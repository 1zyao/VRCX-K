#!/bin/bash
# REAL-APP macOS verification for issue #41 gap ② — builds the actual Tauri app and
# asserts the URL reaches the host. Companion to run.sh (which needs no toolchain).
#
# ⚠ WHAT THIS MODIFIES. It patches the tree it is pointed at, and restores it on
# exit (originals are kept as *.orig):
#
#   1. src-tauri/tauri.conf.json — declares a SCRATCH scheme, because the real
#      name is an open owner decision (issue #41 §7). Pass it as $1.
#   2. host/src/index.ts — inserts a TEMPORARY consumer that logs the received
#      `deepLink.opened`. This is not optional: the host has NO consumer today
#      (that absence IS gap ④), so without it an arriving URL leaves no trace and
#      there is nothing to assert on.
#
# ⇒ Point it at a SCRATCH COPY, never at a tree you intend to commit from.
#
# What it measures that run.sh cannot:
#   - does the Tauri BUNDLER turn `plugins.deep-link.desktop.schemes` into a real
#     CFBundleURLTypes in the built .app?
#   - does the installed app CLAIM the scheme?
#   - does the full chain work: macOS -> shell -> kkrpc/stdio -> host consumer?
#
# Prereqs on the Mac: rustup + bun + Xcode. Getting the SOURCE there is the
# awkward step when github.com is slow (a clone timed out at 75 s from this Mac).
# 1.4 MiB of tracked files is enough — ship it over the LAN instead:
#   (on the Windows box)  git archive --format=tar.gz -o src.tgz origin/rewrite
#                         scp src.tgz mac:/tmp/
#   (on the Mac)          tar -xzf /tmp/src.tgz -C <tree>
#
# Usage:
#   bash run-real-app.sh <tree> [scheme]
#
# Measured 2026-09-28, macOS 26.6.2 arm64 (8 CPU / 16 GB), rustc 1.98.1, bun 1.4.2:
# release build 4m53s; all assertions passed (see FINDINGS.md §5).

set -u
export PATH="$HOME/.cargo/bin:$HOME/.bun/bin:$PATH"

TREE="${1:?usage: run-real-app.sh <tree> [scheme]}"
SCHEME="${2:-vrcxkscratch}"
[ -d "$TREE/src-tauri" ] || { echo "not a VRCX-K tree: $TREE"; exit 2; }

# ⚠ The cargo WORKSPACE root is the repo root, so the bundle is under <tree>/target,
# NOT <tree>/src-tauri/target. Getting this wrong reads as "the build produced
# nothing" while the build actually succeeded.
APP="$TREE/target/release/bundle/macos/vrcx-k.app"
CONF="$TREE/src-tauri/tauri.conf.json"
IDX="$TREE/host/src/index.ts"
HOSTLOG_DIR="$HOME/Library/Logs/com.vrcxk.app"
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

FAILED=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; FAILED=1; }
stage() { echo; echo "########## $* ##########"; }

restore() {
  for f in "$CONF" "$IDX"; do
    [ -f "$f.orig" ] && mv -f "$f.orig" "$f"
  done
}
trap restore EXIT
cp -n "$CONF" "$CONF.orig"
cp -n "$IDX" "$IDX.orig"

stage "1. scratch edits (tree: $TREE, scheme: $SCHEME)"
python3 - "$TREE" "$SCHEME" <<'PY'
import json, sys
repo, scheme = sys.argv[1], sys.argv[2]
conf_path = f"{repo}/src-tauri/tauri.conf.json"
with open(conf_path) as fh:
    conf = json.load(fh)
conf.setdefault("plugins", {})["deep-link"] = {"desktop": {"schemes": [scheme]}}
with open(conf_path, "w") as fh:
    json.dump(conf, fh, indent=2); fh.write("\n")
print(f"tauri.conf.json: plugins.deep-link.desktop.schemes = [{scheme}]")

idx = f"{repo}/host/src/index.ts"
src = open(idx).read()
anchor = "    autostart.attachShell(shell)\n"
assert anchor in src, "anchor not found in host/src/index.ts"
src = src.replace(anchor, anchor + """
    // ⚠ LOCAL VERIFICATION HACK (issue #41) — NOT FOR COMMIT.
    const offDeepLinkProbe = shell.deepLink.onOpen((event) => {
      log(`[probe] deepLink.opened received urls=${JSON.stringify(event.urls)}`)
    })
    ctx.effect(() => () => {
      offDeepLinkProbe()
    })
""", 1)
open(idx, "w").write(src)
print("host/src/index.ts: temporary deepLink consumer inserted")
PY

stage "2. build (bun run tauri build --bundles app)"
( cd "$TREE" && bun install && bun run tauri build --bundles app ) || fail "tauri build"

stage "3. did the BUNDLER put the scheme into the built app?"
if [ -d "$APP" ]; then
  /usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes" "$APP/Contents/Info.plist"
  if /usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes" "$APP/Contents/Info.plist" 2>/dev/null | grep -q "$SCHEME"; then
    pass "built Info.plist declares $SCHEME"
  else
    fail "built Info.plist does NOT declare $SCHEME"
  fi
  ls "$APP/Contents/MacOS/" | sed 's/^/       payload: /'
else
  fail "no app bundle at $APP"
fi

stage "4. does LaunchServices give OUR bundle the scheme?"
"$LSREG" -f "$APP" 2>/dev/null; sleep 1
"$LSREG" -dump 2>/dev/null | grep -B6 "claimed schemes:.*$SCHEME" | grep -E "bundle id|path|claimed schemes" | head -12
if "$LSREG" -dump 2>/dev/null | grep -q "claimed schemes:.*[[:space:]]$SCHEME:"; then
  pass "LaunchServices claims $SCHEME"
else
  fail "LaunchServices does not claim $SCHEME"
fi

stage "5. launch (into the GUI session) and deliver a URL from SSH"
rm -rf "$HOSTLOG_DIR"
pkill -f "$APP/Contents/MacOS" 2>/dev/null
sleep 1
open -a "$APP" || fail "open -a failed"
for _ in $(seq 1 90); do ls "$HOSTLOG_DIR" >/dev/null 2>&1 && break; sleep 1; done
echo "--- host log before the URL ---"
tail -10 "$HOSTLOG_DIR"/* 2>/dev/null || echo "(no host log — the sidecar may not have started)"
sleep 3
open "$SCHEME://hello?a=1" && echo "open returned 0 (⚠ NOT evidence on its own)" || fail "open returned non-zero"
sleep 8

stage "6. ASSERT on the APP side: did the host receive deepLink.opened?"
if grep -rh "deepLink.opened received" "$HOSTLOG_DIR" 2>/dev/null; then
  pass "URL reached the host: macOS -> shell -> kkrpc/stdio -> host consumer"
else
  fail "no deepLink.opened in the host log"
  tail -30 "$HOSTLOG_DIR"/* 2>/dev/null || echo "(no host log at all)"
fi

stage "7. cleanup"
pkill -f "$APP/Contents/MacOS" 2>/dev/null && echo "killed app" || echo "(app not running)"
"$LSREG" -u "$APP" >/dev/null 2>&1
echo "(tree restored from *.orig; the built .app is left in place)"

echo
if [ "$FAILED" -eq 0 ]; then echo "### VERDICT: all assertions passed ###"; else echo "### VERDICT: FAILURES ###"; fi
exit "$FAILED"
