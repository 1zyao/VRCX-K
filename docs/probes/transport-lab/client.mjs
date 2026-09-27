/**
 * E2E LAB CLIENT — one probe process, one cell, machine-readable verdict.
 *
 * Runs against the long-lived server (`server.mjs`). Both directions are
 * measured, and — this is the important part — the two directions are verified
 * by DIFFERENT parties:
 *
 *   dir=down  the SERVER sends, the CLIENT verifies
 *   dir=up    the CLIENT sends, the SERVER verifies and returns its verdict
 *
 * So a direction cannot be declared healthy by the same code that produced it.
 * Every earlier round verified the receiving side only, which is how a broken
 * instrument could look like a broken library.
 *
 * TRANSPORTS
 *   tcp   raw length-framed bytes
 *   ws    WebSocket; the `encoding` argument decides HOW BYTES ARE CARRIED:
 *           raw     native binary WS frames (what a correct transport does)
 *           base64  text frames with a base64 string       (~1.33x the payload)
 *           json    text frames with a numeric-keyed object (~11x — exactly
 *                   what kkrpc's built-in transport produces from a Uint8Array,
 *                   measured here rather than asserted)
 *   udp   datagrams, no stream semantics (the loss is EXPECTED and is what makes
 *         the whole measurement falsifiable: a detector that never reports loss
 *         detects nothing)
 *
 * CLIENT IMPLEMENTATION is itself a variable:
 *   --client=ws|global   the `ws` package, or the runtime's global WebSocket
 *                        (which is what kkrpc's `webSocketClientTransport` uses,
 *                        and therefore what src/host.ts actually ships)
 *
 * Usage:
 *   node|bun client.mjs --transport=tcp --port=46000 --direction=down \
 *        --frames=64 --size=1048576 [--encoding=raw] [--client=global]
 */
import { connect } from "node:net"
import { createSocket as createUdpSocket } from "node:dgram"
import { WebSocket as WsClient } from "ws"
import {
  fromBase64,
  MSG,
  packTcp,
  packUdp,
  TcpFramer,
  unpackUdp,
  Verifier,
} from "./proto.mjs"

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

const transport = args.transport
const port = Number(args.port)
const direction = args.direction ?? "down"
const frames = Number(args.frames ?? 64)
const size = Number(args.size ?? 1048576)
const encoding = args.encoding ?? "raw"
const clientKind = args.client ?? "ws"
const host = args.host ?? "127.0.0.1"
const timeoutMs = Number(args.timeoutMs ?? 120000)

const runtime = typeof Bun !== "undefined" ? `bun-${Bun.version}` : `node-${process.version}`
const te = new TextEncoder()
const td = new TextDecoder()

const out = {
  transport,
  direction,
  frames,
  size,
  encoding: transport === "ws" ? encoding : "raw",
  client: transport === "ws" ? clientKind : "-",
  runtime,
}

/** Land the verdict and exit. stdout carries exactly one RESULT line. */
function finish(extra = {}) {
  Object.assign(out, extra)
  process.stdout.write(`RESULT ${JSON.stringify(out)}\n`)
  process.exit(0)
}

const sessionId = `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

// ── outbound frame builder, per transport/encoding ───────────────────────
import { makeFrame } from "./proto.mjs"

function outboundFrame(seq) {
  // The frame is always built the same way; only its CARRIER changes.
  return makeFrame(seq, size)
}

// ── TCP ──────────────────────────────────────────────────────────────────
async function runTcp() {
  const socket = connect({ host, port, noDelay: true })
  const framer = new TcpFramer()
  const verifier = new Verifier(size, frames)
  let controlResolve = null
  const nextControl = () =>
    new Promise((resolve) => {
      controlResolve = resolve
    })
  let pending = nextControl()
  let sent = 0
  let t0 = 0
  let bytesOut = 0

  socket.on("data", (chunk) => {
    for (const message of framer.push(chunk)) {
      if (message.type === MSG.FRAME) {
        if (direction === "down") verifier.add(message.payload)
        continue
      }
      const msg = JSON.parse(td.decode(message.payload))
      controlResolve?.(msg)
      controlResolve = null
    }
  })

  await new Promise((resolve, reject) => {
    socket.once("connect", resolve)
    socket.once("error", reject)
  })

  const ctl = (obj) => socket.write(packTcp(MSG.CONTROL, te.encode(JSON.stringify(obj))))

  if (direction === "down") {
    t0 = Date.now()
    ctl({ id: sessionId, dir: "down", frames, size })
    await Promise.race([pending, new Promise((r) => setTimeout(() => r({ timeout: true }), timeoutMs))])
    const elapsedMs = Date.now() - t0
    return finish({ ...verifier.result(), ...wall(elapsedMs, verifier.bytes) })
  }

  // uplink: announce, wait for ready, blast, then await the server's verdict
  ctl({ id: sessionId, dir: "up", frames, size })
  await Promise.race([pending, new Promise((r) => setTimeout(() => r({ timeout: true }), 15000))])
  t0 = Date.now()
  for (let i = 0; i < frames; i++) {
    const frame = outboundFrame(i)
    bytesOut += frame.length
    socket.write(packTcp(MSG.FRAME, frame))
    sent++
  }
  ctl({ id: sessionId, done: true })
  const verdict = await Promise.race([
    nextControl(),
    new Promise((r) => setTimeout(() => r({ timeout: true }), timeoutMs)),
  ])
  const elapsedMs = Date.now() - t0
  socket.destroy()
  return finish({
    sent,
    bytesOut,
    serverVerdict: verdict.result ?? null,
    ...wall(elapsedMs, bytesOut),
  })
}

function wall(elapsedMs, bytes) {
  return {
    elapsedMs,
    mbps: +(((bytes ?? 0) / 1048576 / Math.max(1, elapsedMs)) * 1000).toFixed(1),
  }
}

// ── WebSocket ────────────────────────────────────────────────────────────
async function runWs() {
  const isPkg = clientKind === "ws"
  const url = `ws://${host}:${port}`
  const socket = isPkg
    ? new WsClient(url, { perMessageDeflate: false, maxPayload: 1 << 30 })
    : new WebSocket(url)
  if (!isPkg && socket.binaryType !== undefined) socket.binaryType = "arraybuffer"

  const verifier = new Verifier(size, frames)
  let controlResolve = null
  let pending = new Promise((r) => (controlResolve = r))
  let bytesOut = 0
  let sent = 0
  let t0 = 0

  /** Encode payload bytes for the wire according to `encoding`. */
  const encodeData = (seq, frame) => {
    if (encoding === "raw") return { data: frame, binary: true }
    if (encoding === "base64") {
      return { data: JSON.stringify({ seq, b64: Buffer.from(frame).toString("base64") }), binary: false }
    }
    return { data: JSON.stringify({ seq, bytes: frame }), binary: false }
  }

  /** Recover payload bytes from an inbound message. */
  const decodeData = (data, isBinary) => {
    if (encoding === "raw") return isBinary ? new Uint8Array(data) : null
    if (isBinary) return null
    const parsed = JSON.parse(data.toString("utf8"))
    if (encoding === "base64") return fromBase64(parsed.b64)
    return new Uint8Array(Object.values(parsed.bytes))
  }

  const onControl = (text) => {
    const msg = JSON.parse(text)
    controlResolve?.(msg)
    controlResolve = null
    pending = new Promise((r) => (controlResolve = r))
  }

  const onData = (data, isBinary) => {
    if (direction !== "down") return
    const frame = decodeData(data, isBinary)
    if (frame) verifier.add(frame)
  }

  const attach = () => {
    // CONTROL IS TAGGED. Sniffing for a leading "{" cannot work: base64 and json
    // DATA frames are text too and start with "{" as well, so a heuristic
    // discards real payload and reports phantom data loss.
    const handleText = (text) => {
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        return // not JSON: cannot be a control frame
      }
      if (parsed.ctl === true) onControl(text)
      else onData(Buffer.from(text), false)
    }
    if (isPkg) {
      socket.on("message", (data, isBinary) => {
        if (isBinary) onData(new Uint8Array(data), true)
        else handleText(data.toString("utf8"))
      })
    } else {
      socket.addEventListener("message", (ev) => {
        const d = ev.data
        if (typeof d === "string") handleText(d)
        else onData(new Uint8Array(d), true)
      })
    }
  }

  await new Promise((resolve, reject) => {
    if (isPkg) {
      socket.once("open", resolve)
      socket.once("error", reject)
    } else {
      socket.addEventListener("open", resolve)
      socket.addEventListener("error", reject)
    }
  })
  attach()

  const send = (obj) => socket.send(JSON.stringify({ ctl: true, ...obj }))
  const ctl = (obj) => send(obj)

  if (direction === "down") {
    t0 = Date.now()
    ctl({ id: sessionId, dir: "down", frames, size, encoding })
    await Promise.race([pending, new Promise((r) => setTimeout(() => r({ timeout: true }), timeoutMs))])
    const elapsedMs = Date.now() - t0
    socket.close()
    return finish({ ...verifier.result(), ...wall(elapsedMs, verifier.bytes) })
  }

  ctl({ id: sessionId, dir: "up", frames, size, encoding })
  await Promise.race([pending, new Promise((r) => setTimeout(() => r({ timeout: true }), 15000))])
  t0 = Date.now()
  for (let i = 0; i < frames; i++) {
    const frame = outboundFrame(i)
    const { data, binary } = encodeData(i, frame)
    bytesOut += frame.length
    if (isPkg) {
      socket.send(data, { binary })
    } else if (binary) {
      // A GLOBAL WebSocket needs `binaryType` set BEFORE sending to receive
      // ArrayBuffer, and its send() must be handed the bytes themselves. Sending
      // a JSON string here (as the first version did for every encoding) made
      // the server see a text control frame and discard the payload entirely.
      socket.send(data)
    } else {
      socket.send(data)
    }
    sent++
  }
  ctl({ id: sessionId, done: true })
  const verdict = await Promise.race([
    pending,
    new Promise((r) => setTimeout(() => r({ timeout: true }), timeoutMs)),
  ])
  const elapsedMs = Date.now() - t0
  socket.close()
  return finish({
    sent,
    bytesOut,
    serverVerdict: verdict.result ?? null,
    ...wall(elapsedMs, bytesOut),
  })
}

// ── UDP ──────────────────────────────────────────────────────────────────
async function runUdp() {
  const socket = createUdpSocket("udp4")
  const verifier = new Verifier(size, frames)
  let controlResolve = null
  let pending = new Promise((r) => (controlResolve = r))
  let bytesOut = 0
  let sent = 0

  socket.on("message", (datagram) => {
    const { type, payload } = unpackUdp(datagram)
    if (type !== MSG.CONTROL) {
      if (type === MSG.FRAME && direction === "down") verifier.add(payload)
      return
    }
    const msg = JSON.parse(td.decode(payload))
    controlResolve?.(msg)
    controlResolve = null
    pending = new Promise((r) => (controlResolve = r))
  })

  const ctl = (obj) => socket.send(packUdp(MSG.CONTROL, te.encode(JSON.stringify(obj))), port, host)

  if (direction === "down") {
    const t0 = Date.now()
    ctl({ id: sessionId, dir: "down", frames, size })
    // UDP cannot signal completion, so wait a fixed grace period after the last
    // frame and then report what actually arrived. The grace period is part of
    // the measurement, not a fudge: it is stated in the result.
    await new Promise((r) => setTimeout(r, Math.max(500, Number(args.graceMs ?? 1500))))
    const elapsedMs = Date.now() - t0
    socket.close()
    return finish({ ...verifier.result(), graceMs: Number(args.graceMs ?? 1500), ...wall(elapsedMs, verifier.bytes) })
  }

  ctl({ id: sessionId, dir: "up", frames, size })
  await Promise.race([pending, new Promise((r) => setTimeout(() => r({ timeout: true }), 15000))])
  const t0 = Date.now()
  let oversize = 0
  for (let i = 0; i < frames; i++) {
    const frame = outboundFrame(i)
    bytesOut += frame.length
    // A UDP datagram has a hard 64 KiB payload ceiling. A larger frame cannot
    // be sent at all, and `socket.send` reports that asynchronously at best —
    // so it is counted explicitly instead of vanishing into a "missing" figure
    // that would otherwise be blamed on the network.
    if (1 + frame.length > 65507) {
      oversize++
      sent++
      continue
    }
    socket.send(packUdp(MSG.FRAME, frame), port, host)
    sent++
  }
  await new Promise((r) => setTimeout(r, Math.max(500, Number(args.graceMs ?? 1500))))
  ctl({ id: sessionId, report: true })
  const verdict = await Promise.race([
    pending,
    new Promise((r) => setTimeout(() => r({ timeout: true }), timeoutMs)),
  ])
  const elapsedMs = Date.now() - t0
  socket.close()
  return finish({
    sent,
    bytesOut,
    oversizeDatagrams: oversize,
    serverVerdict: verdict.result ?? null,
    graceMs: Number(args.graceMs ?? 1500),
    ...wall(elapsedMs, bytesOut),
  })
}

const runners = { tcp: runTcp, ws: runWs, udp: runUdp }
const runner = runners[transport]
if (!runner) {
  out.error = `unknown transport ${transport}`
  finish()
}
await runner()
