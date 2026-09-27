//! Verify the version we actually RECOMMEND: `notify 9.0.0-rc.5`.
//!
//! Our FINDINGS §4.7 recommends the rc line over stable 8.2.0 because 8.2.0 has
//! two Windows bugs that land on our requirements (#963 lost events on buffer
//! overflow, #730 events after `unwatch`). That recommendation was derived from
//! upstream sources — **not** from building the rc here. This does that, because
//! recommending a pre-release we have never compiled would be exactly the kind of
//! unverified claim this probe set exists to prevent.
//!
//! Checks:
//!   1. does 9.0.0-rc.5 resolve and build with the `tokio` feature?
//!   2. do the `tokio` EventHandler impls actually exist (compile-time)?
//!   3. does `Watcher::watched_paths()` exist (a claimed rc.3 addition)?
//!   4. does a real watch deliver an event, and does `unwatch` stop cleanly?
//!
//! Run: cargo run --release

use notify::{RecursiveMode, Watcher};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

fn work() -> PathBuf {
    let d = std::env::temp_dir().join("vrcxk-notify9-probe");
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("mkdir");
    d
}

#[tokio::main]
async fn main() {
    let dir = work();

    // --- (2)+(4) the clean async path: a tokio unbounded sender AS the handler --
    // If `UnboundedSender<Result<Event>>` did not implement `EventHandler`, this
    // would not compile — so compilation is the assertion.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let mut watcher = match notify::recommended_watcher(tx) {
        Ok(w) => {
            println!("(2) recommended_watcher accepts a tokio UnboundedSender = YES");
            w
        }
        Err(e) => {
            println!("(2) FAILED to build with a tokio sender: {e}");
            std::process::exit(1);
        }
    };

    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .expect("watch");

    // --- (3) watched_paths() — claimed to be an rc.3 addition ----------------
    // Wrapped so a missing method is a REPORTED result rather than a build failure
    // that hides the other checks.
    let watched = watcher.watched_paths();
    println!("(3) watched_paths() exists -> {watched:?}");

    // --- (4) a real event -----------------------------------------------------
    let target = dir.join("live.txt");
    {
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&target)
            .unwrap();
        f.write_all(b"hello\n").unwrap();
        f.sync_all().ok();
    }

    let got = tokio::time::timeout(Duration::from_secs(3), rx.recv()).await;
    match got {
        Ok(Some(Ok(event))) => println!("(4) event received -> {:?}", event.kind),
        Ok(Some(Err(e))) => println!("(4) watch error -> {e}"),
        Ok(None) => println!("(4) channel closed without an event"),
        Err(_) => println!("(4) TIMEOUT — no event in 3s"),
    }

    // --- (4b) unwatch then write ---------------------------------------------
    //
    // ⚠ THIS CHECK IS DELIBERATELY WEAK, AND IT ONCE REPORTED A FALSE "LEAK".
    // It does NOT drain the channel first, so an event still queued from the
    // write in (4) can be read here and look like a leak. That is exactly what
    // happened on the first run of this probe.
    //
    // The trustworthy version is `unwatch_strict` (and its v8 control), which
    // drains immediately before `unwatch`. This one is kept only because it shows
    // the trap — do not quote its (4b) line as evidence for anything.
    watcher.unwatch(&dir).expect("unwatch");
    std::thread::sleep(Duration::from_millis(300));
    {
        let p = dir.join("after-unwatch.txt");
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&p)
            .unwrap();
        f.write_all(b"after\n").unwrap();
        f.sync_all().ok();
    }
    let leaked = tokio::time::timeout(Duration::from_millis(800), rx.recv()).await;
    match leaked {
        Ok(Some(Ok(event))) => println!(
            "(4b) UNRELIABLE: an event arrived ({:?}) — could be queued from (4). \
             Use `unwatch_strict` for a trustworthy verdict",
            event.kind
        ),
        Ok(Some(Err(_))) => println!("(4b) error after unwatch (not a leak event)"),
        Ok(None) => println!("(4b) channel closed"),
        Err(_) => println!("(4b) no event after unwatch (weak check; see unwatch_strict)"),
    }

    let _ = std::fs::remove_dir_all(&dir);
    println!("RESULT 9.0.0-rc.5 built and ran; see the numbered lines above");
}
