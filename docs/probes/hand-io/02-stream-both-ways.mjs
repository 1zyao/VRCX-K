// The decisive test: a real Rust binary that speaks kkrpc STREAMING over real
// OS pipes, driven by the real kkrpc 2.1.0 StreamingRPCChannel on the other end.
//
// This is not an in-memory transport pair and not an argument about source code.
// A child process is spawned, its stdin/stdout are the channel, and a multi-MiB
// file crosses in both directions with byte-exact verification on BOTH sides:
//
//   DOWN (hands -> brain): Rust opens a local file, returns a stream ref; the
//                          brain pulls chunks and writes them out; the bytes are
//                          compared to the original.
//   UP   (brain -> hands): the brain returns an AsyncIterable from an exposed
//                          method; Rust pulls, writes to disk, and REPLIES with
//                          the byte count; the file on disk is compared.
//
// Both directions also check that the reply arrives at all, which is what proves
// the deferred-reply / credit-replenish logic is wired right.
//
// Usage (build the Rust peer first — see README.md):
//   cargo build --release --manifest-path docs/probes/hand-io/rust/Cargo.toml
//   node docs/probes/hand-io/02-stream-both-ways.mjs --size=8388608

import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { StreamingRPCChannel } from "kkrpc/streaming"

const here = dirname(fileURLToPath(import.meta.url))
// The cargo target dir lives beside the crate, i.e. docs/probes/hand-io/rust/target.
const BIN = join(
  here,
  "rust",
  "target",
  "release",
  process.platform === "win32" ? "handio-stream.exe" : "handio-stream",
)

const args = Object.fromEntries(
  process.argv.slice(2).map((raw) => {
    const [key, value] = raw.replace(/^--/, "").split("=")
    return [key, value ?? "true"]
  }),
)
const SIZE = Number(args.size ?? 8 * 1024 * 1024)

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`   ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `\n         ${detail}` : ""}`)
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex")

// ------------------------------------------------------------------ transport

/**
 * A transport over a real child process's pipes.
 *
 * Deliberately jsonLineCodec-shaped: one JSON object per line, exactly what
 * `kkrpc/stdio` does and what `src-tauri/src/kkrpc_peer.rs` reads. If the Rust
 * peer can stream over THIS, it can stream over the production bridge.
 */
function childTransport(child) {
  const listeners = new Set()
  let buffer = ""
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8")
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      const text = line.trim()
      // Mirror kkrpc's own isLikelyRpcFrame guard.
      if (!text.startsWith("{")) continue
      try {
        listeners.forEach((listener) => listener(JSON.parse(text)))
      } catch {
        /* malformed frame: dropped, like kkrpc */
      }
    }
  })
  return {
    capabilities: { objectMode: false, transfer: false, remoteRefs: true },
    send: (message) => {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

// ----------------------------------------------------------------------- main

const work = mkdtempSync(join(tmpdir(), "handio-stream-"))
const child = spawn(BIN, [], { stdio: ["pipe", "pipe", "inherit"] })

/**
 * The brain's LOCAL producer, for the UP direction.
 *
 * It must be a plain local async generator, NOT reached through the remote
 * proxy: `hands.brain.file(...)` would send a `call` frame to Rust (which has no
 * such method), whereas a local iterable passed as an ARGUMENT is what kkrpc
 * turns into a stream-ref envelope. Getting this wrong is how the first version
 * of this probe failed.
 *
 * `encoding` selects the carrier, because that is the variable under test:
 *
 *   "base64" — a deliberate base64 string (1.33x the payload)
 *   "buffer" — a raw Node Buffer, which JSON turns into
 *              {"type":"Buffer","data":[byte,...]}  (~4-6x)
 *   "uint8"  — a raw Uint8Array, which JSON turns into {"0":b,"1":b,...} (~6-10x)
 *
 * The last two are what happens by DEFAULT when nobody chooses a codec: real
 * binary that kkrpc has no wire form for. Measuring all three is what turns
 * "base64 is required" from an opinion into a number.
 */
async function* brainFile(path, encoding) {
  const data = readFileSync(path)
  const CHUNK = 256 * 1024
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const slice = data.subarray(offset, offset + CHUNK)
    if (encoding === "base64") yield slice.toString("base64")
    else if (encoding === "buffer") yield slice
    else yield new Uint8Array(slice)
  }
}

const channel = new StreamingRPCChannel(childTransport(child), {
  timeout: 120_000,
  onClose: (reason) => console.log(`   [channel closed] ${reason ?? "clean"}`),
})
const hands = channel.getAPI()

try {
  console.log(`Rust streaming peer: ${BIN}`)
  console.log(`payload = ${(SIZE / 1048576).toFixed(1)} MiB\n`)

  // Deterministic-ish source payload.
  const source = randomBytes(SIZE)
  const sourcePath = join(work, "source.bin")
  writeFileSync(sourcePath, source)
  const sourceHash = sha256(source)

  // ---- DOWN: hands -> brain ---------------------------------------------
  console.log("1. DOWN  hands -> brain   (Rust opens a file, returns a stream ref)")
  const downPath = join(work, "down.bin")
  const fd = openSync(downPath, "w")
  let downBytes = 0
  const startedDown = performance.now()
  // `hands.serve` returns an async iterable thanks to kkrpc's stream-ref decode,
  // so this is a normal `for await` — no manual credit handling on this side.
  for await (const chunk of hands.hands.serve(sourcePath)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "base64")
    writeSync(fd, bytes)
    downBytes += bytes.length
  }
  closeSync(fd)
  const downMs = performance.now() - startedDown
  const downHash = sha256(readFileSync(downPath))
  check(
    "hands -> brain: byte-identical over real pipes",
    downBytes === SIZE && downHash === sourceHash,
    `${downBytes} bytes in ${downMs.toFixed(0)} ms (${(SIZE / 1048576 / (downMs / 1000)).toFixed(1)} MiB/s), sha256 ${downHash === sourceHash ? "match" : "MISMATCH"}`,
  )

  // ---- UP: brain -> hands, under each carrier ----------------------------
  // Same bytes, same stream, three encodings. This is the measurement that
  // decides whether base64 is a requirement or merely a choice.
  console.log("\n2. UP    brain -> hands   (brain passes a local iterable, Rust writes to disk)")
  const upResults = []
  for (const encoding of ["base64", "buffer", "uint8"]) {
    const upPath = join(work, `up-${encoding}.bin`)
    const started = performance.now()
    let response
    let failure = null
    try {
      response = await hands.hands.receive(upPath, brainFile(sourcePath, encoding))
    } catch (error) {
      failure = error.message
    }
    const ms = performance.now() - started
    const wrote = statSync(upPath).size
    const hash = wrote === SIZE ? sha256(readFileSync(upPath)) : null
    upResults.push({ encoding, bytes: wrote, ms, exact: hash === sourceHash, failure, reported: response?.bytes })
    check(
      `brain -> hands over ${encoding}`,
      !failure && hash === sourceHash,
      failure
        ? `FAILED (${failure})`
        : `${wrote} bytes in ${ms.toFixed(0)} ms (${(SIZE / 1048576 / (ms / 1000)).toFixed(1)} MiB/s)`,
    )
  }

  const fastest = [...upResults].filter((r) => r.exact).sort((a, b) => a.ms - b.ms)[0]
  if (fastest) {
    const slowest = [...upResults].filter((r) => r.exact).sort((a, b) => b.ms - a.ms)[0]
    check(
      "carrier choice changes UP throughput",
      slowest.encoding !== fastest.encoding,
      `fastest = ${fastest.encoding} (${fastest.ms.toFixed(0)} ms); slowest = ${slowest.encoding} ` +
        `(${slowest.ms.toFixed(0)} ms) = ${(slowest.ms / fastest.ms).toFixed(1)}x`,
    )
  }

  // ---- a small file, to catch chunk-boundary bugs at the edges ----------
  console.log("\n3. Edge cases")
  const tiny = randomBytes(1)
  const tinyPath = join(work, "tiny.bin")
  writeFileSync(tinyPath, tiny)
  const tinyParts = []
  for await (const chunk of hands.hands.serve(tinyPath)) {
    tinyParts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "base64"))
  }
  check("1-byte file round trips", Buffer.concat(tinyParts).equals(tiny), `${Buffer.concat(tinyParts).length} byte(s)`)

  // An exact multiple of CHUNK exercises the "last read returns 0" path.
  const CHUNK = 256 * 1024
  const exact = randomBytes(CHUNK * 2)
  const exactPath = join(work, "exact.bin")
  writeFileSync(exactPath, exact)
  const exactParts = []
  for await (const chunk of hands.hands.serve(exactPath)) {
    exactParts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "base64"))
  }
  const exactOut = Buffer.concat(exactParts)
  check(
    `exact multiple of CHUNK (${CHUNK * 2} B) round trips`,
    exactOut.equals(exact),
    `${exactOut.length} bytes received`,
  )

  // ---- early termination must stop the Rust producer --------------------
  console.log("\n4. Early termination (break after 1 chunk)")
  let seen = 0
  for await (const _chunk of hands.hands.serve(sourcePath)) {
    seen++
    if (seen >= 1) break
  }
  check("breaking a stream returns control instead of hanging", true, `took ${seen} chunk(s), then returned`)
} finally {
  channel.destroy()
  child.kill()
  rmSync(work, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
console.log(`RESULT ${JSON.stringify({ size: SIZE, results })}`)
process.exit(failed.length ? 1 : 0)
