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
//   ⚠ The deep-link gate added for issue #41 is desktop-only for the same reason:
//   `declared_schemes`, `declared_schemes_of`, `registration_verdict` and
//   `claim_of` are reached ONLY from the `shell.deepLink.register` /
//   `shell.deepLink.unregister` handlers in the desktop block. (`command_owner_matches`
//   is additionally `target_os = "windows"`-gated, so it is deliberately NOT in the
//   list — the list covers `#[cfg(desktop)]` items that exist on every desktop.)
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

#[cfg(desktop)]
/// Who currently owns the OS handler entry for `scheme`.
///
/// ⚠ This type exists because "is the scheme already registered?" is the **wrong
/// question** for a write path. `DeepLinkExt::is_registered` answers that yes/no, and on
/// Windows a third-party class key carrying our requested name is "registered" too —
/// registering over it **overwrites its `shell\open\command` with no way back** (see
/// `RESERVED_REGISTRY_CLASSES`: `unregister` is a `remove_tree`, not a restore). So the
/// probe distinguishes three cases and the verdict refuses the third.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SchemeClaim {
    /// Nothing is registered under this name — nothing to collide with.
    Absent,
    /// Something is registered **and it is this very executable**: re-registering is a
    /// no-op and removing it is our own undo.
    Ours,
    /// Something is registered and we cannot show it is ours; the string is what the OS
    /// reports as the current handler, so the error text can name it.
    Foreign(String),
}

#[cfg(desktop)]
/// The schemes declared by `plugins.deep-link.desktop` in `tauri.conf.json`.
///
/// # ⚠ Why this is read rather than written down here
///
/// The declared name lives in the config (that is what the bundler turns into
/// `CFBundleURLTypes` / `Software\Classes\<scheme>`). A `const` list in Rust would be a
/// **second copy** of it, and the drift between the two is invisible: the installer would
/// register one name while the runtime gate allowed another. So the runtime gate reads the
/// same value the bundler reads.
///
/// Both shapes the upstream CLI accepts are handled — a single protocol object, or a list
/// of them (`DesktopDeepLinks::One | List` in `tauri-cli/src/interface/rust.rs`). Names are
/// lowercased and de-duplicated because URL schemes and registry key names are both
/// case-insensitive.
pub fn declared_schemes(plugin_config: Option<&Value>) -> Vec<String> {
    let Some(desktop) = plugin_config.and_then(|config| config.get("desktop")) else {
        return Vec::new();
    };
    let entries: Vec<&Value> = match desktop {
        Value::Array(items) => items.iter().collect(),
        single => vec![single],
    };
    let mut schemes: Vec<String> = Vec::new();
    for entry in entries {
        let Some(list) = entry.get("schemes").and_then(Value::as_array) else {
            continue;
        };
        for scheme in list.iter().filter_map(Value::as_str) {
            let lowered = scheme.to_ascii_lowercase();
            if !lowered.is_empty() && !schemes.contains(&lowered) {
                schemes.push(lowered);
            }
        }
    }
    schemes
}

#[cfg(desktop)]
/// This build's declared schemes, read from its own config.
fn declared_schemes_of(app: &AppHandle) -> Vec<String> {
    declared_schemes(app.config().plugins.0.get("deep-link"))
}

#[cfg(desktop)]
/// The **one** gate both `register` and `unregister` pass through.
///
/// Refuses, in order:
///
/// 1. a syntactically illegal or reserved name ([`validate_deep_link_scheme`]);
/// 2. a name this build does **not declare** — the owner's decision (issue #41 §7.1 item 2)
///    is that runtime registration is limited to the declared allowlist, so the blacklist
///    in (1) is a floor, not the gate;
/// 3. an existing handler we cannot show is ours ([`SchemeClaim::Foreign`]).
///
/// ⚠ (3) is not a formality. It is the only thing standing between a plugin-visible
/// capability and "this machine's `Software\Classes\<name>` now points at us, and no
/// recorded value can bring it back".
pub fn registration_verdict(
    scheme: &str,
    declared: &[String],
    claim: &SchemeClaim,
) -> Result<(), String> {
    validate_deep_link_scheme(scheme)?;
    let lowered = scheme.to_ascii_lowercase();
    if !declared.iter().any(|name| name == &lowered) {
        return Err(format!(
            "scheme {lowered:?} is not declared in tauri.conf.json \
             (plugins.deep-link.desktop.schemes); runtime registration is limited to the \
             declared names"
        ));
    }
    if let SchemeClaim::Foreign(owner) = claim {
        return Err(format!(
            "scheme {lowered:?} is already handled by something this app does not own \
             ({owner}); refusing to overwrite it — an existing class key cannot be restored"
        ));
    }
    Ok(())
}

#[cfg(all(desktop, target_os = "windows"))]
/// The executable path a `shell\open\command` line names, as far as it can be read.
///
/// Quoted is the shape both writers produce (`"<exe>" "%1"`), so the quoted branch is the
/// one that matters in practice. An **unquoted** command is ambiguous by construction on
/// Windows, because an installed path contains spaces — [`command_owner_matches`] therefore
/// also accepts a whole-path prefix rather than trusting this function alone.
fn command_executable(command: &str) -> &str {
    let trimmed = command.trim();
    match trimmed.strip_prefix('"') {
        Some(rest) => rest.split('"').next().unwrap_or(""),
        None => trimmed.split_whitespace().next().unwrap_or(""),
    }
}

#[cfg(all(desktop, target_os = "windows"))]
/// Does `command` — a `shell\open\command` DEFAULT value — launch `exe`?
///
/// Case-insensitive, like the registry's own comparison of key names.
fn command_owner_matches(command: &str, exe: &std::path::Path) -> bool {
    let exe = exe.to_string_lossy();
    if exe.is_empty() {
        return false;
    }
    if command_executable(command).eq_ignore_ascii_case(&exe) {
        return true;
    }
    // An unquoted command whose path contains spaces (`C:\Program Files\…\vrcx-k.exe "%1"`)
    // is what a human hand-editing the key would leave behind. The whole trimmed string is
    // compared against the path plus a BOUNDARY — without that boundary check,
    // `…\vrcx-k.exe.old` would count as ours, which is exactly the mistake that would let a
    // stale entry be overwritten in place of a foreign one.
    let lowered = command.trim().to_ascii_lowercase();
    match lowered.strip_prefix(&exe.to_ascii_lowercase()) {
        Some(rest) => matches!(
            rest.chars().next(),
            None | Some(' ') | Some('\t') | Some('"')
        ),
        None => false,
    }
}

#[cfg(all(desktop, target_os = "windows"))]
/// The Windows ownership probe, without a Tauri handle.
///
/// Split out from [`claim_of`] so the **real-registry** test can call it: a unit test
/// cannot build an `AppHandle`, and the whole point of that test is that it runs against
/// the actual registry rather than a mock.
fn claim_from_registry(scheme: &str) -> SchemeClaim {
    // ⚠ ERROR_FILE_NOT_FOUND is the ONLY error that means "nothing is there". Treating any
    // error as "absent" would turn an unreadable key (permissions, a damaged hive) into
    // permission to overwrite it — the exact failure this check exists to stop.
    const ERROR_FILE_NOT_FOUND: i32 = 0x8007_0002u32 as i32;
    let path = format!("Software\\Classes\\{scheme}\\shell\\open\\command");
    match windows_registry::CURRENT_USER.open(&path) {
        Ok(key) => match key.get_string("") {
            Ok(command) => {
                let exe = std::env::current_exe().unwrap_or_default();
                if command_owner_matches(&command, &exe) {
                    SchemeClaim::Ours
                } else {
                    SchemeClaim::Foreign(command)
                }
            }
            Err(err) => SchemeClaim::Foreign(format!("unreadable command value: {err}")),
        },
        Err(err) if err.code().0 == ERROR_FILE_NOT_FOUND => SchemeClaim::Absent,
        Err(err) => SchemeClaim::Foreign(format!("unreadable key: {err}")),
    }
}

#[cfg(desktop)]
/// What is registered under `scheme` right now, on this platform.
///
/// ⚠ The **Windows** branch reads the registry; every other desktop reports an existing
/// registration as foreign, because none of them exposes a way to tell *whose* it is.
/// That is the safe direction on purpose: on Linux the name this build would register is
/// the one its own installer already claimed (`x-scheme-handler/vrcxk`), so refusing costs
/// a redundant runtime call and buys the guarantee that we never overwrite a foreign
/// handler. macOS cannot register at runtime at all.
fn claim_of(app: &AppHandle, scheme: &str) -> SchemeClaim {
    #[cfg(target_os = "windows")]
    {
        // The registry is the whole story on Windows; no Tauri API is involved.
        let _ = app;
        claim_from_registry(scheme)
    }
    #[cfg(not(target_os = "windows"))]
    {
        match app.deep_link().is_registered(scheme) {
            Ok(false) => SchemeClaim::Absent,
            Ok(true) => SchemeClaim::Foreign(
                "an existing handler (this platform cannot report whose it is)".to_string(),
            ),
            Err(err) => SchemeClaim::Foreign(format!("unreadable registration state: {err}")),
        }
    }
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
        // ⚠ TWO GATES before the OS is touched, and both are load-bearing:
        //
        //   1. `validate_deep_link_scheme` — syntax plus the reserved-name/class lists.
        //      Run FIRST because it is pure: a caller sending `*` must not even cause a
        //      registry read.
        //   2. `registration_verdict` — AFTER the platform ownership probe, i.e. after
        //      I/O. It enforces the declared allowlist AND refuses to overwrite a handler
        //      this app does not own (issue #41 §7.1 item 2; see its doc comment).
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
                let declared = declared_schemes_of(app);
                let claim = claim_of(app, &scheme);
                if let Err(reason) = registration_verdict(&scheme, &declared, &claim) {
                    eprintln!("[shell] deep-link register {scheme:?}: {reason}");
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
        // shell.deepLink.unregister(scheme) -> { ok, scheme, removed, error? }
        //
        // The undo issue #41 §7.1 item 2 asked for, with the shape that decision settled:
        // reachable from the HOST (and therefore the UI), **not** from plugins — the
        // capability mirror in `capability.ts` deliberately does not list it — and bounded
        // to the declared names by the same `registration_verdict` the write path uses.
        //
        // ⚠ It will NOT remove a foreign handler, and that is the point: upstream
        // `unregister` is a `remove_tree`, so removing a key we did not write would delete
        // somebody else's class key outright. An absent handler answers
        // `ok: true, removed: false` — idempotent, because "make sure this is not
        // registered" is a legitimate thing to ask twice.
        //
        // ⚠ Platform note (upstream docs, 2.4.10): Linux can only unregister a scheme that
        // was registered through `register` in the first place, and macOS/Android/iOS
        // return `UnsupportedPlatform`. The error is forwarded rather than swallowed, so a
        // caller learns which of those it hit.
        peer.on(
            "shell.deepLink.unregister",
            handler(app.clone(), |app, args| {
                let scheme = str_arg(args, 0);
                if let Err(reason) = validate_deep_link_scheme(&scheme) {
                    eprintln!("[shell] deep-link unregister {scheme:?}: {reason}");
                    return json!({
                        "ok": false,
                        "scheme": scheme,
                        "removed": false,
                        "error": reason
                    });
                }
                let declared = declared_schemes_of(app);
                let claim = claim_of(app, &scheme);
                if let Err(reason) = registration_verdict(&scheme, &declared, &claim) {
                    eprintln!("[shell] deep-link unregister {scheme:?}: {reason}");
                    return json!({
                        "ok": false,
                        "scheme": scheme,
                        "removed": false,
                        "error": reason
                    });
                }
                if let SchemeClaim::Absent = claim {
                    return json!({ "ok": true, "scheme": scheme, "removed": false });
                }
                match app.deep_link().unregister(scheme.clone()) {
                    Ok(()) => json!({ "ok": true, "scheme": scheme, "removed": true }),
                    Err(err) => {
                        eprintln!("[shell] deep-link unregister {scheme}: {err}");
                        json!({
                            "ok": false,
                            "scheme": scheme,
                            "removed": false,
                            "error": err.to_string()
                        })
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
    /// ⚠ A test like this must check BOTH directions, and for a while this one did not.
    /// Walking only NAMED → gated leaves an unlisted helper invisible: the list could rot
    /// silently while the test stayed green — the exact "single source of truth" failure
    /// it exists to prevent. It now also walks gated → NAMED, so adding a desktop-only
    /// helper fails until the gate and the note are updated together.
    ///
    /// ⚠ Two traps in that reverse walk, both hit while writing it:
    ///   1. **`#[cfg(desktop)]` is not the same as desktop-only.** An item defined TWICE —
    ///      once under `#[cfg(desktop)]` and once under `#[cfg(not(desktop))]` — exists on
    ///      mobile too, so it must NOT be required in NAMED (e.g. `WINDOW_ACTIONS`, whose
    ///      mobile variant is a shorter list). The first version accused it.
    ///   2. **Only `fn`/`const` count as helpers.** `#[cfg(desktop)] use tauri_plugin_deep_link::…`
    ///      is an import; the first version accused it too.
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
            "claim_of",
            "declared_schemes",
            "declared_schemes_of",
            "is_scheme_char",
            "json_type_name",
            "registration_verdict",
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
            //
            // ⚠ The optional visibility prefix is load-bearing: a desktop-only helper that
            // must be reachable from another module in this crate (e.g. `declared_schemes`,
            // which the packaging test calls) is `pub fn`, and an earlier version of this
            // walk only accepted a bare `fn`/`const`. It then reported a *correct* entry as
            // "no longer declared here", which is the worst kind of red: it punishes the
            // right answer.
            let declared = lines.iter().position(|line| {
                let trimmed = line.trim_start();
                let declaration = trimmed
                    .strip_prefix("pub(crate) ")
                    .or_else(|| trimmed.strip_prefix("pub "))
                    .unwrap_or(trimmed);
                (declaration.starts_with("fn ") || declaration.starts_with("const "))
                    && declaration
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

        // ⚠ THE REVERSE DIRECTION, which the doc-comment above claimed but the test did
        // not implement. Everything above walks NAMED → gated, so a `#[cfg(desktop)]`
        // item that was never added to NAMED was invisible: the list could rot silently
        // while the test stayed green. That is precisely the "single source of truth"
        // failure this test exists to prevent.
        //
        // This walks gated → NAMED: every desktop-ONLY item must appear in NAMED.
        //
        // ⚠ "desktop-only" is not the same as "carries #[cfg(desktop)]". An item defined
        // TWICE — once under `#[cfg(desktop)]` and once under `#[cfg(not(desktop))]` —
        // exists on mobile too (e.g. `WINDOW_ACTIONS`, whose mobile variant is a shorter
        // list), so it is legitimately absent from NAMED. The first version of this check
        // missed that distinction and accused `WINDOW_ACTIONS` of being unlisted; that was
        // a bug in the check, not a gap in the list.
        /// The item name declared immediately after the first attribute at `start`,
        /// skipping further attributes and doc comments. `None` when the attribute gates
        /// something that is not a `fn`/`const` (a `use` import, a `mod`, …).
        ///
        /// ⚠ The `fn`/`const` restriction matters: `#[cfg(desktop)] use tauri_plugin_deep_link::…`
        /// is an IMPORT, not a desktop-only helper, and an earlier version of this walk
        /// accused it of being unlisted.
        fn item_after(lines: &[&str], start: usize) -> Option<String> {
            for candidate in lines.iter().skip(start + 1) {
                let trimmed = candidate.trim_start();
                if trimmed.starts_with("#[") || trimmed.starts_with("//") || trimmed.is_empty() {
                    continue;
                }
                if !(trimmed.starts_with("fn ") || trimmed.starts_with("const ")) {
                    return None;
                }
                return trimmed
                    .split(|c: char| !c.is_alphanumeric() && c != '_')
                    .nth(1)
                    .map(str::to_string);
            }
            None
        }

        let mut gated_names: Vec<String> = Vec::new();
        for (index, line) in lines.iter().enumerate() {
            if line.trim_start().starts_with("#[cfg(desktop)]") {
                if let Some(name) = item_after(&lines, index) {
                    gated_names.push(name);
                }
            }
        }

        // Every name that has its OWN `#[cfg(not(desktop))]` definition — those items
        // exist on mobile too, so they are not desktop-only and must not be required here.
        let mut mobile_names: Vec<String> = Vec::new();
        for (index, line) in lines.iter().enumerate() {
            if line.trim_start().starts_with("#[cfg(not(desktop))]") {
                if let Some(name) = item_after(&lines, index) {
                    mobile_names.push(name);
                }
            }
        }

        // Anti-vacuous: if the walk found nothing, the assertions below would pass for
        // the wrong reason (an empty set is trivially consistent).
        assert!(
            !gated_names.is_empty(),
            "no `#[cfg(desktop)]` items were discovered, so the reverse check would \
             pass without looking at anything — the walk above is broken"
        );

        for name in &gated_names {
            // An item defined both ways is not desktop-only: `WINDOW_ACTIONS` has a
            // shorter mobile variant, so it legitimately stays out of NAMED.
            if mobile_names.contains(name) {
                continue;
            }
            assert!(
                NAMED.contains(&name.as_str()),
                "`{name}` is desktop-only (`#[cfg(desktop)]` with no mobile counterpart) but \
                 is MISSING from the NAMED list above. That list is meant to be the complete \
                 set of desktop-only helpers, so add it (and the note) together."
            );
        }
    }

    // ── the declared-scheme allowlist (issue #41 §7.1 item 1/2) ──────────────
    //
    // These exercise the pure reader, because the alternative — trusting that a
    // hand-written `const` in Rust matches the config — is exactly the silent drift the
    // runtime read exists to remove.

    #[test]
    fn declared_schemes_reads_the_object_shape() {
        let config = json!({ "desktop": { "schemes": ["vrcxk", "VRCXK-App"] } });
        assert_eq!(
            declared_schemes(Some(&config)),
            vec!["vrcxk".to_string(), "vrcxk-app".to_string()],
            "names must be lowercased (registry keys and URL schemes are case-insensitive) \
             and de-duplicated"
        );
    }

    #[test]
    fn declared_schemes_reads_the_list_shape() {
        // `DesktopDeepLinks::List` — the second shape the upstream CLI accepts.
        let config = json!({
            "desktop": [{ "schemes": ["vrcxk"] }, { "schemes": ["other"] }]
        });
        assert_eq!(
            declared_schemes(Some(&config)),
            vec!["vrcxk".to_string(), "other".to_string()]
        );
    }

    #[test]
    fn declared_schemes_is_empty_when_nothing_is_declared() {
        // The state this repo was in before issue #41: no `schemes` key at all. It must
        // read as "nothing is declared", NOT as "everything is allowed" — the allowlist is
        // the gate, so an empty list has to refuse every name.
        assert!(declared_schemes(None).is_empty());
        assert!(declared_schemes(Some(&json!({}))).is_empty());
        assert!(declared_schemes(Some(&json!({ "desktop": {} }))).is_empty());
        assert!(declared_schemes(Some(&json!({ "desktop": { "schemes": [] } }))).is_empty());
        // A mobile-only declaration is not a desktop one.
        assert!(
            declared_schemes(Some(&json!({ "mobile": [{ "host": "example.com" }] }))).is_empty()
        );
    }

    #[test]
    fn the_verdict_requires_a_declared_name() {
        let declared = vec!["vrcxk".to_string()];
        // Declared + nothing registered ⇒ allowed (the ordinary cold install).
        assert_eq!(
            registration_verdict("vrcxk", &declared, &SchemeClaim::Absent),
            Ok(())
        );
        // Declared + already ours ⇒ allowed (re-registering is a no-op).
        assert_eq!(
            registration_verdict("vrcxk", &declared, &SchemeClaim::Ours),
            Ok(())
        );
        // Case-insensitive, like the registry itself.
        assert_eq!(
            registration_verdict("VRCXK", &declared, &SchemeClaim::Absent),
            Ok(())
        );
        // NOT declared ⇒ refused, even though it is a perfectly legal scheme name.
        // ⚠ NOT `vrcx`: that one is refused by the RESERVED list before the allowlist ever
        // runs, so it would prove nothing about this gate. The example must be a name that
        // passes `validate_deep_link_scheme` and is nonetheless undeclared.
        let refusal = registration_verdict("someotherscheme", &declared, &SchemeClaim::Absent)
            .expect_err("an undeclared name must be refused");
        assert!(
            refusal.contains("not declared"),
            "the refusal must say the name is not declared, got: {refusal}"
        );
    }

    /// The acceptance criterion of issue #41: claiming an **existing** class key is
    /// refused. This is the logic half; the real-registry half is below (Windows only).
    #[test]
    fn an_existing_foreign_handler_is_refused_even_when_the_name_is_declared() {
        let declared = vec!["vrcxk".to_string()];
        let claim = SchemeClaim::Foreign("\"C:\\Other\\app.exe\" \"%1\"".to_string());
        let refusal = registration_verdict("vrcxk", &declared, &claim)
            .expect_err("a foreign handler must be refused");
        assert!(
            refusal.contains("does not own"),
            "the refusal must name the reason (not ours), got: {refusal}"
        );
        assert!(
            refusal.contains("cannot be restored"),
            "the refusal must say why it is permanent, got: {refusal}"
        );
        assert!(
            refusal.contains("C:\\Other\\app.exe"),
            "the refusal must quote the current handler so the caller can see whose it is, \
             got: {refusal}"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn command_ownership_matches_the_first_token_only() {
        let exe = std::path::Path::new(r"C:\Program Files\vrcx-k\vrcx-k.exe");
        for command in [
            // What the Tauri installer and the plugin both write.
            r#""C:\Program Files\vrcx-k\vrcx-k.exe" "%1""#,
            r#""C:\Program Files\vrcx-k\vrcx-k.exe""#,
            // A hand-edited UNQUOTED command whose path contains spaces. `command_executable`
            // cannot see past the first space here, which is why the whole-path prefix
            // branch exists.
            r#"C:\Program Files\vrcx-k\vrcx-k.exe "%1""#,
            // The registry is case-insensitive for this comparison too.
            r#""c:\program files\VRCX-K\VRCX-K.EXE" "%1""#,
        ] {
            assert!(
                command_owner_matches(command, exe),
                "{command:?} launches our executable and must count as ours"
            );
        }
        for command in [
            r#""C:\Other\app.exe" "%1""#,
            r#""C:\Program Files\vrcx-k\vrcx-k-helper.exe" "%1""#,
            // ⚠ The boundary case the whole-path branch would get wrong without its check:
            // a NEIGHBOUR of our own executable, whose path starts with ours.
            r#""C:\Program Files\vrcx-k\vrcx-k.exe.old" "%1""#,
            r#"C:\Program Files\vrcx-k\vrcx-k.exe.old "%1""#,
            "",
        ] {
            assert!(
                !command_owner_matches(command, exe),
                "{command:?} does not launch our executable and must count as foreign"
            );
        }
    }

    /// ⚠ **The real-registry half of the acceptance criterion** — not a mock.
    ///
    /// It writes a throwaway class key under `HKCU` whose `shell\open\command` belongs to
    /// another app, then asserts that (a) the probe reports it as foreign, (b) the verdict
    /// refuses, and (c) **the key is still exactly as it was** — because "refused" is only
    /// worth anything if nothing was written. It never calls the plugin's `register`, so it
    /// cannot leave a real scheme registration behind.
    ///
    /// # ⚠ Why the fixture can come from the environment
    ///
    /// Some environments let this process **read** the registry but not **write** it (a
    /// restricted token — measured on this project's dev machine, where the harness denies
    /// `RegCreateKeyEx` to descendants while the user itself can write `HKCU`). Refusing to
    /// run there would throw away the coverage that matters most: the *read* path being
    /// asserted against a real hive. So a pre-created fixture can be pointed at with
    /// `VRCXK_DEEPLINK_FOREIGN_FIXTURE=<scheme>`; the assertions are identical, only the
    /// fixture's provenance changes, and the test never deletes a key it did not create.
    #[cfg(target_os = "windows")]
    #[test]
    fn a_real_existing_class_key_is_left_untouched_by_a_refused_registration() {
        use windows_registry::CURRENT_USER;

        const ACCESS_DENIED: i32 = 0x8007_0005u32 as i32;
        const FIXTURE_ENV: &str = "VRCXK_DEEPLINK_FOREIGN_FIXTURE";
        let foreign = "\"C:\\Program Files\\SomeOtherApp\\other.exe\" \"%1\"";

        let fixture = std::env::var(FIXTURE_ENV)
            .ok()
            .filter(|name| !name.is_empty());
        // Unique per process: two `cargo test` runs must not fight over one key.
        let scheme = fixture
            .clone()
            .unwrap_or_else(|| format!("vrcxktest{}", std::process::id()));
        let class_key = format!("Software\\Classes\\{scheme}");
        let command_key = format!("{class_key}\\shell\\open\\command");

        let mut created_here = false;
        if fixture.is_none() {
            // A pre-existing key owned by somebody else.
            match CURRENT_USER.create(&command_key) {
                Ok(key) => {
                    key.set_string("", foreign)
                        .expect("write the foreign command");
                    created_here = true;
                }
                Err(err) if err.code().0 == ACCESS_DENIED => {
                    // ⚠ Loud, and it says what was NOT verified. A silent skip here would
                    // read as coverage that does not exist.
                    eprintln!(
                        "\n⚠ SKIPPED — nothing was verified: this process may read the \
                         registry but not write it, so the fixture cannot be created.\n  \
                         Either run with {FIXTURE_ENV}=<scheme> after creating \
                         HKCU\\{class_key}\\shell\\open\\command yourself, or run under an \
                         unrestricted token (CI's windows-latest runner is one).\n"
                    );
                    return;
                }
                Err(err) => panic!("create the throwaway class key: {err}"),
            }
        }

        let claim = claim_from_registry(&scheme);
        assert_eq!(
            claim,
            SchemeClaim::Foreign(foreign.to_string()),
            "a key whose command points at another executable must read as foreign \
             (fixture {FIXTURE_ENV}={scheme})"
        );

        let declared = vec![scheme.clone()];
        let refusal = registration_verdict(&scheme, &declared, &claim)
            .expect_err("registering over an existing foreign class key must be refused");
        assert!(refusal.contains("does not own"), "got: {refusal}");

        // ⚠ The assertion that makes the refusal meaningful: the key is unchanged.
        let readback = CURRENT_USER
            .open(&command_key)
            .expect("the key must still exist after a refused registration")
            .get_string("")
            .expect("the command value must still be readable");
        assert_eq!(
            readback, foreign,
            "a refused registration must not have touched the existing value"
        );

        if created_here {
            // No key at all ⇒ Absent, so the ordinary path is still open.
            CURRENT_USER
                .remove_tree(&class_key)
                .expect("remove the throwaway class key");
            assert_eq!(
                claim_from_registry(&scheme),
                SchemeClaim::Absent,
                "after cleanup the probe must report the name as free again"
            );
        }
    }
}
