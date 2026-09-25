//! Minimal kkrpc **compact-protocol** peer, over an **injected transport**.
//!
//! Why this exists at all (D1 finding, M1-4): the published `kkrpc` Rust crate
//! 0.6.1 speaks the JSON-mode protocol (`{method,args,type,version:"json"}`),
//! which does **not** interoperate with npm kkrpc 2.1.0's compact protocol
//! (`{t:"q",op,p,a}`) — a Rust `Client` against our host simply hung. This is
//! our own ~200-line endpoint implementing the compact frames the host already
//! speaks, so both ends are on one protocol.
//!
//! # The transport is a parameter, not a dependency
//!
//! The peer does not care *how* bytes travel. It is constructed from a
//! `Write` (outbound) and given a `Read` (inbound), so the same protocol, the
//! same pending-request table and the same dispatch logic serve:
//!
//!   - `stdio` — the current M1-4 brain⇄hands bridge. The shell owns the host
//!     as a child process, so a pipe is available and is the cheapest channel.
//!   - any future channel — e.g. a socket to a host that is **not** a local
//!     child (the "brain lives on the desktop, phone is a client" direction in
//!     `docs/mobile-feasibility.md`). That direction has no `ChildStdin` to
//!     hand over, which is exactly the seam this abstraction leaves open.
//!
//! Keeping the abstraction here rather than at the call sites means the frames,
//! the id spaces (`r-` requests, `n-` notifications) and the EOF policy stay in
//! one place: a second transport must not become a second protocol
//! implementation.
//!
//! # Framing
//!
//! One JSON object per line, newline-terminated, in both directions.

use base64::Engine as _;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// kkrpc wraps callback-style arguments in a value envelope; the host expects
/// the inner value, not the envelope (official interop rule).
const ARG_ENVELOPE: &str = "__kkrpc_next_arg__";

/// kkrpc's stream-reference envelope. A method result (or argument) shaped like
/// `{__kkrpc_next_stream__:"async-iterable", id}` is decoded by the host into an
/// async iterable, and pulling then happens over `t:"sq"` / `t:"sr"` frames
/// rather than inside the original reply.
pub const STREAM_REF: &str = "__kkrpc_next_stream__";

/// Credit window. Both numbers are copied from kkrpc's own consumer
/// (`createRemoteAsyncIterable`: it opens with `sendStreamPull(sid, 32)` and then
/// replenishes 16 per 16 values delivered), so the host's window and our
/// producer's bound agree by construction. Measured behaviour of this window:
/// `docs/probes/transport-lab/FINDINGS.md` §4 — a consumer that stops taking
/// values stops the producer at exactly 32 chunks.
pub const INITIAL_CREDIT: usize = 32;
pub const REPLENISH: usize = 16;

/// One step of a producer-side stream.
pub enum StreamStep {
    /// One chunk of bytes. The peer base64-encodes it onto the wire.
    Chunk(Vec<u8>),
    /// Clean end. The peer sends the terminal frame and forgets the stream.
    Done,
    /// Failure. The peer sends an error frame and forgets the stream.
    Failed(String),
}

/// A byte source the peer pumps on the host's credit.
///
/// `next_chunk` runs on the peer's reader thread, so credit is what keeps a fast
/// disk from outrunning a slow consumer — not a background thread.
pub trait StreamProducer: Send {
    fn next_chunk(&mut self) -> StreamStep;
    /// Called when the stream stops for any reason other than a clean end
    /// (host cancelled, transport died). Releases handles.
    fn close(&mut self) {}
}

/// The receiving half of a host-produced stream.
pub trait StreamSink: Send {
    /// One decoded chunk. Returning `Err` aborts the stream and fails the
    /// pending deferred reply with that message.
    fn write(&mut self, bytes: &[u8]) -> Result<(), String>;
    /// Called exactly once: `Ok` on a clean end, `Err` on error or cancellation.
    fn finish(&mut self, outcome: Result<(), String>);
}

/// An **unsolicited** value source: values arrive when the world changes, not
/// when the consumer asks.
///
/// This is deliberately NOT the [`StreamProducer`] shape. A producer is pumped
/// on the peer's **reader thread**, which is fine for a file read (bounded work)
/// but fatal for a watch: blocking there would stop the peer from processing
/// *any* frame, including the very `return` meant to cancel the watch. So an
/// event stream gets its own thread, and `next_value` may block on that thread
/// only.
///
/// `next_value` takes a timeout and must honour it: the thread notices a
/// cancellation request only between calls, so an implementation that blocked
/// forever would make `unwatch` hang until the next filesystem event.
pub trait StreamSource: Send {
    /// The next value, or `None` once the source is exhausted. `None` is also
    /// the correct answer for "nothing happened within `timeout`" — the caller
    /// re-invokes it, so a quiet stream is a series of `None`s, not a stop.
    fn next_value(&mut self, timeout: Duration) -> Option<Value>;
    /// Release the underlying watch. Called on cancel and on transport loss.
    fn close(&mut self) {}
}

/// How long a dedicated event thread waits on the source before re-checking
/// whether it should stop. Small enough that a cancelled watch ends promptly,
/// large enough that an idle watch costs one wake-up per tick.
const EVENT_POLL: Duration = Duration::from_millis(100);

/// A reply the handler did not produce synchronously.
///
/// `hands.write` must not answer until the incoming stream has ended, so the
/// request is answered from the stream's completion instead of from the handler
/// body. Handed to a handler registered through [`Peer::on_deferred`].
#[derive(Clone)]
pub struct DeferredReply {
    peer: Arc<Peer>,
    id: String,
}

impl DeferredReply {
    fn new(peer: Arc<Peer>, id: String) -> Self {
        Self { peer, id }
    }

    /// The request id this reply will answer.
    ///
    /// Needed by [`Peer::open_stream`]: the stream reference must be written as
    /// *this* request's reply, so the id has to travel with the reply handle.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Send the request's successful result.
    pub fn send(&self, value: Value) {
        let _ = self
            .peer
            .write(&json!({ "t": "r", "id": self.id, "v": value }));
    }

    /// Fail the request. The host maps `e.m` to the rejection's message.
    pub fn fail(&self, message: impl Into<String>) {
        let _ = self.peer.write(&json!({
            "t": "r",
            "id": self.id,
            "e": { "m": message.into() },
        }));
    }
}

/// A producer-side stream this peer owns.
type Producer = Box<dyn StreamProducer>;

/// A consumer-side stream this peer owns: it receives the host's chunks.
struct Consumer {
    sink: Box<dyn StreamSink>,
    /// Values received since the last credit replenishment.
    since_pull: usize,
}

#[derive(Default)]
struct StreamTable {
    next_sid: u64,
    /// Producer streams, keyed by sid. The value is the CONTROL block, not the
    /// producer: the producer itself is owned by its own thread (see
    /// [`Peer::spawn_producer`]), which is what keeps a batch off the reader
    /// thread. Removing the entry is how a terminal frame is claimed — whoever
    /// still finds it owns the ending.
    producers: HashMap<String, Arc<ProducerStream>>,
    consumers: HashMap<String, Consumer>,
    /// Event streams (watches), which run on their OWN thread. See [`StreamSource`].
    events: HashMap<String, Arc<EventStream>>,
    /// Stream ids cancelled while they were mid-pump.
    ///
    /// Kept for the window where a producer has been taken off the table but its
    /// thread has not yet observed the cancellation, so a late `return` is not
    /// lost.
    cancelled: HashSet<String>,
}

/// Shared control block for one event stream: the host's credit and a stop flag,
/// both touched from the peer's reader thread and the stream's own thread.
#[derive(Default)]
struct EventStream {
    credit: AtomicI64,
    cancelled: AtomicBool,
}

/// Shared control block for one PRODUCER stream.
///
/// Same shape as [`EventStream`] and for the same reason: the producer runs on
/// its own thread, so the reader thread and the producer thread coordinate here
/// rather than by the reader owning the producer.
///
/// ⚠ Why this exists at all — measured, not theoretical. `pump_producer` used to
/// run the whole `for _ in 0..credit` batch ON THE READER THREAD, so the reader
/// could not return to `read_line` until the batch drained and an inbound
/// request waited out the **remaining credit**. `hol-credit.mjs` isolated it:
/// interactive p95 was linear in outstanding credit (~1.7 ms/chunk mid-batch)
/// while the batch-END probe sat at idle, and the raw `hol.mjs` 51–70x tail fell
/// straight out of kkrpc's `pull n=32` open (1.7 x 32 ~= 54 ms vs a measured
/// 55.7 ms max).
///
/// ⚠ CREDIT IS SIGNALLED, NOT POLLED. The first version slept `IDLE_POLL` and
/// re-checked, which put the poll interval directly into the latency: p50 sat at
/// ~1 ms with a 1 ms interval, and dropping the interval to 50 µs moved it to
/// ~0.95 ms — i.e. the wake-up granularity WAS the residual. A [`Condvar`] makes
/// a `pull` wake the producer immediately, so the only remaining cost is the
/// real work. [`EventStream`] can afford a 10 ms sleep because a watch is quiet
/// by nature; a producer is on the hot path of every `hands.read`.
#[derive(Default)]
struct ProducerStream {
    credit: Mutex<i64>,
    /// Signalled on every credit increase and on cancellation.
    credit_changed: Condvar,
    cancelled: AtomicBool,
}

impl ProducerStream {
    /// Add `n` credit and wake the producer thread.
    fn add_credit(&self, n: i64) {
        let mut credit = self.credit.lock().expect("producer credit");
        *credit += n;
        self.credit_changed.notify_one();
    }

    /// Block until credit is available or the stream is cancelled.
    ///
    /// Returns `false` when cancelled, so the caller exits its loop.
    fn wait_for_credit(&self) -> bool {
        let mut credit = self.credit.lock().expect("producer credit");
        while *credit <= 0 {
            if self.cancelled.load(Ordering::SeqCst) {
                return false;
            }
            // A timeout is only a safety net for a missed notification; the
            // normal path wakes on `add_credit` or `cancel` immediately.
            let (guard, _) = self
                .credit_changed
                .wait_timeout(credit, Duration::from_millis(50))
                .expect("producer credit");
            credit = guard;
        }
        !self.cancelled.load(Ordering::SeqCst)
    }

    /// Spend one credit. Callers must have observed credit > 0.
    fn spend_credit(&self) {
        let mut credit = self.credit.lock().expect("producer credit");
        *credit -= 1;
    }

    /// Stop the producer and wake it if it is waiting.
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.credit_changed.notify_all();
    }
}

impl StreamTable {
    fn new_sid(&mut self) -> String {
        let sid = format!("s-{}", self.next_sid);
        self.next_sid += 1;
        sid
    }
}

/// Deferred handlers answer the request later (see [`DeferredReply`]).
type DeferredHandler = Arc<dyn Fn(DeferredReply, Vec<Value>) + Send + Sync>;

/// What a registered method does with a request.
enum HandlerEntry {
    /// Reply with the returned value immediately.
    Sync(Handler),
    /// Take ownership of the reply.
    Deferred(DeferredHandler),
}

impl HandlerEntry {
    /// A dispatchable copy of this entry.
    fn cloned_entry(&self) -> Self {
        match self {
            HandlerEntry::Sync(handler) => HandlerEntry::Sync(Arc::clone(handler)),
            HandlerEntry::Deferred(handler) => HandlerEntry::Deferred(Arc::clone(handler)),
        }
    }
}

/// Allocate an id in the given space. The prefixes mirror the existing ones
/// (`r-` requests, `n-` notifications) and add `p-` for pulls, `x-` for stream
/// data and `c-` for cancels, so a wire trace is readable by eye.
fn next_id(prefix: &str) -> String {
    format!("{prefix}-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed))
}

/// Decode one inbound stream chunk.
///
/// The wire carrier is NOT fixed by kkrpc's protocol: its stock transport
/// JSON-stringifies, and JSON has no bytes, so whatever the sender passes is
/// mangled into one of three shapes. All three were measured
/// (`docs/probes/hand-io/FINDINGS.md` §2), and the differences are the reason
/// the finding exists at all:
///
/// | shape | cost vs payload |
/// |---|---|
/// | `"AAEC…"` — base64 string | **1.33x** (what we send) |
/// | `{"type":"Buffer","data":[…]}` — a Node `Buffer` | ~4-6x |
/// | `{"0":65,"1":66,…}` — a raw `Uint8Array` | **11.4x** |
///
/// Accepting the latter two is not leniency for its own sake: a host that
/// forgets to encode would otherwise either mis-read silently or fail opaquely,
/// and both are worse than a correct transfer that merely costs bandwidth. The
/// waste is the sender's, and it stays visible — this function's cost is written
/// down here so nobody re-derives "binary over JSON is fine".
///
/// ⚠ **This is a property of the STOCK JSON CODEC, not of the pipe.** kkrpc
/// exposes `createTransport({ platform, codec })`, so a length-prefixed binary
/// framing is possible over the SAME single pipe — measured at 1.8-2.1x faster
/// than base64 with no desynchronisation
/// (`docs/probes/hand-io/04-binary-framing.mjs`; FINDINGS §5.1). The cost is
/// changing BOTH ends, not impossibility. The three shapes below exist because we
/// currently keep the stock codec — not because bytes are impossible here.
fn decode_chunk(value: Option<&Value>) -> Result<Vec<u8>, String> {
    let Some(value) = value else {
        return Err("stream frame carries no value".into());
    };
    match value {
        Value::String(encoded) => base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|error| format!("bad base64 chunk: {error}")),
        // Node Buffer: {"type":"Buffer","data":[byte,…]}
        Value::Object(map) if map.get("type").and_then(Value::as_str) == Some("Buffer") => map
            .get("data")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(Value::as_u64)
                    .map(|byte| byte as u8)
                    .collect::<Vec<u8>>()
            })
            .ok_or_else(|| "Buffer-shaped chunk has no data array".to_string()),
        // Uint8Array: {"0":byte,"1":byte,…}. Keys are contiguous by construction.
        Value::Object(map) => {
            let mut bytes = Vec::with_capacity(map.len());
            for index in 0..map.len() {
                match map.get(&index.to_string()).and_then(Value::as_u64) {
                    Some(byte) => bytes.push(byte as u8),
                    None => {
                        return Err(format!(
                            "unrecognised stream value shape: object is not a \
                             contiguous byte map (missing key {index})"
                        ))
                    }
                }
            }
            Ok(bytes)
        }
        Value::Array(entries) => Ok(entries
            .iter()
            .filter_map(Value::as_u64)
            .map(|byte| byte as u8)
            .collect()),
        other => Err(format!(
            "unrecognised stream value shape: {}",
            match other {
                Value::Null => "null".into(),
                _ => other.to_string(),
            }
        )),
    }
}

/// Error handed to every in-flight call when the transport ends.
///
/// Wire-visible: it is the `Err` text of any call outstanding at disconnect, so
/// it flows into host-lifecycle diagnostics and the dev smoke panel. Spelled as
/// it was before the transport abstraction existed, so this change does not move
/// a user-visible string.
const TRANSPORT_CLOSED: &str = "host stdio closed";

pub type Handler = Arc<dyn Fn(Vec<Value>) -> Value + Send + Sync>;

pub struct Peer {
    writer: Mutex<Box<dyn Write + Send>>,
    pending: Mutex<HashMap<String, Sender<Result<Value, String>>>>,
    handlers: Mutex<HashMap<String, HandlerEntry>>,
    streams: Mutex<StreamTable>,
}

impl Peer {
    /// Create a peer over a transport. The reader half is installed separately
    /// by [`Peer::start_reader`] so mandatory handlers (e.g. the `ready`
    /// handshake) can be registered first — early frames then stay buffered in
    /// the transport rather than being dispatched as unknown methods.
    pub fn new(writer: impl Write + Send + 'static) -> Arc<Self> {
        Arc::new(Self {
            writer: Mutex::new(Box::new(writer)),
            pending: Mutex::new(HashMap::new()),
            handlers: Mutex::new(HashMap::new()),
            streams: Mutex::new(StreamTable::default()),
        })
    }

    /// Spawn the read loop over the transport's inbound half.
    ///
    /// Takes any `Read`, not a `ChildStdout`: the loop owns the reader for the
    /// lifetime of the thread and only ever calls `read_line`, so a pipe, a
    /// socket and an in-memory buffer are equally valid.
    pub fn start_reader<R: Read + Send + 'static>(self: &Arc<Self>, reader: R) {
        let reader_peer = Arc::clone(self);
        thread::spawn(move || {
            let mut reader = BufReader::new(reader);
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => {
                        // The other end is gone. Fail every waiter now rather
                        // than letting each hit its own timeout: the
                        // distinction between "slow" and "closed" is what the
                        // supervisor acts on.
                        let mut pending = reader_peer.pending.lock().expect("pending");
                        for (_, sender) in pending.drain() {
                            let _ = sender.send(Err(TRANSPORT_CLOSED.into()));
                        }
                        drop(pending);
                        // Streams are owned by the same connection. Leaving a
                        // producer open would hold a file handle on a peer that
                        // can never pull again, and a consumer's deferred reply
                        // would never be sent.
                        reader_peer.close_streams();
                        break;
                    }
                    Ok(_) => {}
                }
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                // A malformed line is skipped, not fatal: one bad frame must not
                // take down every later request on the same transport.
                let Ok(message) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };
                reader_peer.dispatch(message);
            }
        });
    }

    pub fn on(&self, method: &str, handler: Handler) {
        self.handlers
            .lock()
            .expect("handlers")
            .insert(method.to_string(), HandlerEntry::Sync(handler));
    }

    /// Register a method whose reply is sent later, from another thread.
    ///
    /// Needed by any method that CONSUMES an incoming stream: its reply cannot be
    /// written until the stream ends, and that happens after the handler returns.
    pub fn on_deferred(&self, method: &str, handler: DeferredHandler) {
        self.handlers
            .lock()
            .expect("handlers")
            .insert(method.to_string(), HandlerEntry::Deferred(handler));
    }

    pub fn call(&self, method: &str, args: Vec<Value>) -> Result<Value, String> {
        self.call_timeout(method, args, Duration::from_secs(10))
    }

    /// Fire-and-forget request: write the same `call` frame but do not register
    /// a pending waiter. The host executes the method and its `r` reply is
    /// ignored (`dispatch` drops responses without a pending sender).
    ///
    /// Used by the supervisor thread for signals whose outcome is observed
    /// through the child process itself (e.g. `restart`, which makes the host
    /// tear down and exit 51) — blocking the single supervisor thread on a 28s
    /// RPC would stall command servicing and child reaping.
    pub fn notify(&self, method: &str, args: Vec<Value>) -> Result<(), String> {
        let id = format!("n-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
        self.write(&Self::request_frame(&id, method, args))
    }

    fn request_frame(id: &str, method: &str, args: Vec<Value>) -> Value {
        let path: Vec<Value> = method
            .split('.')
            .map(|segment| Value::String(segment.to_string()))
            .collect();
        let mut payload = serde_json::Map::new();
        payload.insert("t".into(), json!("q"));
        payload.insert("id".into(), json!(id));
        payload.insert("op".into(), json!("call"));
        payload.insert("p".into(), Value::Array(path));
        if !args.is_empty() {
            payload.insert("a".into(), Value::Array(args));
        }
        Value::Object(payload)
    }

    pub fn call_timeout(
        &self,
        method: &str,
        args: Vec<Value>,
        timeout: Duration,
    ) -> Result<Value, String> {
        let id = format!("r-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = mpsc::channel();
        self.pending.lock().expect("pending").insert(id.clone(), tx);
        if let Err(err) = self.write(&Self::request_frame(&id, method, args)) {
            self.pending.lock().expect("pending").remove(&id);
            return Err(err);
        }
        let result = rx.recv_timeout(timeout).map_err(|err| err.to_string());
        self.pending.lock().expect("pending").remove(&id);
        result?
    }

    fn dispatch(self: &Arc<Self>, message: Value) {
        match message.get("t").and_then(Value::as_str) {
            Some("q") if message.get("op").and_then(Value::as_str) == Some("call") => {
                let id = message.get("id").cloned().unwrap_or(json!(""));
                let method = message
                    .get("p")
                    .and_then(Value::as_array)
                    .map(|path| {
                        path.iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(".")
                    })
                    .unwrap_or_default();
                let args = message
                    .get("a")
                    .and_then(Value::as_array)
                    .map(|values| values.iter().map(unwrap_arg).collect())
                    .unwrap_or_default();
                let handler = self
                    .handlers
                    .lock()
                    .expect("handlers")
                    .get(&method)
                    .map(HandlerEntry::cloned_entry);
                let response = match handler {
                    Some(HandlerEntry::Sync(call)) => {
                        json!({ "t": "r", "id": id, "v": call(args) })
                    }
                    Some(HandlerEntry::Deferred(call)) => {
                        // The handler owns the reply now. Give it a way to send
                        // one, and write nothing here.
                        let id = id.as_str().unwrap_or_default().to_string();
                        call(DeferredReply::new(Arc::clone(self), id), args);
                        return;
                    }
                    // Naming the method matters: this text reaches the host and
                    // localises a typo immediately.
                    None => json!({
                        "t": "r",
                        "id": id,
                        "e": { "m": format!("unknown RPC method: {method}") },
                    }),
                };
                let _ = self.write(&response);
            }
            Some("r") => {
                let Some(id) = message.get("id").and_then(Value::as_str) else {
                    return;
                };
                let sender = self.pending.lock().expect("pending").remove(id);
                if let Some(sender) = sender {
                    if let Some(error) = message.get("e") {
                        let text = error
                            .get("m")
                            .and_then(Value::as_str)
                            .unwrap_or("RPC error")
                            .to_string();
                        let _ = sender.send(Err(text));
                    } else {
                        let _ = sender.send(Ok(message.get("v").cloned().unwrap_or(Value::Null)));
                    }
                }
            }
            // Host → shell stream control or stream data.
            Some("sq") => self.dispatch_stream_control(&message),
            Some("sr") => self.dispatch_stream_data(&message),
            // Host → shell notifications (`t:"cb"`) are consumed by the
            // registrations in `shell_sys`. Anything else is ignored rather than
            // treated as an error, so a newer host cannot break an older shell
            // merely by sending a frame type it does not know.
            _ => {}
        }
    }

    // --- streaming ---------------------------------------------------------

    /// Start a producer-side stream: reply with a stream reference, then emit
    /// chunks from the producer's OWN THREAD as the host spends credit.
    ///
    /// The reply is a REFERENCE, not data — this is what makes a multi-GB file
    /// cost `credit × chunk` bytes of memory instead of the file size.
    ///
    /// # ⚠ The thread is the FIX, not an optimisation
    ///
    /// This used to register the producer in the table and let `pump_producer`
    /// emit batches **on the reader thread**. Measured consequence
    /// (`docs/probes/hands-e2e/hol-credit.mjs`, MID vs END probe at equal credit):
    /// the reader could not return to `read_line` until a whole batch drained, so
    /// an inbound interactive request waited out the **remaining credit** —
    /// p95 linear in outstanding credit at ~1.7 ms/chunk, which is also why
    /// `hol.mjs` showed a 51–70x tail (kkrpc opens with `pull n=32`:
    /// 1.7 x 32 ~= 54 ms against a measured 55.7 ms max).
    ///
    /// [`Peer::open_event_stream`] had already solved the same hazard for watches
    /// by giving the source its own thread. This is that shape applied to
    /// producers, which is why [`ProducerStream`] mirrors [`EventStream`].
    ///
    /// ⚠ Do NOT "fix" this by lowering the credit instead: throughput scales with
    /// it (87 MiB/s at credit 1 vs 171 MiB/s at 32), and emitting a single chunk
    /// per pull would **deadlock**, because kkrpc's consumer only replenishes once
    /// `consumedSincePull >= 16`.
    pub fn open_stream(
        self: &Arc<Self>,
        request_id: &str,
        producer: Producer,
    ) -> Result<String, String> {
        let (sid, control) = {
            let mut streams = self.streams.lock().map_err(|err| err.to_string())?;
            let sid = streams.new_sid();
            let control = Arc::new(ProducerStream::default());
            streams.producers.insert(sid.clone(), Arc::clone(&control));
            (sid, control)
        };

        // The stream-ref reply goes out BEFORE the thread starts, so no chunk can
        // reach the host before it holds a reference to route it by.
        if let Err(error) = self.write(&json!({
            "t": "r",
            "id": request_id,
            "v": { STREAM_REF: "async-iterable", "id": sid },
        })) {
            let mut streams = self.streams.lock().expect("streams");
            streams.producers.remove(&sid);
            let mut producer = producer;
            producer.close();
            return Err(error);
        }

        // Hand `sid` to the thread (which owns it) and return a copy to the
        // caller; the thread needs it for every frame it writes.
        let thread_sid = sid.clone();
        self.spawn_producer(thread_sid, control, producer);
        Ok(sid)
    }

    /// The producer's own thread: wait for credit, emit one chunk, repeat.
    ///
    /// Owns the producer outright, so the reader thread never touches it and never
    /// blocks on file I/O. Credit is the only coupling — the host's `pull` widens
    /// `control.credit`, this loop consumes it.
    fn spawn_producer(
        self: &Arc<Self>,
        sid: String,
        control: Arc<ProducerStream>,
        mut producer: Producer,
    ) {
        let peer = Arc::clone(self);
        thread::spawn(move || {
            loop {
                // Block until the host grants credit (or the stream is cancelled).
                // Signalled rather than polled: a poll interval would land directly
                // in the latency of every following `hands.read`.
                if !control.wait_for_credit() {
                    break;
                }
                control.spend_credit();

                let frame = match producer.next_chunk() {
                    StreamStep::Chunk(bytes) => {
                        let payload = base64::engine::general_purpose::STANDARD.encode(&bytes);
                        json!({
                            "t": "sr", "id": next_id("x"), "sid": sid,
                            "d": false, "v": payload,
                        })
                    }
                    StreamStep::Done => {
                        // ⚠ No `v` on the terminal frame, and that is ONLY correct
                        // because `StreamStep::Done` carries no payload (see the
                        // enum above) and `StreamSink::finish` takes no value
                        // either.
                        //
                        // kkrpc's remote consumer DOES read a terminal `v`.
                        // Verified against the shipped source map
                        // (`streaming-channel.ts`):
                        //
                        //   :433-439  const result = { done: message.d === true,
                        //                             value: this.decodeValue(message.v) }
                        //             waiter.resolve(result)      // <-- delivered
                        //   :648-655  readBuffered() returns it to the caller
                        //   :667      `if (stream.done) return {done:true,value:undefined}`
                        //             is NOT this path — it is the "already
                        //             finished, next() called again" short-circuit
                        //
                        // So an earlier claim of mine ("the JS side ignores it
                        // anyway, the value is hardcoded `void 0`") was WRONG: it
                        // read the short-circuit branch as the delivery path. The
                        // honest reason there is nothing to send is simply that no
                        // value exists.
                        //
                        // ⇒ If `StreamStep::Done` ever gains a payload, THIS frame
                        // must gain `"v"` in the same change, or the value is
                        // silently dropped to `undefined` on the host side.
                        json!({ "t": "sr", "id": next_id("x"), "sid": sid, "d": true })
                    }
                    StreamStep::Failed(message) => json!({
                        "t": "sr", "id": next_id("x"), "sid": sid,
                        "e": { "n": "Error", "m": message },
                    }),
                };
                let terminal = frame.get("e").is_some()
                    || frame.get("d").and_then(Value::as_bool) == Some(true);

                if terminal {
                    // Whoever still finds the entry in the table owns the ending.
                    // A cancellation path removes it and answers on its own, so a
                    // late terminal frame here would be a duplicate. Remove BEFORE
                    // writing: a test (and the host) may observe the frame and
                    // immediately assert the stream is forgotten.
                    let owned = {
                        let mut streams = peer.streams.lock().expect("streams");
                        streams.producers.remove(&sid).is_some()
                    };
                    if owned {
                        let _ = peer.write(&frame);
                    }
                    break;
                }

                if peer.write(&frame).is_err() {
                    // The transport is gone. ⚠ Do NOT just drop our own entry:
                    // `forget_stream` also FAILS EVERY CONSUMER SINK, and that is
                    // the only thing standing between a broken write side and a
                    // `hands.write` caller hanging until kkrpc's 30s timeout.
                    // `close_streams` is not a safety net here — it runs on reader
                    // EOF, which may never arrive if only the WRITE side is broken
                    // (the same reasoning that put the replenish-write check in
                    // `dispatch_stream_data`).
                    peer.forget_stream(&sid);
                    break;
                }
            }
            // Exactly one close per producer, on every exit path (clean end,
            // failure, cancellation, transport death) — a file handle must not
            // outlive the stream.
            producer.close();
        });
    }

    /// Register a sink for a stream the host is producing, and open the window.
    ///
    /// `sid` comes from the request's stream-ref argument; the host only starts
    /// sending once it receives the `pull`, so this must run before the reply.
    pub fn consume_stream(&self, sid: &str, sink: Box<dyn StreamSink>) -> Result<(), String> {
        {
            let mut streams = self.streams.lock().map_err(|err| err.to_string())?;
            if streams.consumers.contains_key(sid) {
                return Err(format!("stream {sid} is already being consumed"));
            }
            streams.consumers.insert(
                sid.to_string(),
                Consumer {
                    sink,
                    since_pull: 0,
                },
            );
        }
        self.write(&json!({
            "t": "sq",
            "id": next_id("p"),
            "sid": sid,
            "op": "pull",
            "n": INITIAL_CREDIT,
        }))
    }

    /// Handle `t:"sq"` from the host: pull credit, or cancel a producer.
    fn dispatch_stream_control(self: &Arc<Self>, message: &Value) {
        let sid = message.get("sid").and_then(Value::as_str).unwrap_or("");
        let op = message.get("op").and_then(Value::as_str).unwrap_or("");
        let control_id = message
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        match op {
            // `n` is an INCREMENT, never a settable window. A missing or
            // nonsensical `n` means one chunk, which is what kkrpc does.
            "pull" => {
                let credit = message
                    .get("n")
                    .and_then(Value::as_u64)
                    .map(|n| n.max(1) as usize)
                    .unwrap_or(1);
                // Both stream kinds are pumped by their OWN thread; all a pull
                // does here is widen the corresponding window. ⚠ This is the whole
                // point of the producer thread: the reader returns to `read_line`
                // immediately instead of emitting the batch itself.
                let producer = self
                    .streams
                    .lock()
                    .expect("streams")
                    .producers
                    .get(sid)
                    .map(Arc::clone);
                if let Some(producer) = producer {
                    producer.add_credit(credit as i64);
                    return;
                }
                let event = self
                    .streams
                    .lock()
                    .expect("streams")
                    .events
                    .get(sid)
                    .map(Arc::clone);
                if let Some(event) = event {
                    event.credit.fetch_add(credit as i64, Ordering::SeqCst);
                }
            }
            // `return`/`throw` are the only request/response-shaped stream
            // frames: they owe an acknowledgement carrying this control id.
            "return" | "throw" => {
                {
                    let mut streams = self.streams.lock().expect("streams");
                    // An event stream stops by flag; its own thread owns the
                    // source and will close it.
                    if let Some(event) = streams.events.remove(sid) {
                        event.cancelled.store(true, Ordering::SeqCst);
                    } else if let Some(producer) = streams.producers.remove(sid) {
                        // Same shape for producers: signal the owning thread and
                        // let it close the file. Closing here would race with the
                        // thread still inside `next_chunk`.
                        producer.cancel();
                    } else {
                        // Already finished, or removed by the ending path. Record
                        // it so a thread that has not yet observed the cancel
                        // cannot resurrect the stream.
                        streams.cancelled.insert(sid.to_string());
                    }
                }
                let acknowledgement = if op == "return" {
                    json!({ "t": "sr", "id": control_id, "sid": sid, "d": true })
                } else {
                    json!({
                        "t": "sr", "id": control_id, "sid": sid,
                        "e": { "n": "Error", "m": "consumer threw" },
                    })
                };
                let _ = self.write(&acknowledgement);
            }
            _ => {}
        }
    }

    /// Start an **event** stream (a watch) on its own thread.
    ///
    /// Differs from [`Peer::open_stream`] in where values come from: a producer
    /// is pumped on demand by the host's credit, whereas an event source blocks
    /// waiting for the world to change and must therefore not run on the reader
    /// thread (see [`StreamSource`]). Credit still bounds how far the source may
    /// run ahead, so a chatty directory cannot flood the pipe.
    pub fn open_event_stream(
        self: &Arc<Self>,
        request_id: &str,
        mut source: Box<dyn StreamSource>,
    ) -> Result<String, String> {
        let (sid, control) = {
            let mut streams = self.streams.lock().map_err(|err| err.to_string())?;
            let sid = streams.new_sid();
            let control = Arc::new(EventStream::default());
            streams.events.insert(sid.clone(), Arc::clone(&control));
            (sid, control)
        };

        // The stream-ref reply goes out BEFORE the thread starts, so no value
        // can reach the host before it has one.
        if let Err(error) = self.write(&json!({
            "t": "r",
            "id": request_id,
            "v": { STREAM_REF: "async-iterable", "id": sid },
        })) {
            let mut streams = self.streams.lock().expect("streams");
            streams.events.remove(&sid);
            source.close();
            return Err(error);
        }

        let peer = Arc::clone(self);
        let thread_sid = sid.clone();
        thread::spawn(move || {
            loop {
                if control.cancelled.load(Ordering::SeqCst) {
                    break;
                }
                // Spend credit before producing, so the window is honoured even
                // when the source is faster than the consumer. A `None` here
                // means "nothing happened in the last tick", NOT exhaustion — a
                // quiet watch is expected to answer `None` indefinitely.
                let Some(value) = source.next_value(EVENT_POLL) else {
                    continue;
                };
                if control.cancelled.load(Ordering::SeqCst) {
                    break;
                }
                // Wait for a window rather than buffering: an event that arrives
                // while the consumer is saturated is still held by the source's
                // own queue, so nothing is lost by pausing here.
                while control.credit.load(Ordering::SeqCst) <= 0 {
                    if control.cancelled.load(Ordering::SeqCst) {
                        break;
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                if control.cancelled.load(Ordering::SeqCst) {
                    break;
                }
                control.credit.fetch_sub(1, Ordering::SeqCst);
                if peer
                    .write(&json!({
                        "t": "sr", "id": next_id("x"), "sid": thread_sid,
                        "d": false, "v": value,
                    }))
                    .is_err()
                {
                    break;
                }
            }

            source.close();
            // Whoever still finds the entry in the table owns the stream and
            // therefore owes the terminal frame. A cancellation path removed it
            // already and answered on its own.
            let owned = {
                let mut streams = peer.streams.lock().expect("streams");
                streams.events.remove(&thread_sid).is_some()
            };
            if owned {
                let _ = peer.write(&json!({
                    "t": "sr", "id": next_id("x"), "sid": thread_sid, "d": true,
                }));
            }
        });

        Ok(sid)
    }

    /// Handle `t:"sr"` from the host: data for a stream this side consumes.
    fn dispatch_stream_data(self: &Arc<Self>, message: &Value) {
        let sid = message
            .get("sid")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        // A control acknowledgement is keyed by an id we generated, and owes no
        // reply of its own — the deferred request already answered.
        if let Some(error) = message.get("e") {
            if let Some(mut consumer) = self.take_consumer(&sid) {
                let text = error
                    .get("m")
                    .and_then(Value::as_str)
                    .unwrap_or("stream failed")
                    .to_string();
                consumer.sink.finish(Err(text));
            }
            return;
        }

        if message.get("d").and_then(Value::as_bool) == Some(true) {
            if let Some(mut consumer) = self.take_consumer(&sid) {
                consumer.sink.finish(Ok(()));
            }
            return;
        }

        let bytes = match decode_chunk(message.get("v")) {
            Ok(bytes) => bytes,
            Err(reason) => {
                if let Some(mut consumer) = self.take_consumer(&sid) {
                    consumer.sink.finish(Err(reason));
                }
                return;
            }
        };

        // Write with the lock RELEASED: a sink does file I/O, and holding the
        // stream table across it would block every other stream (and any
        // `return` trying to cancel this one).
        let outcome = {
            let mut streams = self.streams.lock().expect("streams");
            match streams.consumers.get_mut(&sid) {
                Some(consumer) => {
                    consumer.since_pull += 1;
                    let replenish = if consumer.since_pull >= REPLENISH {
                        consumer.since_pull = 0;
                        true
                    } else {
                        false
                    };
                    Some((consumer.sink.write(&bytes), replenish))
                }
                None => None,
            }
        };

        match outcome {
            // The sink failed: end the stream and honour the cancellation.
            Some((Err(message), _)) => {
                if let Some(mut consumer) = self.take_consumer(&sid) {
                    consumer.sink.finish(Err(message));
                }
                self.cancel_remote_stream(&sid);
            }
            Some((Ok(()), true)) => {
                // ⚠ The replenish write MUST be checked, and this is the only
                // ignored write in the consume path.
                //
                // If it fails the transport is gone, so no further chunks will
                // ever arrive — and the sink is what owns the consumer's deferred
                // reply. Leaving it unfinished means `hands.write`'s caller waits
                // out kkrpc's 30s timeout instead of being told the write died.
                //
                // `close_streams` is not a safety net here: it runs on reader EOF,
                // which may never come if only the WRITE side is broken. The
                // read-side path already does this correctly (it finishes the sink
                // with the sink's own error above); this is the mirror of it.
                if let Err(error) = self.write(&json!({
                    "t": "sq", "id": next_id("p"), "sid": sid,
                    "op": "pull", "n": REPLENISH,
                })) {
                    if let Some(mut consumer) = self.take_consumer(&sid) {
                        consumer
                            .sink
                            .finish(Err(format!("stream interrupted: {error}")));
                    }
                }
            }
            _ => {}
        }
    }

    fn take_consumer(&self, sid: &str) -> Option<Consumer> {
        self.streams.lock().expect("streams").consumers.remove(sid)
    }

    /// Drop local state for a stream. Used when the transport fails mid-stream.
    fn forget_stream(&self, sid: &str) {
        let mut streams = self.streams.lock().expect("streams");
        if let Some(producer) = streams.producers.remove(sid) {
            // Signal only: the producer's own thread is very likely inside
            // `next_chunk` right now, so it must be the one to close the handle.
            // Closing here would be a data race on the file.
            producer.cancel();
        }
        if let Some(mut consumer) = streams.consumers.remove(sid) {
            consumer
                .sink
                .finish(Err("stream interrupted by transport failure".into()));
        }
        streams.cancelled.insert(sid.to_string());
    }

    /// Tell the host to stop producing a stream we no longer want. Best-effort:
    /// the host treats an unknown stream as already finished.
    fn cancel_remote_stream(&self, sid: &str) {
        let _ = self.write(&json!({
            "t": "sq", "id": next_id("c"), "sid": sid, "op": "return",
        }));
    }

    /// Drop every stream (transport end). Producers are signalled; consumers fail.
    fn close_streams(&self) {
        let mut streams = self.streams.lock().expect("streams");
        for (_, producer) in streams.producers.drain() {
            // Signal, do not close: each producer's own thread owns its handle and
            // may be mid-`next_chunk`. It observes this flag and closes itself.
            producer.cancel();
        }
        for (_, mut consumer) in streams.consumers.drain() {
            consumer.sink.finish(Err(TRANSPORT_CLOSED.to_string()));
        }
        // Event threads own their sources, so they release the watch themselves;
        // this flag is what tells them to.
        for (_, event) in streams.events.drain() {
            event.cancelled.store(true, Ordering::SeqCst);
        }
    }

    fn write(&self, message: &Value) -> Result<(), String> {
        let mut encoded = serde_json::to_string(message).map_err(|err| err.to_string())?;
        encoded.push('\n');
        let mut writer = self.writer.lock().map_err(|err| err.to_string())?;
        writer
            .write_all(encoded.as_bytes())
            .map_err(|err| err.to_string())?;
        writer.flush().map_err(|err| err.to_string())
    }
}

fn unwrap_arg(value: &Value) -> Value {
    if value.get(ARG_ENVELOPE).and_then(Value::as_str) == Some("value") {
        value.get("v").cloned().unwrap_or(Value::Null)
    } else {
        value.clone()
    }
}

/// Hooks that exist only for the crate's own tests.
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    /// A [`DeferredReply`] wired to an in-memory sink, so a sink under test can
    /// call `send`/`fail` without a live transport.
    pub(crate) fn detached_reply() -> DeferredReply {
        let sink = Arc::new(Mutex::new(Vec::<u8>::new()));
        let peer = Peer::new(SharedSink(sink));
        DeferredReply::new(peer, "test".into())
    }

    /// A [`DeferredReply`] plus the bytes it writes, so a test can assert on the
    /// exact reply FRAME a sink produced.
    ///
    /// ⚠ Needed because asserting a sink's INTERNAL field is not the same as
    /// asserting what a caller receives. A regression test that read the field
    /// stayed green when the bug was re-injected; reading the emitted frame is
    /// what actually fails. See `hands.rs`'s
    /// `bytes_counts_what_this_call_wrote_not_the_resulting_file_size`.
    pub(crate) fn reply_with_sink() -> (DeferredReply, Arc<Mutex<Vec<u8>>>) {
        let sink = Arc::new(Mutex::new(Vec::<u8>::new()));
        let peer = Peer::new(SharedSink(Arc::clone(&sink)));
        (DeferredReply::new(peer, "test".into()), sink)
    }

    /// The last complete frame written through a [`reply_with_sink`] handle.
    pub(crate) fn last_frame(sink: &Arc<Mutex<Vec<u8>>>) -> serde_json::Value {
        let bytes = sink.lock().expect("sink");
        let text = String::from_utf8_lossy(&bytes);
        let line = text.lines().last().unwrap_or_default();
        serde_json::from_str(line).unwrap_or(serde_json::Value::Null)
    }

    /// A writer that keeps whatever it is given, for tests that only need the
    /// peer to exist.
    pub(crate) struct SharedSink(pub Arc<Mutex<Vec<u8>>>);

    impl Write for SharedSink {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            self.0.lock().expect("sink").extend_from_slice(data);
            Ok(data.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
}

/// Protocol- and transport-level tests.
///
/// These drive the peer over an **in-memory transport** rather than a real child
/// process. That is the point of the abstraction: framing, id routing and EOF
/// handling do not depend on stdio, so the tests must not either. A
/// child-process test would exercise the OS pipe as much as the protocol and
/// could not reach split or merged frames at all. The real stdio path keeps its
/// own end-to-end coverage in `host`'s sidecar tests.
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap as StdHashMap;
    use std::io::{self, Cursor, Read, Write};
    use std::sync::mpsc::{channel, Receiver, Sender};
    use std::time::Instant;

    /// Inbound half: the harness pushes byte chunks, the peer reads them.
    /// Dropping the sender is EOF, which is how a closed transport behaves.
    struct ChannelReader {
        rx: Receiver<Vec<u8>>,
        buf: Vec<u8>,
        pos: usize,
    }

    impl Read for ChannelReader {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            while self.pos >= self.buf.len() {
                match self.rx.recv() {
                    Ok(chunk) => {
                        self.buf = chunk;
                        self.pos = 0;
                    }
                    Err(_) => return Ok(0),
                }
            }
            let n = (self.buf.len() - self.pos).min(out.len());
            out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
            self.pos += n;
            Ok(n)
        }
    }

    /// Outbound half: whatever the peer writes lands in a channel the harness
    /// drains frame by frame.
    struct ChannelWriter {
        tx: Sender<Vec<u8>>,
    }

    impl Write for ChannelWriter {
        fn write(&mut self, data: &[u8]) -> io::Result<usize> {
            self.tx
                .send(data.to_vec())
                .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "harness gone"))?;
            Ok(data.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct Harness {
        peer: Arc<Peer>,
        out_rx: Receiver<Vec<u8>>,
        in_tx: Option<Sender<Vec<u8>>>,
        /// Bytes of a frame that has been read but not yet newline-terminated.
        leftover: Vec<u8>,
    }

    impl Harness {
        fn new() -> Self {
            let (out_tx, out_rx) = channel();
            let (in_tx, in_rx) = channel();
            let peer = Peer::new(ChannelWriter { tx: out_tx });
            peer.start_reader(ChannelReader {
                rx: in_rx,
                buf: Vec::new(),
                pos: 0,
            });
            Self {
                peer,
                out_rx,
                in_tx: Some(in_tx),
                leftover: Vec::new(),
            }
        }

        /// Send raw bytes to the peer (other-side → peer direction).
        fn feed(&self, text: &str) {
            self.in_tx
                .as_ref()
                .expect("inbound still open")
                .send(text.as_bytes().to_vec())
                .expect("feed");
        }

        /// Close the inbound direction, which the peer observes as EOF.
        fn close_inbound(&mut self) {
            self.in_tx = None;
        }

        /// Read exactly one protocol frame written by the peer.
        fn next_frame(&mut self) -> Value {
            loop {
                if let Some(end) = self.leftover.iter().position(|byte| *byte == b'\n') {
                    let text = String::from_utf8(self.leftover[..end].to_vec()).expect("utf8");
                    self.leftover.drain(..=end);
                    return serde_json::from_str(&text).expect("a JSON frame");
                }
                let chunk = self
                    .out_rx
                    .recv_timeout(Duration::from_secs(5))
                    .expect("peer wrote a frame");
                self.leftover.extend_from_slice(&chunk);
            }
        }
    }

    fn reply(id: &str, value: Value) -> String {
        format!("{}\n", json!({ "t": "r", "id": id, "v": value }))
    }

    fn error_reply(id: &str, message: &str) -> String {
        format!("{}\n", json!({ "t": "r", "id": id, "e": { "m": message } }))
    }

    // --- outbound framing (the contract with the TS side) -----------------

    #[test]
    fn outbound_frames_use_the_compact_shape() {
        let mut h = Harness::new();
        h.peer
            .notify("shell.notify", vec![json!("title"), json!("body")])
            .expect("write");
        let frame = h.next_frame();

        assert_eq!(frame["t"], json!("q"));
        assert_eq!(frame["op"], json!("call"));
        // The path is an array of segments, not a dotted string.
        assert_eq!(frame["p"], json!(["shell", "notify"]));
        assert_eq!(frame["a"], json!(["title", "body"]));
        assert!(frame["id"].as_str().is_some_and(|id| id.starts_with("n-")));
    }

    #[test]
    fn an_empty_argument_list_is_omitted_from_the_frame() {
        // `a` is present only when there are arguments. Pinned because it is a
        // wire detail the host's parser sees, not an implementation choice.
        let mut h = Harness::new();
        h.peer.notify("ping", Vec::new()).expect("write");
        let frame = h.next_frame();
        assert!(
            frame.get("a").is_none(),
            "empty args must not emit `a`: {frame}"
        );
        assert_eq!(frame["p"], json!(["ping"]));
    }

    #[test]
    fn calls_and_notifications_use_separate_id_spaces() {
        let mut h = Harness::new();
        h.peer.notify("ping", Vec::new()).expect("write");
        let notification = h.next_frame();
        assert!(
            notification["id"].as_str().unwrap().starts_with("n-"),
            "notify must not occupy the request id space: {notification}"
        );

        let peer = Arc::clone(&h.peer);
        let handle = thread::spawn(move || peer.call("ping", Vec::new()));
        let request = h.next_frame();
        let id = request["id"].as_str().unwrap().to_string();
        assert!(
            id.starts_with("r-"),
            "call must use the request space: {id}"
        );
        assert_ne!(id, notification["id"].as_str().unwrap());
        h.feed(&reply(&id, json!("pong")));
        assert_eq!(handle.join().unwrap().unwrap(), json!("pong"));
    }

    // --- request/reply routing --------------------------------------------

    #[test]
    fn a_reply_resolves_the_matching_call() {
        let mut h = Harness::new();
        let peer = Arc::clone(&h.peer);
        let handle = thread::spawn(move || peer.call("ping", Vec::new()));

        let id = h.next_frame()["id"].as_str().unwrap().to_string();
        h.feed(&reply(&id, json!("pong")));
        assert_eq!(handle.join().unwrap().unwrap(), json!("pong"));
        assert!(h.peer.pending.lock().unwrap().is_empty());
    }

    #[test]
    fn an_error_reply_becomes_a_call_error() {
        let mut h = Harness::new();
        let peer = Arc::clone(&h.peer);
        let handle = thread::spawn(move || peer.call("ping", Vec::new()));

        let id = h.next_frame()["id"].as_str().unwrap().to_string();
        h.feed(&error_reply(&id, "boom"));
        assert_eq!(handle.join().unwrap().unwrap_err(), "boom");
        assert!(h.peer.pending.lock().unwrap().is_empty());
    }

    #[test]
    fn concurrent_calls_resolve_against_their_own_replies_out_of_order() {
        let mut h = Harness::new();
        let one = {
            let peer = Arc::clone(&h.peer);
            thread::spawn(move || peer.call("one", Vec::new()))
        };
        let two = {
            let peer = Arc::clone(&h.peer);
            thread::spawn(move || peer.call("two", Vec::new()))
        };

        // Map by method, not arrival order: the two threads race.
        let mut ids: StdHashMap<String, String> = StdHashMap::new();
        for _ in 0..2 {
            let frame = h.next_frame();
            let method = frame["p"][0].as_str().unwrap().to_string();
            ids.insert(method, frame["id"].as_str().unwrap().to_string());
        }
        assert_eq!(ids.len(), 2, "distinct ids for distinct calls: {ids:?}");

        // Answer in the reverse order of the requests to prove keying, not FIFO.
        h.feed(&reply(&ids["two"], json!("second")));
        h.feed(&reply(&ids["one"], json!("first")));

        assert_eq!(one.join().unwrap().unwrap(), json!("first"));
        assert_eq!(two.join().unwrap().unwrap(), json!("second"));
    }

    #[test]
    fn a_call_times_out_when_no_reply_arrives() {
        let h = Harness::new();
        let err = h
            .peer
            .call_timeout("ping", Vec::new(), Duration::from_millis(50))
            .unwrap_err();
        assert!(err.contains("timed out"), "unexpected timeout text: {err}");
    }

    #[test]
    fn notify_never_registers_a_waiter() {
        let mut h = Harness::new();
        h.peer
            .notify("shell.window.show", Vec::new())
            .expect("write");
        let id = h.next_frame()["id"].as_str().unwrap().to_string();
        assert!(
            h.peer.pending.lock().unwrap().is_empty(),
            "a notification must not create a pending entry"
        );

        // Its reply is dropped, and dropping it must not disturb later traffic.
        h.feed(&reply(&id, json!(true)));
        h.peer.on("ping", Arc::new(|_| json!("still-alive")));
        let peer = Arc::clone(&h.peer);
        let handle = thread::spawn(move || peer.call("ping", Vec::new()));
        let next = h.next_frame()["id"].as_str().unwrap().to_string();
        h.feed(&reply(&next, json!("still-alive")));
        assert_eq!(handle.join().unwrap().unwrap(), json!("still-alive"));
    }

    // --- inbound dispatch --------------------------------------------------

    #[test]
    fn a_handler_receives_the_caller_arguments() {
        let mut h = Harness::new();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        h.peer.on(
            "probe",
            Arc::new(move |args| {
                *sink.lock().unwrap() = args;
                json!("ok")
            }),
        );

        h.feed("{\"t\":\"q\",\"id\":\"c1\",\"op\":\"call\",\"p\":[\"probe\"],\"a\":[\"x\",1]}\n");
        let frame = h.next_frame();
        assert_eq!(frame["id"], json!("c1"));
        assert_eq!(frame["v"], json!("ok"));
        assert_eq!(*seen.lock().unwrap(), vec![json!("x"), json!(1)]);
    }

    #[test]
    fn a_value_envelope_argument_is_unwrapped_before_the_handler_sees_it() {
        // kkrpc wraps callback-style arguments; the host expects the inner value
        // (official interop rule). A handler seeing the envelope would silently
        // mis-read every callback payload.
        let mut h = Harness::new();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        h.peer.on(
            "probe",
            Arc::new(move |args| {
                *sink.lock().unwrap() = args;
                Value::Null
            }),
        );

        h.feed(
            "{\"t\":\"q\",\"id\":\"c2\",\"op\":\"call\",\"p\":[\"probe\"],\
             \"a\":[{\"__kkrpc_next_arg__\":\"value\",\"v\":42},{\"plain\":1}]}\n",
        );
        h.next_frame();
        assert_eq!(
            *seen.lock().unwrap(),
            vec![json!(42), json!({ "plain": 1 })],
            "envelope unwrapped, plain object untouched"
        );
    }

    #[test]
    fn an_unknown_method_replies_with_an_error_naming_it() {
        let mut h = Harness::new();
        h.feed("{\"t\":\"q\",\"id\":\"c3\",\"op\":\"call\",\"p\":[\"shell\",\"nope\"]}\n");
        let frame = h.next_frame();
        assert_eq!(frame["id"], json!("c3"));
        assert_eq!(frame["e"]["m"], json!("unknown RPC method: shell.nope"));
        assert!(frame.get("v").is_none(), "an error reply carries no value");
    }

    #[test]
    fn a_method_with_no_arguments_is_dispatched_with_an_empty_list() {
        let mut h = Harness::new();
        let count = Arc::new(Mutex::new(None));
        let sink = Arc::clone(&count);
        h.peer.on(
            "probe",
            Arc::new(move |args| {
                *sink.lock().unwrap() = Some(args.len());
                Value::Null
            }),
        );
        h.feed("{\"t\":\"q\",\"id\":\"c4\",\"op\":\"call\",\"p\":[\"probe\"]}\n");
        h.next_frame();
        assert_eq!(*count.lock().unwrap(), Some(0));
    }

    // --- framing robustness ------------------------------------------------

    #[test]
    fn a_frame_split_across_reads_is_reassembled() {
        let mut h = Harness::new();
        h.peer.on("probe", Arc::new(|_| json!("ok")));
        h.feed("{\"t\":\"q\",\"id\":\"s1\",\"op\":\"call\",");
        h.feed("\"p\":[\"probe\"]}\n");
        assert_eq!(h.next_frame()["id"], json!("s1"));
    }

    #[test]
    fn several_frames_arriving_in_one_chunk_are_all_dispatched() {
        let mut h = Harness::new();
        h.peer.on(
            "probe",
            Arc::new(|args| json!(args.first().cloned().unwrap_or(Value::Null))),
        );
        h.feed(
            "{\"t\":\"q\",\"id\":\"m1\",\"op\":\"call\",\"p\":[\"probe\"],\"a\":[1]}\n\
             {\"t\":\"q\",\"id\":\"m2\",\"op\":\"call\",\"p\":[\"probe\"],\"a\":[2]}\n",
        );
        let first = h.next_frame();
        let second = h.next_frame();
        assert_eq!(
            (first["id"].clone(), first["v"].clone()),
            (json!("m1"), json!(1))
        );
        assert_eq!(
            (second["id"].clone(), second["v"].clone()),
            (json!("m2"), json!(2))
        );
    }

    #[test]
    fn malformed_and_blank_lines_are_skipped_without_killing_the_reader() {
        let mut h = Harness::new();
        h.peer.on("probe", Arc::new(|_| json!("ok")));
        h.feed("this is not json\n");
        h.feed("\n");
        h.feed("{\"t\":\"q\",\"id\":\"k1\",\"op\":\"call\",\"p\":[\"probe\"]}\n");
        // Reaching the reply at all proves the loop survived both bad lines.
        assert_eq!(h.next_frame()["id"], json!("k1"));
    }

    #[test]
    fn an_unrecognised_frame_type_is_ignored() {
        // Forward compatibility: a newer host may send frame types this shell
        // does not know. That must not be an error and must not stop the loop.
        let mut h = Harness::new();
        h.peer.on("probe", Arc::new(|_| json!("ok")));
        h.feed("{\"t\":\"future\",\"whatever\":1}\n");
        h.feed("{\"t\":\"r\",\"id\":\"no-such-request\",\"v\":1}\n");
        h.feed("{\"t\":\"q\",\"id\":\"f1\",\"op\":\"call\",\"p\":[\"probe\"]}\n");
        assert_eq!(h.next_frame()["id"], json!("f1"));
    }

    // --- disconnect policy -------------------------------------------------

    #[test]
    fn a_pending_call_fails_when_the_transport_reaches_eof() {
        let mut h = Harness::new();
        let peer = Arc::clone(&h.peer);
        let handle = thread::spawn(move || peer.call("ping", Vec::new()));

        h.next_frame(); // the request is on the wire, so a waiter exists
        assert_eq!(h.peer.pending.lock().unwrap().len(), 1);
        h.close_inbound();

        assert_eq!(handle.join().unwrap().unwrap_err(), TRANSPORT_CLOSED);
        assert!(
            h.peer.pending.lock().unwrap().is_empty(),
            "EOF must drain every waiter, not leak them into their timeouts"
        );
    }

    #[test]
    fn a_call_after_the_transport_closed_fails_instead_of_hanging() {
        let mut h = Harness::new();
        h.close_inbound();
        // Give the reader thread a moment to observe EOF.
        let deadline = Instant::now() + Duration::from_millis(500);
        while Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        let err = h
            .peer
            .call_timeout("ping", Vec::new(), Duration::from_millis(200))
            .unwrap_err();
        assert!(
            err.contains("timed out") || err == TRANSPORT_CLOSED,
            "a call on a dead transport must fail, not hang: {err}"
        );
    }

    // --- transport independence -------------------------------------------

    #[test]
    fn the_peer_runs_over_a_non_channel_transport() {
        // A shared buffer plus a cursor: nothing pipe-, channel- or
        // process-shaped. This is the actual claim of the abstraction — that
        // framing and dispatch do not depend on stdio — stated without the test
        // harness's own transports.
        struct SharedSink(Arc<Mutex<Vec<u8>>>);
        impl Write for SharedSink {
            fn write(&mut self, data: &[u8]) -> io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(data);
                Ok(data.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let sink = Arc::new(Mutex::new(Vec::<u8>::new()));
        let peer = Peer::new(SharedSink(Arc::clone(&sink)));
        peer.on("probe", Arc::new(|_| json!("ok")));
        peer.start_reader(Cursor::new(
            b"{\"t\":\"q\",\"id\":\"n1\",\"op\":\"call\",\"p\":[\"probe\"]}\n".to_vec(),
        ));

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let text = String::from_utf8(sink.lock().unwrap().clone()).expect("utf8");
            if let Some(line) = text.lines().next() {
                let frame: Value = serde_json::from_str(line).expect("a JSON frame");
                assert_eq!(frame["id"], json!("n1"));
                assert_eq!(frame["v"], json!("ok"));
                return;
            }
            assert!(
                Instant::now() < deadline,
                "no reply written over the non-channel transport"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn a_writer_failure_is_reported_as_a_call_error() {
        // The transport can refuse writes (a closed socket, a dead pipe). That
        // must surface as an error on the call, and must not leak a pending
        // entry that would only clear on timeout.
        struct BrokenWriter;
        impl Write for BrokenWriter {
            fn write(&mut self, _data: &[u8]) -> io::Result<usize> {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed"))
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let peer = Peer::new(BrokenWriter);
        let err = peer
            .call_timeout("ping", Vec::new(), Duration::from_millis(50))
            .unwrap_err();
        assert!(
            err.contains("closed"),
            "write failure must be reported: {err}"
        );
        assert!(
            peer.pending.lock().unwrap().is_empty(),
            "a failed write must not leave a waiter behind"
        );
    }

    // --- framing edge cases ------------------------------------------------

    #[test]
    fn a_reply_without_a_value_resolves_to_null() {
        let mut h = Harness::new();
        let peer = Arc::clone(&h.peer);
        let handle = thread::spawn(move || peer.call("ping", Vec::new()));
        let id = h.next_frame()["id"].as_str().unwrap().to_string();
        h.feed(&format!("{}\n", json!({ "t": "r", "id": id })));
        assert_eq!(handle.join().unwrap().unwrap(), Value::Null);
    }

    #[test]
    fn an_error_reply_without_a_message_falls_back_to_a_generic_text() {
        let mut h = Harness::new();
        let peer = Arc::clone(&h.peer);
        let handle = thread::spawn(move || peer.call("ping", Vec::new()));
        let id = h.next_frame()["id"].as_str().unwrap().to_string();
        h.feed(&format!("{}\n", json!({ "t": "r", "id": id, "e": {} })));
        assert_eq!(handle.join().unwrap().unwrap_err(), "RPC error");
    }

    #[test]
    fn a_reply_carrying_no_id_is_ignored() {
        let mut h = Harness::new();
        h.peer.on("probe", Arc::new(|_| json!("ok")));
        h.feed("{\"t\":\"r\",\"v\":1}\n");
        h.feed("{\"t\":\"q\",\"id\":\"g1\",\"op\":\"call\",\"p\":[\"probe\"]}\n");
        assert_eq!(h.next_frame()["id"], json!("g1"));
    }

    // --- stream chunk decoding ---------------------------------------------

    #[test]
    fn a_base64_chunk_is_decoded() {
        // The carrier we SEND: 1.33x the payload and the cheapest of the three
        // shapes reachable through the stock JSON codec.
        //
        // ⚠ "cheapest available", not "required by the protocol". kkrpc lets the
        // platform and codec be replaced (`createTransport({platform, codec})`),
        // and a length-prefixed binary framing over the SAME pipe is measured at
        // 1.8-2.1x faster than base64 (docs/probes/hand-io/04-binary-framing.mjs,
        // FINDINGS §5.1). Adopting it requires changing BOTH ends — that is the
        // cost, not an impossibility. Do not describe base64 as a contract.
        let decoded = decode_chunk(Some(&json!("AAEC"))).expect("decode");
        assert_eq!(decoded, vec![0u8, 1, 2]);
    }

    #[test]
    fn a_node_buffer_shaped_chunk_is_decoded() {
        // What a raw Node `Buffer` becomes once the stock JSON transport sees it.
        let decoded =
            decode_chunk(Some(&json!({ "type": "Buffer", "data": [65, 66] }))).expect("decode");
        assert_eq!(decoded, b"AB");
    }

    #[test]
    fn a_uint8array_shaped_chunk_is_decoded() {
        // What a raw `Uint8Array` becomes — 11.4x the payload. Accepted rather
        // than rejected so a host that forgets to encode still transfers
        // correctly; the cost is recorded, not hidden.
        let decoded = decode_chunk(Some(&json!({ "0": 90, "1": 91 }))).expect("decode");
        assert_eq!(decoded, vec![90u8, 91]);
    }

    #[test]
    fn a_non_contiguous_byte_map_is_refused_with_a_naming_message() {
        // {"0":1,"2":3} is not a byte array; silently reading 2 bytes would
        // corrupt the file in a way the caller cannot detect.
        let error = decode_chunk(Some(&json!({ "0": 1, "2": 3 }))).expect_err("must fail");
        assert!(error.contains("missing key 1"), "got: {error}");
    }

    #[test]
    fn an_empty_object_decodes_to_no_bytes() {
        // An empty Uint8Array serialises to `{}`. Treating it as an error would
        // abort a transfer whose producer legitimately emitted an empty chunk.
        assert_eq!(
            decode_chunk(Some(&json!({}))).expect("decode"),
            Vec::<u8>::new()
        );
    }

    #[test]
    fn an_unrecognised_chunk_shape_is_an_error_not_a_silent_empty_read() {
        let error = decode_chunk(Some(&json!(42))).expect_err("must fail");
        assert!(
            error.contains("unrecognised stream value shape"),
            "got: {error}"
        );
        assert!(
            decode_chunk(None).is_err(),
            "a missing value must not read as empty"
        );
    }

    // --- streaming: producer side ------------------------------------------

    /// A producer that yields a fixed number of chunks then ends.
    struct CountingProducer {
        remaining: usize,
        closed: Arc<Mutex<bool>>,
    }

    impl StreamProducer for CountingProducer {
        fn next_chunk(&mut self) -> StreamStep {
            if self.remaining == 0 {
                return StreamStep::Done;
            }
            self.remaining -= 1;
            StreamStep::Chunk(vec![7u8; 4])
        }
        fn close(&mut self) {
            *self.closed.lock().unwrap() = true;
        }
    }

    /// A producer whose every chunk takes `per_chunk` to produce.
    ///
    /// Models a real file read: the cost is INSIDE `next_chunk`, which is where
    /// `pump_producer` spends its batch. Used to measure head-of-line blocking —
    /// see `an_inbound_request_is_served_while_a_large_batch_is_in_flight`.
    struct SlowProducer {
        remaining: usize,
        per_chunk: Duration,
        closed: Arc<Mutex<bool>>,
    }

    impl StreamProducer for SlowProducer {
        fn next_chunk(&mut self) -> StreamStep {
            if self.remaining == 0 {
                return StreamStep::Done;
            }
            self.remaining -= 1;
            thread::sleep(self.per_chunk);
            StreamStep::Chunk(vec![7u8; 4])
        }
        fn close(&mut self) {
            *self.closed.lock().unwrap() = true;
        }
    }

    #[test]
    fn an_inbound_request_is_served_while_a_large_batch_is_in_flight() {
        // ⚠ THE HEAD-OF-LINE-BLOCKING REGRESSION.
        //
        // `pump_producer` used to run `for _ in 0..credit` ON THE READER THREAD,
        // so while a batch was being produced the reader was not in `read_line`
        // and an inbound request waited for the batch to finish. Measured end to
        // end (docs/probes/hands-e2e/hol-credit.mjs): p95 degradation grew with
        // the credit — 22x at credit 4, 196x at credit 32 — and MID-batch probes
        // were far worse than END-batch ones, which is the signature of
        // starvation rather than queueing.
        //
        // The contract this pins: producing N chunks must NOT delay an inbound
        // request by anything proportional to N. Timing-based, so the assertions
        // are deliberately loose (a generous multiple of the production cost
        // rather than an exact bound) — the point is to catch "waits for the
        // WHOLE batch", not to measure microseconds.
        let mut h = Harness::new();
        let per_chunk = Duration::from_millis(20);
        let credit = 16; // 16 * 20ms = 320ms if the batch is not interruptible
        let closed = Arc::new(Mutex::new(false));
        h.peer
            .open_stream(
                "req-1",
                Box::new(SlowProducer {
                    remaining: 1000,
                    per_chunk,
                    closed: Arc::clone(&closed),
                }),
            )
            .expect("open");
        let sid = h.next_frame()["v"]["id"].as_str().unwrap().to_string();

        // A handler that answers immediately.
        h.peer.on("ping", Arc::new(|_| json!("still-alive")));

        // Ask for a batch big enough that serving it blocks the reader for a
        // long time if the pump owns that thread.
        h.feed(&format!(
            "{}\n",
            json!({ "t": "sq", "id": "c1", "sid": sid, "op": "pull", "n": credit })
        ));
        // Then, while that batch is being produced, send an ordinary request.
        // ⚠ `"op":"call"` is required: a `t:"q"` frame without it is not a
        // request and is never dispatched (the first version of this test omitted
        // it and failed with a frame TIMEOUT rather than the timing assertion —
        // which looks like the bug but is only a malformed frame).
        h.feed(&format!(
            "{}\n",
            json!({ "t": "q", "id": "p1", "op": "call", "p": ["ping"] })
        ));

        // Drain frames until the ping is answered, recording how long it took.
        let started = Instant::now();
        let mut answered = None;
        while started.elapsed() < Duration::from_secs(10) {
            let frame = h.next_frame();
            if frame["id"] == json!("p1") {
                answered = Some(started.elapsed());
                break;
            }
        }

        let latency = answered.expect("the ping must be answered");
        // The batch takes credit * per_chunk to produce; a blocked reader could
        // not answer before most of it elapsed. Require the answer well inside
        // that window — generous enough to survive a loaded CI machine, tight
        // enough to fail when the whole batch is un-interruptible.
        let batch_cost = per_chunk * credit as u32;
        assert!(
            latency < batch_cost / 2,
            "an inbound request waited {latency:?} — the producer is starving the \
             reader thread (one batch costs {batch_cost:?})"
        );
    }

    #[test]
    fn opening_a_stream_replies_with_a_reference_not_data() {
        // The whole memory argument: the reply must be a stream-ref envelope, so
        // a multi-GB file costs the credit window rather than the file size.
        let mut h = Harness::new();
        let closed = Arc::new(Mutex::new(false));
        h.peer
            .open_stream(
                "req-1",
                Box::new(CountingProducer {
                    remaining: 2,
                    closed: Arc::clone(&closed),
                }),
            )
            .expect("open");

        let reply = h.next_frame();
        assert_eq!(reply["id"], json!("req-1"));
        assert_eq!(reply["v"][STREAM_REF], json!("async-iterable"));
        assert!(
            reply["v"]["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("s-")),
            "the reply must carry a stream id, not bytes: {reply}"
        );
    }

    #[test]
    fn a_pull_emits_exactly_the_requested_credit() {
        // Credit is the backpressure mechanism, so "one pull emits N" is a
        // contract, not an implementation detail.
        let mut h = Harness::new();
        h.peer
            .open_stream(
                "req-1",
                Box::new(CountingProducer {
                    remaining: 10,
                    closed: Arc::new(Mutex::new(false)),
                }),
            )
            .expect("open");
        let sid = h.next_frame()["v"]["id"].as_str().unwrap().to_string();

        h.feed(&format!(
            "{}\n",
            json!({ "t": "sq", "id": "c1", "sid": sid, "op": "pull", "n": 3 })
        ));

        for _ in 0..3 {
            let frame = h.next_frame();
            assert_eq!(frame["t"], json!("sr"));
            assert_eq!(frame["sid"], json!(sid));
            assert_eq!(frame["d"], json!(false));
            assert!(frame["v"].is_string(), "chunks travel base64-encoded");
        }
    }

    #[test]
    fn a_producer_that_ends_sends_a_terminal_frame_and_is_forgotten() {
        // ⚠ The close is ASYNCHRONOUS: the producer owns its own thread, so the
        // terminal frame is written by that thread and the handle is closed on its
        // way out — a hair AFTER the frame the reader just observed. Asserting
        // `closed` immediately is therefore a race (this failed only when several
        // `cargo test` runs shared the machine). Poll for the invariant; see the
        // sibling test below for the same lesson on the cancellation path.
        let mut h = Harness::new();
        let closed = Arc::new(Mutex::new(false));
        h.peer
            .open_stream(
                "req-1",
                Box::new(CountingProducer {
                    remaining: 1,
                    closed: Arc::clone(&closed),
                }),
            )
            .expect("open");
        let sid = h.next_frame()["v"]["id"].as_str().unwrap().to_string();

        h.feed(&format!(
            "{}\n",
            json!({ "t": "sq", "id": "c1", "sid": sid, "op": "pull", "n": 5 })
        ));

        assert_eq!(h.next_frame()["d"], json!(false));
        let terminal = h.next_frame();
        assert_eq!(terminal["d"], json!(true), "clean end must be terminal");

        let deadline = Instant::now() + Duration::from_secs(5);
        while !*closed.lock().unwrap() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(
            *closed.lock().unwrap(),
            "a finished producer must be closed, not left holding a handle"
        );

        // The table entry is removed BEFORE the terminal frame is written (that
        // is how the ending is claimed), so this one is not racy.
        assert!(
            h.peer.streams.lock().unwrap().producers.is_empty(),
            "a finished stream must not be retained"
        );
    }

    #[test]
    fn returning_a_stream_closes_the_producer_and_acknowledges() {
        // Cancellation must release the file handle, or a long-lived shell leaks
        // one descriptor per abandoned download.
        //
        // ⚠ The close is ASYNCHRONOUS now, and this test was racy because of it.
        // Since the producer owns its own thread, `return` only SIGNALS
        // (`ProducerStream::cancel`); the owning thread closes the handle on its
        // way out, because closing from the reader would race a thread that may
        // be inside `next_chunk`. So the ordering is: reader acks → thread
        // observes the flag → thread closes. Asserting `closed` immediately after
        // the ack therefore loses that race under load — it reproduced only when
        // several `cargo test` runs shared the machine. Poll for the invariant.
        let mut h = Harness::new();
        let closed = Arc::new(Mutex::new(false));
        h.peer
            .open_stream(
                "req-1",
                Box::new(CountingProducer {
                    remaining: 10,
                    closed: Arc::clone(&closed),
                }),
            )
            .expect("open");
        let sid = h.next_frame()["v"]["id"].as_str().unwrap().to_string();

        h.feed(&format!(
            "{}\n",
            json!({ "t": "sq", "id": "ctl-1", "sid": sid, "op": "return" })
        ));

        let ack = h.next_frame();
        assert_eq!(
            ack["id"],
            json!("ctl-1"),
            "`return` owes its control id back"
        );
        assert_eq!(ack["d"], json!(true));

        // The invariant this test is actually about: the handle IS released.
        let deadline = Instant::now() + Duration::from_secs(5);
        while !*closed.lock().unwrap() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(
            *closed.lock().unwrap(),
            "the cancelled producer must be closed"
        );
    }

    #[test]
    fn no_further_chunks_arrive_after_a_cancel() {
        // The failure this prevents: a `return` that races a pump, after which
        // the producer is re-inserted and keeps reading a file nobody wants.
        let mut h = Harness::new();
        h.peer
            .open_stream(
                "req-1",
                Box::new(CountingProducer {
                    remaining: 100,
                    closed: Arc::new(Mutex::new(false)),
                }),
            )
            .expect("open");
        let sid = h.next_frame()["v"]["id"].as_str().unwrap().to_string();

        h.feed(&format!(
            "{}\n",
            json!({ "t": "sq", "id": "ctl-1", "sid": sid, "op": "return" })
        ));
        assert_eq!(h.next_frame()["id"], json!("ctl-1"));

        // A pull for a cancelled stream must produce nothing at all.
        h.feed(&format!(
            "{}\n",
            json!({ "t": "sq", "id": "c2", "sid": sid, "op": "pull", "n": 5 })
        ));
        // A live probe proves the reader survived and stayed silent about `sid`.
        h.peer.on("ping", Arc::new(|_| json!("pong")));
        h.feed("{\"t\":\"q\",\"id\":\"probe-1\",\"op\":\"call\",\"p\":[\"ping\"]}\n");
        assert_eq!(h.next_frame()["id"], json!("probe-1"));
    }

    #[test]
    fn a_transport_end_closes_every_producer() {
        // No peer means no pulls ever again; an open producer would hold a file
        // handle until the process exits.
        let mut h = Harness::new();
        let closed = Arc::new(Mutex::new(false));
        h.peer
            .open_stream(
                "req-1",
                Box::new(CountingProducer {
                    remaining: 10,
                    closed: Arc::clone(&closed),
                }),
            )
            .expect("open");
        h.next_frame();
        h.close_inbound();

        let deadline = Instant::now() + Duration::from_secs(2);
        while !*closed.lock().unwrap() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(*closed.lock().unwrap(), "EOF must close open producers");
    }

    // --- streaming: consumer side -----------------------------------------

    /// A sink that records what it is given.
    struct RecordingSink {
        bytes: Arc<Mutex<Vec<u8>>>,
        outcome: Arc<Mutex<Option<Result<(), String>>>>,
    }

    impl StreamSink for RecordingSink {
        fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
            self.bytes.lock().unwrap().extend_from_slice(bytes);
            Ok(())
        }
        fn finish(&mut self, outcome: Result<(), String>) {
            *self.outcome.lock().unwrap() = Some(outcome);
        }
    }

    fn recording_sink() -> (
        Box<dyn StreamSink>,
        Arc<Mutex<Vec<u8>>>,
        Arc<Mutex<Option<Result<(), String>>>>,
    ) {
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let outcome = Arc::new(Mutex::new(None));
        (
            Box::new(RecordingSink {
                bytes: Arc::clone(&bytes),
                outcome: Arc::clone(&outcome),
            }),
            bytes,
            outcome,
        )
    }

    /// Wait for a sink to be finished, then return a COPY of its outcome.
    ///
    /// Cloned rather than borrowed: the guard's temporary would otherwise
    /// outlive the match on it.
    fn await_outcome(
        outcome: &Arc<Mutex<Option<Result<(), String>>>>,
    ) -> Option<Result<(), String>> {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(value) = outcome.lock().unwrap().clone() {
                return Some(value);
            }
            if Instant::now() >= deadline {
                return None;
            }
            thread::sleep(Duration::from_millis(5));
        }
    }

    /// Poll until `ready` holds, or give up after `limit`.
    ///
    /// Required because dispatch runs on the reader THREAD: `feed` returns as
    /// soon as the bytes are queued, so a synchronous assertion right after it
    /// is a race, not a check. Every test that observes a side effect of a fed
    /// frame must go through here.
    fn wait_until(limit: Duration, mut ready: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + limit;
        loop {
            if ready() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn consuming_a_stream_opens_the_credit_window_before_any_data() {
        // kkrpc's producer sends nothing until it sees a pull, so a consumer
        // that forgot this would deadlock rather than fail loudly.
        let mut h = Harness::new();
        let (sink, _, _) = recording_sink();
        h.peer.consume_stream("s-9", sink).expect("consume");

        let pull = h.next_frame();
        assert_eq!(pull["t"], json!("sq"));
        assert_eq!(pull["op"], json!("pull"));
        assert_eq!(pull["sid"], json!("s-9"));
        assert_eq!(
            pull["n"],
            json!(INITIAL_CREDIT),
            "the initial window must match kkrpc's own consumer"
        );
    }

    #[test]
    fn stream_data_is_written_to_the_sink_and_replenished() {
        let mut h = Harness::new();
        let (sink, bytes, _) = recording_sink();
        h.peer.consume_stream("s-9", sink).expect("consume");
        h.next_frame(); // the opening pull

        // Feed one short of the replenish threshold, then the one that trips it.
        for _ in 0..REPLENISH - 1 {
            h.feed(&format!(
                "{}\n",
                json!({ "t": "sr", "id": "x", "sid": "s-9", "d": false, "v": "AAE=" })
            ));
        }
        // Dispatch is asynchronous (reader thread), so wait for the writes to
        // land rather than assuming `feed` has been processed.
        let partial = (REPLENISH - 1) * 2;
        assert!(
            wait_until(Duration::from_secs(2), || bytes.lock().unwrap().len()
                == partial),
            "expected {partial} bytes before the replenish threshold, got {}",
            bytes.lock().unwrap().len()
        );

        h.feed(&format!(
            "{}\n",
            json!({ "t": "sr", "id": "x", "sid": "s-9", "d": false, "v": "AAE=" })
        ));

        let pull = h.next_frame();
        assert_eq!(pull["op"], json!("pull"), "credit must be replenished");
        assert_eq!(pull["n"], json!(REPLENISH));
        assert_eq!(bytes.lock().unwrap().len(), REPLENISH * 2);
    }

    #[test]
    fn a_terminal_frame_finishes_the_sink_exactly_once() {
        let mut h = Harness::new();
        let (sink, _, outcome) = recording_sink();
        h.peer.consume_stream("s-9", sink).expect("consume");
        h.next_frame();

        h.feed("{\"t\":\"sr\",\"id\":\"x\",\"sid\":\"s-9\",\"d\":true}\n");
        assert!(
            matches!(await_outcome(&outcome), Some(Ok(()))),
            "a clean end must finish the sink with Ok"
        );
        assert!(
            h.peer.streams.lock().unwrap().consumers.is_empty(),
            "a finished consumer must not be retained"
        );
    }

    #[test]
    fn an_errored_stream_fails_the_sink_with_the_sender_message() {
        let mut h = Harness::new();
        let (sink, _, outcome) = recording_sink();
        h.peer.consume_stream("s-9", sink).expect("consume");
        h.next_frame();

        h.feed("{\"t\":\"sr\",\"id\":\"x\",\"sid\":\"s-9\",\"e\":{\"m\":\"disk full\"}}\n");
        match await_outcome(&outcome) {
            Some(Err(message)) => assert!(message.contains("disk full"), "got: {message}"),
            other => panic!("expected a failure carrying the sender's message, got {other:?}"),
        }
    }

    #[test]
    fn a_sink_failure_ends_the_stream_and_tells_the_producer_to_stop() {
        // A full disk must not leave the host pumping forever into a dead sink.
        struct FailingSink;
        impl StreamSink for FailingSink {
            fn write(&mut self, _bytes: &[u8]) -> Result<(), String> {
                Err("ENOSPC: no space left on device".into())
            }
            fn finish(&mut self, _outcome: Result<(), String>) {}
        }

        let mut h = Harness::new();
        h.peer
            .consume_stream("s-9", Box::new(FailingSink))
            .expect("consume");
        h.next_frame(); // opening pull

        h.feed("{\"t\":\"sr\",\"id\":\"x\",\"sid\":\"s-9\",\"d\":false,\"v\":\"AAE=\"}\n");

        // The peer must both forget the consumer and ask the host to stop.
        let cancel = h.next_frame();
        assert_eq!(cancel["t"], json!("sq"));
        assert_eq!(cancel["op"], json!("return"));
        assert_eq!(cancel["sid"], json!("s-9"));
        assert!(
            h.peer.streams.lock().unwrap().consumers.is_empty(),
            "a failed consumer must not be retained"
        );
    }

    #[test]
    fn consuming_the_same_stream_twice_is_refused() {
        // Two sinks on one stream would split the bytes between them and corrupt
        // both outputs.
        let h = Harness::new();
        let (first, _, _) = recording_sink();
        h.peer.consume_stream("s-9", first).expect("first");
        let (second, _, _) = recording_sink();
        let error = h
            .peer
            .consume_stream("s-9", second)
            .expect_err("must refuse");
        assert!(error.contains("already being consumed"), "got: {error}");
    }

    #[test]
    fn a_transport_end_fails_every_consumer() {
        let mut h = Harness::new();
        let (sink, _, outcome) = recording_sink();
        h.peer.consume_stream("s-9", sink).expect("consume");
        h.next_frame();
        h.close_inbound();

        match await_outcome(&outcome) {
            Some(Err(message)) => assert_eq!(message, TRANSPORT_CLOSED),
            other => panic!("EOF must fail a waiting consumer, got {other:?}"),
        }
    }

    // --- streaming: deferred replies ---------------------------------------

    #[test]
    fn a_deferred_handler_owns_the_reply() {
        // Nothing may be written when the handler returns; the sink answers later.
        let mut h = Harness::new();
        let captured = Arc::new(Mutex::new(None::<DeferredReply>));
        let sink = Arc::clone(&captured);
        h.peer.on_deferred(
            "hands.write",
            Arc::new(move |reply, _args| {
                *sink.lock().unwrap() = Some(reply);
            }),
        );

        h.feed("{\"t\":\"q\",\"id\":\"d1\",\"op\":\"call\",\"p\":[\"hands\",\"write\"]}\n");
        assert!(
            wait_until(Duration::from_secs(2), || captured
                .lock()
                .unwrap()
                .is_some()),
            "the deferred handler must run and capture the reply"
        );
        let reply = captured.lock().unwrap().clone().expect("handler ran");
        assert_eq!(reply.id(), "d1");

        reply.send(json!({ "bytes": 5 }));
        let frame = h.next_frame();
        assert_eq!(frame["id"], json!("d1"));
        assert_eq!(frame["v"]["bytes"], json!(5));
    }

    #[test]
    fn a_deferred_failure_reaches_the_caller_as_an_error() {
        let mut h = Harness::new();
        let captured = Arc::new(Mutex::new(None::<DeferredReply>));
        let sink = Arc::clone(&captured);
        h.peer.on_deferred(
            "hands.write",
            Arc::new(move |reply, _args| {
                *sink.lock().unwrap() = Some(reply);
            }),
        );

        h.feed("{\"t\":\"q\",\"id\":\"d2\",\"op\":\"call\",\"p\":[\"hands\",\"write\"]}\n");
        assert!(
            wait_until(Duration::from_secs(2), || captured
                .lock()
                .unwrap()
                .is_some()),
            "the deferred handler must run before its reply is used"
        );
        captured
            .lock()
            .unwrap()
            .clone()
            .expect("handler ran")
            .fail("ENOSPC: full");
        let frame = h.next_frame();
        assert_eq!(frame["id"], json!("d2"));
        assert_eq!(frame["e"]["m"], json!("ENOSPC: full"));
    }

    // --- streaming: event sources ------------------------------------------

    /// An event source that yields a fixed list, then reports "quiet" forever.
    struct ScriptedSource {
        values: Vec<Value>,
        closed: Arc<Mutex<bool>>,
    }

    impl StreamSource for ScriptedSource {
        fn next_value(&mut self, _timeout: Duration) -> Option<Value> {
            if self.values.is_empty() {
                // Quiet, not exhausted: a watch that stops firing is normal.
                thread::sleep(Duration::from_millis(5));
                return None;
            }
            self.values.remove(0).into()
        }
        fn close(&mut self) {
            *self.closed.lock().unwrap() = true;
        }
    }

    #[test]
    fn an_event_stream_replies_with_a_reference_then_emits_on_credit() {
        let mut h = Harness::new();
        let closed = Arc::new(Mutex::new(false));
        h.peer
            .open_event_stream(
                "req-w",
                Box::new(ScriptedSource {
                    values: vec![json!({ "kind": "create" })],
                    closed: Arc::clone(&closed),
                }),
            )
            .expect("open");

        let reply = h.next_frame();
        assert_eq!(reply["id"], json!("req-w"));
        let sid = reply["v"]["id"].as_str().unwrap().to_string();

        // No credit yet, so nothing may arrive. Probe with a real request.
        h.peer.on("ping", Arc::new(|_| json!("pong")));
        h.feed("{\"t\":\"q\",\"id\":\"p0\",\"op\":\"call\",\"p\":[\"ping\"]}\n");
        assert_eq!(h.next_frame()["id"], json!("p0"));

        h.feed(&format!(
            "{}\n",
            json!({ "t": "sq", "id": "c1", "sid": sid, "op": "pull", "n": 1 })
        ));
        let event = h.next_frame();
        assert_eq!(event["sid"], json!(sid));
        assert_eq!(event["v"]["kind"], json!("create"));
    }

    #[test]
    fn cancelling_an_event_stream_closes_the_source() {
        // The requirement the proposal calls out: cancelling must release the
        // watch, not merely stop delivering.
        let mut h = Harness::new();
        let closed = Arc::new(Mutex::new(false));
        h.peer
            .open_event_stream(
                "req-w",
                Box::new(ScriptedSource {
                    values: Vec::new(),
                    closed: Arc::clone(&closed),
                }),
            )
            .expect("open");
        let sid = h.next_frame()["v"]["id"].as_str().unwrap().to_string();

        h.feed(&format!(
            "{}\n",
            json!({ "t": "sq", "id": "ctl-1", "sid": sid, "op": "return" })
        ));

        assert_eq!(h.next_frame()["id"], json!("ctl-1"));
        let deadline = Instant::now() + Duration::from_secs(3);
        while !*closed.lock().unwrap() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(
            *closed.lock().unwrap(),
            "cancelling a watch must close it, or the OS watch leaks"
        );
    }

    #[test]
    fn a_transport_end_stops_event_streams() {
        // A watch outliving its transport would keep firing into a dead pipe.
        let mut h = Harness::new();
        let closed = Arc::new(Mutex::new(false));
        h.peer
            .open_event_stream(
                "req-w",
                Box::new(ScriptedSource {
                    values: Vec::new(),
                    closed: Arc::clone(&closed),
                }),
            )
            .expect("open");
        h.next_frame();
        h.close_inbound();

        let deadline = Instant::now() + Duration::from_secs(3);
        while !*closed.lock().unwrap() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(*closed.lock().unwrap(), "EOF must stop open event streams");
    }
}
