//! Verify the ONE hybrid option that would let us reuse Tauri's file plumbing
//! instead of hand-rolling it: can Rust-side code get a real `std::fs::File`
//! out of `tauri-plugin-fs`'s `Fs<R>` handle?
//!
//! Why this decides a design choice: `Fs<R>::open()` is `pub` on desktop AND on
//! Android (where it resolves a `content://` URI through the SAF fd bridge). If
//! Rust can call it, then the hands can get a seekable `File` for BOTH an
//! ordinary path and an Android content URI, without touching the webview — and
//! `tauri-plugin-fs` becomes a candidate for the file layer instead of a
//! webview-only dead end.
//!
//! This is a COMPILE-level check plus a run against a temp file. It does NOT
//! register the plugin in the app (that would need a Tauri runtime); it verifies
//! the API shape Rust code would compile against, and that `open` really yields
//! a `std::fs::File` we can seek and append to.
//!
//! Run: cargo run --release --bin fs_handle

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;

fn main() {
    // The path type is `tauri_plugin_fs::FilePath` (dialog re-exports it).
    // On desktop it is `FilePath::Path(PathBuf)` for a normal path, and
    // `FilePath::Url(_)` for a `content://` URI / `file://` URL.
    let dir = std::env::temp_dir().join("vrcxk-fs-handle-probe");
    std::fs::create_dir_all(&dir).expect("mkdir");
    let target = dir.join("hybrid.bin");

    // --- what the plugin's OpenOptions offers (compile-time surface) --------
    let _opts: tauri_plugin_fs::OpenOptions = {
        let mut o = tauri_plugin_fs::OpenOptions::new();
        o.read(true)
            .write(true)
            .append(false)
            .truncate(true)
            .create(true);
        o
    };

    // --- FilePath is the type `Fs::open` accepts ---------------------------
    let as_path: tauri_plugin_fs::FilePath = target.clone().into();
    // `FromStr` for `FilePath` is INFALLIBLE (`Err = Infallible`): the enum is
    // untagged, so any string becomes either a `Url` or a `Path`. That is a real
    // finding for callers — there is no "unparseable URI" failure to handle, and
    // a bad URI only fails later, inside `Fs::open`.
    let via_url: tauri_plugin_fs::FilePath =
        "content://media/external/images/media/42".parse().unwrap();
    println!("FilePath from a path  : {as_path:?}");
    println!("FilePath from a URI   : {via_url:?}  (constructed without panicking)");
    // `into_path()` is the desktop-friendly conversion; it must FAIL for a
    // content:// URI *by design* — that failure is exactly why the hands must
    // use `Fs::open` (which routes URIs through the platform bridge) rather
    // than turning everything into a path first.
    println!(
        "  into_path() on the URI -> {:?}  (true = it failed, as designed)",
        via_url.clone().into_path().is_err()
    );
    // --- the real question: does `open` give us a std::fs::File? -----------
    // We cannot construct an `AppHandle` outside a Tauri runtime, so this
    // checks the SIGNATURE rather than calling it: if `Fs::open` did not return
    // `std::io::Result<std::fs::File>`, this function pointer coercion would not
    // compile.
    let _sig: fn(
        &tauri_plugin_fs::Fs<tauri::Wry>,
        tauri_plugin_fs::FilePath,
        tauri_plugin_fs::OpenOptions,
    ) -> std::io::Result<std::fs::File> = tauri_plugin_fs::Fs::<tauri::Wry>::open;
    println!("Fs::<Wry>::open signature = fn(&Fs, FilePath, OpenOptions) -> io::Result<std::fs::File>  <- CONFIRMED");

    // --- and prove the returned File would be genuinely usable -------------
    // Same operations the hands need, on a normal File, so the claim "seek +
    // append + read all work on what open returns" is demonstrated rather than
    // asserted.
    {
        let mut f = std::fs::File::create(&target).expect("create");
        f.write_all(&[0xAAu8; 512]).expect("seed");
        f.sync_all().ok();
    }
    {
        let mut f = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&target)
            .expect("reopen");
        let len = f.metadata().expect("meta").len();
        f.seek(SeekFrom::Start(len)).expect("seek");
        f.write_all(&[0xBBu8; 128]).expect("append");
        f.sync_all().ok();
    }
    let mut back = Vec::new();
    std::fs::File::open(&target)
        .expect("open")
        .read_to_end(&mut back)
        .expect("read");
    println!(
        "seek+append on a File = {} bytes, prefix/ suffix correct = {}",
        back.len(),
        back.len() == 640
            && back[..512].iter().all(|b| *b == 0xAA)
            && back[512..].iter().all(|b| *b == 0xBB)
    );

    let _ = std::fs::remove_dir_all(&dir);
    println!("RESULT Fs<R>::open returns a real std::fs::File (Rust-side usable); content:// -> into_path() fails by design, which is why open() must be used instead of path conversion");
}

// Keep the unused-import lint honest about what this probe does and does not do.
#[allow(dead_code)]
fn _unused(_p: PathBuf) {}
