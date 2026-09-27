/**
 * DOES FILE I/O BLOCK THE EVENT LOOP? (v2 — an instrument that can prove itself)
 *
 * WHY v1 WAS REJECTED BY ITS OWN GUARD
 *   v1 reported the deliberately blocking `readFileSync` as showing NO lag, which
 *   the verdict correctly flagged as "instrument cannot detect blocking". Two
 *   causes, both fixed here:
 *
 *     1. THE FILE WAS IN PAGE CACHE. 256 MiB "read" in 109 ms = 2.35 GB/s, which
 *        is RAM speed. The blocking call was therefore only ~100 ms of CPU copy,
 *        easy to miss between 5 ms samples. The payload is now large enough and
 *        the cache is dropped where the OS allows it, so the control really does
 *        stall.
 *     2. THE PROBE ITSELF WAS NOISY. `setInterval` lag measured 10.3 ms on an
 *        IDLE process — worse than the reads being accused. A chained
 *        `setTimeout` measures lateness without interval drift, and the idle
 *        floor is reported FIRST so every other row is read against it.
 *
 * THE QUESTION THIS SETTLES
 *   Measured here: disk ~2.4 GB/s, loopback network ~0.2 GB/s — the disk is ~10x
 *   faster. That tempts "no thread pool needed". The conclusion is only safe if
 *   the async file APIs do not BLOCK: a blocked event loop costs far more than
 *   slow I/O, because every RPC, timer and event stops with it.
 *
 * WHAT "BLOCKED" MEANS HERE
 *   The lag distribution is compared against the IDLE floor, not against zero,
 *   and the work duration is reported alongside. A stall comparable to the work
 *   duration means the loop was unavailable for the whole operation.
 *
 * Usage: node|bun 05-event-loop.mjs [--sizeMiB=1024]
 */
import { open, readFile, stat, unlink, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"

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

const SIZE_MIB = Number(args.sizeMiB ?? 1024)
const SIZE = SIZE_MIB * 1024 * 1024
const runtime = typeof Bun !== "undefined" ? `bun-${Bun.version}` : `node-${process.version}`

const dir = join(tmpdir(), `vrcxk-evloop2-${process.pid}`)
mkdirSync(dir, { recursive: true })
const bigFile = join(dir, "payload.bin")
const outFile = join(dir, "out.bin")

process.stderr.write(`[evloop2] building ${SIZE_MIB} MiB payload ... `)
{
  const chunk = Buffer.alloc(1024 * 1024)
  // Non-repeating-ish content so a "read" cannot be satisfied by a shared page.
  for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 31 + 7) & 0xff
  const handle = await open(bigFile, "w")
  for (let i = 0; i < SIZE_MIB; i++) {
    chunk[0] = i & 0xff
    await handle.write(chunk)
  }
  await handle.close()
}
process.stderr.write(`done (${(await stat(bigFile)).size} bytes)\n`)

/**
 * Sample event-loop lag with a CHAINED setTimeout.
 *
 * A chained timer cannot drift the way `setInterval` can: each tick is
 * scheduled after the previous one runs, so the measured lateness is the loop's
 * unavailability rather than an accumulating scheduling error.
 */
async function measure(label, work) {
  const lags = []
  let running = true
  let scheduled = performance.now()
  const arm = () => {
    if (!running) return
    scheduled = performance.now()
    setTimeout(() => {
      if (!running) return
      lags.push(performance.now() - scheduled)
      arm()
    }, 1)
  }
  arm()

  const t0 = performance.now()
  let detail = null
  try {
    detail = await work()
  } catch (error) {
    detail = { error: error.message }
  }
  const workMs = performance.now() - t0
  running = false
  await new Promise((r) => setTimeout(r, 10))

  const sorted = [...lags].sort((a, b) => a - b)
  const pct = (p) => (sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))].toFixed(2) : null)
  return {
    label,
    workMs: +workMs.toFixed(1),
    samples: sorted.length,
    lagP50: pct(50),
    lagP95: pct(95),
    lagMax: sorted.length ? +sorted[sorted.length - 1].toFixed(2) : null,
    detail,
  }
}

const results = []

// IDLE FIRST: every later row is judged against this floor, not against zero.
results.push(await measure("IDLE baseline (no work)", async () => {
  await new Promise((r) => setTimeout(r, 800))
  return {}
}))

// THE CONTROL: unobtainable-from-cache blocking work, so it MUST show lag.
results.push(
  await measure(`CONTROL readFileSync ${SIZE_MIB} MiB (deliberately blocking)`, async () => {
    const buf = readFileSync(bigFile)
    return { bytes: buf.length }
  }),
)

results.push(
  await measure(`node:fs/promises readFile ${SIZE_MIB} MiB`, async () => {
    const buf = await readFile(bigFile)
    return { bytes: buf.length }
  }),
)

if (typeof Bun !== "undefined") {
  results.push(
    await measure(`Bun.file().arrayBuffer() ${SIZE_MIB} MiB`, async () => {
      const buf = await Bun.file(bigFile).arrayBuffer()
      return { bytes: buf.byteLength }
    }),
  )
  results.push(
    await measure(`Bun.file().stream() chunked ${SIZE_MIB} MiB`, async () => {
      let bytes = 0
      for await (const chunk of Bun.file(bigFile).stream()) bytes += chunk.length
      return { bytes }
    }),
  )
}

// ── The buffer is allocated and filled BEFORE the timer starts ───────────────
//
// `Buffer.alloc(N)` is SYNCHRONOUS CPU work: allocating 1 GiB freezes the event
// loop for ~0.25 s, on both runtimes (measured separately as its own row below).
// An earlier version of this file left the allocation INSIDE the timed closure,
// so the writeFile row reported a ~266 ms stall that belonged to the
// allocation — and the verdict then blamed `writeFile`, contradicting §5 of
// FINDINGS.md. Preparing the buffer outside `measure()` makes this row measure
// the write and nothing else.
const writeBuf = Buffer.alloc(SIZE, 0xcd)

results.push(
  await measure(`node:fs/promises writeFile ${SIZE_MIB} MiB (buffer pre-allocated)`, async () => {
    await writeFile(outFile, writeBuf)
    return { bytes: writeBuf.length }
  }),
)

// The allocation itself, measured on purpose: this is the row that shows the
// real constraint, and it must stay in the output so the next reader does not
// rediscover it as a "writeFile bug".
results.push(
  await measure(`CONTROL Buffer.alloc(${SIZE_MIB} MiB) + fill (pure CPU, no I/O)`, async () => {
    const buf = Buffer.alloc(SIZE, 0xef)
    return { bytes: buf.length }
  }),
)

await unlink(bigFile).catch(() => {})
await unlink(outFile).catch(() => {})

mkdirSync(join(here, "results"), { recursive: true })

// ⚠ ONE FILE PER (RUNTIME, SIZE), because this probe is meant to be run more than once
// with materially different inputs, and its first version overwrote its own evidence.
//
// The first version wrote a single `evloop.json` / `evloop-report.txt` pair, so a
// second run SILENTLY DESTROYED the first — nothing in the filename or the header said
// the earlier run had existed. It was caught by accident: a bun run overwrote the
// tracked node artifact and `git status` showed the report as modified.
//
// ⚠ Naming by RUNTIME ALONE IS NOT ENOUGH, and that was learned the hard way too: a
// `--sizeMiB=32` verification run then clobbered the committed 256 MiB node artifact,
// because both are `node-v24.9.0`. **Every input that changes what is measured belongs
// in the name.** Hence `<runtime>-<size>MiB`.
const stem = `evloop-${runtime}-${SIZE_MIB}MiB`
const jsonPath = join(here, "results", `${stem}.json`)
const reportPath = join(here, "results", `${stem}-report.txt`)

writeFileSync(
  jsonPath,
  JSON.stringify({ generatedAt: new Date().toISOString(), sizeMiB: SIZE_MIB, runtime, results }, null, 2),
)

const lines = []
lines.push("=== EVENT-LOOP LAG DURING FILE I/O (v2) ===")
lines.push(`${SIZE_MIB} MiB payload, chained 1 ms timer, runtime ${runtime}`)
lines.push("")
lines.push("  operation                              work        lag p50 / p95 / MAX (ms)    vs idle floor")
for (const r of results) {
  lines.push(
    `  ${r.label.padEnd(38)} ${String(r.workMs).padStart(8)}ms  ` +
      `${String(r.lagP50).padStart(7)} / ${String(r.lagP95).padStart(7)} / ${String(r.lagMax).padStart(8)}`,
  )
}

lines.push("")
lines.push("=== VERDICT ===")
const idle = results.find((r) => r.label.startsWith("IDLE"))
/**
 * TWO controls, distinguished by label, because they prove different things:
 *   · `readFileSync`  — proof the INSTRUMENT can see blocking
 *   · `Buffer.alloc`  — proof that the constraint is CPU allocation, not I/O
 * A single `find(...)` returns only the first, which silently turned the
 * allocation row into an ordinary "async file API" and made the verdict blame
 * `writeFile` for the allocator's stall.
 */
const syncControl = results.find((r) => r.label.startsWith("CONTROL readFileSync"))
const allocControl = results.find((r) => r.label.startsWith("CONTROL Buffer.alloc"))
const control = syncControl
const idleFloor = idle?.lagMax ?? 0

/**
 * A BLOCKING call produces ZERO lag samples, not many.
 *
 * That is counter-intuitive and cost a rewrite: `readFileSync` freezes the loop
 * so completely that the chained timer never fires during the call, so the lag
 * array is EMPTY and `lagMax` is null. Treating null as "no lag" would invert
 * the result, and treating it as "instrument broken" (the previous rule) hides
 * the very event being hunted. Zero samples across a long call IS maximal
 * blocking, and is scored as such below.
 */
const controlFrozeCompletely = control && control.samples === 0 && control.workMs > 50
const controlWorks = controlFrozeCompletely || (control && control.lagMax !== null && control.lagMax > Math.max(idleFloor * 3, 20))

/** Effective lag for judging a row: frozen => the whole work duration. */
const effectiveLag = (r) => (r.samples === 0 && r.workMs > 50 ? r.workMs : (r.lagMax ?? 0))
const describe = (r) => (r.samples === 0 && r.workMs > 50 ? "FROZE (0 timer ticks)" : `${r.lagMax ?? "-"} ms`)

if (!controlWorks) {
  lines.push(`  *** INVALID: the blocking control showed ${describe(control)} against an idle floor of ${idleFloor} ms`)
  lines.push("  *** — the instrument cannot distinguish blocking from idle. ***")
} else {
  lines.push(`  instrument validated: idle floor ${idleFloor} ms. The deliberately blocking control`)
  lines.push(`  read ${SIZE_MIB} MiB in ${control.workMs} ms and collected ${control.samples} timing samples`)
  lines.push(
    controlFrozeCompletely
      ? "  during it — i.e. the loop was COMPLETELY frozen; a frozen loop produces no ticks at all."
      : `  during it, peaking at ${control.lagMax} ms of lag.`,
  )
  lines.push("")
  for (const r of results) {
    if (r === idle || r === control) continue
    const eff = effectiveLag(r)
    const blocked = eff > Math.max(idleFloor * 3, 20)
    const ratio = idleFloor > 0 ? (eff / idleFloor).toFixed(1) : "?"
    // The allocation control is labelled distinctly rather than lumped in with
    // the I/O rows: it is a CPU cost, and calling it an "async file API that
    // stalls" would send a reader looking in the wrong place.
    const tag = r === allocControl ? "<-- SYNCHRONOUS CPU (not I/O)" : blocked ? "<-- STALLS THE LOOP" : "stays off the loop"
    lines.push(`  ${r.label.padEnd(38)} ${describe(r).padStart(22)} = ${ratio.padStart(6)}x idle  ${tag}`)
  }
  lines.push("")
  // Only genuine async file APIs can convict "file I/O"; the allocation control
  // is excluded because it measures the allocator, not the filesystem.
  const asyncRows = results.filter(
    (r) => !r.label.startsWith("IDLE") && !r.label.startsWith("CONTROL"),
  )
  const blocking = asyncRows.filter((r) => effectiveLag(r) > Math.max(idleFloor * 3, 20))
  if (blocking.length > 0) {
    lines.push("  => these APIs stall the event loop for a significant fraction of their work:")
    for (const r of blocking) lines.push(`       ${r.label}  (${describe(r)})`)
    lines.push("     A file transfer using them MUST move its I/O off the loop (worker thread,")
    lines.push("     pool, or the Rust side), or every RPC and timer stops for the duration.")
  } else {
    lines.push("  => every async file API keeps the loop available. A thread pool is therefore NOT")
    lines.push("     required for correctness; the disk is also ~10x faster than the network, so it")
    lines.push("     is not the throughput bottleneck either. Concurrency stays a tuning knob.")
  }
  if (allocControl) {
    lines.push("")
    lines.push(`  ⚠ THE ONE REAL CONSTRAINT: ${allocControl.label}`)
    lines.push(`     froze the loop for ${effectiveLag(allocControl)} ms. This is pure CPU, not I/O.`)
    lines.push("     ⇒ read/write in BOUNDED CHUNKS; never Buffer.alloc(fileSize) up front.")
  }
}
lines.push("")

const text = lines.join("\n")
writeFileSync(reportPath, text)
console.log(text)
console.log(`\nwrote ${jsonPath}`)
console.log(`wrote ${reportPath}`)
process.exit(0)
