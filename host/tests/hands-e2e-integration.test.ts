// END-TO-END: the host's `HandsService` against the REAL Rust peer, over REAL pipes.
//
// WHY THIS EXISTS (the gap it closes)
//   Every other hands test stops one layer short of the seam:
//
//     - `docs/probes/hands-e2e/run.mjs` drives the real Rust peer, but with a
//       hand-rolled script on the JS side (never `HandsService`).
//     - `host/tests/hands-service.test.ts` drives the real `HandsService`, but
//       against a FAKE bridge (never the real peer).
//
//   So "the host's service can talk to the shipped Rust code" was never
//   executed. That is exactly the class of gap this repo keeps getting bitten
//   by: both halves verified, the seam not. The macOS watch bug (a path-form
//   mismatch that only CI's other target could see) is the same shape.
//
// HOW IT WORKS WITHOUT A TAURI APP
//   `hands-e2e` compiles `src-tauri/src/hands.rs` and `kkrpc_peer.rs` by `#[path]`
//   — the production files, not copies — and registers the real handlers. It
//   needs no `AppHandle`, because the file primitives genuinely have no Tauri
//   dependency (unlike tray/shortcut/dialog). So a real child process on real
//   pipes IS the production code path for these four primitives.
//
//   The test spawns that binary and wraps its stdio with the same
//   `stdioJsonTransport` production uses (`connectShellStdio`'s default), then
//   drives `HandsService` through it.
//
// ⚠ WHAT THIS STILL DOES NOT COVER
//   The Rust SHELL (the Tauri app) itself: it needs a webview and cannot run
//   headless. So the shell's own registration call (`host.rs` →
//   `register_hands_handlers`) is not exercised here — only that the module it
//   calls works with the host service on the other end.
//
// Runs only when the probe binary exists (built by
// `cargo build --release --manifest-path docs/probes/hands-e2e/rust/Cargo.toml`).
// Absence is a SKIP with a reason, never a silent pass.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { type ChildProcess, spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "cordis"
import { stdioJsonTransport } from "kkrpc/stdio"
import { StreamingRPCChannel } from "kkrpc/streaming"
import { HandsService } from "../src/hands"
import type { ShellStdioBridge } from "../src/stdio"

const repoRoot = join(import.meta.dir, "..", "..")
const BIN = join(
  repoRoot,
  "docs",
  "probes",
  "hands-e2e",
  "rust",
  "target",
  "release",
  process.platform === "win32" ? "hands-e2e.exe" : "hands-e2e",
)

let binaryAvailable = true
try {
  // A stat, not a read: only existence matters here.
  readFileSync(BIN, { flag: "r" }).subarray(0, 0)
} catch {
  binaryAvailable = false
}

/**
 * Whether a missing binary must FAIL rather than skip.
 *
 * ⚠ The first CI run of this file reported "8 tests skipped" on a GREEN job,
 * because the runner had never built the peer. A skip nobody notices is
 * indistinguishable from coverage — the exact "green hides the gap" failure this
 * suite exists to prevent. CI therefore sets this flag, making a missing binary a
 * hard failure; locally the skip stays, because a clean checkout has no
 * `target/` and an unbuildable prerequisite should not block unrelated work.
 */
const requireBinary = process.env.VRCXK_REQUIRE_HANDS_E2E === "1"

if (!binaryAvailable && requireBinary) {
  // Thrown at module scope so the failure names the missing prerequisite
  // instead of surfacing later as a confusing assertion error.
  throw new Error(
    `[hands-e2e-integration] ${BIN} is absent but VRCXK_REQUIRE_HANDS_E2E=1 — ` +
      `build it with \`cargo build --release --manifest-path docs/probes/hands-e2e/rust/Cargo.toml\``,
  )
}

if (!binaryAvailable) {
  console.warn(
    `[hands-e2e-integration] SKIPPED: ${BIN} is absent — build it with ` +
      `\`cargo build --release --manifest-path docs/probes/hands-e2e/rust/Cargo.toml\``,
  )
}

let child: ChildProcess | undefined
let work: string
let svc: HandsService
let channel: StreamingRPCChannel<object, object> | undefined

/**
 * Connect a real `HandsService` to a freshly spawned Rust peer.
 *
 * `stdioJsonTransport` returns a TRANSPORT (the byte plumbing), so it has to be
 * wrapped in a channel to get a request/reply API — and it must be the
 * STREAMING channel, because `hands.read`/`watch` answer with stream references
 * that the base channel cannot route (measured: the base channel has zero
 * `"sq"`/`"sr"` handling).
 *
 * The bridge is cast because the peer implements ONLY the `hands.*` routes — it
 * is the capability under test, not a full shell.
 */
function connect(): HandsService {
  if (!child?.stdout || !child.stdin) {
    throw new Error('spawned peer has no stdio pipes (spawn needs stdout/stdin: "pipe")')
  }
  const transport = stdioJsonTransport({
    readable: child.stdout,
    writable: child.stdin,
    lifecycle: child.stdout,
  })
  channel = new StreamingRPCChannel<object, object>(transport as never, {})
  // ⚠ `getAPI()` returns the ROOT proxy: the methods live under the `hands`
  // namespace, so the bridge takes `api.hands`, not `api`. Passing the root made
  // every call arrive as `unknown RPC method: stat` — which is what the first run
  // of this test reported.
  const api = channel.getAPI() as { hands: unknown }
  const bridge = { hands: api.hands }
  const ctx = new Context()
  const service = new HandsService(ctx, {})
  service.attachShell({ ...(bridge as object), shell: {} } as unknown as ShellStdioBridge)
  return service
}

beforeAll(() => {
  if (!binaryAvailable) return
  work = mkdtempSync(join(tmpdir(), "hands-integration-"))
  child = spawn(BIN, [], { stdio: ["pipe", "pipe", "inherit"] })
  svc = connect()
}, 30_000)

afterAll(() => {
  // ⚠ `destroy()`, not `close()` — and the difference is not cosmetic.
  // `StreamingRPCChannel` exposes `destroy()`; there is no `close()`. The first
  // version of this wrote `channel?.close?.()`, and the optional call meant it
  // was a SILENT NO-OP: the stream bookkeeping (`localStreams` / `remoteStreams`
  // / `pendingStreams`) was never torn down, so a stream still in flight kept its
  // state until the process exited. Nothing failed, which is why it survived —
  // the type checker only caught it once `host/tests` was included in a program.
  try {
    channel?.destroy()
  } catch {
    /* already gone */
  }
  child?.kill()
  if (work) rmSync(work, { recursive: true, force: true })
})

describe("the host's HandsService drives the real Rust peer", () => {
  test.skipIf(!binaryAvailable)(
    "stat reads a real file's size and identity",
    async () => {
      const path = join(work, "real.txt")
      writeFileSync(path, "hello world")
      const stat = await svc.stat(path)
      expect(stat).not.toBeNull()
      expect(stat?.size).toBe(11)
      expect(stat?.kind).toBe("file")
      // The u128 HighRes id on Windows — proves `file-id` really ran, not a stub.
      expect(stat?.id.length).toBeGreaterThan(0)
    },
    30_000,
  )

  test.skipIf(!binaryAvailable)(
    "stat of a missing path is null, not an error",
    async () => {
      // The contract that keeps callers out of try/catch for control flow.
      expect(await svc.stat(join(work, "nope.txt"))).toBeNull()
    },
    30_000,
  )

  test.skipIf(!binaryAvailable)(
    "read streams real bytes: base64 on the wire, decoded by the service",
    async () => {
      // THE seam this file exists for. The Rust side sends base64; if the
      // service did not decode, this yields garbage or a wrong length rather
      // than failing — which is precisely why it is asserted byte-for-byte.
      const payload = Buffer.from("ABCDEFGHIJ", "utf8")
      const path = join(work, "read.bin")
      writeFileSync(path, payload)

      const chunks: Uint8Array[] = []
      for await (const chunk of svc.read(path)) chunks.push(chunk)
      const got = Buffer.concat(chunks.map((c) => Buffer.from(c)))
      expect(got.equals(payload)).toBe(true)
    },
    30_000,
  )

  test.skipIf(!binaryAvailable)(
    "read honours an offset against the real peer",
    async () => {
      const path = join(work, "resume.bin")
      writeFileSync(path, "0123456789")
      const chunks: Uint8Array[] = []
      for await (const chunk of svc.read(path, { offset: 4 })) chunks.push(chunk)
      expect(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString()).toBe("456789")
    },
    30_000,
  )

  test.skipIf(!binaryAvailable)(
    "write consumes a host-produced stream and reports the real byte count",
    async () => {
      // Also exercises the DEFERRED reply: the peer cannot answer until the
      // last chunk arrives, so a wrong implementation would hang here rather
      // than fail.
      const payload = Buffer.from("x".repeat(5000), "utf8")
      const path = join(work, "written.bin")

      async function* source(): AsyncIterable<Uint8Array> {
        for (let at = 0; at < payload.length; at += 1000) {
          yield new Uint8Array(payload.subarray(at, at + 1000))
        }
      }

      const result = await svc.write(path, source())
      expect(result.bytes).toBe(payload.length)
      expect(result.endOffset).toBe(payload.length)
      expect(Buffer.from(readFileSync(path)).equals(payload)).toBe(true)
    },
    30_000,
  )

  test.skipIf(!binaryAvailable)(
    "watch reports a file created AFTER the watch started",
    async () => {
      // The tail-on-startup case: the peer must fall back to watching the parent
      // directory when the target does not exist yet. Drive it through the real
      // service so the `HandsChange` normalisation is covered too.
      const target = join(work, "appears.log")
      const seen: Array<{ kind: string; path: string }> = []

      const consumer = (async () => {
        for await (const change of svc.watch(target)) {
          seen.push({ kind: change.kind, path: change.path })
          break
        }
      })()

      // Give the watch a moment to install before the file exists.
      await new Promise((resolve) => setTimeout(resolve, 300))
      writeFileSync(target, "hello\n")

      await Promise.race([consumer, new Promise((resolve) => setTimeout(resolve, 8_000))])
      expect(seen.length).toBe(1)
      expect(seen[0]?.kind).toBe("create")
    },
    30_000,
  )

  test.skipIf(!binaryAvailable)(
    "breaking out of a stream early returns instead of hanging",
    async () => {
      // Cancellation through the real transport: a stream left un-returned holds
      // a file handle on the Rust side.
      const path = join(work, "big.bin")
      writeFileSync(path, Buffer.alloc(2 * 1024 * 1024, 7))
      let seen = 0
      for await (const _chunk of svc.read(path)) {
        seen += 1
        break
      }
      expect(seen).toBe(1)
    },
    30_000,
  )

  test.skipIf(!binaryAvailable)(
    "an error from the real peer carries a parseable code",
    async () => {
      // The Rust side reports `CODE: detail`; the service turns that into
      // `HandsError.code`. A directory read is the cheapest real failure.
      let caught: unknown
      try {
        for await (const _chunk of svc.read(work)) {
          /* a directory: must fail */
        }
      } catch (error) {
        caught = error
      }
      expect(caught).toBeDefined()
      // `EISDIR` is the documented code for this case.
      expect((caught as { code?: string }).code).toBe("EISDIR")
    },
    30_000,
  )
})
