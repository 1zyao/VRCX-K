//! Stricter version of the unwatch-leak check.
//!
//! The first run reported "LEAK — event after unwatch" on notify 9.0.0-rc.5.
//! That may be a real leak OR a stale queued event from the write that happened
//! BEFORE unwatch. Those are distinguishable, and the difference decides whether
//! our recommendation (rc over stable) rests on a fix that does not work.
//!
//! Method: DRAIN the channel immediately before unwatch, so nothing from before
//! can masquerade as an after-event. Then unwatch, then write, then check. Also
//! run several cycles, because the upstream issue is a *race* — one clean sample
//! proves nothing either way.
//!
//! Run: cargo run --release --bin unwatch_strict

use notify::{RecursiveMode, Watcher};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

fn work() -> PathBuf {
    let d = std::env::temp_dir().join("vrcxk-unwatch-strict");
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

#[tokio::main]
async fn main() {
    const ROUNDS: usize = 5;
    let mut leaks = 0;
    let mut clean = 0;
    let mut no_event_before = 0;

    for round in 0..ROUNDS {
        let dir = work().join(format!("r{round}"));
        std::fs::create_dir_all(&dir).unwrap();

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut watcher = notify::recommended_watcher(tx).expect("watcher");
        watcher
            .watch(&dir, RecursiveMode::NonRecursive)
            .expect("watch");

        // Prove the watch is live for THIS round before trusting a later zero.
        write(&dir.join("before.txt"), "before\n");
        let live = tokio::time::timeout(Duration::from_millis(1500), rx.recv()).await;
        if live.is_err() {
            println!("  round {round}: NO event for the control write — inconclusive");
            no_event_before += 1;
            let _ = watcher.unwatch(&dir);
            continue;
        }

        // ⚠ THE KEY STEP: drain everything still queued, so a stale event cannot
        // be mistaken for a leak.
        std::thread::sleep(Duration::from_millis(250));
        while rx.try_recv().is_ok() {}

        watcher.unwatch(&dir).expect("unwatch");
        std::thread::sleep(Duration::from_millis(250));

        // Any event from here on arrived AFTER unwatch returned.
        write(&dir.join("after.txt"), "after\n");
        let leaked = tokio::time::timeout(Duration::from_millis(1200), rx.recv()).await;
        match leaked {
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
    println!("rounds={ROUNDS}  clean={clean}  leaks={leaks}  inconclusive={no_event_before}");
    if no_event_before == ROUNDS {
        println!("RESULT INCONCLUSIVE — the watch never fired at all");
    } else if leaks == 0 {
        println!(
            "RESULT no leak reproduced under a DRAINED channel (stronger than the first test)"
        );
    } else {
        println!("RESULT LEAK REPRODUCED after unwatch — the rc.3 fix does not hold here");
    }
}
