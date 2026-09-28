# mac-deeplink — how macOS hands a custom-scheme URL to an app, measured

> **Scope**: one narrow question, measured. macOS **26.6.2** (Darwin 25.6.0, **arm64**),
> Xcode CLT `Apple clang 21.0.0`, driven **over SSH** (ssh user == console user, `gui/501` reachable).
> **Date**: 2026-09-28 · measured from branch `docs/issue-41-deep-link-decisions`, for issue #41.
> **Why this is in the repo**: #41's acceptance criteria require a **macOS real-device check**
> for `plugins.deep-link.desktop.schemes`, and [`../../deep-link-decisions.md`](../../deep-link-decisions.md)
> §5/§8 cites this. (AGENTS.md §临时工作区 → 转正触发点.)
> **Run it**: `ssh mac 'bash -s' < docs/probes/mac-deeplink/run.sh`
> — needs only `clang` + `python3` (both from Xcode CLT). **No Rust, no bun, no Tauri.**
> It self-cleans on exit (kills the app, `lsregister -u`, removes the bundles).
> `PROBE_ROOT=... run.sh` overrides where the bundles are built (that is finding §0.7).

## 0. Answer table

| # | Question | Answer | How it was measured |
|---|---|---|---|
| 1 | Does a scheme declared via `CFBundleURLTypes` actually reach a running app? | **Yes** | Bundle + `lsregister -f` + `open "scheme://…"` → the app logged the URL |
| 2 | Which receive path is used — **argv**, **Apple Event**, or the **NSApplication delegate**? | **Apple Event `kAEGetURL`**, which `NSApplication` forwards to the **delegate's `application:openURLs:`**. **argv is never used.** | A plain C URL handler logged `argc=1` (no URL) three times while `open` reported success; an ObjC/AppKit app logged `PATH-B delegate openURLs url=…` |
| 3 | Is the **delegate** path (the one Tauri/WRY turns into `RunEvent::Opened`) the one that fires? | **Yes** — measured with **no** Apple Event handler installed | Mode A of the probe installs nothing; `PATH-B delegate` fired |
| 4 | Can delivery be **driven and observed over SSH**? | **Yes, if the SSH user owns the console session** (`launchctl print gui/<uid>` reachable). `open -a` launches into the GUI session and a full `NSApplication` runs there | §2 run 1: `gui/501 domain: reachable`, app reached `didFinishLaunching`, URL delivered |
| 5 | Is **`open`'s exit status** evidence that the URL was delivered? | **No — both directions measured.** exit 0 with nothing delivered (§3.1), and non-zero while the claim exists (§3.2) | plain C handler; `/tmp` run |
| 6 | Is a **shell-script** `CFBundleExecutable` a usable URL handler? | **No.** `-10669` when the bundle is otherwise launchable, `-10814` when it is not | control section of the probe |
| 7 | Does a **hyphen** in the scheme name break registration? | **No** (the guess that motivated the check was **wrong**) | `claimed schemes: … vrcxkprobe-hy:` |
| 8 | Does the **bundle's location** matter? | **Yes.** Same script, bundles under `/tmp`: LaunchServices records the claim, `open` fails `-10814`, URL never delivered. Under `$HOME`: delivered | §2 run 1 vs run 2 (`PROBE_ROOT=/tmp/…`) |
| 9 | Does the **Tauri bundler** turn `plugins.deep-link.desktop.schemes` into a real `CFBundleURLTypes`? | **Yes — measured on a real `tauri build`** (`CFBundleURLSchemes = [vrcxkscratch]`, `CFBundleURLName = "com.vrcxk.app vrcxkscratch"`). This half was previously **source-read only** | §5, `run-real-app.sh` |
| 10 | Does the **full chain** work on real hardware — macOS → shell → kkrpc/stdio → host? | **Yes.** `open "vrcxkscratch://hello?a=1"` from an SSH session → the host logged `[probe] deepLink.opened received urls=["vrcxkscratch://hello?a=1"]` | §5 |
| 11 | Does the same hold on **Windows**, where the launch URL arrives as **argv**? | **Yes — after a fix.** Windows/Linux deliver it inside the deep-link plugin's own setup, which Tauri runs *before* the app's `.setup()` registers `on_open_url`, so the URL was emitted into an empty listener set. Draining `get_current()` after registering fixes it; measured: `deepLink.opened vrcxk://user/usr_1` at **6 ms after `ready`**, plus the warm case (§7) | §7 |
| 12 | What is **still unverified**? | (a) the **installer's own** registry write and (b) the `NSIS_HOOK_POSTUNINSTALL` runtime behaviour — both blocked on this machine by a context that refuses installer writes (a 20-line NSIS installer reproduces it; another unsigned NSIS installer on the same box installed fine, so it is not NSIS and not "unsigned"). Everything else — scheme declaration, bundler output, LaunchServices/registry claim, cold + warm delivery on macOS **and** Windows, and the incumbent VRCX's key staying byte-identical — is measured. Also unmeasured: `LSUIElement`/second-instance details (§0.9) | §6.3, §7.1 |

## 1. What the probe does

`run.sh` builds two tiny AppKit apps from one source file and measures them **separately**:

- **Mode A — delegate only.** No Apple Event handler is installed, so the only way the URL can
  arrive is `application:openURLs:`. **This is the path Tauri/WRY uses** (it maps to
  `RunEvent::Opened`), so it is the mode that matters for #41.
- **Mode B — hand-installed `kAEGetURL` handler.** The shape a hand-rolled macOS deep-link app uses.

Measuring only Mode B would be the classic false positive: it would show "delivery works" while
saying nothing about the path production actually uses. Both modes are asserted, and the probe
**exits non-zero** if any check fails.

It also carries two controls, because both are silent-failure shapes:

- a **script-executable bundle** (must be refused), and
- a **location A/B** (`PROBE_ROOT=/tmp/…`), which is how §0.8 was found.

## 2. Raw output

### Run 1 — default root (`$HOME/.vrcxk-mac-deeplink-probe`)

```
=== environment ===
26.6.2
arm64
ssh user=test uid=501 console user=test
gui/501 domain: reachable

=== control: a SCRIPT-based bundle executable ===
  PASS control: script-executable bundle is refused (cannot be a URL handler)
       _LSOpenURLsWithCompletionHandler() failed with error -10669 for the URL vrcxkprobecontrol://x.

=== scheme-name shape: does a hyphen survive registration? ===
  PASS hyphenated scheme 'vrcxkprobe-hy' is claimed by LaunchServices

=== A: delegate-only (the path Tauri/WRY uses: RunEvent::Opened) ===
  PASS delegate: LaunchServices claims vrcxkprobedel:
  PASS delegate: 'open vrcxkprobedel://hello?a=1' returned 0
  PASS delegate: URL delivered via 'PATH-B delegate'
       21:22:55 PATH-B delegate openURLs url=vrcxkprobedel://hello?a=1

=== B: hand-installed kAEGetURL Apple Event handler ===
  PASS aehandler: LaunchServices claims vrcxkprobeae:
  PASS aehandler: 'open vrcxkprobeae://hello?a=1' returned 0
  PASS aehandler: URL delivered via 'PATH-A apple-event'
       21:23:03 PATH-A apple-event url=vrcxkprobeae://hello?a=1

=== VERDICT: all checks passed ===
```

### Run 2 — same script, `PROBE_ROOT=/tmp/vrcxk-mac-deeplink-probe-tmp`

```
=== A: delegate-only (the path Tauri/WRY uses: RunEvent::Opened) ===
  PASS delegate: LaunchServices claims vrcxkprobedel:
  FAIL delegate: 'open vrcxkprobedel://hello?a=1' returned non-zero
  FAIL delegate: URL NOT delivered as 'PATH-B delegate' (log follows)
  PASS aehandler: LaunchServices claims vrcxkprobeae:
  FAIL aehandler: 'open vrcxkprobeae://hello?a=1' returned non-zero
  FAIL aehandler: URL NOT delivered as 'PATH-A apple-event' (log follows)
=== VERDICT: FAILURES above ===
```

### Supporting measurement — argv is not the carrier

A plain C bundle (no AppKit) with the same `CFBundleURLTypes`, launched and then sent
`open "scheme://…"` five ways (`open -a`, `open URL`, `open -n URL`, `osascript open location`,
`open -b <bundleid> URL`):

```
21:20:28 pid=53592 argc=1 argv=[…/Probe2.app/Contents/MacOS/probe2]
21:20:28 pid=53589 argc=1 argv=[…/Probe2.app/Contents/MacOS/probe2]
21:20:29 pid=53595 argc=1 argv=[…/Probe2.app/Contents/MacOS/probe2]
```

`argc=1` on every launch — and `open` reported **OK** for all five. The URL was simply dropped,
which is what a handler without an Apple Event/`NSApplication` path looks like.

## 3. The two traps, in detail

### 3.1 `open`'s exit status says nothing about delivery

Three independent observations, all measured:

| Situation | `open` exit | URL delivered? |
|---|---|---|
| plain C bundle, `open "scheme://…"` ×5 | **0** | **No** (`argc=1`, nothing logged) |
| AppKit bundle, `/tmp` | **non-zero** (`-10814`) | No |
| AppKit bundle, `$HOME` | **0** | **Yes** |

⇒ A macOS acceptance test must assert on the **app side** (a logged Apple Event / the host
receiving `deepLink.opened`), never on `open`'s status. This is the same lesson as the repo's
existing rule that **a skip is not a pass**, in a different costume: `open` saying "OK" is a
statement about LaunchServices' dispatch attempt, not about the app.

### 3.2 `/tmp` is not a place a URL handler can live

In run 2 the bundle **is** registered — `lsregister -dump` shows the claim for the exact scheme —
and yet `open` answers `kLSApplicationNotFoundErr (-10814)`, "no application claims the file".
The claim and the launchability are two different things, and only the first survives `/tmp`.

⚠ This is a **trap for the verification harness itself**, not a product behaviour: the real app
is installed in `/Applications` (or `~/Applications`) by the bundler, so it is unaffected. But a
hand-made probe — or a CI step that builds a bundle in a temp dir — will fail here and look like
"macOS deep links are broken".

## 4. What this means for issue #41

1. **The macOS half of gap ② is mechanically sound, and now measured** (previously "zero
   verification"). A `CFBundleURLTypes` entry is enough for macOS to deliver `scheme://…` to a
   running app, via the **delegate path Tauri uses**.
2. The verification that #41's acceptance criteria ask for is therefore **the real app**:
   build + install + `open "vrcxk://…"` + assert **the host received `deepLink.opened`**.
   The remaining unknown is Tauri's own plumbing plus the bundler's `Info.plist` generation —
   not macOS.
3. **That Mac needed prep, and now has it** (2026-09-28): it had **no rustup and no bun**; both are
   installed now (§5). `git` and `python3` are present; Xcode (not just CLT) is at
   `/Applications/Xcode.app`; 380 GB free. ⚠ **github.com is unusable from it** (20 s to first
   byte, a clone timing out at 75 s) — fetch sources over the LAN, or through the relay.
4. This probe stays useful **after** the toolchains are installed: it is a name-independent smoke
   test that separates "macOS would not deliver" from "our app did not receive/forward".

## 5. The real app — built and measured (2026-09-28, same Mac)

`run-real-app.sh` does what §4.2 asks for, without waiting for the scheme-name decision: it patches
a **scratch tree** with a **scratch scheme** (`vrcxkscratch`) and a **temporary logging consumer**,
builds the real app, and asserts on the host side. Nothing was pushed; the tree is restored on exit.

**Toolchain prep done first** (that Mac had none):

| piece | result |
|---|---|
| rustup | ✅ installed `stable-aarch64-apple-darwin`, **rustc 1.98.1** (`--no-modify-path`, so `~/.cargo/bin` is not on the interactive PATH) |
| bun | ✅ **1.4.2** (matches the repo's pin). ⚠ The official installer's GitHub download died with `curl: (16) Error in the HTTP2 framing layer`; it worked through the user's relay (`https://e.mcrete.top/<urlencode(target)>`, the shape its own homepage uses) |
| source | ⚠ `git clone` from this Mac **timed out after 75 s** against github.com. 1.4 MiB of tracked files is enough for a build, so the tree was shipped over the LAN (`git archive` + `scp` + `tar -x`). Nothing in the build needs `.git` |

Build: `bun run tauri build --bundles app` → **release build 4 m 53 s** (8 CPU / 16 GB), and the
bundle carries the sidecar (`Contents/MacOS/host` 62.9 MB next to `tauri-app` 6.6 MB — the
macOS sidecar path works).

### Raw output

```
########## 3. did the BUNDLER put the scheme into the built app? ##########
Array {
    Dict {
        CFBundleTypeRole = Editor
        CFBundleURLName = com.vrcxk.app vrcxkscratch
        CFBundleURLSchemes = Array {
            vrcxkscratch
        }
    }
}
PASS: built Info.plist declares vrcxkscratch

########## 4. does LaunchServices give OUR bundle the scheme? ##########
claimed schemes:            vrcxkscratch:
PASS: LaunchServices claims vrcxkscratch

########## 5. launch (into the GUI session) and deliver a URL from SSH ##########
--- host log before the URL ---
2026-09-28T14:09:19.539Z [host] starting Cordis...
2026-09-28T14:09:19.548Z [host] manifests: 0 registered (none), 1 without a usable declaration (2023438d:heartbeat)
2026-09-28T14:09:19.555Z [host] ready {"schemaVersion":1,…,"host":{"platform":"macos","arch":"arm64","mode":"source"},…}
--- opening vrcxkscratch://hello?a=1 ---
open returned 0

########## 6. ASSERT on the APP side ##########
2026-09-28T14:09:23.425Z [host] [probe] deepLink.opened received urls=["vrcxkscratch://hello?a=1"]
PASS: URL reached the host: macOS -> shell -> kkrpc/stdio -> host consumer

### VERDICT: all assertions passed ###
```

(The host log is at `~/Library/Logs/com.vrcxk.app/host.log`, i.e. `app_log_dir()` — that is the
observable end of the chain. Without the temporary consumer, **nothing** would have been logged:
that is gap ④, and it is why this harness cannot exist without patching the tree.)

### Two traps hit while writing this harness

1. ⚠ **The bundle is under `<tree>/target`, not `<tree>/src-tauri/target`** — the cargo workspace
   root is the repo root. The first run reported `FAIL: app bundle not found` for a build that had
   in fact succeeded four lines earlier (`Finished release … Finished 1 bundle at: …`). A path bug
   in the harness read exactly like a build failure.
2. ⚠ **A `PASS` on the LaunchServices claim can be inherited from an earlier run**: the freshly
   built app had already been auto-registered by macOS, so the claim claim check passed even in the run
   where the harness was looking at the wrong path. Assert on the app side (Web 6) as well, or the
   claim check alone can be satisfied by a stale registration.

## 6. The REAL name, with BOTH halves — and the cold-start defect it exposed

`run-real-name.sh` is the acceptance run for the declared name: it patches **nothing** (the tree
declares `vrcxk` and the host's own `ctx.deepLink` logs arrivals), so what it measures is production
wiring. It needs a tree carrying **both** the shell change and the host consumer.

### 6.1 First run: the cold start did nothing — and the reason was NOT delivery

```
PASS: Info.plist declares vrcxk
PASS: LaunchServices claims vrcxk
COLD START (app not running, the URL launches it):
    [host] ready 15:37:29.256
    (no deepLink.opened)
FAIL: the cold-start URL never reached the host
WARM:  PASS — [host] deepLink.opened vrcxk://world/wrld_2
```

A temporary file-based diagnostic inside the shell settled where it was lost, because a bundled
app's stderr goes nowhere:

```
[forward_deep_link] urls=["vrcxk://user/usr_1"] peer=true      ← the shell DID get the URL…
[replay] batches=0 dropped=0 peer=true                          ← …with the peer already up, so nothing was queued
```

⇒ The URL took the **"delivered"** path. The loss was **host-side and structural**: `expose` is
registered in `connectShellStdio()`, but the service that consumes `deepLink.opened`
(`ctx.deepLink`) attaches **after** `await shell.ready(...)`. A notification landing in that window
was emitted into an **empty handler set** and vanished silently — the shell-side replay queue cannot
help, because it only engages when there is no peer at all.

**Fix (host PR):** `fanout(..., { retainUntilSubscribed: true })` — the deep-link notification keeps
its newest value in **one slot** until the first subscriber arrives, then hands it over once. Only
deep links opt in: a URL is still a valid intent seconds later, whereas a tray click or hotkey press
is a momentary input (replaying one after startup could fire an action the user has moved past).

### 6.2 After the fix — all assertions pass

```
########## 4. COLD START — no app running, the URL launches it ##########
opened vrcxk://user/usr_1 at 23:42:13 with the app NOT running
    2026-09-28T15:42:15.523Z [host] ready {…}
    2026-09-28T15:42:15.526Z [host] deepLink.opened vrcxk://user/usr_1
PASS: the cold-start URL reached the host (production consumer, nothing patched)

########## 5. WARM — the app is running, a second URL arrives ##########
PASS: a second activation reached the host while the app was running
    2026-09-28T15:42:15.526Z [host] deepLink.opened vrcxk://user/usr_1
    2026-09-28T15:42:24.336Z [host] deepLink.opened vrcxk://world/wrld_2

### VERDICT: all assertions passed ###
```

⚠ **Read the timing, it is the evidence**: the URL line lands **3 ms after `ready`** — i.e. it was
handed over by the retention slot, not delivered live (a live delivery would have been logged while
the host was still booting, and before the consumer existed).

### 6.3 Two traps that cost a whole round each

1. ⚠ **Running this against the SHELL branch alone produces a false failure — and a misleading one.**
   With no `ctx.deepLink` in the tree, the URL *is* delivered and simply leaves no trace, so the
   output reads exactly like "delivery is broken" (it even matches the pre-#41 symptom). Check
   `grep -q deepLinks.attachShell <tree>/host/src/index.ts` first; the script now does.
2. ⚠ **The macOS cold-start URL arrives LATE — after `ready`.** Measured twice (15:32:44 ready for a
   15:32:42 open; and the run above). The shell-side queue therefore does **not** cover the macOS cold
   start; what covers it is the host-side retention above. The queue remains the mechanism for the
   windows where the peer genuinely does not exist yet (host restart, and platforms that deliver the
   URL at process start rather than ~2 s later).

## 7. Windows: the argv cold start, verified — and the packaging gap it exposed

macOS delivers the launch URL through `RunEvent::Opened` (after setup). **Windows/Linux deliver it as
**argv**, and that path runs *inside the deep-link plugin's own setup* — which Tauri calls from
`Builder::build()` (`tauri-2.11.5/src/app.rs:2440` `initialize_plugins`) **before** the app's
`.setup()` (`app.rs:2521`) where the shell registers `on_open_url`
(`tauri-plugin-deep-link-2.4.10/src/lib.rs:75-81`, `:196-222` fire `emit("deep-link://new-url")`
there). So the URL was emitted into an **empty listener set** and lost, every time. The fix is to drain
`app.deep_link().get_current()` right after registering the listener (`src-tauri/src/lib.rs`).

Measured on Windows (equivalent install = the rendered NSIS script's file layout + its exact registry
writes, then the app launched **by a human** via the URL):

```
2026-09-28T17:22:43.060Z [host] ready {… "host":{"platform":"windows","arch":"x64","mode":"compiled"},…}
2026-09-28T17:22:43.066Z [host] deepLink.opened vrcxk://user/usr_1      ← 6 ms after ready
2026-09-28T17:23:32.529Z [host] deepLink.opened vrcxk://world/wrld_2    ← warm
```

⚠ **The timing is the signature again**: 6 ms after `ready`, exactly like macOS's 3 ms — the URL was
captured at startup and handed over by the drain. Without the fix this line never appeared on Windows
(measured), while the warm case always worked.

Against that: `HKCU\Software\Classes\vrcx` (the incumbent VRCX's own class key, byte-compared with
`reg export` 5 times across install / cold / warm / failed attempts) was **identical throughout** — the
install writes only `HKCU\Software\Classes\vrcxk`, and the runtime gate is bounded to the declared name.

### 7.1 ⚠ Two things Windows still does NOT verify, and the measured reason why

1. **The installer's own file and registry writes.** Measured on this machine, and reduced to a clean
   asymmetry — **same context, same operations, different binary** (all runs launched the way a user
   does, through Explorer, in the logged-in session at High integrity, outside the agent's process tree):

   | actor | `mkdir` on C: | write a 6.9 MB `.exe` to C: | write `HKCU\Software\Classes\…` |
   |---|---|---|---|
   | `cmd` (Microsoft-signed) | ✅ | ✅ | ✅ |
   | our freshly built, **unsigned** NSIS installer | ❌ | ❌ (exits 0 having written nothing) | ❌ (silent no-op) |

   Supporting measurements, each ruling out one explanation:
   - **Not our packaging**: a **20-line NSIS installer built with the same makensis** behaves identically,
     and `tauri build --bundles nsis` produced a byte-valid installer that installs **completely** when
     its target is on **D:** (`tauri-app.exe`, `host.exe`, `cordis.yml`, `plugins/`, `uninstall.exe` all
     present) while writing **nothing** to the same relative path on **C:**.
   - **Not a path or ACL problem**: in the *same* context `cmd` creates the directory, writes the very
     same 6.9 MB executable there, and creates the class key.
   - **Not "NSIS is broken here"**: another **unsigned NSIS installer** (a .NET/CefSharp product,
     148.7 MiB) *did* install on this machine.
   - **Not the agent's sandbox**: the DSH file policy for the session was `danger-full-access` and the
     failures reproduce in a plain Explorer-launched session.
   - The machine runs two third-party **kernel file-system filters**: Huorong's `sysdiag`
     (altitude 324600, 7 instances) and `EasyAntiCheat_EOSSys` (both C: and D:). A **per-binary** rule in
     such a product — "unknown program modifies the system drive / a file association" — produces exactly
     this shape. ⚠ Huorong's own `hips.db` had **0 rows** and its `applog.db` only *recorded that our
     binaries ran*, so its UI log does **not** show this class of denial: absence of a log entry here is
     not evidence of absence.
   - **This also blocked producing the fallback**: WiX's `light.exe` cannot build the MSI here — it dies
     in .NET's `TempFileCollection.CreateTempDirectoryWithAce` (`access denied` / `1314 a required
     privilege is not held`), the same "create a temp dir *with a security descriptor*" step that the
     MSVC linker and the NSIS stub fail at.

   ⇒ The uninstall-path criterion therefore needs a machine without that block. **Done — in CI**, and
   that is now the durable home for it: `.github/workflows/installer-acceptance.yml` builds the NSIS
   bundle on `windows-latest` and runs `scripts/installer-acceptance.ps1`
   (manual / weekly / only when packaging or hook files change). First green run **36462916457**:

   ```
   installer exit code: 0
   PASS: 自有类键 HKCU\Software\Classes\vrcxk 出现
     shell\open\command = "C:\Users\runneradmin\AppData\Local\vrcx-k\tauri-app.exe" "%1"
   PASS: 命令串指向安装出来的 exe / 安装目录里确实有那个 exe 文件 / 带 URL Protocol 值
   PASS: 安装器写了 Uninstall 条目（Install 段跑到了底）
   PASS: 安装后，别人的 vrcx 类键逐字节未变
   uninstaller exit code: 0
   PASS: 卸载后自有类键 HKCU\Software\Classes\vrcxk 确实被删（acceptance criterion）
   PASS: 卸载后 Uninstall 条目也不在了
   PASS: 卸载后，别人的 vrcx 类键仍然逐字节未变
   ### VERDICT: all assertions passed ###
   ```

   ⚠ The script guards one **false green** on purpose: if the install phase never wrote the key, it
   records the uninstall assertion as **"cannot verify" (FAIL)** instead of letting "the key is absent"
   pass vacuously — that is the same trap this session hit twice elsewhere.
2. **`NSIS_HOOK_POSTUNINSTALL` at runtime — now verified** (the `PASS` above, on a real Windows runner):
   the hook is compiled into the installer (read out of the rendered `.nsi`), a packaging test ties every
   declared scheme to its `DeleteRegKey` (fault-injected), and the CI run above shows the key actually
   disappearing after a real uninstall while the foreign key stays byte-identical.
3. ⚠ **A false "the host never started" — also a per-binary effect, not a path one.** The host log lives
   under `%LOCALAPPDATA%\<identifier>\logs`; when the app was launched from the agent's tree the same
   binary wrote no log, and when a human launched it the log appeared. Same lesson as (1): assert on a
   channel the launcher's own context owns, or launch it the way a user would.



