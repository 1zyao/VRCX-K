/**
 * BACKPRESSURE: is the producer bounded when the consumer stops draining?
 *
 * WHY THIS FILE REPLACES THE PREVIOUS ATTEMPT
 *   The first version reported "kkrpc/streaming produced 0 chunks while the
 *   consumer stalled => flow control holds". That was VACUOUS: the client never
 *   called `readFile()` at all, so the generator never started. Zero chunks was
 *   evidence that nothing was requested, not that anything was bounded. The
 *   control arm (no flow control, 2048 MiB straight into the socket buffer) was
 *   the only real reading in it.
 *
 * THE CORRECT EXPERIMENT
 *   The consumer must genuinely open the stream, take ONE item, and then stop
 *   pulling — the state a slow phone or a paused UI leaves the system in. Only
 *   then does "how far did the producer get?" measure flow control.
 *
 *     server: an async generator that counts every chunk it is allowed to yield
 *     client: remote.readFile(), take exactly one chunk, then never pull again
 *     after a fixed stall: read the producer's counter
 *
 *   bounded   (≈ kkrpc's 32-chunk credit)  => memory ≈ credit x chunk size
 *   unbounded (runs to TOTAL)              => a large file would be buffered
 *                                             whole, defeating "streaming"
 *
 * TWO ARMS, both now actually pulling:
 *   gated  kkrpc/streaming over a binary ws transport — initial credit 32,
 *          replenished every 16 consumed values
 *   raw    the same transport, no kkrpc: a plain send loop. This is the control
 *          showing what an UNGATED producer does, so the gated number means
 *          something by comparison.
 *
 * ALSO MEASURED: whether closing/aborting mid-stream stops the producer. A
 * cancelled transfer that keeps reading a file to completion is a real bug that
 * no throughput number would reveal.
 *
 * Usage: node 02-backpressure.mjs [--chunk=1048576] [--total=2048] [--stallMs=2000]
 *        Ports default to 46300/46301 and are derived from --port; nothing else must run.
 */
import { WebSocketServer, WebSocket as WsClient } from "ws"
import { RPCChannel } from "kkrpc/streaming"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
/**
 * Flags are normalised from `--kebab-case` to `camelCase` on the way in.
 *
 * Without this, a documented `--some-flag=x` produced the key `some-flag`
 * while the code read `args.someFlag`: the flag was silently ignored and the
 * default was used instead. That is the same silent-failure class this whole
 * investigation keeps running into — the symptom never names the cause.
 */
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [rawKey, v] = a.replace(/^--/, "").split("=")
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    return [key, v === undefined ? "true" : v]
  }),
)

const CHUNK = Number(args.chunk ?? 1024 * 1024)
const TOTAL = Number(args.total ?? 2048)
const STALL_MS = Number(args.stallMs ?? 2000)
const runtime = typeof Bun !== "undefined" ? `bun-${Bun.version}` : `node-${process.version}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeChunk(seq) {
  const buf = new Uint8Array(CHUNK)
  new DataView(buf.buffer).setBigUint64(0, BigInt(seq))
  return buf
}

/** Minimal binary WebSocket transport: JSON structure, bytes in binary frames. */
function binaryTransport(socket, stats, onMessage) {
  const listeners = new Set()
  const payloadsOf = (value, sink) => {
    if (value === null || typeof value !== "object") return
    if (typeof value.$b === "number" && typeof value.n === "number") {
      sink.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const v of value) payloadsOf(v, sink)
      return
    }
    for (const k of Object.keys(value)) payloadsOf(value[k], sink)
  }
  const revive = (value, map) => {
    if (value === null || typeof value !== "object") return value
    if (typeof value.$b === "number" && typeof value.n === "number") return map.get(value.$b)
    if (Array.isArray(value)) return value.map((v) => revive(v, map))
    const out = {}
    for (const k of Object.keys(value)) out[k] = revive(value[k], map)
    return out
  }
  const encode = (message) => {
    const payloads = []
    const json = JSON.stringify(message, (_k, value) => {
      if (value instanceof Uint8Array) {
        payloads.push(value)
        return { $b: payloads.length - 1, n: value.byteLength }
      }
      return value
    })
    if (payloads.length === 0) return json
    const header = Buffer.allocUnsafe(4)
    header.writeUInt32BE(Buffer.byteLength(json), 0)
    return Buffer.concat([header, Buffer.from(json, "utf8"), ...payloads.map((p) => Buffer.from(p))])
  }
  const decode = (data) => {
    if (typeof data === "string") return JSON.parse(data)
    const buf = Buffer.from(data)
    const len = buf.readUInt32BE(0)
    const parsed = JSON.parse(buf.toString("utf8", 4, 4 + len))
    const ph = []
    payloadsOf(parsed, ph)
    ph.sort((a, b) => a.$b - b.$b)
    let off = 4 + len
    const map = new Map()
    for (const p of ph) {
      map.set(p.$b, buf.subarray(off, off + p.n))
      off += p.n
    }
    return revive(parsed, map)
  }
  const handler = (data, isBinary) => {
    const msg = decode(isBinary ? new Uint8Array(data) : data.toString("utf8"))
    if (onMessage) onMessage(msg)
    for (const l of [...listeners]) l(msg)
  }
  socket.on("message", handler)
  return {
    capabilities: { objectMode: false, transfer: false, remoteRefs: false },
    send(message) {
      stats.frames++
      socket.send(encode(message))
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      socket.close?.()
    },
  }
}

/**
 * One arm. `gated` routes the transfer through kkrpc/streaming; `raw` sends on
 * the same transport with no flow control at all.
 */
async function arm(mode, port) {
  const stats = { frames: 0 }
  let produced = 0
  let producerDone = false
  /** Set when the consumer's first pull has actually arrived. */
  let consumerOpened = false
  /** Set when the client closes mid-stream, to check cancellation. */
  let peerClosed = false

  const wss = new WebSocketServer({ host: "127.0.0.1", port, maxPayload: 1 << 30, perMessageDeflate: false })
  await new Promise((r) => wss.once("listening", r))

  wss.on("connection", (socket) => {
    socket.once("close", () => {
      peerClosed = true
    })
    if (mode === "gated") {
      const api = {
        async *readFile() {
          consumerOpened = true
          for (let i = 0; i < TOTAL; i++) {
            produced++
            yield makeChunk(i)
          }
          producerDone = true
        },
      }
      const channel = new RPCChannel(binaryTransport(socket, stats), { expose: api })
      socket.once("close", () => channel.destroy())
    } else {
      // Ungated: the moment the consumer asks, blast everything into the socket.
      const onMessage = (msg) => {
        if (msg?.ctl !== true) return
        consumerOpened = true
        void (async () => {
          for (let i = 0; i < TOTAL; i++) {
            if (socket.readyState !== 1) break
            produced++
            socket.send(makeChunk(i), { binary: true })
            if (i % 64 === 0) await sleep(0)
          }
          producerDone = true
        })()
      }
      binaryTransport(socket, stats, onMessage)
    }
  })

  const client = new WsClient(`ws://127.0.0.1:${port}`, { perMessageDeflate: false, maxPayload: 1 << 30 })
  await new Promise((resolve, reject) => {
    client.once("open", resolve)
    client.once("error", reject)
  })

  let firstChunkAt = null
  let chunksTaken = 0
  const clientStats = { frames: 0 }

  if (mode === "gated") {
    const remote = new RPCChannel(binaryTransport(client, clientStats)).getAPI()
    const iterable = await remote.readFile("/f")
    const it = iterable[Symbol.asyncIterator]()
    // TAKE EXACTLY ONE. Then stop pulling — the slow-consumer state.
    const first = await it.next()
    if (!first.done) {
      chunksTaken = 1
      firstChunkAt = Date.now()
    }
    // Deliberately no further next() calls.
    await sleep(STALL_MS)
    const atStall = produced
    const doneAtStall = producerDone

    // Cancellation: close the socket mid-stream and see if the producer stops.
    client.close()
    const beforeClose = produced
    await sleep(1200)
    const afterClose = produced

    wss.close()
    return {
      mode,
      runtime,
      chunkMiB: +(CHUNK / 1048576).toFixed(2),
      theoreticalTotalMiB: +((TOTAL * CHUNK) / 1048576).toFixed(0),
      stallMs: STALL_MS,
      consumerOpened,
      chunksTaken,
      producedWhileStalled: atStall,
      producerFinishedWhileStalled: doneAtStall,
      inFlightMiBAtStall: +((atStall * CHUNK) / 1048576).toFixed(1),
      bounded: !doneAtStall && atStall < TOTAL,
      producedAfterClose: afterClose - beforeClose,
      cancellationStoppedIt: afterClose - beforeClose < 32,
      clientFrames: clientStats.frames,
    }
  }

  // raw arm: ask, then read nothing at all.
  client.on("message", () => {
    chunksTaken++
  })
  client.send(JSON.stringify({ ctl: true, mode }))
  await sleep(STALL_MS)
  const atStall = produced
  const doneAtStall = producerDone
  client.close()
  const beforeClose = produced
  await sleep(1200)
  const afterClose = produced
  wss.close()
  return {
    mode,
    runtime,
    chunkMiB: +(CHUNK / 1048576).toFixed(2),
    theoreticalTotalMiB: +((TOTAL * CHUNK) / 1048576).toFixed(0),
    stallMs: STALL_MS,
    consumerOpened,
    chunksTaken,
    producedWhileStalled: atStall,
    producerFinishedWhileStalled: doneAtStall,
    inFlightMiBAtStall: +((atStall * CHUNK) / 1048576).toFixed(1),
    bounded: !doneAtStall && atStall < TOTAL,
    producedAfterClose: afterClose - beforeClose,
    cancellationStoppedIt: afterClose - beforeClose < 32,
    peerClosed,
  }
}

const results = []
for (const [mode, port] of [
  ["gated", Number(args.port ?? 46300)],
  ["raw", Number(args.port ?? 46300) + 1],
]) {
  process.stderr.write(`[bp] ${mode} ... `)
  const r = await arm(mode, port)
  results.push(r)
  process.stderr.write(
    `opened=${r.consumerOpened} took=${r.chunksTaken} produced-while-stalled=${r.producedWhileStalled} ` +
      `(${r.inFlightMiBAtStall} MiB) bounded=${r.bounded} cancel-stops=${r.cancellationStoppedIt}\n`,
  )
  await sleep(400)
}

mkdirSync(join(here, "results"), { recursive: true })
writeFileSync(join(here, "results", "backpressure.json"), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2))

const lines = []
lines.push("=== BACKPRESSURE: producer behaviour when the consumer stops pulling ===")
lines.push(`${CHUNK / 1048576} MiB chunks, up to ${((TOTAL * CHUNK) / 1048576).toFixed(0)} MiB available, stall ${STALL_MS} ms`)
lines.push(`client = ws package (${runtime})`)
lines.push("")
lines.push("  arm     opened  took  produced while stalled   in-flight   bounded?  cancel stops it")
for (const r of results) {
  lines.push(
    `  ${r.mode.padEnd(7)} ${String(r.consumerOpened).padEnd(7)} ${String(r.chunksTaken).padStart(4)}  ` +
      `${String(r.producedWhileStalled).padStart(21)}   ${String(r.inFlightMiBAtStall).padStart(8)} MiB  ` +
      `${String(r.bounded).padEnd(9)} ${r.cancellationStoppedIt}`,
  )
}

lines.push("")
lines.push("=== VERDICT ===")
const gated = results.find((r) => r.mode === "gated")
const raw = results.find((r) => r.mode === "raw")

// Guard against repeating the previous file's mistake: a "bounded" reading is
// only meaningful if the consumer actually opened the stream.
if (!gated.consumerOpened) {
  lines.push("  *** INVALID: the gated consumer never opened the stream, so its 0-chunk")
  lines.push("  *** reading proves nothing. Fix the probe before using this result. ***")
} else if (gated.bounded) {
  lines.push(
    `  kkrpc/streaming: the consumer took ${gated.chunksTaken} chunk and stopped; the producer`,
  )
  lines.push(
    `  advanced only ${gated.producedWhileStalled} chunks (${gated.inFlightMiBAtStall} MiB) in ${STALL_MS} ms`,
  )
  lines.push("  => BOUNDED. Memory while streaming a large file is ~credit x chunk size,")
  lines.push("     NOT the file size. This is what makes 'streaming' true rather than nominal.")
} else {
  lines.push(
    `  *** kkrpc/streaming produced ${gated.producedWhileStalled} chunks (${gated.inFlightMiBAtStall} MiB)`,
  )
  lines.push("  *** while the consumer pulled once. NOT BOUNDED by the credit window. ***")
}
if (raw) {
  lines.push(
    `  comparison (no flow control at all): ${raw.producedWhileStalled} chunks = ` +
      `${raw.inFlightMiBAtStall} MiB queued in the socket buffer`,
  )
  if (raw.producedWhileStalled > 0 && gated.producedWhileStalled > 0) {
    lines.push(
      `  => gating constrains the producer by ${(raw.producedWhileStalled / Math.max(1, gated.producedWhileStalled)).toFixed(0)}x`,
    )
  }
}
lines.push("")
for (const r of results) {
  lines.push(
    `  ${r.mode}: cancellation — ${r.producedAfterClose} further chunks after close ` +
      `(${r.cancellationStoppedIt ? "stopped promptly" : "KEPT PRODUCING"})`,
  )
}
lines.push("")

const text = lines.join("\n")
writeFileSync(join(here, "results", "backpressure-report.txt"), text)
console.log(text)
process.exit(0)
