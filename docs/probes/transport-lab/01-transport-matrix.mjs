/**
 * E2E LAB MATRIX — the complete, repeatable comparison report.
 *
 * Drives the long-lived `server.mjs` with `client.mjs` probes over a full
 * factorial grid and writes BOTH a JSON record and a human-readable report.
 *
 * THE AXES
 *   transport   tcp | ws | udp
 *   direction   down (server→client) | up (client→server)
 *   frames      8 | 64 | 256
 *   size        16 KiB | 64 KiB | 256 KiB | 1 MiB | 4 MiB
 *   encoding    raw | base64 | json        (ws only; tcp/udp always raw)
 *   client      ws | global                (ws only; global = what ships)
 *   repeats     3 per cell by default
 *
 * WHY REPEATS ARE PART OF THE DESIGN
 *   An earlier round concluded "1 MiB chunks are unsafe" from ONE reading, and
 *   another concluded "raw WebSocket duplicates frames" from a single
 *   self-contradictory run. Both were instrument artifacts. Every cell here runs
 *   N times and the report shows the SPREAD, so a claim like "X% loss" can only
 *   be made from a distribution rather than a single sample.
 *
 * WHAT MAKES THE NUMBERS TRUSTWORTHY
 *   · down is verified by the CLIENT, up by the SERVER — the producer never
 *     grades its own work.
 *   · Frames carry a sequence number, so duplicates, gaps and reordering are
 *     distinguished instead of collapsing into "missing".
 *   · Bytes are regenerated and compared exactly (no hash, no probabilistic
 *     check).
 *   · UDP is included as a FALSIFICATION CONTROL: it is permitted to lose
 *     datagrams, so a grid where UDP also reports zero loss would prove the
 *     detector cannot detect loss.
 *
 * Usage:
 *   node 01-transport-matrix.mjs --base-port=47000 [--repeats=3] [--quick=true]
 *
 * ⚠ EXPECTED RUNTIME, and why it is not a bug:
 *   The json-encoded cells at 1 MiB and 4 MiB DO NOT COMPLETE — that is the
 *   finding (§2 of FINDINGS.md). Each one therefore burns the client's full
 *   timeout before the orchestrator moves on. A full run is ~10 minutes and a
 *   `--quick` run still spends several, almost all of it waiting on cells whose
 *   failure IS the result. Do not "fix" it by lowering the timeout: a shorter
 *   budget would report those cells as slow rather than as broken.
 *
 *   Start the server first, from this directory:
 *     node server.mjs --base-port=47000
 */
import { spawn } from "node:child_process"
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
const REPEATS = Number(args.repeats ?? 3)
const quick = args.quick === "true"
const BASE = Number(args.basePort ?? 46000)
const PORTS = { tcp: BASE, ws: BASE + 1, udp: BASE + 2 }

const KIB = 1024
const MIB = 1024 * 1024

function runClient(clientRuntime, argv) {
  return new Promise((resolve) => {
    const child = spawn(clientRuntime, [join(here, "client.mjs"), ...argv], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => {
      stdout += d
    })
    child.stderr.on("data", (d) => {
      stderr += d
    })
    child.on("close", (code) => resolve({ code, stdout, stderr }))
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: String(err) }))
  })
}

function parseResult(stdout) {
  for (const line of stdout.split("\n")) {
    if (line.startsWith("RESULT ")) {
      try {
        return JSON.parse(line.slice("RESULT ".length))
      } catch {
        return null
      }
    }
  }
  return null
}

/** The integrity facts, from whichever side owned the verdict. */
function integrityOf(result) {
  if (!result) return null
  // For `up` the SERVER holds the verdict; for `down` the client does.
  const v = result.serverVerdict ?? result
  if (v.error) return { error: v.error }
  return {
    exact: v.exact,
    events: v.events,
    unique: v.unique,
    duplicates: v.duplicates,
    missing: v.missing,
    reordered: v.reordered,
    corrupt: v.corrupt,
    bytes: v.bytes,
    firstIssue: v.firstIssue ?? null,
  }
}

const cells = []

async function cell({ transport, direction, frames, size, encoding, client, runtime = "node" }) {
  const argv = [
    `--transport=${transport}`,
    `--port=${PORTS[transport]}`,
    `--direction=${direction}`,
    `--frames=${frames}`,
    `--size=${size}`,
  ]
  if (transport === "ws") {
    argv.push(`--encoding=${encoding}`, `--client=${client}`)
  }
  const label =
    `${transport}/${direction} ${frames}x${size / KIB}KiB` +
    (transport === "ws" ? ` ${encoding}/${client}` : "")

  const runs = []
  for (let i = 0; i < REPEATS; i++) {
    process.stderr.write(`[matrix] ${label} run ${i + 1}/${REPEATS} ... `)
    const started = Date.now()
    const res = await runClient(runtime === "bun" ? process.env.E2E_BUN : process.execPath, argv)
    const parsed = parseResult(res.stdout)
    const integrity = integrityOf(parsed)
    const seconds = +((Date.now() - started) / 1000).toFixed(2)
    const row = {
      integrity,
      elapsedMs: parsed?.elapsedMs ?? null,
      mbps: parsed?.mbps ?? null,
      oversizeDatagrams: parsed?.oversizeDatagrams ?? 0,
      // A cell that produced no RESULT line is NOT a pass: it is missing evidence.
      noResult: parsed === null,
      stderr: parsed === null ? res.stderr.slice(-200) : undefined,
      seconds,
    }
    runs.push(row)
    process.stderr.write(
      parsed === null
        ? `NO RESULT (exit ${res.code})\n`
        : `exact=${integrity?.exact} unique=${integrity?.unique}/${frames} dup=${integrity?.duplicates} ` +
            `missing=${integrity?.missing} corrupt=${integrity?.corrupt} ${parsed.mbps}MB/s ${seconds}s\n`,
    )
  }

  const exactCount = runs.filter((r) => r.integrity?.exact === true).length
  const noResult = runs.filter((r) => r.noResult).length
  const mbpsValues = runs.map((r) => r.mbps).filter((v) => typeof v === "number")
  cells.push({
    label,
    transport,
    direction,
    frames,
    size,
    encoding: transport === "ws" ? encoding : "raw",
    client: transport === "ws" ? client : "-",
    bytesPerRun: frames * size,
    repeats: REPEATS,
    exactRuns: exactCount,
    noResultRuns: noResult,
    /** The headline: did EVERY repeat transfer byte-exact? */
    allExact: exactCount === REPEATS,
    anyLoss: runs.some((r) => r.integrity && r.integrity.exact === false),
    mbps: mbpsValues.length ? +(mbpsValues.reduce((a, b) => a + b, 0) / mbpsValues.length).toFixed(1) : null,
    mbpsSpread: mbpsValues.length > 1 ? +(Math.max(...mbpsValues) - Math.min(...mbpsValues)).toFixed(1) : 0,
    runs,
  })
}

// ── the grid ─────────────────────────────────────────────────────────────
const SIZES = quick ? [64 * KIB, MIB] : [16 * KIB, 64 * KIB, 256 * KIB, MIB, 4 * MIB]
const FRAME_COUNTS = quick ? [64] : [8, 64, 256]

// Phase 1 — encoding comparison: the same payload carried three ways.
// This is the axis that decides whether base64 is necessary (it is not) and how
// expensive kkrpc's built-in transport is (measured, not asserted).
for (const encoding of ["raw", "base64", "json"]) {
  for (const size of SIZES) {
    await cell({ transport: "ws", direction: "down", frames: 64, size, encoding, client: "ws" })
  }
}

// Phase 2 — client implementation: `ws` package vs the runtime's global
// WebSocket, which is what kkrpc's transport and therefore src/host.ts use.
for (const client of ["ws", "global"]) {
  for (const size of SIZES) {
    await cell({ transport: "ws", direction: "down", frames: 64, size, encoding: "raw", client })
  }
}

// Phase 3 — transport comparison on the SAME payload, both directions.
for (const transport of ["tcp", "ws", "udp"]) {
  for (const direction of ["down", "up"]) {
    for (const size of SIZES) {
      if (transport === "udp" && size > 60 * KIB) continue // datagram ceiling; measured separately
      await cell({ transport, direction, frames: 64, size, encoding: "raw", client: "ws" })
    }
  }
}

// Phase 4 — volume scaling at a safe frame size.
for (const frames of FRAME_COUNTS) {
  for (const transport of ["tcp", "ws"]) {
    await cell({ transport, direction: "down", frames, size: 64 * KIB, encoding: "raw", client: "ws" })
  }
}

// Phase 5 — the UDP datagram ceiling, stated explicitly rather than implied.
for (const size of [16 * KIB, 60 * KIB, 64 * KIB]) {
  await cell({ transport: "udp", direction: "up", frames: 8, size, encoding: "raw", client: "ws" })
}

// ── report ───────────────────────────────────────────────────────────────
mkdirSync(join(here, "results"), { recursive: true })
const report = {
  generatedAt: new Date().toISOString(),
  repeats: REPEATS,
  serverRuntime: "node",
  clientRuntime: "node",
  cells,
}
writeFileSync(join(here, "results", "matrix.json"), JSON.stringify(report, null, 2))

const lines = []
lines.push("=== E2E LAB MATRIX ===")
lines.push(`repeats per cell: ${REPEATS}   generated: ${report.generatedAt}`)
lines.push("")
lines.push(
  "  cell                                        exact  throughput    spread   note",
)
for (const c of cells) {
  const note = c.noResultRuns > 0 ? `${c.noResultRuns} NO-RESULT` : c.allExact ? "" : "LOSS"
  lines.push(
    `  ${c.label.padEnd(42)} ${String(`${c.exactRuns}/${c.repeats}`).padStart(5)}  ` +
      `${String(c.mbps ?? "-").padStart(8)}MB/s  ${String(c.mbpsSpread).padStart(6)}  ${note}`,
  )
}

lines.push("")
lines.push("=== HEADLINE COMPARISONS ===")

const find = (t, d, s, enc, cl) =>
  cells.find(
    (c) =>
      c.transport === t &&
      c.direction === d &&
      c.size === s &&
      (enc === undefined || c.encoding === enc) &&
      (cl === undefined || c.client === cl),
  )

const rawCell = find("ws", "down", 64 * KIB, "raw", "ws")
const b64Cell = find("ws", "down", 64 * KIB, "base64", "ws")
const jsonCell = find("ws", "down", 64 * KIB, "json", "ws")
lines.push("")
lines.push("  ENCODING (64 KiB frames, 64 frames, ws/ws, down)")
for (const [name, c] of [
  ["raw binary WS frame", rawCell],
  ["base64 text frame", b64Cell],
  ["json numeric-keyed (kkrpc built-in)", jsonCell],
]) {
  if (c) lines.push(`    ${name.padEnd(38)} ${String(c.mbps).padStart(7)} MB/s   exact ${c.exactRuns}/${c.repeats}`)
}
if (rawCell?.mbps && jsonCell?.mbps) {
  lines.push(`    => the built-in encoding is ${(rawCell.mbps / jsonCell.mbps).toFixed(1)}x SLOWER than raw binary`)
}

lines.push("")
lines.push("  TRANSPORT (64 KiB frames, 64 frames, down)")
for (const t of ["tcp", "ws", "udp"]) {
  const c = find(t, "down", 64 * KIB, "raw", "ws")
  if (c) lines.push(`    ${t.padEnd(5)} ${String(c.mbps).padStart(7)} MB/s   exact ${c.exactRuns}/${c.repeats}`)
}

lines.push("")
lines.push("  DIRECTION (ws raw, 64 KiB x 64)")
for (const d of ["down", "up"]) {
  const c = find("ws", d, 64 * KIB, "raw", "ws")
  if (c) lines.push(`    ${d.padEnd(5)} ${String(c.mbps).padStart(7)} MB/s   exact ${c.exactRuns}/${c.repeats}`)
}

lines.push("")
lines.push("  CLIENT IMPLEMENTATION (ws raw, down)")
for (const cl of ["ws", "global"]) {
  const c = find("ws", "down", 64 * KIB, "raw", cl)
  if (c) lines.push(`    ${cl.padEnd(8)} exact ${c.exactRuns}/${c.repeats}   ${c.mbps} MB/s`)
}

lines.push("")
lines.push("=== VERDICT ===")
const missingEvidence = cells.filter((c) => c.noResultRuns === c.repeats)
const anyCellNotExact = cells.filter((c) => !c.allExact)
const udpCells = cells.filter((c) => c.transport === "udp")
const tcpWsCells = cells.filter((c) => c.transport !== "udp")

if (missingEvidence.length > 0) {
  lines.push(`  *** ${missingEvidence.length} CELL(S) PRODUCED NO RESULT AT ALL — NO VERDICT POSSIBLE ***`)
  for (const c of missingEvidence) lines.push(`      ${c.label}`)
} else {
  lines.push(`  cells measured                     : ${cells.length}`)
  lines.push(`  TCP/WS cells byte-exact every run  : ${tcpWsCells.filter((c) => c.allExact).length}/${tcpWsCells.length}`)
  lines.push(
    `  TCP/WS cells with ANY loss         : ${tcpWsCells.filter((c) => c.anyLoss).length}` +
      (tcpWsCells.filter((c) => c.anyLoss).length
        ? ` (${tcpWsCells.filter((c) => c.anyLoss).map((c) => c.label).join("; ")})`
        : ""),
  )
  lines.push(`  UDP cells with loss (expected)     : ${udpCells.filter((c) => c.anyLoss).length}/${udpCells.length}`)
  lines.push("")
  if (udpCells.every((c) => c.allExact) && udpCells.length > 0) {
    lines.push("  *** WARNING: UDP reported NO loss. UDP may legitimately drop datagrams, so a")
    lines.push("  *** detector that never sees loss is not detecting anything. Treat every")
    lines.push("  *** 'exact' above as unproven until this is explained. ***")
  } else {
    lines.push("  The UDP cells DO show loss, so the detector demonstrably reports loss when it")
    lines.push("  occurs; the exact TCP/WS cells are therefore meaningful rather than vacuous.")
  }
  if (anyCellNotExact.filter((c) => c.transport !== "udp").length > 0) {
    lines.push("")
    lines.push("  Cells with loss outside UDP:")
    for (const c of anyCellNotExact.filter((c) => c.transport !== "udp")) lines.push(`      ${c.label}`)
  }
}
lines.push("")

const text = lines.join("\n")
writeFileSync(join(here, "results", "matrix-report.txt"), text)
console.log(text)

const failing = missingEvidence.length > 0
process.exit(failing ? 2 : 0)
