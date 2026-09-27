// Drive the app's debug self-probe over `adb forward` — the Android counterpart to
// `hands-e2e/run.mjs`.
//
// ⚠ READ `docs/android-debuggable-probe-design.md` §7 BEFORE TRUSTING A GREEN HERE.
// This proves the app's own `hands.*` primitives work on a real device under the app's
// own uid and its own data directories. It does NOT prove anything about the SAF
// `content://` bridge — which, as the design doc records, **does not exist in this
// codebase at all** (`hands.*` takes paths; `content://` lives only in the dialog
// picker). Do not read success here as "Android support is verified".
//
// WHY A CONNECT TRANSPORT RATHER THAN spawn(): on a device the peer is not a child of
// this process — it is the APP, already running, listening on an abstract unix socket
// that `adb forward` bridges to a local TCP port. `hands-e2e/run.mjs` drives a spawned
// child over stdio; this drives a forwarded socket. Everything downstream of the
// transport is deliberately identical, because the point is to exercise the same
// production modules.
//
// USAGE
//   1. Build the debuggable APK and install it (CI's mobile job does this by default).
//   2. Launch the app once, so `.setup()` runs and the probe binds.
//   3. node docs/probes/debug-probe/run-android.mjs
//
// ⚠ The app must have been launched AT LEAST ONCE. The probe starts from `.setup()`,
// which tauri runs after the windows are built — an app that was never started has no
// socket to forward to, and this script will say so rather than hang.

import { execFileSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createConnection } from "node:net"
import { StreamingRPCChannel } from "kkrpc/streaming"

/** The socket-name prefix and token filename, mirrored from `debug_probe::policy`. */
const SOCKET_PREFIX = "vrcxk-debug-probe"
const TOKEN_FILE = `${SOCKET_PREFIX}.token`

/** The app's own external files dir — where the probe publishes its token. */
const APP_EXTERNAL_DIR = "/sdcard/Android/data/com.vrcxk.app/files"

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`   ${pass ? "PASS" : "FAIL"}  ${name}${detail && !pass ? ` — ${detail}` : ""}`)
}

const adb = (...args) => execFileSync("adb", args, { encoding: "utf8" }).trim()

/**
 * Find the running app's probe socket.
 *
 * ⚠ The socket name carries the PID, and the PID is not knowable in advance: the app
 * is launched by the OS. So the name is DISCOVERED from the device's own socket table
 * rather than guessed — a guessed name would fail with a connection error that looks
 * exactly like "the feature is broken".
 */
function findProbeSocket() {
  const table = adb("shell", "cat", "/proc/net/unix")
  const match = table
    .split("\n")
    .map((line) => line.trim().split(/\s+/).pop())
    .find((name) => name?.startsWith(`@${SOCKET_PREFIX}:`))
  return match?.slice(1) ?? null // drop the leading '@'
}

/** Read the token the probe published. Same discovery argument as above. */
function readToken() {
  return adb("shell", "cat", `${APP_EXTERNAL_DIR}/${TOKEN_FILE}`)
}

/**
 * A kkrpc transport over an already-connected socket.
 *
 * Deliberately the same shape as `hands-e2e/run.mjs`'s `childTransport`: newline-framed
 * JSON, same capabilities. Downstream code cannot tell the two apart, which is what
 * makes the two probes comparable.
 */
function socketTransport(socket) {
  const listeners = new Set()
  let buffer = ""
  socket.on("data", (chunk) => {
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
    send: (message) => socket.write(`${JSON.stringify(message)}\n`),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** `adb forward tcp:0 …` returns the chosen port; parse it. */
function forwardTo(socketName) {
  const out = adb("forward", "tcp:0", `localabstract:${socketName}`)
  const port = Number.parseInt(out, 10)
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`could not parse a port from adb forward output: ${JSON.stringify(out)}`)
  }
  return port
}

const work = mkdtempSync(join(tmpdir(), "android-probe-"))
let socketName = null

try {
  console.log("0. locate the running app's probe")
  socketName = findProbeSocket()
  if (!socketName) {
    // ⚠ Say the likely CAUSE, not just the fact. The two ways to get here are
    // "the app is not debuggable, so it correctly stayed closed" and "the app was
    // never launched". Both are actionable; "socket not found" alone is not.
    console.error(
      [
        `No @${SOCKET_PREFIX}:* socket on the device.`,
        "  The app either is not running, or is running but NOT debuggable — in which",
        "  case it correctly refused to listen. Confirm the installed APK came from a",
        "  `-d` build (CI sets that by default; `android_release_apk=1` disables it).",
      ].join("\n"),
    )
    for (const r of results) console.log(`   ${r.pass ? "PASS" : "FAIL"}  ${r.name}`)
    process.exit(1)
  }
  check("the probe bound a socket on the device", true)
  console.log(`   socket: @${socketName}`)

  const token = readToken()
  check(
    "the token is readable via adb from the app's external dir",
    /^[0-9a-f]{64}$/.test(token),
    `expected 64 hex chars, got ${JSON.stringify(token.slice(0, 80))}`,
  )

  const port = forwardTo(socketName)
  console.log(`   forwarded tcp:${port} -> localabstract:${socketName}`)
  check("adb forward accepted the abstract socket", Number.isInteger(port))

  const socket = createConnection({ host: "127.0.0.1", port })
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve)
    socket.once("error", reject)
  })

  // The token goes FIRST, as one line, exactly as `handshake` expects.
  socket.write(`${token}\n`)

  const transport = socketTransport(socket)
  const channel = new StreamingRPCChannel(transport, {
    timeout: 60_000,
    onClose: (reason) => console.log(`   [channel closed] ${reason ?? "clean"}`),
  })
  const hands = channel.getAPI()

  console.log("\n1. hands.hello (proves the production ordering survived the transport)")
  const boot = await new Promise((resolve) => {
    const unsubscribe = transport.subscribe((message) => {
      if (message?.p?.[0] === "hands" && message?.p?.[1] === "hello") {
        unsubscribe()
        resolve(message)
      }
    })
  })
  check(
    "the app announced itself as a node",
    boot?.a?.[0]?.schemaVersion === 1 && typeof boot?.a?.[0]?.node?.platform === "string",
    JSON.stringify(boot).slice(0, 200),
  )
  console.log(`   platform reported by the app: ${boot?.a?.[0]?.node?.platform}`)

  console.log("\n2. hands.stat on a file we place in the app's OWN external dir")
  // ⚠ The file is placed where the APP can read it (its own external dir), not where
  // this process happens to have permissions. That is the whole point: the primitives
  // must work under the app's uid, not ours.
  const payload = randomBytes(48 * 1024)
  const sourceHash = createHash("sha256").update(payload).digest("hex")
  const localPath = join(work, "source.bin")
  writeFileSync(localPath, payload)
  adb("push", localPath, `${APP_EXTERNAL_DIR}/source.bin`)

  const stat = await hands.hands.stat(`${APP_EXTERNAL_DIR}/source.bin`)
  check(
    "hands.stat reports the exact size we pushed",
    stat?.size === payload.length,
    `expected ${payload.length}, got ${stat?.size}`,
  )

  console.log("\n3. hands.read round trip (bytes must match, not 'it said ok')")
  const back = await hands.hands.read(`${APP_EXTERNAL_DIR}/source.bin`)
  const chunks = []
  for await (const chunk of back) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "base64") : Buffer.from(chunk))
  }
  const received = Buffer.concat(chunks)
  const receivedHash = createHash("sha256").update(received).digest("hex")
  check(
    "the bytes read back are byte-identical to what was pushed",
    receivedHash === sourceHash,
    `expected sha256 ${sourceHash.slice(0, 16)}…, got ${receivedHash.slice(0, 16)}… (${received.length} vs ${payload.length} bytes)`,
  )

  channel.destroy?.()
  socket.destroy()
} catch (error) {
  console.error(`\nprobe failed: ${error?.stack ?? error}`)
  results.push({ name: "probe ran to completion", pass: false })
} finally {
  // Leave the device as we found it.
  try {
    adb("forward", "--remove-all")
  } catch {
    /* nothing forwarded */
  }
  try {
    adb("shell", "rm", "-f", `${APP_EXTERNAL_DIR}/source.bin`)
  } catch {
    /* already gone */
  }
  rmSync(work, { recursive: true, force: true })

  const passed = results.filter((r) => r.pass).length
  console.log(`\n${passed}/${results.length} passed`)
  process.exit(passed === results.length && results.length > 0 ? 0 : 1)
}
