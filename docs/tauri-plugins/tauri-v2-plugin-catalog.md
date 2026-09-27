# Tauri v2 Official Plugin Catalog — Exhaustive Report

Source: `https://v2.tauri.app/plugin/` (index) + one page per plugin.
Fetched 2026 (site footer shows "Last updated: Jul 22, 2026" on the index).

**Important provenance note.** The plugin pages render their platform matrix as
**SVG icons whose meaning lives in `title` tooltips** — the text of the page never
contains "full/partial/none". Reading the rendered page (dokobot *and* `web_fetch`)
therefore yields platform *names* with **empty** Level/Notes columns, which is
unusable. I recovered the authoritative values from the generator the docs site
itself uses:

* `src/components/plugins/_tableContent.json` is **gitignored** (generated).
* `packages/compatibility-table/build.ts` generates it by reading every
  `plugins/<name>/Cargo.toml` in `tauri-apps/plugins-workspace` and copying
  `[package.metadata.platforms.support]` → `{platform: {level, notes}}`.
* `develop/plugins/index.mdx` confirms: *"Plugins can declare which platforms they
  support, and to what extent, in the `[package.metadata.platforms.support]`
  section… The support table and the platform filter on the Features & Recipes
  page are generated from this metadata."*

So every ✅/❌/⚠️ and every footnote below is **the documented declaration itself**,
read from the plugin's own manifest. Where a value is inference rather than a doc
statement, it is labelled.

---

## Corrections applied after review (2026-09)

Two load-bearing claims were re-checked against this repository and the crate
source. One was **wrong for our architecture** and is corrected here; two others
were confirmed.

### Correction: the `opener` scope gap is NOT a live bug here

The report said `opener:default` omits `allow-open-path`, so `openPath()` "fails
until an explicit `{path}` scope is added", and called it a likely live bug.

**That is not the path our code takes.** Verified in this repository and in
`tauri-plugin-opener` 2.5.5:

| Entry point | Scope enforced? |
|---|---|
| `#[tauri::command]` IPC layer — `src/commands.rs` takes `CommandScope` + `GlobalScope`, calls `is_path_allowed` | **Yes** |
| Rust extension API — `app.opener().open_path(...)` / `reveal_item_in_dir(...)` in `src/lib.rs` | **No** — they delegate straight to `open::open(...)` / `reveal_items_in_dir(...)`, no scope check |

Our shell uses the **Rust** API: `src-tauri/src/shell_sys.rs` registers
`shell.openPath` / `shell.reveal` and answers with
`app.opener().open_path(path, None::<&str>)` and
`app.opener().reveal_item_in_dir(path)`.

The frontend **never** calls the opener plugin — it imports only
`@tauri-apps/api/core` and `@tauri-apps/api/event`, reaches the shell through the
kkrpc/ws channel (`src/host.ts`) plus a few core `invoke` calls. There is no
`@tauri-apps/plugin-opener` import anywhere under `src/`.

⇒ No permission is missing and `openPath` works. The observation about
`opener:default` remains **true and worth knowing** — it bites the moment anyone
calls the opener from the webview — but it is a latent trap, not a live defect.

### Confirmed: `notification` has no deep-toast API

Its Windows note is limited to "only works for installed apps"; the Actions API is
mobile-only. This corroborates using `tauri-winrt-notification` for Windows-deep
toasts (hero/AUMID/buttons) instead of expecting them from the plugin.

### Confirmed: `single-instance` is registered first

`src-tauri/src/lib.rs:140` registers `tauri_plugin_single_instance::init(...)`
before `opener` / `dialog` / `notification`, satisfying the documented "must be the
first one to be registered" constraint.

---

## Table 1 — Complete plugin inventory

### 1a. Official (Tauri-maintained) plugins — 30 of 30, none omitted

All 30 are maintained in the single monorepo
[`tauri-apps/plugins-workspace`](https://github.com/tauri-apps/plugins-workspace)
under `plugins/`, and every one declares
`_This plugin requires a Rust version of at least **1.77.2**_`
(the workspace-level `rust-version`; none overrides it).

| # | Plugin | Identifier (crate / npm) | What it does (one line) | Win | macOS | Linux | Android | iOS | Official? | Extra setup needed |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Autostart | `tauri-plugin-autostart` 2.5.1 / `@tauri-apps/plugin-autostart` 2.5.1 | Automatically launch your application at system startup. | ✅ | ✅ | ✅ | ❌ | ❌ | Official | None beyond deps. Rust add is target-gated: `--target 'cfg(any(target_os = "macos", windows, target_os = "linux"))'`; `init(MacosLauncher::LaunchAgent, Some(argv))`. |
| 2 | Barcode Scanner | `tauri-plugin-barcode-scanner` 2.4.6 / `@tauri-apps/plugin-barcode-scanner` 2.4.6 | Use the camera to scan QR codes, EAN-13 and other barcodes. | ❌ | ❌ | ❌ | ✅ | ✅ | Official | iOS: `NSCameraUsageDescription` in Info.plist (`src-tauri/Info.ios.plist`). Mobile-only; UI must show a transparent element over the camera view. |
| 3 | Biometric | `tauri-plugin-biometric` 2.3.3 / `@tauri-apps/plugin-biometric` 2.3.3 | Prompt the user for biometric authentication on Android and iOS. | ❌ | ❌ | ❌ | ✅ | ✅ | Official | iOS: `NSFaceIDUsageDescription` in `src-tauri/Info.ios.plist`. Mobile-only. |
| 4 | Command Line Interface (CLI) | `tauri-plugin-cli` 2.4.1 / `@tauri-apps/plugin-cli` 2.4.1 | Parse arguments from the command line interface. | ✅ | ✅ | ✅ | ❌ | ❌ | Official | Requires a `plugins.cli` block in `tauri.conf.json` declaring `args`, `subcommands`, positional/named/flag args. |
| 5 | Clipboard | `tauri-plugin-clipboard-manager` 2.3.3 / `@tauri-apps/plugin-clipboard-manager` 2.3.3 | Read and write to the system clipboard. | ✅ | ✅ | ✅ | ⚠️[^1] | ⚠️[^1] | Official | None. Mobile is plain-text only[^1]. |
| 6 | Deep Linking | `tauri-plugin-deep-link` 2.4.10 / `@tauri-apps/plugin-deep-link` 2.4.10 | Set your Tauri application as the default handler for a URL. | ✅ | ⚠️[^3] | ✅ | ⚠️[^3] | ⚠️[^3] | Official | `plugins.deep-link.desktop.schemes` for desktop; mobile needs `assetlinks.json` (Android, HTTPS, `Content-Type: application/json`) or `apple-app-site-association` (iOS, HTTPS). Desktop runtime registration requires the `deep-link` feature on **single-instance**, and runtime schems must be re-checked via `Env::args_os`. |
| 7 | Dialog | `tauri-plugin-dialog` 2.7.3 / `@tauri-apps/plugin-dialog` 2.7.3 | Native system dialogs for opening/saving files and message dialogs. | ✅ | ✅ | ✅ | ⚠️[^2] | ⚠️[^2] | Official | None. Mobile has no folder picker[^2]. |
| 8 | File System | `tauri-plugin-fs` 2.5.2 / `@tauri-apps/plugin-fs` 2.5.2 | Access the file system. | ✅[^4] | ✅[^4] | ✅[^4] | ⚠️[^4] | ⚠️[^4] | Official | **Watch API needs the `watch` feature flag** (`features = ["watch"]`). Android external-storage permissions (`READ_/WRITE_EXTERNAL_STORAGE`) for audio/cache/documents/downloads/picture/public/video dirs. iOS `PrivacyInfo.xcprivacy` with `NSPrivacyAccessedAPICategoryFileTimestamp` / reason `C617.1`. **Permissions alone grant no path — a scope is mandatory.** `requireLiteralLeadingDot: false` for dotfiles/dotfolders. |
| 9 | Geolocation | `tauri-plugin-geolocation` 2.3.3 / `@tauri-apps/plugin-geolocation` 2.3.3 | Get and track the device's current position (altitude, heading, speed if available). | ❌ | ❌ | ❌ | ✅ | ✅ | Official | iOS: `NSLocationWhenInUseUsageDescription` in Info.plist. Android: plugin auto-adds `ACCESS_COARSE_LOCATION` + `ACCESS_FINE_LOCATION`; add `<uses-feature android:name="android.hardware.location.gps" android:required="true"/>` if GPS is mandatory. Mobile-only. |
| 10 | Global Shortcut | `tauri-plugin-global-shortcut` 2.3.2 / `@tauri-apps/plugin-global-shortcut` 2.3.2 | Register global shortcuts. | ✅ | ✅ | ✅ | ❌ | ❌ | Official | None beyond target gating: `--target 'cfg(any(target_os = "macos", windows, target_os = "linux"))'`. |
| 11 | Haptics | `tauri-plugin-haptics` 2.3.3 / `@tauri-apps/plugin-haptics` 2.3.3 | Haptic feedback and vibrations on Android and iOS. | ❌ | ❌ | ❌ | ✅ | ✅ | Official | None. Target-gated `--target 'cfg(any(target_os = "android", target_os = "ios"))'`; registered under `#[cfg(mobile)]`. |
| 12 | HTTP Client | `tauri-plugin-http` 2.7.0 / `@tauri-apps/plugin-http` 2.6.1 | Access the HTTP client written in Rust (reqwest re-export). | ✅ | ✅ | ✅ | ✅ | ✅ | Official | Capability **must** declare allowed URLs (`http:default` + `allow`/`deny` url globs), else requests are blocked. `unsafe-headers` feature flag required to send forbidden request headers. |
| 13 | Localhost | `tauri-plugin-localhost` 2.3.2 / **no JS package**[^8] | Expose your app's assets through a localhost server instead of the default custom protocol. | ✅ | ✅ | ✅ | ❌ | ❌ | Official | Rust-only. Docs carry an explicit caution: *"This plugin brings considerable security risks and you should only use it if you know what you are doing."* |
| 14 | Logging | `tauri-plugin-log` 2.9.2 / `@tauri-apps/plugin-log` 2.9.2 | Configurable logging. | ✅ | ✅ | ✅ | ✅ | ✅ | Official | Add the `log` crate to `Cargo.toml` to use the macros on the Rust side. Targets: terminal / webview console / persisted file (with rotation config), filtering, max level, target filter, formatting. |
| 15 | NFC | `tauri-plugin-nfc` 2.3.6 / `@tauri-apps/plugin-nfc` 2.3.6 | Read and write NFC tags on Android and iOS. | ❌ | ❌ | ❌ | ✅ | ✅ | Official | iOS needs three things: adjust target iOS version, `NFCReaderUsageDescription` in Info.plist, and the NFC capability on the app. Tag **filtering is Android-only** — always validate scanned tag contents. MIME types must be lowercase. Mobile-only. |
| 16 | Notifications | `tauri-plugin-notification` 2.4.0 / `@tauri-apps/plugin-notification` 2.4.0 | Send native notifications to the user. | ✅[^5] | ✅ | ✅ | ✅ | ✅ | Official | Windows caveat[^5]. Runtime permission flow (`isPermissionGranted` → `requestPermission` → `sendNotification`). Actions API is **mobile-only**. Attachments + channels (Android channels). |
| 17 | Opener | `tauri-plugin-opener` 2.5.5 / `@tauri-apps/plugin-opener` 2.5.5 | Open files and URLs in external applications; also "reveal in file explorer". | ✅ | ✅ | ✅ | ⚠️[^6] | ⚠️[^6] | Official | Scope **must** list allowed `{path}` and `{url}` globs for `openPath`/`openUrl` (`opener:allow-open-path`, `opener:allow-open-url`). Mobile can only open URLs[^6]. |
| 18 | OS Information | `tauri-plugin-os` 2.3.2 / `@tauri-apps/plugin-os` 2.3.2 | Read information about the operating system. | ✅ | ✅ | ✅ | ✅ | ✅ | Official | None. Commands: arch, exe-extension, family, hostname, locale, os-type, platform, version. |
| 19 | Persisted Scope | `tauri-plugin-persisted-scope` 2.3.8 / **no JS package**[^8] | Save filesystem and asset scopes and restore them when the app is reopened. | ✅ | ✅ | ✅ | ✅ | ✅ | Official | Rust-only. **Registration order matters:** the docs say to register `tauri_plugin_fs::init()` **before** persisted-scope (`// fs MUST BE before persisted scope!`). |
| 20 | Positioner | `tauri-plugin-positioner` 2.3.4 / `@tauri-apps/plugin-positioner` 2.3.4 | Position your windows at well-known locations. | ✅ | ✅ | ✅ | ❌ | ❌ | Official | Tray-relative positions need extra wiring: add the `tray-icon` feature to the positioner dep **and** an `on_tray_icon_event` handler calling `tauri_plugin_positioner::on_tray_event(...)`. |
| 21 | Process | `tauri-plugin-process` 2.3.1 / `@tauri-apps/plugin-process` 2.3.1 | Access the current process of your Tauri application. | ✅ | ✅ | ✅ | ❌ | ❌ | Official | None. Commands: `exit`, `restart`. |
| 22 | Shell | `tauri-plugin-shell` 2.3.6 / `@tauri-apps/plugin-shell` 2.3.6 | Access the system shell to spawn child processes. | ✅ | ✅ | ✅ | ⚠️[^7] | ⚠️[^7] | Official | Scope must enumerate **each** command with `name`, `cmd`, `args` (literal or `{"validator": "<regex>"}`) and `sidecar`. `shell.open` has moved to the **Opener** plugin. Mobile can only open URLs[^7]. |
| 23 | Single Instance | `tauri-plugin-single-instance` 2.4.5 / **no JS package**[^8] | Ensure that a single instance of your Tauri app is running at a time. | ✅ | ✅ | ✅ | ❌ | ❌ | Official | Rust-only. Docs: *"must be the first one to be registered to work well."* Rust add target-gated; registration inside `.setup()` under `#[cfg(desktop)]`. Extra section covers **Snap and Flatpak** app-ID requirements. |
| 24 | SQL | `tauri-plugin-sql` 2.4.1 / `@tauri-apps/plugin-sql` 2.4.1 | Interface for the frontend to talk to SQL databases through `sqlx`. | ✅ | ✅ | ✅ | ✅ | ✅ | Official | **You must pick an engine feature**: `sqlite`, `mysql`, or `postgres`. Migrations are declared in Rust and registered on the builder; each migration needs a unique version number. |
| 25 | Store | `tauri-plugin-store` 2.4.5 / `@tauri-apps/plugin-store` 2.4.5 | Simple, persistent key-value store. | ✅ | ✅ | ✅ | ✅ | ✅ | Official | None. Values must be `serde_json::Value`. Has `LazyStore`. Dedicated "Migrating from v1 and v2 beta/rc" section. |
| 26 | Stronghold | `tauri-plugin-stronghold` 2.3.2 / `@tauri-apps/plugin-stronghold` 2.3.2 | Store secrets and keys using the IOTA Stronghold secret-management engine. | ✅ | ✅ | ✅ | ✅ | ✅ | Official | Must initialize with a password-hash function returning **exactly 32 bytes** ("This is a Stronghold requirement"). Argon2 example given. |
| 27 | Updater | `tauri-plugin-updater` 2.12.0 / `@tauri-apps/plugin-updater` 2.12.0 | In-app updates for Tauri applications. | ✅ | ✅ | ✅ | ❌ | ❌ | Official | Signing keypair + `plugins.updater.pubkey` / `endpoints` in tauri.conf.json; `createUpdaterArtifacts` for the bundler (removed in v3 → set to `true`); private key must be an **env var** (`.env` files do not work). `installMode` on Windows (`passive`/`basicUi`/`quiet`). Server contract: static JSON or dynamic server, required keys `version` + `platforms.[target].url` + `platforms.[target].signature`, RFC 3339 `pub_date`, `{{target}}`/`{{arch}}` variables, TLS enforced in production. Downgrades need `version_comparator`. Some APIs are Rust-only "for security reasons". |
| 28 | Upload | `tauri-plugin-upload` 2.4.1 / `@tauri-apps/plugin-upload` 2.4.1 | Upload files from disk to a remote server over HTTP — **and download** them back. | ✅ | ✅ | ✅ | ✅ | ✅ | Official | None. Permissions are `upload:allow-upload` **and** `upload:allow-download`; the JS `download(url, filePath, onProgress, headers)` takes a progress callback. |
| 29 | Websocket | `tauri-plugin-websocket` 2.4.3 / `@tauri-apps/plugin-websocket` 2.4.3 | Open a WebSocket connection using a Rust client, from JavaScript. | ✅ | ✅ | ✅ | ✅ | ✅ | Official | None. Permissions: `websocket:allow-connect`, `websocket:allow-send`. |
| 30 | Window State | `tauri-plugin-window-state` 2.4.1 / `@tauri-apps/plugin-window-state` 2.4.1 | Save window positions and sizes and restore them when the app is reopened. | ✅ | ✅ | ✅ | ❌ | ❌ | Official | None. Rust add target-gated to desktop; registered in `.setup()` under `#[cfg(desktop)]`; builder-configurable. |

### 1b. Two extra rows the support table carries that have **no plugin page**

These appear in the index **support table** only. `build.ts` hardcodes them
(`desktopOnlySupport`), because they are Tauri **core** features, not plugins — they
have no `plugins/` directory and therefore no page under `/plugin/`. I list them
because a "nothing missed" reading of the support table must account for them.

| Plugin | Identifier | What it is | Win | macOS | Linux | Android | iOS | Official? | Notes |
|---|---|---|---|---|---|---|---|---|---|
| system-tray | core `tauri` (`tray-icon` feature) | System tray icon in the Tauri core. | ✅ | ✅ | ✅ | ❌ | ❌ | Official (core) | Listed in the support table; **no dedicated `plugins/system-tray` crate** — `build.ts` injects this row. Docs page for it is `/learn/system-tray/`, not `/plugin/`. Same `rust-version` 1.77.2. |
| window-customization | core `tauri` | Window decorations/customization in the Tauri core. | ✅ | ✅ | ✅ | ❌ | ❌ | Official (core) | Same as above — injected row, no plugin crate. Docs page is `/learn/window-customization/`. |

### 1c. Community plugins — the 50 listed on the index

The index renders these from `packages/awesome-tauri/README.md`, section
**Plugins**, filtered to drop any entry badged `official`. That filter removes
**three** entries from the README's 53: the "Official Plugins" monorepo link,
`window-vibrancy` and `window-shadows` (both badged *officially maintained*, both
described in the README as **v1-only, "added to Tauri in v2"**). Hence 53 − 3 = **50**,
matching the page exactly. Badges below are the `![v1]`/`![v2]` tags from the README;
the index page itself does **not** show v1/v2 badges.

| # | Community plugin | What it does (as listed) | v1/v2 tag |
|---|---|---|---|
| 1 | sentry-tauri | Capture JavaScript errors, Rust panics and native crash minidumps to Sentry. | v2 |
| 2 | tauri-awesome-rpc | Custom invoke system that leverages WebSocket. | v2 |
| 3 | tauri-nspanel | Convert a window to panel. | v2 |
| 4 | tauri-nspopover-plugin | Native NSPopover view for use in the status bar in macOS. | v2 |
| 5 | tauri-plugin-android-battery-optimization | Check and request battery optimization exemptions on Android. | v2 |
| 6 | tauri-plugin-android-fs | Access the file system on Android. | v2 |
| 7 | tauri-plugin-aptabase | Privacy-first and minimalist analytics for desktop and mobile apps. | v2 |
| 8 | tauri-plugin-auth | Auth plugin for iOS using ASWebAuthenticationSession (allows keychain access). | v2 |
| 9 | tauri-plugin-blec | Cross-platform Bluetooth Low Energy client based on `btleplug`. | v2 |
| 10 | tauri-plugin-cache | Advanced disk caching: memory layer, TTL management, compression. | v2 |
| 11 | tauri-plugin-clipboard | Clipboard read/write text/image/html/rtf/files, **plus clipboard-update monitoring**. | v2 |
| 12 | tauri-plugin-context-menu | Native context menu. | **v1** |
| 13 | tauri-plugin-desktop-underlay | Attach a window to desktop, below icons and above wallpaper. | v2 |
| 14 | tauri-plugin-device-info | Battery, network, storage, display, system details across desktop and mobile. | v2 |
| 15 | tauri-plugin-dragout | Native macOS drag-out (file promise) support. | v2 |
| 16 | tauri-plugin-drpc | Discord RPC support. | v2 |
| 17 | tauri-plugin-esc-pos | ESC/POS receipt printer support over USB and TCP. | v2 |
| 18 | tauri-plugin-fs-pro | Extended `fs` with additional methods for files and directories. | v2 |
| 19 | tauri-plugin-graphql | Type-safe IPC for Tauri using GraphQL. | **v1** |
| 20 | tauri-plugin-iap (Choochmeque) | Full In-App Purchases flow for Android, macOS, iOS and Windows. | v2 |
| 21 | tauri-plugin-iap (inKibra) | In-app-purchase plugin **for iOS only** (fetch/purchase/restore). | v2 |
| 22 | tauri-plugin-in-app-review | In-app rating prompts using native platform APIs. | v2 |
| 23 | tauri-plugin-ios-photos | iOS Photos album and asset management via native APIs. | v2 |
| 24 | tauri-plugin-js | Electron-like JS backends with type-safe RPC powered by **kkrpc**. Supports Bun, Node.js, Deno. | v2 |
| 25 | tauri-plugin-keep-screen-on | Disable screen timeout on Android and iOS. | v2 |
| 26 | tauri-plugin-libsql | libsql/Turso database with encryption, embedded replicas, Drizzle ORM. | v2 |
| 27 | tauri-plugin-macos-permissions | Check and request macOS system permissions. | v2 |
| 28 | tauri-plugin-mobile-sharetarget | Handle mobile Share Intents with a FIFO queue. | v2 |
| 29 | tauri-plugin-mqtt | MQTT client support. | v2 |
| 30 | tauri-plugin-network | Read network information and scan the network. | v2 |
| 31 | tauri-plugin-nosleep | Block the power-save functionality in the OS. | **v1** |
| 32 | tauri-plugin-ota | OTA delivery of new JavaScript code based on a manifest. | v2 |
| 33 | tauri-plugin-pinia | Persistent Pinia stores for Vue. | v2 |
| 34 | tauri-plugin-prevent-default | Disable default browser shortcuts. | v2 |
| 35 | tauri-plugin-python | Use Python in your backend. | v2 |
| 36 | tauri-plugin-screenshots | Get screenshots of windows and monitors. | v2 |
| 37 | tauri-plugin-serialport | Cross-compatible serialport communication. | v2 |
| 38 | tauri-plugin-serialplugin | Cross-compatible serialport communication (a second, separate implementation). | v2 |
| 39 | tauri-plugin-sharesheet | Share content to other apps via Android Sharesheet / iOS Share Pane. | v2 |
| 40 | tauri-plugin-svelte | Persistent Svelte stores. | v2 |
| 41 | tauri-plugin-system-info | Detailed system information. | v2 |
| 42 | tauri-plugin-tcp | TCP socket support. | v2 |
| 43 | tauri-plugin-thermal-printer | Handle thermal printers. | v2 |
| 44 | tauri-plugin-tracing | Structured logging with the `tracing` crate: JS→Rust log bridging, file rotation, flamegraph profiling. | v2 |
| 45 | tauri-plugin-udp | UDP socket support. | v2 |
| 46 | tauri-plugin-velesdb | Native vector database: 70µs semantic search, ≥95% recall, hybrid BM25+vector, offline-first. | v2 |
| 47 | tauri-plugin-view | View and share files on mobile. | v2 |
| 48 | tauri-plugin-widgets | Cross-platform home-screen widgets (WidgetKit, AppWidgetManager, Adaptive Cards, desktop webviews). | v2 |
| 49 | tauri-remote-ui | Make your web app bundle available as a web page **for test and development**. | v2 |
| 50 | taurpc | Typesafe IPC wrapper for Tauri commands and events. | v2 |

### 1d. Community integrations — the 16 listed on the index

From the README's **Integrations** section (rendered verbatim, no filtering).

| # | Integration | What it does | v1/v2 |
|---|---|---|---|
| 1 | Astrodon | Make Tauri desktop apps with Deno. | **v1** |
| 2 | axios-tauri-adapter | `axios` adapter for the `@tauri-apps/api/http` module. | **v1** |
| 3 | axios-tauri-api-adapter | Makes it easy to use Axios in Tauri (same adapter idea, second implementation). | v2 |
| 4 | Deno in Tauri | Run JS/TS code with the Deno Core Engine inside Tauri apps. | v2 |
| 5 | faynosync-update-server | Self-hosted dynamic update server with statistics. | v2 |
| 6 | kkrpc | Seamless RPC between a Tauri app and node/deno/bun processes. | v2 |
| 7 | ngx-tauri | Wrap Tauri module functions for easier Angular integration. | **v1** |
| 8 | svelte-tauri-filedrop | File-drop handling component for Svelte. | v2 |
| 9 | Tauri Specta | Completely typesafe Tauri commands. | v2 |
| 10 | tauri-htmx-extension | Extension for using htmx with Tauri APIs. | v2 |
| 11 | tauri-macos-menubar-app-example | Example macOS menubar app project. | **not badged** (README entry carries no `![vN]` tag) |
| 12 | tauri-macos-spotlight-example | Example macOS Spotlight app project. | **not badged** |
| 13 | tauri-mcp-server | MCP server and plugin for rapid development and debugging. | v2 |
| 14 | tauri-update-cloudflare | One-click deploy a Tauri update server to Cloudflare. | v2 |
| 15 | tauri-update-server | Interface the Tauri updater with git repository releases. | **v1** |
| 16 | vite-plugin-tauri | Integrate Tauri in a Vite project to build cross-platform apps. | v2 |

---

## Table 2 — Things worth a second look

| Thing | What it is | Why it stands out |
|---|---|---|
| **`fs` scopes are two independent gates** | Enabling `fs:allow-exists` grants **zero** paths. The docs carry a dedicated caution: *"Permissions alone do not grant a scope… calls will fail at runtime with a `forbidden path` error, even though the permission is enabled."* | This is the single most common silent-failure mode in the whole catalog. Two working forms: a global `fs:scope` permission, or the object form `{"identifier": "fs:allow-exists", "allow": [{"path": "$HOME/**/*"}]}`. Also note **`deny` beats `allow`** and each base directory must be configured separately. |
| **`fs` watch is behind a Cargo feature flag** | `watch`/`watchImmediate` exist but require `tauri-plugin-fs = { features = ["watch"] }`. | Easy to miss: the JS API is importable, but the Rust side must be compiled with the feature or it will not work. `watch` is debounced (`delayMs`), `watchImmediate` is not; **directory watching is non-recursive by default**. |
| **`fs` has an escape hatch for dotfiles** | `plugins.fs.requireLiteralLeadingDot: false` in `tauri.conf.json`. | Documented as necessary for `.gitignore` / `.ssh` style paths on Unix; the docs point at the same option existing for `app.security.assetProtocol.scope` in object form, and cite tauri#13788. |
| **`fs` deny-list protects webview data** | `fs:deny-webview-data-linux` denies `$APPLOCALDATA/**`; `fs:deny-webview-data-windows` denies `$APPLOCALDATA/EBWebView/**`. | The docs explain why: that is where webview data and configuration live, so allowing it *"can lead to sensitive information disclosure."* These are platform-scoped permissions. |
| **`persisted-scope` has a registration-order requirement** | `tauri_plugin_fs::init()` must come **before** `tauri_plugin_persisted_scope::init()`, annotated in the docs as `// fs MUST BE before persisted scope!`. | A pure ordering constraint that produces no compile error — it silently fails at runtime if reversed. |
| **`single-instance` must be registered first** | *"The Single Instance plugin must be the first one to be registered to work well. This assures that it runs before other plugins can interfere."* | Another no-compile-error ordering constraint. It also has a whole section on **Snap and Flatpak** app-ID requirements, which most plugin pages lack. |
| **`upload` is a two-way plugin, not just upload** | The advertised one-liner says "File uploads through HTTP", but the documented API includes `download(url, filePath, onProgress, headers)` with a progress callback, and permissions `upload:allow-upload` **and** `upload:allow-download`. | Anyone skimming the index would miss the download half entirely. |
| **`notification` supports channels, actions, and attachments** | Beyond `sendNotification`: `createChannel`/`channels`/`removeChannel` with importance/visibility/LED/vibration/custom sound; `registerActionTypes` + `onAction`; `attachments` with `asset://`/`file://` URLs. | The plugin has **34 permission identifiers** — by far the largest command surface after `fs`. But the **Actions API is explicitly mobile-only**, and the docs say to test attachments per platform. |
| **`notification` Windows caveat** | Support note on Windows: *"Only works for installed apps. Shows powershell name & icon in development."* | Directly relevant if you want deep/hero toasts: the plugin itself will misattribute your app in dev builds. |
| **`opener` and `shell` split** | The shell page states plainly: *"If you're looking for documentation for the `shell.open` API, check out the new Opener plugin instead."* | `shell.open` was moved out of `shell` into `opener`. Migrating code that still calls `shell.open` is a v1→v2 trap. `opener` also does **reveal-in-file-explorer** (`opener:allow-reveal-item-in-dir`) which the index one-liner never mentions. |
| **`opener`/`http`/`shell` all use glob scopes** | `opener` scopes both `{path}` and `{url}` using Rust `glob` syntax; `http` scopes URLs the same way; `shell` scopes each command with `name`/`cmd`/`args`/`sidecar` and supports per-arg `{"validator": "<regex>"}`. | Three different plugins, three scope shapes, one shared philosophy. `deny` beats `allow` throughout. |
| **`localhost` carries an explicit security warning** | *"This plugin brings considerable security risks and you should only use it if you know what you are doing. If in doubt, use the default custom protocol implementation."* | The only official plugin page with a razor-edged caution of this kind. It is also Rust-only (no JS bindings at all). |
| **`deep-link` runtime registration is desktop-only** | macOS, Android, and iOS are all `partial` with the same note: *"Deep links must be registered in config. Dynamic registration at runtime is not supported."* | Windows and Linux are `full` (runtime registration works). So a "register my scheme at first run" design can only work on two of five platforms. |
| **`http` has an `unsafe-headers` feature** | *"Forbidden request headers are ignored by default. To use them you must enable the `unsafe-headers` feature flag."* | A deliberate footgun-guard: silently dropping headers is the default behaviour. |
| **`stronghold` requires exactly 32 bytes** | *"The password hash must contain exactly 32 bytes. This is a Stronghold requirement."* | An unusual, hard numeric constraint surfaced only in the docs. |
| **`updater` is the most heavily documented plugin** | 27 KB of MDX — roughly 3× the next largest. Covers signing, `createUpdaterArtifacts`, Windows `installMode` (`passive`/`basicUi`/`quiet`), static-JSON vs dynamic server contracts, `{{target}}`/`{{arch}}` variables, downgrade support via `version_comparator`, and a note that *"some APIs are only available for Rust"* for security reasons. | If you are planning distribution, this page is a spec, not a tutorial. Note `.env` files **do not work** for the private key. |
| **`log` is the widest-reach plugin** | Full support on **all five** platforms, with three target sinks (terminal, webview console, persisted file), filtering, max level, target filter and per-target formatting. | Only six plugins are full on all five platforms: `http`, `log`, `os`, `persisted-scope`, `sql`, `store`, `stronghold`, `upload`, `websocket` (nine, in fact). `log` is the one most likely to be undervalued. |
| **Two "plugins" in the support table are not plugins** | `system-tray` and `window-customization` are hardcoded rows in `build.ts` (`desktopOnlySupport`) — they are Tauri **core** features. | A reader who tries `cargo add tauri-plugin-system-tray` will find nothing. The real docs are `/learn/system-tray/` and `/learn/window-customization/`. |
| **Declaring support is now manifest-driven** | `[package.metadata.platforms.support]` with `level` ∈ {`full`,`partial`,`none`} + optional Markdown `notes`; *"The support table and the platform filter on the Features & Recipes page are generated from this metadata."* | Useful for anyone writing a third-party plugin: the site picks it up automatically, but only if the crate is in the workspace the generator walks. |
| **Permission identifier is a hard compile-time grammar** | Lowercase ASCII + digits + hyphens only; no leading/trailing hyphen; a single `:` only with a prefix; base name ≤ 64 chars, full identifier ≤ 129 (the `permissions.mdx` page computes 116 from `MAX_LEN_PREFIX + 1 + MAX_LEN_BASE`; the newer `develop/plugins` page states 64/129). **These two pages disagree — see unconfirmed list.** | Build fails with a specific message naming the offending value. `@koishijs`-style underscores and camelCase are simply illegal. |
| **`sql` requires an engine feature** | `tauri-plugin-sql` defaults to nothing usable for a database choice — you must pick `sqlite`, `mysql`, or `postgres`. | The docs' own example ships `features = ["sqlite"]`. Migrations need unique version numbers and are registered on the builder. |
| **`positioner` is the tray's missing half** | Tray-relative positioning requires the `tray-icon` cargo feature **and** an `on_tray_icon_event` hook calling `tauri_plugin_positioner::on_tray_event(...)`. | If you have a tray icon and want a popup menu positioned correctly, this is the only supported wiring; `Position.TopRight` etc. are the API. |
| **`barcode-scanner` and `nfc` are mobile-only with opaque prerequisites** | Barcode requires `NSCameraUsageDescription`; NFC requires target-iOS-version adjustment + `NFCReaderUsageDescription` + the NFC capability entitlement. | NFC tag filtering is **Android-only**, with the docs warning to validate scanned contents yourself. |
| **Community: `tauri-plugin-js` + `kkrpc`** | `tauri-plugin-js` — *"Give your app Electron-like JS backends with type-safe RPC powered by kkrpc. Supports Bun, Node.js, and Deno."* `kkrpc` itself is listed under Integrations: *"Seamless RPC communication between a Tauri app and node/deno/bun processes."* | This is the one community entry that overlaps a pattern you already run natively. Worth a read as prior art even if you keep your own bridge. |
| **Community: two different `tauri-plugin-iap` entries** | Same name, different repos, overlapping but non-identical scope (one covers Android+macOS+iOS+Windows; the other is iOS-only). | A name collision on the index page itself. Pick by repository URL, not by name. |
| **Community: `tauri-plugin-fs-pro`** | *"Extended with additional methods for files and directories."* | The natural place to look if the official `fs` command set is not enough — before writing your own. |
| **Community: `tauri-remote-ui` is dev-only by its own description** | *"Make your web app bundle available as a web page for test and development."* | It is the only catalog entry that gestures at remote UI, and it explicitly is **not** a production multi-device mechanism. |

---

## Section 3 — Relevance notes for VRCX-K

Assumptions used (from this repo's `AGENTS.md` and `src-tauri/Cargo.toml`):
Tauri v2, Rust shell ("hands"), React UI, bun/Cordis sidecar as the "brain",
persistence living in the brain (`bun:sqlite`, COMMIT-based durability), an Android
target in CI, and a future multi-device direction. Current Rust deps, read from
`src-tauri/Cargo.toml`: `tauri` (features `tray-icon`, `image-png`, `image-ico`),
`tauri-plugin-opener`, `tauri-plugin-single-instance`, `tauri-plugin-global-shortcut`,
`tauri-plugin-dialog`, `tauri-plugin-notification`, plus `notify` 8, `file-id` 0.2,
and (Windows-only) `tauri-winrt-notification` 0.8. Root `package.json` depends on
`@tauri-apps/api` and `@tauri-apps/plugin-opener` only.

### 3a. Already in use — audit notes, not adoption questions

| Plugin | Status in VRCX-K | What the docs add that you should check |
|---|---|---|
| **opener** | In `Cargo.toml` **and** `package.json` | **Your capabilities must contain `opener:allow-open-path` / `opener:allow-open-url` scopes with explicit `{path}`/`{url}` globs.** The default permission set (`allow-open-url`, `allow-reveal-item-in-dir`, `allow-default-urls`) does **not** include `allow-open-path`. So `openPath()` from the UI will fail until you add it with a scope. Also: `reveal-item-in-dir` is available and free — useful if you ever want "show in Explorer". |
| **single-instance** | In `Cargo.toml` | Two documented constraints to confirm you satisfy: it **must be registered first**, and if you use `deep-link`, the plugin needs the `deep-link` feature. Rust-only (no JS API). Has a Snap/Flatpak section if you ever ship Linux. |
| **global-shortcut** | In `Cargo.toml` | 10 permissions; `register-all` / `unregister-all` exist beyond the pair you probably use. Desktop-only (Android/iOS = none), so nothing to gate for the Android CI target beyond the existing `cfg(desktop)`. |
| **dialog** | In `Cargo.toml` | Mobile is `partial`: **no folder picker on Android/iOS**. If any UI path assumes a directory picker, it needs a desktop-only branch for the Android build. Also note `dialog:allow-ask` / `allow-confirm` are **deprecated aliases** for `allow-message`, slated for removal in v3. |
| **notification** | In `Cargo.toml` (+ `tauri-winrt-notification` 0.8 provisioned for F3 depth) | The official plugin is the right cross-platform *baseline*, but the docs confirm its Windows ceiling: the platform note is only *"Only works for installed apps. Shows powershell name & icon in development."* There is **no documented hero-image, AUMID, or button API** on the plugin page — the deep-toast work stays on `tauri-winrt-notification`, exactly as your Cargo.toml comment anticipates. The plugin's action/attachment APIs are mobile-only, so they are not a substitute. |
| **fs** (transitive) | Pulled in transitively | See 3b — the interesting parts are `watch` and scopes. |

### 3b. Directly relevant, not yet adopted

| Plugin | Why it is concretely relevant | The catch |
|---|---|---|
| **fs** (`watch` + scopes) | You have just built Rust file primitives on `notify` 8 + `file-id` 0.2. The plugin's `watch`/`watchImmediate` is a **second, independent** file-watching implementation with one property yours lacks: the events are delivered to the **frontend** as JS callbacks, with `recursive` and `delayMs` options. | Two watchers on the same tree is a real cost. Decide per consumer: if the React UI needs change events, the plugin's `watch` (with the `watch` cargo feature) is less plumbing than forwarding your own; if only the brain needs them, keep your Rust path. Also: `fs` permissions are useless without an `allow` scope, `deny` beats `allow`, and non-recursive-by-default is the default that surprises people. |
| **upload** | The one official plugin that does **download with a progress callback** (`download(url, filePath, onProgress, headers)`) as well as upload. Given the open question about "file upload/download", this is the shortest path to HTTP transfer with progress, full support on all five platforms, and a trivial permission set (`upload:allow-upload`, `upload:allow-download`). | It is disk-to-disk over HTTP. If your transfers must stream into the brain (kkrpc/Cordis) rather than land on the hands' filesystem first, this does not fit your architecture — your custom primitives remain the right answer. |
| **http** | `reqwest` re-export + a JS `fetch` with a **URL scope enforced by the capability system**. Relevant if you want to hand the frontend a sanctioned, scope-limited way to reach VRChat's API without exposing a raw Rust command. | Scope must list allowed URLs or every request is blocked. `unsafe-headers` is required for otherwise-forbidden request headers (a documented, silent default-drop). Rust side is unrestricted — the scope only governs the JS path. |
| **updater** + **process** | Directly maps to your **M5 "分发与更新"** milestone. `updater` is the official in-app update path (signing, endpoints, Windows `installMode`, static/dynamic server contracts, `{{target}}`/`{{arch}}`). `process` is its documented companion for relaunch/exit (`process:allow-restart`, `process:allow-exit`). | Substantial setup: keypair, `pubkey`+`endpoints` in `tauri.conf.json`, `createUpdaterArtifacts`, private key **as an env var** (`.env` files explicitly do not work), and a server that satisfies the documented JSON contract. Desktop-only (Android/iOS = `none`), so it cannot serve the Android target. |
| **window-state** | You have multi-window on the roadmap. This persists sizes/positions across restarts, is desktop-only, and is a few lines in `.setup()` under `#[cfg(desktop)]`. | Purely a persistence convenience — it does not give you multi-window itself. Multi-window is core (`core:window`/`core:webview` permissions), not a plugin. |
| **positioner** | You already compile `tauri` with `tray-icon`. If you want a tray-anchored window/popup to land at the tray correctly (`Position.TopRight` etc.), this is the only documented mechanism, and its prerequisites (the positioner `tray-icon` feature + `on_tray_icon_event` → `on_tray_event`) line up with the tray feature you already enable. | Adds a Rust-side event hook to your tray builder. Desktop-only. |
| **clipboard-manager** | Not on your dep list, but this is a VRCX-shaped app: copying user IDs, instance links, avatar URLs is routine. Six commands, all five platforms (mobile is plain-text only), and no scope to configure — just `allow-read-text`/`allow-write-text`. | Its default permission set enables **nothing** (`clipboard-manager` default = "No features are enabled by default"). You must list every command you want. |
| **autostart** | A VRCX-class desktop app plausibly wants "start with the system". Desktop-only, three commands, tiny. | `MacosLauncher::LaunchAgent` and an argv list are part of `init()`; on Windows/Linux registration lands in the OS's own startup mechanism, which some users dislike — a UI toggle is advisable. |
| **deep-link** | If VRCX-K should answer `vrchat://`-style links or its own scheme, this is the official path. Windows/Linux are `full`. | macOS/Android/iOS are `partial`: **runtime registration is not supported** on those three — schemes must be in config. Android additionally needs an HTTPS `assetlinks.json` with `Content-Type: application/json`; iOS needs an HTTPS `apple-app-site-association`. Desktop runtime registration pulls in a `deep-link` feature on **single-instance** and an `Env::args_os` re-check. |
| **log** | You already depend on the `log` crate in Rust. The plugin adds a **JS→Rust bridge** and three sinks (terminal / webview console / persisted file with rotation), full support on all five platforms. Relevant precisely because your brain (bun) and hands (Rust) both log today and this would put them in one stream. | Rust-side macros need the `log` crate added explicitly. This does not replace the brain's own logging — it is the shell's sink. |
| **os** | Full support on all five platforms; trivial; useful for platform-conditional UI and for the multi-device direction (identifying "which machine am I on"). | Eight read-only commands, no scope. Low stakes either way. |

### 3c. Not relevant, with reasons

| Plugin | Why not relevant to VRCX-K |
|---|---|
| **barcode-scanner** | Mobile-only (❌ Win/macOS/Linux), requires camera + `NSCameraUsageDescription`. No VRCX-K need identified. |
| **biometric** | Mobile-only, requires `NSFaceIDUsageDescription`. Authentication in VRCX-K is VRChat credentials (2FA) in the brain, not device biometrics. |
| **geolocation** | Mobile-only. VRCX-K's location data is VRChat instance/world location from the API, not device GPS. |
| **haptics** | Mobile-only, and there is no touch-driven interaction it would serve. |
| **nfc** | Mobile-only with hefty iOS entitlements (target version + usage description + NFC capability). No use case. |
| **localhost** | The docs themselves warn it brings "considerable security risks". Your UI loads from the Tauri custom protocol today, and there is no documented need to opt into a localhost HTTP server. Actively avoid unless a concrete requirement appears. |
| **sql** | Your persistence lives in the brain on `bun:sqlite`, with your own cross-engine invariants and DDL-rollback contract (`docs/data-engine-fault-history.md`). Introducing `sqlx` in the shell would create a second database engine and a second source of truth — exactly the "第二份真源" failure mode your conventions warn against. |
| **stronghold** | Same reasoning: secrets (VRChat credentials/tokens) belong to the brain's storage strategy. The 32-byte hash constraint and a second secret store would be cost with no architectural fit. |
| **store** | A key-value store in the shell duplicates the brain's persistence. Only worth it for purely shell-local UI state that must survive restarts and cannot round-trip to the brain (e.g. window layout is already covered better by `window-state`). |
| **persisted-scope** | Only meaningful if you both use `fs` **and** mutate scopes at runtime via the frontend. Your file primitives are Rust-side, so there is nothing to persist. Revisit only if you adopt `fs` with runtime scope changes. |
| **shell** | Your sidecar (bun/Cordis) is spawned by the Rust shell (`src-tauri/src/host.rs`), i.e. via Tauri's core sidecar/`Command` path, not the plugin. Adding `shell` would add a **second** process-spawning surface that the frontend could reach, guarded only by a per-command arg-validator scope. That is a net increase in attack surface for no capability you lack. Also note `shell.open` moved to `opener`, which you already have. |
| **cli** | Requires declaring the full arg/subcommand grammar in `tauri.conf.json`. You already have `single-instance`, whose `init` callback delivers `args` and `cwd` to Rust — that covers the realistic "second launch passes a path/flag" case without a new plugin. |
| **process** | Listed as *relevant* in 3b only as the updater's companion. On its own (`exit`/`restart`) it is desktop-only and marginal, since your shutdown path is deliberately handled by the shell (`docs/shutdown-strategy-review.md`). Do not add it standalone. |
| **websocket** | You already run bidirectional WS in the brain via `kkrpc/ws` with `ws` in Node/bun. A Rust WS client exposed to the frontend would be a parallel transport. The one scenario that would revive it — the multi-device direction, where the *shell* must hold a socket — is speculative today; it is unconfirmed whether the shell or the brain would own that connection. |
| **tauri-remote-ui** (community) | Its own one-liner says *"for test and development"*. It is not a production multi-device mechanism. Do not read it as an answer to "UI on one machine, hands on another". |
| **iptables of community mobile plugins** (`-android-fs`, `-ios-photos`, `-sharesheet`, `-keep-screen-on`, `-in-app-review`, `-iap`, `-auth`, `-mobile-sharetarget`, `-widgets`) | Mobile/store-distribution concerns. Your Android target exists in CI as a build target, not as a store product; adopting these before that changes is premature. |

### 3d. The multi-device question — explicit finding

**No official plugin answers "UI on one machine, hands on another."** The three
closest official pieces are `localhost` (Rust-only, explicitly flagged as a
security risk), `websocket` (a Rust WS client the *frontend* drives), and `http`
(scope-limited requests) — and none of them is a remote-control transport. The only
catalog entry that even gestures at remote UI is the community
`tauri-remote-ui`, which describes itself as test/development only. There is also a
documented caveat that fits your architecture: the `fs` mobile note is *"Access is
restricted to Application folder by default"*, i.e. away from the plain filesystem —
worth knowing before assuming a mobile client can read arbitrary paths on the "hands"
machine.

**State this as unconfirmed:** whether the Tauri capability/permission model can be
extended to a *remote* webview (rather than a local one) is not addressed anywhere in
the pages retrieved. It may well be defined elsewhere in the docs, but I did not
retrieve such a page, so I am not asserting either way.

### 3e. Android CI target — what the platform matrix means for you

Plugins you either use or might adopt, and their Android column:

* **Android ✅ (full):** `http`, `log`, `os`, `persisted-scope`, `sql`, `store`,
  `stronghold`, `upload`, `websocket`, plus mobile-only `barcode-scanner`,
  `biometric`, `geolocation`, `haptics`, `nfc`, and `notification`.
* **Android ⚠️ (partial):** `clipboard-manager` (plain text only), `dialog` (**no
  folder picker**), `deep-link` (config-only registration), `fs` (app folder by
  default), `opener` (URLs only), `shell` (URLs only).
* **Android ❌ (none):** `autostart`, `cli`, `global-shortcut`, `localhost`,
  `positioner`, `process`, `single-instance`, `updater`, `window-state` — i.e.
  **every desktop-shell plugin you currently depend on except `dialog`, `opener`,
  and `notification`.**

So for the Android build: `single-instance` and `global-shortcut` are already
target-gated in their docs' own install commands and need `#[cfg(desktop)]`;
`dialog` needs a folder-picker fallback; `opener` should only be given URL opens;
and `fs` paths must stay inside the application folder or add the external-storage
permissions listed on the `fs` page.

---

## Section 4 — Coverage statement

### Where the platform matrix came from (the one thing a reader must know)

**Every ✅/⚠️/❌ in Table 1 comes from the plugin's own
`Cargo.toml` `[package.metadata.platforms.support]` block**, retrieved from
`raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/<name>/Cargo.toml`.
This is the exact input the docs site's own generator consumes
(`packages/compatibility-table/build.ts`), so it is the same data the site renders.

⚠ **It is NOT taken from the rendered plugin pages**, and that is worth knowing because
the pages *look* authoritative: both a real-browser read and a plain fetch produce the
platform table with **empty Level/Notes cells**, since those cells are icon-only with the
meaning in a `title` attribute. Anyone re-checking this catalog from the website would
see a blank table and conclude the data is missing.

*(The exhaustive per-file fetch logs that used to follow were removed: they recorded the
research process, not any finding, and grew with every retry without changing a
conclusion.)*

### Failures and partial results — state plainly

1. **`_tableContent.json` — HTTP 404, by design.** The file the docs site renders the
   support table from is **gitignored** (`src/components/plugins/.gitignore` contains
   exactly that one line). Recovered by reading the generator instead; see above.
2. **3 of 30 npm `package.json` — HTTP 404: `localhost`, `persisted-scope`,
   `single-instance`.** **Interpretation (inferred, not stated in the docs):** these
   three are the plugins whose doc pages pass `showJsLinks={false}`, i.e. they have no
   JavaScript guest bindings and therefore no npm package. The docs never say this in
   prose; I inferred it from the `showJsLinks` prop plus the absent `package.json`.
   Marked `[^8]` in Table 1 as inferred.
3. **`@tauri-apps/plugin-http` version skew.** Crate is `2.7.0`, npm package is
   `2.6.1`. Both read from the same branch. Reported as-is; not an error on my side,
   but flagging it since the task asked for exact identifiers.
4. **⚠ Upstream directory names are capitalised**: `learn/Security/`, `develop/Plugins/`.
   Lowercase guesses (`learn/security/*.mdx`, `develop/plugins/index.mdx`) 404. Kept
   because it is a **reusable trap for anyone re-checking this data** on a
   case-sensitive filesystem (GitHub raw is case-sensitive; a local macOS/Windows
   checkout would not reveal it).

### Ambiguities I am marking as **unconfirmed**

* **Permission-identifier maximum length is stated differently on two pages.**
  `security/permissions.mdx` derives **116** (`MAX_LEN_PREFIX + 1 + MAX_LEN_BASE`
  = 53 + 1 + 64 − ... as written in that file), while `develop/Plugins/index.mdx`
  states **64 for the base name, 129 with a prefix**. I am reporting both rather than
  picking one. The character-set rules agree on both pages.
* **Whether `system-tray` / `window-customization` have ever had plugin crates.**
  The generator injects them as constants, and `plugins-workspace` contains no such
  directories — consistent with "core feature, never a plugin". The docs do not say
  this in words, so I am labelling the reasoning as inference.
* **The three no-npm plugins** — see item 2 above.
* **Remote-webview capability support** — see §3d.
* **Version numbers.** All versions are the ones present on branch `v2` at retrieval
  time. The docs site does not publish per-plugin versions on its pages, so these come
  from the manifests, not from the documentation prose. Treat them as a snapshot.
* **The rendered plugin pages' own "Notes" column could not be read from the browser.**
  The notes in this report come from the manifest, which the docs site states is the
  same source. I did not visually confirm any single note against a rendered tooltip.

### Nothing was skipped

30 official plugins + 2 support-table-only core rows + 50 community plugins +
16 community integrations = **98 catalog entries**, every one enumerated above. No
row is summarised as "etc."

---

### Footnotes

[^1]: `clipboard-manager` Android/iOS = `partial`: *"Only plain-text content support"*.
[^2]: `dialog` Android/iOS = `partial`: *"Does not support folder picker"*.
[^3]: `deep-link` macOS/Android/iOS = `partial`: *"Deep links must be registered in config. Dynamic registration at runtime is not supported."*
[^4]: `fs` Android/iOS = `partial`: *"Access is restricted to Application folder by default"*. Also on the `full` desktop rows: Windows *"Apps installed via MSI or NSIS in `perMachine` and `both` mode require admin permissions for write access in `$RESOURCES` folder"*; Linux and macOS *"No write access to `$RESOURCES` folder"*.
[^5]: `notification` Windows = `full` with note: *"Only works for installed apps. Shows powershell name & icon in development."*
[^6]: `opener` Android/iOS = `partial`: *"Only allows to open URLs via `open`"*.
[^7]: `shell` Android/iOS = `partial`: *"Only allows to open URLs via `open`"*.
[^8]: Inferred: no npm package, based on the doc page's `showJsLinks={false}` plus the absent `package.json`. Not stated in prose by the docs.
