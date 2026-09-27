/**
 * E2E LAB SERVER — one long-lived process, three transports, both directions.
 *
 * RUN THIS AS A BACKGROUND TASK. The client probes connect to it repeatedly, so
 * the server is started ONCE instead of being restarted per measurement. That
 * matters for more than speed:
 *
 *   · Every earlier round spawned a fresh server per cell and then depended on
 *     parsing that child's stdout to learn its port. When the parse failed the
 *     symptom ("server exited early", empty stderr) looked like a transport
 *     failure. Here the ports are FIXED by the command line and printed once.
 *   · The server verifies the UPLINK direction itself and reports the verdict,
 *     so "the sender says it sent" and "the receiver saw it" are separate facts.
 *
 * PROTOCOL (all three transports)
 *   A session starts with a CONTROL message describing the transfer:
 *     { id, dir: "down" | "up", frames, size, encoding }
 *   · dir=down  server sends `frames` frames, then CONTROL {done:true}
 *   · dir=up    server replies CONTROL {ready:true}, verifies `frames` arriving
 *               frames, then replies CONTROL {result:<verification>}
 *   encoding selects how BYTES are carried over WebSocket only:
 *     raw    binary WebSocket frames (the shape a correct transport uses)
 *     base64 text frames carrying {"seq":n,"b64":"..."}
 *     json   text frames carrying {"seq":n,"bytes":{"0":..}} — EXACTLY what
 *            kkrpc's built-in ws transport produces from a Uint8Array, included
 *            so the built-in behaviour is MEASURED rather than asserted
 *   TCP and UDP always carry raw bytes; their variable is the transport itself.
 *
 * Usage:
 *   node|bun server.mjs --base-port=46000
 */
import { createServer } from "node:net"
import { createSocket as createUdpSocket } from "node:dgram"
import { WebSocketServer } from "ws"
import {
  fromBase64,
  MSG,
  makeFrame,
  packTcp,
  packUdp,
  readSeq,
  TcpFramer,
  unpackUdp,
  Verifier,
} from "./proto.mjs"

/**
 * Flag parsing normalises `--kebab-case` to `camelCase`.
 *
 * The Usage block documents `--base-port=47000`, but a literal
 * `a.replace(/^--/, "").split("=")` yields the key `base-port` while the code
 * below reads `args.basePort` — so the flag was IGNORED and the server silently
 * bound its default port. The visible symptom was `ECONNREFUSED` on the port the
 * caller asked for, which reads like a crashed server rather than a misspelled
 * key. Normalising here means the documented spelling and the read spelling can
 * no longer disagree.
 */
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [rawKey, v] = a.replace(/^--/, "").split("=")
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    return [key, v === undefined ? "true" : v]
  }),
)

const BASE = Number(args.basePort ?? 46000)
const TCP_PORT = BASE
const WS_PORT = BASE + 1
const UDP_PORT = BASE + 2
// Bind address. Defaults to loopback (unchanged behaviour); pass
// `--bind=0.0.0.0` to let a DIFFERENT host reach this server — which is what a
// real-link run needs. Without this flag the server was unreachable from any
// other machine, so §8's "a real-interface run needs no new code" was wrong:
// `client.mjs` accepted `--host`, but the SERVER never listened off-loopback.
//
// Measured use: a genuinely cross-VM run (WSL linux node -> Windows) against
// `--bind=0.0.0.0`. See hand-io/FINDINGS.md §7.2 for the numbers.
const BIND = args.bind ?? "127.0.0.1"
const runtime = typeof Bun !== "undefined" ? `bun-${Bun.version}` : `node-${process.version}`
const log = (...a) => process.stderr.write(`[lab:${runtime}] ${a.join(" ")}\n`)

const te = new TextEncoder()
const td = new TextDecoder()

/** Build the frame set for a transfer ONCE, so send-side CPU is not measured. */
const frameCache = new Map()
function framesFor(count, size) {
  const key = `${count}x${size}`
  let cached = frameCache.get(key)
  if (!cached) {
    cached = []
    for (let i = 0; i < count; i++) cached.push(makeFrame(i, size))
    frameCache.set(key, cached)
    log(`built ${count} frames of ${size}B (${((count * size) / 1048576).toFixed(1)} MiB)`)
  }
  return cached
}

// ══ TCP ══════════════════════════════════════════════════════════════════
const tcpServer = createServer((socket) => {
  socket.setNoDelay(true)
  const framer = new TcpFramer()
  let session = null
  let verifier = null
  let sent = 0

  const control = (obj) => socket.write(packTcp(MSG.CONTROL, te.encode(JSON.stringify(obj))))

  socket.on("data", (chunk) => {
    let messages
    try {
      messages = framer.push(chunk)
    } catch (error) {
      log(`tcp framing error: ${error.message}`)
      socket.destroy()
      return
    }
    for (const message of messages) {
      if (message.type === MSG.CONTROL) {
        const msg = JSON.parse(td.decode(message.payload))
        if (msg.dir === "down") {
          session = msg
          const frames = framesFor(msg.frames, msg.size)
          for (const frame of frames) {
            socket.write(packTcp(MSG.FRAME, frame))
            sent++
          }
          control({ id: msg.id, done: true, sent })
        } else if (msg.dir === "up") {
          session = msg
          verifier = new Verifier(msg.size, msg.frames)
          control({ id: msg.id, ready: true })
        } else if (msg.done && verifier) {
          const result = verifier.result()
          control({ id: session.id, result })
          verifier = null
        }
        continue
      }
      if (message.type === MSG.FRAME && verifier) verifier.add(message.payload)
    }
  })
  socket.on("error", (err) => log(`tcp socket error: ${err.message}`))
})

// ══ WebSocket ════════════════════════════════════════════════════════════
const wss = new WebSocketServer({ host: BIND, port: WS_PORT, maxPayload: 1 << 30, perMessageDeflate: false })

/** Wrap payload bytes the way the session's encoding dictates. */
function wsSendData(socket, encoding, seq, frame) {
  if (encoding === "raw") {
    socket.send(frame, { binary: true })
    return
  }
  if (encoding === "base64") {
    socket.send(JSON.stringify({ seq, b64: Buffer.from(frame).toString("base64") }), { binary: false })
    return
  }
  // "json": kkrpc's built-in transport, byte for byte.
  socket.send(JSON.stringify({ seq, bytes: frame }), { binary: false })
}

/** Recover payload bytes from whatever encoding the peer used. */
function wsReadData(encoding, data, isBinary) {
  if (encoding === "raw") {
    if (!isBinary) return null
    return new Uint8Array(data)
  }
  if (isBinary) return null
  const parsed = JSON.parse(data.toString("utf8"))
  if (encoding === "base64") return fromBase64(parsed.b64)
  return new Uint8Array(Object.values(parsed.bytes))
}

wss.on("connection", (socket) => {
  let verifier = null
  let session = null
  let sent = 0

  // CONTROL IS TAGGED, NEVER SNIFFED.
  //
  // The first version decided "is this a control message?" by testing whether a
  // text frame started with `{`. Every base64/json DATA frame also starts with
  // `{`, so all of them were parsed as control, had no `done` field, and were
  // discarded — the probe then reported 16 missing frames for encodings that
  // were working perfectly. A magic field removes the ambiguity for good.
  const control = (obj) => socket.send(JSON.stringify({ ctl: true, ...obj }), { binary: false })

  socket.on("message", (data, isBinary) => {
    if (!session) {
      if (isBinary) return
      const msg = JSON.parse(data.toString("utf8"))
      if (msg.ctl !== true) return
      session = msg
      if (msg.dir === "down") {
        const frames = framesFor(msg.frames, msg.size)
        for (let i = 0; i < frames.length; i++) {
          wsSendData(socket, msg.encoding, i, frames[i])
          sent++
        }
        control({ id: msg.id, done: true, sent })
        return
      }
      verifier = new Verifier(msg.size, msg.frames)
      control({ id: msg.id, ready: true })
      return
    }

    // Session is live: control frames are still possible (the uplink's "done"),
    // so the tag is checked before anything is treated as payload.
    if (!isBinary) {
      const parsed = JSON.parse(data.toString("utf8"))
      if (parsed.ctl === true) {
        if (parsed.done && verifier) {
          const result = verifier.result()
          control({ id: session.id, result })
          verifier = null
          session = null
        }
        return
      }
    }
    if (verifier) {
      const frame = wsReadData(session.encoding, data, isBinary)
      if (frame) verifier.add(frame)
    }
  })
  socket.on("error", (err) => log(`ws error: ${err.message}`))
})

// ══ UDP ══════════════════════════════════════════════════════════════════
//
// UDP has NO end-of-stream signal: datagrams arrive or they do not, and the
// receiver cannot tell "finished" from "still in flight". An uplink therefore
// ends with an explicit `report` control message from the client, sent after a
// grace period — the only way this direction can produce a verdict at all.
//
// `upSessions` is keyed by remote address:port because one UDP socket serves
// every client, and without the key two concurrent uplinks would share a
// verifier and corrupt each other's result.
const upSessions = new Map()
const udp = createUdpSocket("udp4")

udp.on("message", (datagram, rinfo) => {
  const { type, payload } = unpackUdp(datagram)
  const key = `${rinfo.address}:${rinfo.port}`
  const send = (obj) => udp.send(packUdp(MSG.CONTROL, te.encode(JSON.stringify(obj))), rinfo.port, rinfo.address)

  if (type === MSG.FRAME) {
    upSessions.get(key)?.add(payload)
    return
  }
  if (type !== MSG.CONTROL) return

  const msg = JSON.parse(td.decode(payload))
  if (msg.dir === "down") {
    const frames = framesFor(msg.frames, msg.size)
    for (const frame of frames) udp.send(packUdp(MSG.FRAME, frame), rinfo.port, rinfo.address)
    send({ id: msg.id, done: true })
    return
  }
  if (msg.dir === "up") {
    upSessions.set(key, new Verifier(msg.size, msg.frames))
    send({ id: msg.id, ready: true })
    return
  }
  if (msg.report) {
    const verifier = upSessions.get(key)
    send({ id: msg.id, result: verifier ? verifier.result() : { error: "no session" } })
    upSessions.delete(key)
  }
})
udp.on("error", (err) => log(`udp error: ${err.message}`))

// ══ start ════════════════════════════════════════════════════════════════
let bound = 0
const announce = () => {
  bound++
  if (bound < 3) return
  process.stdout.write(
    JSON.stringify({ ready: true, runtime, tcp: TCP_PORT, ws: WS_PORT, udp: UDP_PORT }) + "\n",
  )
  log(`ready: tcp=${TCP_PORT} ws=${WS_PORT} udp=${UDP_PORT}`)
}

tcpServer.listen(TCP_PORT, BIND, announce)
wss.on("listening", announce)
udp.bind(UDP_PORT, BIND, announce)

tcpServer.on("error", (err) => log(`tcp listen error: ${err.message}`))
process.on("SIGTERM", () => {
  log("terminating")
  process.exit(0)
})
