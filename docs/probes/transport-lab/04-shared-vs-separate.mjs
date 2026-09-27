/**
 * THE DECIDING COMPARISON: shared RPC tunnel vs a SEPARATE connection.
 *
 * THE QUESTION
 *   "将大型数据流以低优先级在 ws 的 RPC 隧道中传输" — can a bulk transfer share
 *   the face⇄brain RPC connection, or does it need its own socket? This file
 *   answers with latency numbers for the SAME payload under both topologies.
 *
 * WHY THE EARLIER ROUNDS COULD NOT ANSWER IT
 *   1. Samples were bucketed by ARRIVAL time, filing blocked probes under
 *      "after" and making the during-window look clean.
 *   2. The client measured its own latency while its event loop was saturated by
 *      inbound bulk frames, so it could barely issue probes (9 in 649 ms). That
 *      saturation is itself a finding, but it means a latency measured ON the
 *      bulk-receiving client is measuring the wrong thing.
 *
 * SO THIS FILE SEPARATES THE ROLES
 *   The PROBE lives in its OWN process with its OWN connection, and measures the
 *   RPC round-trip against a server that is simultaneously pushing bulk on a
 *   DIFFERENT connection. That is the real user-visible question: while a big
 *   transfer is running, is an interactive call still fast?
 *
 * THEN IT COMPARES THE TWO ANSWERS
 *   shared    probe and bulk on the SAME ws connection (the tunnel design)
 *   separate  probe and bulk on DIFFERENT ws connections (the extra-socket design)
 *
 * A separate-connection result at idle-equivalent latency is exactly what
 * "the design must use its own socket" looks like, and it costs one socket —
 * not a protocol change.
 *
 * Usage:
 *   node 03-head-of-line-server.mjs --port=46200   (background)
 *   node 04-shared-vs-separate.mjs --port=46200
 *
 * WHICH SERVER: `03-head-of-line-server.mjs`, NOT `server.mjs`.
 *   This probe measures the latency of an `{rpc:"ping"}` round trip, so the
 *   server has to ANSWER that frame. The general `server.mjs` speaks only the
 *   bulk protocol — it has no RPC counterpart — so pointing this usage line at
 *   it yields a probe that hangs instead of one that fails loudly. Verified by
 *   reading both servers' message handlers.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

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

const PORT = Number(args.port ?? 46200)
const BULK_FRAMES = Number(args.frames ?? 2048)
const BULK_SIZE = Number(args.size ?? 65536)
const PING_EVERY_MS = Number(args.pingMs ?? 5)
const runtime = typeof Bun !== "undefined" ? `bun-${Bun.version}` : `node-${process.version}`

const percentile = (sorted, p) => {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return +sorted[idx].toFixed(2)
}
const summarise = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length ? +sorted[sorted.length - 1].toFixed(2) : null,
    reliable: sorted.length >= 30,
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A dedicated connection carrying ONLY probes. */
async function openProbe(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`)
  socket.binaryType = "arraybuffer"
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve)
    socket.addEventListener("error", () => reject(new Error("probe ws error")))
  })
  const probes = []
  const sentAt = new Map()
  let seq = 0
  socket.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return
    const msg = JSON.parse(ev.data)
    if (msg.rpc !== "pong") return
    const t = sentAt.get(msg.seq)
    if (t !== undefined) {
      // Recorded with its SEND time so windows are bucketed correctly.
      probes.push({ sentAtMs: t, ms: performance.now() - t })
      sentAt.delete(msg.seq)
    }
  })
  const ping = () => {
    const t = performance.now()
    sentAt.set(seq, t)
    socket.send(JSON.stringify({ rpc: "ping", seq, t }))
    seq++
  }
  return { socket, probes, ping, close: () => socket.close() }
}

/**
 * One topology.
 *
 * `shared` puts the bulk control on the PROBE's own socket; `separate` opens a
 * second socket for it. Everything else — payload, pacing, sampling rate — is
 * identical, so the difference in latency is attributable to the topology.
 */
async function topology(name, shared) {
  const probe = await openProbe(PORT)
  const bulkSocket = shared ? probe.socket : new WebSocket(`ws://127.0.0.1:${PORT}`)

  if (!shared) {
    await new Promise((resolve, reject) => {
      bulkSocket.addEventListener("open", resolve)
      bulkSocket.addEventListener("error", () => reject(new Error("bulk ws error")))
    })
  }

  let bulkDone = false
  let bulkDoneAt = null
  if (!shared) {
    bulkSocket.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return
      const msg = JSON.parse(ev.data)
      if (msg.ctl === true && msg.done) {
        bulkDone = true
        bulkDoneAt = performance.now()
      }
    })
  }

  // Idle baseline on the probe connection.
  const timer = setInterval(probe.ping, PING_EVERY_MS)
  await sleep(500)
  const idleCount = probe.probes.length

  const bulkStartedAt = performance.now()
  const control = JSON.stringify({ ctl: true, scenario: shared ? "A" : "B", frames: BULK_FRAMES, size: BULK_SIZE })
  bulkSocket.send(control)

  if (shared) {
    // On a shared socket the server's "done" arrives on the probe connection.
    probe.socket.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return
      const msg = JSON.parse(ev.data)
      if (msg.ctl === true && msg.done) {
        bulkDone = true
        bulkDoneAt = performance.now()
      }
    })
  }

  const deadline = Date.now() + 180000
  while (!bulkDone && Date.now() < deadline) await sleep(10)
  if (bulkDoneAt === null) bulkDoneAt = performance.now()

  const afterCount = probe.probes.length
  await sleep(400) // trailing probes confirm recovery
  clearInterval(timer)

  const idle = probe.probes.slice(0, idleCount)
  const during = probe.probes.filter((p) => p.sentAtMs >= bulkStartedAt && p.sentAtMs <= bulkDoneAt)
  const after = probe.probes.slice(afterCount)

  const bulkMs = bulkDoneAt - bulkStartedAt
  probe.close()
  if (!shared) bulkSocket.close()

  return {
    topology: name,
    shared,
    runtime,
    bulkMiB: +((BULK_FRAMES * BULK_SIZE) / 1048576).toFixed(1),
    bulkMs: +bulkMs.toFixed(0),
    bulkMBps: +(((BULK_FRAMES * BULK_SIZE) / 1048576 / Math.max(1, bulkMs)) * 1000).toFixed(1),
    rpc: {
      idle: summarise(idle.map((p) => p.ms)),
      during: summarise(during.map((p) => p.ms)),
      after: summarise(after.map((p) => p.ms)),
    },
    duringSampleCount: during.length,
    /** Worst interactive wait observed while the transfer was running. */
    worstDuringMs: during.length ? +Math.max(...during.map((p) => p.ms)).toFixed(2) : null,
  }
}

const results = []
for (const [name, shared] of [
  ["shared-tunnel", true],
  ["separate-connection", false],
]) {
  process.stderr.write(`[priority] ${name} ... `)
  const r = await topology(name, shared)
  results.push(r)
  process.stderr.write(
    `bulk ${r.bulkMBps}MB/s | RPC during n=${r.duringSampleCount} ` +
      `p50=${r.rpc.during.p50} p95=${r.rpc.during.p95} max=${r.rpc.during.max} ms\n`,
  )
}

mkdirSync(join(here, "results"), { recursive: true })
writeFileSync(join(here, "results", "priority.json"), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2))

const lines = []
lines.push("=== SHARED RPC TUNNEL vs SEPARATE CONNECTION ===")
lines.push(`${BULK_FRAMES} x ${BULK_SIZE / 1024} KiB = ${((BULK_FRAMES * BULK_SIZE) / 1048576).toFixed(0)} MiB bulk; probe every ${PING_EVERY_MS} ms on its own connection`)
lines.push(`bulk client = global WebSocket (${runtime}); probe process is separate from the bulk sender`)
lines.push("")
lines.push("  topology              bulk        RPC idle p50   DURING p50 / p95 / max (n)      ratio vs idle")
for (const r of results) {
  const d = r.rpc.during
  const ratio = r.rpc.idle.p50 && d.p50 ? (d.p50 / r.rpc.idle.p50).toFixed(0) : "?"
  lines.push(
    `  ${r.topology.padEnd(20)}  ${String(r.bulkMBps).padStart(6)}MB/s  ` +
      `${String(r.rpc.idle.p50).padStart(9)}ms   ` +
      `${String(d.p50).padStart(6)} / ${String(d.p95).padStart(7)} / ${String(d.max).padStart(8)} (${String(d.n).padStart(4)})  ` +
      `${ratio}x${d.reliable ? "" : " (n<30)"}`,
  )
}
lines.push("")
for (const r of results) {
  lines.push(`  ${r.topology}:`)
  lines.push(`    bulk ${r.bulkMiB} MiB in ${r.bulkMs} ms = ${r.bulkMBps} MB/s`)
  for (const w of ["idle", "during", "after"]) {
    const s = r.rpc[w]
    lines.push(`    RPC ${w.padEnd(6)} n=${String(s.n).padStart(5)}  p50=${s.p50} p95=${s.p95} p99=${s.p99} max=${s.max} ms`)
  }
}

lines.push("")
lines.push("=== VERDICT ===")
const [sharedR, separateR] = results
const reliable = results.filter((r) => r.rpc.during.reliable)
if (reliable.length < results.length) {
  lines.push(`  only ${reliable.length}/${results.length} topologies produced >=30 in-transfer samples; treat the rest as indicative`)
}
if (sharedR && separateR) {
  const s = sharedR.rpc.during
  const p = separateR.rpc.during
  const sRatio = s.max / sharedR.rpc.idle.p50
  const pRatio = p.max / separateR.rpc.idle.p50
  lines.push(`  shared   during max : ${s.max} ms (${sRatio.toFixed(0)}x idle)`)
  lines.push(`  separate during max : ${p.max} ms (${pRatio.toFixed(0)}x idle)`)
  lines.push("")
  // A binary "blocked / not blocked" verdict discards the number that matters.
  // Both topologies DO stall here, and saying only that hides a 6x difference
  // between them — so the comparison is reported as a ratio and the residual
  // stall is attributed, since it is NOT the socket.
  if (s.max > 0 && p.max > 0) {
    lines.push(`  => SHARING is ${(s.max / p.max).toFixed(1)}x worse than a separate connection.`)
  }
  if (p.max >= 20) {
    lines.push("     NEITHER is at idle, and the residual stall on the SEPARATE path is NOT the")
    lines.push("     socket: this server pushes the bulk from ONE synchronous send loop, so it")
    lines.push("     cannot answer a ping until a slice completes. A real sender must yield in")
    lines.push("     bounded slices too, or the SERVER becomes the bottleneck no matter which")
    lines.push("     topology the client picks.")
  } else if (s.max > 20) {
    lines.push("     The separate path is at idle latency, so the stall is the shared socket itself.")
    lines.push("     Cost of fixing it: ONE extra connection, no protocol change.")
  }
  lines.push("")
  lines.push("  READ THIS BEFORE QUOTING A NUMBER: " + (reliable.length === results.length
    ? "both topologies produced >=30 in-transfer samples."
    : "at least one topology produced FEWER THAN 30 in-transfer samples, so its percentiles are indicative only — raise --frames or lower --pingMs for a quotable figure."))
}
lines.push("")

const text = lines.join("\n")
writeFileSync(join(here, "results", "priority-report.txt"), text)
console.log(text)
process.exit(0)
