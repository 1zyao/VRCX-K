//! A Rust "hands" endpoint that participates in **kkrpc streaming** over real
//! stdio pipes, in BOTH directions, and is driven by the real kkrpc 2.1.0
//! `StreamingRPCChannel` on the other side.
//!
//! Why this exists: every claim about "the hands could stream a file to the
//! brain" so far rests on reading JS source. This binary makes it an
//! observation. It implements exactly the frame set the Rust peer would need:
//!
//!   inbound  t:"q"   request            -> run a handler, reply t:"r"
//!   inbound  t:"sq"  pull/return/throw  -> producer-side stream control
//!   inbound  t:"sr"  stream value       -> consumer-side stream data
//!   outbound t:"r"   reply
//!   outbound t:"sr"  stream value / control ack
//!   outbound t:"sq"  pull               -> ask the JS producer for more credit
//!
//! Two methods, one per direction:
//!
//!   hands.serve(path)     PRODUCER. Reads a file from local disk and returns a
//!                         stream-ref envelope. The brain pulls chunks.
//!                         (hands -> brain: "download"/upload-from-hands)
//!   hands.receive(path)   CONSUMER. Takes a stream-ref ARG, pulls chunks, and
//!                         writes them to local disk. The reply is DEFERRED
//!                         until the stream finishes.
//!                         (brain -> hands: "download-to-disk")
//!
//! The single-threaded read loop is deliberate: credit windows mean the
//! producer is bounded, so emitting in the read loop cannot drown the peer.

use base64::Engine as _;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};

const CHUNK: usize = 256 * 1024;
const INITIAL_CREDIT: usize = 32;
const REPLENISH: usize = 16;
const ARG_ENVELOPE: &str = "__kkrpc_next_arg__";
const STREAM_REF: &str = "__kkrpc_next_stream__";

/// A stream this side PRODUCES: reads a local file, emits chunks on pull.
struct Producer {
    file: File,
    finished: bool,
}

/// A stream this side CONSUMES: writes chunks to a local file, then replies to
/// the deferred request.
struct Consumer {
    file: File,
    /// The `t:"q"` id whose reply is owed once the stream ends.
    request_id: String,
    received: u64,
    since_pull: usize,
    started: bool,
}

struct State {
    producers: HashMap<String, Producer>,
    consumers: HashMap<String, Consumer>,
    next_sid: u64,
}

impl State {
    fn new() -> Self {
        Self {
            producers: HashMap::new(),
            consumers: HashMap::new(),
            next_sid: 1,
        }
    }

    fn new_sid(&mut self) -> String {
        let sid = format!("s-{}", self.next_sid);
        self.next_sid += 1;
        sid
    }
}

fn send(out: &mut impl Write, message: &Value) {
    let mut text = serde_json::to_string(message).expect("serialize");
    text.push('\n');
    let _ = out.write_all(text.as_bytes());
    let _ = out.flush();
}

/// Unwrap the kkrpc argument envelope(s). A stream-ref arg is wrapped twice:
/// once as a value envelope, and inside it as a stream ref.
fn unwrap_arg(value: &Value) -> Value {
    if value.get(ARG_ENVELOPE).and_then(Value::as_str) == Some("value") {
        value.get("v").cloned().unwrap_or(Value::Null)
    } else {
        value.clone()
    }
}

fn is_stream_ref(value: &Value) -> Option<String> {
    if value.get(STREAM_REF).and_then(Value::as_str) == Some("async-iterable") {
        value.get("id").and_then(Value::as_str).map(str::to_string)
    } else {
        None
    }
}

/// Emit up to `credit` chunks for one producer stream.
fn pump(out: &mut impl Write, state: &mut State, sid: &str, credit: usize) {
    let Some(producer) = state.producers.get_mut(sid) else {
        return;
    };
    if producer.finished {
        return;
    }
    let engine = base64::engine::general_purpose::STANDARD;
    let mut buffer = vec![0u8; CHUNK];

    for _ in 0..credit {
        match producer.file.read(&mut buffer) {
            Ok(0) => {
                // Terminal frame. `d:true` is sticky on the consumer side.
                send(
                    out,
                    &json!({ "t": "sr", "id": format!("x-{sid}"), "sid": sid, "d": true }),
                );
                producer.finished = true;
                state.producers.remove(sid);
                return;
            }
            Ok(n) => {
                let payload = engine.encode(&buffer[..n]);
                send(
                    out,
                    &json!({ "t": "sr", "id": format!("x-{sid}"), "sid": sid, "d": false, "v": payload }),
                );
            }
            Err(error) => {
                send(
                    out,
                    &json!({
                        "t": "sr", "id": format!("x-{sid}"), "sid": sid,
                        "e": { "n": "Io", "m": error.to_string() },
                    }),
                );
                producer.finished = true;
                state.producers.remove(sid);
                return;
            }
        }
    }
}

fn main() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    let mut state = State::new();
    let engine = base64::engine::general_purpose::STANDARD;

    let reader = BufReader::new(stdin.lock());
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };

        match message.get("t").and_then(Value::as_str) {
            // ---- requests -------------------------------------------------
            Some("q") => {
                let id = message
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let method = message
                    .get("p")
                    .and_then(Value::as_array)
                    .map(|p| {
                        p.iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(".")
                    })
                    .unwrap_or_default();
                let args: Vec<Value> = message
                    .get("a")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().map(unwrap_arg).collect())
                    .unwrap_or_default();

                match method.as_str() {
                    // PRODUCER: hands sends a local file to the brain.
                    "hands.serve" => {
                        let path = args.first().and_then(Value::as_str).unwrap_or("");
                        match File::open(path) {
                            Ok(file) => {
                                let sid = state.new_sid();
                                state.producers.insert(sid.clone(), Producer { file, finished: false });
                                // The reply value is a STREAM REF, not data.
                                send(
                                    &mut out,
                                    &json!({
                                        "t": "r", "id": id,
                                        "v": { STREAM_REF: "async-iterable", "id": sid },
                                    }),
                                );
                            }
                            Err(error) => send(
                                &mut out,
                                &json!({ "t": "r", "id": id, "e": { "n": "Io", "m": error.to_string() } }),
                            ),
                        }
                    }

                    // CONSUMER: the brain sends a stream, hands writes it to disk.
                    // The reply is deferred until the stream ends.
                    "hands.receive" => {
                        let path = args.first().and_then(Value::as_str).unwrap_or("");
                        let sid = args.get(1).and_then(is_stream_ref);
                        let Some(sid) = sid else {
                            send(
                                &mut out,
                                &json!({
                                    "t": "r", "id": id,
                                    "e": { "n": "TypeError", "m": "hands.receive: argument 2 is not a stream ref" },
                                }),
                            );
                            continue;
                        };
                        match File::create(path) {
                            Ok(file) => {
                                state.consumers.insert(
                                    sid.clone(),
                                    Consumer {
                                        file,
                                        request_id: id,
                                        received: 0,
                                        since_pull: 0,
                                        started: false,
                                    },
                                );
                                // Open the credit window. `pull` is one-way: no ack.
                                send(
                                    &mut out,
                                    &json!({
                                        "t": "sq", "id": format!("p-{sid}"),
                                        "sid": sid, "op": "pull", "n": INITIAL_CREDIT,
                                    }),
                                );
                            }
                            Err(error) => send(
                                &mut out,
                                &json!({ "t": "r", "id": id, "e": { "n": "Io", "m": error.to_string() } }),
                            ),
                        }
                    }

                    _ => send(
                        &mut out,
                        &json!({ "t": "r", "id": id, "e": { "m": format!("unknown RPC method: {method}") } }),
                    ),
                }
            }

            // ---- producer-side stream control -----------------------------
            Some("sq") => {
                let sid = message.get("sid").and_then(Value::as_str).unwrap_or("");
                let op = message.get("op").and_then(Value::as_str).unwrap_or("");
                let control_id = message.get("id").and_then(Value::as_str).unwrap_or("");
                match op {
                    // Credit: `n` is an INCREMENT, never a settable window.
                    "pull" => {
                        let credit = message
                            .get("n")
                            .and_then(Value::as_u64)
                            .map(|n| n.max(1) as usize)
                            .unwrap_or(1);
                        pump(&mut out, &mut state, sid, credit);
                    }
                    // `return` is the only request/response-shaped stream frame:
                    // echo the control id back.
                    "return" => {
                        state.producers.remove(sid);
                        send(
                            &mut out,
                            &json!({ "t": "sr", "id": control_id, "sid": sid, "d": true }),
                        );
                    }
                    "throw" => {
                        state.producers.remove(sid);
                        send(
                            &mut out,
                            &json!({
                                "t": "sr", "id": control_id, "sid": sid,
                                "e": { "n": "Error", "m": "consumer threw" },
                            }),
                        );
                    }
                    _ => {}
                }
            }

            // ---- consumer-side stream data --------------------------------
            Some("sr") => {
                let sid = message.get("sid").and_then(Value::as_str).unwrap_or("").to_string();
                let Some(consumer) = state.consumers.get_mut(&sid) else {
                    continue;
                };

                if let Some(error) = message.get("e") {
                    let _ = writeln!(
                        std::io::stderr(),
                        "[hands] stream {sid} failed: {}",
                        error.get("m").and_then(Value::as_str).unwrap_or("?")
                    );
                    let request_id = consumer.request_id.clone();
                    state.consumers.remove(&sid);
                    send(
                        &mut out,
                        &json!({ "t": "r", "id": request_id, "e": error.clone() }),
                    );
                    continue;
                }

                if message.get("d").and_then(Value::as_bool) == Some(true) {
                    let received = consumer.received;
                    let request_id = consumer.request_id.clone();
                    let _ = consumer.file.flush();
                    state.consumers.remove(&sid);
                    send(
                        &mut out,
                        &json!({ "t": "r", "id": request_id, "v": { "bytes": received } }),
                    );
                    continue;
                }

                // Three possible wire shapes for binary, and the differences are
                // the whole point of this probe:
                //
                //   base64 string          -> 1.33x the payload (the deliberate carrier)
                //   {"type":"Buffer","data":[...]}  -> what a Node Buffer becomes
                //   {"0":90,"1":90,...}    -> what a Uint8Array becomes
                //
                // The last two are what kkrpc's JSON codec does to binary when no
                // codec carries it, and they cost ~6-10x the payload because every
                // byte becomes its own JSON number. Accepting all three lets one
                // producer be measured under each encoding without a second binary.
                let decoded: Option<Vec<u8>> = match message.get("v") {
                    Some(Value::String(encoded)) => engine.decode(encoded).ok(),
                    // Node Buffer: {"type":"Buffer","data":[byte, ...]}
                    Some(Value::Object(map))
                        if map.get("type").and_then(Value::as_str) == Some("Buffer") =>
                    {
                        map.get("data").and_then(Value::as_array).map(|entries| {
                            entries
                                .iter()
                                .filter_map(Value::as_u64)
                                .map(|byte| byte as u8)
                                .collect::<Vec<u8>>()
                        })
                    }
                    // Uint8Array: {"0":byte,"1":byte,...}
                    Some(Value::Object(map)) => {
                        let mut bytes = Vec::with_capacity(map.len());
                        let mut complete = true;
                        for index in 0..map.len() {
                            match map.get(&index.to_string()).and_then(Value::as_u64) {
                                Some(byte) => bytes.push(byte as u8),
                                None => {
                                    complete = false;
                                    break;
                                }
                            }
                        }
                        if complete {
                            Some(bytes)
                        } else {
                            None
                        }
                    }
                    _ => None,
                };

                match decoded {
                    Some(bytes) => {
                        if consumer.file.write_all(&bytes).is_err() {
                            let request_id = consumer.request_id.clone();
                            state.consumers.remove(&sid);
                            send(
                                &mut out,
                                &json!({
                                    "t": "r", "id": request_id,
                                    "e": { "n": "Io", "m": "write failed" },
                                }),
                            );
                            continue;
                        }
                        consumer.received += bytes.len() as u64;
                        consumer.since_pull += 1;
                        // Replenish exactly the way the reference consumer does.
                        if consumer.since_pull >= REPLENISH {
                            consumer.since_pull = 0;
                            send(
                                &mut out,
                                &json!({
                                    "t": "sq", "id": format!("p-{sid}-{}", consumer.received),
                                    "sid": sid, "op": "pull", "n": REPLENISH,
                                }),
                            );
                        }
                    }
                    None => {
                        let request_id = consumer.request_id.clone();
                        state.consumers.remove(&sid);
                        send(
                            &mut out,
                            &json!({
                                "t": "r", "id": request_id,
                                "e": { "n": "Decode", "m": "unrecognised stream value shape" },
                            }),
                        );
                    }
                }
            }
            _ => {}
        }
    }
}
