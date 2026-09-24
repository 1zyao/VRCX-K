//! The hands → brain hello: who this node is, and what environment it has.
//!
//! # Why this exists (and why a per-field "source" tag would not do)
//!
//! The stdio channel is a pure RPC bus today: the brain announces itself
//! (`ready`, carrying the BRAIN's cwd/execPath/runtime), and the shell says
//! nothing. So the brain cannot tell which machine — or which process — it is
//! talking to, and every fact it reads from the shell arrives with no owner.
//!
//! The tempting fix is to tag each payload (`{ source: "hands", ... }`). That is
//! a **per-field** discipline: it has to be remembered on every field, and one
//! omission produces a value that looks local but came from elsewhere. That is
//! the same failure mode as `host/src/capability.ts`'s note that `fiber.name` is
//! not an identity — a name that *looks* like a key but is not one.
//!
//! Announcing identity **once, at handshake**, is structural instead: the channel
//! is bound to node N, so every later fact on it belongs to N by construction.
//! There is nothing to forget.
//!
//! # Why the environment travels here rather than in a query route
//!
//! Same reason, from the other side. `~` and `%VAR%` expansion needs the shell's
//! own home and environment. A dedicated route (`os.env`) would answer that, but
//! the answer would be a second, unrelated call whose result is indistinguishable
//! from the brain's own environment — the exact confusion this module prevents.
//! Carrying it in the hello binds it to the node at the only moment where the
//! binding is unambiguous.
//!
//! # What is deliberately NOT here
//!
//! - **A stable machine id.** There is no persistence in the shell yet, so any id
//!   generated here would change every launch. A per-launch id is still worth
//!   sending (it makes "did the shell restart?" answerable), but it must not be
//!   presented as a durable device identity — that is `#13`'s problem, and it
//!   needs per-device credentials, not a random string.
//! - **Live/slow-changing values.** The hello is sent once per shell process; a
//!   field that changes minute-to-minute would be read as a constant. Measured
//!   precedent: `host-ready.schema.json` states the same rule for `capacity`.

use serde_json::{json, Value};
use std::sync::Arc;

use crate::kkrpc_peer::Peer;

/// Version of the hello shape.
///
/// Mirrors `HOST_READY_SCHEMA_VERSION`'s role on the other channel: the peer that
/// does not recognise this must refuse rather than guess at fields. The shell is
/// the more likely of the two to be upgraded first, so the brain is the side that
/// most needs a number to check.
pub const HANDS_HELLO_SCHEMA_VERSION: u16 = 1;

/// Collect the environment as an explicit key/value map.
///
/// `std::env::vars()` yields `String`, and a non-UTF-8 value is SKIPPED rather
/// than lossily converted: a mangled path is worse than an absent one, because it
/// looks usable. `vars_os` + `to_str` is what makes that choice possible.
fn environment() -> Value {
    let mut map = serde_json::Map::new();
    for (key, value) in std::env::vars_os() {
        let (Some(key), Some(value)) = (key.to_str(), value.to_str()) else {
            continue;
        };
        // A credential in the environment is not made safe by being on a pipe the
        // brain already controls — but it IS worth not duplicating into logs and
        // crash reports, which is where this payload ends up. Recorded as present
        // with no value, so "the variable exists" stays answerable without the
        // secret travelling further than it already has.
        if looks_secret(key) {
            map.insert(key.to_string(), json!("<redacted>"));
            continue;
        }
        map.insert(key.to_string(), json!(value));
    }
    Value::Object(map)
}

/// Whether a variable name suggests a credential.
///
/// Deliberately a NAME heuristic and not a value scan: this cannot be perfect,
/// and pretending otherwise would be worse than admitting the limit. It is a
/// redaction aid for logs, NOT a security boundary — the brain shares this
/// environment already when both run on one machine.
fn looks_secret(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    const MARKERS: [&str; 7] = [
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "CREDENTIAL",
        "PRIVATE_KEY",
        "APIKEY",
    ];
    MARKERS.iter().any(|marker| upper.contains(marker))
}

/// Build the hello payload.
///
/// Pure, so it is testable without a peer or a real environment.
pub fn hello_payload() -> Value {
    // `.` rather than the process's startup directory when the cwd is gone: on
    // Windows a deleted cwd makes `current_dir()` fail, and a failed cwd must not
    // sink the whole handshake. The reason is reported instead, separately, so a
    // consumer can tell "no cwd" from "cwd happened to be empty".
    let (cwd, cwd_error) = match std::env::current_dir() {
        Ok(path) => (path.to_string_lossy().to_string(), Value::Null),
        Err(error) => (String::new(), json!(error.to_string())),
    };

    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();

    json!({
        "schemaVersion": HANDS_HELLO_SCHEMA_VERSION,
        "node": {
            // Per-launch. See the module note: NOT a durable device identity.
            "launchId": launch_id(),
            "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "family": std::env::consts::FAMILY,
            // The version of THIS shell build, so the brain can tell "the hands
            // were upgraded" from "the hands are misbehaving".
            "shellVersion": env!("CARGO_PKG_VERSION"),
        },
        "cwd": cwd,
        "cwdError": cwd_error,
        "home": home,
        "env": environment(),
    })
}

/// A per-launch random id.
///
/// Built from the process start time and pid rather than pulling in a random
/// source: it only has to distinguish two launches of this shell on this machine,
/// and both inputs are already available. Uniqueness ACROSS machines is not
/// claimed and not needed — the field is named `launchId`, and `#13` owns the
/// durable identity problem.
fn launch_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|delta| delta.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}-{:x}", std::process::id())
}

/// Send the hello to the brain.
///
/// Best-effort by design: failing to announce identity must not stop the shell
/// from starting. The failure is reported to stderr so it is not silent.
pub fn send_hello(peer: &Arc<Peer>) {
    match peer.notify("hands.hello", vec![hello_payload()]) {
        Ok(()) => {}
        Err(error) => eprintln!("[shell] hands hello failed: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_payload_carries_the_schema_version_and_node_identity() {
        // Without these two the brain cannot tell a version skew from a bug, and
        // cannot tell one node from another — the two things the hello is FOR.
        let payload = hello_payload();
        assert_eq!(payload["schemaVersion"], json!(HANDS_HELLO_SCHEMA_VERSION));
        assert_eq!(payload["node"]["platform"], json!(std::env::consts::OS));
        assert_eq!(payload["node"]["arch"], json!(std::env::consts::ARCH));
        assert!(
            payload["node"]["launchId"]
                .as_str()
                .is_some_and(|id| !id.is_empty()),
            "a launch id is required even if it is not durable"
        );
    }

    #[test]
    fn the_payload_carries_the_environment_the_brain_would_otherwise_guess() {
        let payload = hello_payload();
        let env = payload["env"].as_object().expect("env object");
        assert!(
            !env.is_empty(),
            "an empty environment would make the field useless"
        );
    }

    #[test]
    fn the_environment_has_no_null_values() {
        // Every value must be a JSON string. A null would reach the brain as
        // "present but unknown", which is indistinguishable from a variable that
        // is genuinely unset — and the map's whole point is that presence means
        // presence.
        let payload = hello_payload();
        for (key, value) in payload["env"].as_object().expect("env") {
            assert!(
                value.is_string(),
                "{key} is not a string: {value} (non-UTF-8 values must be skipped)"
            );
        }
    }

    #[test]
    fn secret_shaped_names_are_redacted_by_name() {
        // This is the falsifiable part of the redaction: a name that matches must
        // NOT carry its value. (The heuristic's coverage is deliberately partial —
        // see `looks_secret` — but a match must always redact.)
        assert!(looks_secret("GH_TOKEN"));
        assert!(looks_secret("my_secret_thing"));
        assert!(looks_secret("NPM_PASSWORD"));
        assert!(looks_secret("AWS_PRIVATE_KEY"));
        assert!(!looks_secret("PATH"));
        assert!(!looks_secret("HOME"));

        // End to end: a planted variable must arrive redacted.
        // Not `unsafe`: this crate is edition 2021, where `set_var` is safe.
        std::env::set_var("VRCXK_TEST_SECRET_TOKEN", "super-secret-value");
        let payload = hello_payload();
        std::env::remove_var("VRCXK_TEST_SECRET_TOKEN");
        assert_eq!(
            payload["env"]["VRCXK_TEST_SECRET_TOKEN"],
            json!("<redacted>"),
            "a token-shaped name must not carry its value"
        );
    }

    #[test]
    fn cwd_and_home_are_strings_even_when_unavailable() {
        // A consumer must be able to read these unconditionally; absence is
        // signalled by an empty string plus `cwdError`, not by a missing key.
        let payload = hello_payload();
        assert!(payload["cwd"].is_string());
        assert!(payload["home"].is_string());
    }
}
