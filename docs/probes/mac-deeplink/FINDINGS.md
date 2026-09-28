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
| 9 | What is **still unverified**? | The **real Tauri app**: that Mac has **no rustup and no bun**, and nothing here exercises Tauri's `RunEvent::Opened` plumbing or the bundler's `Info.plist` generation (that half is source-read only, see the decision brief §2). Also unmeasured: second-launch/instance behavior, and whether `LSUIElement` matters for a real Tauri bundle (this probe sets it) | — |

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
3. **That Mac needs prep** before the real test can run: `rustup` **MISSING**, `bun` **MISSING**
   (measured §0.9). `git` and `python3` are present; Xcode (not just CLT) is installed at
   `/Applications/Xcode.app`; 380 GB free; `github.com` reachable (HTTP 200, 3.6 s).
4. This probe stays useful **after** the toolchains are installed: it is a name-independent smoke
   test that separates "macOS would not deliver" from "our app did not receive/forward".
