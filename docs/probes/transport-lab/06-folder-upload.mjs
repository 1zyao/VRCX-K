/**
 * FOLDER UPLOAD: many small files one-by-one, vs one packed blob.
 *
 * THE DESIGN QUESTION
 *   "给手加个上传文件夹的能力……直接给手加个打包技能还是一个个解析请求丢池子里"
 *
 *   Both approaches move the same bytes; they differ in PER-FILE OVERHEAD. For a
 *   folder of a few large files that overhead is noise. For a folder of ten
 *   thousand small files it is the whole cost — every file needs its own request,
 *   its own terminator, its own round trip, and its own bookkeeping.
 *
 * WHAT IS COMPARED, on one connection, byte-exactness verified in every case
 *   A  N small files, one transfer request each   (the "one by one" design)
 *   B  one packed blob of the same total size     (the "packing skill" design)
 *
 *   Total payload is identical in A and B, so any difference is overhead.
 *
 * WHAT WOULD DECIDE IT
 *   · A within ~1.5x of B  => per-file overhead is negligible; skip packing
 *                             entirely, since it avoids a zip/tar dependency,
 *                             keeps progress per-file, and allows resume of a
 *                             single file.
 *   · A far slower than B  => packing earns its keep for many-small-file folders,
 *                             and the "packing skill" is justified.
 *
 *   The per-file cost is also measured directly (files/second), because that
 *   number is what predicts behaviour for a folder of 10k files.
 *
 * Usage: node|bun 06-folder-upload.mjs [--files=1000] [--fileBytes=4096] [--port=46600] [--rttMs=5]
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

const PORT = Number(args.port ?? 46600)
const FILE_COUNT = Number(args.files ?? 1000)
const FILE_BYTES = Number(args.fileBytes ?? 4096)
const CHUNK = 64 * 1024
/**
 * Artificial server-side delay per REQUEST, standing in for network RTT.
 *
 * This is the decisive variable and loopback hides it: on loopback a request
 * costs ~0.1 ms, so 2000 files finish in 201 ms and the per-file cost looks
 * tolerable. On a real link every file costs a full round trip, so the same
 * folder takes (fileCount x RTT). Injecting a delay makes that visible instead
 * of leaving it to arithmetic.
 */
const SERVER_DELAY = Number(args.rttMs ?? 0)
const runtime = typeof Bun !== "undefined" ? `bun-${Bun.version}` : `node-${process.version}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Small-file frames: one frame per file, sized to that file. */
const smallFrames = []
for (let i = 0; i < FILE_COUNT; i++) smallFrames.push(makeFrame(i, FILE_BYTES))

/** The packed equivalent: the same bytes in ONE logical blob. */
const PACKED_FRAMES = Math.max(1, Math.ceil((FILE_COUNT * FILE_BYTES) / CHUNK))
const packedFrames = []
for (let i = 0; i < PACKED_FRAMES; i++) packedFrames.push(makeFrame(i, CHUNK))

const TOTAL_BYTES = FILE_COUNT * FILE_BYTES

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT, maxPayload: 1 << 30, perMessageDeflate: false })
await new Promise((r) => wss.once("listening", r))

/**
 * The server answers one request per FILE in mode "small", and one request in
 * mode "packed". No tags are needed: in "small" the client issues requests
 * sequentially and each reply ends with its own terminator.
 */
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
      // Every request pays one simulated round trip. In "packed" mode that is
      // paid ONCE for the whole folder; in "small" mode once PER FILE — which is
      // the entire difference between the two designs on a real link.
      if (SERVER_DELAY > 0) await sleep(SERVER_DELAY)
      if (msg.mode === "small") {
        // One file per request: the per-file overhead under test.
        const frames = smallFrames[msg.fileIndex] ? [smallFrames[msg.fileIndex]] : []
        for (const frame of frames) {
          if (socket.readyState !== 1) return
          socket.send(frame, { binary: true })
        }
        socket.send(JSON.stringify({ ctl: true, fileIndex: msg.fileIndex, fileDone: true }), { binary: false })
        return
      }
      for (const frame of packedFrames) {
        if (socket.readyState !== 1) return
        socket.send(frame, { binary: true })
      }
      socket.send(JSON.stringify({ ctl: true, done: true }), { binary: false })
    })()
  })
  socket.on("error", () => {})
})

/** Verify a single frame against its payload size; returns a failure string or null. */
function check(frame, seq, size) {
  return verifyFrame(frame, seq, size)
}

/** Mode A: FILE_COUNT sequential requests, one per file. */
async function modeSmall() {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}`)
  socket.binaryType = "arraybuffer"
  await new Promise((res, rej) => {
    socket.addEventListener("open", res)
    socket.addEventListener("error", () => rej(new Error("ws error")))
  })

  let verified = 0
  let corrupt = 0
  let firstIssue = null
  let fileDoneResolve = null
  let fileDone = new Promise((r) => (fileDoneResolve = r))

  socket.addEventListener("message", (ev) => {
    const d = ev.data
    if (typeof d === "string") {
      const msg = JSON.parse(d)
      if (msg.fileDone) {
        fileDoneResolve?.()
        fileDoneResolve = null
      }
      return
    }
    const frame = new Uint8Array(d)
    const seq = readSeq(frame)
    const diff = check(frame, seq, FILE_BYTES)
    if (diff !== null) {
      corrupt++
      if (firstIssue === null) firstIssue = `file ${seq}: ${diff}`
    }
    verified++
  })

  const t0 = performance.now()
  for (let i = 0; i < FILE_COUNT; i++) {
    fileDone = new Promise((r) => (fileDoneResolve = r))
    socket.send(JSON.stringify({ ctl: true, mode: "small", fileIndex: i }))
    // Wait for THIS file's terminator before asking for the next: the
    // sequential design, which is what "one by one" means.
    await Promise.race([fileDone, sleep(5000)])
  }
  const wallMs = performance.now() - t0
  socket.close()
  return {
    mode: "small",
    requests: FILE_COUNT,
    filesVerified: verified,
    corrupt,
    firstIssue,
    wallMs: +wallMs.toFixed(0),
    mbps: +((TOTAL_BYTES / 1048576 / Math.max(1, wallMs)) * 1000).toFixed(1),
    filesPerSecond: Math.round((FILE_COUNT / Math.max(1, wallMs)) * 1000),
    exact: verified === FILE_COUNT && corrupt === 0,
  }
}

/** Mode B: one request, one packed blob. */
async function modePacked() {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}`)
  socket.binaryType = "arraybuffer"
  await new Promise((res, rej) => {
    socket.addEventListener("open", res)
    socket.addEventListener("error", () => rej(new Error("ws error")))
  })

  let verified = 0
  let bytes = 0
  let corrupt = 0
  let firstIssue = null
  let done = false

  socket.addEventListener("message", (ev) => {
    const d = ev.data
    if (typeof d === "string") {
      const msg = JSON.parse(d)
      if (msg.done) done = true
      return
    }
    const frame = new Uint8Array(d)
    const seq = readSeq(frame)
    const diff = check(frame, seq, CHUNK)
    if (diff !== null) {
      corrupt++
      if (firstIssue === null) firstIssue = `frame ${seq}: ${diff}`
    }
    verified++
    bytes += frame.length
  })

  const t0 = performance.now()
  socket.send(JSON.stringify({ ctl: true, mode: "packed" }))
  const deadline = Date.now() + 60000
  while (!done && Date.now() < deadline) await sleep(5)
  const wallMs = performance.now() - t0
  socket.close()
  return {
    mode: "packed",
    requests: 1,
    framesVerified: verified,
    framesExpected: PACKED_FRAMES,
    corrupt,
    firstIssue,
    wallMs: +wallMs.toFixed(0),
    mbps: +((TOTAL_BYTES / 1048576 / Math.max(1, wallMs)) * 1000).toFixed(1),
    filesPerSecond: null,
    exact: done && verified === PACKED_FRAMES && corrupt === 0,
  }
}

const small = await modeSmall()
const packed = await modePacked()

mkdirSync(join(here, "results"), { recursive: true })
writeFileSync(
  join(here, "results", "folder.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), fileCount: FILE_COUNT, fileBytes: FILE_BYTES, small, packed }, null, 2),
)

const lines = []
lines.push("=== FOLDER UPLOAD: one request per file vs one packed blob ===")
lines.push(`${FILE_COUNT} files x ${FILE_BYTES} B = ${(TOTAL_BYTES / 1048576).toFixed(2)} MiB total; client = global WebSocket (${runtime})`)
lines.push("")
lines.push("  mode     requests   payload verified        wall      throughput   files/s   exact")
lines.push(
  `  small    ${String(small.requests).padStart(8)}   ${String(`${small.filesVerified}/${FILE_COUNT} files`).padEnd(20)}  ` +
    `${String(small.wallMs).padStart(6)}ms  ${String(small.mbps).padStart(8)}MB/s  ` +
    `${String(small.filesPerSecond).padStart(7)}   ${small.exact}`,
)
lines.push(
  `  packed   ${String(packed.requests).padStart(8)}   ${String(`${packed.framesVerified}/${PACKED_FRAMES} frames`).padEnd(20)}  ` +
    `${String(packed.wallMs).padStart(6)}ms  ${String(packed.mbps).padStart(8)}MB/s  ` +
    `${String("-").padStart(7)}   ${packed.exact}`,
)

lines.push("")
lines.push("=== VERDICT ===")
if (!small.exact || !packed.exact) {
  lines.push("  *** one or both modes failed integrity; see the JSON for the first issue. ***")
  if (small.firstIssue) lines.push(`      small : ${small.firstIssue}`)
  if (packed.firstIssue) lines.push(`      packed: ${packed.firstIssue}`)
} else {
  const ratio = small.wallMs / Math.max(1, packed.wallMs)
  lines.push(`  per-file overhead measured directly: ${small.filesPerSecond} files/s`)
  lines.push(`  packed is ${ratio.toFixed(2)}x the speed of one-request-per-file`)
  lines.push("")
  // Extrapolate to a large folder, because that is the real scenario.
  const tenK = Math.round((10000 / Math.max(1, small.filesPerSecond)) * 1000)
  lines.push(`  extrapolated: 10,000 files of this size would take ~${(tenK / 1000).toFixed(1)}s one-by-one`)
  lines.push("")
  if (ratio > 2) {
    lines.push("  => per-file overhead DOMINATES. Packing (or at least batching several files per")
    lines.push("     request) is justified for folders with many small files.")
  } else {
    lines.push("  => per-file overhead is SMALL relative to the transfer itself. Packing buys little")
    lines.push("     here, and it costs a zip/tar dependency plus per-file progress and resume.")
    lines.push("     Prefer one-request-per-file, and revisit only if real folders are dominated by")
    lines.push("     tiny files.")
  }
}
lines.push("")

const text = lines.join("\n")
writeFileSync(join(here, "results", "folder-report.txt"), text)
console.log(text)
wss.close()
process.exit(0)
