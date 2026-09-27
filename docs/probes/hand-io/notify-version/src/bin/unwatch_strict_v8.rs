//! The 8.2.0 CONTROL for `unwatch_strict` — same scenario, same assertions,
//! different major version.
//!
//! Why it lives in the same crate: the whole point is that BOTH versions are
//! measured by one instrument. Keeping the control next to the rc test makes that
//! structural rather than something a reader has to reconstruct.
//!
//! 8.2.0 has no `tokio` `EventHandler` feature, so the handler is a std `Sender`
//! bridged into a tokio channel by one thread. The logic below is otherwise
//! identical to the rc variant.
//!
//! ⚠ The import is `notify_v8` — Cargo package-renaming in Cargo.toml, which is how
//! both majors coexist in this one crate so a single instrument can measure both.
//!
//! Run: cargo run --release --bin unwatch_strict_v8

use notify_v8::{Event, RecommendedWatcher, RecursiveMode, Result as NotifyResult, Watcher};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::mpsc as std_mpsc;
use std::time::Duration;

fn work() -> PathBuf {
    let d = std::env::temp_dir().join("vrcxk-unwatch-strict-v8");
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("mkdir");
    d
}

fn write(path: &PathBuf, text: &str) {
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap();
    f.write_all(text.as_bytes()).unwrap();
    f.sync_all().ok();
}

fn main() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("rt")
        .block_on(inner())
}

async fn inner() {
    const ROUNDS: usize = 5;
    let mut leaks = 0;
    let mut clean = 0;
    let mut inconclusive = 0;

    for round in 0..ROUNDS {
        let dir = work().join(format!("r{round}"));
        std::fs::create_dir_all(&dir).unwrap();

        // std handler -> bridge thread -> tokio channel. The bridge is the price
        // of staying on stable, and is the pattern FINDINGS §4.7a documents.
        let (raw_tx, raw_rx) = std_mpsc::channel::<NotifyResult<Event>>();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<NotifyResult<Event>>();
        std::thread::spawn(move || {
            while let Ok(ev) = raw_rx.recv() {
                if tx.send(ev).is_err() {
                    break;
                }
            }
        });
        let mut watcher: RecommendedWatcher =
            notify_v8::recommended_watcher(raw_tx).expect("watcher");
        watcher
            .watch(&dir, RecursiveMode::NonRecursive)
            .expect("watch");

        // Control: the watch must be live for THIS round, or a later zero proves nothing.
        write(&dir.join("before.txt"), "before\n");
        if tokio::time::timeout(Duration::from_millis(1500), rx.recv())
            .await
            .is_err()
        {
            println!("  round {round}: NO control event — inconclusive");
            inconclusive += 1;
            let _ = watcher.unwatch(&dir);
            continue;
        }

        // Drain BEFORE unwatch so a stale queued event cannot be counted as a leak.
        std::thread::sleep(Duration::from_millis(250));
        while rx.try_recv().is_ok() {}

        watcher.unwatch(&dir).expect("unwatch");
        std::thread::sleep(Duration::from_millis(250));

        write(&dir.join("after.txt"), "after\n");
        match tokio::time::timeout(Duration::from_millis(1200), rx.recv()).await {
            Ok(Some(Ok(event))) => {
                leaks += 1;
                println!("  round {round}: LEAK after unwatch -> {:?}", event.kind);
            }
            Ok(Some(Err(e))) => {
                leaks += 1;
                println!("  round {round}: error after unwatch -> {e}");
            }
            Ok(None) => {
                clean += 1;
                println!("  round {round}: channel closed (clean)");
            }
            Err(_) => {
                clean += 1;
                println!("  round {round}: clean — no event after unwatch");
            }
        }
    }

    println!();
    println!(
        "notify 8.2.0: rounds={ROUNDS} clean={clean} leaks={leaks} inconclusive={inconclusive}"
    );
    println!("RESULT 8.2.0 leak check complete — compare with the rc variant's output");
}
