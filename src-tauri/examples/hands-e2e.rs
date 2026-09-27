// The hands e2e binary: the PRODUCTION capability modules over real stdio.
//
// It mounts `tauri_app_lib::{hands, hands_hello, kkrpc_peer}` — the real modules,
// reached through the crate's real boundary. That is the point: the test drives
// shipped code, so it cannot drift from it.
//
// ⚠ WHY THIS LIVES IN `examples/` RATHER THAN A SEPARATE PROBE CRATE.
// It used to be `docs/probes/hands-e2e/rust/src/main.rs`, which pulled the same
// three files in with `#[path = "../../../../../src-tauri/src/hands.rs"]`. That
// compiled the real source, but it built a PRIVATE COPY of the module graph: the
// driver could not name `tauri_app_lib::hands`, and nothing verified that those
// modules were reachable the way production reaches them. Moving here required
// making the three modules `pub` (see `lib.rs`) precisely so the example imports
// what the shell registers, not a parallel assembly of the same files.
//
// Why not run the Tauri app itself: the app needs a webview and a window, so it
// cannot run headless in CI. The capability under test has no Tauri dependency
// (only serde/base64/notify/file-id), so mounting it on a bare stdio loop is
// both possible and strictly more focused — it cannot pass because some
// unrelated part of the app happened to work.
//
// ⚠ `cargo test` COMPILES examples; `cargo check` / `clippy` / `build --release`
// do NOT. So a broken example shows up as a failing `cargo test`, not as a lint.

use std::io::Write;
use std::sync::Arc;

use tauri_app_lib::{hands, hands_hello, kkrpc_peer};

fn main() {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();

    // Handlers must be registered BEFORE the reader starts: an early frame must
    // not be dispatched as an unknown method. This is the same ordering the
    // production path uses (host.rs registers, then starts the reader).
    let peer = kkrpc_peer::Peer::new(stdout);
    hands::register_hands_handlers(&peer);

    // Tell the driver we are listening, so a missing binary or a broken
    // registration is distinguishable from a slow start.
    let mut boot = std::io::stdout();
    let _ = writeln!(boot, "{}", serde_json::json!({ "t": "boot" }));
    let _ = boot.flush();

    peer.start_reader(stdin);

    // Announce identity exactly as production does (`host.rs` sends it right
    // after the reader starts) so the E2E observes the real ordering: a hello
    // that arrived before the reader was running would prove nothing about the
    // production path.
    hands_hello::send_hello(&peer);

    // The reader thread owns the loop, so park this thread. The process ends
    // when the driver closes stdin and the reader sees EOF.
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}

// Keep the trait imports honest: the example only needs the registration entry
// points, so a compile error here means the crate's public surface changed in a
// way the E2E depends on.
#[allow(dead_code)]
fn _surface_is_public(peer: &Arc<kkrpc_peer::Peer>) {
    hands::register_hands_handlers(peer);
    hands_hello::send_hello(peer);
}
