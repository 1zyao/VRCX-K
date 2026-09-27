/**
 * HEAD-OF-LINE BLOCKING: can a bulk stream share ONE ws connection with RPC?
 *
 * THE DESIGN QUESTION
 *   The face⇄brain hop already carries RPC on a WebSocket. If large binary
 *   transfers ride the SAME connection "at low priority", the question is not
 *   whether the bytes arrive — it is whether an interactive call (a button
 *   click, a presence query) still answers promptly WHILE megabytes are in
 *   flight. WebSocket is a single ordered stream: everything queues behind
 *   whatever is being written, so this is a real risk, not a theoretical one.
 *
 * WHY A MEASUREMENT IS REQUIRED
 *   "Low priority" has at least three possible meanings, and they behave
 *   completely differently on one socket:
 *
 *     A burst      — write the whole transfer as fast as the socket accepts.
 *                    Whatever queues, queues; RPC waits behind it.
 *     B yielding   — write a bounded slice, then yield to the event loop so any
 *                    pending RPC can be written between slices.
 *     C gated      — as B, but the bulk sender CHECKS whether an RPC is pending
 *                    and stalls until it clears (explicit priority).
 *
 *   A and B differ only in how the sender schedules; C additionally depends on
 *   the transport exposing "is something else waiting". This file measures all
 *   three on the same payload so the choice is made from latency numbers.
 *
 * WHAT IS MEASURED
 *   · RPC round-trip latency distribution (p50 / p95 / p99 / max) during bulk
 *   · bulk throughput (so priority cannot be bought with unlimited time)
 *   · whether the transfer completed byte-exact at all
 *
 * CLIENT CHOICE
 *   The client is the runtime's GLOBAL WebSocket, because that is what
 *   `src/host.ts` builds via kkrpc's `webSocketClientTransport`. Measuring a
 *   client the product does not use would make the result irrelevant.
 *
 * Usage:
 *   node 03-head-of-line-server.mjs --port=46100          (background task)
 *   node 03-head-of-line.mjs --port=46100                 (runs the scenarios)
 */
import { WebSocketServer } from "ws"
import { makeFrame } from "./proto.mjs"

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

const PORT = Number(args.port ?? 46100)
// `--frames` / `--size` are deliberately NOT read here: the frame set is built
// per session from the client's control message, so a startup value would only
// ever be stale or wrong. Only the slice width is a server-side policy.
const SLICE = Number(args.slice ?? 4) // frames written per scheduling turn
const PING_INTERVAL_MS = 20
const RUNTIME = typeof Bun !== "undefined" ? `bun-${Bun.version}` : `node-${process.version}`

const te = new TextEncoder()
const td = new TextDecoder()

/**
 * Frames are built PER SESSION from the control message, not from this
 * process's command line. The first version built one array at startup and the
 * client's `--frames` could disagree with it, which showed up as thousands of
 * "missing" frames — a self-inflicted mismatch that looked like transport loss.
 */
const frameCache = new Map()
function framesFor(count, size) {
  const key = `${count}x${size}`
  let cached = frameCache.get(key)
  if (!cached) {
    cached = []
    for (let i = 0; i < count; i++) cached.push(makeFrame(i, size))
    frameCache.set(key, cached)
    process.stderr.write(`[hol] built ${count} x ${size}B (${((count * size) / 1048576).toFixed(0)} MiB)\n`)
  }
  return cached
}

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT, maxPayload: 1 << 30, perMessageDeflate: false })

/**
 * The server sends the bulk transfer on ONE connection while answering RPC on
 * the same connection. Both directions share the socket in each scenario, so
 * the measurement covers the contention a real deployment would see.
 */
wss.on("connection", (socket) => {
  let session = null
  let sent = 0
  let slices = 0
  /** The frame set for THIS session, sized from its own control message. */
  let frames = []

  const control = (obj) => socket.send(JSON.stringify({ ctl: true, ...obj }), { binary: false })

  /** Scenario A: hand the whole transfer to the socket in one turn. */
  const sendBurst = () => {
    for (const frame of frames) {
      socket.send(frame, { binary: true })
      sent++
    }
    control({ id: session.id, done: true, sent, slices: 0 })
  }

  /**
   * Scenario B: write a bounded slice, then yield.
   *
   * `setImmediate` is the weakest possible form of yielding — it lets already
   * queued I/O callbacks run before the next slice. If even this is enough to
   * keep RPC responsive, priority needs no transport support at all.
   */
  const sendYielding = () => {
    const step = () => {
      const end = Math.min(sent + SLICE, frames.length)
      for (let i = sent; i < end; i++) {
        socket.send(frames[i], { binary: true })
        sent++
      }
      slices++
      if (sent < frames.length) setImmediate(step)
      else control({ id: session.id, done: true, sent, slices })
    }
    step()
  }

  /**
   * Scenario C: as B, but hold the bulk while an RPC is outstanding.
   *
   * `pendingRpc` is set when a call arrives and cleared when its reply is
   * written. This is "explicit priority": the bulk sender inspects shared state
   * rather than hoping the scheduler is fair.
   */
  let pendingRpc = 0
  const sendGated = () => {
    const step = () => {
      if (pendingRpc > 0) {
        // An interactive call is waiting: give the loop a turn and re-check.
        setTimeout(step, 0)
        return
      }
      const end = Math.min(sent + SLICE, frames.length)
      for (let i = sent; i < end; i++) {
        socket.send(frames[i], { binary: true })
        sent++
      }
      slices++
      if (sent < frames.length) setImmediate(step)
      else control({ id: session.id, done: true, sent, slices })
    }
    step()
  }

  socket.on("message", (data, isBinary) => {
    if (isBinary) return
    const text = data.toString("utf8")
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }

    // The interactive call: answered IMMEDIATELY on arrival, on the same socket.
    if (msg.rpc === "ping") {
      pendingRpc++
      socket.send(JSON.stringify({ rpc: "pong", seq: msg.seq, t: msg.t }), { binary: false })
      pendingRpc--
      return
    }

    if (msg.ctl !== true) return
    session = msg
    frames = framesFor(msg.frames, msg.size)
    sent = 0
    slices = 0
    if (msg.scenario === "A" || msg.scenario === "A-slow") sendBurst()
    else if (msg.scenario === "B" || msg.scenario === "B-slow") sendYielding()
    else sendGated()
  })

  socket.on("error", (err) => process.stderr.write(`[hol] socket error: ${err.message}\n`))
})

wss.on("listening", () => {
  // Report the PORT, not frame counts. Frames are built per SESSION from each
  // control message, so these startup values were stale the moment a probe asked
  // for a different size: the banner announced 512 frames while a run used 256,
  // which reads like a configuration mismatch rather than a normal session.
  process.stdout.write(
    JSON.stringify({
      ready: true,
      port: PORT,
      note: "frame count/size come from each session's control message",
    }) + "\n",
  )
  process.stderr.write(`[hol:${RUNTIME}] listening on ${PORT} (scenario sizes arrive per session)\n`)
})

process.on("SIGTERM", () => process.exit(0))
