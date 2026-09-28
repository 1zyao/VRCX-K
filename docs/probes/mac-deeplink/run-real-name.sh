#!/bin/bash
# REAL-NAME acceptance run for issue #41 — the declared scheme on real hardware, with NO
# patching of any kind.
#
# ⚠ What makes this different from `run-real-app.sh`: that one patches a scratch tree (a
# throwaway scheme + a temporary logging consumer) to prove the MECHANISM. This one runs the
# committed tree — `tauri.conf.json` declares `vrcxk`, and the host's own `ctx.deepLink` logs
# every activation — so what it measures is production wiring.
#
# ⚠ It needs a tree with BOTH halves (the shell's declaration/queue AND the host's consumer).
# Running it against the shell branch alone produces a FALSE FAILURE: the URL is delivered but
# nothing on the host side logs it, because the consumer lives in the other PR. That mistake
# cost a full diagnosis round — see `FINDINGS.md` §6.
#
# Cases:
#   1. the built bundle declares the scheme and LaunchServices claims it;
#   2. COLD START — the app is NOT running; `vrcxk://…` is what launches it;
#   3. WARM — the app is running; a second URL arrives.
# The assertion is always on the APP side (the host log), never on `open`'s exit status.
#
# Measured 2026-09-28, macOS 26.6.2 arm64. See FINDINGS.md §6 for the raw output, including the
# cold-start defect this run exposed and the fix that made it pass.

set -u
export PATH="$HOME/.cargo/bin:$HOME/.bun/bin:$PATH"

TREE="${1:?usage: run-real-name.sh <tree-with-both-halves> [scheme]}"
SCHEME="${2:-vrcxk}"
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
APP="$TREE/target/release/bundle/macos/vrcx-k.app"
HOSTLOG_DIR="$HOME/Library/Logs/com.vrcxk.app"

stage() { echo; echo "########## $* ##########"; }
FAILED=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; FAILED=1; }

stage "1. the two halves must both be in this tree"
grep -q 'deepLinks.attachShell' "$TREE/host/src/index.ts" \
  && pass "host consumer wired (ctx.deepLink)" \
  || fail "host consumer missing — this tree is the SHELL branch only, and this run would show a false failure"
grep -q "\"$SCHEME\"" "$TREE/src-tauri/tauri.conf.json" \
  && pass "scheme $SCHEME declared in tauri.conf.json" \
  || fail "scheme $SCHEME is not declared"

stage "2. build"
( cd "$TREE" && bun install && bun run tauri build --bundles app ) || fail "build"
"$LSREG" -f "$APP" 2>/dev/null; sleep 1

stage "3. the built app declares the scheme, and LaunchServices claims it"
/usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes" "$APP/Contents/Info.plist" 2>/dev/null | grep -q "$SCHEME" \
  && pass "Info.plist declares $SCHEME" || fail "Info.plist does not declare $SCHEME"
"$LSREG" -dump 2>/dev/null | grep -q "claimed schemes:.*[[:space:]]$SCHEME:" \
  && pass "LaunchServices claims $SCHEME" || fail "LaunchServices does not claim $SCHEME"

stage "4. COLD START — no app running, the URL launches it"
pkill -f "$APP/Contents/MacOS" 2>/dev/null
sleep 2
rm -rf "$HOSTLOG_DIR"
echo "opened $SCHEME://user/usr_1 at $(date '+%H:%M:%S') with the app NOT running"
open "$SCHEME://user/usr_1" || fail "open returned non-zero"
for _ in $(seq 1 60); do ls "$HOSTLOG_DIR" >/dev/null 2>&1 && break; sleep 1; done
sleep 8
cat "$HOSTLOG_DIR"/* 2>/dev/null | sed 's/^/    /'
if grep -h "deepLink.opened" "$HOSTLOG_DIR"/* 2>/dev/null | grep -q "usr_1"; then
  pass "the cold-start URL reached the host (production consumer, nothing patched)"
else
  fail "the cold-start URL never reached the host"
fi

stage "5. WARM — the app is running, a second URL arrives"
open "$SCHEME://world/wrld_2" || fail "open returned non-zero"
sleep 6
if grep -h "deepLink.opened" "$HOSTLOG_DIR"/* 2>/dev/null | grep -q "wrld_2"; then
  pass "a second activation reached the host while the app was running"
else
  fail "the second activation did not reach the host"
fi
echo "--- every deepLink line in the host log ---"
grep -h "deepLink.opened" "$HOSTLOG_DIR"/* 2>/dev/null | sed 's/^/    /'

stage "6. cleanup"
pkill -f "$APP/Contents/MacOS" 2>/dev/null && echo "killed app" || echo "(app not running)"

echo
if [ "$FAILED" -eq 0 ]; then echo "### VERDICT: all assertions passed ###"; else echo "### VERDICT: FAILURES ###"; fi
exit "$FAILED"
