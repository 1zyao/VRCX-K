#!/bin/bash
# macOS custom-URL-scheme delivery probe (no Rust, no bun, no Tauri needed).
#
# Answers ONE question for issue #41 / `tauri.conf.json` `plugins.deep-link.desktop.schemes`:
# when a scheme is declared as an app-bundle URL type, HOW does macOS hand the URL to
# the app — and can that be driven and observed from an SSH session?
#
# Why this shape: Tauri's macOS path is WRY's NSApplication delegate
# (`application:openURLs:` -> `RunEvent::Opened`), NOT the argv path, and NOT a
# hand-installed Apple Event handler. So the probe measures the DELEGATE path and
# the AE-handler path SEPARATELY — a probe that installs its own AE handler and
# concludes "delivery works" would be measuring a path production does not use.
#
# Run it ON the Mac (needs only Xcode CLT's clang + python3):
#   ssh mac 'bash -s' < docs/probes/mac-deeplink/run.sh
# or copy it over and run it directly. It is self-contained and self-cleaning.
#
# Measured 2026-09-28 on macOS 26.6.2 (Darwin 25.6.0, arm64), console user == ssh user.

set -u

# Where the probe bundles are built. ⚠ NOT /tmp by default: macOS refuses to hand a
# URL to a bundle under /tmp even though LaunchServices records the claim for it
# (measured — see FINDINGS.md §3). Override with PROBE_ROOT to re-check that.
ROOT="${PROBE_ROOT:-$HOME/.vrcxk-mac-deeplink-probe}"
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
FAILED=0

cleanup() {
  pkill -f "$ROOT/[^/]*\.app/Contents/MacOS/probe" 2>/dev/null
  for app in "$ROOT"/*.app "$ROOT"/*/*.app; do
    [ -d "$app" ] && "$LSREG" -u "$app" >/dev/null 2>&1
  done
  rm -rf "$ROOT"
}
trap cleanup EXIT

pass() { printf '  PASS %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; FAILED=1; }
note() { printf '       %s\n' "$1"; }

rm -rf "$ROOT"; mkdir -p "$ROOT"

# ── the probe app ───────────────────────────────────────────────────────────
# One source file, compiled twice: once relying only on the NSApplication
# delegate (the path Tauri uses), once additionally installing a kAEGetURL
# Apple Event handler (the path every hand-rolled macOS deep-link app uses).
cat > "$ROOT/probe.m" <<'OBJC'
#import <Cocoa/Cocoa.h>
#include <unistd.h>

static NSString *gLog = nil;

static void logline(NSString *format, ...) {
    va_list args; va_start(args, format);
    NSString *line = [[NSString alloc] initWithFormat:format arguments:args];
    va_end(args);
    NSDateFormatter *fmt = [[NSDateFormatter alloc] init];
    fmt.dateFormat = @"HH:mm:ss";
    FILE *fh = fopen(gLog.UTF8String, "a");
    if (!fh) return;
    fprintf(fh, "%s %s\n", [fmt stringFromDate:[NSDate date]].UTF8String, line.UTF8String);
    fclose(fh);
}

@interface AppDelegate : NSObject <NSApplicationDelegate>
@end

@implementation AppDelegate
- (void)applicationDidFinishLaunching:(NSNotification *)note {
    logline(@"READY pid=%d mode=%s", getpid(), MODE_NAME);
#ifdef USE_AE_HANDLER
    [[NSAppleEventManager sharedAppleEventManager]
        setEventHandler:self
            andSelector:@selector(handleGetURL:withReplyEvent:)
          forEventClass:kInternetEventClass
             andEventID:kAEGetURL];
    logline(@"AE handler installed for kAEGetURL");
#endif
}
- (void)handleGetURL:(NSAppleEventDescriptor *)event withReplyEvent:(NSAppleEventDescriptor *)reply {
    logline(@"PATH-A apple-event url=%@", [[event paramDescriptorForKeyword:keyDirectObject] stringValue]);
}
- (void)application:(NSApplication *)app openURLs:(NSArray<NSURL *> *)urls {
    for (NSURL *u in urls) logline(@"PATH-B delegate openURLs url=%@", u.absoluteString);
}
@end

int main(void) {
    @autoreleasepool {
        // ⚠ NOT an environment variable: `open` launches through launchd and does
        // NOT pass the calling shell's environment, so a getenv() here is NULL and
        // the app would silently log nowhere. The path is compiled in instead.
        gLog = @LOG_PATH;
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        AppDelegate *delegate = [[AppDelegate alloc] init];
        [NSApp setDelegate:delegate];
        logline(@"main() entered mode=%s", MODE_NAME);
        [NSApp run];
    }
    return 0;
}
OBJC

build_app() { # $1 = mode/label, $2 = scheme, $3 = extra cflags
  local mode="$1" scheme="$2" cflags="$3"
  local app="$ROOT/Probe-$mode.app"
  mkdir -p "$app/Contents/MacOS"
  # shellcheck disable=SC2086
  clang -fobjc-arc -framework Cocoa $cflags \
    -DMODE_NAME="\"$mode\"" -DLOG_PATH="\"$ROOT/$mode.log\"" \
    -o "$app/Contents/MacOS/probe" "$ROOT/probe.m" || return 1
  python3 - "$app" "$scheme" "com.vrcxk.probe.$mode" <<'PY'
import plistlib, sys, os, re
app, scheme, bundleid = sys.argv[1:4]
key = re.sub(r'[^A-Za-z0-9]', '', scheme).lower()
info = {
    "CFBundleIdentifier": bundleid,
    "CFBundleName": "Probe-" + key,
    "CFBundleExecutable": "probe",
    "CFBundlePackageType": "APPL",
    "CFBundleVersion": "1",
    "CFBundleShortVersionString": "1.0",
    "LSUIElement": True,
    "CFBundleURLTypes": [{
        "CFBundleURLName": bundleid + ".scheme",
        "CFBundleURLSchemes": [scheme],
    }],
}
with open(os.path.join(app, "Contents", "Info.plist"), "wb") as fh:
    plistlib.dump(info, fh)
PY
}

claimed() { # $1 = scheme -> 0 if LaunchServices has a claim for it
  "$LSREG" -dump 2>/dev/null | grep -q "claimed schemes:.*[[:space:]]$1:"
}

deliver_and_check() { # $1 = label, $2 = scheme, $3 = expected log pattern
  local mode="$1" scheme="$2" pattern="$3"
  local app="$ROOT/Probe-$mode.app"
  local log="$ROOT/$mode.log"

  rm -f "$log"
  "$LSREG" -f "$app" || fail "$label: lsregister -f failed"
  sleep 1

  if claimed "$scheme"; then
    pass "$mode: LaunchServices claims $scheme:"
  else
    fail "$mode: LaunchServices has NO claim for $scheme: (registration problem, not a delivery problem)"
    return
  fi

  open -a "$app" || { fail "$mode: launch failed"; return; }
  for _ in $(seq 1 20); do grep -q READY "$log" 2>/dev/null && break; sleep 0.5; done
  grep -q READY "$log" || { fail "$mode: app never reached didFinishLaunching"; return; }

  local url="$scheme://hello?a=1"
  if open "$url" 2>"$ROOT/$mode.open.err"; then
    pass "$mode: 'open $url' returned 0"
  else
    fail "$mode: 'open $url' returned non-zero"
    note "$(tr -d '\n' < "$ROOT/$mode.open.err" | cut -c1-200)"
  fi
  sleep 3

  if grep -q "$pattern" "$log"; then
    pass "$mode: URL delivered via '$pattern'"
    grep "$pattern" "$log" | sed 's/^/       /'
  else
    fail "$mode: URL NOT delivered as '$pattern' (log follows)"
    sed 's/^/       /' "$log"
  fi
  pkill -f "$app/Contents/MacOS/probe" 2>/dev/null
  sleep 0.5
}

echo "=== environment ==="
sw_vers -productVersion
uname -m
echo "ssh user=$(id -un) uid=$(id -u) console user=$(stat -f '%Su' /dev/console)"
if launchctl print "gui/$(id -u)" >/dev/null 2>&1; then
  echo "gui/$(id -u) domain: reachable"
else
  echo "gui/$(id -u) domain: NOT reachable  <-- 'open' cannot reach the GUI session"
fi

echo
echo "=== control: a SCRIPT-based bundle executable ==="
# Measured fact worth re-checking on each run: macOS refuses to launch a bundle
# whose CFBundleExecutable is a shell script, so it can never be a URL handler.
CTRL="$ROOT/Probe-control.app"; mkdir -p "$CTRL/Contents/MacOS"
printf '#!/bin/bash\necho "$@" >> "%s"\n' "$ROOT/control.log" > "$CTRL/Contents/MacOS/probe"
chmod +x "$CTRL/Contents/MacOS/probe"
python3 - "$CTRL" <<'PY'
import plistlib, sys, os
info = {"CFBundleIdentifier": "com.vrcxk.probe.control", "CFBundleName": "Probecontrol",
        "CFBundleExecutable": "probe", "CFBundlePackageType": "APPL",
        "CFBundleVersion": "1", "CFBundleURLTypes": [{"CFBundleURLName": "control",
        "CFBundleURLSchemes": ["vrcxkprobecontrol"]}]}
with open(os.path.join(sys.argv[1], "Contents", "Info.plist"), "wb") as fh:
    plistlib.dump(info, fh)
PY
"$LSREG" -f "$CTRL"; sleep 1
if [ -s "$ROOT/control.log" ]; then rm -f "$ROOT/control.log"; fi
if open "vrcxkprobecontrol://x" 2>"$ROOT/control.err"; then
  sleep 2
  if [ -s "$ROOT/control.log" ]; then
    fail "control: script-executable bundle RAN and captured the URL (expected refusal)"
  else
    fail "control: open returned 0 but nothing ran — exit status is NOT evidence of delivery"
  fi
else
  pass "control: script-executable bundle is refused (cannot be a URL handler)"
  note "$(tr -d '\n' < "$ROOT/control.err" | cut -c1-160)"
fi

echo
echo "=== scheme-name shape: does a hyphen survive registration? ==="
build_app shapeshyph "vrcxkprobe-hy" "" >/dev/null 2>&1
build_app shapeplain "vrcxkprobeshapeplain" "" >/dev/null 2>&1
"$LSREG" -f "$ROOT/Probe-shapeshyph.app" >/dev/null 2>&1
"$LSREG" -f "$ROOT/Probe-shapeplain.app" >/dev/null 2>&1
sleep 1
if claimed "vrcxkprobe-hy"; then
  pass "hyphenated scheme 'vrcxkprobe-hy' is claimed by LaunchServices"
else
  note "hyphenated scheme 'vrcxkprobe-hy' is NOT claimed (plain 'vrcxkprobeshapeplain' below is the control)"
  if claimed "vrcxkprobeshapeplain"; then
    pass "plainer scheme 'vrcxkprobeshapeplain' IS claimed  <-- the hyphen is what dropped the claim"
  else
    fail "neither scheme is claimed — this run's registration is broken, conclusions above are void"
  fi
fi

echo
echo "=== A: delegate-only (the path Tauri/WRY uses: RunEvent::Opened) ==="
if build_app delegate "vrcxkprobedel" ""; then
  deliver_and_check delegate "vrcxkprobedel" "PATH-B delegate"
else
  fail "delegate: clang build failed"
fi

echo
echo "=== B: hand-installed kAEGetURL Apple Event handler ==="
if build_app aehandler "vrcxkprobeae" "-DUSE_AE_HANDLER"; then
  deliver_and_check aehandler "vrcxkprobeae" "PATH-A apple-event"
else
  fail "aehandler: clang build failed"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "=== VERDICT: all checks passed ==="
else
  echo "=== VERDICT: FAILURES above ==="
fi
exit "$FAILED"
