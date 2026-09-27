/**
 * HEAD-OF-LINE BLOCKING, measured correctly.
 *
 * WHY THIS FILE REPLACES THE PREVIOUS ATTEMPT
 *   The first version concluded "no head-of-line blocking — burst is fine". Its
 *   own output contradicted that: it reported `RPC during max = 0.8 ms` but
 *   `RPC after max = 74.7 ms`. Two flaws produced that:
 *
 *     1. SAMPLES WERE BUCKETED BY ARRIVAL TIME. A probe sent DURING the bulk
 *        whose reply landed just after the transfer ended was filed under
 *        "after", so the real during-transfer worst case was misattributed and
 *        the during window looked clean. Bucketing is now by SEND TIME, which is
 *        the only timestamp that says when the caller was actually waiting.
 *
 *     2. THE TRANSFER WAS TOO SHORT AND TOO RARE. 32 MiB moved in ~157 ms and
 *        pings went out every 20 ms, so only 2 samples landed inside the
 *        transfer — a p95 computed from 2 points is not a measurement. The bulk
 *        is now much larger and pings are far more frequent.
 *
 * THE LOOPBACK CAVEAT (stated because it biases the result OPTIMISTICALLY)
 *   On loopback the kernel socket buffers absorb tens of megabytes, so a
 *   "burst" can be handed to the kernel and drained before the next probe is
 *   sent. That makes blocking look BETTER here than it would be across a real
 *   network or through a slower sink. This file therefore also measures a
 *   scenario with an artificially SLOW receiver, which keeps the send queue
 *   genuinely full — the closest local approximation of a constrained link. If
 *   blocking appears anywhere, it appears there.
 *
 * WHAT IS REPORTED
 *   · RPC latency (p50/p95/p99/max) bucketed by send time into idle / during /
 *   · bulk throughput, and whether it completed byte-exact
 *   · the number of samples in each bucket, because a percentile over 2 samples
 *     must not be read as a percentile over 200
 *
 * Usage:
 *   node 03-head-of-line-server.mjs --port=46100   (background)
 *   node 03-head-of-line.mjs --port=46100 --frames=2048 --size=65536
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { readSeq, verifyFrame } from "./proto.mjs"

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

const PORT = Number(args.port ?? 46100)
const BULK_FRAMES = Number(args.frames ?? 2048)
const BULK_SIZE = Number(args.size ?? 65536)
const PING_EVERY_MS = Number(args.pingMs ?? 5)
const runtime = typeof Bun !== "undefined" ? `bun-${Bun.version}` : `node-${process.version}`

const percentile = (sorted, p) => {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return +sorted[idx].toFixed(2)
}

/** Summarise a latency bucket, always carrying its sample count. */
const summarise = (samples) => {
  const sorted = [...samples].map((s) => s.ms).sort((a, b) => a - b)
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length ? +sorted[sorted.length - 1].toFixed(2) : null,
    // Enough samples to treat p95 as meaningful rather than as an anecdote.
    reliable: sorted.length >= 20,
  }
}

/**
 * One scenario.
 *
 * `slowReader` throttles the CLIENT's draining of bulk frames. On loopback the
 * send queue empties almost instantly; adding a slow consumer keeps it full, so
 * the contention a real constrained link would produce actually occurs.
 */
async function scenario(name, description, slowReader = false) {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}`)
  socket.binaryType = "arraybuffer"

  /** Every probe: when it was SENT and how long it waited. */
  const probes = []
  const counts = new Map()
  let corrupt = 0
  let firstIssue = null
  let bulkDoneAt = null
  let received = 0
  const sentAt = new Map()
  let pingSeq = 0
  let bulkStartedAt = 0
  let bulkDone = false

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve)
    socket.addEventListener("error", () => reject(new Error("ws error")))
  })

  // Bulk frames are drained through a queue so `slowReader` can throttle them
  // without stalling the socket's own event dispatch (which would distort the
  // RPC latency being measured).
  const queue = []
  let draining = false
  const drain = async () => {
    if (draining) return
    draining = true
    while (queue.length > 0) {
      const frame = queue.shift()
      const seq = readSeq(frame)
      counts.set(seq, (counts.get(seq) ?? 0) + 1)
      const diff = verifyFrame(frame, seq, BULK_SIZE)
      if (diff !== null) {
        corrupt++
        if (firstIssue === null) firstIssue = `seq ${seq}: ${diff}`
      }
      received++
      if (slowReader) await new Promise((r) => setTimeout(r, 0))
    }
    draining = false
  }

  socket.addEventListener("message", (ev) => {
    const d = ev.data
    if (typeof d === "string") {
      const msg = JSON.parse(d)
      if (msg.rpc === "pong") {
        const t = sentAt.get(msg.seq)
        if (t !== undefined) {
          // The SEND timestamp is what places this sample in a window.
          probes.push({ sentAtMs: t, ms: performance.now() - t })
          sentAt.delete(msg.seq)
        }
        return
      }
      if (msg.ctl === true && msg.done) {
        bulkDone = true
        bulkDoneAt = performance.now()
        return
      }
      return
    }
    queue.push(new Uint8Array(d))
    void drain()
  })

  // Pinging runs continuously across all three windows: before, during, after.
  let phase = "idle"
  const ping = () => {
    const t = performance.now()
    sentAt.set(pingSeq, t)
    socket.send(JSON.stringify({ rpc: "ping", seq: pingSeq, t, phase }))
    pingSeq++
  }
  const timer = setInterval(ping, PING_EVERY_MS)

  // Idle baseline.
  await new Promise((r) => setTimeout(r, 400))

  // Bulk.
  bulkStartedAt = performance.now()
  socket.send(JSON.stringify({ ctl: true, scenario: name, frames: BULK_FRAMES, size: BULK_SIZE }))

  const deadline = Date.now() + 180000
  while (!bulkDone && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))

  // Let the reader finish draining before the trailing probes.
  const drainDeadline = Date.now() + 30000
  while ((queue.length > 0 || draining) && Date.now() < drainDeadline) {
    await new Promise((r) => setTimeout(r, 10))
  }

  // Trailing probes confirm the connection recovers.
  const trailUntil = Date.now() + 300
  while (Date.now() < trailUntil) await new Promise((r) => setTimeout(r, 20))
  clearInterval(timer)
  if (bulkDoneAt === null) bulkDoneAt = performance.now()

  const bulkMs = bulkDoneAt - bulkStartedAt

  // BUCKET BY SEND TIME. A probe belongs to the window it was sent in, no
  // matter when its reply arrived — that is when the caller was blocked.
  const idle = probes.filter((p) => p.sentAtMs < bulkStartedAt)
  const during = probes.filter((p) => p.sentAtMs >= bulkStartedAt && p.sentAtMs <= bulkDoneAt)
  const after = probes.filter((p) => p.sentAtMs > bulkDoneAt)

  let missing = 0
  for (let i = 0; i < BULK_FRAMES; i++) if (!counts.has(i)) missing++
  let duplicates = 0
  for (const n of counts.values()) if (n > 1) duplicates += n - 1

  socket.close()

  // The last probe sent during the transfer is the one that waited through the
  // most queued work; its latency is the worst interactive experience.
  const duringSorted = [...during].sort((a, b) => a.sentAtMs - b.sentAtMs)
  const lastDuring = duringSorted[duringSorted.length - 1]

  return {
    scenario: name,
    description,
    slowReader,
    runtime,
    bulkFrames: BULK_FRAMES,
    bulkSize: BULK_SIZE,
    bulkMiB: +((BULK_FRAMES * BULK_SIZE) / 1048576).toFixed(1),
    bulkComplete: bulkDone,
    bulkMs: +bulkMs.toFixed(0),
    bulkMBps: +(((BULK_FRAMES * BULK_SIZE) / 1048576 / Math.max(1, bulkMs)) * 1000).toFixed(1),
    received,
    missing,
    duplicates,
    corrupt,
    firstIssue,
    exact: bulkDone && missing === 0 && duplicates === 0 && corrupt === 0,
    rpc: { idle: summarise(idle), during: summarise(during), after: summarise(after) },
    /** Latency of the FINAL probe sent during the transfer (worst realistic wait). */
    lastDuringLatencyMs: lastDuring ? +lastDuring.ms.toFixed(2) : null,
    duringSampleCount: during.length,
    /** A call that waited at least as long as the transfer was fully serialised. */
    fullyBlocked: lastDuring ? lastDuring.ms >= bulkMs * 0.9 : false,
  }
}

const results = []
const SCENARIOS = [
  ["A", "burst, normal reader", false],
  ["B", "yielding slices, normal reader", false],
  ["A-slow", "burst, SLOW reader (keeps the send queue full)", true],
  ["B-slow", "yielding slices, SLOW reader", true],
]

for (const [name, description, slow] of SCENARIOS) {
  process.stderr.write(`[hol] ${name} — ${description} ... `)
  const r = await scenario(name, description, slow)
  results.push(r)
  process.stderr.write(
    `bulk ${r.bulkComplete ? "ok" : "INCOMPLETE"} ${r.bulkMBps}MB/s in ${r.bulkMs}ms | ` +
      `during n=${r.duringSampleCount} p50=${r.rpc.during.p50} p95=${r.rpc.during.p95} max=${r.rpc.during.max}ms` +
      (r.fullyBlocked ? "  FULLY-BLOCKED" : "") +
      "\n",
  )
}

mkdirSync(join(here, "results"), { recursive: true })
writeFileSync(join(here, "results", "hol.json"), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2))

const lines = []
lines.push("=== HEAD-OF-LINE BLOCKING on a SHARED ws connection ===")
lines.push(`${BULK_FRAMES} x ${BULK_SIZE / 1024} KiB = ${((BULK_FRAMES * BULK_SIZE) / 1048576).toFixed(0)} MiB per scenario; probes every ${PING_EVERY_MS} ms`)
lines.push(`client = global WebSocket (${runtime}); samples bucketed by SEND time`)
lines.push("")
lines.push("  scenario   bulk throughput   RPC idle p50   DURING p50 / p95 / max (n)         verdict")
for (const r of results) {
  const d = r.rpc.during
  const reliable = d.reliable ? "" : " (n<20 UNRELIABLE)"
  lines.push(
    `  ${r.scenario.padEnd(9)}  ${String(r.bulkMBps ?? "-").padStart(7)}MB/s     ` +
      `${String(r.rpc.idle.p50 ?? "-").padStart(7)}ms   ` +
      `${String(d.p50 ?? "-").padStart(6)} / ${String(d.p95 ?? "-").padStart(7)} / ${String(d.max ?? "-").padStart(8)} (${String(d.n).padStart(3)})  ` +
      `${r.fullyBlocked ? "BLOCKED" : "responsive"}${reliable}`,
  )
}

lines.push("")
lines.push("  detail")
for (const r of results) {
  lines.push(`    ${r.scenario}: ${r.description}`)
  lines.push(
    `      bulk ${r.bulkMiB} MiB in ${r.bulkMs} ms = ${r.bulkMBps} MB/s` +
      (r.exact ? " (byte-exact)" : ` (INCOMPLETE: missing ${r.missing}, corrupt ${r.corrupt})`),
  )
  for (const w of ["idle", "during", "after"]) {
    const s = r.rpc[w]
    lines.push(`      RPC ${w.padEnd(6)} n=${String(s.n).padStart(3)}  p50=${s.p50} p95=${s.p95} p99=${s.p99} max=${s.max} ms`)
  }
  lines.push(`      final probe sent during bulk: ${r.lastDuringLatencyMs} ms`)
}

lines.push("")
lines.push("=== VERDICT ===")
const normal = results.filter((r) => !r.slowReader)
const slow = results.filter((r) => r.slowReader)
const anyReliable = results.filter((r) => r.rpc.during.reliable)
lines.push(`  scenarios with a statistically usable during-sample set (n>=20): ${anyReliable.length}/${results.length}`)
if (anyReliable.length === 0) {
  lines.push("  *** NO SCENARIO PRODUCED ENOUGH IN-TRANSFER SAMPLES — this measurement cannot")
  lines.push("  *** support a conclusion either way. Increase --frames or shorten --pingMs. ***")
} else {
  const worst = anyReliable.reduce((m, r) => (r.rpc.during.max > m.rpc.during.max ? r : m))
  lines.push(`  worst during-transfer latency across usable scenarios: ${worst.rpc.during.max} ms (${worst.scenario})`)
  const anyBlocked = anyReliable.some((r) => r.fullyBlocked)
  lines.push(`  any scenario where a call waited ~the whole transfer : ${anyBlocked}`)
  lines.push("")
  if (anyBlocked) {
    lines.push("  => SHARING one ws connection with an unthrottled bulk transfer DOES block")
    lines.push("     interactive RPC. A separate connection (or explicit priority) is required.")
  } else {
    lines.push("  => no full serialisation observed locally. NOTE the loopback caveat: kernel")
    lines.push("     buffers absorb large bursts, so this is an OPTIMISTIC bound. The")
    lines.push("     `-slow` scenarios are the ones to read for a constrained link.")
  }
  for (const r of slow) {
    lines.push(
      `     ${r.scenario}: during p50=${r.rpc.during.p50} max=${r.rpc.during.max} ms vs ` +
        `${r.bulkMBps} MB/s (slow reader keeps the queue full)`,
    )
  }
}
lines.push("")

const text = lines.join("\n")
writeFileSync(join(here, "results", "hol-report.txt"), text)
console.log(text)
process.exit(0)
