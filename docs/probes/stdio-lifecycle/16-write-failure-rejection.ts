// e-write-failure-rejection.ts — the missing cell E.
//
// Review finding (1zyao, on the `shell.ready` narrowing): kkrpc has TWO independent
// "peer is gone" paths, and the narrowing in host/src/index.ts only covers the
// first:
//
//   A–D (already in probe 15):
//     peer closes -> handleTransportClose -> RPCTransportClosedError
//   E (this file):
//     WRITE FAILS -> post() -> handleWriteFailure() -> rejectPendingWrite()
//     -> the raw write Error, NOT wrapped in RPCTransportClosedError
//
// If E is a plain Error, then a shell that dies while `shell.ready` is in
// flight can still surface as a bare rejection, which the narrowed catch
// rethrows -> bootstrap catch-all -> exit 1, racing stopOnStdinLoss's exit 0.
//
// The reviewer worked this out by reading kkrpc's source and explicitly did not
// run it. Measure it instead of inheriting the conclusion.

import { RPCChannel, RPCTransportClosedError } from "../../../host/node_modules/kkrpc/dist/mod.js"
import type { Transport, RPCMessage } from "../../../host/node_modules/kkrpc/dist/mod.js"

/** A transport whose send() rejects, to drive the write-failure path. */
function failingWriteTransport(message: string) {
  let listener: ((m: RPCMessage) => void) | undefined
  let closeListener: ((reason?: unknown) => void) | undefined
  const transport: Transport<RPCMessage> = {
    send() {
      // Exactly what a broken pipe produces: a write error.
      return Promise.reject(new Error(message))
    },
    subscribe(next) {
      listener = next
      return () => {
        listener = undefined
      }
    },
    onClose(next) {
      closeListener = next as (reason?: unknown) => void
      return () => {
        closeListener = undefined
      }
    },
  } as unknown as Transport<RPCMessage>
  return {
    transport,
    killPeer(reason?: unknown) {
      closeListener?.(reason)
    },
    deliver(m: unknown) {
      listener?.(m as RPCMessage)
    },
  }
}

function describe(e: unknown) {
  if (!(e instanceof Error)) return { kind: `non-error: ${String(e)}` }
  return {
    ctor: e.constructor.name,
    name: e.name,
    message: e.message,
    isTransportClosed: e instanceof RPCTransportClosedError,
  }
}

const out: Record<string, unknown> = {}

// ── E. the write itself fails ──────────────────────────────────────────────
{
  const wire = failingWriteTransport("write EPIPE")
  const ch = new RPCChannel(wire.transport, { expose: {} })
  const err = await ch.getAPI().ready({ port: 1, token: "t" }).catch((e: unknown) => e)
  out.E_write_failure = describe(err)
}

// ── E2. same, but the write fails with a non-Error (string) ────────────────
{
  const wire = failingWriteTransport("just a string")
  const ch = new RPCChannel(wire.transport, { expose: {} })
  const err = await ch.getAPI().ready({ port: 1, token: "t" }).catch((e: unknown) => e)
  out.E2_write_failure_string = describe(err)
}

// ── A. control: peer close, for comparison (should be RPCTransportClosedError)
{
  const wire = failingWriteTransport("unused")
  // Replace send with a hanging one so only the close path can settle the call.
  ;(wire.transport as unknown as { send: () => Promise<void> }).send = () => new Promise<void>(() => {})
  const ch = new RPCChannel(wire.transport, { expose: {} })
  const call = ch.getAPI().ready({ port: 1, token: "t" }).catch((e: unknown) => e)
  await new Promise((r) => setTimeout(r, 20))
  wire.killPeer(new Error("stdin gone"))
  out.A_peer_close_control = describe(await call)
}

console.log(JSON.stringify(out, null, 2))

const e = out.E_write_failure as { isTransportClosed?: boolean } | undefined
const a = out.A_peer_close_control as { isTransportClosed?: boolean } | undefined
// The finding is CONFIRMED when the write-failure rejection is NOT classified as
// transport-closed while the peer-close one IS — i.e. the narrowed catch in
// host/src/index.ts rethrows E.
const confirmed = e?.isTransportClosed === false && a?.isTransportClosed === true
console.log(
  confirmed
    ? "\n=> FINDING CONFIRMED: a write failure rejects with a plain Error, so the\n" +
        "   `instanceof RPCTransportClosedError` narrowing rethrows it -> exit 1 race.\n" +
        "   This cell (E) was missing from the original taxonomy."
    : "\n=> finding NOT reproduced — see the cells above.",
)
if (!confirmed) process.exitCode = 1
