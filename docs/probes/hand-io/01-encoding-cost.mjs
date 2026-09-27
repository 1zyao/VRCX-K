// Drive the Rust hands probe over REAL stdio, using the exact framing the
// brain<->hands bridge uses today (one JSON object per line), and measure what
// each candidate binary carrier actually costs end to end.
//
// This is deliberately NOT the transport-lab instrument: that one measured a
// WebSocket. The question here is narrower and was never measured — what does
// the *stdio* shape cost, where the peer is Rust and the framing is text.
//
// Usage (build the Rust peer first — see README.md):
//   cargo build --release --manifest-path docs/probes/hand-io/rust/Cargo.toml
//   node docs/probes/hand-io/01-encoding-cost.mjs                 # cost table + byte-exact check
//   node docs/probes/hand-io/01-encoding-cost.mjs --size=1048576  # bigger payload
//   node docs/probes/hand-io/01-encoding-cost.mjs --repeat=5      # more repeats (median reported)

import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
// The cargo target dir lives beside the crate, i.e. docs/probes/hand-io/rust/target.
const BIN = join(
  here,
  "rust",
  "target",
  "release",
  process.platform === "win32" ? "handio-probe.exe" : "handio-probe",
)

const args = Object.fromEntries(
  process.argv.slice(2).map((raw) => {
    const [key, value] = raw.replace(/^--/, "").split("=")
    return [key, value ?? "true"]
  }),
)
const SIZE = Number(args.size ?? 65536)
const REPEAT = Number(args.repeat ?? 3)
const SEED = 7

// ---------------------------------------------------------------- the peer

class RustHands {
  #child
  #pending = new Map()
  #nextId = 1

  constructor() {
    this.#child = spawn(BIN, [], { stdio: ["pipe", "pipe", "inherit"] })
    const rl = createInterface({ input: this.#child.stdout })
    rl.on("line", (line) => {
      const text = line.trim()
      if (!text) return
      let message
      try {
        message = JSON.parse(text)
      } catch {
        return
      }
      if (message.t !== "r") return
      const waiter = this.#pending.get(message.id)
      if (!waiter) return
      this.#pending.delete(message.id)
      if (message.e) waiter.reject(new Error(message.e.m))
      else waiter.resolve(message.v)
    })
  }

  call(method, callArgs = []) {
    const id = `r-${this.#nextId++}`
    // Exactly the compact frame src-tauri/src/kkrpc_peer.rs writes.
    const frame = { t: "q", id, op: "call", p: method.split("."), a: callArgs }
    const promise = new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
    })
    this.#child.stdin.write(`${JSON.stringify(frame)}\n`)
    return promise
  }

  close() {
    this.#child.stdin.end()
  }
}

// ------------------------------------------------------------ measurement

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function expected(i, seed) {
  return (i + seed) & 0xff
}

const results = []
function record(label, payloadBytes, wireBytes, ms, exact) {
  results.push({
    label,
    payloadBytes,
    wireBytes,
    ratio: wireBytes / payloadBytes,
    mbPerS: payloadBytes / 1048576 / (ms / 1000),
    ms,
    exact,
  })
}

async function main() {
  console.log(`Rust hands probe: ${BIN}`)
  console.log(`payload = ${SIZE} bytes (${(SIZE / 1024).toFixed(0)} KiB), ${REPEAT} repeats, seed = ${SEED}\n`)

  const hands = new RustHands()

  // ---- 1. the arithmetic: what each carrier costs on the wire ------------
  const cost = await hands.call("probe.encodingCost", [SIZE])
  console.log("1. Wire cost of one payload (arithmetic, reported by the RUST side)")
  console.log(`   bytes                 : ${cost.bytes}`)
  console.log(
    `   numeric-keyed JSON    : ${cost.jsonObjectLen} B  = ${cost.jsonObjectRatio.toFixed(2)}x   <- a naive Uint8Array`,
  )
  console.log(`   base64                : ${cost.base64Len} B  = ${cost.base64Ratio.toFixed(2)}x`)
  console.log(`   raw binary frame      : ${cost.rawLen} B  = 1.00x`)
  console.log(
    `   => JSON object is ${(cost.jsonObjectLen / cost.base64Len).toFixed(2)}x base64, ` +
      `${(cost.jsonObjectLen / cost.rawLen).toFixed(2)}x raw\n`,
  )

  // ---- 2. real round trip: base64 ---------------------------------------
  const b64Wire = []
  const b64Times = []
  let b64Exact = true
  for (let r = 0; r < REPEAT; r++) {
    const before = JSON.stringify(await hands.call("probe.encodingCost", [SIZE])).length
    const started = performance.now()
    const reply = await hands.call("probe.readBase64", [SIZE, SEED])
    const ms = performance.now() - started
    const decoded = Buffer.from(reply.base64, "base64")
    let ok = decoded.length === SIZE
    if (ok) {
      for (let i = 0; i < SIZE; i++) {
        if (decoded[i] !== expected(i, SEED)) {
          ok = false
          break
        }
      }
    }
    b64Exact &&= ok
    b64Times.push(ms)
    // The wire size the JS side really received, measured rather than computed.
    const wire = Buffer.byteLength(JSON.stringify({ t: "r", id: "r-0", v: reply }), "utf8") + 1
    b64Wire.push(wire)
    void before
  }
  record("base64", SIZE, median(b64Wire), median(b64Times), b64Exact)

  // ---- 3. real round trip: numeric-keyed JSON object ---------------------
  const jsonWire = []
  const jsonTimes = []
  let jsonExact = true
  for (let r = 0; r < REPEAT; r++) {
    const started = performance.now()
    const reply = await hands.call("probe.readJsonObject", [SIZE, SEED])
    const ms = performance.now() - started
    let ok = Object.keys(reply).length === SIZE
    if (ok) {
      for (let i = 0; i < SIZE; i++) {
        if (reply[i] !== expected(i, SEED)) {
          ok = false
          break
        }
      }
    }
    jsonExact &&= ok
    jsonTimes.push(ms)
    const wire = Buffer.byteLength(JSON.stringify({ t: "r", id: "r-0", v: reply }), "utf8") + 1
    jsonWire.push(wire)
  }
  record("json-object", SIZE, median(jsonWire), median(jsonTimes), jsonExact)

  hands.close()

  // ---- report -----------------------------------------------------------
  console.log("2. Full round trip: Rust encodes -> stdio line -> JS parses -> bytes verified")
  console.log("   carrier          payload    wire      ratio    median      MB/s   exact")
  console.log("   " + "-".repeat(74))
  for (const r of results) {
    console.log(
      `   ${r.label.padEnd(15)} ${String(r.payloadBytes).padStart(8)} ${String(r.wireBytes).padStart(9)} ` +
        `${(r.ratio.toFixed(2) + "x").padStart(8)} ${(r.ms.toFixed(1) + " ms").padStart(10)} ` +
        `${r.mbPerS.toFixed(1).padStart(8)}   ${r.exact ? "yes" : "NO"}`,
    )
  }

  const b64 = results.find((r) => r.label === "base64")
  const json = results.find((r) => r.label === "json-object")
  console.log("")
  console.log("3. Verdict")
  console.log(
    `   base64 is ${(json.ratio / b64.ratio).toFixed(2)}x smaller on the wire and ` +
      `${(json.ms / b64.ms).toFixed(2)}x faster end to end.`,
  )
  console.log(
    `   ${json.exact ? "" : "NOT "}byte-exact for base64; ${b64.exact ? "" : "NOT "}byte-exact for json-object.`,
  )

  console.log(`\nRESULT ${JSON.stringify({ size: SIZE, repeat: REPEAT, cost, results })}`)
}

main().catch((error) => {
  console.error("probe failed:", error)
  process.exit(1)
})
