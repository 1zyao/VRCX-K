mod app_lifecycle;
mod dialog_opts;
mod hands;
mod hands_hello;
mod host;
mod host_lifecycle;
mod host_ready;
mod kkrpc_peer;
mod notify;
mod process_tree;
mod shell_sys;
mod smoke;
// Desktop-only capabilities. These modules are built on APIs that exist only
// off-mobile: `tauri::tray`/`tauri::menu` (no tray or native menu on Android),
// the global-shortcut plugin (no OS-wide hotkeys), and the dialog plugin's
// `blocking_pick_folder*` (mobile exposes file picking only). Gating the
// modules — rather than stubbing their bodies — keeps a missing capability a
// compile-time fact instead of a runtime `false`.
#[cfg(desktop)]
mod shortcut;
#[cfg(desktop)]
mod tray;
// The declarative tray model itself is plain data (serde + collections, no
// Tauri API), so it stays compiled everywhere.
pub mod tray_model;
#[cfg(desktop)]
mod tray_renderer;
#[cfg(desktop)]
mod tray_schema;

use app_lifecycle::{
    AppCommand, AppCommandRequest, AppCommandResult, AppLifecycle, AppLifecycleFacade,
};
use host::{supervise_loop, HostReady, HostState};
use host_lifecycle::{HostCommand, HostCommandResult, HostSnapshot};
use serde::Serialize;
// `json!` is only used by the desktop single-instance callback below.
#[cfg(desktop)]
use serde_json::json;
use std::time::Duration;
use tauri::{Emitter, Manager, RunEvent};

/// Upper bound for a graceful app exit started by another path. Longer than the
/// supervisor's 30s stop watchdog, so a healthy-but-slow teardown is never cut
/// short; it only exists so a dead worker cannot make the app unquittable.
const EXIT_WATCHDOG: Duration = Duration::from_secs(45);

#[derive(Clone, Debug, Serialize)]
struct HostLifecycleStateResponse {
    snapshot: HostSnapshot,
}

#[tauri::command]
fn get_host_ready(state: tauri::State<HostState>) -> Option<HostReady> {
    state.snapshot()
}

#[tauri::command]
fn get_host_lifecycle(state: tauri::State<HostState>) -> HostLifecycleStateResponse {
    HostLifecycleStateResponse {
        snapshot: state.lifecycle_snapshot(),
    }
}

/// Dispatch a host lifecycle command to the supervisor.
///
/// Stable Rust-owned entry point shared by Tauri IPC (`invoke` from the web
/// view) and, through `HostLifecycleFacade`, the #6 tray router. The verdict
/// is synchronous (Accepted/Noop/Rejected against the current snapshot);
/// Accepted commands are executed by the supervisor thread off this caller,
/// so this command never blocks on host RPC or process teardown. The host
/// process tree is only ever touched by that supervisor thread.
#[tauri::command]
fn dispatch_host_command(
    state: tauri::State<HostState>,
    command: HostCommand,
) -> HostCommandResult {
    state.dispatch(command)
}

/// Execute an accepted application command on the Rust-owned lifecycle path.
///
/// Shared by the `dispatch_app_command` IPC entry point and the #6 tray
/// router: the tray route calls this directly (no string IPC) so both callers
/// observe one orchestration. The caller is responsible for obtaining an
/// `Accepted` verdict first (idempotent latch); this function performs the
/// post-accept work — latching AppExit so the supervisor cannot relaunch,
/// then the graceful/force teardown off the calling thread.
pub(crate) fn execute_app_command(app: tauri::AppHandle, command: AppCommand) {
    let state = app.state::<HostState>();
    // The Rust shell owns process lifecycle. Latch AppExit before returning so
    // the supervisor cannot relaunch and host/plugin code cannot race this app
    // command. Graceful work runs off the calling thread.
    state.latch_app_exit();
    match command {
        AppCommand::RestartGraceful => {
            std::thread::spawn(move || {
                let state = app.state::<HostState>();
                state.request_app_exit_graceful();
                app.request_restart();
            });
        }
        AppCommand::QuitGraceful => {
            std::thread::spawn(move || {
                let state = app.state::<HostState>();
                state.request_app_exit_graceful();
                app.exit(0);
            });
        }
        AppCommand::QuitForce => {
            // Force quit is allowed to escalate an in-flight graceful worker;
            // taking and killing the tree makes that worker observe no child.
            state.force_app_exit();
            app.exit(0);
        }
    }
}

#[tauri::command]
fn dispatch_app_command(
    app: tauri::AppHandle,
    _state: tauri::State<HostState>,
    lifecycle: tauri::State<AppLifecycle>,
    request: AppCommandRequest,
) -> AppCommandResult {
    let command = request.command;
    let result = lifecycle.dispatch(request);
    if !matches!(result, AppCommandResult::Accepted { .. }) {
        return result;
    }
    execute_app_command(app.clone(), command);
    result
}

/// Forward one deep link to the host, and mirror it to the face.
///
/// A received URL that nobody consumes is indistinguishable from a link that
/// never arrived — the OS delivered it, this process got it, and nothing
/// happened. So both deliveries are attempted and the outcome is emitted for the
/// dev panel, the same shape `shortcut.pressed` uses.
///
/// The brain owns what a URL MEANS (log in, join an instance); the shell only
/// proves it arrived.
#[cfg(desktop)]
fn forward_deep_link(app: &tauri::AppHandle, urls: Vec<String>) {
    let delivery = {
        let state = app.state::<HostState>();
        match state.peer() {
            Some(peer) => match peer.notify("deepLink.opened", vec![json!({ "urls": urls })]) {
                Ok(()) => "delivered",
                Err(err) => {
                    eprintln!("[shell] deep link notify failed: {err}");
                    "write-failed"
                }
            },
            None => "no-host",
        }
    };
    if let Err(err) = app.emit(
        "deep-link-opened",
        json!({ "urls": urls, "delivery": delivery }),
    ) {
        eprintln!("[shell] emit deep-link-opened: {err}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            // A second launch must surface the running window. The previous
            // `let _ =` swallowed a failed focus, so "the redirect arrived but
            // could not focus" was indistinguishable from "the second instance
            // never reached us" (both look like nothing happened). The outcome
            // is logged and mirrored to the dev smoke panel.
            //
            // Note (plugin behaviour, windows.rs): the second process sends
            // WM_COPYDATA only when it FINDS this instance's hidden window; if
            // it does not, it silently keeps running as a second app. So a
            // missing event here means the redirect never arrived — it does not
            // by itself mean this callback failed.
            let outcome = match tray::show_main_window(app) {
                Ok(()) => {
                    eprintln!("[shell] second instance redirect: main window focused");
                    json!({ "focused": true, "args": args, "cwd": cwd })
                }
                Err(err) => {
                    eprintln!("[shell] second instance redirect failed: {err}");
                    json!({ "focused": false, "error": err, "args": args, "cwd": cwd })
                }
            };
            if let Err(err) = app.emit("single-instance-redirect", outcome) {
                eprintln!("[shell] emit single-instance-redirect: {err}");
            }
        }));
    }

    builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // Cross-platform, no desktop-only API: `os` is read-only facts and
        // `clipboard-manager` works on mobile too (plain text only there), so
        // neither is gated.
        //
        // ⚠ `clipboard-manager`'s default permission set enables NOTHING. Every
        // command must be listed in `capabilities/default.json` or the call fails
        // at runtime with a permission error — see the capability file.
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(HostState::default())
        .manage(AppLifecycle::default());

    // Desktop-only plugins. Declared under a `cfg(any(windows, macos, linux))`
    // target section in Cargo.toml AND gated here: the catalog's platform matrix
    // marks every one of them "none" for Android/iOS, so referencing them on
    // mobile would be a compile error rather than a graceful absence.
    #[cfg(desktop)]
    {
        // Window position/size persistence. Defaults are the documented useful
        // set (size, position, maximized, fullscreen, decorations, visible) —
        // deliberately not narrowed, because losing "was maximized" on restart is
        // exactly the surprise this plugin exists to prevent.
        builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());

        // Autostart: `MacosLauncher::LaunchAgent` is the documented default and
        // the argv comes from the plugin's own builder. The shell only provides
        // the MECHANISM — whether a user wants the app to launch with the system
        // is a UI decision, so nothing enables it at boot. It is off until the
        // user turns it on.
        builder = builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ));

        // Deep links. Registered AFTER single-instance on purpose: a second
        // launch carrying a URL must be forwarded to the running instance, which
        // is what single-instance's `deep-link` feature (enabled in Cargo.toml)
        // arranges. Without that pairing a `vrchat://` link would open a second
        // app instead of reaching the live one.
        //
        // ⚠ Runtime scheme registration is Windows/Linux only; on macOS the
        // scheme must be declared in `tauri.conf.json`.
        //
        // ⚠ The `on_open_url` hook is registered in the ONE `.setup()` below,
        // NOT here. `Builder::setup` is a single slot: a second call REPLACES the
        // first with no error, so a handler registered in a second `.setup()`
        // silently discards everything the other one did. That is exactly what
        // the first attempt at this wiring did.
        builder = builder.plugin(tauri_plugin_deep_link::init());

        // Tray-relative positioning. Nothing calls `move_window` yet: today the
        // tray is a native menu and there is no popup window to place. Registered
        // now so the tray event hook has somewhere to go when the panel lands.
        builder = builder.plugin(tauri_plugin_positioner::init());
    }

    // Global shortcuts are a desktop-only capability: the plugin's types and the
    // `AppHandle::global_shortcut()` extension do not exist on mobile. The
    // plugin and its managed registry are gated together on purpose — the
    // builder-level handler is what makes a registered chord DO something (it
    // fires for every shortcut the shell registered and, issue #6, forwards the
    // key-down edge to the host over kkrpc/stdio), so registering one without
    // the other would give `on_event` no state to read.
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(shortcut::on_event)
                    .build(),
            )
            .manage(shortcut::ManagedShortcuts::default());
    }

    builder = builder
        .invoke_handler(tauri::generate_handler![
            get_host_ready,
            get_host_lifecycle,
            dispatch_host_command,
            dispatch_app_command,
            smoke::capability_smoke
        ])
        // Tray-resident window: closing the window hides it instead of
        // destroying it, so `show_main_window` (tray Show item, tray left
        // click, single-instance focus) keeps working. Quitting is an explicit
        // tray action (`app.quit.graceful`/`app.quit.force`), which tears the
        // process down through `app.exit()` and never goes through here.
        //
        // Applies to the MAIN window only: a future secondary window (tool /
        // dialog) must still be able to close normally.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                api.prevent_close();
                if let Err(err) = window.hide() {
                    eprintln!("[shell] hide window: {err}");
                }
            }
        })
        .setup(|app| {
            // The tray icon is a desktop surface: `tauri::tray` does not exist
            // on mobile, so there is nothing to set up there.
            #[cfg(desktop)]
            tray::setup(app.handle())?;
            // Deep links: consume the URLs the OS hands us. Registered here
            // rather than in its own `.setup()` because `Builder::setup` is a
            // single slot — a second call would silently replace this one and
            // lose the tray + supervisor wiring below.
            //
            // Without this hook a deep link is a link that vanishes: the OS
            // delivers it, this process receives it, nothing happens. The brain
            // owns what a URL MEANS (log in, join an instance); the shell only
            // proves it arrived.
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt as _;
                let deeplink_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    let urls: Vec<String> =
                        event.urls().iter().map(|url| url.to_string()).collect();
                    forward_deep_link(&deeplink_handle, urls);
                });
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let state = handle.state::<HostState>();
                let ready_handle = handle.clone();
                let snapshot_handle = handle.clone();
                // Change feed cache: the supervisor may observe the snapshot
                // many times per transition; only real changes reach the tray
                // and the web view.
                let mut last_fingerprint: Option<u64> = None;
                supervise_loop(
                    state.inner(),
                    Some(&handle),
                    move |ready| {
                        if let Err(err) = ready_handle.emit("host-ready", &ready) {
                            eprintln!("[shell] emit host-ready: {err}");
                        }
                    },
                    &mut move |snapshot| {
                        let fingerprint = host_lifecycle::snapshot_fingerprint(snapshot);
                        if last_fingerprint == Some(fingerprint) {
                            return;
                        }
                        last_fingerprint = Some(fingerprint);
                        // Tray projection is desktop-only; the lifecycle event
                        // below is emitted on every platform.
                        #[cfg(desktop)]
                        if let Err(err) = tray::refresh(&snapshot_handle) {
                            eprintln!("[shell] tray refresh: {err}");
                        }
                        if let Err(err) = snapshot_handle.emit("host-lifecycle", snapshot) {
                            eprintln!("[shell] emit host-lifecycle: {err}");
                        }
                    },
                );
            });
            Ok(())
        });

    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            RunEvent::ExitRequested {
                code: None, api, ..
            } => {
                // An OS/user exit not initiated by dispatch_app_command enters
                // the same Rust-owned graceful path.
                let request = AppCommandRequest {
                    schema_version: app_lifecycle::APP_LIFECYCLE_SCHEMA_VERSION,
                    command: AppCommand::QuitGraceful,
                };
                let lifecycle = app.state::<AppLifecycle>();
                match lifecycle.dispatch(request) {
                    AppCommandResult::Accepted { .. } => {
                        // Prevent this exit; the worker calls app.exit(0) only
                        // after the child is reaped.
                        api.prevent_exit();
                        app.state::<HostState>().latch_app_exit();
                        let exit_app = app.clone();
                        std::thread::spawn(move || {
                            let state = exit_app.state::<HostState>();
                            state.request_app_exit_graceful();
                            exit_app.exit(0);
                        });
                    }
                    AppCommandResult::Noop { .. } => {
                        // A graceful quit worker is already in flight and owns
                        // the exit. Letting the process leave here would orphan
                        // the child mid-teardown.
                        api.prevent_exit();
                        // Watchdog: if that worker dies without exiting (panic
                        // after the latch), the app must still be quittable.
                        // The bound exceeds the host stop watchdog (30s) so a
                        // slow-but-healthy teardown is never cut short.
                        let watchdog_app = app.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(EXIT_WATCHDOG);
                            watchdog_app.state::<HostState>().force_app_exit();
                            watchdog_app.exit(0);
                        });
                    }
                    AppCommandResult::Rejected { reason, .. } => {
                        // Another lifecycle command (e.g. a restart) owns the
                        // app; do not block the exit. `RunEvent::Exit` below is
                        // the guaranteed non-blocking child cleanup.
                        eprintln!("[shell] exit requested while {reason}; exiting");
                    }
                }
            }
            RunEvent::Exit => {
                // Final non-blocking safety net: whatever path reached here,
                // the host process tree must not outlive the shell.
                app.state::<HostState>().force_app_exit();
            }
            _ => {}
        });
}

/// Guards for packaging configuration, which has no compiler behind it.
#[cfg(test)]
mod packaging_tests {
    use serde_json::Value;

    fn conf(name: &str) -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(name);
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|err| panic!("cannot read {}: {err}", path.display()));
        serde_json::from_str(&text)
            .unwrap_or_else(|err| panic!("{} is not valid JSON: {err}", path.display()))
    }

    fn at(conf: &Value, path: &[&str]) -> Option<Value> {
        let mut current = conf;
        for key in path {
            current = current.get(key)?;
        }
        Some(current.clone())
    }

    /// Resolve a config key the way Tauri does: the platform config is
    /// **deep-merged over** the base one, so a key the override omits does not
    /// mean "unset" — it means "inherit the base value".
    ///
    /// This distinction is the whole point of these guards. Reading the
    /// override file in isolation would happily pass when the override has
    /// been deleted, which is precisely the failure they exist to catch.
    fn effective(base: &Value, android: &Value, path: &[&str]) -> Option<Value> {
        at(android, path).or_else(|| at(base, path))
    }

    /// The desktop bundle ships the host sidecar; the effective Android config
    /// must keep it disabled.
    ///
    /// This is load-bearing and reads as redundant, so it needs saying why:
    /// the sidecar artifact is named per Rust target triple
    /// (`binaries/host-<triple>[.exe]`), and `tauri-build` copies whatever
    /// `externalBin` lists **for every target with no desktop/mobile gate**.
    /// Verified against tauri-build 2.6.3: `copy_binaries` is called
    /// unconditionally from `try_build`, and that crate contains no
    /// `cfg(desktop)` at all. A non-empty `externalBin` on Android therefore
    /// makes the build reach for `binaries/host-aarch64-linux-android`, which
    /// nothing produces — surfacing upstream as a bare `os error 2`
    /// (tauri-apps/tauri#9774, still open).
    ///
    /// So deleting the Android override does not remove redundancy; it breaks
    /// the Android build. See docs/mobile-feasibility.md.
    #[test]
    fn android_effectively_keeps_the_sidecar_disabled() {
        let base = conf("tauri.conf.json");
        let android = conf("tauri.android.conf.json");

        // The base config really does declare one, so the override is not
        // overriding nothing.
        let shipped = at(&base, &["bundle", "externalBin"])
            .and_then(|value| value.as_array().map(Vec::len))
            .unwrap_or(0);
        assert!(
            shipped > 0,
            "the desktop bundle must declare bundle.externalBin (the host sidecar)"
        );

        // Effective value after the merge: absent in the override means the
        // desktop list applies, which is the trap.
        let effective = effective(&base, &android, &["bundle", "externalBin"]);
        let listed = effective
            .as_ref()
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0);
        assert_eq!(
            listed, 0,
            "the EFFECTIVE Android bundle.externalBin must be empty: no Android host \
             artifact exists yet, and tauri-build copies externalBin for every target, so \
             a non-empty value fails the Android build with a bare ENOENT (tauri#9774). \
             Omitting the key inherits the desktop list — the override must state the \
             empty list explicitly. Read docs/mobile-feasibility.md before changing this; \
             got {effective:?}"
        );
    }

    /// The other half of the same override: Android must not run `build:host`.
    /// Resolved through the merge as well, since a deleted `build` block would
    /// otherwise silently inherit the desktop hook.
    #[test]
    fn android_does_not_build_an_unbundled_sidecar() {
        let base = conf("tauri.conf.json");
        let android = conf("tauri.android.conf.json");
        let hook = effective(&base, &android, &["build", "beforeBuildCommand"])
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_default();
        assert!(
            !hook.contains("build:host"),
            "the effective Android beforeBuildCommand must not run build:host: its product \
             is not bundled there (externalBin is empty), so the work is wasted. Got {hook:?}"
        );
    }
}
