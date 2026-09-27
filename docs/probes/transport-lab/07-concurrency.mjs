/**
 * CONCURRENT TRANSFERS — one connection per transfer, so the measurement is
 * about concurrency rather than about demultiplexing.
 *
 * WHY THIS FILE REPLACES TWO FAILED ATTEMPTS
 *   Both earlier versions multiplexed several files onto ONE socket and tagged
 *   each frame with a fileId. Both reported corruption, and both times the fault
 *   was mine:
 *     · attempt 1 built frames 8 bytes short, so EVERY frame was "corrupt" at
 *       EVERY level including level 1 — identical at level 1 and 8, which is the
 *       signature of a probe bug rather than a concurrency defect;
 *     · attempt 2 failed purely on DUPLICATES while the failure message printed
 *       only `missing` and `corrupt` — so it read as "0 missing, 0 corrupt",
 *       i.e. as no problem at all. (Omitting a counter from the message has now
 *       hidden a real result twice in this investigation.)
 *
 *   The demultiplexing was the only complexity in those tests and the only
 *   place a bug could hide. It is also unnecessary: the head-of-line experiment
 *   already showed a SEPARATE connection keeps interactive RPC responsive while
 *   a bulk transfer runs, which is the topology a real implementation should
 *   use anyway.
 *
 * SO: N transfers = N independent connections, each carrying one file. Each
 * connection is verified on its own, and no frame needs a tag.
 *
 * WHAT IS MEASURED, and why each matters for "upload a folder"
 *   · aggregate throughput vs level  — does parallelism buy anything at all?
 *   · per-transfer bytes and integrity — a fast wrong answer is worthless
 *   · peak heap — the real cost of parallelism, since each stream holds buffers
 *   · start-to-finish spread — whether one slow transfer drags the batch
 *
 * Usage: node|bun 07-concurrency.mjs [--sizeMiB=16] [--levels=1,2,4,8] [--port=46500]
 */
import { WebSocketServer } from "ws"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { makeFrame, readSeq, verifyFrame } from "./proto.mjs"

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

const PORT = Number(args.port ?? 46500)
const SIZE_MIB = Number(args.sizeMiB ?? 16)
const CHUNK = 64 * 1024
const FRAMES_PER_FILE = Math.floor((SIZE_MIB * 1024 * 1024) / CHUNK)
const LEVELS = String(args.levels ?? "1,2,4,8").split(",").map(Number)
const runtime = typeof Bun !== "undefined" ? `bun-${Bun.version}` : `node-${process.version}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Built once and reused: send-side CPU must not be measured as transport. */
const payload = []
for (let i = 0; i < FRAMES_PER_FILE; i++) payload.push(makeFrame(i, CHUNK))
const FILE_BYTES = FRAMES_PER_FILE * CHUNK

/**
 * The server sends ONE file per connection, then the terminator. No tags, no
 * interleaving: if a frame arrives, it belongs to this file.
 */
const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT, maxPayload: 1 << 30, perMessageDeflate: false })
await new Promise((r) => wss.once("listening", r))

wss.on("connection", (socket) => {
  socket.on("message", (data, isBinary) => {
    if (isBinary) return
    let msg
    try {
      msg = JSON.parse(data.toString("utf8"))
    } catch {
      return
    }
    if (msg.ctl !== true) return
    void (async () => {
      for (let i = 0; i < FRAMES_PER_FILE; i++) {
        if (socket.readyState !== 1) return
        socket.send(payload[i], { binary: true })
        // Yield periodically so the server's own event loop stays alive; a fully
        // synchronous loop would make the server the bottleneck and the
        // comparison meaningless.
        if (i % 32 === 0) await sleep(0)
      }
      socket.send(JSON.stringify({ ctl: true, done: true }), { binary: false })
    })()
  })
  socket.on("error", () => {})
})

/** One transfer on its own connection. */
async function transfer(index) {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}`)
  socket.binaryType = "arraybuffer"
  await new Promise((res, rej) => {
    socket.addEventListener("open", res)
    socket.addEventListener("error", () => rej(new Error("ws error")))
  })

  const counts = new Map()
  let corrupt = 0
  let firstIssue = null
  let dupTotal = 0
  const dupSeqs = []
  let done = false
  let finishedAt = null
  const startedAt = performance.now()

  socket.addEventListener("message", (ev) => {
    const d = ev.data
    if (typeof d === "string") {
      const msg = JSON.parse(d)
      if (msg.ctl === true && msg.done) {
        done = true
        finishedAt = performance.now()
      }
      return
    }
    const frame = new Uint8Array(d)
    const seq = readSeq(frame)
    const before = counts.get(seq) ?? 0
    counts.set(seq, before + 1)
    if (before > 0) {
      dupTotal++
      if (dupSeqs.length < 6) dupSeqs.push(seq)
    }
    const diff = verifyFrame(frame, seq, CHUNK)
    if (diff !== null) {
      corrupt++
      if (firstIssue === null) firstIssue = `seq ${seq}: ${diff}`
    }
  })

  socket.send(JSON.stringify({ ctl: true, index }))

  const deadline = Date.now() + 60000
  while (!done && Date.now() < deadline) await sleep(5)
  socket.close()

  let missing = 0
  for (let i = 0; i < FRAMES_PER_FILE; i++) if (!counts.has(i)) missing++
  let duplicates = 0
  for (const n of counts.values()) if (n > 1) duplicates += n - 1

  return {
    index,
    done,
    ms: finishedAt === null ? null : +(finishedAt - startedAt).toFixed(0),
    startedAtMs: +(startedAt - t0).toFixed(0),
    bytes: [...counts.keys()].length,
    missing,
    duplicates,
    dupTotal,
    dupSeqs,
    corrupt,
    firstIssue,
    exact: done && missing === 0 && duplicates === 0 && corrupt === 0,
  }
}

let t0 = 0

/** Launch `level` transfers at once, each on its own connection. */
async function runLevel(level) {
  const heapBefore = process.memoryUsage().heapUsed
  let peakHeap = heapBefore
  const sampler = setInterval(() => {
    const m = process.memoryUsage().heapUsed
    if (m > peakHeap) peakHeap = m
  }, 5)

  t0 = performance.now()
  const results = await Promise.all(Array.from({ length: level }, (_, i) => transfer(i)))
  const wallMs = performance.now() - t0
  clearInterval(sampler)
  const heapAfter = process.memoryUsage().heapUsed
  if (heapAfter > peakHeap) peakHeap = heapAfter

  const finished = results.filter((r) => r.ms !== null)
  const totalBytes = level * FILE_BYTES
  return {
    level,
    runtime,
    exactCount: results.filter((r) => r.exact).length,
    wallMs: +wallMs.toFixed(0),
    aggregateMBps: +((totalBytes / 1048576 / Math.max(1, wallMs)) * 1000).toFixed(1),
    fastestMs: finished.length ? Math.min(...finished.map((r) => r.ms)) : null,
    slowestMs: finished.length ? Math.max(...finished.map((r) => r.ms)) : null,
    /** Bytes actually verified (not merely sent) across all transfers. */
    verifiedMiB: +((results.reduce((a, r) => a + r.bytes * CHUNK, 0)) / 1048576).toFixed(1),
    expectedMiB: +(totalBytes / 1048576).toFixed(1),
    peakHeapMiB: +((peakHeap - heapBefore) / 1048576).toFixed(1),
    peakHeapAbsMiB: +(peakHeap / 1048576).toFixed(1),
    transfers: results,
  }
}

const results = []
for (const level of LEVELS) {
  process.stderr.write(`[conc2] level ${level} ... `)
  const r = await runLevel(level)
  results.push(r)
  process.stderr.write(
    `${r.exactCount}/${level} exact, wall ${r.wallMs}ms, ${r.aggregateMBps} MB/s, ` +
      `heap +${r.peakHeapMiB} MiB, verified ${r.verifiedMiB}/${r.expectedMiB} MiB\n`,
  )
  await sleep(300)
}

mkdirSync(join(here, "results"), { recursive: true })
writeFileSync(
  join(here, "results", "conc2.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), sizeMiB: SIZE_MIB, port: PORT, results }, null, 2),
)

const lines = []
lines.push("=== CONCURRENT TRANSFERS, ONE CONNECTION PER TRANSFER ===")
lines.push(`${SIZE_MIB} MiB per file (${FRAMES_PER_FILE} x ${CHUNK / 1024} KiB), client = global WebSocket (${runtime})`)
lines.push("")
lines.push("  level  exact   wall      aggregate   fastest/slowest   heap delta   verified")
for (const r of results) {
  lines.push(
    `  ${String(r.level).padStart(5)}  ${String(`${r.exactCount}/${r.level}`).padStart(5)}  ` +
      `${String(r.wallMs).padStart(6)}ms  ${String(r.aggregateMBps).padStart(8)}MB/s  ` +
      `${String(r.fastestMs).padStart(7)}/${String(r.slowestMs).padStart(7)}ms  ` +
      `${String(`+${r.peakHeapMiB}`).padStart(9)} MiB  ${r.verifiedMiB}/${r.expectedMiB} MiB`,
  )
}

// Per-transfer detail for any level that was not fully exact.
for (const r of results) {
  const bad = r.transfers.filter((t) => !t.exact)
  if (bad.length === 0) continue
  lines.push("")
  lines.push(`  level ${r.level} details (every counter printed — omitting one has hidden a result twice):`)
  for (const t of bad) {
    lines.push(
      `    file ${t.index}: done=${t.done} missing=${t.missing} duplicates=${t.duplicates} ` +
        `corrupt=${t.corrupt} seqsSeen=${t.bytes}/${FRAMES_PER_FILE}` +
        (t.dupSeqs.length ? ` firstDupSeqs=[${t.dupSeqs.join(",")}]` : "") +
        (t.firstIssue ? ` issue=${t.firstIssue}` : ""),
    )
  }
}

lines.push("")
lines.push("=== VERDICT ===")
const allExact = results.every((r) => r.exactCount === r.level)
const totalVerified = results.reduce((a, r) => a + r.verifiedMiB, 0)
const totalExpected = results.reduce((a, r) => a + r.expectedMiB, 0)

lines.push(`  every transfer byte-exact at every level : ${allExact}`)
lines.push(`  bytes verified / expected across all runs : ${totalVerified.toFixed(0)} / ${totalExpected.toFixed(0)} MiB`)
if (!allExact) {
  lines.push("")
  lines.push("  *** INTEGRITY FAILURES — do NOT parallelise until the cause is identified. ***")
} else {
  const base = results.find((r) => r.level === 1)
  const best = results.reduce((m, r) => (r.aggregateMBps > m.aggregateMBps ? r : m))
  const worst = results.reduce((m, r) => (r.aggregateMBps < m.aggregateMBps ? r : m))
  lines.push("")
  if (base) lines.push(`  level 1 baseline                          : ${base.aggregateMBps} MB/s, ${base.wallMs} ms`)
  lines.push(`  best                                     : level ${best.level}, ${best.aggregateMBps} MB/s`)
  lines.push(`  worst                                    : level ${worst.level}, ${worst.aggregateMBps} MB/s`)
  if (base) {
    lines.push(`  scaling vs level 1                       : ${(best.aggregateMBps / base.aggregateMBps).toFixed(2)}x`)
  }
  lines.push(`  heap delta: ` + results.map((r) => `L${r.level}=+${r.peakHeapMiB}MiB`).join("  "))
  lines.push("  interference (slowest - fastest, ms): " + results.map((r) => `L${r.level}=${r.slowestMs - r.fastestMs}`).join("  "))
  lines.push("")
  if (base && best.aggregateMBps > base.aggregateMBps * 1.5) {
    lines.push("  => parallelism DOES raise aggregate throughput, so it is worth offering.")
    lines.push("     Budget by MEMORY, not by throughput: each stream costs buffers, and the")
    lines.push("     heap delta above is the price per level on this machine.")
  } else {
    lines.push("  => parallelism does NOT meaningfully raise aggregate throughput — one transfer")
    lines.push("     already saturates this machine's path. For a folder upload, prefer")
    lines.push("     SEQUENTIAL and spend the effort on progress/resume instead.")
  }
}
lines.push("")

const text = lines.join("\n")
writeFileSync(join(here, "results", "conc2-report.txt"), text)
console.log(text)
wss.close()
process.exit(0)
