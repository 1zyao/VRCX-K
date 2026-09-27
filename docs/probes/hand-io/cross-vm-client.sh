#!/bin/sh
# WSL-side client for the cross-VM measurements.
#
# WHY: `transport-lab/FINDINGS.md` §8 records that "everything here is loopback"
# and that real-network RTT is the one variable the whole set does NOT measure —
# while §6 shows RTT is decisive (folder upload is 320x slower at 5 ms RTT).
# WSL sits on a Hyper-V vSwitch, so Windows<->WSL TCP is a real network path.
# This script produces the RTT NUMBER that `06-folder-upload.mjs --rttMs=` needs.
#
# The distro has `nc`/`dd` and no node/bun/python, so everything here is
# busybox + POSIX shell. Two things were learned the hard way and are kept as code:
#
#   1. Running this via `wsl -- /bin/sh -c '<multi-line>'` from PowerShell mangles
#      `$vars` in the loop body. Run it as a FILE; that is partly why it exists.
#   2. A `cmd | head -1` pipeline silently yields an empty string here (there is no
#      `head` in PATH), and an empty timer reading renders as `0 ms` — which is how
#      the first attempt produced five impossible samples. So every reply is
#      checked for emptiness and the run FAILS LOUDLY instead of reporting zeros.
#
# Usage:
#   sh cross-vm-client.sh rtt    <host> <port> <count>     # one persistent conn
#   sh cross-vm-client.sh upload <host> <port> <mib>       # throughput

set -u

MODE="${1:-rtt}"
HOST="${2:-172.25.32.1}"
PORT="${3:-47400}"

# `date +%s%N` is the only sub-second clock here. Verify it is real before
# trusting any number derived from it.
clock_ok() {
  A=$(date +%s%N)
  B=$(date +%s%N)
  [ -n "$A" ] && [ -n "$B" ] && [ "$A" != "$B" ]
}

case "$MODE" in
  rtt)
    COUNT="${4:-20}"
    if ! clock_ok; then
      printf 'RESULT {"mode":"rtt","error":"no sub-second clock (date +%%s%%N)"}\n'
      exit 1
    fi

    # ONE connection for all COUNT round trips, via a fifo pair. A fresh
    # connection per ping would include TCP setup, which is not what the lab's
    # `--rttMs` models (it models a request/response round trip).
    D=$(mktemp -d)
    mkfifo "$D/in" "$D/out" || exit 1
    nc -w 5 "$HOST" "$PORT" <"$D/in" >"$D/out" &
    NC_PID=$!
    exec 3>"$D/in"
    exec 4<"$D/out"

    i=1
    total=0
    min=999999
    max=0
    while [ "$i" -le "$COUNT" ]; do
      START=$(date +%s%N)
      printf 'ping-%s\n' "$i" >&3
      REPLY=""
      read -r REPLY <&4
      END=$(date +%s%N)
      if [ -z "$REPLY" ]; then
        printf 'RESULT {"mode":"rtt","error":"empty reply at sample %s (connection dropped or server gone)","host":"%s","port":"%s"}\n' \
          "$i" "$HOST" "$PORT"
        exec 3>&-
        exec 4<&-
        kill "$NC_PID" 2>/dev/null
        rm -rf "$D"
        exit 1
      fi
      DELTA=$(( (END - START) / 1000000 ))
      total=$((total + DELTA))
      [ "$DELTA" -lt "$min" ] && min=$DELTA
      [ "$DELTA" -gt "$max" ] && max=$DELTA
      i=$((i + 1))
    done
    exec 3>&-
    exec 4<&-
    kill "$NC_PID" 2>/dev/null
    rm -rf "$D"

    printf 'RESULT {"mode":"rtt","host":"%s","port":"%s","count":%s,"avgMs":%s,"minMs":%s,"maxMs":%s}\n' \
      "$HOST" "$PORT" "$COUNT" "$((total / COUNT))" "$min" "$max"
    ;;

  upload)
    MIB="${4:-64}"
    COUNT=$((MIB * 16))
    START=$(date +%s%N)
    dd if=/dev/zero bs=64k count="$COUNT" 2>/dev/null | nc -w 10 "$HOST" "$PORT"
    END=$(date +%s%N)
    MS=$(( (END - START) / 1000000 ))
    printf 'RESULT {"mode":"upload","host":"%s","port":"%s","mib":%s,"ms":%s}\n' \
      "$HOST" "$PORT" "$MIB" "$MS"
    ;;

  *)
    echo "unknown mode: $MODE" >&2
    exit 2
    ;;
esac
