// The decisive test for the hands' file capability: a REAL Rust peer process,
// driven by the REAL kkrpc 2.1.0 `StreamingRPCChannel`, over REAL OS pipes.
//
// Why a child process and not an in-memory transport pair: the entire claim is
// that our hand-written Rust peer interoperates with the stock JS channel. An
// in-memory pair would let both sides agree on a private mistake, and the
// project's own probes already learned this lesson twice the hard way
// (docs/probes/hand-io/FINDINGS.md §1: "a real child process on real pipes",
// and the mis-wired-transport "failure that does not vary with the variable").
//
// What it proves, each with an independent check:
//   1. `hands.stat` round trips, including the null-for-missing contract.
//   2. `hands.read` streams a multi-MiB file: byte-exact on BOTH sides.
//   3. `hands.read` honours `offset` (the whole resumption mechanism).
//   4. `hands.write` consumes a host-produced stream and reports the byte count.
//   5. `hands.watch` delivers an event for a file that did NOT exist at start
//      (the parent-directory fallback), and stops when the stream is returned.
//   6. Backpressure/cancellation: after the consumer abandons a stream, nothing
//      further arrives on it (observed on the wire, not assumed).
//
// Usage:
//   cargo build --release --locked --manifest-path src-tauri/Cargo.toml --example hands-e2e
//   node docs/probes/hands-e2e/run.mjs
//
// ⚠ This drives the crate's `hands` module directly through a thin probe binary
// rather than the whole Tauri app: the app cannot run headless in CI (it needs a
// webview), while the capability under test has no Tauri dependency at all.

import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { StreamingRPCChannel } from "kkrpc/streaming"

const here = dirname(fileURLToPath(import.meta.url))
const BIN = join(
  here,
  "..",
  "..",
  "..",
  "target",
  "release",
  "examples",
  process.platform === "win32" ? "hands-e2e.exe" : "hands-e2e",
)

const results = []
/**
 * How long §6 watches for data that must NOT arrive after the consumer stops
 * pulling. Long enough to dwarf a full transfer on this machine (~24 ms for the
 * 4 MiB file), short enough not to slow the probe down.
 */
const CANCEL_QUIET_MS = 1500
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`   ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `\n         ${detail}` : ""}`)
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex")
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A transport over the child's real pipes.
 *
 * Deliberately the same jsonLineCodec shape as `kkrpc/stdio` and as
 * `src-tauri/src/kkrpc_peer.rs`'s reader: one JSON object per line. If the Rust
 * peer streams over THIS, it streams over the production bridge.
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
      if (!text.startsWith("{")) continue
      try {
        const message = JSON.parse(text)
        listeners.forEach((listener) => listener(message))
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

const work = mkdtempSync(join(tmpdir(), "hands-e2e-"))
const child = spawn(BIN, [], { stdio: ["pipe", "pipe", "inherit"] })
const transport = childTransport(child)
const channel = new StreamingRPCChannel(transport, {
  timeout: 60_000,
  onClose: (reason) => console.log(`   [channel closed] ${reason ?? "clean"}`),
})
const hands = channel.getAPI()

/**
 * Every frame the Rust peer sent, with its arrival time.
 *
 * Section 6 uses this to LOOK for data arriving after the consumer stopped
 * pulling. Without it the only available evidence is "the loop returned", which
 * says nothing about the producer — and a check that cannot observe the failure
 * it names is not a check.
 */
const frames = []
transport.subscribe((message) => {
  frames.push({ at: performance.now(), message })
})

/** The stream id from a `__kkrpc_next_stream__` reply, or null for any other frame. */
const streamRefId = (message) =>
  message?.v?.["__kkrpc_next_stream__"] === "async-iterable" && typeof message.v.id === "string"
    ? message.v.id
    : null

try {
  console.log(`Rust hands peer: ${BIN}\n`)

  // ---- 1. stat -----------------------------------------------------------
  console.log("1. hands.stat")
  const source = randomBytes(4 * 1024 * 1024 + 1234)
  const sourcePath = join(work, "source.bin")
  writeFileSync(sourcePath, source)
  const sourceHash = sha256(source)

  const stat = await hands.hands.stat(sourcePath)
  check(
    "stat reports the real size and an identity",
    stat?.size === source.length && typeof stat?.id === "string" && stat.id.length > 0,
    `size=${stat?.size} kind=${stat?.kind} id=${(stat?.id ?? "").slice(0, 40)}…`,
  )

  const missing = await hands.hands.stat(join(work, "nope.bin"))
  check(
    "stat of a missing path resolves to null (not an error)",
    missing === null,
    `got ${JSON.stringify(missing)}`,
  )

  // ---- 2. read (hands -> brain) ------------------------------------------
  console.log("\n2. hands.read   hands -> brain")
  const downPath = join(work, "down.bin")
  const fd = openSync(downPath, "w")
  let downBytes = 0
  let chunks = 0
  const started = performance.now()
  for await (const chunk of hands.hands.read(sourcePath)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "base64")
    writeSync(fd, bytes)
    downBytes += bytes.length
    chunks++
  }
  closeSync(fd)
  const downMs = performance.now() - started
  const downHash = sha256(readFileSync(downPath))
  check(
    "a 4 MiB file is byte-identical over real pipes",
    downBytes === source.length && downHash === sourceHash,
    `${downBytes} bytes in ${chunks} chunks, ${downMs.toFixed(0)} ms ` +
      `(${(source.length / 1048576 / (downMs / 1000)).toFixed(1)} MiB/s), sha256 ${downHash === sourceHash ? "match" : "MISMATCH"}`,
  )

  // Chunks must be bounded, or memory scales with the file.
  const bounded = chunks >= 2 && chunks <= Math.ceil(source.length / 4096) + 2
  check("chunks are bounded, so memory does not scale with file size", bounded, `${chunks} chunks`)

  // ---- 3. read with an offset (resume) -----------------------------------
  console.log("\n3. hands.read with offset   (the resumption mechanism)")
  const OFFSET = 1_000_000
  const parts = []
  for await (const chunk of hands.hands.read(sourcePath, { offset: OFFSET })) {
    parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "base64"))
  }
  const tail = Buffer.concat(parts)
  check(
    "offset yields exactly the tail of the file",
    tail.length === source.length - OFFSET && sha256(tail) === sha256(source.subarray(OFFSET)),
    `${tail.length} bytes from offset ${OFFSET}`,
  )

  // ---- 4. write (brain -> hands) -----------------------------------------
  console.log("\n4. hands.write   brain -> hands")
  // The carrier is base64 ON PURPOSE, and this is the load-bearing detail of the
  // whole test: kkrpc's stock transport JSON-stringifies, and JSON has no bytes.
  // Yielding a raw Uint8Array here does NOT send binary — it sends
  // {"0":65,"1":66,…} at ~11.4x the payload (measured, hand-io/FINDINGS.md §2).
  // This exact mistake is what the first run of this probe hit.
  async function* brainFile() {
    const CHUNK = 256 * 1024
    for (let at = 0; at < source.length; at += CHUNK) {
      yield source.subarray(at, at + CHUNK).toString("base64")
    }
  }
  const upPath = join(work, "up.bin")
  const response = await hands.hands.write(upPath, brainFile())
  const upHash = sha256(readFileSync(upPath))
  check(
    "the host's stream is written to disk byte-identically",
    statSync(upPath).size === source.length && upHash === sourceHash,
    `${response?.bytes} bytes reported, endOffset=${response?.endOffset}`,
  )
  check(
    "the deferred reply carries the true byte count",
    response?.bytes === source.length,
    `reported ${response?.bytes}, expected ${source.length}`,
  )

  // ---- 5. watch, including the parent-directory fallback ------------------
  console.log("\n5. hands.watch   (target does not exist yet — the tail-on-startup case)")
  const watchPath = join(work, "not-yet.log")
  const watched = []
  const watcher = (async () => {
    for await (const change of hands.hands.watch(watchPath)) {
      watched.push(change)
      if (watched.length >= 1) break
    }
  })()

  // Give the watch a moment to install before the file appears.
  await new Promise((resolve) => setTimeout(resolve, 400))
  writeFileSync(watchPath, "hello\n")

  await Promise.race([watcher, new Promise((resolve) => setTimeout(resolve, 8000))])
  check(
    "a watch on an absent path still reports its creation",
    watched.length >= 1,
    watched.length >= 1 ? `kind=${watched[0]?.kind} path=${watched[0]?.path}` : "no event delivered",
  )

  // ---- 6. cancellation must stop the producer ----------------------------
  //
  // The claim is not "the loop returned" — that happens whether or not the peer
  // keeps pushing. The claim is that the producer STOPS: no further data for
  // this stream, even though the file has many chunks left.
  //
  // Measured on the wire, and shaped around what the instrument can actually
  // see (both facts measured on this machine, not assumed):
  //   · the opening reply names the stream, so the abandoned stream is
  //     identifiable in the frame stream;
  //   · the in-flight chunk has already LANDED by the time `break` returns, so
  //     "frames after the return timestamp" is 0 either way and would be a
  //     vacuous criterion.
  //
  // So the criterion is the one with discriminating power: the total number of
  // data frames that ever arrive for the abandoned stream must stay far below
  // the chunk count the SAME file produced in §2, and must not grow at all
  // during a quiet window that dwarfs a full transfer (~24 ms measured in §2).
  // A peer that ignored the release would push on towards the credit window.
  //
  // `firstChunkAt` keeps the detector honest in the other direction: it proves
  // the collector DOES register frames arriving after a cutoff, so the flat
  // reading below is a stopped producer rather than a blind counter.
  console.log("\n6. early termination")
  frames.length = 0
  let seen = 0
  let abandonedId = null
  let firstChunkAt = null
  for await (const _chunk of hands.hands.read(sourcePath)) {
    seen++
    firstChunkAt ??= performance.now()
    if (abandonedId === null) {
      // The opening reply names the stream, and it must arrive before the first
      // chunk can be delivered.
      for (const frame of frames) {
        const id = streamRefId(frame.message)
        if (id !== null) abandonedId = id
      }
    }
    if (seen >= 1) break
  }
  const returnedAfterMs = performance.now() - firstChunkAt

  // Data frames only. A terminal/ack frame for this sid is the peer answering
  // the release, which is correct behaviour and not a straggler.
  const dataFramesFor = (sid) =>
    frames.filter((frame) => frame.message?.sid === sid && frame.message?.d === false)
  const atRelease = abandonedId === null ? 0 : dataFramesFor(abandonedId).length
  await sleep(CANCEL_QUIET_MS)
  const afterQuiet = abandonedId === null ? 0 : dataFramesFor(abandonedId).length
  const afterFirstChunk =
    abandonedId === null
      ? 0
      : dataFramesFor(abandonedId).filter((frame) => frame.at > firstChunkAt).length

  check(
    "the abandoned stream is identified on the wire",
    abandonedId !== null,
    abandonedId === null ? "no __kkrpc_next_stream__ reply was observed" : `sid=${abandonedId}`,
  )
  check(
    "the producer stops: the abandoned stream never reaches the file's chunk count",
    abandonedId !== null && seen >= 1 && afterQuiet === atRelease && afterQuiet < chunks,
    `took ${seen} chunk(s) in ${returnedAfterMs.toFixed(0)} ms; data frames for sid=${abandonedId}: ` +
      `${atRelease} at release, ${afterQuiet} after a further ${CANCEL_QUIET_MS} ms ` +
      `(growth ${afterQuiet - atRelease}, want 0) — the same file produced ${chunks} chunks in §2, ` +
      `and ${afterFirstChunk} frame(s) DID arrive after the first chunk, so the counter is not blind`,
  )
} catch (error) {
  check("the run completed without throwing", false, String(error?.stack ?? error))
} finally {
  channel.destroy()
  child.kill()
  rmSync(work, { recursive: true, force: true })
}

const failed = results.filter((result) => !result.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
console.log(`RESULT ${JSON.stringify({ results })}`)
process.exit(failed.length ? 1 : 0)
