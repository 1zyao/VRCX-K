/**
 * The blocking prerequisite for `ctx.hands`: can the host's stdio channel carry
 * streams WITHOUT regressing ordinary RPC?
 *
 * WHY THIS EXISTS
 *   `host/src/stdio.ts` builds its channel as:
 *
 *     import { RPCChannel } from "kkrpc"
 *     const channel = new RPCChannel<HostStdioAPI, ShellSysAPI>(transport, {...})
 *
 *   The base `RPCChannel` has **no** stream handling at all — measured: the
 *   compiled `channel-*.js` contains zero occurrences of the `"sq"` / `"sr"`
 *   frame tags it would have to route. So today the host physically cannot
 *   receive what `hands.read` produces: the stream frames arrive and are dropped
 *   (a `t:"sr"` frame is not a recognised shape, so it is ignored).
 *
 *   The candidate fix is `StreamingRPCChannel` from `kkrpc/streaming`. But that
 *   replaces the channel class on the ONE channel that carries every shell RPC
 *   (notify/dialog/window/tray/shortcut/lifecycle). "It extends RPCChannel so it
 *   must be safe" is exactly the kind of extrapolation this probe set keeps
 *   falsifying, so it is measured.
 *
 * WHAT IS MEASURED
 *   Q1. Is `StreamingRPCChannel` a drop-in for ordinary request/response RPC —
 *       same constructor options, same `getAPI()` / `expose` semantics, both
 *       directions?
 *   Q2. Can the host CONSUME a stream using the exact frame set
 *       `src-tauri/src/kkrpc_peer.rs` emits? The peer here is a SCRIPTED frame
 *       handler on the raw transport, which is what the Rust side actually is —
 *       not a second StreamingRPCChannel (that would only prove kkrpc agrees
 *       with itself).
 *
 * Run: bun run docs/probes/probe-host-streaming-channel.ts
 */
import { RPCChannel as BaseRPCChannel } from "kkrpc"
import { StreamingRPCChannel } from "kkrpc/streaming"

type Message = Record<string, unknown>
type Listener = (message: Message) => void

/** One end of the raw transport; `peer` is the other end's inbound handler. */
type Wire = {
  send: (message: Message) => void
  subscribe: (listener: Listener) => () => void
}

/** Two ends of an in-memory transport, so no child process is needed. */
function pair(): [Wire, Wire] {
  const a = new Set<Listener>()
  const b = new Set<Listener>()
  return [
    {
      send: (m) => {
        for (const listener of [...b]) listener(m)
      },
      subscribe: (l) => {
        a.add(l)
        return () => a.delete(l)
      },
    },
    {
      send: (m) => {
        for (const listener of [...a]) listener(m)
      },
      subscribe: (l) => {
        b.add(l)
        return () => b.delete(l)
      },
    },
  ]
}

const results: Array<{ name: string; pass: boolean; detail: string }> = []
function check(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `\n         ${detail}` : ""}`)
}

async function main() {
  // ---------------------------------------------------------------------
  // Q1 — plain RPC in both directions, through the streaming channel.
  //
  // The API shapes mirror production: the HOST exposes HostStdioAPI
  // (`ping`) and calls the SHELL's ShellSysAPI (`shell.notify`), which the
  // shell exposes as a nested namespace.
  // ---------------------------------------------------------------------
  console.log("Q1. is StreamingRPCChannel a drop-in for ordinary RPC?\n")

  const [hostWire, shellWire] = pair()
  const shellCalls: string[] = []

  const shellChannel = new StreamingRPCChannel<Record<string, unknown>, Record<string, unknown>>(
    shellWire as never,
    {
      expose: {
        // Real shape: ShellSysAPI is a nested `shell` namespace plus `ready`.
        ready: async () => undefined,
        shell: {
          notify: async (title: string, body: string) => {
            shellCalls.push(`${title}/${body}`)
            return true
          },
        },
      },
    },
  )
  const hostChannel = new StreamingRPCChannel<Record<string, unknown>, Record<string, unknown>>(
    hostWire as never,
    {
      expose: {
        ping: async () => "pong",
      },
    },
  )

  const shellApi = hostChannel.getAPI() as {
    shell: { notify: (t: string, b: string) => Promise<boolean> }
    hands: { read: (path: string) => AsyncIterable<unknown> }
  }

  let notifyResult: unknown
  try {
    notifyResult = await shellApi.shell.notify("title", "body")
  } catch (error) {
    check("ordinary host→shell RPC resolves", false, String(error))
  }
  check(
    "ordinary host→shell RPC resolves (host → shell, nested namespace)",
    notifyResult === true,
    `shell.notify returned ${JSON.stringify(notifyResult)}; shell saw ${JSON.stringify(shellCalls)}`,
  )

  // Reverse direction: the shell calls the host's exposed `ping`.
  const shellToHost = shellChannel.getAPI() as { ping: () => Promise<string> }
  let pong: unknown
  try {
    pong = await shellToHost.ping()
  } catch (error) {
    check("ordinary shell→host RPC resolves", false, String(error))
  }
  check(
    "ordinary shell→host RPC resolves (expose path)",
    pong === "pong",
    `ping returned ${JSON.stringify(pong)}`,
  )

  // ---------------------------------------------------------------------
  // Q2 — consume a Rust-shaped stream.
  //
  // A SCRIPTED peer answers the frames exactly as `kkrpc_peer.rs` does:
  //   1. reply to `hands.read` with a stream-REFERENCE, not data
  //   2. answer each `sq pull` with `sr` chunks (base64) and a terminal frame
  // This is the real half of the contract the host must meet.
  // ---------------------------------------------------------------------
  console.log("\nQ2. can the host consume a stream in the Rust peer's frame set?\n")

  const [hostWire2, peerWire] = pair()
  const produced = ["AAEC", "AwQF"] // base64: [0,1,2] and [3,4,5]
  let pulls = 0
  let sawReturn = false

  const host2 = new StreamingRPCChannel<Record<string, unknown>, Record<string, unknown>>(
    hostWire2 as never,
    {},
  )

  // The scripted peer: read-side handler for everything the host emits.
  peerWire.subscribe((message) => {
    const path = Array.isArray(message.p) ? (message.p as string[]).join(".") : undefined
    if (message.t === "q" && path === "hands.read") {
      peerWire.send({
        t: "r",
        id: message.id,
        // A reference, not bytes — this is what makes the file cheap.
        v: { __kkrpc_next_stream__: "async-iterable", id: "s-1" },
      })
      return
    }
    if (message.t === "sq" && message.op === "pull") {
      pulls += 1
      const sid = message.sid as string
      for (const [index, chunk] of produced.entries()) {
        peerWire.send({ t: "sr", id: `x-${index}`, sid, d: false, v: chunk })
      }
      peerWire.send({ t: "sr", id: "x-end", sid, d: true })
      return
    }
    if (message.t === "sq" && message.op === "return") {
      sawReturn = true
      peerWire.send({ t: "sr", id: message.id, sid: message.sid, d: true })
    }
  })

  const streamApi = host2.getAPI() as {
    hands: { read: (path: string) => AsyncIterable<unknown> }
  }

  // What the host ACTUALLY receives per chunk, recorded verbatim. The first run
  // of this probe assumed `Uint8Array` and got zero bytes: the stock JSON codec
  // has no binary form, so the peer's base64 string arrives as a STRING. The
  // type of the delivered value is therefore a design input for §2's
  // `AsyncIterable<Uint8Array>` signature, not an implementation detail.
  const observed: Array<{ type: string; sample: string; byteLength: number | null }> = []
  try {
    for await (const chunk of streamApi.hands.read("/tmp/x")) {
      const asBytes =
        chunk instanceof Uint8Array
          ? chunk
          : typeof chunk === "string"
            ? new Uint8Array(Buffer.from(chunk, "base64"))
            : null
      observed.push({
        type: chunk === null ? "null" : chunk instanceof Uint8Array ? "Uint8Array" : typeof chunk,
        sample: typeof chunk === "string" ? chunk : JSON.stringify(chunk)?.slice(0, 24) ?? "?",
        byteLength: asBytes ? asBytes.length : null,
      })
    }
  } catch (error) {
    check("host consumes a Rust-shaped stream", false, String(error))
  }

  const decoded = observed.filter((entry) => entry.byteLength === 3)
  check(
    "the host receives every Rust chunk and can decode it to 3 bytes",
    observed.length === produced.length && decoded.length === produced.length,
    `delivered ${observed.length}/${produced.length}; types=${JSON.stringify(
      [...new Set(observed.map((entry) => entry.type))],
    )}; samples=${JSON.stringify(observed.map((entry) => entry.sample))}`,
  )
  check(
    "the delivered chunk is a base64 STRING, not bytes (the stock codec has no binary form)",
    observed.length > 0 && observed.every((entry) => entry.type === "string"),
    `types seen: ${JSON.stringify([...new Set(observed.map((entry) => entry.type))])} — ` +
      `so §2's AsyncIterable<Uint8Array> requires the HOST SIDE to decode base64, ` +
      `it is not a pass-through`,
  )
  check(
    "the host's consumer opened the credit window (a pull reached the peer)",
    pulls >= 1,
    `peer saw ${pulls} pull(s) — without this the peer never sends anything`,
  )

  // ---------------------------------------------------------------------
  // Q3 — the control: prove the BASE channel cannot do this, so the claim
  // "stdio.ts must change" is a measurement and not a reading of the docs.
  // ---------------------------------------------------------------------
  console.log("\nQ3. control — does the base RPCChannel route stream frames?\n")

  const [hostWire3, peerWire3] = pair()
  const base = new BaseRPCChannel<Record<string, unknown>, Record<string, unknown>>(
    hostWire3 as never,
    {},
  )
  let basePulls = 0
  peerWire3.subscribe((message) => {
    if (message.t === "sq" && message.op === "pull") basePulls += 1
  })

  const baseApi = base.getAPI() as { hands?: { read?: unknown } }
  // The base channel has no stream-ref decoding at all: a stream-ref value stays
  // a plain object, so the caller cannot `for await` it.
  let baseIsIterable = false
  try {
    const value = await (baseApi as unknown as { hands: { read: () => Promise<unknown> } }).hands.read()
    baseIsIterable = typeof (value as AsyncIterable<unknown>)?.[Symbol.asyncIterator] === "function"
  } catch {
    // A rejection is also a fine outcome for the control — it means no stream.
  }
  check(
    "base RPCChannel cannot produce a stream (no pull, not iterable)",
    basePulls === 0 && !baseIsIterable,
    `base pulls=${basePulls}, iterable=${baseIsIterable} — this is why stdio.ts must switch`,
  )

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  console.log(`RESULT ${JSON.stringify({ results })}`)
  process.exit(failed.length ? 1 : 0)
}

main()
