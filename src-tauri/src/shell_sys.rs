// M1-4: shell system capability surface (hands -> host).
//
// The Rust shell registers a forward-looking set of `shell.*` RPC methods on
// the kkrpc/stdio Peer so the host (brain) can ask the shell (hands) for
// system abilities: notifications, dialogs, opener, global shortcuts, window
// control, app metadata and path resolution.
//
// Design notes:
//   - Method names are dot-namespaced (e.g. `shell.notify`); the host side
//     calls them through the kkrpc API proxy (`api.shell.notify(...)`).
//   - Handlers run on the Peer reader thread; anything blocking (dialogs)
//     uses the plugin's `blocking_*` API on purpose (M1 smoke scope).
//   - Capability set is intentionally generous now (前瞻性): more surface is
//     cheaper to ship than to retrofit. Unused handlers are still exercised
//     by the host-side type definitions, and each is a thin wrapper.

use crate::dialog_opts;
use crate::kkrpc_peer::Peer;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
#[cfg(desktop)]
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;
#[cfg(desktop)]
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

fn str_arg(args: &[Value], i: usize) -> String {
    args.get(i)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

// ⚠ KNOWN GAP — the four items below are dead code ON MOBILE, and the Android
//   build warns about them ON PURPOSE. Read this before "cleaning them up".
//
//   The only caller is `shell.deepLink.register`, whose handler sits inside the
//   `#[cfg(desktop)]` block further down (it shares that block with `autostart`).
//   On Android that block is not compiled at all, so these compile but nothing
//   calls them, and `cargo build --target aarch64-linux-android` reports:
//
//       warning: constant `MAX_SCHEME_LEN` is never used
//       warning: constant `RESERVED_SCHEMES` is never used
//       warning: function `is_scheme_char` is never used
//       warning: function `validate_deep_link_scheme` is never used
//
//   ⚠ That message is misleading in one direction and accurate in another: on
//   DESKTOP these ARE used (so the warning never fires there, and `clippy
//   -D warnings` stays clean), while on Android they genuinely have no caller.
//   It is not leftover code — it is the deep-link surface being desktop-only.
//
//   The warning is deliberately LEFT IN as the reminder, so do NOT silence it
//   with `#[allow(dead_code)]`: the day someone wires deep-link for Android,
//   these are exactly what must be reached, and a silenced warning would hide
//   that they were skipped. If this warning ever disappears without Android
//   deep-link being implemented, something was papered over — check why.

/// Longest scheme this surface accepts.
///
/// RFC 3986 sets no length limit, so the number is a deliberate choice rather
/// than a standard: the accepted string becomes a Windows registry key
/// (`Software\Classes\<scheme>`), an `x-scheme-handler/<scheme>` MIME type on
/// Linux, and a bundle URL-type entry on macOS. Every scheme in real use is far
/// shorter — the longest name in [`RESERVED_SCHEMES`] is `javascript`, at 10
/// characters — so 32 leaves a legitimate caller untouched while refusing a
/// value whose only notable property is being long.
const MAX_SCHEME_LEN: usize = 32;

/// Schemes this app must never claim.
///
/// ⚠ The last two entries are deliberate — do NOT "helpfully" remove them:
///   - `vrchat` belongs to the VRChat client itself. The project's documented
///     prior-art finding (`docs/hands-prior-art.md` §2.3) is that **no project
///     claims it**: VRCX only *forwards* `vrchat://` URLs to VRChat's own
///     launcher pipe. Claiming it here would be novel and would steal the
///     client's own links.
///   - `vrcx` is already registered by the separate VRCX application
///     (`HKCU\Software\Classes\vrcx`, `docs/hands-prior-art.md` §2.1). Two apps
///     writing the same registry key is exactly the failure this guards.
const RESERVED_SCHEMES: &[&str] = &[
    "http",
    "https",
    "file",
    "ftp",
    "mailto",
    "javascript",
    "data",
    "about",
    "vrchat",
    "vrcx",
];

/// Is `c` allowed in a scheme **after** the first character?
///
/// RFC 3986 §3.1: `scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`. The set
/// is deliberately ASCII-only, which is also what rejects `*`, `/`, `\`, `:`,
/// whitespace and control characters — none of them is a member. `*` matters
/// most: on Windows `Software\Classes\*` is the registry's wildcard class, so it
/// would claim every file type on the machine.
fn is_scheme_char(c: char) -> bool {
    matches!(c, 'a'..='z' | 'A'..='Z' | '0'..='9' | '+' | '-' | '.')
}

/// Validate a scheme name before it reaches the OS.
///
/// # Why this exists
///
/// On Windows `DeepLink::register` writes the string **straight into the
/// registry**: it creates `Software\Classes\<scheme>` plus a `DefaultIcon` and a
/// `shell\open\command` value (verified in `tauri-plugin-deep-link` 2.4.10,
/// `src/lib.rs:259-281`). That is an unvalidated, **persistent** side effect —
/// the plugin ships no unregister path on Windows — and the string arrives from
/// plugin code through the host, i.e. it is not trusted input. A caller passing
/// `"*"` would therefore claim every file type, permanently, with nothing in
/// this app able to take it back.
///
/// Returns the rejection reason; the caller puts it in the `error` field of the
/// same `{ ok: false, .. }` shape the sibling handlers use.
fn validate_deep_link_scheme(scheme: &str) -> Result<(), String> {
    if scheme.is_empty() {
        return Err("scheme is empty".to_string());
    }
    if scheme.len() > MAX_SCHEME_LEN {
        return Err(format!(
            "scheme is {} characters, the limit is {MAX_SCHEME_LEN}",
            scheme.len()
        ));
    }
    let mut chars = scheme.chars();
    let first = chars.next().expect("emptiness was checked above");
    if !first.is_ascii_alphabetic() {
        return Err(format!(
            "scheme must start with a letter (RFC 3986 §3.1), got {first:?}"
        ));
    }
    if let Some((index, bad)) = chars.enumerate().find(|(_, c)| !is_scheme_char(*c)) {
        return Err(format!(
            "scheme may only contain A-Z a-z 0-9 + - . (RFC 3986 §3.1); {bad:?} at position {}",
            index + 1
        ));
    }
    // Scheme names are case-insensitive (RFC 3986 §3.1) AND the Windows registry
    // is case-insensitive for key names, so `HTTP` lands on the very key `http`
    // uses. Comparing case-sensitively would make the reserved list bypassable.
    let lowered = scheme.to_ascii_lowercase();
    if RESERVED_SCHEMES.contains(&lowered.as_str()) {
        return Err(format!("scheme {lowered:?} is reserved"));
    }
    if lowered.starts_with("ms-") {
        return Err(format!(
            "scheme {scheme:?} is reserved (the ms- prefix is Microsoft's)"
        ));
    }
    Ok(())
}

/// Register every `shell.*` capability handler on the peer.
///
/// `app` is cloned into each closure so the reader thread can reach Tauri
/// state without borrowing the builder's handle.
pub fn register_shell_handlers(peer: &Arc<Peer>, app: AppHandle) {
    // --- notifications -----------------------------------------------------
    // shell.notify(title, body) -> bool
    peer.on(
        "shell.notify",
        handler(app.clone(), |app, args| {
            let title = str_arg(args, 0);
            let body = str_arg(args, 1);
            let result = app.notification().builder().title(title).body(body).show();
            json!(result.is_ok())
        }),
    );

    // --- dialogs -----------------------------------------------------------
    // shell.dialog.message(text, opts) -> bool (true = OK/Yes pressed)
    // opts: { title?, kind?: "info"|"warning"|"error", buttons?: "ok"|"okCancel"|"yesNo"|"yesNoCancel" }
    peer.on(
        "shell.dialog.message",
        handler(app.clone(), |app, args| {
            let text = str_arg(args, 0);
            let opts = args.get(1).cloned().unwrap_or_else(|| json!({}));
            let title = dialog_opts::opt_str(&opts, "title").unwrap_or("");
            let kind = dialog_opts::message_kind(dialog_opts::opt_str(&opts, "kind"));
            let buttons = dialog_opts::message_buttons(dialog_opts::opt_str(&opts, "buttons"));
            let mut builder = app.dialog().message(text).kind(kind).buttons(buttons);
            if !title.is_empty() {
                builder = builder.title(title);
            }
            json!(builder.blocking_show())
        }),
    );

    // shell.dialog.ask(text, opts) -> "yes"|"no"|"cancel"|"ok"
    // Same options as message; returns the raw button result.
    peer.on(
        "shell.dialog.ask",
        handler(app.clone(), |app, args| {
            let text = str_arg(args, 0);
            let opts = args.get(1).cloned().unwrap_or_else(|| json!({}));
            let title = dialog_opts::opt_str(&opts, "title").unwrap_or("");
            let buttons = dialog_opts::message_buttons(dialog_opts::opt_str(&opts, "buttons"));
            let mut builder = app.dialog().message(text).buttons(buttons);
            if !title.is_empty() {
                builder = builder.title(title);
            }
            let result = builder.blocking_show_with_result();
            let label = match result {
                tauri_plugin_dialog::MessageDialogResult::Yes => "yes",
                tauri_plugin_dialog::MessageDialogResult::No => "no",
                tauri_plugin_dialog::MessageDialogResult::Ok => "ok",
                tauri_plugin_dialog::MessageDialogResult::Cancel => "cancel",
                _ => "unknown",
            };
            json!(label)
        }),
    );

    // shell.dialog.pickFile(opts) -> string | string[] | null
    // opts: { multiple?: bool, directory?: bool, save?: bool }
    peer.on(
        "shell.dialog.pickFile",
        handler(app.clone(), |app, args| {
            let opts = args.first().cloned().unwrap_or_else(|| json!({}));
            let save = dialog_opts::opt_bool(&opts, "save");
            let directory = dialog_opts::opt_bool(&opts, "directory");
            let multiple = dialog_opts::opt_bool(&opts, "multiple");
            let builder = app.dialog().file();
            // The flag precedence lives in `dialog_opts::pick_mode` (one tested
            // implementation shared with the smoke entry point).
            let picked: Option<Value> = match dialog_opts::pick_mode(save, directory, multiple) {
                dialog_opts::PickMode::Save => builder
                    .blocking_save_file()
                    .map(dialog_opts::file_path_to_json),
                // Folder picking is desktop-only: the mobile dialog plugin
                // exposes file picking but has no folder API. A folder request
                // there reports "nothing picked" rather than silently
                // degrading into a file picker (which would look like the user
                // cancelled a dialog they were never shown).
                #[cfg(desktop)]
                dialog_opts::PickMode::Folders => builder.blocking_pick_folders().map(|paths| {
                    Value::Array(
                        paths
                            .into_iter()
                            .map(dialog_opts::file_path_to_json)
                            .collect(),
                    )
                }),
                #[cfg(desktop)]
                dialog_opts::PickMode::Folder => builder
                    .blocking_pick_folder()
                    .map(dialog_opts::file_path_to_json),
                #[cfg(not(desktop))]
                dialog_opts::PickMode::Folders | dialog_opts::PickMode::Folder => None,
                dialog_opts::PickMode::Files => builder.blocking_pick_files().map(|paths| {
                    Value::Array(
                        paths
                            .into_iter()
                            .map(dialog_opts::file_path_to_json)
                            .collect(),
                    )
                }),
                dialog_opts::PickMode::File => builder
                    .blocking_pick_file()
                    .map(dialog_opts::file_path_to_json),
            };
            match picked {
                Some(v) => v,
                None => Value::Null,
            }
        }),
    );

    // --- opener ------------------------------------------------------------
    // shell.openUrl(url) -> bool
    peer.on(
        "shell.openUrl",
        handler(app.clone(), |app, args| {
            let url = str_arg(args, 0);
            json!(app.opener().open_url(url, None::<&str>).is_ok())
        }),
    );

    // shell.openPath(path) -> bool
    peer.on(
        "shell.openPath",
        handler(app.clone(), |app, args| {
            let path = str_arg(args, 0);
            json!(app.opener().open_path(path, None::<&str>).is_ok())
        }),
    );

    // shell.reveal(path) -> bool  (show file in its directory)
    peer.on(
        "shell.reveal",
        handler(app.clone(), |app, args| {
            let path = str_arg(args, 0);
            json!(app.opener().reveal_item_in_dir(path).is_ok())
        }),
    );

    // --- clipboard ---------------------------------------------------------
    // Text only through this surface on purpose. The plugin also does images and
    // HTML, but the brain's use is user IDs / instance links / avatar URLs, and a
    // narrower wire surface is a smaller thing to keep honest. Adding image
    // transfer here would also mean deciding an encoding for the wire (the same
    // question as `hands`, and we already have a streaming answer there).
    //
    // ⚠ Each of these needs its permission listed in `capabilities/default.json`;
    // the plugin's default set enables nothing, so a missing entry surfaces as a
    // runtime permission error, not a compile error.
    peer.on(
        "shell.clipboard.writeText",
        handler(app.clone(), |app, args| {
            json!(app.clipboard().write_text(str_arg(args, 0)).is_ok())
        }),
    );
    // shell.clipboard.readText() -> string | null
    // `null` (not an empty string) when there is nothing to read or the read
    // failed: "" is a legitimate clipboard value, so the two must not collapse.
    peer.on(
        "shell.clipboard.readText",
        handler(app.clone(), |app, _args| {
            match app.clipboard().read_text() {
                Ok(text) => json!(text),
                Err(err) => {
                    eprintln!("[shell] clipboard read: {err}");
                    Value::Null
                }
            }
        }),
    );

    // --- os ----------------------------------------------------------------
    // Host facts. Merged into ONE reply rather than eight routes: they are read
    // together (build an environment fingerprint), every one is a cheap local
    // call, and eight round trips to assemble one object would be eight
    // opportunities for a partial read.
    peer.on(
        "shell.os.info",
        handler(app.clone(), |_app, _args| {
            json!({
                "platform": tauri_plugin_os::platform(),
                "version": tauri_plugin_os::version().to_string(),
                "family": tauri_plugin_os::family(),
                "arch": tauri_plugin_os::arch(),
                "locale": tauri_plugin_os::locale(),
                "hostname": tauri_plugin_os::hostname(),
            })
        }),
    );

    // --- autostart (desktop-only) ------------------------------------------
    // Mechanism only. Nothing here turns autostart ON at boot: whether the app
    // should launch with the system is a user decision, so the shell exposes the
    // switch and the UI owns it.
    //
    // Gated because the plugin has no mobile implementation at all — on Android
    // the route is absent, so a call gets the peer's "unknown RPC method" instead
    // of a `{ok:false}` that would imply the OS refused a request it never saw.
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt as _;

        // shell.autostart.isEnabled() -> bool
        peer.on(
            "shell.autostart.isEnabled",
            handler(app.clone(), |app, _args| {
                json!(app.autolaunch().is_enabled().unwrap_or(false))
            }),
        );
        // shell.autostart.setEnabled(enabled) -> { ok, error? }
        // A verdict object, not a bare bool: "the OS refused to register" is
        // actionable (show it), whereas `false` is indistinguishable from "the
        // user asked for off".
        peer.on(
            "shell.autostart.setEnabled",
            handler(app.clone(), |app, args| {
                let wanted = args.first().and_then(Value::as_bool).unwrap_or(false);
                let result = if wanted {
                    app.autolaunch().enable()
                } else {
                    app.autolaunch().disable()
                };
                match result {
                    Ok(()) => json!({ "ok": true }),
                    Err(err) => {
                        eprintln!("[shell] autostart set {wanted}: {err}");
                        json!({ "ok": false, "error": err.to_string() })
                    }
                }
            }),
        );

        // --- deep link ------------------------------------------------------
        // shell.deepLink.register(scheme) -> { ok, error? }
        // Runtime registration works on Windows/Linux only; on macOS the scheme
        // must be declared in tauri.conf.json. Reported rather than swallowed:
        // a scheme that silently failed to register is indistinguishable from a
        // link nobody clicked.
        //
        // ⚠ The scheme is validated before it reaches the OS: the upstream
        // Windows path writes it into the registry as a new class (see
        // `validate_deep_link_scheme`), so a bad value here is a persistent
        // machine-wide change, not a failed call. A rejected scheme never
        // touches the plugin.
        //
        // ⚠ `scheme` IS PRESENT ON ALL THREE PATHS, and its meaning is "the value
        // you asked to register" — NOT "what the OS now routes".
        //
        // A first version omitted it on the validation-rejection path, reasoning
        // that an unregistered value beside `ok: false` would be misleading. The
        // asymmetric SHAPE was the worse problem: a caller reading
        // `result.scheme` would get the value on success and on plugin failure but
        // `undefined` on rejection, so every error handler would have to know
        // which failure it was looking at to read its own input back. Presence is
        // now uniform and `ok` carries the outcome.
        peer.on(
            "shell.deepLink.register",
            handler(app.clone(), |app, args| {
                let scheme = str_arg(args, 0);
                if let Err(reason) = validate_deep_link_scheme(&scheme) {
                    eprintln!("[shell] deep-link register {scheme:?}: {reason}");
                    // No `scheme` is registered — `ok: false` says so.
                    return json!({ "ok": false, "scheme": scheme, "error": reason });
                }
                match app.deep_link().register(scheme.clone()) {
                    Ok(()) => json!({ "ok": true, "scheme": scheme }),
                    Err(err) => {
                        eprintln!("[shell] deep-link register {scheme}: {err}");
                        json!({ "ok": false, "scheme": scheme, "error": err.to_string() })
                    }
                }
            }),
        );
        // shell.deepLink.isRegistered(scheme) -> bool
        peer.on(
            "shell.deepLink.isRegistered",
            handler(app.clone(), |app, args| {
                let scheme = str_arg(args, 0);
                json!(app.deep_link().is_registered(scheme).unwrap_or(false))
            }),
        );
    }

    // --- global shortcuts --------------------------------------------------
    // Desktop-only: there is no OS-wide hotkey facility on mobile, and the
    // plugin does not expose its types there. The routes are not registered at
    // all, so a call gets the peer's standard "no such method" reply instead of
    // a `{ok:false}` that implies the chord was parsed and merely refused.
    #[cfg(desktop)]
    {
        // shell.shortcut.register(accelerator) -> ShortcutRegistration
        // Accelerator strings follow the plugin syntax, e.g. "CommandOrControl+Shift+N".
        //
        // The reply carries the CANONICAL spelling (`shift+control+KeyN`) so the
        // caller can match the `shortcut.pressed` events it will receive without
        // re-implementing accelerator parsing: chord identity has exactly one
        // implementation (the plugin's parser, via crate::shortcut).
        peer.on(
            "shell.shortcut.register",
            handler(app.clone(), |app, args| {
                let accel = str_arg(args, 0);
                let registration = match crate::shortcut::parse_accelerator(&accel) {
                    Ok(shortcut) => crate::shortcut::register_with_os(app, shortcut),
                    Err(err) => crate::shortcut::ShortcutRegistration::rejected(err),
                };
                serde_json::to_value(registration)
                    .unwrap_or_else(|err| json!({ "ok": false, "error": err.to_string() }))
            }),
        );

        // shell.shortcut.unregister(accelerator) -> ShortcutRegistration
        peer.on(
            "shell.shortcut.unregister",
            handler(app.clone(), |app, args| {
                let accel = str_arg(args, 0);
                let registration = match crate::shortcut::parse_accelerator(&accel) {
                    Ok(shortcut) => crate::shortcut::unregister_with_os(app, shortcut),
                    Err(err) => crate::shortcut::ShortcutRegistration::rejected(err),
                };
                serde_json::to_value(registration)
                    .unwrap_or_else(|err| json!({ "ok": false, "error": err.to_string() }))
            }),
        );

        // shell.shortcut.isRegistered(accelerator) -> bool
        peer.on(
            "shell.shortcut.isRegistered",
            handler(app.clone(), |app, args| {
                let accel = str_arg(args, 0);
                match accel.parse::<tauri_plugin_global_shortcut::Shortcut>() {
                    Ok(shortcut) => json!(app.global_shortcut().is_registered(shortcut)),
                    Err(_) => json!(false),
                }
            }),
        );
    }

    // --- window control (main webview window) ------------------------------
    // shell.window.show() / hide() / minimize() / maximize() / unmaximize()
    // / focus() / close() -> bool
    //
    // `minimize`/`maximize`/`unmaximize` are desktop-only: the mobile webview
    // window API has no such operations. They are left out of the route list
    // there rather than matched to a no-op, so the peer reports an unknown
    // method instead of returning `true` for a window nothing happened to.
    #[cfg(desktop)]
    const WINDOW_ACTIONS: &[&str] = &[
        "show",
        "hide",
        "minimize",
        "maximize",
        "unmaximize",
        "focus",
        "close",
    ];
    #[cfg(not(desktop))]
    const WINDOW_ACTIONS: &[&str] = &["show", "hide", "focus", "close"];

    for action in WINDOW_ACTIONS {
        let method = format!("shell.window.{action}");
        let app = app.clone();
        peer.on(
            &method,
            Arc::new(move |_args: Vec<Value>| {
                let Some(win) = app.get_webview_window("main") else {
                    return json!(false);
                };
                let result = match *action {
                    "show" => win.show(),
                    "hide" => win.hide(),
                    #[cfg(desktop)]
                    "minimize" => win.minimize(),
                    #[cfg(desktop)]
                    "maximize" => win.maximize(),
                    #[cfg(desktop)]
                    "unmaximize" => win.unmaximize(),
                    "focus" => win.set_focus(),
                    "close" => win.close(),
                    _ => Ok(()),
                };
                json!(result.is_ok())
            }),
        );
    }

    // --- app metadata ------------------------------------------------------
    // shell.app.info() -> { name, version, identifier }
    peer.on(
        "shell.app.info",
        handler(app.clone(), |app, _args| {
            let config = app.config();
            json!({
                "name": config.product_name.clone(),
                "version": config.version.clone(),
                "identifier": config.identifier.clone(),
            })
        }),
    );

    // shell.app.exit(code?) -> never returns (app quits)
    peer.on(
        "shell.app.exit",
        handler(app.clone(), |app, args| {
            let code = args.first().and_then(Value::as_u64).unwrap_or(0) as i32;
            app.exit(code);
            json!(true)
        }),
    );

    // --- paths -------------------------------------------------------------
    // shell.path.dir() -> { config, data, cache, temp, home }
    peer.on(
        "shell.path.dir",
        handler(app.clone(), |app, _args| {
            let path = app.path();
            let get = |f: &dyn Fn(
                &tauri::path::PathResolver<tauri::Wry>,
            ) -> Result<std::path::PathBuf, tauri::Error>| {
                f(path)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default()
            };
            json!({
                "config": get(&|p| p.app_config_dir()),
                "data": get(&|p| p.app_data_dir()),
                "cache": get(&|p| p.app_cache_dir()),
                "temp": get(&|p| p.temp_dir()),
                "home": get(&|p| p.home_dir()),
            })
        }),
    );

    // shell.path.resolve(kind) -> string
    // kind: "config"|"data"|"cache"|"temp"|"home"
    peer.on(
        "shell.path.resolve",
        handler(app.clone(), |app, args| {
            let kind = str_arg(args, 0);
            let path = app.path();
            let resolved = match kind.as_str() {
                "config" => path.app_config_dir(),
                "data" => path.app_data_dir(),
                "cache" => path.app_cache_dir(),
                "temp" => path.temp_dir(),
                "home" => path.home_dir(),
                _ => return json!(""),
            };
            json!(resolved
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default())
        }),
    );

    // shell.devWatchEvent(event) -> bool
    // #11 wiring: the host relays dev-watch state (reload results, config
    // refresh, restart-required) to the face by calling this method; the shell
    // re-emits it as a Tauri `dev-watch` event for the webview. The payload is
    // a #11-owned plain JSON object (never a #7 lifecycle DTO). Fire-and-forget
    // on the host side, so an absent handler (tests / no UI) is harmless.
    peer.on(
        "shell.devWatchEvent",
        handler(app.clone(), |app, args| {
            let payload = args.first().cloned().unwrap_or_else(|| json!({}));
            match app.emit("dev-watch", payload) {
                Ok(()) => json!(true),
                Err(err) => {
                    eprintln!("[shell] emit dev-watch: {err}");
                    json!(false)
                }
            }
        }),
    );

    // shell.tray.setSnapshot(snapshot) -> { ok, revision, error? }
    // The only ingress for host/plugin-owned declarative tray groups. The
    // snapshot is validated against the JSON Schema and the domain model before
    // it is cached; core groups are rejected (Rust-owned). The reply is
    // synchronous so the host knows whether its menu was accepted.
    //
    // Desktop-only: a declarative tray snapshot has no meaning where there is
    // no tray, so the route is absent rather than accepting and discarding it.
    #[cfg(desktop)]
    peer.on(
        "shell.tray.setSnapshot",
        handler(app.clone(), |app, args| {
            let payload = args.first().cloned().unwrap_or_else(|| json!({}));
            let verdict = crate::tray::apply_host_snapshot(app, payload);
            serde_json::to_value(verdict).unwrap_or_else(
                |err| json!({ "ok": false, "revision": 0, "error": err.to_string() }),
            )
        }),
    );
}

/// Helper to build a handler closure that clones the app handle.
fn handler<F>(app: AppHandle, f: F) -> crate::kkrpc_peer::Handler
where
    F: Fn(&AppHandle, &[Value]) -> Value + Send + Sync + 'static,
{
    Arc::new(move |args: Vec<Value>| f(&app, &args))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole point of the gate: `*` is the Windows registry wildcard class
    /// (`Software\Classes\*`), so registering it claims every file type — and
    /// the upstream Windows path has no unregister. It must never get through.
    #[test]
    fn wildcard_scheme_is_rejected() {
        let err = validate_deep_link_scheme("*").expect_err("* must be rejected");
        assert!(
            err.contains('*'),
            "the reason should name the bad character: {err}"
        );
    }

    #[test]
    fn empty_scheme_is_rejected() {
        // Note this is the shape a missing argument takes: `str_arg` yields `""`.
        assert!(validate_deep_link_scheme("").is_err());
    }

    #[test]
    fn whitespace_and_control_characters_are_rejected() {
        // Every one of these is outside RFC 3986's scheme character set, and a
        // whitespace-bearing name is also an invalid registry key / MIME type.
        for input in [
            "my scheme",
            "my\tscheme",
            "my\nscheme",
            " scheme",
            "scheme ",
            "a\u{7}b",
        ] {
            assert!(
                validate_deep_link_scheme(input).is_err(),
                "{input:?} must be rejected"
            );
        }
    }

    #[test]
    fn separators_and_scheme_delimiters_are_rejected() {
        // `:` and `/` are the ones a caller is most likely to pass by accident,
        // having copied a full `scheme://` URL instead of a bare scheme name.
        for input in ["a:b", "a/b", "a\\b", "a?b", "a#b", "a_b", "%2e"] {
            assert!(
                validate_deep_link_scheme(input).is_err(),
                "{input:?} must be rejected"
            );
        }
    }

    #[test]
    fn a_scheme_must_start_with_a_letter() {
        // RFC 3986 §3.1: `ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`. A leading
        // digit or sign is not a scheme, however plausible it looks.
        for input in ["1vrcxk", "-vrcxk", "+vrcxk", ".vrcxk", "3"] {
            assert!(
                validate_deep_link_scheme(input).is_err(),
                "{input:?} must be rejected"
            );
        }
    }

    #[test]
    fn an_over_long_scheme_is_rejected() {
        let too_long = format!("v{}", "a".repeat(MAX_SCHEME_LEN));
        assert!(too_long.len() > MAX_SCHEME_LEN);
        assert!(validate_deep_link_scheme(&too_long).is_err());
        // The boundary itself is inclusive: a scheme of exactly the cap is fine,
        // so the check can never be "one shorter than documented".
        let at_limit = format!("v{}", "a".repeat(MAX_SCHEME_LEN - 1));
        assert_eq!(at_limit.len(), MAX_SCHEME_LEN);
        assert!(validate_deep_link_scheme(&at_limit).is_ok());
    }

    #[test]
    fn well_known_schemes_are_rejected() {
        for input in [
            "http",
            "https",
            "file",
            "ftp",
            "mailto",
            "javascript",
            "data",
            "about",
        ] {
            assert!(
                validate_deep_link_scheme(input).is_err(),
                "{input} must be rejected as reserved"
            );
        }
    }

    #[test]
    fn the_ms_prefix_is_rejected_case_insensitively() {
        // The registry is case-insensitive for key names, so `MS-SETTINGS` and
        // `ms-settings` are the same class. A case-sensitive check would leave
        // an obvious bypass.
        for input in [
            "ms-settings",
            "ms-windows-store",
            "MS-SETTINGS",
            "Ms-GameBar",
        ] {
            assert!(
                validate_deep_link_scheme(input).is_err(),
                "{input} must be rejected"
            );
        }
        // And the prefix alone, with no suffix, is still Microsoft's namespace.
        assert!(validate_deep_link_scheme("ms-").is_err());
    }

    #[test]
    fn reserved_names_are_rejected_case_insensitively() {
        // `VRCX://` is spelled the same key as `vrcx://` on Windows, and URL
        // schemes are case-insensitive per RFC 3986 §3.1.
        for input in ["HTTP", "Http", "VRCX", "VRChat", "JAVASCRIPT"] {
            assert!(
                validate_deep_link_scheme(input).is_err(),
                "{input} must be rejected"
            );
        }
    }

    /// ⚠ These two are a deliberate product decision, not an oversight — see the
    /// `RESERVED_SCHEMES` comment (`vrchat` belongs to the VRChat client and no
    /// project claims it; `vrcx` is already registered by the VRCX app, and two
    /// apps on one registry key is the failure being avoided). This test exists
    /// so removing either name from the list is a test failure with a reason
    /// attached, rather than a silent regression.
    #[test]
    fn the_two_project_specific_reservations_stay_reserved() {
        assert!(validate_deep_link_scheme("vrchat").is_err());
        assert!(validate_deep_link_scheme("vrcx").is_err());
        assert!(RESERVED_SCHEMES.contains(&"vrchat"));
        assert!(RESERVED_SCHEMES.contains(&"vrcx"));
    }

    #[test]
    fn a_plausible_project_scheme_passes() {
        // The positive case, so the gate cannot pass by rejecting everything.
        // These are spellings a caller could reasonably ask for; none is claimed
        // by the project yet (no scheme is declared in tauri.conf.json).
        for input in ["vrcxk", "vrcx-k", "vrcx.k", "x1", "MyApp+1"] {
            assert!(
                validate_deep_link_scheme(input).is_ok(),
                "{input} must be accepted, got {:?}",
                validate_deep_link_scheme(input)
            );
        }
    }
}
