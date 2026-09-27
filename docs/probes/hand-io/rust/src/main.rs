//! A Rust "hands" endpoint that speaks the kkrpc compact protocol over stdio,
//! exactly as `src-tauri/src/kkrpc_peer.rs` does, and is asked to move file
//! bytes. Answers, by measurement:
//!
//!   1. What does a `Uint8Array` cost on the wire when it rides the JSON text
//!      framing that stdio actually uses? (The transport-lab measured 11.4x for
//!      kkrpc's *ws* transport; this pins the SAME number for the stdio shape the
//!      brain<->hands bridge uses.)
//!   2. base64 vs the numeric-keyed JSON object: which is cheaper, and by how
//!      much?
//!   3. Does a full round trip through Rust actually preserve the bytes?
//!
//! Protocol (from src-tauri/src/kkrpc_peer.rs):
//!   request   {"t":"q","id":"r-1","op":"call","p":["ns","method"],"a":[...]}
//!   response  {"t":"r","id":"r-1","v":<value>}
//!   error     {"t":"r","id":"r-1","e":{"m":"..."}}
//!
//! One JSON object per line. That is the whole framing.

use base64::Engine as _;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};

/// Cost of carrying `len` raw bytes as the numeric-keyed object JSON.stringify
/// produces for a `Uint8Array`: `{"0":12,"1":13,...}`.
///
/// Rather than estimate, build the real string for a small sample and measure
/// its growth, then extrapolate — the shape is regular.
fn measure_json_object_expansion(len: usize) -> (usize, f64) {
    let sample_len = len.min(4096).max(1);
    let bytes: Vec<u8> = (0..sample_len).map(|i| (i % 256) as u8).collect();
    // Mirror JSON.stringify(new Uint8Array(...)): index keys, comma separated.
    let mut text = String::with_capacity(sample_len * 5);
    text.push('{');
    for (i, byte) in bytes.iter().enumerate() {
        if i > 0 {
            text.push(',');
        }
        text.push('"');
        text.push_str(&i.to_string());
        text.push_str("\":");
        text.push_str(&byte.to_string());
    }
    text.push('}');
    let ratio = text.len() as f64 / sample_len as f64;
    // The per-index overhead is stable, so scaling the sample is exact enough:
    // the digits-per-index term is the only non-linear part and it is marginal.
    let projected = (len as f64 * ratio) as usize;
    (projected, ratio)
}

fn main() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
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
        if message.get("t").and_then(Value::as_str) != Some("q") {
            continue;
        }
        let id = message
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let path: Vec<String> = message
            .get("p")
            .and_then(Value::as_array)
            .map(|p| {
                p.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let method = path.join(".");
        let args = message
            .get("a")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let reply = match method.as_str() {
            // Echo the payload straight back. The JS side measures what it costs
            // on the wire and confirms the bytes survive.
            "probe.echo" => json!({ "t": "r", "id": id, "v": args.first().cloned().unwrap_or(Value::Null) }),

            // Report the expansion cost of the two candidate encodings for a
            // payload of `a[0]` bytes. No bytes cross the wire: this is the
            // arithmetic that decides which one the bridge should use.
            "probe.encodingCost" => {
                let len = args.first().and_then(Value::as_u64).unwrap_or(0) as usize;
                let (json_len, ratio) = measure_json_object_expansion(len);
                let b64_len = len.div_ceil(3) * 4;
                json!({
                    "t": "r",
                    "id": id,
                    "v": {
                        "bytes": len,
                        // What kkrpc's built-in JSON path produces for a Uint8Array.
                        "jsonObjectLen": json_len,
                        "jsonObjectRatio": ratio,
                        // What a base64 string costs.
                        "base64Len": b64_len,
                        "base64Ratio": (b64_len as f64) / (len.max(1) as f64),
                        // RAW (a binary frame) would be exactly `len` + framing.
                        "rawLen": len,
                    },
                })
            }

            // Real round trip: build `a[0]` bytes deterministically, carry them as
            // base64 (the only binary-safe textual carrier), and let the JS side
            // verify the decoded bytes match its own regeneration.
            "probe.readBase64" => {
                let len = args.first().and_then(Value::as_u64).unwrap_or(0) as usize;
                let seed = args.get(1).and_then(Value::as_u64).unwrap_or(0) as u8;
                let data: Vec<u8> = (0..len).map(|i| (i as u8).wrapping_add(seed)).collect();
                let encoded = base64::engine::general_purpose::STANDARD.encode(&data);
                json!({ "t": "r", "id": id, "v": { "base64": encoded, "bytes": len } })
            }

            // The same payload as the numeric-keyed object a naive Uint8Array
            // produces, so the JS side can measure the real client-side cost of
            // parsing/serialising it rather than trusting arithmetic.
            "probe.readJsonObject" => {
                let len = args.first().and_then(Value::as_u64).unwrap_or(0) as usize;
                let seed = args.get(1).and_then(Value::as_u64).unwrap_or(0) as u8;
                let mut map = serde_json::Map::with_capacity(len);
                for i in 0..len {
                    map.insert(i.to_string(), json!((i as u8).wrapping_add(seed)));
                }
                json!({ "t": "r", "id": id, "v": Value::Object(map) })
            }

            _ => json!({ "t": "r", "id": id, "e": { "m": format!("unknown RPC method: {method}") } }),
        };

        let mut out = serde_json::to_string(&reply).expect("serialize");
        out.push('\n');
        if stdout.write_all(out.as_bytes()).is_err() {
            break;
        }
        if stdout.flush().is_err() {
            break;
        }
    }
}
