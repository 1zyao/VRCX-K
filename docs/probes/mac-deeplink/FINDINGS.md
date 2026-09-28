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
| 11 | What is **still unverified**? | The **product** side, not macOS: (a) the scheme **name** is an open owner decision, so §5 used a scratch one; (b) the host has **no `deepLink` consumer** in the product (that absence IS gap ④), so §5 had to insert a temporary logging consumer to have anything to assert on; (c) second-launch/instance behavior and `LSUIElement` were not measured | — |

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
   built app had already been auto-registered by macOS, so the claim check passed even in the run
   where the harness was looking at the wrong path. Assert on the app side (Web 6) as well, or the
   claim check alone can be satisfied by a stale registration.

