// WHY THE INTERACTIVE TAIL BLOWS UP DURING BULK — attempt 2, after attempt 1 was
// invalid by construction.
//
// WHAT WENT WRONG IN ATTEMPT 1 (`hol-credit.mjs`, kept for the record)
//   It probed interactively at the END of each credit batch. But the producer has
//   exactly exhausted its credit at that moment, so it is BLOCKED waiting for the
//   next pull — the reader thread is idle by construction. Every probe therefore
//   measured the quiescent state (tail 1.2-1.8x) and the "credit does not scale"
//   conclusion was an artefact of the instrument, not a finding.
//   This is the same family of mistake the probe README warns about: a failure
//   that does not vary with the variable is the instrument.
//
// THE HYPOTHESIS UNDER TEST (H3)
//   `kkrpc_peer.rs::pump_producer` runs `for _ in 0..credit { … }` on the READER
//   thread and does not call `read_line` again until the whole batch is emitted.
//   An inbound request therefore waits for the remainder of the batch — so the
//   interactive delay should track **how much credit is still outstanding**.
//
// THE DISCRIMINATING DESIGN (this file)
//   Compare two probe positions WITHIN THE SAME CREDIT, so throughput and
//   per-chunk cost are held constant and only "is the producer mid-batch?" varies:
//
//     MID   — probe after the 1st chunk of a batch  (credit-1 still outstanding,
//             producer actively pumping)              ⇒ H3 predicts LARGE delay
//     END   — probe after the last chunk of a batch (credit exhausted, producer
//             blocked on the next pull)               ⇒ H3 predicts ~0 delay
//
//   Same batch size, same bytes, same round trips. If MID >> END, the reader
//   thread is genuinely starved by the pump loop (H3 confirmed). If MID ≈ END,
//   H3 is dead and the cost is per-chunk CPU or per-write lock.
//
//   A second axis is then free: the delay should grow with the credit size, since
//   more outstanding credit means more iterations before read_line is reached.
//
// Usage:
//   cargo build --release --locked --manifest-path src-tauri/Cargo.toml --example hands-e2e
//   node docs/probes/hands-e2e/hol-credit.mjs [--sizeMiB=64] [--credits=4,8,16,32]
//
// ⚠ Loopback only. This measures the MECHANISM (what the delay tracks), not the
//   severity on a real link — transport-lab §8 discipline applies.

import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

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
const SIZE_MIB = Number(args.sizeMiB ?? 64)
const CREDITS = String(args.credits ?? "4,8,16,32")
  .split(",")
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)

function percentile(sorted, p) {
  if (sorted.length === 0) return Number.NaN
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[i]
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
  }
}

/** Speak the frame protocol directly, so `n` in each pull is ours to choose. */
class RawPeer {
  constructor(child) {
    this.child = child
    this.buffer = ""
    this.waiters = new Map()
    this.streams = new Map()
    this.nextId = 1
    child.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8")
      const lines = this.buffer.split("\n")
      this.buffer = lines.pop() ?? ""
      for (const line of lines) {
        const text = line.trim()
        if (!text.startsWith("{")) continue
        let message
        try {
          message = JSON.parse(text)
        } catch {
          continue
        }
        this.#dispatch(message)
      }
    })
  }

  #send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #dispatch(message) {
    if (message.t === "r") {
      const waiter = this.waiters.get(message.id)
      if (waiter) {
        this.waiters.delete(message.id)
        if (message.e) waiter.reject(new Error(message.e.m ?? "rpc error"))
        else waiter.resolve(message.v)
      }
      return
    }
    if (message.t === "sr") {
      const stream = this.streams.get(message.sid)
      if (!stream) return
      if (message.e) {
        stream.onError(new Error(message.e.m ?? "stream error"))
        this.streams.delete(message.sid)
        return
      }
      if (message.d === true) {
        this.streams.delete(message.sid)
        stream.onDone()
        return
      }
      stream.onChunk(
        typeof message.v === "string" ? Buffer.from(message.v, "base64").length : 0,
      )
    }
  }

  call(path, callArgs = [], timeoutMs = 60_000) {
    const id = `r-${this.nextId++}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id)
        reject(new Error(`timeout waiting for ${path.join(".")}`))
      }, timeoutMs)
      this.waiters.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      this.#send({ t: "q", id, op: "call", p: path, a: callArgs })
    })
  }

  pull(sid, n) {
    this.#send({ t: "sq", id: `p-${this.nextId++}`, sid, op: "pull", n })
  }

  /**
   * Open a stream and probe at TWO fixed positions inside every batch.
   *
   * Both probes happen in the same run at the same credit, so throughput, chunk
   * size and round-trip count are identical for the two arms — only the number of
   * outstanding credits at probe time differs.
   */
  consume(path, credit, { onMid, onEnd, callArgs = [] }) {
    return new Promise((resolve, reject) => {
      this.call(path, callArgs)
        .then((ref) => {
          const sid = ref?.__kkrpc_next_stream__ ? ref.id : undefined
          if (!sid) {
            reject(new Error(`no stream ref from ${path.join(".")}`))
            return
          }
          let inBatch = 0
          let totalChunks = 0
          let totalBytes = 0
          const started = performance.now()

          this.streams.set(sid, {
            onChunk: (bytes) => {
              totalChunks += 1
              totalBytes += bytes
              inBatch += 1

              // MID: the batch has just started, so `credit - 1` pulls are still
              // outstanding and the producer keeps pumping while we probe.
              if (inBatch === 1) {
                void onMid()
              }
              // END: the batch is exhausted; the producer is blocked until we
              // pull again, so the reader thread is idle while we probe.
              if (inBatch >= credit) {
                inBatch = 0
                void onEnd().then(() => this.pull(sid, credit))
              }
            },
            onDone: () =>
              resolve({ chunks: totalChunks, bytes: totalBytes, ms: performance.now() - started }),
            onError: reject,
          })
          this.pull(sid, credit)
        })
        .catch(reject)
    })
  }
}

const work = mkdtempSync(join(tmpdir(), "hol-credit2-"))
const child = spawn(BIN, [], { stdio: ["pipe", "pipe", "inherit"] })
const peer = new RawPeer(child)

/** Fire a `stat` and record its latency. Never throws. */
function makeProbe(sink) {
  return async () => {
    const t0 = performance.now()
    try {
      await peer.call(["hands", "stat"], [source])
    } catch {
      /* recorded regardless: a failed probe is still a delayed one */
    }
    sink.push(performance.now() - t0)
  }
}
let source = ""

const results = []
try {
  const size = SIZE_MIB * 1024 * 1024
  source = join(work, "big.bin")
  writeFileSync(source, Buffer.alloc(size, 7))
  console.log(`payload = ${SIZE_MIB} MiB, credits = ${CREDITS.join(", ")}\n`)

  const idle = []
  for (let i = 0; i < 100; i++) {
    const t0 = performance.now()
    await peer.call(["hands", "stat"], [source])
    idle.push(performance.now() - t0)
  }
  const idleStats = stats(idle)
  console.log(
    `idle   hands.stat  p50=${idleStats.p50.toFixed(3)}ms p95=${idleStats.p95.toFixed(3)}ms\n`,
  )

  console.log("credit | arm |    n | p50 (ms) | p95 (ms) | max (ms) | vs idle p95")
  console.log("-------|-----|------|----------|----------|----------|------------")

  for (const credit of CREDITS) {
    const mid = []
    const end = []
    const summary = await peer.consume(["hands", "read"], credit, {
      onMid: makeProbe(mid),
      onEnd: makeProbe(end),
      callArgs: [source, { offset: 0 }],
    })
    const m = stats(mid)
    const e = stats(end)
    const mibps = summary.bytes / 1048576 / (summary.ms / 1000)
    results.push({ credit, mid: m, end: e, mibps, chunks: summary.chunks })
    for (const [arm, s] of [
      ["MID", m],
      ["END", e],
    ]) {
      console.log(
        `${String(credit).padStart(6)} | ${arm} | ${String(s.n).padStart(4)} | ` +
          `${s.p50.toFixed(3).padStart(8)} | ${s.p95.toFixed(3).padStart(8)} | ` +
          `${s.max.toFixed(3).padStart(8)} | ${(s.p95 / idleStats.p95).toFixed(1).padStart(6)}x`,
      )
    }
    console.log(`       |     |      | (${mibps.toFixed(0)} MiB/s, ${summary.chunks} chunks)`)
  }

  // ---- verdict -----------------------------------------------------------
  console.log("")
  const midRatios = results.map((r) => r.mid.p95 / Math.max(r.end.p95, 0.001))
  const worst = Math.max(...midRatios)
  const midScales = results[results.length - 1].mid.p95 / Math.max(results[0].mid.p95, 0.001)
  const creditRatio = results[results.length - 1].credit / results[0].credit

  console.log(`MID/END p95 ratio per credit: ${midRatios.map((r) => r.toFixed(2)).join(", ")}`)
  console.log(
    `MID p95 grew ${midScales.toFixed(1)}x while credit grew ${creditRatio.toFixed(0)}x`,
  )
  console.log("")

  // H3 requires BOTH: a mid-batch penalty, and that penalty growing with credit.
  const midPenalty = worst > 2.5
  const scales = midScales > creditRatio * 0.3 && midScales > 2

  if (midPenalty && scales) {
    console.log(
      "RESULT H3 CONFIRMED: probing mid-batch is far worse than at batch end, and the\n" +
        "  penalty grows with the credit size.\n" +
        "  ⇒ `pump_producer`'s `for _ in 0..credit` loop starves read_line on the reader\n" +
        "    thread; an inbound request waits out the remainder of the batch.\n" +
        "  ⇒ FIX: yield between chunks (or shrink the batch). A second channel would\n" +
        "    also work but is far more expensive; a cheaper carrier only shortens each\n" +
        "    iteration, it does not remove the starvation.",
    )
  } else if (midPenalty) {
    console.log(
      "RESULT H3 PARTIAL: mid-batch probing is worse than batch-end, but the penalty does\n" +
        "  not scale with credit. Something in the pump loop costs a fixed amount per\n" +
        "  batch rather than per outstanding credit — inspect before choosing a fix.",
    )
  } else {
    console.log(
      "RESULT H3 REFUTED: mid-batch and batch-end probing cost about the same, so the\n" +
        "  reader thread is NOT starved by the pump loop. The residual cost is per-chunk\n" +
        "  (carrier/CPU) or per-write (lock/pipe) — measure those instead.",
    )
  }

  console.log(
    `RESULT ${JSON.stringify({ sizeMiB: SIZE_MIB, idle: idleStats, results: results.map((r) => ({ credit: r.credit, mid: r.mid, end: r.end, mibps: r.mibps })) })}`,
  )
} finally {
  child.kill()
  rmSync(work, { recursive: true, force: true })
}
