#!/bin/sh
# Regression test for the platform guard in cross-vm-sweep.sh.
#
# WHY THIS EXISTS: a Windows node.exe launched from WSL via interop runs as a
# WINDOWS process (process.platform=win32) and egresses from 127.0.0.1, so a
# "cross-VM" run with it silently measures Windows loopback. That happened once
# here and produced plausible, meaningless numbers. The sweep must therefore
# REFUSE a non-Linux node rather than report loopback throughput as cross-VM.
#
# Paths are derived from this script's own location, so it works from any clone
# root rather than the machine it was written on.
set -u

SELF_DIR=$(cd "$(dirname "$0")" && pwd)
SWEEP="$SELF_DIR/cross-vm-sweep.sh"

# A win32 node to feed the guard. `node.exe` is the Windows build; interop runs
# it as win32. If it is not present the case is SKIPPED, not silently passed.
WINNODE=""
for c in \
  "/mnt/host/d/Program Files/DSH Desktop/resources/app/node_modules/node/bin/node.exe" \
  "$(command -v node.exe 2>/dev/null)"
do
  if [ -n "$c" ] && [ -x "$c" ]; then WINNODE="$c"; break; fi
done

fails=0

echo "--- case 1: a win32 node must be REFUSED (expect exit 2) ---"
if [ -z "$WINNODE" ]; then
  echo "  SKIP  no node.exe available to test with"
else
  mkdir -p /tmp/xvm-guard/bin
  ln -sf "$WINNODE" /tmp/xvm-guard/bin/node
  OUT=$(sh "$SWEEP" 172.25.32.1 47800 /tmp/xvm-guard 2>&1)
  CODE=$?
  if [ "$CODE" -eq 2 ]; then
    echo "  PASS  refused with exit 2"
  else
    echo "  FAIL  expected exit 2, got $CODE"
    echo "$OUT" | sed 's/^/        /'
    fails=$((fails + 1))
  fi
  # The refusal must SAY why, or the next person will not understand it.
  case "$OUT" in
    *win32*) echo "  PASS  the message names the platform" ;;
    *) echo "  FAIL  refusal did not mention win32"; fails=$((fails + 1)) ;;
  esac
fi

echo ""
echo "--- case 2: a missing node must fail loudly (expect exit 1) ---"
OUT=$(sh "$SWEEP" 172.25.32.1 47800 /tmp/xvm-guard-does-not-exist 2>&1)
CODE=$?
if [ "$CODE" -eq 1 ]; then
  echo "  PASS  failed with exit 1"
else
  echo "  FAIL  expected exit 1, got $CODE"
  fails=$((fails + 1))
fi

echo ""
if [ "$fails" -eq 0 ]; then
  echo "guard test: all cases passed"
  exit 0
fi
echo "guard test: $fails case(s) FAILED"
exit 1
