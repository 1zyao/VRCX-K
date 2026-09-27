//! Runs `debug_probe::imp::serve_hands` over a real abstract unix socket, on real
//! Linux, against the REAL production modules.
//!
//! # Why this probe exists
//!
//! `serve_hands` mounts `crate::hands`, `crate::kkrpc_peer` and `crate::hands_hello`.
//! The main crate cannot cross-compile to `linux-musl` (the `libdbus-sys` build script
//! needs system libraries), so a test inside the crate can only run on Windows — where
//! abstract unix sockets do not exist. This crate pulls the production sources in
//! verbatim with `#[path]` and supplies the small amount of crate plumbing they expect,
//! so the socket path can be exercised on the platform that actually has it.
//!
//! # What it proves, and what it does NOT
//!
//! ✅ The abstract-socket transport carries the real kkrpc compact protocol; the
//!    production registration ORDER survives (handlers before reader, hello after
//!    reader — asserted, see below); and a real `hands.stat` answers with the real
//!    byte count of a file this process created.
//!
//! ❌ It says NOTHING about Android: not its permissions, not its filesystem layout,
//!    not `FLAG_DEBUGGABLE`. Android is the intended target and remains unverified
//!    until the probe runs on a device. Do not read a green here as "Android works".
//!
//! # Run it
//!
//! ```bash
//! cd docs/probes/debug-probe
//! cargo run --target x86_64-unknown-linux-musl   # then run the binary under Linux/WSL
//! ```
//! ⚠ The `rust-lld` linker in `.cargo/config.toml` is what makes the musl build work
//! without a system C toolchain.
#![allow(dead_code)]

// ── The production modules, verbatim ────────────────────────────────────────────
#[path = "../../../../src-tauri/src/kkrpc_peer.rs"]
pub mod kkrpc_peer;
#[path = "../../../../src-tauri/src/hands.rs"]
pub mod hands;
#[path = "../../../../src-tauri/src/hands_hello.rs"]
pub mod hands_hello;
#[path = "../../../../src-tauri/src/debug_probe.rs"]
pub mod debug_probe_impl;

/// Re-export under the name the production module expects, plus the Android-only JNI
/// shim that `cfg(target_os = "android")` keeps out of this build.
pub mod debug_probe {
    pub use crate::debug_probe_impl::*;
    pub mod jni {
        pub fn read_flag_debuggable() -> Option<bool> {
            None
        }
    }
}

fn main() {
    let pid = std::process::id();
    let probe = &debug_probe::imp::serve_hands;

    // Bind an abstract socket the same way the probe does, then accept ONE client and
    // hand it to the REAL serve_hands.
    let name = debug_probe::policy::socket_name(pid);
    let addr = {
        use std::os::linux::net::SocketAddrExt as _;
        std::os::unix::net::SocketAddr::from_abstract_name(name.as_bytes()).unwrap()
    };
    let listener = std::os::unix::net::UnixListener::bind_addr(&addr).expect("bind");
    println!("LISTENING @{name}");

    let client = std::thread::spawn(move || {
        use std::io::{BufRead, BufReader, Write};
        let addr = {
            use std::os::linux::net::SocketAddrExt as _;
            std::os::unix::net::SocketAddr::from_abstract_name(name.as_bytes()).unwrap()
        };
        let stream = std::os::unix::net::UnixStream::connect_addr(&addr).expect("connect");
        let mut writer = stream.try_clone().expect("clone");
        let mut reader = BufReader::new(stream);

        // 1) The `boot` frame the peer emits before the reader starts. Production's
        //    example writes it to stdout; here it arrives on the socket.
        let mut line = String::new();
        reader.read_line(&mut line).expect("read boot");
        println!("CLIENT boot: {}", line.trim());

        // 2) `hands.hello` is sent right after the reader starts. Reading it proves the
        //    production ORDERING (hello after reader) survived the transport change.
        //
        //    ⚠ TWO wrong guesses were made here before getting it right, and both are
        //    worth recording because they are the same mistake in different clothes:
        //      · asserting a `m` field — the compact protocol has no `m`;
        //      · asserting the literal "hands.hello" — the method is carried as a PATH
        //        ARRAY (`"p":["hands","hello"]`), never as a dotted string.
        //    Parsing the frame instead of pattern-matching the text is what settles it.
        line.clear();
        reader.read_line(&mut line).expect("read hello");
        let hello: serde_json::Value = serde_json::from_str(line.trim()).expect("hello is JSON");
        println!("CLIENT hello: t={:?} op={:?} p={:?}", hello["t"], hello["op"], hello["p"]);
        assert_eq!(
            hello["p"],
            serde_json::json!(["hands", "hello"]),
            "the hello must be addressed as the path [\"hands\",\"hello\"] on the wire"
        );
        assert_eq!(
            hello["a"][0]["schemaVersion"],
            serde_json::json!(1),
            "the payload must carry the schema version the brain checks for version skew"
        );
        assert_eq!(
            hello["a"][0]["node"]["platform"],
            serde_json::json!("linux"),
            "the payload must identify the node — here, the platform we are actually on"
        );

        // 3) Drive a REAL `hands.stat` over the wire and check the answer describes a
        //    file this process created. This is the assertion that matters: it proves
        //    the production handler ran, not merely that a socket accepted bytes.
        //
        // ⚠ The request shape is kkrpc's COMPACT protocol — `p` is the method PATH as
        // an array, and `a` is the argument list. Sending `{method: …}` (the JSON-mode
        // shape the Rust crate 0.6.1 speaks) would be silently ignored here, which is
        // exactly the protocol mismatch documented at the top of `kkrpc_peer.rs`.
        let target = std::env::temp_dir().join("serve-hands-probe-target.txt");
        std::fs::write(&target, b"probe-bytes").expect("write target");
        let request = serde_json::json!({
            "t": "q", "op": "call", "id": 1,
            "p": ["hands", "stat"],
            "a": [target.to_string_lossy()],
        });
        writeln!(writer, "{request}").expect("send stat");
        writer.flush().expect("flush");

        line.clear();
        reader.read_line(&mut line).expect("read stat reply");
        println!("CLIENT stat reply: {}", line.trim());

        // The reply shape is kkrpc's; the SIZE must be the 11 bytes we wrote.
        let text = line.clone();
        assert!(
            text.contains("\"size\":11") || text.contains("\"size\": 11"),
            "⚠ hands.stat must report the 11 bytes of the file this test created; \
             got {text}. A reply of any other size means the handler did not run \
             against the real filesystem"
        );
        println!("CLIENT ok");
        let _ = std::fs::remove_file(&target);
    });

    let (stream, _) = listener.accept().expect("accept");
    // ⚠ The boot frame is written by the CALLER in the real example; `serve_hands`
    // mounts the handlers. Emit it on the stream first so the client's read order
    // matches production.
    {
        use std::io::Write;
        let mut boot_stream = stream.try_clone().expect("clone for boot");
        writeln!(boot_stream, "{}", serde_json::json!({ "t": "boot" })).expect("boot");
        boot_stream.flush().expect("flush boot");
    }

    let secs = probe(stream).expect("serve_hands runs");
    println!("SERVER session lasted {secs}s");
    client.join().expect("client thread");
    println!("DONE");
}
