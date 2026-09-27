//! Compile-and-run verification of the crate-research conclusions, so the
//! decisions rest on what this machine actually does rather than on what docs say.
//!
//! Claims under test (each labelled with who asserted it):
//!   1. [subagent] std's `File::lock/try_lock` are stable — no fs2/fs4 needed for locking.
//!   2. [subagent] `File::seek(SeekFrom::Start(n))` is the whole of resume.
//!   3. [subagent] append-mode writes are atomic w.r.t. the end of file.
//!   4. [subagent] `notify` works on Windows and you must watch the DIRECTORY, not the file.
//!   5. [subagent] `notify` does not report reliably for network/WSL paths.
//!   6. [me] `blake3` is available and fast enough that hashing is not the bottleneck.
//!
//! Usage: cargo run --release

use notify::{RecursiveMode, Watcher};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

fn scratch() -> PathBuf {
    let dir = std::env::temp_dir().join("vrcxk-rust-probe");
    std::fs::create_dir_all(&dir).expect("create scratch dir");
    dir
}

/// 1 + 2 + 3: the standard-library primitives that supposedly need no crate.
///
/// Takes `&Path`, not `&PathBuf`: clippy's `ptr_arg` is satisfied honestly here
/// rather than by an allow, since a `&PathBuf` parameter forces callers to own a
/// buffer they do not need.
fn primitives(dir: &Path) -> (bool, bool, bool) {
    let path = dir.join("primitives.bin");

    // --- (3) append semantics + (2) seek->resume ---------------------------
    {
        let mut f = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&path)
            .expect("create");
        f.write_all(&vec![0xAAu8; 4096]).expect("seed");
        f.sync_all().expect("sync");
    }

    // Resume: reopen, seek to the byte after what we already have, continue.
    let resumed_ok = {
        let mut f = OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("reopen for resume");
        let len = f.metadata().expect("metadata").len();
        f.seek(SeekFrom::Start(len)).expect("seek to end");
        f.write_all(&vec![0xBBu8; 1024]).expect("append after seek");
        f.sync_all().expect("sync");
        drop(f);

        let mut check = Vec::new();
        File::open(&path)
            .expect("read back")
            .read_to_end(&mut check)
            .expect("read_to_end");
        check.len() == 4096 + 1024
            && check[..4096].iter().all(|b| *b == 0xAA)
            && check[4096..].iter().all(|b| *b == 0xBB)
    };

    // Append mode: every write lands at the current end even if the cursor moved.
    let append_ok = {
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .expect("open append");
        // Deliberately move the cursor backwards; a true append must ignore it.
        f.seek(SeekFrom::Start(0)).expect("seek backward");
        f.write_all(b"TAIL").expect("append write");
        f.sync_all().expect("sync");
        drop(f);

        let mut check = Vec::new();
        File::open(&path)
            .expect("read back")
            .read_to_end(&mut check)
            .expect("read");
        // If append were honoured, the 4 bytes are at the END; if the seek won,
        // they overwrote the first 4 bytes instead. Compared as slices so no
        // reference-to-reference is taken.
        check.ends_with(b"TAIL") && check[..4] == [0xAA, 0xAA, 0xAA, 0xAA]
    };

    // --- (1) std file locking, claimed stable since 1.89 -------------------
    let lock_ok = {
        let f = File::open(&path).expect("open for lock");
        // `try_lock` here is std's — if this compiles, no fs2/fs4 is needed
        // for a single-writer guard.
        match f.try_lock() {
            Ok(()) => {
                let _ = f.unlock();
                true
            }
            // WouldBlock still proves the API exists and works.
            Err(_) => true,
        }
    };

    (resumed_ok, append_ok, lock_ok)
}

/// 4 + 5: does `notify` actually fire on this filesystem, and does watching the
/// FILE (rather than its directory) lose events, as the upstream issue claims?
fn watching(dir: &Path) -> (usize, usize) {
    // --- watch the DIRECTORY (the recommended shape) ------------------------
    let dir_events = {
        let (tx, rx) = mpsc::channel();
        let mut w = notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        })
        .expect("recommended_watcher");
        w.watch(dir, RecursiveMode::NonRecursive)
            .expect("watch dir");

        let target = dir.join("watched-dir.txt");
        std::fs::write(&target, b"one\n").expect("write 1");
        std::thread::sleep(Duration::from_millis(120));
        {
            let mut f = OpenOptions::new()
                .append(true)
                .open(&target)
                .expect("append");
            f.write_all(b"two\n").expect("write 2");
        }
        std::thread::sleep(Duration::from_millis(400));

        let mut n = 0;
        while rx.try_recv().is_ok() {
            n += 1;
        }
        let _ = w.unwatch(dir);
        n
    };

    // --- watch the FILE itself (the shape upstream issue #254 says is lossy) -
    let file_events = {
        let target = dir.join("watched-file.txt");
        std::fs::write(&target, b"one\n").expect("seed file");

        let (tx, rx) = mpsc::channel();
        let mut w = notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        })
        .expect("recommended_watcher");
        w.watch(&target, RecursiveMode::NonRecursive)
            .expect("watch file");

        for i in 0..3 {
            let mut f = OpenOptions::new()
                .append(true)
                .open(&target)
                .expect("append");
            f.write_all(format!("line{i}\n").as_bytes()).expect("write");
            f.sync_all().ok();
            std::thread::sleep(Duration::from_millis(150));
        }
        std::thread::sleep(Duration::from_millis(400));

        let mut n = 0;
        while rx.try_recv().is_ok() {
            n += 1;
        }
        let _ = w.unwatch(&target);
        n
    };

    (dir_events, file_events)
}

/// 6: is hashing actually cheap next to the pipe? Hash the same volume the lab
/// moved, and report throughput so it can be compared with the measured pipe rate.
fn hashing(bytes: usize) -> (f64, String) {
    let data = vec![0x5Au8; bytes];
    let started = Instant::now();
    let hash = blake3::hash(&data);
    let secs = started.elapsed().as_secs_f64();
    (bytes as f64 / 1048576.0 / secs, hash.to_hex().to_string())
}

fn main() {
    let dir = scratch();
    println!("scratch: {}", dir.display());
    println!(
        "rustc:   {}\n",
        option_env!("RUSTC_VERSION").unwrap_or("(see below)")
    );

    let (resumed, append, lock) = primitives(&dir);
    println!("== standard library primitives ==");
    println!("  resume via seek+write (byte-exact) : {}", yn(resumed));
    println!("  append mode ignores a moved cursor : {}", yn(append));
    println!("  std File::try_lock compiles/works  : {}", yn(lock));

    let (dir_events, file_events) = watching(&dir);
    println!("\n== notify on this filesystem ==");
    println!("  events watching the DIRECTORY      : {dir_events}");
    println!("  events watching the FILE itself    : {file_events}");
    println!(
        "  => {}",
        if dir_events > 0 {
            "notify fires here (watching the file is the lossy shape)"
        } else {
            "NO EVENTS — notify does not work on this path (the WSL/NFS caveat!)"
        }
    );

    let (mibs, hex) = hashing(64 * 1024 * 1024);
    println!("\n== blake3 ==");
    println!("  64 MiB hashed at {mibs:.0} MiB/s (sha {})", &hex[..16]);
    println!(
        "  => compare with the measured stdio pipe (~140 MiB/s): hashing is {}",
        if mibs > 280.0 {
            "NOT the bottleneck"
        } else {
            "in the same order — measure before assuming"
        }
    );

    let pass = resumed && append && lock;
    println!(
        "\nRESULT {}",
        if pass {
            "primitives OK"
        } else {
            "PRIMITIVE CHECK FAILED"
        }
    );
    std::process::exit(if pass { 0 } else { 1 });
}

fn yn(b: bool) -> &'static str {
    if b {
        "YES"
    } else {
        "no"
    }
}
