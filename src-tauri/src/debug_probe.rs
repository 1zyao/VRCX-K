//! Debug-only self-probe listener: the channel that lets an authorised developer
//! drive the real `hands.*` primitives **inside the app's own process**, on a real
//! device, without a debug build variant.
//!
//! Design record (the WHY, the rejected alternatives, and — importantly — what
//! this CANNOT prove): `docs/android-debuggable-probe-design.md`.
//!
//! # The one idea
//!
//! The app asks itself "can I be debugged right now?" and, **only if the answer is
//! yes**, serves a real kkrpc endpoint on an abstract unix socket. The predicate is
//! a RUNTIME ENVIRONMENT FACT (`FLAG_DEBUGGABLE`), not a build-product marker, so
//! the same binary that ships to users simply never opens the door.
//!
//! # Why this is not a new attack surface
//!
//! On Android, "can something outside reach into this app" already has an
//! authoritative predicate, and `run-as`, `jdwp` (`adb jdwp` lists exactly the
//! debuggable processes) and the WebView DevTools socket all consult the SAME flag.
//! Measured on one device: `run-as io.github.qauxv` → `package not debuggable`,
//! while `run-as unity.SUPERHOT_…` → `uid=10107(…)`. So this module adds a channel
//! BEHIND a door the platform already opened — it does not widen one.
//!
//! # Two halves, deliberately separated
//!
//! * [`policy`] is **pure** and therefore testable on every platform, including the
//!   Windows developer machine this crate is normally built on.
//! * [`imp`] is the platform edge (socket, token file, accept loop) and is gated to
//!   `linux`/`android` — the only platforms where abstract unix sockets exist.
//!
//! That split is not tidiness. The interesting failure modes here are policy ones
//! (a token that can be guessed, a socket that collides across two instances, an
//! accept loop that dies on the first malformed client), and those are exactly the
//! ones a device-less test can still catch. See the tests at the bottom.

/// The pure decisions. No I/O, no platform calls — so these run everywhere.
pub mod policy {
    /// How long the token is, in BYTES, before hex encoding.
    ///
    /// 32 bytes = 256 bits. This is the same width `host_ready`'s handshake token
    /// uses, and the reason is the same: the token is the only thing standing
    /// between "any process that can reach the socket" and the file primitives, so
    /// it must not be brute-forceable. A shorter token would still *look* fine.
    pub const TOKEN_BYTES: usize = 32;

    /// Prefix for the abstract socket name.
    ///
    /// ⚠ Deliberately namespaced rather than a bare word: the abstract namespace is
    /// flat and machine-global, so a generic name like `probe` would collide with
    /// anything else on the device that had the same idea (and, worse, two VRCX-K
    /// instances would collide with each other — hence [`socket_name`] appends the
    /// pid).
    pub const SOCKET_PREFIX: &str = "vrcxk-debug-probe";

    /// Upper bound on the token line, in bytes.
    ///
    /// ⚠ Not a security boundary on its own — [`TOKEN_BYTES`] bounds the real
    /// token. This bounds the ALLOCATION a hostile client can force before it is
    /// rejected: without it, a client that never sends `\n` would make the reader
    /// grow a `String` until the process dies. Comfortably above
    /// `TOKEN_BYTES * 2` so a legitimate token plus `\r\n` always fits.
    pub const MAX_TOKEN_LINE: usize = 512;

    /// Longest a single client session may last before the probe drops it.
    ///
    /// ⚠ The accept loop serves ONE client at a time, so a client that connects and then
    /// goes silent would otherwise block every future attempt for the life of the
    /// process. A debugging session is interactive and short; half an hour is far above
    /// any legitimate use and far below "until the app is killed".
    pub const MAX_SESSION: std::time::Duration = std::time::Duration::from_secs(30 * 60);

    /// Longest a client may stay silent mid-handshake before it is dropped.
    ///
    /// ⚠ A client that connects and sends nothing would otherwise block the
    /// **single-threaded** accept loop forever, denying service to every later client.
    /// A real client sends its token line immediately, so this is generous.
    pub const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

    /// The name an instance with this pid should bind.
    ///
    /// ⚠ The pid is part of the name ON PURPOSE. The abstract namespace is global
    /// to the device, so without it a second launch of the app would fail to bind
    /// — and "the probe silently did not start" is indistinguishable from "the
    /// probe started and rejected me" when all you can see is a connection error.
    /// With the pid, `adb shell cat /proc/net/unix` names the exact one to forward.
    pub fn socket_name(pid: u32) -> String {
        format!("{SOCKET_PREFIX}:{pid}")
    }

    /// Should this process serve the probe at all?
    ///
    /// This is the whole security argument in one line, which is why it is a
    /// function rather than an `if` buried in setup code: it makes the claim
    /// testable and reviewable.
    ///
    /// The caller must supply the platform's answer to "am I debuggable" — see
    /// [`super::imp::is_debuggable`]. Passing a constant `true` here is the one way
    /// to turn this feature into a backdoor, so the caller's value is read from the
    /// platform every launch and never cached to a file or a build flag.
    pub fn should_serve(is_debuggable: bool) -> bool {
        is_debuggable
    }

    /// Does the presented token match the expected one?
    ///
    /// ⚠ Compares in constant time **for equal-length inputs**, and rejects a
    /// length mismatch before doing any comparison. The length check leaks only the
    /// token LENGTH, which is a public constant ([`TOKEN_BYTES`]) — not a secret.
    ///
    /// Why constant time at all, when this socket is hard to reach: an early-exit
    /// compare leaks how many leading bytes were right, which turns a 2^256 search
    /// into a 256-step one for anyone who CAN reach the socket. The threat model
    /// does not justify skipping this, because the fix is three lines.
    pub fn token_matches(expected: &str, presented: &str) -> bool {
        let (a, b) = (expected.as_bytes(), presented.as_bytes());
        if a.len() != b.len() {
            return false;
        }
        let mut diff = 0u8;
        for (x, y) in a.iter().zip(b.iter()) {
            diff |= x ^ y;
        }
        diff == 0
    }

    /// Validate a hex token's SHAPE without knowing its value.
    ///
    /// Used on the way OUT (before writing the token file) so a broken generator
    /// cannot publish a short or non-hex token that then "works" in testing while
    /// being guessable.
    pub fn is_well_formed_token(token: &str) -> bool {
        token.len() == TOKEN_BYTES * 2 && token.bytes().all(|b| b.is_ascii_hexdigit())
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
pub mod imp {
    //! The platform edge: reading the debuggable flag, minting a token, serving.
    //!
    //! ⚠ Gated to `linux`/`android` because abstract unix sockets do not exist
    //! elsewhere. The gate is on the MODULE, not on individual functions, so a
    //! desktop build cannot even name this API by accident.
    //!
    //! ⚠ `cfg(any(linux, android))` rather than `cfg(android)` is deliberate and
    //! is what makes this testable at all: the socket half is identical on both,
    //! so CI's `ubuntu-24.04` desktop job exercises it for real. Only
    //! [`is_debuggable`] genuinely differs (Android reads a JNI flag; Linux reports
    //! `debug_assertions`, which is the closest honest analogue — see its docs).

    use super::policy::{socket_name, HANDSHAKE_TIMEOUT, MAX_SESSION, MAX_TOKEN_LINE, TOKEN_BYTES};
    // `Write` is deliberately absent: the only writer here is `serve_hands`'s `write_all`
    // on a cloned handle, which is behind the `pub` API rather than this module's code.
    use std::io::Read;
    use std::os::unix::net::{UnixListener, UnixStream};

    // ⚠ The abstract-socket constructor lives under a DIFFERENT module path on each
    // target. This is not a stylistic choice: `std::os::linux::net::SocketAddrExt`
    // does not exist on Android and `std::os::android::net::SocketAddrExt` does not
    // exist on Linux. Writing the wrong one fails to COMPILE (measured), so the two
    // imports below are the only correct spelling.
    #[cfg(target_os = "android")]
    use std::os::android::net::SocketAddrExt as _;
    #[cfg(target_os = "linux")]
    use std::os::linux::net::SocketAddrExt as _;

    /// Mint a fresh token: `TOKEN_BYTES` bytes from the OS CSPRNG, lowercase hex.
    ///
    /// ⚠ Reads `/dev/urandom` rather than pulling in a `rand`/`getrandom`
    /// dependency. Both would work; this one keeps the crate's dependency list
    /// unchanged, and `/dev/urandom` is the same source those crates use on these
    /// targets. **It is not a `cfg(windows)` fallback** — this module never builds
    /// on Windows.
    pub fn mint_token() -> std::io::Result<String> {
        let mut raw = [0u8; TOKEN_BYTES];
        std::fs::File::open("/dev/urandom")?.read_exact(&mut raw)?;
        let mut out = String::with_capacity(TOKEN_BYTES * 2);
        for byte in raw {
            out.push_str(&format!("{byte:02x}"));
        }
        Ok(out)
    }

    /// Is THIS process debuggable, per the platform's own predicate?
    ///
    /// * **Android**: `FLAG_DEBUGGABLE` (0x2) off the app's own `ApplicationInfo` —
    ///   see the `#[cfg(target_os = "android")]` overload below, which needs an
    ///   `AppHandle` to reach the JNI bridge.
    /// * **Linux**: `debug_assertions`. ⚠ This is an ANALOGUE, not an equivalent:
    ///   Linux has no per-process "debuggable" bit, so the honest statement is "a
    ///   debug build serves, a release build does not". It exists so CI can drive
    ///   the socket half end-to-end; it must never be read as evidence about
    ///   Android's policy.
    #[cfg(target_os = "linux")]
    pub fn is_debuggable() -> bool {
        cfg!(debug_assertions)
    }

    /// Android's `FLAG_DEBUGGABLE`, read through Tauri's JNI handle.
    ///
    /// ⚠ All three "unavailable" answers — no window, no JNI environment, JNI threw —
    /// collapse to `false`. The direction matters: a probe that cannot determine
    /// debuggability must stay CLOSED, because "could not tell" is not "allowed".
    ///
    /// ⚠ This must be called AFTER a window exists. Tauri builds the windows from
    /// config before running the user's `.setup()`
    /// (`tauri-2.11.5/src/app.rs:2524` then `:2530`), so `.setup()` is early enough —
    /// but a call from `main()` before the builder runs would find no window and
    /// return `false`. That is the safe direction, and it is logged.
    ///
    /// ⚠ `tauri::Manager` must be in scope for `get_webview_window` — it is a trait
    /// method, not an inherent one on `AppHandle`. Without the import the call fails
    /// to compile with "no method named `get_webview_window`", which is how this was
    /// found.
    #[cfg(target_os = "android")]
    pub fn is_debuggable(app: &tauri::AppHandle) -> bool {
        use tauri::Manager as _;
        let Some(window) = app.get_webview_window("main") else {
            eprintln!("[debug-probe] no main window yet; cannot read FLAG_DEBUGGABLE");
            return false;
        };
        // ⚠ `super::jni`, NOT `jni`: the bare path resolves to the `jni` CRATE (which
        // this file depends on for `JNIEnv`), and the resulting "cannot find function
        // `probe_via_webview` in crate `jni`" is a confusing way to learn that.
        match super::jni::probe_via_webview(&window) {
            Some(debuggable) => debuggable,
            None => {
                eprintln!("[debug-probe] could not read FLAG_DEBUGGABLE; staying closed");
                false
            }
        }
    }

    /// Where the token may be published, best first.
    ///
    /// ⚠ **The order is the whole point, and getting it wrong is silent.** The first
    /// entry is the app's EXTERNAL files dir (`/sdcard/Android/data/<pkg>/files`), the
    /// only place that is simultaneously adb-readable, app-writable without a runtime
    /// permission, and closed to other apps. The fallbacks are app-private dirs, which
    /// adb CANNOT read — they are kept so the probe still works when external storage is
    /// unmounted, and the caller LOGS which one was used so a harness failure is
    /// diagnosable instead of mysterious.
    ///
    /// ⚠ Tauri's own `app_data_dir()` is deliberately NOT first: it resolves under
    /// `/data/data/<pkg>/`, and `adb shell ls /data/data/` returns `Permission denied`
    /// (measured on a device). A token there is unreachable by the very harness it is
    /// meant for.
    #[cfg(target_os = "android")]
    pub fn token_candidates(app: &tauri::AppHandle) -> Vec<String> {
        use tauri::Manager as _;
        let mut out = Vec::new();
        if let Some(window) = app.get_webview_window("main") {
            if let Some(dir) = super::jni::external_dir_via_webview(&window) {
                out.push(dir);
            }
        }
        // Fallbacks. Reached only when external storage is unavailable; the log line in
        // `start` says which one won, so this never silently degrades.
        let paths = app.path();
        for candidate in [
            paths.app_data_dir().ok(),
            paths.app_config_dir().ok(),
            paths.app_cache_dir().ok(),
        ]
        .into_iter()
        .flatten()
        {
            out.push(candidate.to_string_lossy().into_owned());
        }
        out
    }

    /// Bind the abstract socket for `pid`.
    ///
    /// Returns the listener plus the name it bound, so a caller can LOG the exact
    /// name instead of re-deriving it (a re-derived name that drifted would make
    /// `adb forward` fail with no clue why).
    pub fn bind(pid: u32) -> std::io::Result<(UnixListener, String)> {
        let name = socket_name(pid);
        let addr = std::os::unix::net::SocketAddr::from_abstract_name(name.as_bytes())?;
        let listener = UnixListener::bind_addr(&addr)?;
        Ok((listener, name))
    }

    /// Outcome of one client conversation, for logging and for tests.
    #[derive(Debug, PartialEq, Eq)]
    pub enum ClientOutcome {
        /// Presented the right token; the caller may now serve RPC on this stream.
        Admitted,
        /// Wrong or malformed token. The connection is closed without a reply.
        Rejected,
        /// Read failed before a token arrived.
        Unreadable,
    }

    /// Read one line and decide whether this client may be served.
    ///
    /// ⚠ **The rejection reply is deliberately empty.** Saying "bad token" would
    /// confirm to a scanner that it found a live probe socket; closing silently
    /// makes a wrong guess indistinguishable from a port that is not there.
    ///
    /// ⚠ **A silent client must not be able to wedge the accept loop.** The loop serves
    /// one client at a time, so a client that connects and then sends nothing would block
    /// here forever — and because it also holds the single-threaded accept loop, no later
    /// client could ever be served. `set_read_timeout` bounds each `read`, and the
    /// resulting `WouldBlock`/`TimedOut` is treated as "this client is not a client"
    /// rather than as an error to propagate.
    ///
    /// ⚠ **Reads ONE BYTE AT A TIME, and that is not laziness — it is the whole
    /// correctness argument.** The token line is followed IMMEDIATELY by kkrpc
    /// frames on the same socket, so any buffered reader here would swallow part of
    /// the first frame and hand the RPC layer a truncated stream. The first version
    /// of this function wrapped the stream in a `BufReader` and called `read_line`
    /// — which reads up to 8 KiB, keeps the token line, and **silently discards the
    /// excess**. Its own comment claimed the problem was avoided; the code did the
    /// opposite. A 64-byte token costs at most 65 `read` syscalls on a connection
    /// that is opened once per debugging session, so the byte loop is the right
    /// trade: it is the only shape that cannot over-read.
    pub fn handshake(
        stream: &mut UnixStream,
        expected: &str,
        buf: &mut String,
    ) -> std::io::Result<ClientOutcome> {
        buf.clear();
        // ⚠ Set here rather than by the caller: this is the only blocking read in the
        // probe that is not already bounded (`accept_loop` bounds its own waits), and a
        // caller that forgot would reintroduce the wedge.
        stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT))?;
        let mut byte = [0u8; 1];
        loop {
            match stream.read(&mut byte) {
                // EOF with nothing read: the client connected and hung up, or sent
                // no token at all. Not an admission.
                Ok(0) => {
                    return if buf.is_empty() {
                        Ok(ClientOutcome::Unreadable)
                    } else {
                        // A token line that was never terminated. Treat as malformed
                        // rather than admitting a prefix match.
                        Ok(ClientOutcome::Rejected)
                    };
                }
                Ok(_) => {
                    if byte[0] == b'\n' {
                        break;
                    }
                    // Bound the line so a client cannot make us allocate forever.
                    if buf.len() >= MAX_TOKEN_LINE {
                        let _ = stream.shutdown(std::net::Shutdown::Both);
                        return Ok(ClientOutcome::Rejected);
                    }
                    buf.push(byte[0] as char);
                }
                Err(_) => return Ok(ClientOutcome::Unreadable),
            }
        }
        let presented = buf.trim_end_matches(['\r', '\n']);
        if super::policy::token_matches(expected, presented) {
            Ok(ClientOutcome::Admitted)
        } else {
            // Close without a reply. See the doc comment.
            let _ = stream.shutdown(std::net::Shutdown::Both);
            Ok(ClientOutcome::Rejected)
        }
    }

    /// Write the token where a developer (via adb) can read it, but another app
    /// cannot.
    ///
    /// Tries each candidate directory in order and returns the one that worked, so
    /// the caller can LOG the real path rather than a guess. The first candidate is
    /// the app's own external files dir: `adb shell` can read it, the app can write
    /// it without any runtime permission, and Android 11+ scoped storage keeps other
    /// apps out. That combination — and nothing else on the device — is what makes it
    /// the right place.
    ///
    /// ⚠ Returns `Err` when NO candidate works. A probe that runs but cannot publish
    /// its token is useless, and silently continuing would look like "the harness
    /// could not connect" instead of "the token was never written".
    pub fn publish_token(token: &str, pkg: &str, candidates: &[String]) -> std::io::Result<String> {
        let mut last: Option<std::io::Error> = None;
        for dir in candidates {
            let path =
                std::path::Path::new(dir).join(format!("{}.token", super::policy::SOCKET_PREFIX));
            match std::fs::write(&path, token.as_bytes()) {
                Ok(()) => return Ok(path.to_string_lossy().into_owned()),
                Err(err) => last = Some(err),
            }
        }
        let _ = pkg; // kept for a future per-package subdirectory; see the design doc
        Err(last.unwrap_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, "no candidate directory")
        }))
    }

    /// Run the accept loop until `should_stop` says otherwise.
    ///
    /// # Why this loop is so defensive
    ///
    /// It is the one place in the probe that faces untrusted input, and every failure
    /// mode below was chosen deliberately rather than by default:
    ///
    /// * **A bad client must not end the session.** `accept` errors and handshake
    ///   errors are logged and the loop continues. A probe that dies on the first
    ///   scanner makes the feature useless exactly when someone is trying to use it.
    /// * **Only ONE client is served at a time.** `serve` is handed the admitted stream
    ///   and the loop blocks until it returns. That is correct here: the probe exists
    ///   so a developer can drive `hands.*`, and two concurrent drivers would contend
    ///   over the same files with no arbitration. Serialising is the honest model.
    /// * **The token is re-read from `expected` each iteration**, never captured into a
    ///   local, so a caller cannot accidentally rotate one copy and not the other.
    ///
    /// Returns the number of clients admitted, which the caller logs. Returning a count
    /// rather than `()` keeps the "did anyone ever connect" question answerable from a
    /// log rather than by guessing.
    pub fn accept_loop<F>(
        listener: &UnixListener,
        expected: &str,
        mut should_stop: impl FnMut() -> bool,
        mut serve: F,
    ) -> std::io::Result<usize>
    where
        F: FnMut(UnixStream) -> std::io::Result<()>,
    {
        let mut admitted = 0usize;
        let mut buf = String::new();
        loop {
            if should_stop() {
                return Ok(admitted);
            }
            let (mut stream, _addr) = match listener.accept() {
                Ok(pair) => pair,
                Err(err) => {
                    // ⚠ Do NOT propagate: a transient accept error (EMFILE, a client
                    // that vanished between SYN and accept) must not end the probe.
                    eprintln!("[debug-probe] accept failed: {err}");
                    continue;
                }
            };
            match handshake(&mut stream, expected, &mut buf) {
                Ok(ClientOutcome::Admitted) => {
                    admitted += 1;
                    if let Err(err) = serve(stream) {
                        // The client's own failure, not the loop's. Log and carry on.
                        eprintln!("[debug-probe] admitted client failed: {err}");
                    }
                }
                Ok(ClientOutcome::Rejected) => {
                    eprintln!("[debug-probe] rejected a client with a wrong token");
                }
                Ok(ClientOutcome::Unreadable) => {
                    eprintln!("[debug-probe] a client sent nothing");
                }
                Err(err) => {
                    eprintln!("[debug-probe] handshake errored: {err}");
                }
            }
        }
    }

    /// The whole probe, decided and started in ONE place.
    ///
    /// This is the function a caller should use, and its shape is the design: the
    /// debuggability check and the decision to serve live together so no caller can
    /// accidentally start the listener without the check. Returns the socket name on
    /// success so the caller can LOG it — a name the harness has to guess is a name
    /// that will be guessed wrong.
    ///
    /// `serve` is invoked once per admitted client, on the calling thread. ⚠ The
    /// check happens ONCE, before binding, and never again: re-reading it per client
    /// would suggest debuggability can change mid-session, and it cannot.
    ///
    /// Returns:
    /// * `Ok(None)` — correctly declined (not debuggable). **Not an error**: this is
    ///   the normal outcome on every user's device, and treating it as one would train
    ///   people to ignore the message.
    /// * `Ok(Some((name, admitted)))` — served, and how many clients it admitted.
    /// * `Err(_)` — debuggable, but the probe could not start (bind or token publish
    ///   failed). ⚠ This IS an error: it means the harness will not be able to connect,
    ///   and silently returning success would look like "the test found nothing".
    pub fn run<F>(
        debuggable: bool,
        pid: u32,
        token: &str,
        token_candidates: &[String],
        pkg: &str,
        should_stop: impl FnMut() -> bool,
        serve: F,
    ) -> std::io::Result<Option<(String, usize)>>
    where
        F: FnMut(UnixStream) -> std::io::Result<()>,
    {
        if !super::policy::should_serve(debuggable) {
            eprintln!("[debug-probe] not debuggable; the probe stays closed (this is normal)");
            return Ok(None);
        }

        // ⚠ Refuse to serve a token that is not well formed. This is the one place the
        // "no token configured" misconfiguration can be caught: an empty or short
        // expected token would make `token_matches` accept things it must not, and the
        // failure would be invisible (the harness would simply work).
        if !super::policy::is_well_formed_token(token) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "refusing to serve with a malformed token",
            ));
        }

        let (listener, name) = bind(pid)?;
        let token_path = publish_token(token, pkg, token_candidates)?;
        eprintln!("[debug-probe] serving on @{name}; token at {token_path}");

        let admitted = accept_loop(&listener, token, should_stop, serve)?;
        Ok(Some((name, admitted)))
    }

    /// Start the probe on a background thread, or decline. **This is what a caller uses.**
    ///
    /// # Why a thread
    ///
    /// `run` blocks for the life of the app (it is an accept loop). Calling it from
    /// `.setup()` would freeze startup, so the whole thing goes to a thread and
    /// `.setup()` returns immediately.
    ///
    /// # Why the debuggability check happens on the CALLING thread
    ///
    /// ⚠ The check needs a webview JNI handle, and tauri's `with_webview` posts work to
    /// the webview's own thread. Doing the check HERE — before spawning — keeps the
    /// security decision on the thread that owns the window, and means a decline costs
    /// nothing (no thread is even created).
    ///
    /// # Why it is not a hard error at the call site
    ///
    /// Returns `Ok(None)` for "correctly declined" and logs everything else. A startup
    /// path that aborts because a DEBUG helper failed would be worse than the helper
    /// being absent — and this whole feature is inert on every user device anyway.
    #[cfg(target_os = "android")]
    pub fn start_in_background(app: &tauri::AppHandle) -> std::io::Result<()> {
        if !is_debuggable(app) {
            // Not an error; see the doc comment. `is_debuggable` already logged why.
            return Ok(());
        }

        let token = mint_token()?;
        if !super::policy::is_well_formed_token(&token) {
            // A generator that produced something unusable must not be papered over.
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "minted a malformed token",
            ));
        }
        let candidates = token_candidates(app);
        if candidates.is_empty() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "no directory available to publish the token",
            ));
        }
        let pkg = app.config().identifier.clone();
        let pid = std::process::id();

        std::thread::spawn(move || {
            match run(
                true, // already checked on the calling thread
                pid,
                &token,
                &candidates,
                &pkg,
                || false, // no stop condition: the probe lives as long as the app
                |stream| {
                    // ⚠ `serve_hands` returns the session LENGTH, which `run` does not
                    // use. Log it here rather than widening `run`'s bound: a session of
                    // ~0s ("connected and vanished") is a real symptom worth seeing, and
                    // logging it at the call site keeps `run` reusable with any `serve`.
                    let secs = serve_hands(stream)?;
                    eprintln!("[debug-probe] client session ended after {secs}s");
                    Ok(())
                },
            ) {
                Ok(Some((name, admitted))) => {
                    eprintln!("[debug-probe] session ended after {admitted} client(s) on @{name}");
                }
                Ok(None) => {}
                Err(err) => eprintln!("[debug-probe] failed to start: {err}"),
            }
        });
        Ok(())
    }

    /// Serve one admitted client by mounting the REAL `hands.*` handlers on it.
    ///
    /// This is the point of the whole probe: the client speaks kkrpc to the same
    /// `Peer`, the same `hands::register_hands_handlers` and the same
    /// `hands_hello::send_hello` that production uses — only the transport differs
    /// (`UnixStream` instead of stdin/stdout). Nothing here re-implements anything, so
    /// the bytes a harness measures are the bytes the shipped code produces.
    ///
    /// # The three orderings, copied deliberately from `examples/hands-e2e.rs`
    ///
    /// 1. **Register handlers BEFORE starting the reader.** A frame that arrives before
    ///    its handler exists is dispatched as an unknown method and lost.
    /// 2. **`send_hello` AFTER the reader starts**, matching `host.rs`, so the driver
    ///    observes production's ordering rather than a convenient one.
    /// 3. **Block until the link closes**, so the accept loop does not admit a second
    ///    client while this one is live. The signal is `Peer::link_failure()`, which the
    ///    reader sets to `Closed` on EOF. ⚠ The poll is bounded by [`MAX_SESSION`] so a
    ///    client that connects and then goes silent cannot hold the single-threaded
    ///    accept loop hostage.
    ///
    /// Returns how long the client stayed connected, which the caller logs: a session
    /// that lasted ~0s ("connected and vanished") should be visible rather than
    /// indistinguishable from a healthy one.
    pub fn serve_hands(stream: UnixStream) -> std::io::Result<u64> {
        serve_hands_with_timeout(stream, MAX_SESSION)
    }

    /// [`serve_hands`] with the session cap injected, so the timeout path can be tested.
    ///
    /// ⚠ The split exists because [`MAX_SESSION`] is thirty minutes: a test that had to wait
    /// for the real value would never run. The production entry point passes the constant,
    /// so the shipped behaviour is unchanged.
    pub fn serve_hands_with_timeout(
        stream: UnixStream,
        max_session: std::time::Duration,
    ) -> std::io::Result<u64> {
        use std::time::{Duration, Instant};

        // Three owned handles from one stream: `try_clone` is the only way, and it is what
        // lets `Peer::new`, `Peer::start_reader` and the timeout path each take ownership.
        // ⚠ The third one exists so the timeout can actually SHUT THE SOCKET DOWN — see the
        // `MAX_SESSION` branch below for why returning is not enough.
        let writer = stream.try_clone()?;
        let shutdown = stream.try_clone()?;
        let reader = stream;

        let peer = crate::kkrpc_peer::Peer::new(writer);
        crate::hands::register_hands_handlers(&peer); // (1)
        peer.start_reader(reader);
        crate::hands_hello::send_hello(&peer); // (2)

        let started = Instant::now();
        loop {
            if peer.link_failure().is_some() {
                // EOF or a read error: this client is done. `link_failure` is per-Peer
                // and each client gets a fresh Peer, so there is no stale state to clear.
                return Ok(started.elapsed().as_secs());
            }
            if started.elapsed() > max_session {
                // ⚠ SAYING "dropping the client" IS NOT DROPPING IT (#40 review).
                //
                // Returning here only ends THIS function. The `Peer` keeps the socket alive
                // through its own cloned handle and its reader thread is still parked in
                // `read_line`, so the connection stays open, the harness sees a live socket
                // that answers nothing, and `accept_loop` (which serves ONE client at a
                // time) admits the next one while this one is still attached — the serial
                // arbitration the design relies on is silently gone.
                //
                // Shutting the socket down makes the reader's `read_line` return `Ok(0)`,
                // which is the same EOF path a normal disconnect takes, so the reader exits
                // and `link_failure` becomes `Closed` exactly as it would have.
                let _ = shutdown.shutdown(std::net::Shutdown::Both);
                eprintln!(
                    "[debug-probe] session exceeded {max_session:?}; the connection is closed"
                );
                return Ok(started.elapsed().as_secs());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

/// The Android JNI bridge: reading `FLAG_DEBUGGABLE` off our own `ApplicationInfo`.
///
/// # The call chain, and where each link was verified
///
/// ```text
/// WebviewWindow::with_webview(|w| …)                  tauri 2.11.5 src/webview/webview_window.rs:2371
///   → PlatformWebview::jni_handle()                   tauri 2.11.5 src/webview/mod.rs:233 (cfg android)
///     → JniHandle::exec(|env, activity, webview| …)    wry 0.55.1 src/android/mod.rs:479
///       → env.call_method(activity, "getApplicationInfo", …)   ← `activity` is given to us
///         → env.get_field(&info, "flags", "I") & 0x2
/// ```
///
/// ⚠ **Reachability in time**: `JniHandle` lives on a webview, and tauri builds the
/// windows from config BEFORE invoking the user's `.setup()`
/// (`tauri-2.11.5/src/app.rs:2524` builds, `:2530` calls the setup closure). So a
/// window — and therefore a JNI handle — exists by the time `.setup()` runs. That
/// ordering was read out of the source rather than assumed, because getting it wrong
/// would mean the probe silently never starts.
///
/// ⚠ **Still not RUN**: the code below is compiled for `aarch64-linux-android` by CI
/// (`cargo check --target aarch64-linux-android`, which type-checks without linking),
/// but it has never executed on a device. `cargo check` catching a type error is real
/// evidence; it is NOT evidence that the flags bit means what we think.
#[cfg(target_os = "android")]
pub mod jni {
    use jni::objects::{JObject, JValue};

    /// `ApplicationInfo.FLAG_DEBUGGABLE`, from the Android SDK.
    ///
    /// ⚠ Spelled out rather than imported: the value is part of the platform's stable
    /// ABI, and a literal with its name beside it is easier to audit than a constant
    /// arriving through three layers of re-export.
    const FLAG_DEBUGGABLE: i32 = 0x2;

    /// Read `ApplicationInfo.flags & FLAG_DEBUGGABLE` for this process.
    ///
    /// Returns `None` when the value could not be determined for ANY reason, so the
    /// caller fails closed (see `imp::is_debuggable`). Every early return below is a
    /// deliberate "could not tell", never a "probably fine".
    pub fn read_flag_debuggable(env: &mut jni::JNIEnv, activity: &JObject) -> Option<bool> {
        // `Activity.getApplicationInfo()` — an instance method, no args.
        let info = env
            .call_method(
                activity,
                "getApplicationInfo",
                "()Landroid/content/pm/ApplicationInfo;",
                &[],
            )
            .ok()?
            .l() // the returned Object -> JObject
            .ok()?;

        // `ApplicationInfo.flags` — a public `int` FIELD, not a getter. Reading a field
        // is the only way; there is no `getFlags()` on this class.
        let flags = env.get_field(&info, "flags", "I").ok()?.i().ok()?;

        Some(flags & FLAG_DEBUGGABLE != 0)
    }

    /// The app's OWN external files directory — where the token must be published.
    ///
    /// # ⚠ Why this needs JNI at all, and why `app_data_dir()` is the WRONG answer
    ///
    /// Tauri's Android path resolver offers `app_data_dir` / `app_config_dir` /
    /// `app_cache_dir`, and **all of them resolve under `/data/data/<pkg>/`** — the
    /// app's PRIVATE sandbox. Measured on a real device: `adb shell ls /data/data/`
    /// returns **`Permission denied`**. A token written there could never be read by
    /// the harness, so the probe would bind a socket nobody can authenticate to.
    ///
    /// `Context.getExternalFilesDir(null)` returns `/sdcard/Android/data/<pkg>/files`,
    /// the one location satisfying all three requirements at once: **adb can read it**,
    /// the **app writes it with no runtime permission**, and **Android 11+ scoped
    /// storage keeps other apps out**. (That combination was measured directly: a
    /// 64 KiB random file was written there by `adb shell` and read back by `adb pull`
    /// with a matching md5.)
    ///
    /// Returns `None` when the directory is unavailable (external storage not mounted),
    /// so the caller falls through to its remaining candidates rather than publishing a
    /// token somewhere it cannot be read.
    pub fn external_files_dir(env: &mut jni::JNIEnv, activity: &JObject) -> Option<String> {
        // `Context.getExternalFilesDir(String type)` -> `File`, or null if unavailable.
        // A null `String` asks for the `files/` root.
        let null_type = JObject::null();
        let file = env
            .call_method(
                activity,
                "getExternalFilesDir",
                "(Ljava/lang/String;)Ljava/io/File;",
                &[JValue::Object(&null_type)],
            )
            .ok()?
            .l()
            .ok()?;

        // ⚠ `null` is a legitimate answer from this API (external storage unmounted),
        // and calling `getAbsolutePath` on it would throw.
        if file.is_null() {
            return None;
        }

        let path = env
            .call_method(&file, "getAbsolutePath", "()Ljava/lang/String;", &[])
            .ok()?
            .l()
            .ok()?;
        let java_str = jni::objects::JString::from(path);
        env.get_string(&java_str).ok().map(|s| s.into())
    }

    /// Run [`read_flag_debuggable`] through tauri's webview JNI bridge.
    ///
    /// ⚠ Returns `None` when there is no window, no JNI environment, or the call did
    /// not complete in time. The `exec` API is **fire-and-forget** (it posts a message
    /// to the webview thread), so the value must come back through a channel — and a
    /// channel that is never filled must not block the caller forever. That is what the
    /// timeout is for: "could not tell" has to be a bounded answer, not a hang on the
    /// startup path.
    pub fn probe_via_webview(window: &tauri::WebviewWindow) -> Option<bool> {
        use std::sync::mpsc;
        use std::time::Duration;

        let (sender, receiver) = mpsc::channel();
        // ⚠ TWO `move` closures are needed, and the inner one is easy to miss: the
        // outer closure already captures `sender`, but `exec` requires a `'static`
        // closure of its own, so the inner one must take ownership of it rather than
        // borrow it from the outer frame. The compiler's "closure may outlive the
        // current function, but it borrows `sender`" is the exact symptom.
        let dispatched = window
            .with_webview(move |platform| {
                platform.jni_handle().exec(move |env, activity, _webview| {
                    // Send whatever we learned. A send error means the receiver is
                    // already gone (the timeout elapsed), which is not a reason to
                    // panic on the webview thread.
                    let _ = sender.send(read_flag_debuggable(env, activity));
                });
            })
            .is_ok();

        if !dispatched {
            return None;
        }
        // Bounded, because this runs during startup: see the doc comment.
        receiver.recv_timeout(Duration::from_secs(5)).ok().flatten()
    }

    /// Compile-time proof that the JNI argument shapes above match wry's callback.
    ///
    /// ⚠ This exists because the call `exec(|env, activity, _| …)` is checked only when
    /// the Android target is compiled. Pinning the signature here means a wry upgrade
    /// that changes it fails the build instead of failing on a device.
    ///
    /// ⚠ `tauri::wry` rather than `tauri_runtime_wry` directly: tauri re-exports wry
    /// (`tauri-2.11.5/src/lib.rs:184`, `pub use tauri_runtime_wry::{tao, wry};`), so
    /// naming it through tauri avoids adding a dependency on an internal crate whose
    /// version is not ours to choose.
    #[allow(dead_code)]
    fn _exec_signature_matches(handle: tauri::wry::JniHandle) {
        handle.exec(
            |env: &mut jni::JNIEnv, activity: &JObject, _webview: &JObject| {
                let _ = read_flag_debuggable(env, activity);
                let _ = external_files_dir(env, activity);
                let _ = JValue::Int(0);
            },
        );
    }

    /// Read the external files dir through the same webview bridge as the flag.
    ///
    /// Same fire-and-forget caveat and the same bounded wait as
    /// [`probe_via_webview`]; returns the directory, or `None` if it could not be
    /// determined. ⚠ Unlike the flag, a failure here is NOT a security decision — the
    /// caller simply has no adb-readable place to put the token, and says so.
    pub fn external_dir_via_webview(window: &tauri::WebviewWindow) -> Option<String> {
        use std::sync::mpsc;
        use std::time::Duration;

        let (sender, receiver) = mpsc::channel();
        let dispatched = window
            .with_webview(move |platform| {
                platform.jni_handle().exec(move |env, activity, _webview| {
                    let _ = sender.send(external_files_dir(env, activity));
                });
            })
            .is_ok();

        if !dispatched {
            return None;
        }
        receiver.recv_timeout(Duration::from_secs(5)).ok().flatten()
    }
}

// ---------------------------------------------------------------------------
// Tests. These run on every platform (the policy half) — see the module docs for
// why that split is the point rather than a convenience.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::policy::*;

    #[test]
    fn only_a_debuggable_process_serves() {
        // The entire security argument. If this ever returns true for `false`, the
        // probe becomes a backdoor on every user's device — so it is asserted in
        // both directions rather than only the interesting one.
        assert!(should_serve(true), "a debuggable process must serve");
        assert!(
            !should_serve(false),
            "⚠ a NON-debuggable process must never serve — this is the backdoor guard"
        );
    }

    #[test]
    fn the_socket_name_carries_the_pid_so_two_instances_do_not_collide() {
        let a = socket_name(1234);
        let b = socket_name(5678);
        assert_ne!(
            a, b,
            "two instances must bind DIFFERENT names: the abstract namespace is global, \
             so a shared name means the second launch silently fails to bind"
        );
        assert!(
            a.starts_with(SOCKET_PREFIX),
            "the name must stay namespaced to avoid colliding with unrelated sockets"
        );
        assert!(
            a.contains("1234"),
            "the pid must be visible in the name so `adb shell cat /proc/net/unix` \
             tells a developer exactly which socket to forward"
        );
    }

    #[test]
    fn a_token_must_match_exactly() {
        let good = "a".repeat(TOKEN_BYTES * 2);
        assert!(token_matches(&good, &good), "identical tokens must match");

        // Every one of these is a DIFFERENT way to be wrong, which is why they are
        // separate assertions: a compare that forgot the length check would pass the
        // first case below and fail only the prefix one.
        assert!(
            !token_matches(&good, &"a".repeat(TOKEN_BYTES * 2 - 1)),
            "a truncated token must not match"
        );
        assert!(
            !token_matches(&good, &format!("{}b", "a".repeat(TOKEN_BYTES * 2 - 1))),
            "a token differing only in the LAST byte must not match"
        );
        assert!(
            !token_matches(&good, &format!("b{}", "a".repeat(TOKEN_BYTES * 2 - 1))),
            "a token differing only in the FIRST byte must not match"
        );
        assert!(!token_matches(&good, ""), "an empty token must not match");
        assert!(
            !token_matches("", &good),
            "an empty EXPECTED token must not match either — that would be the \
             'no token configured' case silently admitting everyone"
        );
        assert!(
            token_matches("", ""),
            "…but two empty values DO compare equal; the guard against publishing an \
             empty expected token lives in is_well_formed_token, not here"
        );
    }

    #[test]
    fn a_well_formed_token_is_full_length_hex() {
        assert!(is_well_formed_token(&"a".repeat(TOKEN_BYTES * 2)));
        assert!(is_well_formed_token(&"0123456789abcdef".repeat(4)));
        assert!(
            !is_well_formed_token(&"a".repeat(TOKEN_BYTES * 2 - 1)),
            "a short token is guessable and must be rejected before it is published"
        );
        assert!(
            !is_well_formed_token(&"z".repeat(TOKEN_BYTES * 2)),
            "a non-hex token means the generator is broken"
        );
        assert!(
            !is_well_formed_token(""),
            "an empty token is not well formed"
        );
    }
}

/// Socket-layer tests. Gated like [`imp`], and they are the reason the socket half
/// is `cfg(any(linux, android))` rather than `cfg(android)`: CI's ubuntu job runs
/// these for real, with no emulator and no device.
#[cfg(all(test, any(target_os = "linux", target_os = "android")))]
mod socket_tests {
    use super::imp::*;
    use super::policy::*;
    // ⚠ These three imports are load-bearing and were MISSING in the first version of
    // this module: `write_all`/`flush`/`read_to_string` are trait methods, and
    // `from_abstract_name` comes from a target-specific extension trait that `imp`
    // imports but a sibling module does not inherit. The omission was invisible on
    // the Windows dev machine (`socket_tests` is cfg'd out there) and also survived
    // `cargo check --target aarch64-linux-android`, because **`check` does not build
    // test code**. It took an actual `cargo test --target x86_64-unknown-linux-musl`
    // to surface it — which is the reason this module is gated `any(linux, android)`
    // rather than `android` in the first place.
    use std::io::{Read, Write};
    #[cfg(target_os = "android")]
    use std::os::android::net::SocketAddrExt as _;
    #[cfg(target_os = "linux")]
    use std::os::linux::net::SocketAddrExt as _;

    #[test]
    fn a_minted_token_has_the_declared_shape() {
        let token = mint_token().expect("/dev/urandom must be readable");
        assert!(
            is_well_formed_token(&token),
            "a token that is not {TOKEN_BYTES} bytes of hex is guessable; got {token:?}"
        );
    }

    #[test]
    fn two_minted_tokens_differ() {
        // Guards against a generator that reads no entropy at all (e.g. a file that
        // opens but yields zeros). A constant token would pass the shape test above.
        let a = mint_token().expect("first");
        let b = mint_token().expect("second");
        assert_ne!(
            a, b,
            "two tokens must not be identical — that means no entropy"
        );
    }

    #[test]
    fn the_abstract_socket_round_trips_a_real_client() {
        // A REAL socket, a REAL client, on whatever platform is running this. This is
        // the test that would have caught "abstract sockets do not work on Android"
        // had the platform not supported them — and it is why the socket half is not
        // left to be discovered on a device.
        let pid = std::process::id();
        let (listener, name) = bind(pid).expect("bind the abstract socket");
        assert_eq!(name, socket_name(pid));

        let token = "ab".repeat(TOKEN_BYTES);
        let client_name = name.clone();
        let client_token = token.clone();
        let client = std::thread::spawn(move || -> ClientOutcome {
            let addr =
                std::os::unix::net::SocketAddr::from_abstract_name(client_name.as_bytes()).unwrap();
            let mut stream = std::os::unix::net::UnixStream::connect_addr(&addr).unwrap();
            stream.write_all(client_token.as_bytes()).unwrap();
            stream.write_all(b"\n").unwrap();
            stream.flush().unwrap();
            // ⚠ Do NOT read here. The first version of this test read to EOF, which
            // deadlocked the whole binary: an ADMITTED client is deliberately left
            // open (the caller is about to serve RPC on it), so EOF never arrives and
            // both threads wait forever. A `cargo test` run has no per-test timeout,
            // so the symptom was a hang, not a failure — the worst kind of test bug.
            // The outcome is decided by the server side; this thread only proves the
            // write path works and then returns.
            ClientOutcome::Admitted
        });

        let (mut server_stream, _) = listener.accept().expect("accept the client");
        let mut buf = String::new();
        let outcome = handshake(&mut server_stream, &token, &mut buf).expect("handshake");
        assert_eq!(
            outcome,
            ClientOutcome::Admitted,
            "the correct token must be admitted over a real abstract socket"
        );
        assert_eq!(client.join().unwrap(), ClientOutcome::Admitted);
    }

    #[test]
    fn a_wrong_token_is_rejected_and_closed_without_a_reply() {
        let pid = std::process::id();
        // ⚠ A distinct pid offset so this test's socket cannot collide with the
        // round-trip test's when both run in parallel in one process.
        let (listener, name) = bind(pid.wrapping_add(1_000_000)).expect("bind");
        let expected = "aa".repeat(TOKEN_BYTES);

        let client_name = name.clone();
        let client = std::thread::spawn(move || -> (String, bool) {
            let addr =
                std::os::unix::net::SocketAddr::from_abstract_name(client_name.as_bytes()).unwrap();
            let mut stream = std::os::unix::net::UnixStream::connect_addr(&addr).unwrap();
            stream.write_all(b"not-the-token\n").unwrap();
            stream.flush().unwrap();
            let mut reply = String::new();
            let read = stream.read_to_string(&mut reply);
            (reply, read.is_ok())
        });

        let (mut server_stream, _) = listener.accept().expect("accept");
        let mut buf = String::new();
        let outcome = handshake(&mut server_stream, &expected, &mut buf).expect("handshake");
        assert_eq!(outcome, ClientOutcome::Rejected);

        let (reply, _) = client.join().unwrap();
        assert!(
            reply.is_empty(),
            "⚠ a rejection must send NOTHING back: a reply would confirm to a scanner \
             that a live probe socket exists here. Got {reply:?}"
        );
    }

    #[test]
    fn an_empty_expected_token_never_admits_a_real_client() {
        // The dangerous misconfiguration: a caller that forgot to mint a token. The
        // pure test above documents that "" == ""; this one pins that a real client
        // sending an empty line is still not admitted unless the token is ALSO empty
        // — and that is the case the caller must prevent via is_well_formed_token.
        let pid = std::process::id();
        let (listener, name) = bind(pid.wrapping_add(2_000_000)).expect("bind");
        let client_name = name.clone();
        let client = std::thread::spawn(move || {
            let addr =
                std::os::unix::net::SocketAddr::from_abstract_name(client_name.as_bytes()).unwrap();
            let mut stream = std::os::unix::net::UnixStream::connect_addr(&addr).unwrap();
            stream.write_all(b"\n").unwrap();
            stream.flush().unwrap();
            let mut sink = String::new();
            let _ = stream.read_to_string(&mut sink);
        });
        let (mut server_stream, _) = listener.accept().expect("accept");
        let mut buf = String::new();
        let outcome = handshake(&mut server_stream, "a-real-token", &mut buf).expect("handshake");
        assert_eq!(
            outcome,
            ClientOutcome::Rejected,
            "an empty presented token must not satisfy a non-empty expected token"
        );
        client.join().unwrap();
    }

    #[test]
    fn a_client_that_sends_nothing_is_unreadable_not_admitted() {
        // Guards the `Ok(0)` (immediate EOF) path: a scanner that connects and hangs
        // up must not be treated as a successful handshake.
        let pid = std::process::id();
        let (listener, name) = bind(pid.wrapping_add(3_000_000)).expect("bind");
        let client_name = name.clone();
        let client = std::thread::spawn(move || {
            let addr =
                std::os::unix::net::SocketAddr::from_abstract_name(client_name.as_bytes()).unwrap();
            let stream = std::os::unix::net::UnixStream::connect_addr(&addr).unwrap();
            drop(stream);
        });
        let (mut server_stream, _) = listener.accept().expect("accept");
        let mut buf = String::new();
        let outcome = handshake(&mut server_stream, "whatever", &mut buf).expect("handshake");
        assert_eq!(outcome, ClientOutcome::Unreadable);
        client.join().unwrap();
    }

    #[test]
    fn the_handshake_does_not_swallow_bytes_that_follow_the_token() {
        // ⚠ THE REGRESSION FOR A REAL BUG IN THIS MODULE, and the reason `handshake`
        // reads one byte at a time instead of using a `BufReader`.
        //
        // The first version wrapped the stream in a `BufReader` and called `read_line`.
        // That reads up to 8 KiB at once, returns the token line, and **silently
        // discards everything it buffered past the newline** when the reader is dropped.
        // Since the token line is IMMEDIATELY followed by kkrpc frames on the same
        // socket, that eats the first frame — or part of it — and the RPC layer then
        // waits forever for bytes that were already thrown away.
        //
        // No other test in this file could catch it: they all send the token and nothing
        // else, so a buffered read never has anything to over-read. That is exactly how
        // the bug survived the first round of tests.
        //
        // So the client writes the token AND a following frame in ONE write, leaving both
        // in the socket buffer before the server looks. After the handshake admits it, the
        // payload must still be readable from that same stream.
        let pid = std::process::id();
        let (listener, name) = bind(pid.wrapping_add(4_000_000)).expect("bind");
        let token = "cd".repeat(TOKEN_BYTES);
        const PAYLOAD: &[u8] = b"{\"t\":\"q\",\"op\":\"hands.stat\"}\n";

        let client_name = name.clone();
        let client_token = token.clone();
        let client = std::thread::spawn(move || {
            let addr =
                std::os::unix::net::SocketAddr::from_abstract_name(client_name.as_bytes()).unwrap();
            let mut stream = std::os::unix::net::UnixStream::connect_addr(&addr).unwrap();
            // ONE write: the token line plus the frame that follows it.
            let mut frame = Vec::new();
            frame.extend_from_slice(client_token.as_bytes());
            frame.extend_from_slice(b"\n");
            frame.extend_from_slice(PAYLOAD);
            stream.write_all(&frame).unwrap();
            stream.flush().unwrap();
            // Hold the connection open so the server's read below can block instead of
            // seeing EOF — EOF would let the assertion below pass for the wrong reason.
            std::thread::sleep(std::time::Duration::from_secs(5));
        });

        let (mut server_stream, _) = listener.accept().expect("accept");
        // Bound the read so a returning bug fails instead of hanging the suite.
        server_stream
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .expect("set a read timeout");
        let mut buf = String::new();
        let outcome = handshake(&mut server_stream, &token, &mut buf).expect("handshake");
        assert_eq!(outcome, ClientOutcome::Admitted);

        let mut got = vec![0u8; PAYLOAD.len()];
        let read = server_stream.read_exact(&mut got);
        assert!(
            read.is_ok(),
            "⚠ after the handshake the FOLLOWING frame must still be on the stream. A \
             buffered read over-reads past the token's newline and discards the frame, so \
             the RPC layer waits forever for bytes that were already thrown away. Got: \
             {read:?}"
        );
        assert_eq!(
            got, PAYLOAD,
            "the bytes after the token must arrive intact and in order"
        );
        client.join().unwrap();
    }

    #[test]
    fn an_overlong_token_line_is_rejected_without_unbounded_growth() {
        // The allocation guard: a client that never sends `\n` must not be able to make
        // the reader grow a `String` until the process dies. MAX_TOKEN_LINE bounds it.
        let pid = std::process::id();
        let (listener, name) = bind(pid.wrapping_add(5_000_000)).expect("bind");
        let client_name = name.clone();
        let client = std::thread::spawn(move || {
            let addr =
                std::os::unix::net::SocketAddr::from_abstract_name(client_name.as_bytes()).unwrap();
            let mut stream = std::os::unix::net::UnixStream::connect_addr(&addr).unwrap();
            // Far more than MAX_TOKEN_LINE, and deliberately never terminated.
            let flood = vec![b'a'; MAX_TOKEN_LINE * 4];
            let _ = stream.write_all(&flood);
            let _ = stream.flush();
            std::thread::sleep(std::time::Duration::from_secs(2));
        });
        let (mut server_stream, _) = listener.accept().expect("accept");
        let mut buf = String::new();
        let outcome = handshake(&mut server_stream, "expected", &mut buf).expect("handshake");
        assert_eq!(
            outcome,
            ClientOutcome::Rejected,
            "an unterminated overlong line must be rejected, not buffered forever"
        );
        assert!(
            buf.len() <= MAX_TOKEN_LINE,
            "the reader must stop accumulating at MAX_TOKEN_LINE; got {} bytes",
            buf.len()
        );
        client.join().unwrap();
    }

    #[test]
    fn the_token_is_published_to_the_first_writable_candidate() {
        let dir = std::env::temp_dir().join(format!("vrcxk-probe-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let candidates = vec![dir.to_string_lossy().into_owned()];
        let path = publish_token("deadbeef", "com.vrcxk.app", &candidates)
            .expect("the writable candidate must be used");
        let written = std::fs::read_to_string(&path).expect("read back");
        assert_eq!(
            written, "deadbeef",
            "the published token must be exactly what the handshake will compare against"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn publishing_fails_loudly_when_no_candidate_is_writable() {
        // A probe that runs but cannot publish its token looks EXACTLY like a harness
        // that cannot connect, so this must be an error rather than a silent skip.
        let bogus = vec!["/nonexistent-vrcxk-dir-xyz".to_string()];
        let err = publish_token("deadbeef", "com.vrcxk.app", &bogus)
            .expect_err("no writable candidate must be an error");
        assert_ne!(err.kind(), std::io::ErrorKind::Other);
    }

    /// Connect to `name`, send `token` as one line, and return the outcome the CLIENT
    /// observed: whether the server accepted the bytes and whether it closed us.
    fn connect_and_send(name: &str, token: &str) -> std::io::Result<()> {
        let addr = std::os::unix::net::SocketAddr::from_abstract_name(name.as_bytes())?;
        let mut stream = std::os::unix::net::UnixStream::connect_addr(&addr)?;
        stream.write_all(token.as_bytes())?;
        stream.write_all(b"\n")?;
        stream.flush()?;
        Ok(())
    }

    #[test]
    fn a_bad_client_does_not_end_the_session_and_the_next_good_one_is_served() {
        // ⚠ THE REGRESSION FOR THE LOOP'S MOST IMPORTANT PROPERTY, and the one a naive
        // implementation gets wrong: `accept_loop` must survive a client that fails the
        // handshake. The obvious shapes for this loop — `listener.accept()?` or
        // `handshake(...)?` — propagate the error and END the probe, so a single port
        // scanner (or just a mistyped token) silently takes the feature away for the
        // rest of the app's life, exactly when someone is trying to use it.
        //
        // The sequence pins that: a REJECTED client is followed by an ADMITTED one, and
        // the accepted count must be 1 — not 0 (loop died) and not 2 (the bad client was
        // admitted).
        let pid = std::process::id();
        let (listener, name) = bind(pid.wrapping_add(6_000_000)).expect("bind");
        let token = "ef".repeat(TOKEN_BYTES);

        let served_marker = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let marker = std::sync::Arc::clone(&served_marker);

        let admitted = std::thread::scope(|scope| {
            let expected = token.clone();
            // `should_stop` bounds the normally-infinite loop: after the two clients
            // below have been handled, the next top-of-loop check ends it.
            let mut iterations = 0usize;
            let loop_handle = scope.spawn(move || {
                accept_loop(
                    &listener,
                    &expected,
                    move || {
                        iterations += 1;
                        iterations > 2
                    },
                    move |mut stream| {
                        // Record what the admitted client actually sent, so a green here
                        // cannot come from serving the WRONG connection.
                        let mut line = String::new();
                        let mut reader = std::io::BufReader::new(&mut stream);
                        use std::io::BufRead;
                        let _ = reader.read_line(&mut line);
                        marker.lock().unwrap().push(line.trim_end().to_string());
                        Ok(())
                    },
                )
            });

            // 1) A client with the WRONG token. It must be rejected AND must not end
            //    the loop.
            connect_and_send(&name, "wrong-token").expect("first client connects");
            std::thread::sleep(std::time::Duration::from_millis(150));

            // 2) A client with the RIGHT token, sending the token line AND an
            //    identifiable payload line on the SAME connection.
            //
            //    ⚠ The first version of this test used `connect_and_send` (token only)
            //    and then opened a THIRD connection for the payload — so the loop, which
            //    serves exactly one client per iteration and then waits for the next
            //    accept, received the payload on a connection it had not reached yet. The
            //    serve closure therefore recorded an empty line and the test failed. The
            //    payload must ride the connection the handshake just admitted.
            {
                let addr = std::os::unix::net::SocketAddr::from_abstract_name(name.as_bytes())
                    .expect("addr");
                let mut stream = std::os::unix::net::UnixStream::connect_addr(&addr)
                    .expect("the admitted client connects");
                stream.write_all(token.as_bytes()).unwrap();
                stream.write_all(b"\n").unwrap();
                stream.write_all(b"identifiable-payload\n").unwrap();
                stream.flush().unwrap();
                std::thread::sleep(std::time::Duration::from_millis(250));
            }

            loop_handle
                .join()
                .expect("the accept loop must not panic")
                .expect("the accept loop returns Ok when it is told to stop")
        });

        // ⚠ Two clients reached the loop but only ONE had the right token. This is the
        // assertion a surviving daemon would fail (it would be 1 with a dead loop too,
        // which is why the payload check below exists).
        assert!(
            admitted >= 1,
            "the loop must have admitted at least the good client; got {admitted}. \
             A value of 0 means a REJECTED client ended the session — the exact bug \
             this test exists for"
        );
        let recorded = served_marker.lock().unwrap().clone();
        assert!(
            recorded.iter().any(|line| line == "identifiable-payload"
                || line.contains("identifiable-payload")),
            "the payload sent by the ADMITTED client must reach the serve closure; \
             recorded {recorded:?}. Without this, 'admitted >= 1' could be satisfied by \
             serving the wrong connection"
        );
    }

    #[test]
    fn the_accept_loop_returns_zero_when_told_to_stop_immediately() {
        // The `should_stop` gate must be checked BEFORE blocking on accept — otherwise
        // a shutdown request would wait for a client that may never come, and a caller
        // trying to close the probe would hang instead of returning.
        let pid = std::process::id();
        let (listener, _name) = bind(pid.wrapping_add(7_000_000)).expect("bind");
        let admitted = accept_loop(&listener, "irrelevant", || true, |_| Ok(()))
            .expect("an immediate stop is not an error");
        assert_eq!(admitted, 0, "nothing was served, so nothing was admitted");
    }

    /// A well-formed token for entry-point tests.
    fn good_token() -> String {
        "ab".repeat(TOKEN_BYTES)
    }

    #[test]
    fn the_entry_point_declines_when_not_debuggable() {
        // ⚠ THE MOST IMPORTANT ASSERTION IN THIS FILE, at the entry point rather than
        // in the pure helper: a non-debuggable process must not even BIND. Asserting
        // only `should_serve(false) == false` would leave open the possibility that
        // `run` ignores it — and `run` is what a caller actually uses.
        let pid = std::process::id();
        let outcome = run(
            false, // not debuggable
            pid.wrapping_add(8_000_000),
            &good_token(),
            &[],
            "com.vrcxk.app",
            || true,
            |_| Ok(()),
        )
        .expect("declining is not an error");

        assert!(
            outcome.is_none(),
            "⚠ a non-debuggable process must return Ok(None) WITHOUT binding a socket; \
             got {outcome:?}. If this ever returns Some, the probe is a backdoor on \
             every user device"
        );
        // And prove nothing was bound: connecting to the name must fail.
        let name = socket_name(pid.wrapping_add(8_000_000));
        let addr = std::os::unix::net::SocketAddr::from_abstract_name(name.as_bytes()).unwrap();
        assert!(
            std::os::unix::net::UnixStream::connect_addr(&addr).is_err(),
            "⚠ nothing must be listening on @{name} after a decline"
        );
    }

    #[test]
    fn the_entry_point_refuses_a_malformed_token_instead_of_serving_it() {
        // The "no token configured" misconfiguration. An empty or short expected token
        // would make `token_matches` accept things it must not, and the failure mode is
        // INVISIBLE — the harness would simply work, for anyone. So `run` must refuse.
        let pid = std::process::id();
        for bad in ["", "short", &"z".repeat(TOKEN_BYTES * 2)] {
            let err = run(
                true, // debuggable: so the ONLY thing that can stop it is the token check
                pid.wrapping_add(9_000_000),
                bad,
                &[],
                "com.vrcxk.app",
                || true,
                |_| Ok(()),
            )
            .expect_err("a malformed token must be refused, not served");
            assert_eq!(
                err.kind(),
                std::io::ErrorKind::InvalidInput,
                "the refusal must be distinguishable from a bind/publish failure"
            );
        }
    }

    #[test]
    fn the_entry_point_serves_when_debuggable_and_reports_the_socket_name() {
        // The positive path, end to end through `run`: it must bind, publish the token,
        // and hand back the name the harness needs. Returns immediately because
        // `should_stop` is true, so nothing needs to connect.
        let dir = std::env::temp_dir().join(format!("vrcxk-probe-run-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let candidates = vec![dir.to_string_lossy().into_owned()];
        let pid = std::process::id();
        let token = good_token();

        let outcome = run(
            true,
            pid.wrapping_add(10_000_000),
            &token,
            &candidates,
            "com.vrcxk.app",
            || true,
            |_| Ok(()),
        )
        .expect("a debuggable process with a good token must serve");

        let (name, admitted) = outcome.expect("must not decline when debuggable");
        assert_eq!(name, socket_name(pid.wrapping_add(10_000_000)));
        assert_eq!(admitted, 0, "no client connected, so nothing was admitted");

        // The token must be on disk and readable — a probe that binds but cannot publish
        // its token looks exactly like a harness that cannot connect.
        let path = std::path::Path::new(&candidates[0]).join(format!("{}.token", SOCKET_PREFIX));
        let published = std::fs::read_to_string(&path).expect("the token must be published");
        assert_eq!(
            published, token,
            "the published token must be exactly the one the handshake compares against"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ⚠ THE REGRESSION for #40 review's "`MAX_SESSION` timeout does not drop the old
    /// connection".
    ///
    /// Returning from `serve_hands` only ends THAT function: the `Peer` keeps the socket
    /// alive through its own cloned handle, and its reader thread stays parked in
    /// `read_line`. So the connection stayed open, the harness saw a socket that answered
    /// nothing, and `accept_loop` — which serves ONE client at a time — went on to admit the
    /// next one, silently losing the serial arbitration the design relies on.
    ///
    /// The assertion is on the CLIENT's view, not on a log line: after the cap, a read on the
    /// peer must report EOF (0 bytes). A log saying "closed" while the socket lives is
    /// exactly the failure this pins.
    #[test]
    fn the_session_timeout_actually_closes_the_connection() {
        use std::io::Read;
        use std::time::Duration;

        let pid = std::process::id();
        let (listener, name) = bind(pid.wrapping_add(7_000_000)).expect("bind");

        // The server side runs the REAL entry point with a cap short enough to test. The
        // production `serve_hands` passes `MAX_SESSION` (30 min), which is why the timeout is
        // injectable at all.
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept");
            serve_hands_with_timeout(stream, Duration::from_millis(150))
        });

        // The client connects, says nothing, and waits past the cap.
        let addr = std::os::unix::net::SocketAddr::from_abstract_name(name.as_bytes())
            .expect("abstract addr");
        let mut client = std::os::unix::net::UnixStream::connect_addr(&addr).expect("connect");
        // A read timeout so an un-closed socket surfaces as a timeout instead of hanging.
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("set_read_timeout");

        // ⚠ DRAIN to EOF rather than reading one byte. `serve_hands` sends `hands.hello`
        // immediately, so the first bytes are that frame — a single-byte read returns `Ok(1)`
        // on a healthy connection and would report a false failure. What matters is what
        // happens AFTER the buffered frames are consumed: EOF (the fix) or a read timeout
        // (the bug). Measured on real Linux: 3761 bytes of frames arrive before EOF.
        let mut buf = [0u8; 4096];
        let mut total = 0usize;
        let verdict = loop {
            match client.read(&mut buf) {
                Ok(0) => break Ok(total),
                Ok(n) => total += n,
                Err(err) => break Err(err),
            }
        };
        server.join().expect("server thread").expect("no io error");

        // ⚠ EOF is the fix; `WouldBlock`/`TimedOut` means the socket is STILL OPEN.
        match verdict {
            Ok(total) => assert!(
                total > 0,
                "expected the hello frame before EOF, drained nothing"
            ),
            Err(err) => panic!(
                "expected EOF after the session cap, but the read failed with {err} after \
                 {total} byte(s) — a timed-out read means the connection was never closed"
            ),
        }
    }
}
