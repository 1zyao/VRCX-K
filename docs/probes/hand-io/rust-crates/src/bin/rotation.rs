//! Verify the single most design-critical `notify` claim by experiment:
//! **does a single-FILE watch survive log rotation** (rename away + recreate)?
//!
//! If it does not, the hands need to re-watch on every rotation; if it does
//! (the upstream researcher's claim, mechanism = notify emulates a file watch by
//! watching the parent directory), rotation handling is nearly free.
//!
//! Also verifies the rotation-DETECTION primitive (`file_id` before/after), which
//! is what tells a reader "this path is a different file now, restart at offset 0".
//!
//! Run: cargo run --release --bin rotation

use notify::{RecursiveMode, Watcher};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

fn work() -> PathBuf {
    let d = std::env::temp_dir().join("vrcxk-rotation-probe");
    std::fs::create_dir_all(&d).expect("mkdir");
    // Start clean: a stale app.log from a previous run would change the file id
    // baseline and make the comparison meaningless.
    let _ = std::fs::remove_file(d.join("app.log"));
    let _ = std::fs::remove_file(d.join("app.log.1"));
    d
}

fn append(path: &PathBuf, text: &str) {
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .expect("open append");
    f.write_all(text.as_bytes()).expect("write");
    f.sync_all().ok();
}

fn drain(rx: &mpsc::Receiver<notify::Result<notify::Event>>, label: &str) -> usize {
    // Give the OS time to deliver, then count everything queued.
    std::thread::sleep(Duration::from_millis(500));
    let mut n = 0;
    while let Ok(Ok(event)) = rx.try_recv() {
        n += 1;
        println!("    {label}: {:?} paths={:?}", event.kind, event.paths);
    }
    n
}

fn main() {
    let dir = work();
    let log = dir.join("app.log");
    append(&log, "line1\n");

    // --- watch the FILE itself (not the directory) --------------------------
    let (tx, rx) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })
    .expect("watcher");
    watcher
        .watch(&log, RecursiveMode::NonRecursive)
        .expect("watch file");
    std::thread::sleep(Duration::from_millis(300));

    println!("watching FILE: {}\n", log.display());

    // --- STEP 1: plain append ----------------------------------------------
    println!("STEP 1: append to the original file");
    let id_before = file_id::get_file_id(&log).ok();
    append(&log, "line2\n");
    let n1 = drain(&rx, "  step1");
    println!("  -> {n1} event(s)\n");

    // --- STEP 2: copytruncate (the OTHER common rotation style) ------------
    println!("STEP 2: copytruncate (content copied away, file truncated in place)");
    std::fs::write(&log, b"").expect("truncate");
    append(&log, "after-truncate\n");
    let n2 = drain(&rx, "  step2");
    println!("  -> {n2} event(s)\n");

    // --- STEP 3: TRUE rotation: rename away, then create a NEW file --------
    println!("STEP 3: TRUE ROTATION (rename app.log -> app.log.1, create new app.log)");
    std::fs::rename(&log, dir.join("app.log.1")).expect("rename");
    append(&log, "fresh-after-rotation\n");
    let n3 = drain(&rx, "  step3");
    let id_after = file_id::get_file_id(&log).ok();
    println!("  -> {n3} event(s)");
    println!("  file_id before = {id_before:?}");
    println!("  file_id after  = {id_after:?}");
    println!("  id_changed     = {}\n", id_before != id_after);

    // --- STEP 4: the decisive test — does the OLD watch still fire? --------
    println!("STEP 4 (decisive): append to the NEW file at the same path");
    append(&log, "still-watched\n");
    let n4 = drain(&rx, "  step4");
    println!("  -> {n4} event(s)\n");

    let survives_rotation = n4 > 0;
    println!(
        "RESULT file-watch {} log rotation; rotation {} be detected via file_id",
        if survives_rotation {
            "SURVIVES (no re-watch needed)"
        } else {
            "BREAKS (must re-watch)"
        },
        if id_before != id_after {
            "CAN"
        } else {
            "CANNOT"
        }
    );

    let _ = watcher.unwatch(&log);
    let _ = std::fs::remove_dir_all(&dir);
}
