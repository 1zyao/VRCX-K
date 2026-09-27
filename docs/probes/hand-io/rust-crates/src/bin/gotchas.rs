//! Two design-critical `notify` behaviours, measured rather than taken on trust.
//!
//! (a) Watching a path that does NOT EXIST YET — the `tail -f`-on-startup case.
//!     If `watch()` refuses, the hands cannot install a file watch before the
//!     log exists, and must instead watch the parent directory and filter.
//!
//! (b) Event AMPLIFICATION under a write burst. If N appends produce ~N events,
//!     a debouncer is mandatory; if they coalesce to ~1, it is not — and the only
//!     remaining reason to take `notify-debouncer-full` would be its FileIdMap.
//!
//! Run: cargo run --release --bin gotchas

use notify::{RecursiveMode, Watcher};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

fn work() -> PathBuf {
    let d = std::env::temp_dir().join("vrcxk-gotcha-probe");
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("mkdir");
    d
}

fn count_events(rx: &mpsc::Receiver<notify::Result<notify::Event>>, settle_ms: u64) -> usize {
    std::thread::sleep(Duration::from_millis(settle_ms));
    let mut n = 0;
    while let Ok(Ok(_)) = rx.try_recv() {
        n += 1;
    }
    n
}

fn new_watcher() -> (
    notify::RecommendedWatcher,
    mpsc::Receiver<notify::Result<notify::Event>>,
) {
    let (tx, rx) = mpsc::channel();
    let w = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })
    .expect("watcher");
    (w, rx)
}

/// (a) Does `watch()` accept a path that does not exist yet?
fn nonexistent(dir: &Path) -> (bool, usize) {
    let missing = dir.join("does-not-exist-yet.log");
    let (mut w, rx) = new_watcher();

    let watch_ok = w.watch(&missing, RecursiveMode::NonRecursive).is_ok();

    // Whether or not the file watch was accepted, now create the file and see
    // what (if anything) is delivered.
    {
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&missing)
            .expect("create");
        f.write_all(b"first line\n").expect("write");
        f.sync_all().ok();
    }
    let events_after_create = count_events(&rx, 600);
    let _ = w.unwatch(&missing);
    (watch_ok, events_after_create)
}

/// (a2) The fallback: watch the PARENT directory and filter by path.
fn parent_dir_fallback(dir: &Path) -> usize {
    let target = dir.join("created-later.log");
    let (mut w, rx) = new_watcher();
    w.watch(dir, RecursiveMode::NonRecursive)
        .expect("watch dir");

    {
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&target)
            .expect("create");
        f.write_all(b"first line\n").expect("write");
        f.sync_all().ok();
    }
    let n = count_events(&rx, 600);
    let _ = w.unwatch(dir);
    n
}

/// (b) Do N appends produce N events?
fn amplification(dir: &Path) -> usize {
    let target = dir.join("burst.log");
    std::fs::write(&target, b"").expect("seed");

    let (mut w, rx) = new_watcher();
    w.watch(&target, RecursiveMode::NonRecursive)
        .expect("watch file");
    std::thread::sleep(Duration::from_millis(200));

    // Drain anything from establishing the watch, so the count is the burst's.
    let _ = count_events(&rx, 200);

    const APPENDS: usize = 200;
    {
        // ONE handle, many writes, flushed — the shape a log producer has.
        let mut f = OpenOptions::new()
            .append(true)
            .open(&target)
            .expect("open append");
        for i in 0..APPENDS {
            writeln!(f, "burst line {i}").expect("write");
        }
        f.flush().expect("flush");
        f.sync_all().ok();
    }

    let n = count_events(&rx, 800);
    let _ = w.unwatch(&target);
    (APPENDS, n).1
}

fn main() {
    let dir = work();

    let (watch_ok, after_create) = nonexistent(&dir);
    println!("== (a) watching a path that does not exist yet ==");
    println!(
        "  watch(nonexistent file) accepted : {}",
        if watch_ok { "YES" } else { "NO (errors)" }
    );
    println!("  events delivered after it was created : {after_create}");

    let parent_events = parent_dir_fallback(&dir);
    println!("  FALLBACK: watch parent dir, filter by path : {parent_events} event(s)");
    println!(
        "  => {}",
        if parent_events > 0 {
            "the parent-directory fallback works (use it for tail-on-startup)"
        } else {
            "NEITHER shape saw the new file — investigate before relying on it"
        }
    );

    let burst = amplification(&dir);
    println!("\n== (b) event amplification under a write burst ==");
    println!("  200 appends through one handle -> {burst} event(s)");
    println!(
        "  => {}",
        if burst <= 5 {
            "events coalesce; a debouncer is NOT needed for volume"
        } else {
            "events do NOT coalesce; a debouncer is required"
        }
    );
}
