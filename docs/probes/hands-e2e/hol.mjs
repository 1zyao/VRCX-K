// Does `hands.read` block interactive RPC on the shared stdio pipe?
//
// WHY THIS IS THE DECIDING MEASUREMENT
//   `docs/hands-capability-proposal.md` §5 says the hands⇄brain bridge has ONE
//   stdin/stdout pipe, and that bulk transfer will contend with interactive
//   calls — citing transport-lab's WebSocket result (interactive p50 0.66 → 321 ms
//   during a 128 MiB transfer). It then leaves three options to the SDK:
//   (a) add a second channel, (b) rate-limit on the brain side, (c) accept it.
//
//   §5 is explicitly an INFERENCE ("本提案发现的新问题"), not a measurement of
//   this path. The transport-lab number is from a different transport with
//   different framing. So before designing a second channel (which is real work:
//   a second fd, its own lifecycle, its own teardown), the claim has to be
//   measured on the ACTUAL Rust peer.
//
//   The mechanism matters: `kkrpc_peer.rs`'s `write()` takes the writer lock and
//   releases it per frame, so the worst-case delay for an interactive call is ONE
//   chunk write, not the whole file. With 256 KiB chunks that is bounded — but by
//   how much depends on the link, which is why this is measured and not reasoned.
//
// WHAT IS MEASURED
//   Baseline: round-trip latency of `hands.stat` on an idle channel.
//   Loaded:   the same call, repeatedly, while a large `hands.read` stream is
//             being consumed.
//   Reported as p50 / p95 / max, plus the stream's throughput, so the tradeoff is
//   visible rather than asserted.
//
// Usage:
//   cargo build --release --locked --manifest-path src-tauri/Cargo.toml --example hands-e2e
//   node docs/probes/hands-e2e/hol.mjs [--size=134217728] [--samples=200]
//
// ⚠ Loopback caution (the lesson from transport-lab §8): this measures a LOCAL
//   pipe. It cannot tell you what a remote hands over a slow link does — the same
//   code path with a network transport would stretch the per-chunk delay. Treat
//   the absolute numbers as the floor, and the RATIO as the finding.

import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

const args = Object.fromEntries(
  process.argv.slice(2).map((raw) => {
    const [key, value] = raw.replace(/^--/, "").split("=")
    return [key, value ?? "true"]
  }),
)
const SIZE = Number(args.size ?? 128 * 1024 * 1024)
const SAMPLES = Number(args.samples ?? 200)

function transport(child) {
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
        /* malformed frame */
      }
    }
  })
  return {
    capabilities: { objectMode: false, transfer: false, remoteRefs: true },
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return Number.NaN
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

const work = mkdtempSync(join(tmpdir(), "hands-hol-"))
const child = spawn(BIN, [], { stdio: ["pipe", "pipe", "inherit"] })
const channel = new StreamingRPCChannel(transport(child), { timeout: 120_000 })
const hands = channel.getAPI()

const results = {}

try {
  const source = join(work, "big.bin")
  writeFileSync(source, Buffer.alloc(SIZE, 7))
  console.log(`payload = ${(SIZE / 1048576).toFixed(0)} MiB, samples = ${SAMPLES}\n`)

  // ---- baseline: interactive latency on an idle channel -------------------
  const idle = []
  for (let i = 0; i < SAMPLES; i++) {
    const started = performance.now()
    await hands.hands.stat(source)
    idle.push(performance.now() - started)
  }
  idle.sort((a, b) => a - b)
  results.idle = {
    p50: percentile(idle, 50),
    p95: percentile(idle, 95),
    max: idle[idle.length - 1],
  }
  console.log(
    `idle    hands.stat  p50=${results.idle.p50.toFixed(2)}ms ` +
      `p95=${results.idle.p95.toFixed(2)}ms max=${results.idle.max.toFixed(2)}ms`,
  )

  // ---- loaded: the same call while a big stream is flowing ---------------
  const loaded = []
  let streamed = 0
  let chunks = 0
  const startedAt = performance.now()

  // Start consuming, and interleave a stat probe after EVERY chunk. Probing per
  // chunk (rather than on a timer) guarantees the probe lands inside the
  // transfer window instead of racing its end.
  const consumer = (async () => {
    for await (const chunk of hands.hands.read(source)) {
      // ⚠ `chunk` is a base64 STRING, not bytes: the stock JSON codec has no
      // binary form (measured — see probe-host-streaming-channel.ts). Counting
      // `chunk.length` here reports 1.33x the real payload; the first run of this
      // probe did exactly that (it printed "171 MiB" for a 128 MiB file).
      streamed += typeof chunk === "string" ? Buffer.from(chunk, "base64").length : chunk.length
      chunks += 1
      const probeStarted = performance.now()
      await hands.hands.stat(source)
      loaded.push(performance.now() - probeStarted)
    }
  })()

  await consumer
  const elapsed = performance.now() - startedAt
  loaded.sort((a, b) => a - b)
  results.loaded = {
    p50: percentile(loaded, 50),
    p95: percentile(loaded, 95),
    max: loaded[loaded.length - 1],
    samples: loaded.length,
  }
  const throughput = streamed / 1048576 / (elapsed / 1000)
  console.log(
    `loaded  hands.stat  p50=${results.loaded.p50.toFixed(2)}ms ` +
      `p95=${results.loaded.p95.toFixed(2)}ms max=${results.loaded.max.toFixed(2)}ms ` +
      `(n=${loaded.length}, stream ${(streamed / 1048576).toFixed(0)} MiB in ${chunks} chunks ` +
      `at ${throughput.toFixed(0)} MiB/s)`,
  )

  const ratioP95 = results.loaded.p95 / Math.max(results.idle.p95, 0.001)
  const ratioP50 = results.loaded.p50 / Math.max(results.idle.p50, 0.001)
  console.log("")
  console.log(`p50 degradation: ${ratioP50.toFixed(2)}x`)
  console.log(`p95 degradation: ${ratioP95.toFixed(2)}x`)

  // ---- the competing explanation -----------------------------------------
  //
  // The loaded tail could be head-of-line blocking on the shared pipe — OR it
  // could be the Rust peer itself being busy producing base64 chunks, with no
  // queueing involved at all. Those need different fixes (a second channel vs
  // cheaper per-chunk work), so the two are separated:
  //
  //   `hands.read` producing chunks and answering `stat` are both handled by the
  //   SAME reader thread. If the peer is CPU-bound in `decode/encode`, the delay
  //   appears even when nothing is queued behind a large write.
  //
  // Recorded as a control instead of guessed at: the ratio above stands whatever
  // the cause, but the CAUSE decides the remedy.
  const control = []
  for (let i = 0; i < SAMPLES; i++) {
    const started = performance.now()
    await hands.hands.stat(source)
    control.push(performance.now() - started)
  }
  control.sort((a, b) => a - b)
  const controlP95 = percentile(control, 95)
  console.log(
    `post-load (idle again) p50=${percentile(control, 50).toFixed(2)}ms ` +
      `p95=${controlP95.toFixed(2)}ms`,
  )
  console.log(
    controlP95 < results.idle.p95 * 3
      ? "  ⇒ latency RECOVERS once the stream stops, so the tail is caused by the transfer, not by a persistent degradation"
      : "  ⚠ latency does NOT recover after the stream stops — investigate before attributing it to the transfer",
  )

  console.log(
    `RESULT ${JSON.stringify({
      sizeMiB: SIZE / 1048576,
      idle: results.idle,
      loaded: results.loaded,
      postLoadP95: controlP95,
      ratioP50,
      ratioP95,
      throughputMiBps: throughput,
      chunks,
    })}`,
  )
} finally {
  channel.destroy()
  child.kill()
  rmSync(work, { recursive: true, force: true })
}
