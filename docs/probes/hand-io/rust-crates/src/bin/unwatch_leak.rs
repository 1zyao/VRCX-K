//! Does `notify` 8.2.0 leak events AFTER `unwatch()` on Windows?
//!
//! Upstream issue #730 claims it does, and says it was fixed in 9.0.0-rc.3.
//! This matters because "must stop cleanly when a caller unsubscribes" is an
//! explicit requirement for the hands' watcher — and the answer decides whether
//! we take stable 8.2.0 or the 9.0.0-rc line.
//!
//! Method: watch a directory, unwatch it, then write to it and count events.
//! Correct behaviour = 0 events after unwatch. A leak = events still arrive.
//!
//! Run: cargo run --release --bin unwatch-leak

use notify::{RecursiveMode, Watcher};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

/// How long to wait after `unwatch()` before writing. Issue #730 is a race, so
/// this is a *parameter of the experiment*, not an implementation detail — the
/// leak is reported to appear when this gap is small.
const SETTLE_AFTER_UNWATCH_MS: u64 = 300;

fn work() -> PathBuf {
    let d = std::env::temp_dir().join("vrcxk-unwatch-probe");
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("mkdir");
    d
}

fn main() {
    let dir = work();

    let (tx, rx) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })
    .expect("watcher");

    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .expect("watch");

    // Prove the watch is live BEFORE unwatching, so a later zero is meaningful
    // rather than an artifact of a watch that never worked.
    let probe = dir.join("before.txt");
    {
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&probe)
            .unwrap();
        f.write_all(b"before\n").unwrap();
        f.sync_all().ok();
    }
    std::thread::sleep(Duration::from_millis(500));
    let mut before = 0;
    while rx.try_recv().is_ok() {
        before += 1;
    }

    // Now unwatch. On 8.2.0 the Windows backend may return before the watch is
    // fully torn down (that is exactly what #730 says).
    watcher.unwatch(&dir).expect("unwatch");
    std::thread::sleep(Duration::from_millis(SETTLE_AFTER_UNWATCH_MS));

    // Write AFTER unwatching. Anything counted here is a leak.
    for i in 0..5 {
        let p = dir.join(format!("after-{i}.txt"));
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&p)
            .unwrap();
        f.write_all(b"after\n").unwrap();
        f.sync_all().ok();
    }
    std::thread::sleep(Duration::from_millis(800));
    let mut after = 0;
    while rx.try_recv().is_ok() {
        after += 1;
    }

    println!("events BEFORE unwatch : {before}   (0 would invalidate the test)");
    println!("events AFTER  unwatch : {after}    (0 = clean; >0 = leaked, issue #730)");

    // ⚠ Issue #730 is a RACE, so a single clean run is NOT proof it is fixed.
    // The 300 ms settle below is generous; a tighter unwatch→write gap is exactly
    // where the leak is reported to appear. Report this honestly rather than as
    // "no leak exists".
    println!(
        "\nNOTE: #730 is a race. This run waited {} ms after unwatch before writing; \
         a clean result here means 'not reproduced at this timing', not 'fixed'.",
        SETTLE_AFTER_UNWATCH_MS
    );

    if before == 0 {
        println!("RESULT INCONCLUSIVE — the watch never fired, so 'after' proves nothing");
    } else if after == 0 {
        println!("RESULT clean — no leak observed on this platform/version");
    } else {
        println!(
            "RESULT LEAK — {after} event(s) delivered after unwatch (prefer notify 9.0.0-rc.3+)"
        );
    }

    drop(watcher);
    let _ = std::fs::remove_dir_all(&dir);
}
