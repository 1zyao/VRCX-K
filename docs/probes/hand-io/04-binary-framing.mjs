// Is base64 REQUIRED on the brain<->hands pipe, or merely the cheap default?
//
// An earlier version of `FINDINGS.md` §5 claimed a binary framing "collides with
// the line splitter". That is only true while **`stdioPlatform` is kept**.
// kkrpc exposes `createTransport({ platform, codec })` as a public entry point
// (`kkrpc/transport`) and BOTH halves are replaceable, so this probe replaces
// both and measures what raw bytes actually cost over a real pipe.
//
// WHY THE PEER IS JS, NOT THE RUST BINARY:
//   The Rust peer in ../rust/ reads with `BufReader::lines()` — it is
//   line-oriented by construction, so it cannot speak this framing without a
//   matching reader. Driving it here would measure the mismatch, not the
//   framing. So this probe uses a small JS child process that speaks the SAME
//   framing, which isolates the question actually being asked: can the pipe
//   carry a length-prefixed binary frame, and what does that buy?
//
//   ⇒ Adopting this in production therefore requires changing BOTH ends
//   (JS platform+codec AND the Rust reader). That is part of its cost.
//
// Usage:
//   node docs/probes/hand-io/04-binary-framing.mjs --size=8388608

import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { StreamingRPCChannel } from "kkrpc/streaming"
import { createTransport } from "kkrpc/transport"

const here = dirname(fileURLToPath(import.meta.url))

const args = Object.fromEntries(
  process.argv.slice(2).map((raw) => {
    const [key, value] = raw.replace(/^--/, "").split("=")
    return [key, value ?? "true"]
  }),
)
const SIZE = Number(args.size ?? 8 * 1024 * 1024)

// --------------------------------------------------------------- the framing
//
// WIRE FORMAT (one message):
//
//   [4-byte BE header length][header JSON utf8][payload bytes ...]
//
// The header may reference payloads by index: `{"$b":0,"n":<len>}` means "the
// next `n` bytes after the header are payload 0". Payloads are concatenated in
// `$b` order.
//
// This is the smallest thing that can carry a Uint8Array without expanding it.
// It is deliberately NOT a design proposal — it exists so the cost of a bespoke
// framing is a measurement rather than an opinion.

function packBinary(value, payloads) {
  if (value instanceof Uint8Array) {
    const index = payloads.length
    payloads.push(value)
    return { $b: index, n: value.length }
  }
  if (Array.isArray(value)) return value.map((entry) => packBinary(entry, payloads))
  if (value !== null && typeof value === "object") {
    const out = {}
    for (const [key, entry] of Object.entries(value)) out[key] = packBinary(entry, payloads)
    return out
  }
  return value
}

function unpackBinary(value, payloads) {
  if (value !== null && typeof value === "object") {
    if (typeof value.$b === "number" && typeof value.n === "number") return payloads[value.$b]
    if (Array.isArray(value)) return value.map((entry) => unpackBinary(entry, payloads))
    const out = {}
    for (const [key, entry] of Object.entries(value)) out[key] = unpackBinary(entry, payloads)
    return out
  }
  return value
}

/** A binary codec: messages <-> a header object plus raw payload buffers. */
function binaryCodec() {
  return {
    capabilities: { transfer: true },
    encode(message) {
      const payloads = []
      const header = packBinary(message, payloads)
      return { header, payloads }
    },
    decode(wire) {
      return unpackBinary(wire.header, wire.payloads)
    },
  }
}

/** Collect every `{$b:i,n:len}` reference in a header, in index order. */
function refsIn(header) {
  const refs = []
  const walk = (value) => {
    if (value !== null && typeof value === "object") {
      if (typeof value.$b === "number" && typeof value.n === "number") refs.push(value)
      else for (const entry of Object.values(value)) walk(entry)
    }
  }
  walk(header)
  return refs.sort((a, b) => a.$b - b.$b)
}

/**
 * A platform over a stream pair, with length-prefixed framing.
 *
 * Replaces `stdioPlatform`, which splits on "\n" and DISCARDS any line not
 * starting with "{". Nothing is discarded here.
 */
function lengthPrefixedPlatform(writable, readable, onDesync) {
  const listeners = new Set()
  let buffer = Buffer.alloc(0)

  readable.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      if (buffer.length < 4) return
      const headerLength = buffer.readUInt32BE(0)
      if (buffer.length < 4 + headerLength) return
      let header
      try {
        header = JSON.parse(buffer.subarray(4, 4 + headerLength).toString("utf8"))
      } catch {
        // A malformed header means the stream is desynchronised. A line-based
        // stream self-synchronises (skip the bad line); this one cannot, which
        // is a real cost of the format and is reported rather than hidden.
        onDesync()
        return
      }
      let offset = 4 + headerLength
      const payloads = []
      for (const ref of refsIn(header)) {
        if (buffer.length < offset + ref.n) return
        payloads[ref.$b] = buffer.subarray(offset, offset + ref.n)
        offset += ref.n
      }
      buffer = buffer.subarray(offset)
      const wire = { header, payloads }
      for (const listener of listeners) listener(wire)
    }
  })

  return {
    capabilities: { objectMode: false, transfer: true },
    send(wire) {
      const encoded = Buffer.from(JSON.stringify(wire.header), "utf8")
      const head = Buffer.alloc(4)
      head.writeUInt32BE(encoded.length, 0)
      const parts = [head, encoded]
      for (const payload of wire.payloads) parts.push(Buffer.from(payload))
      writable.write(Buffer.concat(parts))
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

// ----------------------------------------------------- the child (echo peer)

/**
 * A minimal child process that speaks the same framing and answers two RPC
 * methods. Written as a string so it shares `stdin`/`stdout` with the parent
 * exactly the way the Rust peer does.
 */
const CHILD_SOURCE = `
const jsonEncoder = new TextEncoder()
function unpackBinary(value, payloads) {
  if (value !== null && typeof value === "object") {
    if (typeof value.$b === "number" && typeof value.n === "number") return payloads[value.$b]
    if (Array.isArray(value)) return value.map((e) => unpackBinary(e, payloads))
    const out = {}
    for (const [k, e] of Object.entries(value)) out[k] = unpackBinary(e, payloads)
    return out
  }
  return value
}
function packBinary(value, payloads) {
  if (value instanceof Uint8Array) {
    const index = payloads.length
    payloads.push(value)
    return { $b: index, n: value.length }
  }
  if (Array.isArray(value)) return value.map((e) => packBinary(e, payloads))
  if (value !== null && typeof value === "object") {
    const out = {}
    for (const [k, e] of Object.entries(value)) out[k] = packBinary(e, payloads)
    return out
  }
  return value
}
function refsIn(header) {
  const refs = []
  const walk = (v) => {
    if (v !== null && typeof v === "object") {
      if (typeof v.$b === "number" && typeof v.n === "number") refs.push(v)
      else for (const e of Object.values(v)) walk(e)
    }
  }
  walk(header)
  return refs.sort((a, b) => a.$b - b.$b)
}
function send(message) {
  // Pack INSIDE send(), never at the call sites: a call site that passes a raw
  // Uint8Array straight into the header gets it JSON-stringified into
  // {"0":..,"1":..} — which is the exact expansion this framing exists to avoid,
  // and it silently produces a ~4x-larger *header* while also appending the
  // payload again. One packing point removes the whole class of mistake.
  const payloads = []
  const header = packBinary(message, payloads)
  const encoded = Buffer.from(JSON.stringify(header), "utf8")
  const head = Buffer.alloc(4)
  head.writeUInt32BE(encoded.length, 0)
  const parts = [head, encoded]
  for (const p of payloads) parts.push(Buffer.from(p))
  process.stdout.write(Buffer.concat(parts))
}

// streams this peer produces, keyed by sid
const producers = new Map()
let nextSid = 1

function pump(sid, credit) {
  const producer = producers.get(sid)
  if (!producer) return
  for (let i = 0; i < credit; i++) {
    const chunk = producer.chunks[producer.index]
    if (chunk === undefined) {
      send({ t: "sr", id: 'x-' + sid, sid, d: true })
      producers.delete(sid)
      return
    }
    producer.index++
    send({ t: "sr", id: 'x-' + sid, sid, d: false, v: chunk })
  }
}

// consumer: request id -> bytes received
const consumers = new Map()

let buffer = Buffer.alloc(0)
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    if (buffer.length < 4) return
    const headerLength = buffer.readUInt32BE(0)
    if (buffer.length < 4 + headerLength) return
    let header
    try {
      header = JSON.parse(buffer.subarray(4, 4 + headerLength).toString("utf8"))
    } catch { return }
    let offset = 4 + headerLength
    const payloads = []
    for (const ref of refsIn(header)) {
      if (buffer.length < offset + ref.n) return
      payloads[ref.$b] = buffer.subarray(offset, offset + ref.n)
      offset += ref.n
    }
    buffer = buffer.subarray(offset)
    const message = unpackBinary(header, payloads)

    if (message.t === "q") {
      const method = (message.p || []).join(".")
      const callArgs = (message.a || []).map((a) =>
        a && a.__kkrpc_next_arg__ === "value" ? a.v : a)
      if (method === "peer.serve") {
        // Returns a stream of raw Uint8Array chunks -- NO base64.
        const total = callArgs[0]
        const per = callArgs[1]
        const chunks = []
        for (let o = 0; o < total; o += per) chunks.push(new Uint8Array(per))
        const sid = "s-" + nextSid++
        producers.set(sid, { chunks, index: 0 })
        send({ t: "r", id: message.id, v: { __kkrpc_next_stream__: "async-iterable", id: sid } })
      } else if (method === "peer.receive") {
        // Consumes a stream REF passed as an argument, replies when done.
        const ref = callArgs[1]
        const sid = ref && ref.__kkrpc_next_stream__ === "async-iterable" ? ref.id : null
        if (!sid) {
          send({ t: "r", id: message.id, e: { n: "TypeError", m: "no stream ref" } })
        } else {
          consumers.set(sid, { requestId: message.id, bytes: 0, sincePull: 0 })
          send({ t: "sq", id: "p-" + sid, sid, op: "pull", n: 32 })
        }
      } else {
        send({ t: "r", id: message.id, e: { m: "unknown: " + method } })
      }
      continue
    }

    if (message.t === "sq") {
      if (message.op === "pull") pump(message.sid, Math.max(1, message.n || 1))
      else if (message.op === "return") {
        producers.delete(message.sid)
        send({ t: "sr", id: message.id, sid: message.sid, d: true })
      }
      continue
    }

    if (message.t === "sr") {
      const consumer = consumers.get(message.sid)
      if (!consumer) continue
      if (message.d === true) {
        consumers.delete(message.sid)
        send({ t: "r", id: consumer.requestId, v: { bytes: consumer.bytes } })
        continue
      }
      const value = message.v
      // The decisive case: a RAW Uint8Array arriving over the pipe.
      if (value instanceof Uint8Array) consumer.bytes += value.length
      else if (typeof value === "string") consumer.bytes += Buffer.from(value, "base64").length
      consumer.sincePull++
      if (consumer.sincePull >= 16) {
        consumer.sincePull = 0
        send({ t: "sq", id: "p-" + message.sid + "-" + consumer.bytes, sid: message.sid, op: "pull", n: 16 })
      }
    }
  }
})
`

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`   ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `\n         ${detail}` : ""}`)
}

const work = mkdtempSync(join(tmpdir(), "handio-binframe-"))
const childPath = join(work, "peer.cjs")
writeFileSync(childPath, CHILD_SOURCE)

const child = spawn(process.execPath, [childPath], { stdio: ["pipe", "pipe", "pipe"] })
child.stderr.on("data", (chunk) => process.stderr.write(`[peer] ${chunk}`))

let desynced = false
const platform = lengthPrefixedPlatform(child.stdin, child.stdout, () => {
  desynced = true
})
const transport = createTransport({ platform, codec: binaryCodec() })
const channel = new StreamingRPCChannel(transport, { timeout: 60_000 })
const peer = channel.getAPI()

try {
  console.log(`payload = ${(SIZE / 1048576).toFixed(1)} MiB, length-prefixed binary framing (no base64)\n`)

  // ---- 1. a normal call over the custom framing ---------------------------
  console.log("1. Does a normal RPC call survive the custom framing?")
  const probePath = join(work, "probe.bin")
  const empty = await peer.peer.receive(probePath, (async function* () {})())
  check(
    "a streaming call completes over the binary platform",
    empty?.bytes === 0,
    `reply = ${JSON.stringify(empty)}`,
  )

  // ---- 2. RAW bytes as stream values (the decisive measurement) -----------
  console.log("\n2. Raw Uint8Array as a stream value — the thing base64 was said to require")
  const started = performance.now()
  const reply = await peer.peer.receive(
    join(work, "raw.bin"),
    (async function* () {
      const CHUNK = 256 * 1024
      for (let offset = 0; offset < SIZE; offset += CHUNK) {
        // A RAW Uint8Array. No base64 anywhere on this path.
        yield new Uint8Array(Math.min(CHUNK, SIZE - offset))
      }
    })(),
  )
  const ms = performance.now() - started
  check(
    "raw bytes cross the pipe without expansion",
    reply?.bytes === SIZE,
    `${reply?.bytes} bytes in ${ms.toFixed(0)} ms (${(SIZE / 1048576 / (ms / 1000)).toFixed(1)} MiB/s). ` +
      `The honest comparison is a SIDE-BY-SIDE run of 02-stream-both-ways.mjs at the SAME ` +
      `size, not a hard-coded baseline: throughput rises with size on both carriers ` +
      `(~169 vs ~88 MiB/s at 4 MiB; ~260 vs ~125 MiB/s at 16 MiB).`,
  )

  // ---- 3. the same payload DOWN, so both directions are covered ----------
  console.log("\n3. The same framing in the other direction")
  const downStarted = performance.now()
  let downBytes = 0
  for await (const chunk of peer.peer.serve(SIZE, 256 * 1024)) {
    downBytes += chunk.length
  }
  const downMs = performance.now() - downStarted
  check(
    "peer -> brain raw stream arrives whole",
    downBytes === SIZE,
    `${downBytes} bytes in ${downMs.toFixed(0)} ms (${(SIZE / 1048576 / (downMs / 1000)).toFixed(1)} MiB/s)`,
  )

  check("the stream never desynchronised", !desynced, desynced ? "a malformed header was seen" : "no desync")
} finally {
  channel.destroy()
  child.kill()
  rmSync(work, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
console.log(`RESULT ${JSON.stringify({ size: SIZE, results })}`)
process.exit(failed.length ? 1 : 0)
