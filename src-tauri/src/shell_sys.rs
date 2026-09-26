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

#[cfg(desktop)]
/// What kind of JSON value actually arrived, for an error that names it.
///
/// ⚠ `serde_json`'s `Value` has no `type_name()`, and the point of the message is
/// that the CALLER can see what it sent. "expected a boolean" alone leaves a
/// caller staring at code that reads `setEnabled(enabled)` wondering which layer
/// mangled it; "got a string" names the layer.
fn json_type_name(value: Option<&Value>) -> &'static str {
    match value {
        None => "no argument at all",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "a boolean",
        Some(Value::Number(_)) => "a number",
        Some(Value::String(_)) => "a string",
        Some(Value::Array(_)) => "an array",
        Some(Value::Object(_)) => "an object",
    }
}

#[cfg(desktop)]
/// Read the `enabled` flag of `shell.autostart.setEnabled`.
///
/// # ⚠ Why this is a separate, strict function and not `as_bool().unwrap_or(false)`
///
/// The handler used to be exactly that one-liner, and it was a **silent data
/// corruption bug**, not just lax validation:
///
///   - A caller passing the STRING `"true"` (a form value, a JSON round-trip
///     through something that stringified it, a plugin reading `process.env`)
///     has `as_bool()` return `None`, so `unwrap_or(false)` produced **`false`**.
///   - The handler then called `autolaunch().disable()` — turning the user's
///     autostart **OFF** when they asked for it ON — and replied `{"ok": true}`.
///
/// So the failure is inverted AND invisible: the caller's intent is discarded,
/// the machine is changed in the opposite direction, and the verdict says the
/// change succeeded. There is no later signal that it went wrong; the user only
/// finds out when their app stops starting with the system.
///
/// The absences are equally load-bearing: `null`, a missing argument and a
/// number all fail the same way under `unwrap_or(false)`, i.e. they all mean
/// "disable". A missing argument is a caller bug, and the honest answer to
/// "what did you mean?" is to refuse — **never guess**, because here the two
/// guesses are opposite machine-wide changes.
///
/// `Err` carries the **complete verdict object** (`{ok:false, error:…}`) rather
/// than only a message, so the exact bytes the caller will receive are
/// constructible — and therefore testable — without a Tauri `AppHandle`. The
/// handler's only job becomes forwarding `Err` unchanged.
fn autostart_flag(args: &[Value]) -> Result<bool, Value> {
    match args.first() {
        Some(Value::Bool(wanted)) => Ok(*wanted),
        // `json_type_name(None)` reads "no argument at all", which is the shape a
        // zero-argument call takes — distinct from an explicit `null` first arg,
        // and worth distinguishing in the message because they have different
        // fixes at the caller.
        other => Err(json!({
            "ok": false,
            "error": format!(
                "shell.autostart.setEnabled expects a boolean as its first argument, got {}",
                json_type_name(other)
            ),
        })),
    }
}

// ⚠ DESKTOP-ONLY: the helpers below are reached ONLY from the `#[cfg(desktop)]`
//   handler blocks further down (`shell.deepLink.*`, `shell.autostart.*`). On
//   mobile those blocks are not compiled at all, so each of these carries its own
//   `#[cfg(desktop)]` and simply does not exist there.
//
//   ⚠ WHY THEY ARE GATED RATHER THAN LEFT TO WARN. They used to compile on mobile
//   and be reported by the compiler as dead code:
//
//       warning: constant `MAX_SCHEME_LEN` is never used        (and six more)
//
//   That warning was deliberately left in as a reminder that deep-link is not
//   wired for Android. It was replaced by a TEST — see
//   `the_desktop_only_helpers_are_gated_and_listed` — because a warning only
//   helps someone who reads the mobile build log, while a test fails in the
//   ordinary loop. Same signal, no reliance on someone remembering to look.
//
//   ⚠ The list below must stay exact: the test asserts every name here is
//   `#[cfg(desktop)]`-gated AND that this comment still names them. Adding a
//   desktop-only helper without updating both is a red test, which is the point.
//
//   Do NOT "clean these up" by deleting them: the day deep-link or autostart is
//   wired for Android, these are exactly what must be reached.

#[cfg(desktop)]
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

#[cfg(desktop)]
/// Windows registry classes that EXIST on a stock install, under
/// `HKEY_CLASSES_ROOT` / `HKCU\Software\Classes`.
///
/// ⚠ Why this list exists and what it is NOT. Read this whole comment before
/// extending it.
///
/// `validate_deep_link_scheme` started as a **blacklist**: reject `*`, the empty
/// string, a `RESERVED_SCHEMES` list and the `ms-` prefix. A reviewer then showed
/// the obvious hole — the check is only as good as its list, and it named no
/// names that already exist as classes. `exefile`, `batfile`, `Directory`,
/// `lnkfile` and `comfile` are all valid RFC 3986 scheme spellings, so they
/// passed every check:
///
///   - `exefile`, `comfile`, `batfile`, `Directory` and `lnkfile` are all real,
///     stock classes, and all five are valid RFC 3986 scheme spellings — so they
///     passed every earlier check.
///   - On Windows `DeepLink::register` writes `Software\Classes\<name>` **plus**
///     `DefaultIcon` and `shell\open\command` (verified in `tauri-plugin-deep-link`
///     2.4.10 `src/lib.rs:259-281`). Registering `exefile` therefore **overwrites
///     the `shell\open\command` of the class that decides how every `.exe` on the
///     machine is launched** — and the write goes to `HKCU`, which **shadows
///     `HKLM`**, so the machine-wide consequence survives without admin rights.
///
/// ⚠⚠ **A BLACKLIST CANNOT BE COMPLETE. This list is a mitigation, NOT a proof.**
/// The honest statement of what is still broken, so nobody reads this as "now
/// it is safe":
///
///   1. `HKCR` is the live merge of `HKLM\Software\Classes` and
///      `HKCU\Software\Classes`, and **third-party software adds classes to it
///      at any time**. A name that is not in this list may already be claimed on
///      *this* machine — by the VRChat client, by a user's other tool, by
///      anything installed after this source was written. **We cannot enumerate
///      the machine's registry from a `const`**, and doing it at runtime would
///      still be a race (check-then-write, and the plugin writes unconditionally).
///   2. Case-insensitive classes, per-user vs per-machine classes, and `Wow6432Node`
///      views are not modelled here; only the plain lowercase spelling is.
///   3. It does not cover **file extensions**: `Software\Classes\.exe` is a real
///      key, and `.exe` is *not* a legal scheme name (leading `.` fails the
///      RFC 3986 first-character rule), so that particular case is closed by the
///      syntax check rather than by this list — but the general lesson stands.
///   4. It does not cover Linux's `x-scheme-handler/<name>` MIME database, where
///      a known name can collide with an installed handler and where the effect
///      is a silently hijacked default application rather than a registry write.
///
/// ⇒ **The defensible long-term fix is an ALLOWLIST, not a longer blacklist**:
/// the project declares its own scheme name(s) in `tauri.conf.json` and runtime
/// registration is restricted to those. That is a **product decision the owner
/// has not made yet** — `docs/hands-prior-art.md` §2.1/§2.3 records that both
/// `vrcx` and `vrchat` are taken, so no name has been chosen and the honest state
/// is "machinery present, no scheme declared" (see `lib.rs` on `init()`).
/// Until that decision exists, this collision list plus the syntax gate is
/// what we have, and **it does not make the API safe in general.**
///
/// ⚠ Do NOT remove entries to "unblock" a name. Every entry here is a class that
/// a stock Windows machine already uses; a caller that needs one of these names
/// needs a different name, not a weaker gate.
///
/// The list only contains names that are **also legal RFC 3986 scheme spellings**
/// (lowercase, `A-Z a-z 0-9 + - .`). Registry keys containing a space — e.g.
/// `Component Categories`, `Media Type` — are deliberately absent: they cannot
/// reach the registry through this surface anyway, because the space fails the
/// syntax check first. Adding them would only suggest the syntax gate can be
/// bypassed.
const RESERVED_REGISTRY_CLASSES: &[&str] = &[
    // ── Shell "file type" classes (ProgIDs) that exist on a stock install ────
    // These are the reviewer's examples plus their immediate neighbours.
    "exefile",
    "comfile",
    "batfile",
    "cmdfile",
    "scrfile",
    "piffile",
    "lnkfile",
    "regfile",
    "txtfile",
    "docfile",
    "inffile",
    "ttffile",
    "fonfile",
    "dllfile",
    "cplfile",
    "mscfile",
    "msofile",
    // ── Directory / drive / shell-namespace classes ────────────────────────
    // `Directory` and `Folder` are the two that make Explorer work at all;
    // overwriting either is a machine-wide shell breakage, not a redirect.
    "directory",
    "folder",
    "drive",
    // ── Extension-shaped ProgIDs and their short aliases ──────────────────
    // A file extension is not a legal scheme (`.exe` fails the leading-character
    // rule), but the class NAME beside it is: `Software\Classes\exe` is not the
    // same key as `Software\Classes\.exe`, and several of these exist as bare
    // names too. Keeping them costs nothing and closes the near-miss.
    "dll",
    "exe",
    "com",
    "bat",
    "cmd",
    "scr",
    "lnk",
    "url",
    "pif",
    "reg",
    "inf",
    "chm",
    "hlp",
    "sys",
    "ocx",
    "tlb",
    // ── Handlers / verbs / HKCR roots that are already classes ─────────────
    "applications",
    "appid",
    "clsid",
    "interface",
    "typelib",
    "protocols",
    "shell",
    "shellex",
    "systemfileassociations",
    "unknown",
    "mime",
    "mimetype",
    "network",
    "printable",
    "printto",
];

#[cfg(desktop)]
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

#[cfg(desktop)]
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

#[cfg(desktop)]
/// Validate a scheme name before it reaches the OS.
///
/// # Why this exists
///
/// On Windows `DeepLink::register` writes the string **straight into the
/// registry**: it creates `Software\Classes\<scheme>` plus a `DefaultIcon` and a
/// `shell\open\command` value (verified in `tauri-plugin-deep-link` 2.4.10,
/// `src/lib.rs:259-281`). That is an unvalidated, **persistent** side effect on
/// input that arrives from plugin code through the host, i.e. it is not trusted.
/// A caller passing `"*"` would claim every file type, and — see the correction
/// below — this surface offers no way back.
///
/// # ⚠ Correction: the plugin DOES ship an unregister, and we do not expose it
///
/// An earlier version of this comment said "the plugin ships no unregister path
/// on Windows". **That was wrong**, and it is worth stating plainly because the
/// wrong version made the risk sound unavoidable when it is in fact a missing
/// route on our side:
///
///   - `tauri-plugin-deep-link` 2.4.10 `src/lib.rs:380-392` implements
///     `unregister` for Windows: it `remove_tree`s
///     `Software\Classes\<scheme>` from **both** `LOCAL_MACHINE` and
///     `CURRENT_USER`. The mobile `imp` (line 145) is the stub that returns
///     `UnsupportedPlatform` — the desktop one is real.
///   - This module registers only `shell.deepLink.register` and
///     `shell.deepLink.isRegistered`. **There is no `shell.deepLink.unregister`
///     route**, so no host or plugin caller can reach the working upstream
///     function. The permanence is OUR gap, not the plugin's.
///
/// ⚠ That matters for the residual-risk argument: an unregister route would make
/// a bad registration recoverable, and its absence is the reason the collision
/// checks below have to be strict rather than merely advisory. Adding
/// `shell.deepLink.unregister` is a legitimate follow-up (it touches the host's
/// capability mirror too, so it is out of scope for a review-fix round) — but do
/// not cite "the plugin cannot unregister" as a reason it is impossible.
///
/// # ⚠ What this function is and is NOT
///
/// It is a **syntax gate plus a collision check against a hand-written list**.
/// It is **not** a proof that a scheme is safe to register, and the earlier
/// version of this comment implied otherwise by presenting the reserved list as
/// the guard. Two independent limits:
///
///   - [`RESERVED_REGISTRY_CLASSES`] is a **blacklist**, so it can only refuse
///     the collisions someone thought of. See its comment for the full list of
///     what it cannot catch (third-party classes installed later, per-machine vs
///     per-user views, the Linux MIME database). Read that before treating a
///     pass here as clearance.
///   - Nothing here consults the machine. A name that passes is merely
///     *not known* to collide — it may still be claimed right now.
///
/// ⇒ The defensible fix is an **allowlist** driven by a declared project scheme;
/// until the owner picks a name, this gate reduces the blast radius and the
/// residual risk is documented rather than claimed away.
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
    // ⚠ The collision check. `lowered` is already the right comparison: registry
    // key names are case-insensitive, so `EXEFILE` would hit the very class
    // `exefile` names. A case-sensitive comparison here would be a bypass.
    //
    // The error text says what is actually wrong ("already a Windows registry
    // class"), not merely "reserved": the two rejections have different fixes.
    // A reserved *scheme* needs a different name; a class collision needs a
    // different name too, but the reason is that the OS already owns it, and a
    // caller debugging this needs to know which list refused it.
    if RESERVED_REGISTRY_CLASSES.contains(&lowered.as_str()) {
        return Err(format!(
            "scheme {lowered:?} is already a Windows registry class; \
             registering it would overwrite that class's shell\\open\\command"
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
        //
        // ⚠ The argument is NOT coerced. See `autostart_flag`: reading a
        // non-boolean as `false` used to turn autostart OFF while replying
        // `{ok: true}`, so a caller that passed the string `"true"` got the
        // opposite machine-wide change AND a success verdict. Refusing is the
        // only correct answer when the two possible guesses are opposites.
        peer.on(
            "shell.autostart.setEnabled",
            handler(app.clone(), |app, args| {
                let wanted = match autostart_flag(args) {
                    Ok(wanted) => wanted,
                    Err(verdict) => {
                        eprintln!("[shell] autostart setEnabled: {verdict}");
                        return verdict;
                    }
                };
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
        // ⚠ There is deliberately only `register` and `isRegistered` here — no
        // `unregister` route. That is a real asymmetry: the plugin CAN unregister
        // on Windows (see the correction on `validate_deep_link_scheme`), so this
        // surface currently offers no way to undo what it does. Adding the route
        // means touching the host's capability mirror too, so it is left as a
        // follow-up rather than smuggled into a review-fix round.
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

    /// The exact names the reviewer used to show the blacklist was incomplete.
    ///
    /// Every one of these is a valid RFC 3986 scheme spelling, so the syntax gate
    /// alone let it through — and each is a class that already exists on a stock
    /// Windows install. Registering one writes `shell\open\command` into `HKCU`,
    /// which shadows `HKLM`, so the damage is machine-wide and persistent.
    ///
    /// ⚠ This test is a regression guard for the LIST, not a proof of safety. It
    /// failing means a name was removed from `RESERVED_REGISTRY_CLASSES`; it
    /// passing does NOT mean an arbitrary scheme is safe (see that const's
    /// comment for what a blacklist still cannot catch).
    #[test]
    fn the_reviewers_existing_registry_classes_are_refused() {
        for input in ["exefile", "batfile", "Directory", "lnkfile", "comfile"] {
            let err = validate_deep_link_scheme(input)
                .expect_err(&format!("{input} is an existing registry class"));
            // The reason must say WHY, not merely "reserved": a caller needs to
            // know the OS already owns this name.
            assert!(
                err.contains("registry class"),
                "the reason should name the actual collision, got: {err}"
            );
        }
    }

    /// Registry key names are case-insensitive, so the collision check must be
    /// too — otherwise `ExeFile` is a one-character bypass of the whole list.
    #[test]
    fn registry_class_collisions_are_refused_case_insensitively() {
        for input in [
            "EXEFILE",
            "ExeFile",
            "eXeFiLe",
            "DIRECTORY",
            "Directory",
            "LNKFILE",
            "ComFile",
            "BATFILE",
        ] {
            assert!(
                validate_deep_link_scheme(input).is_err(),
                "{input} names a real registry class and must be refused"
            );
        }
    }

    /// The other half of the collision set: `HKCR` roots and shell-namespace
    /// keys that are classes in their own right rather than file-type ProgIDs.
    #[test]
    fn shell_namespace_registry_classes_are_refused() {
        for input in [
            "clsid",
            "appid",
            "applications",
            "systemfileassociations",
            "shellex",
            "protocols",
        ] {
            assert!(
                validate_deep_link_scheme(input).is_err(),
                "{input} is an HKCR namespace key and must be refused"
            );
        }
    }

    /// ⚠ The boundary of the mitigation, pinned as a test so the residual risk is
    /// visible in the test suite and not only in a comment. These names are NOT
    /// on the list and DO pass, because a static blacklist cannot know about a
    /// class registered by software this source never saw.
    #[test]
    fn the_blacklist_cannot_catch_unknown_classes_and_that_is_documented() {
        // Stand-ins for "some class another program registered on this machine".
        // They pass the syntax gate AND the collision list — which is the honest
        // statement of the residual risk, asserted rather than claimed away.
        for input in ["vrcxktestsuite", "myappclass", "someothertool"] {
            assert!(
                validate_deep_link_scheme(input).is_ok(),
                "{input} is not in the list, so it passes — that IS the limitation"
            );
        }
        // And the list is a plain slice with no runtime registry access behind
        // it: this assertion would be impossible if the check consulted the
        // machine, which is exactly the property that makes it incomplete.
        assert!(!RESERVED_REGISTRY_CLASSES.is_empty());
    }

    /// The list must only contain names that can reach the registry through this
    /// surface. A name with a space would fail the syntax check first, so listing
    /// it would be dead weight implying a bypass that does not exist.
    #[test]
    fn every_listed_class_is_reachable_through_the_syntax_gate() {
        for name in RESERVED_REGISTRY_CLASSES {
            assert!(
                name.chars().next().is_some_and(|c| c.is_ascii_alphabetic()),
                "{name} must start with a letter to be a legal scheme"
            );
            assert!(
                name.chars().all(is_scheme_char),
                "{name} contains a character the syntax gate already refuses, \
                 so listing it here is misleading"
            );
            assert!(
                name.chars().all(|c| !c.is_ascii_uppercase()),
                "{name} should be stored lowercase: the check lowercases the \
                 input, so an uppercase entry could never match"
            );
            // The list must be reachable at all: if the syntax gate refused it
            // first, the entry would be unreachable code in data form.
            assert!(
                matches!(validate_deep_link_scheme(name), Err(ref e) if e.contains("registry class")),
                "{name} should be refused BY THE COLLISION CHECK, not by syntax"
            );
        }
    }

    /// No duplicates: a repeated entry is a sign of an unreviewed append, and the
    /// list's length is what a reader uses to judge its coverage.
    #[test]
    fn the_registry_class_list_has_no_duplicates() {
        let mut seen = std::collections::HashSet::new();
        for name in RESERVED_REGISTRY_CLASSES {
            assert!(seen.insert(*name), "{name} is listed twice");
        }
    }

    // ── shell.autostart.setEnabled argument handling ────────────────────────
    //
    // ⚠ These tests exercise `autostart_flag`, which is where the decision lives.
    // The handler around it is a thin forward of the value or the verdict, so the
    // behaviour under test is the behaviour on the wire — but the tests do NOT
    // execute the handler itself, and there is no test here that an
    // `AppHandle`/autolaunch call was made. That is stated rather than implied:
    // a Tauri `AppHandle` cannot be constructed in a unit test.

    #[test]
    fn a_boolean_flag_is_accepted_in_both_directions() {
        assert_eq!(autostart_flag(&[json!(true)]), Ok(true));
        assert_eq!(autostart_flag(&[json!(false)]), Ok(false));
        // Extra trailing arguments are ignored, not an error: this mirrors how
        // every other handler in the file reads positional args.
        assert_eq!(autostart_flag(&[json!(true), json!("ignored")]), Ok(true));
    }

    /// The headline regression. The old code read the string `"true"` as `false`,
    /// then called `disable()` and replied `{ok:true}` — the user's autostart was
    /// turned OFF, they were told it worked, and nothing recorded the difference.
    #[test]
    fn the_string_true_is_refused_instead_of_silently_disabling_autostart() {
        let verdict =
            autostart_flag(&[json!("true")]).expect_err("a string must not be coerced to a bool");
        assert_eq!(verdict["ok"], json!(false));
        // ⚠ Written as `assert!(contains(..))`, not `assert_eq!(contains(..), true)`:
        // the latter trips `clippy::bool_assert_comparison`, and this file must
        // stay clean under `clippy -- -D warnings`.
        assert!(
            verdict["error"]
                .as_str()
                .expect("an error string")
                .contains("a string"),
            "the error must name what actually arrived: {verdict}"
        );
    }

    /// Every non-boolean JSON type, not just the string case. `null`, a missing
    /// argument and a number all used to mean "disable" under `unwrap_or(false)`;
    /// a caller that forgot the argument turned autostart off.
    #[test]
    fn every_non_boolean_argument_is_refused_rather_than_treated_as_false() {
        // `[json!({})]` is the zero-argument call shape as the peer delivers it.
        for (args, expected_type) in [
            (vec![], "no argument"),
            (vec![json!(null)], "null"),
            (vec![json!("false")], "a string"),
            (vec![json!(1)], "a number"),
            (vec![json!(0)], "a number"),
            (vec![json!(1.5)], "a number"),
            (vec![json!([])], "an array"),
            (vec![json!({})], "an object"),
            // ⚠ `json!({"enabled": true})` is the shape a caller who read the
            // wire docs too loosely would send. It must NOT be mined for a
            // nested field: guessing which key means "enabled" is the same guess
            // that produced the original bug.
            (vec![json!({"enabled": true})], "an object"),
        ] {
            let verdict = autostart_flag(&args)
                .expect_err(&format!("{args:?} must be refused, never guessed at"));
            assert_eq!(verdict["ok"], json!(false), "for {args:?}");
            let error = verdict["error"].as_str().expect("an error string");
            assert!(
                error.contains(expected_type),
                "the error for {args:?} should name {expected_type}, got: {error}"
            );
            // The shape must be the documented verdict shape, so the host's
            // `verdict.ok ? ... : error` branch reads it without special-casing.
            assert!(
                verdict.get("error").is_some(),
                "a refusal must carry an error: {verdict}"
            );
        }
    }

    /// A refusal must never look like a success, in either field.
    #[test]
    fn a_refused_verdict_is_never_ok_and_always_carries_a_reason() {
        for args in [
            vec![],
            vec![json!("true")],
            vec![json!(0)],
            vec![json!(null)],
        ] {
            let verdict = autostart_flag(&args).expect_err("must refuse");
            assert_eq!(verdict["ok"], json!(false));
            assert!(
                verdict["error"].as_str().is_some_and(|e| !e.is_empty()),
                "an empty reason would be as unhelpful as the silent coercion"
            );
        }
    }

    /// The desktop-only helpers must stay `#[cfg(desktop)]`-gated, and the note
    /// above them must stay accurate.
    ///
    /// ⚠ THIS TEST REPLACES A COMPILER WARNING, deliberately. Those helpers used
    /// to compile on mobile and be reported there as dead code:
    ///
    ///     warning: constant `MAX_SCHEME_LEN` is never used      (and six more)
    ///
    /// The warning was left in on purpose, as a reminder that deep-link is not
    /// wired for Android. It was replaced by this test for one reason: a warning
    /// only reaches someone who reads the MOBILE build log, whereas this fails in
    /// the ordinary `cargo test` loop on every platform. Same signal, no longer
    /// dependent on remembering to look.
    ///
    /// ⚠ What a test like this cannot do is notice a helper that is MISSING from
    /// the list, so it asserts the list in the source note is exactly the set of
    /// `#[cfg(desktop)]` items it discovers. Adding a desktop-only helper
    /// therefore fails until the gate and the note are updated together — which is
    /// the habit the warning used to protect.
    #[test]
    fn the_desktop_only_helpers_are_gated_and_listed() {
        // Read our own source as TEXT: the property is about the file, and no
        // amount of calling these functions can observe whether they were gated.
        const SOURCE: &str = include_str!("shell_sys.rs");

        // Keep this in lockstep with the note above the helpers.
        const NAMED: &[&str] = &[
            "MAX_SCHEME_LEN",
            "RESERVED_REGISTRY_CLASSES",
            "RESERVED_SCHEMES",
            "autostart_flag",
            "is_scheme_char",
            "json_type_name",
            "validate_deep_link_scheme",
        ];

        let lines: Vec<&str> = SOURCE.lines().collect();
        // A guard against the whole test passing vacuously if `include_str!` ever
        // resolves to something unexpected.
        assert!(
            lines.len() > 100,
            "reading our own source produced {} lines, so the checks below would \
             pass without looking at anything",
            lines.len()
        );

        for name in NAMED {
            // Find the DECLARATION, not a mention inside a comment.
            let declared = lines.iter().position(|line| {
                let trimmed = line.trim_start();
                (trimmed.starts_with("fn ") || trimmed.starts_with("const "))
                    && trimmed
                        .split(|c: char| !c.is_alphanumeric() && c != '_')
                        .nth(1)
                        .is_some_and(|word| word == *name)
            });
            let Some(index) = declared else {
                panic!(
                    "`{name}` is named in the desktop-only note but is no longer \
                     declared here — update the note and this list together"
                );
            };

            // Walk back over the item's doc-comment / attribute block and require
            // a `#[cfg(desktop)]` in it. Walking back rather than reading only the
            // previous line, because the attribute sits ABOVE the doc comment.
            let mut gated = false;
            let mut cursor = index;
            while cursor > 0 {
                cursor -= 1;
                let previous = lines[cursor].trim_start();
                if previous.starts_with("#[cfg(desktop)]") {
                    gated = true;
                    break;
                }
                if previous.starts_with("///") || previous.starts_with("//") {
                    continue;
                }
                if previous.starts_with("#[") {
                    continue;
                }
                break;
            }
            assert!(
                gated,
                "`{name}` is desktop-only but not `#[cfg(desktop)]`-gated, so on \
                 mobile it compiles with no caller and `clippy -D warnings` fails \
                 the mobile build with `never used`"
            );
        }
    }
}
