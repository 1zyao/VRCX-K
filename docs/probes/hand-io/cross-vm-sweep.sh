#!/bin/sh
# Cross-VM sweep: a genuine LINUX node inside WSL driving the LANDED
# transport-lab client against a Windows-side server.
#
# WHY A DOWNLOADED NODE: this distro ships no node, and the Windows node.exe
# reachable via WSL interop runs as a WINDOWS process (process.platform=win32,
# egresses from 127.0.0.1), so a run with it measures **Windows loopback** and
# quietly produces fake "cross-VM" numbers. That mistake was made once here.
# A real hop needs a Linux node. This distro's rootfs had only 29 MB free
# (`apk add nodejs` failed with ENOSPC), so fetch a musl build onto the Windows
# mount instead:
#
#   mkdir -p /mnt/host/e/tmp/nodemusl && cd /mnt/host/e/tmp/nodemusl
#   wget https://unofficial-builds.nodejs.org/download/release/v24.18.1/\
#        node-v24.18.1-linux-x64-musl.tar.xz
#   tar xf node-v24.18.1-linux-x64-musl.tar.xz
#
# Start the Windows-side server first:
#   node docs/probes/transport-lab/server.mjs --base-port=47800 --bind=0.0.0.0
#
# Usage:
#   sh cross-vm-sweep.sh [windows-ip] [base-port] [node-dir]
set -u

HOST="${1:-172.25.32.1}"
BASE="${2:-47800}"
NODEDIR="${3:-/mnt/host/e/tmp/nodemusl/node-v24.18.1-linux-x64-musl}"

NODE="$NODEDIR/bin/node"
REPO="/mnt/host/e/Users/30885/VRCX-K"
LAB="$REPO/docs/probes/transport-lab/client.mjs"

if [ ! -x "$NODE" ]; then
  echo "linux node not found at $NODE — see the header for how to fetch it" >&2
  exit 1
fi
if [ ! -e "$LAB" ]; then echo "lab client not found at $LAB" >&2; exit 1; fi

# The lab's own README documents that kkrpc/ws resolve from the ROOT
# package.json, so run with the repo as CWD.
cd "$REPO" || exit 1

# A single guard so a wrong setup fails loudly instead of producing numbers that
# look like cross-VM results but are not.
PLATFORM=$("$NODE" -e 'process.stdout.write(process.platform)')
if [ "$PLATFORM" != "linux" ]; then
  echo "REFUSING: node reports platform=$PLATFORM, expected linux." >&2
  echo "A win32 node here measures Windows loopback, not the WSL hop." >&2
  exit 2
fi

run_cell() {
  transport="$1"; direction="$2"; size="$3"; encoding="$4"; client="$5"
  case "$transport" in
    ws)  port=$((BASE + 1)) ;;
    tcp) port=$BASE ;;
    udp) port=$((BASE + 2)) ;;
  esac
  echo "--- $transport/$direction size=$size enc=$encoding client=$client ---"
  "$NODE" "$LAB" \
    --transport="$transport" --host="$HOST" --port="$port" \
    --direction="$direction" --frames=64 --size="$size" \
    --encoding="$encoding" --client="$client" 2>&1 | grep '^RESULT' || echo "RESULT {} (no line)"
}

# Encodings at a payload large enough that steady state dominates (small
# transfers are startup-bound and wash the difference out).
for enc in raw base64 json; do run_cell ws down 1048576 "$enc" ws; done
run_cell tcp down 1048576 raw ws
run_cell ws up 1048576 raw ws
run_cell ws down 1048576 raw global
# Falsification control: UDP must LOSE data, proving the detector works.
run_cell udp down 16384 raw ws
