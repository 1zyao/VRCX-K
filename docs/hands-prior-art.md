# Prior art: URL scheme, bulk-vs-interactive IPC, plugin resource lifetime

Research report for three technical decisions in **VRCX-K** (Tauri v2 Rust shell + React UI +
bun/Cordis sidecar).

Every claim below cites a URL or a file path. Where a source could not be opened or a question
could not be settled, the text says **unconfirmed** rather than guessing.

---

## 0. Provenance and licence gate (read before trusting any VRCX citation)

**All `vrcx-team/VRCX` citations were read from this checkout's remote-tracking ref
`refs/remotes/VRCX/master`**, not over the network, per the task's instruction to prefer local.

| Fact | Value |
|---|---|
| Ref actually read | `refs/remotes/VRCX/master` |
| Commit | `a43a43d8fda98c09ce594eb685904f83be06c7a7` |
| Author / date | `Natsumi`, Thu Sep 10 20:44:28 2026 +1000 |
| Subject | "Fix new instance group privacy" |
| Licence (verified first) | `MIT License` / `Copyright (c) 2019-2026 pypy and individual contributors.` → **MIT, safe** |

Three warnings that affect how these citations may be reused:

1. ⚠ **`git rev-list --count refs/remotes/VRCX/master` returns `2`, which is NOT the branch
   length.** `git rev-parse --is-shallow-repository` → **`true`**; `.git/shallow` contains
   `e46ac924a69498b93fb0019881a7f800facf33ea`. The number is truncated by the shallow graft.
   Line-level file content is fully readable; **commit-count-derived claims are not**.
2. ⚠ **Two different refs are named `VRCX/master`.** `refs/heads/VRCX/master` is a *different*
   commit (`49923dfa4c6217e00b94334b57eef5a2e48c0d9b`, 2026-08-04, "Touch ups"), and
   `git merge-base refs/heads/VRCX/master refs/remotes/VRCX/master` **fails (exit 1)** — no common
   ancestor exists in this shallow clone. The unqualified name emits
   `warning: refname 'VRCX/master' is ambiguous`. **Every citation below is fully qualified.**
3. Licence was checked on *both* refs before reading (`git show <ref>:LICENSE`); both are MIT.

**GPL red line honoured:** the `vrcx-0` / Map1en lineage was **never opened, read, quoted, or
described** — GPL-lineage, not inspected. Nothing under `docs/legacy-recon/` was read.

**A note on the two evidence classes in this report.** Q1 and the VRCX/SDK parts of Q2/Q3 rest on
sources **I read directly** (git objects, working-tree files, `node_modules`). The cross-project
survey in Q2 (VS Code, rust-analyzer, tokio, gRPC, LSP, Chromium, RFCs) and the mechanism survey
in Q3 came from a delegated research pass that fetched them over the network; I verified that the
**VRCX file paths** it cited exist in the ref, but I did **not** independently re-fetch the
non-VRCX upstream files. That distinction is marked in §6.

---

## 1. Bottom line

| # | Question | Answer in one line | Confidence |
|---|---|---|---|
| **Q1** | Does vrcx-team/VRCX register a URL scheme, and does it claim `vrchat://`? | **Yes — it registers `vrcx` only** (`HKCU\Software\Classes\vrcx`, NSIS `Installer/installer.nsi:193-199`; Linux `x-scheme-handler/vrcx`); **it does NOT claim `vrchat://`** — it *forwards* `vrchat://launch?ref=vrcx.app&…` to VRChat's own `VRChatURLLaunchPipe` | **definite** |
| **Q2** | How do mature systems keep bulk transfer off the interactive latency path? | **No project solves it inside one unframed channel.** The real answers are (a) per-stream credit/flow control, (b) cap-and-split writes at ≤256 KiB, (c) a *two-class dispatcher* that drains interactive work before bulk, and (d) in the extremes a second transport; **multiplexing alone is explicitly documented as insufficient** | **likely** (mechanisms verified; direct transferability to our pipe is inference) |
| **Q3** | How is an in-flight resource stopped when its owning plugin unloads? | **"Register cleanup on the owner's lifecycle scope" is the dominant pattern but is never sufficient alone** — every mature system adds a *forced host-side path* that enumerates and clears the owner's disposables; registration in a container nobody iterates is itself the failure mode | **definite** |

**Single most decision-relevant finding overall:** VRCX — the incumbent app we are allowed to learn
from — **deliberately declined to claim `vrchat://`**. If VRCX-K claims it, that is a novel product
decision with no precedent in the app being copied, not a compatibility requirement.

---

## 2. Q1 — custom URL scheme / deep linking

### 2.1 The exact scheme string is `vrcx` — not `vrchat`

Windows, declared in the Inno/NSIS installer `Installer/installer.nsi` under **`HKCU`** (per-user, so
no elevation needed), lines **193–199**, with removal at **:219**:

```
193: WriteRegStr HKCU "Software\Classes\vrcx" "" "URL:vrcx"
194: WriteRegStr HKCU "Software\Classes\vrcx" "FriendlyTypeName" "VRCX"
195: WriteRegStr HKCU "Software\Classes\vrcx" "URL Protocol" ""
196: WriteRegExpandStr HKCU "Software\Classes\vrcx\DefaultIcon" "" "$INSTDIR\VRCX.ico"
197: WriteRegStr HKCU "Software\Classes\vrcx\shell" "" "open"
198: WriteRegStr HKCU "Software\Classes\vrcx\shell\open" "FriendlyAppName" "VRCX"
199: WriteRegStr HKCU "Software\Classes\vrcx\shell\open\command" "" '"$INSTDIR\VRCX.exe" /uri="%1" /params="%2 %3 %4"'
219: DeleteRegKey HKCU "Software\Classes\vrcx"
```

I enumerated **every** `WriteReg*`/`DeleteReg*` line in that file: the only protocol key written is
`Software\Classes\vrcx`. The other writes are `HKLM\Software\VRCX` (InstallDir) and the
`...\Uninstall\VRCX` AppWizard entries. **There is no `Software\Classes\vrchat` write anywhere in the
repo** — `git grep -n 'Classes\\vrchat' refs/remotes/VRCX/master` returns no match (exit 1).

The same scheme name is a constant in code (`src-electron/main.js:46`):

```
46: const VRCX_URI_PREFIX = 'vrcx';
```

### 2.2 Argument parsing — the stored command is the path *after* `vrcx://`

`Dotnet/StartupArgs.cs:110-111`:

```csharp
public const string LaunchCommandPrefix = "/uri=vrcx://";
public const string LinuxLaunchCommandPrefix = "vrcx://";
```

consumed at `Dotnet/StartupArgs.cs:81-85`, which strips the prefix so `LaunchCommand` holds e.g.
`user/usr_1` or `world/wrld_…`. Note the Windows registry command is `/uri="%1"` where `%1` is the
whole URL, giving `/uri=vrcx://user/usr_1` — the two constants deliberately match that shape.

> **Inference (not read):** on Windows the app's own `vrcx://` URLs appear to also flow through the
> *external-link* path — `src/shared/utils/appActions.js:53-61` `openExternalLink(link)` calls
> `searchStore.directAccessParse(link)` and otherwise shows an external-link dialog. I read
> `src/stores/search.js:116-168` (`directAccessParse`) and `:170-215` (`directAccessWorld`): they
> recognise `https://vrchat.` URLs, `/home/`, `https://vrc.group/`, `https://vrch.at/`, bare IDs
> (`usr_`, `avtr_`, `grp_`, `wrld_`, 8-char short names) — **none of them match a `vrcx://` prefix**.
> The only test that feeds a `vrcx://` string (`src/shared/utils/__tests__/appActions.test.js:105-111`)
> **mocks** `directAccessParse` to return `true`, so it proves nothing about real parsing. **How a
> genuine `vrcx://user/usr_1` reaches a dialog is unconfirmed.**

### 2.3 `vrchat://` — VRCX does not claim it; it *forwards* to VRChat's own pipe

This is the key product finding. VRCX builds `vrchat://` URLs and hands them to **VRChat's launcher**
through a named pipe it does not own:

- Target pipe: `Dotnet/IPC/VRCIPC.cs:9` — `private const string PipeName = "VRChatURLLaunchPipe";`
- Send path: `Dotnet/AppApi/Common/AppApiCommon.cs:172-175` —
  `public virtual Task<bool> TryOpenInstanceInVrc(string launchUrl) => VRCIPC.Send(launchUrl);`
- URL construction: `src/stores/launch.js:65, 82, 84` — e.g.
  `` `vrchat://launch?ref=vrcx.app&id=${location}&shortName=${shortName}` `` (the `ref=vrcx.app`
  parameter is VRCX's attribution tag).
- No-registration proof: §2.1 above — the installer writes only `Classes\vrcx`.

For anything else, VRCX defers to the OS shell rather than claiming the scheme —
`Dotnet/AppApi/Common/AppApiCommon.cs:60-62` uses `Process.Start(new ProcessStartInfo(url){ UseShellExecute = true })`.

⇒ **VRCX integrates with `vrchat://` as a *client* of VRChat's launcher, not as a *handler* of it.**

### 2.4 "App already running, second launch arrives with a URL"

Two independent mechanisms exist. **They are not the same pipe** — do not conflate them.

**(a) Windows / CefSharp build — duplicate-process detection + own named pipe**

- `Dotnet/StartupArgs.cs:52-59`: if a duplicate process with the same config directory exists →
  `IPCToMain(); Thread.Sleep(10); Environment.Exit(0);`
- `IPCToMain()` (`Dotnet/StartupArgs.cs:176-183`) opens a client on `IPCServer.GetIpcName()` and writes
  one NUL-terminated JSON line:
  `{"type":"LaunchCommand","command":"<LaunchCommand>"}` + `(char)0x00`.
- Pipe name is **per-user** and derived from a char-sum of the username —
  `Dotnet/IPC/IPCServer.cs:32-40`: `GetIpcName() => $"vrcx-ipc-{hash}"`. Server is
  `NamedPipeServerStream(…, MaxAllowedServerInstances, PipeTransmissionMode.Byte, PipeOptions.Asynchronous)`,
  accepting repeatedly (`IPCServer.cs:41-49`).
- Reception: `Dotnet/IPC/IPCClient.cs:74-91` splits the stream on `\0` and pushes each packet into the
  webview: `MainForm.Instance.Browser.ExecuteScriptAsync("window?.$pinia?.vrcx.ipcEvent", packet)`.
- Renderer route: `src/stores/vrcx.js:545-547` — `case 'LaunchCommand': eventLaunchCommand(data.command); break;`

**Window focus is a separate, frontend-initiated call**, not part of the redirect:
`eventLaunchCommand` ends with `if (shouldFocusWindow) { AppApi.FocusWindow(); }` → and
`Dotnet/Cef/MainForm.cs:226-235`:

```csharp
public void Focus_Window() {
    Show();
    if (WindowState == FormWindowState.Minimized) { WindowState = LastWindowStateToRestore; }
    // Focus();
    Activate();
}
```

(Note `Focus()` is commented out at `:233`; `shouldFocusWindow` is also set to `false` for the
"avatar without confirmation" branch.)

**(b) Linux/macOS Electron build — `requestSingleInstanceLock` + `open-url`**

`src-electron/main.js`:

```
140: const gotTheLock = app.requestSingleInstanceLock();
141: const strip_vrcx_prefix_regex = new RegExp('^' + VRCX_URI_PREFIX + '://');
143: if (!gotTheLock) { console.log('Another instance is already running. Exiting.'); app.quit(); }
147: app.on('second-instance', (_event, commandLine, _workingDirectory) => {
150:     mainWindow.webContents.send('launch-command',
152:         commandLine.pop().trim().replace(strip_vrcx_prefix_regex, ''));
160: app.on('open-url', (_event, url) => {
162:     mainWindow.webContents.send('launch-command', url.replace(strip_vrcx_prefix_regex, ''));
```

Renderer listener at `src/stores/vrcx.js:102` (`'launch-command'`), exposed through the preload
allow-list `src-electron/preload.js:41` (`const validChannels = ['launch-command'];`).
Caveat for both branches: delivery is silently dropped when `mainWindow` is undefined, and
`second-instance` takes only `commandLine.pop()` (the **last** argument).

### 2.5 macOS / Linux

- **Linux: yes, declared and registered.** `electron-builder.config.js` sets
  `linux.mimeTypes: ['x-scheme-handler/vrcx']` and `linux.desktop.entry.MimeType: 'x-scheme-handler/vrcx;'`.
  At runtime `src-electron/main.js:68-74` calls `app.setAsDefaultProtocolClient(VRCX_URI_PREFIX, …)`,
  guarded by `app.isPackaged && process.defaultApp && process.platform !== 'win32'` — i.e. it only runs
  in the unpackaged/dev case.
- **macOS: unconfirmed.** The same config has a `mac` target (`target: ['dmg']`), but I saw **no**
  `CFBundleURLTypes` / `Info.plist` scheme declaration anywhere I read, and the runtime
  registration above is explicitly `!== 'win32'`-gated without being macOS-specific. Whether macOS
  actually registers `vrcx` is **unconfirmed**.
- The `.iss`-style installer path is Windows-only; Linux uses electron-builder; so **VRCX is
  Windows + Linux for schemes, macOS unknown.**

### 2.6 Contrast — what VRCX-K already has (and what it lacks)

Our shell already carries the machinery but **no scheme string is set**:

- `src-tauri/Cargo.toml:23` — `tauri-plugin-single-instance = { version = "2", features = ["deep-link"] }`
- `src-tauri/Cargo.toml:84-89` — `tauri-plugin-deep-link = "2"`, with a comment documenting exactly the
  platform split we care about: "Windows/Linux support runtime registration; **macOS/Android/iOS require
  the scheme to be declared in config** and cannot register at runtime."
- `src-tauri/src/shell_sys.rs:282-299` — `shell.deepLink.register(scheme)` and `shell.deepLink.isRegistered(scheme)`.
- `src-tauri/src/lib.rs:321-327` wires `app.deep_link().on_open_url(...)` → `forward_deep_link`.
- `src-tauri/src/lib.rs:144-164` `forward_deep_link` notifies the host as `deepLink.opened` and mirrors to
  the frontend as `deep-link-opened` — with the deliberate design note that "the brain owns what a URL
  MEANS; the shell only proves it arrived."
- `src-tauri/src/lib.rs:172-197` handles second-instance redirect and emits `single-instance-redirect`,
  documenting the plugin behaviour that a missing event means the redirect never arrived.
- Host side: `host/src/stdio.ts` (`deepLink.opened` → fanout) and `onOpen`, plus
  `host/src/capability.ts` — which exposes **`deepLink.isRegistered` only**.
  ⚠ `deepLink.register` is deliberately NOT exposed to plugins as of the review round
  that found it: it writes `HKCU\Software\Classes\<scheme>` with no unregister route,
  so a single call is a persistent machine-wide change this app cannot undo — and the
  feature it would serve is not wired (no `schemes` in `tauri.conf.json`, so
  `deepLink.opened` never fires). Exposing it would buy the side effect without the
  feature. The shell-side route remains and is still validated; see
  `src-tauri/src/shell_sys.rs`.
- ⚠ **`src-tauri/tauri.conf.json` contains no `plugins`/deep-link scheme section** → no scheme is
  currently declared, so on macOS/Android/iOS the feature cannot work yet.

---

## 3. Q2 — bulk transfer vs interactive traffic

### 3.1 First, the measured facts we are reasoning from (local, cited)

| Fact | Value | Source |
|---|---|---|
| Interactive p50, idle → loaded | 0.15 ms → 0.19 ms (**1.28x**) | `docs/hands-capability-proposal.md:245`; `docs/hands-host-design.md:224` |
| Interactive p95, idle → loaded | 0.37 ms → 18.85 ms (**51x**) | same lines |
| p95 after transfer | 0.21 ms (recovers) | same |
| Mechanism | shell's `write()` holds the writer lock **per frame**, not per file | `docs/hands-host-design.md:229-231`; code at `src-tauri/src/kkrpc_peer.rs:913-921` (`let mut writer = self.writer.lock()…; write_all(encoded); writer.flush()`) |
| Transfer is 128 MiB, n=100 | probe `docs/probes/hands-e2e/hol.mjs` | run: `cargo build --release --locked --manifest-path src-tauri/Cargo.toml --example hands-e2e && node docs/probes/hands-e2e/hol.mjs` |
| Single pipe confirmed | `.stdin(Stdio::piped()).stdout(Stdio::piped())`, one channel | `src-tauri/src/host.rs:1217-1219` |
| **Cause is NOT separated** | p95 may be head-of-line **queueing** *or* the peer being **busy**; the probe says the two need different fixes and this measurement cannot distinguish them | `hol.mjs` "the competing explanation" block; `docs/hands-host-design.md:242-244` |
| Loopback is a **lower bound** | cross-machine tail is unmeasured and will be worse | `docs/hands-host-design.md:237-240`; `docs/probes/transport-lab/FINDINGS.md:126-136` |

⚠ **The stated numbers must not be quoted without the caveat.** The earlier WebSocket run of the same
question gave p50 0.66 ms → 321 ms (740x), and `transport-lab/FINDINGS.md:120-136` **explicitly warns
against quoting that multiple** (that run had `n<30` in-transfer samples; a smaller-payload re-run
compresses 740x → 2.0x). The current `hol.mjs` numbers are the trustworthy ones for *this* pipe.

### 3.2 What our own transport already does — and what it does not

I read the shipped bundles in `node_modules/kkrpc@2.1.0`:

| Property | Status | Evidence |
|---|---|---|
| Credit/window flow control | **Yes** | `STREAM_CREDIT_WINDOW = 32`, `STREAM_CREDIT_REPLENISH = 16` — named constants recovered from `node_modules/kkrpc/dist/streaming.js.map` (`sourcesContent[0]`); runtime confirmations `sendStreamPull(e, 32)` and `!(e.consumedSincePull < 16)` in `node_modules/kkrpc/dist/streaming.js` |
| Flow control verified empirically | **Yes** | `docs/probes/transport-lab/FINDINGS.md:144-152` — **32 chunks** produced while the consumer stalls (exactly the credit constant) vs **2048** ungated; memory is `credit × chunk size`, not file size |
| **Any priority / QoS / write queue** | **No — none at all** | `grep -r "priority\|writeQueue\|pendingWrites" node_modules/kkrpc/dist` → **no matches** |
| Bulk is throttled or deferred | **No** | `pumpLocalStream()` (`streaming.js`) loops `for (; !this.destroyed && !t.closed && t.credit > 0;)` — no yield, no budget, no interleave |
| Chunk writes are atomic per frame | **Yes** | sender awaits `this.post(...)` per chunk, so the lock is released between frames (this is *why* p50 holds) |

⇒ **kkrpc gives us back-pressure but gives us no priority.** The p95 blow-up is exactly what you get
from flow control without scheduling.

### 3.3 Pattern table

Legend for the last column: ✅ = plausibly helps our p95-only, single-pipe situation; ⚠️ = partial or
conditional; ❌ = does not address it or is explicitly disclaimed.

| Pattern | Real project that uses it | Where I saw it | Mechanism (concrete) | Cost / tradeoff | Fit for a single stdio pipe with p95-only degradation |
|---|---|---|---|---|---|
| **Cap + split every write** | VS Code (MIT) | `src/vs/base/parts/ipc/node/ipc.net.ts`, `WebSocketNodeSocket.write()` | `const enum Constants { MaxWebSocketMessageLength = 256 * 1024 }`; large buffers split into 256 KiB messages. Comment states the failure it prevents: the sender would otherwise wait for the *entire* buffer to compress, and the receiver for the entire message to arrive. The `write()` body documents the same "many messages coalesced in one tick → one 100 MB buffer" problem we have | Extra frames (6 B header each) + receiver reassembly | ✅ **Best cost/benefit.** No protocol change; directly attacks "one frame is too big to wait behind" |
| **Two-class dispatcher: drain interactive first** | rust-analyzer (MIT/Apache) | `crates/rust-analyzer/src/main_loop.rs`, `next_event` | `if let Ok(task) = self.fmt_pool.receiver.try_recv() { return Ok(Some(Event::Task(task))); }` **before** the `select!` over all receivers — comment: *"Make sure we reply to formatting requests ASAP so the editor doesn't block"* | A `try_recv` probe each loop turn; needs a designated interactive queue | ✅ Attacks the tail directly and needs no second transport |
| **Time-boxed background coalescing** | rust-analyzer | same file, `handle_event` | Every background branch drains with `while loop_start.elapsed() < Duration::from_millis(50) && let Ok(x) = rx.try_recv()`; progress notifications held to one `last_report` because *"sending progress reports serializes notifications on the mainthread"* | Bounded 50 ms starvation of the inbox per batch | ✅ Bounds the worst case rather than eliminating it |
| **Cooperative budget (forced yield)** | Tokio (MIT) | `tokio/src/task/coop/mod.rs`; applied in `tokio/src/io/util/copy.rs` `CopyBuffer::poll_copy` | `Budget::initial() = Budget(Some(128))`; `poll_proceed(cx)` → `Poll::Pending` at zero; `made_progress()` commits only if work happened. Docs name the starvation case verbatim (`while let Some(_) = input.next().await {}` "will never yield"). In `copy.rs`: `let coop = ready!(crate::task::coop::poll_proceed(cx));` per read/write iteration | Branch per iteration; yield points must live in *leaf* futures or work is double-counted; `task::coop::unconstrained` to opt out | ✅ Portable idea: count work, yield at a fixed budget |
| **`runtime.Gosched()` on small batches** | gRPC-Go (Apache-2.0) | `internal/transport/controlbuf.go`, `loopyWriter.run()` | `if l.framer.writer.offset < minBatchSize { runtime.Gosched(); continue hasdata }`, `const minBatchSize = 1000` — explicitly to let stream producers fill the batch | Yields even when nothing else is runnable (bounded by batch growth) | ⚠️ Rust side would want an equivalent; Rust has no direct `Gosched` — needs a yield point in the loop |
| **Yield with a macrotask, not a microtask** | Node.js (docs) / VS Code | [nodejs.org/api/timers.html](https://nodejs.org/api/timers.html); `src/vs/base/parts/ipc/common/ipc.net.ts` `BufferedEmitter` | `setImmediate` "Schedules the 'immediate' execution of the callback after I/O events' callbacks"; `timersPromises.scheduler.yield()` "equivalent to calling `setImmediate()`". VS Code's comment shows the deliberate split: *"it is important to deliver these messages after this call, but before other messages have a chance to be received … that's why we're using here queueMicrotask and not other types of timeouts"* | Microtasks do not admit I/O | ⚠️ **Important correction:** `await <resolved promise>` drains only microtasks, so "await between chunks" may **not** let I/O in. Treat as **unconfirmed** — no source validated plain `await` for this purpose |
| **Per-stream credit / window flow control** | SSH RFC 4254 §5.1–5.2; yamux (MPL-2.0); HTTP/2 RFC 7540 §5.2/§6.5.2/§6.9 | [rfc-editor.org/rfc/rfc4254.txt](https://www.rfc-editor.org/rfc/rfc4254.txt); [github.com/hashicorp/yamux](https://github.com/hashicorp/yamux) `spec.md`; [rfc-editor.org/rfc/rfc7540.txt](https://www.rfc-editor.org/rfc/rfc7540.txt) | SSH: `CHANNEL_OPEN` carries `initial window size` + `maximum packet size`; `CHANNEL_WINDOW_ADJUST` (93) adds credit; `CHANNEL_DATA` (94) consumes it — *"The maximum amount of data allowed is determined by the maximum packet size for the channel, and the current window size, whichever is smaller."* Directly on point: *"one might want to use smaller packets for interactive connections to get better interactive response on slow links."* yamux: 256 KB/stream, no session window. HTTP/2: `SETTINGS_INITIAL_WINDOW_SIZE` default **65,535**, `SETTINGS_MAX_FRAME_SIZE` default **16,384** | Extra control messages; per-stream state | ❌ **We already have this** (kkrpc credit 32/16, verified). It is what keeps p50 flat — it does not fix p95, as our own numbers show |
| **Round-robin across streams with a per-stream cap** | gRPC-Go | `internal/transport/controlbuf.go` | `loopyWriter` walks `activeStreams`; `processData()` writes `min(http2MaxFrameLen, strQuota, sendQuota)` then re-enqueues. Header: *"Loopy goes over this list of active streams by processing one node every iteration, thereby closely resembling a round-robin scheduling over all streams."* | 16 KB/stream/turn bounds HOL blocking but caps single-stream throughput | ✅ With one stream this degenerates to a cap — which is the same lever as §3.3 row 1 |
| **Separate non-throttled control class** | gRPC-Go | same file | `cbItem.isThrottled()`: headers/data `false`; settings/window-update/ping/RST `true`; throttled items count against `maxQueuedControlBufferItems` | Limits need tuning | ⚠️ Our interactive calls are *requests*, not control frames; the analogue is a priority class |
| **Weighted priority tree** | HTTP/2 RFC 7540 §5.3 | [rfc-editor.org/rfc/rfc7540.txt](https://www.rfc-editor.org/rfc/rfc7540.txt) | `PRIORITY` frame: `E` flag + 31-bit Stream Dependency + 8-bit Weight (+1 → 1..256); `HEADERS` may carry the same. *"Prioritization … ensures that limited resources can be directed to the most important streams first."* PING responses "SHOULD be given higher priority than any other frame" | Sender-advised only; RFC 9113 later deprecated the tree for the simpler urgency scheme | ⚠️ Concept is right; full tree is overkill for two classes |
| **Urgency classes** | Chromium (BSD-3) | `base/task/task_traits.h` | `enum class TaskPriority { BEST_EFFORT = LOWEST, USER_VISIBLE, USER_BLOCKING, HIGHEST = USER_BLOCKING }`; `BEST_EFFORT` = "Persisting data to disk", `USER_VISIBLE` = "Downloading a file requested by the user". Default `USER_BLOCKING` | Nothing may exceed `USER_BLOCKING` without scheduler-team coordination | ✅ Exactly the two-class model our pipe needs |
| **Distinct transport per purpose** | VS Code (MIT) | `src/vs/platform/remote/common/remoteAgentConnection.ts`; `src/vs/base/parts/ipc/node/ipc.net.ts` | `enum ConnectionType { Management=1, ExtensionHost=2, Tunnel=3 }`, each with its own `createSocket()` + `new PersistentProtocol({socket})`. Node IPC: `createRandomIPCHandle()` → `\\.\pipe\vscode-ipc-<uuid>-sock` (Win) / unix socket elsewhere; each accepted socket wrapped in its own `Protocol` | **Real lifecycle cost:** per connection 1 socket, 3 handshake messages (`auth`→`sign`→`connectionType`), 5 connect attempts, 30 s reconnect timeout, 3 h reconnection grace, 5 s keepalive, plus an unacked-message queue. Path-length caps (Linux 107 / macOS 103) | ✅ But this is the expensive option — see §3.5 |
| **Bulk bytes never traverse the control channel** | VRCX (MIT) | `Dotnet/ImageCache.cs:77-109`; `src-electron/main.js` | `GetImage` returns a **filesystem path string**, not bytes, after C# writes `Path.Join(AppDataDirectory,"ImageCache",fileId,$"{version}.png")` (`ImageCache.cs:85, 109`). Overlay frames go to shared memory `/dev/shm/vrcx_overlay` via `fs.writeSync` with a ready-flag byte | Cache dir management (evicts 1100→1000 LRU) | ✅ The "don't put the bytes on the chatty channel at all" escape hatch — see §3.6 |
| **Multiplexing alone does NOT fix this** | muxado (Apache) | [github.com/inconshreveable/muxado](https://github.com/inconshreveable/muxado) README | Verbatim: *"Any stream-multiplexing library over TCP will suffer from head-of-line blocking if the next packet to service gets dropped. muxado is also a poor choice when sending many large payloads concurrently. It shines best when the application workload needs to quickly open a large number of small-payload streams."* | — | ❌ **Explicit counter-warning to "just multiplex it"** |
| **Cancellation instead of flow control** | LSP `$/cancelRequest` | `vscode-languageserver-node` `connection.ts`; rust-analyzer `main_loop.rs`, `msg.rs` | `NotificationType<CancelParams>('$/cancelRequest')`; server cancels work for that id; codes `RequestCanceled = -32800`, `ContentModified = -32801`, `ServerCancelled = -32802` | Cooperative; **cannot preempt a message already physically in the pipe** | ❌ Does not help: the queueing is already in the pipe |

### 3.4 LSP specifically — the honest answer is that LSP does not solve it

Framing is `Content-Length: N\r\n\r\n` + N bytes UTF-8 JSON
(`lib/lsp-server/src/msg.rs`, `read_msg_text`/`write_msg_text`): the reader `read_exact`s the whole body
**before** dispatching, so a large message structurally blocks the ones behind it. Rust-analyzer uses
three named threads (`LspServerReader`, `LspServerWriter`, `LspMessageDropper`) on
`bounded::<Message>(0)` rendezvous channels, so back-pressure is implicit rather than explicit.

Moreover `vscode-languageserver-node`'s `ReadableStreamMessageReader.onData` **deliberately serialises**
decode with `this.readSemaphore.lock(...)` — its comment explains that otherwise a small message could
finish decoding before a large earlier one and be delivered out of order. **That is the opposite of
priority.**

LSP/JSON-RPC has **no** flow control, **no** priority, **no** stream multiplexing — `ConnectionOptions`
offers only `cancellationStrategy`, `connectionStrategy`, `messageStrategy`, `maxParallelism`. Real
implementations cope by (a) `$/cancelRequest`, (b) never putting bulk bytes in one message —
rust-analyzer sets `save_options: SaveOptions { include_text: Some(false) }` so the client must not ship
document text on save — (c) threadpools for heavy handlers, (d) deferring background work until
`is_quiescent()`. **I found no implementation that streams a large file payload over LSP itself —
unconfirmed whether any do.**

### 3.5 What the extra transport actually costs (the number that decides (a) vs (b))

The task asked for the lifecycle cost of a second channel. From VS Code's remote-connection
implementation, one logical connection costs: **1 socket**, a **3-message handshake**
(`auth` → `sign` → `connectionType`), **5 connect attempts**, a **30 s reconnect timeout**, a **3 h
reconnection grace period**, a **5 s keepalive timer**, and an **unacked-message queue**. On the Rust
side we would additionally have to create, own, monitor and tear down a second fd/pipe as part of the
existing `host.rs` spawn/watch/relaunch state machine (`src-tauri/src/host.rs`, which already tracks
`SpawnFailure::{Retry, StdioLost}` and `HOST_STDIO_LOST_EXIT = 52`).

Our own docs reached the same conclusion independently: `docs/hands-capability-proposal.md:270` lists
option (a) as "壳要开第二个 fd / socket；生命周期与现管道一并管" and conditions it on **cross-machine
tail data we do not yet have**.

### 3.6 Does VRCX do bulk file/image work, and does it separate it from chatty calls?

**Yes to bulk, and it separates it by mechanism in some paths — but not in all.** I verified each cited
path exists in `refs/remotes/VRCX/master`, and read the two load-bearing ones myself.

| Path | What it does | Separation? |
|---|---|---|
| `Dotnet/ImageCache.cs:77-109` | `public static async Task<string> GetImage(string url, string fileId, string version)` — C# downloads via `HttpClient` and **returns `fileLocation`, a path string** (line 85, 109); `SaveImageToFile` at `:112` | ✅ **Bulk bytes never cross the bridge** |
| `Dotnet/Cef/CefService.cs:48-58` | Custom scheme `new CefCustomScheme { SchemeName = "file", DomainName = "vrcx", SchemeHandlerFactory = new FolderSchemeHandlerFactory(Path.Join(Program.BaseDirectory,"html"), "file", defaultPage:"index.html"), IsLocal = true }` → renderer fetches app assets over `file://vrcx/…` | ✅ Separate transport from binding calls |
| `Dotnet/Cef/JavascriptBindings.cs` | `ApplyAppJavascriptBindings` registers whole service objects (`AppApi`, `WebApi`, `VRCXStorage`, `SQLite`, `LogWatcher`, `Discord`, `AssetBundleManager`) into the page | The chatty surface is object-level interop |
| `src-electron/InteropApi.js:1-31` + `src-electron/main.js:123-125` + `src-electron/preload.js:30-34` | `contextBridge` `callDotNetMethod` → `ipcMain.handle('callDotNetMethod')` → `new (require('node-api-dotnet/net10.0').VRCX[className]())[methodName](...args)`, instances cached per class in `this.createdObjects` | ✅ Linux/Electron calls .NET **in-process**, no marshalling |
| `src-electron/main.js:103-109` | `OVERLAY_SHM_PATH = '/dev/shm/vrcx_overlay'`; `fs.writeFileSync(...)` + `fs.writeSync` with a ready-flag byte | ✅ **Shared memory**, not IPC |
| ⚠ `Dotnet/AppApi/Common/AppApiCommon.cs:162-170` | `GetFileBase64(string path) => Convert.ToBase64String(File.ReadAllBytes(path))` — exposed to JS as `GetFileBase64(path): Promise<string \| null>` (`src/types/globals.d.ts:215`), used at `src/views/Tools/ScreenshotMetadata.vue:665` | ❌ **Bulk bytes DO cross the chatty bridge as base64 here** |
| ⚠ `Dotnet/WebApi.cs:459-482` | The VRChat-API proxy inspects `Content-Type`; for `image/` or `application/octet-stream` it reads all bytes and returns `$"data:image/png;base64,{Convert.ToBase64String(imageBytes)}"` over the same Tuple<int,string> reply path (consumed e.g. at `src/components/FullscreenImagePreview.vue:311`) | ❌ **Image bytes DO cross the bridge as base64 data URLs** |
| ⚠ `src/api/vrcPlusImage.js` | Upload path passes `imageData` as a request parameter (`request('file/image', { uploadImage: true, …, imageData })`; `request('prints', { uploadImagePrint: true, …, imageData })`) | ❌ Upload bytes cross the bridge |

⚠ **Correction to the delegated VRCX findings:** the research pass reported it could not find
`GetFileBase64` and therefore treated "never bytes over the bridge" as unconfirmed. **I found it** —
it exists at `Dotnet/AppApi/Common/AppApiCommon.cs:162-170` and is reachable from the UI. So the
accurate statement is: **VRCX uses paths/shared-memory/in-process calls for the hot cached-image and
overlay paths, and base64-over-the-bridge for API-proxied images, file reads and uploads. It has both,
not one.**

⇒ **VRCX is a useful precedent for the *avoidance* strategy (don't put bytes on the chatty channel)
but is not a precedent for *scheduling* bulk against interactive traffic, because it never had to
share one saturated channel in the first place.**

---

## 4. Q3 — resource lifetime tied to a plugin/module

### 4.1 The Cordis mechanism, read from the installed source

Cordis version/licence, `node_modules/cordis/package.json`: `"version": "4.0.0-rc.9"`,
`"license": "MIT"`. Implementation read in `node_modules/cordis/lib/index.js`.

| Element | Finding | Location |
|---|---|---|
| Per-fiber disposer store | `class Fiber { … _disposables = new DisposableList(); }` | `lib/index.js:783` |
| The store's backing map | `class DisposableList` holds `map = new Map()` (**strong** refs) plus `weak = new WeakMap()` used only as an index for `delete(value)` | `lib/index.js:9-41` |
| Push returns a remover | `push(value)` → `return () => this.map.delete(sn)` | `lib/index.js:19-24` |
| Clear runs **reverse-insertion** order | `clear() { const values = [...this.map.values()]; this.map.clear(); return values.reverse(); }` | `lib/index.js:30-34` |
| Registering an effect | `effect(execute, label = "anonymous")` — begins with `this.assertActive()`; each disposer is also pushed onto `this._disposables` and tagged with `symbols.effect` metadata | `lib/index.js:844-897` |
| Per-effect disposer order | `for (const dispose2 of disposables.splice(0).reverse())` — same reverse rule inside one effect | `lib/index.js:849` |
| Double-dispose guard | `wrapper`/`disposeAsync` both early-return `if (!runner.epoch) return;` | `lib/index.js:882-891` |
| Error isolation | Each disposer is awaited inside `try/catch` that **logs** rather than aborting — `this.ctx.logger.error(reason)` | `lib/index.js:981-992` |
| Unload = await all disposers | `async _unload() { await Promise.all(this._disposables.clear().map(async (dispose) => { … await dispose(); })) }` — note the deliberate `await Promise.resolve()` before each disposer so pending microtasks land first | `lib/index.js:981-988` |
| Unloading is a distinct state | `FiberState { PENDING=0, LOADING=1, ACTIVE=2, FAILED=3, DISPOSED=4, UNLOADING=5 }` | `lib/fiber.d.ts` |
| Registering on a dead fiber **throws** (loud, not silent) | `assertActive() { if (this.uid !== null) return; throw new CordisError("INACTIVE_EFFECT"); }`, code text `"cannot create effect on inactive context"` | `lib/index.js:797-800`, `:687` |
| `ctx.on()` is itself an effect | `on(name, listener, options)` begins with `this.ctx.fiber.assertActive()` and ends by registering through the fiber | `lib/index.js:355-365` |
| Teardown happens at root-fiber granularity | Root disposal is `root._disposables.clear()` performed **explicitly by us** | `host/src/lifecycle.ts:104-114` |

**The pivotal structural fact** (`lib/index.js:691-728`): a `Fiber` is built with `this.uid = parent.registry.counter` only when `runtime` is truthy. The **root** fiber is created with `runtime === null`, so it gets **no uid** and is **absent from `registry`**. That is exactly why root-context effects are invisible to plugin unload. Our own code documents this at `host/src/lifecycle.ts:7-16`: *"The root fiber's `dispose()` is `() => this.restart()`… so we do NOT call it. Instead we dispose every child fiber explicitly and finally clear the root fiber's `_disposables`."*

### 4.2 What our probes already measured (the strongest evidence for this project)

These are local, reproducible measurements rather than survey claims:

| Finding | Evidence |
|---|---|
| A `ctx.effect()` created **inside a Service method** binds to the **caller's** fiber | `docs/hands-host-design.md:135`, probe `docs/probes/probe-host-stream-lifecycle.ts` |
| Unloading the plugin **does** run that disposer, and it **does** stop the stream (`chunksAfterUnload = 0`) | `docs/hands-host-design.md:136-137`, probe `docs/probes/probe-host-stream-leak.ts` (arm B) |
| **Without** the guard, unload leaks: the stream produced **16 more chunks after the plugin was unloaded** | `docs/hands-host-design.md:119-122` (arm A: `chunksAfterUnload=16 disposerRan=false halted=false`) |
| `ctx.effect` **returns** a disposer that can be released early | `docs/hands-host-design.md:138`, probe `docs/probes/probe-host-effect-economy.ts` |
| **Registrations accumulate**: 1000 per-stream registrations all survived until unload | `docs/hands-host-design.md:142-143`; `docs/probes/README.md:251` |
| Root-context effects do **not** run on plugin unload — but **do** run on graceful shutdown; and **never** on a hard kill | `docs/hands-host-design.md:162-166`; `host/src/lifecycle.ts:104-114` |

Run them with `bun run docs/probes/probe-host-stream-leak.ts` (also
`probe-host-stream-lifecycle.ts`, `probe-host-effect-economy.ts`, `probe-host-root-effect-shutdown.ts`)
— commands from `docs/probes/README.md:253-257`.

### 4.3 Mechanism table

| Mechanism | Project / system | Where I saw it | How it ties resource to owner | Known failure modes |
|---|---|---|---|---|
| **Force-cleared per-owner `DisposableStore`** | VS Code (MIT) | `src/vs/workbench/api/common/extHostExtensionService.ts` (~`:489` `const extensionInternalStore = new DisposableStore(); // disposables that follow the extension lifecycle`; `_callActivate` returns `new ActivatedExtension(…, toDisposable(() => { extensionInternalStore.dispose(); dispose(context.subscriptions); }))`; `_deactivate()` calls `extension.disposable.dispose()` **unconditionally** after `deactivate()`, under a `Promise.race([timeout(5000), extensionsDeactivated])`); `src/vs/base/common/lifecycle.ts` | `context.subscriptions` is a plain array the **host** force-disposes; the extension is never trusted to clean up itself | `DisposableStore.add()` on an already-disposed store **warns and drops** the disposable — *"The added object will be leaked!"*; `Cannot register a disposable on itself!` throws; `clear()` uses try/finally so one throwing disposer doesn't block others, but ordering is Set-insertion order (not reverse); `collectLeakingDisposables` exists because leaks are expected |
| **`Fiber` + `ctx.effect()` disposer list** | cordiverse/cordis (MIT) | `packages/core/src/fiber.ts`, `events.ts`, `registry.ts`, `reflect.ts`, `utils.ts`, `context.ts`; **and locally** `node_modules/cordis/lib/index.js` as tabulated in §4.1 | Every side effect is an effect on the owning fiber; `ctx.on`/`ctx.provide`/`ctx.accessor`/`ctx.mixin` are internally `fiber.effect(...)`; unload is `registry.delete() → runtime.fibers → fiber.dispose()`, which awaits `this.inertia` | `_unload()` uses `Promise.all` over async wrappers → **completion** order not guaranteed (only start order, reverse-insertion); `effect()` on a dead fiber throws `INACTIVE_EFFECT`; **root-context effects are invisible to plugin unload** (see §4.4 F2) |
| **`FinalizationRegistry` / `WeakRef`** | Node.js / MDN | [nodejs.org/api/globals.html#class-finalizationregistry](https://nodejs.org/api/globals.html#class-finalizationregistry), [MDN FinalizationRegistry](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/FinalizationRegistry), [MDN WeakRef](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WeakRef) | Ties to **unreachability**, not to an owner — an in-flight stream is strongly reachable, so this never fires | *"A conforming JavaScript implementation … is **not required to call cleanup callbacks**"*; *"When and whether it does so is entirely down to the implementation"*; likely no call "When the JavaScript program shuts down entirely"; the held value is a **strong** ref (`register(x, x)` leaks); WeakRef target is cleared at/before the callback so `deref()` is `undefined` |
| **RAII / `Drop`** | Rust std | [doc.rust-lang.org/std/mem/fn.forget.html](https://doc.rust-lang.org/std/mem/fn.forget.html), [std/rc/struct.Rc.html](https://doc.rust-lang.org/std/rc/struct.Rc.html) | Ownership *is* the scope; scope exit runs the destructor deterministically | `mem::forget` — *"without running its destructor … will linger forever"*; the doc names the escapes itself: *"a program can create a reference cycle using `Rc`, or call `process::exit`"*; *"You cannot return a value and expect that the caller will necessarily run the value's destructor"*; `Rc::new_cyclic` — self-referencing cycles *"should not hold a strong reference to itself to prevent a memory leak"*; `forget` can cause a **double free** on a panic; `ManuallyDrop` *"errs on the side of leaking instead of … (double-)dropping"* |
| **`IDisposable` / `using` / `IAsyncDisposable`** | .NET | [Implement a Dispose method](https://learn.microsoft.com/en-us/dotnet/standard/garbage-collection/implementing-dispose), [Implement a DisposeAsync method](https://learn.microsoft.com/en-us/dotnet/standard/garbage-collection/implementing-disposeasync) | *"If your class owns an instance of another type that implements IDisposable, the containing class itself should also implement IDisposable"*; `using` / `await using` scopes | **Async-only trap** (Caution box): *"If a class implements IAsyncDisposable, but not IDisposable, and a consumer only calls `Dispose` … This would result in a resource leak."*; finalizer path is non-deterministic (`disposing == false`) and finalization order is non-deterministic; `Dispose` must be idempotent (`Interlocked.CompareExchange(ref _isDisposed, 1, 0) == 0`); **stacked `await using`** — a constructor throw means *"neither object is properly disposed of"*; `GC.KeepAlive` exists because a finalizer can run while unmanaged refs are still in use |
| **Structured concurrency (lexical scope / nursery)** | Kotlin, Trio | [Kotlin `coroutineScope`](https://kotlinlang.org/api/kotlinx.coroutines/kotlinx-coroutines-core/kotlinx.coroutines/coroutine-scope.html), [Kotlin `Job`](https://kotlinlang.org/api/kotlinx.coroutines/kotlinx-coroutines-core/kotlinx.coroutines/-job/), [Trio reference-core](https://trio.readthedocs.io/en/stable/reference-core.html) | The scope **is** the owner's lifetime; *"whenever the caller gets cancelled, so does the new scope"* | Kotlin documents **"Pitfall: returning closeable resources from a lexically scoped coroutine"** — a resource obtained in-scope and returned out is **not** covered; Trio's cancellation is level-triggered (all cancellable ops in a cancelled block keep raising), given as the explicit fix for "cleanup hangs forever"; async cleanup *"still perform[s] a minimum level of cleanup before raising Cancelled"*; `shield=True` is the escape hatch |
| **`AbortSignal` / cancellation token** | WHATWG/MDN + Node | [MDN AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal), [nodejs.org/api/globals.html#class-abortsignal](https://nodejs.org/api/globals.html#class-abortsignal) | The signal is passed into the operation (`fetch(url, { signal })`); `abort()` fires one event; `AbortSignal.any()` links a child to an owner's signal | *"An AbortSignal can only be used once"* — no reset, so a pooled owner scope cannot reuse one; listeners *"should use the `{ once: true }` option … Failure to do so may result in memory leaks"*; cancellation is **cooperative** — a resource that never checks the signal is not stopped |

### 4.4 Is "register cleanup on the owner's lifecycle scope" the common answer?

**Yes — it is the dominant pattern in every system surveyed, but no mature system relies on it alone.**
Each adds a *forced* host-side path:

- **VS Code** does not trust `deactivate()`: afterwards it calls `extension.disposable.dispose()`
  unconditionally and disposes `context.subscriptions` itself.
- **Cordis** never asks a plugin to unsubscribe: `ctx.on()` *is* `fiber.effect(...)`, and unload is
  `registry.delete() → fiber.dispose()`.
- **Rust / .NET** make ownership the scope (no registry at all).
- **Structured concurrency** makes the scope *be* the owner's lifetime.

The real differentiator is whether the host holds a **strong, enumerable, per-owner registry that it
force-clears**. Registering into a container nobody iterates is the failure mode, not the fix.

**Enumerated failure modes, each with a real citation:**

- **F1 — Leak when the resource outlives the owner, or the disposer list itself is retained forever.**
  Cordis `DisposableList.map` is a strong `Map<number, T>`; its `WeakMap` is *only* an index for
  `delete(value)` (`lib/index.js:9-41`). **Measured in this repo:** 1000 stream registrations all
  survived to unload (`docs/hands-host-design.md:142-143`). Mitigation in our design: each stream must
  release its own registration when it ends — `const release = this.ctx.effect(…)` then call `release`
  on end *and* on cancel (`docs/hands-host-design.md:145-155`, which warns "不释放的话，护栏自己变成一个
  无界增长的表 —— 与它要防的泄漏同一量级").
- **F2 — Cleanup that never runs (root-scope registration).** Cordis builds the root `Fiber` with
  `runtime === null`, so it has no uid and is absent from `registry` (`lib/index.js:691-728`); root
  effects are reached only by an explicit shutdown step (`host/src/lifecycle.ts:104-114`).
  Kotlin names the same shape as the lexical-scope closeable pitfall.
- **F3 — Cleanup that never runs (process killed).** Rust's `mem::forget` doc names `process::exit`.
  Our own environment finding: on Windows `SIGTERM`/`SIGINT` are not delivered (`kill()` is a hard
  `TerminateProcess`), so signal-handler cleanup is dead code —
  `docs/shutdown-strategy-review.md` and `docs/shutdown-and-persistence-findings.md`. Cordis `_unload`
  awaits `this.inertia`, but a hard kill never reaches it.
- **F4 — Cleanup that never runs (non-deterministic GC).** MDN `FinalizationRegistry`: not required to
  call callbacks at all, and none on program shutdown. An in-flight stream is strongly reachable, so
  this path never fires.
- **F5 — Silent no-op (registered where nothing iterates it).** VS Code's `DisposableStore.add()` on a
  disposed store **warns and drops** it (*"The added object will be leaked!"*). Cordis instead **throws**
  (`INACTIVE_EFFECT`) — a loud failure, strictly better. The Cordis *root* case is the silent variant.
- **F6 — Double-dispose / dispose-after-free races.** .NET: idempotent `Dispose` +
  `Interlocked.CompareExchange`; `SafeHandle` *"guarantees that `ReleaseHandle` is called only once"*.
  VS Code: `FunctionDisposable` `_isDisposed` guard. Cordis: both `wrapper()` and `disposeAsync()`
  guard on `!runner.epoch`, and `Fiber.dispose()` awaits `this.inertia` so a second dispose awaits
  rather than races (`lib/index.js:882-891`). `AbortSignal` is single-use by spec, which avoids
  double-abort but makes signal reuse a bug.
- **F7 — Async disposal racing with in-flight reads.** Cordis's async-iterable branch captures
  `oldEpoch` and re-checks `if (runner.epoch !== oldEpoch) return` before each `iter.next()`, and
  `_unload` does `await Promise.resolve()` first so pending microtasks land before disposers run
  (`lib/index.js:981-988`). VS Code's `thenRegisterOrDispose(promise, store)` is the explicit
  resolution: if the promise settles after the store was disposed, the new disposable is **disposed**
  instead of registered. **Local symptom of getting this wrong:** the stream produced 16 chunks after
  plugin unload (`docs/hands-host-design.md:119-122`).

---

## 5. Recommendations

### Q1 — URL scheme

1. **Do not claim `vrchat://` by default.** The incumbent app we are permitted to learn from
   registered `vrcx` and treated `vrchat://` as a foreign scheme it *forwards* to VRChat's launcher
   pipe (§2.3). Claiming it would be a new product decision with real collision risk.
2. **Register our own scheme, and pick the string deliberately** — e.g. `vrcxk://` if we want to
   coexist with a user's installed VRCX. ⚠ Note `vrcx://` is *already taken by VRCX* on any machine
   where it is installed; two apps writing `HKCU\Software\Classes\vrcx` will fight.
3. **Reuse the shape VRCX proved out**, because it is simple and needs no admin:
   `HKCU\Software\Classes\<scheme>` with `"" = "URL:<scheme>"`, `"URL Protocol" = ""`,
   `FriendlyTypeName`, `DefaultIcon`, `shell = open`, and
   `shell\open\command = "<exe>" /uri="%1"`; delete the key on uninstall.
4. **Declare the scheme in `tauri.conf.json`** — we currently have none (§2.6), which is why
   macOS/Android/iOS cannot work. Windows/Linux can register at runtime via
   `shell.deepLink.register` (`src-tauri/src/shell_sys.rs:282-299`).
5. **Keep the second-launch path we already have** (`lib.rs:172-197` → `forward_deep_link` →
   `deepLink.opened`), since VRCX needed *two different* mechanisms (a per-user named pipe on Windows,
   `requestSingleInstanceLock` on Electron) and we get one from `tauri-plugin-single-instance`.

**Explicitly NOT confident about:** whether `vrcx://` currently registered by an installed VRCX would
be overwritten by our installer or vice versa (registry-last-writer-wins, untested); whether VRCX's
macOS build registers any scheme (unconfirmed); and how VRCX actually parses an inbound `vrcx://`
path on Windows (unconfirmed, §2.2).

### Q2 — bulk vs interactive

The measured facts constrain this sharply: **p50 is fine (1.28x), only the tail is bad (51x), and the
cause is not separated** between pipe queueing and peer busyness (`hol.mjs` says so explicitly).

1. **Do the cheap things first — they are unconditionally correct and cost nothing architecturally:**
   - **Cap and split writes** (§3.3 row 1, VS Code's 256 KiB). Our current behaviour lets one frame be
     large enough that "wait for one frame" *is* the tail.
   - **Make the yield a macrotask, not a microtask.** ⚠ Do **not** assume `await somePromise` between
     chunks lets I/O in — that is **unconfirmed** and the sources point the other way (§3.3 row 6).
   - **Add a two-class dispatcher:** drain interactive work before bulk (rust-analyzer `next_event`'s
     `try_recv`-before-`select!`).
2. **Do not build a second transport yet.** Option (a) costs a socket, a handshake, reconnect and
   keepalive state, plus ownership in `host.rs`'s existing spawn/watch/relaunch machine (§3.5), and our
   own docs already gate it on cross-machine tail data we do not have
   (`docs/hands-capability-proposal.md:270`; `docs/hands-host-design.md:268`).
3. **Before choosing, separate the cause.** The single highest-value next experiment is not a new
   channel — it is distinguishing *queueing* from *peer busy*, which `hol.mjs` is already instrumented
   to do (its `control` block re-measures after the load). These have **different fixes**: queueing →
   priority/cap; peer-busy → make per-chunk work cheaper. Until that is separated, a second channel may
   buy nothing.
4. **Prefer the avoidance strategy VRCX demonstrates** for anything large and cacheable: return a
   **path** (`ImageCache.GetImage`) and let a separate scheme serve it, rather than base64 over the
   bridge. ⚠ We already pay base64 on the Rust side: `docs/hands-host-design.md:46` records that chunks
   arriving at the host are **base64 strings, not bytes**, so the host must decode — that is per-chunk
   CPU on the exact thread that also answers interactive calls, i.e. a plausible contributor to the
   unseparated "peer busy" cause. Checking that is cheap.
5. **Note the honest counter-example:** muxado's README states multiplexing alone does **not** fix
   bulk-vs-interactive and can make it worse (§3.3 last row). "Just multiplex the pipe" is not a plan.

**Explicitly NOT confident about:** whether the 51x tail is queueing or peer busyness (unmeasured);
what the cross-machine tail actually is (local pipe is a lower bound); whether chunk-size reduction
helps or merely trades frame overhead for latency; and whether the delegated survey's non-VRCX
upstream files were read as accurately as reported — I verified only the VRCX paths and the shipped
`kkrpc` bundle myself (§6).

### Q3 — plugin resource lifetime

1. **Keep `this.ctx.effect(...)` inside the Service method — it is confirmed to bind to the caller's
   fiber** (`docs/hands-host-design.md:135`) and to actually stop the stream on unload (arm B,
   `chunksAfterUnload=0`). This is the right primitive and it matches Cordis's own design intent.
2. **Always release the registration when the stream ends** — on end *and* on cancel (F1, measured:
   1000 registrations retained). Otherwise the guardrail becomes the leak.
3. **Decide §4.2 (a)/(b)/(c) before letting the host call `ctx.hands`.** A host-side call lands on the
   **root** ctx, where plugin unload will never reclaim it (F2, measured) — it lives until graceful
   shutdown and survives a hard kill entirely. Our own doc leaves this open
   (`docs/hands-host-design.md:174-182`).
4. **Do not use GC-based cleanup as the reliability mechanism** (F4). An in-flight stream is strongly
   reachable, so `FinalizationRegistry` will not fire at all — it is not a backstop here.
5. **Make double-dispose structurally impossible, not merely guarded** (F6). Cordis already guards
   (`!runner.epoch`) and serialises via `inertia`; the same discipline should hold in `hands.ts`.
6. **The regression tests already specified are the right ones** and should land with the
   implementation: leak regression (start stream → unload plugin → assert stream stops) and
   registration-does-not-accumulate (`docs/hands-host-design.md:256-260`).

**Explicitly NOT confident about:** whether `_unload`'s `Promise.all` gives any *completion* ordering
guarantee (start order is reverse-insertion; completion is not guaranteed — flagged by the delegated
pass, and consistent with the code I read at `lib/index.js:981-992`); how Koishi (as distinct from
Cordis) handles disposal — the delegated pass could not fetch `koishi.chat` docs, so **nothing about
Koishi is confirmed**; and whether Cordis's root-context behaviour is intended-by-design or an
oversight (the source shows a deliberate `_disposables.clear()` in the root constructor, which reads as
intentional).

---

## 6. Coverage statement

**Which sources were read, and by whom**, is summarised in the two evidence classes
described at the top of this document (§ "A note on the two evidence classes") and the
provenance table in §0. That summary is the contract; the exhaustive file-by-file
inventory that used to sit here was **removed**, because it duplicated §0 and grew with
every fetch without changing any conclusion. The rule that matters is short:

- **Read directly by this session**: the VRCX ref objects, working-tree files, and
  `node_modules` sources. These back Q1 and the VRCX/SDK parts of Q2/Q3.
- **Read by a delegated pass over the network**: the cross-project survey (VS Code,
  rust-analyzer, tokio, gRPC, LSP, Chromium, RFCs). The **VRCX paths** it cited were
  verified to exist in the ref, but the non-VRCX files were **not** independently
  re-fetched.

**Failed, unavailable, or could not be confirmed:**

| Source | Status |
|---|---|
| `github.com/docker/pinata` | **404** via REST API *and* raw README; `docker`-org search for `pinata` → `total_count: 0`; no public `docker/desktop` repo. ⇒ Docker Desktop's control-vs-data-plane split is **verified only at documentation level**, not at code level. **Unconfirmed at code level.** |
| `docs.docker.com/desktop/features/`, `/features/file-sharing/` | **404** |
| `moby/vpnkit` (public, Apache-2.0) | Read, but it is the HyperKit-era networking component — **not** the modern file-sharing data plane. Does not answer the question. |
| `grpc/grpc` `doc/flow-control.md` | **404** |
| `moby/moby` `pkg/stdcopy/stdcopy.go` | **404** |
| `chromium.googlesource.com` `?format=TEXT` | fetch failed (base64 wrapper); the `chromium/chromium` GitHub mirror was used instead |
| `docker/roadmap` issue 7 via API | fetch failed |
| `koishi.chat` docs | **fetch failed** ⇒ **nothing about Koishi is confirmed**; all plugin-lifecycle facts are from Cordis source |
| `vscode.d.ts` (`context.subscriptions` published contract) | fetch failed twice; VS Code behaviour is read from **implementation source only**, not the published API doc |
| VS Code line numbers | quoted from `main`-branch raw text; `extHostExtensionService.ts` was **truncated mid-file** during fetch, so the cited line numbers are approximate. **Pin a tag/commit before treating them as stable.** |
| `web_search` in the delegated sessions | unavailable (no `DEEPSEEK_API_KEY`); discovery was by direct primary-source fetch only, so coverage is **not exhaustive** — absence of a project from §3.4/§4.3 is not evidence it does not exist |
| Firefox IPC priority scheduling | not investigated — **unconfirmed** |
| Chromium **Mojo** message priorities | read `message_pipe.h` / `data_pipe.h`: these are **capacity/back-pressure** primitives, not priority classes. Mojo-level priorities **unconfirmed** |
| HTTP/2 priority in current practice | RFC 7540 §5.3 read; **RFC 9113** (which deprecates the dependency tree for the urgency scheme) **not fetched** ⇒ "current state" **unconfirmed** |
| Swift task cancellation | not fetched — **unconfirmed** |
| .NET `CancellationTokenSource` linked to an owner (as distinct from `AbortSignal`) | not fetched — **unconfirmed** |
| Node-specific `WeakRef` section | the `#class-weakref` anchor resolves to `globals.html`; quoted WeakRef text is from **MDN**, not a Node-specific section |
| Whether any LSP implementation streams large payloads over the protocol | no evidence found either way — **unconfirmed** |
| macOS scheme registration in VRCX | no `CFBundleURLTypes`/`Info.plist` scheme declaration found — **unconfirmed** |
| How VRCX parses an inbound `vrcx://` path on Windows | **unconfirmed** (§2.2) |
| Whether our `vrcx://` would collide with an installed VRCX's registry key | **untested** |

**Not read, by policy:** the `vrcx-0` / Map1en lineage (GPL — GPL-lineage, not inspected), and
everything under `docs/legacy-recon/`.
