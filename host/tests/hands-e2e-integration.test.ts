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
//   `hands-e2e` is a Cargo EXAMPLE of the shell crate. It imports
//   `tauri_app_lib::{hands, kkrpc_peer, hands_hello}` — the production modules,
//   reached through the crate boundary — and registers the real handlers. It
//   needs no `AppHandle`, because the file primitives genuinely have no Tauri
//   dependency (unlike tray/shortcut/dialog). So a real child process on real
//   pipes IS the production code path for these four primitives.
//
//   The test spawns that binary and wraps its stdio with the same
//   `stdioJsonTransport` production uses (`connectShellStdio`'s default), then
//   drives `HandsService` through it.
//
//   ⚠ It previously lived at `docs/probes/hands-e2e/rust/` and pulled the same
//   files in with `#[path]`. That compiled production source but built a private
//   copy of the module graph, so nothing verified the modules were reachable as
//   production reaches them. Moving it to `src-tauri/examples/` required making
//   those three modules `pub` (see `src-tauri/src/lib.rs`).
//
// ⚠ WHAT THIS STILL DOES NOT COVER
//   The Rust SHELL (the Tauri app) itself: it needs a webview and cannot run
//   headless. So the shell's own registration call (`host.rs` →
//   `register_hands_handlers`) is not exercised here — only that the module it
//   calls works with the host service on the other end.
//
// Runs only when the peer binary exists (built by
// `cargo build --release --locked --manifest-path src-tauri/Cargo.toml --example hands-e2e`).
// Absence is a SKIP with a reason, never a silent pass.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { type ChildProcess, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { Context } from "cordis"
import { stdioJsonTransport } from "kkrpc/stdio"
import { StreamingRPCChannel } from "kkrpc/streaming"
import { HandsError, HandsService } from "../src/hands"
import type {
  HandsHelloHandler,
  HandsHelloWire,
  ShellHandsHelloBridge,
  ShellStdioBridge,
} from "../src/stdio"

const repoRoot = join(import.meta.dir, "..", "..")
// ⚠ The example builds into the WORKSPACE target dir, not a probe-local one:
// `cargo build --release --example hands-e2e` from the root puts it in
// <root>/target/release/examples/. It used to be a standalone probe crate at
// docs/probes/hands-e2e/rust/ with its own target tree.
const DEFAULT_BIN = join(
  repoRoot,
  "target",
  "release",
  "examples",
  process.platform === "win32" ? "hands-e2e.exe" : "hands-e2e",
)

/**
 * The artifact the BUILD STEP handed over, if it did.
 *
 * ⚠ This exists so the test does not have to decide, by looking at the disk,
 * whether the thing it is about to exercise is the artifact this run built. That
 * question cannot be answered by a test: `existsSync` says "some binary is there",
 * which is true for a stale one, a half-written one, or one built from different
 * sources. Measured the hard way — a local `17/17 pass` was a FALSE GREEN because
 * `target/release/examples/hands-e2e.exe` predated the source change it was
 * supposed to validate, and the expectation it satisfied was the stale one too.
 *
 * So the pipeline builds first and passes the path (see `build.yml`); when the
 * variable is set, its presence is a CONTRACT rather than a probe, and a missing
 * file at that path is a hard failure — never a skip. Unset means a local run, and
 * the conventional path plus the skip below still applies, because a clean
 * checkout has no `target/` and an unbuildable prerequisite should not block
 * unrelated work.
 */
const handedOverBin = process.env.VRCXK_HANDS_E2E_BIN
// ⚠ Resolved against `repoRoot`, NEVER against the process cwd. `bun run test`
// runs this file with `--cwd host`, so a relative path from the pipeline would
// otherwise land in `host/target/...` — a directory that does not exist, which
// would surface as "the pipeline built nothing" and send the next reader to the
// wrong file entirely. Measured: that is exactly what happened the first time.
const BIN = handedOverBin
  ? isAbsolute(handedOverBin)
    ? handedOverBin
    : resolve(repoRoot, handedOverBin)
  : DEFAULT_BIN

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

if (!binaryAvailable && handedOverBin) {
  // ⚠ A HANDED-OVER PATH THAT IS EMPTY IS A PIPELINE FAILURE, and it is reported
  // as one. `VRCXK_HANDS_E2E_BIN` is set by the build step in `build.yml`, so if
  // the file is not there afterwards the ordering is wrong or the build step did
  // not run — a defect in the pipeline, not a missing local prerequisite. Naming
  // the pipeline keeps this from being read as "run cargo build yourself", which
  // is the wrong fix and would hide the real one.
  throw new Error(
    `[hands-e2e-integration] the build step handed over ${BIN} but it is not ` +
      `there — the pipeline built nothing, or built it elsewhere. Fix the STEP ` +
      `ORDER in .github/workflows/build.yml (build before the test), not this file.`,
  )
}

if (!binaryAvailable && requireBinary) {
  // Thrown at module scope so the failure names the missing prerequisite
  // instead of surfacing later as a confusing assertion error.
  throw new Error(
    `[hands-e2e-integration] ${BIN} is absent but VRCXK_REQUIRE_HANDS_E2E=1 — ` +
      `build it with \`cargo build --release --locked --manifest-path src-tauri/Cargo.toml --example hands-e2e\``,
  )
}

if (!binaryAvailable) {
  console.warn(
    `[hands-e2e-integration] SKIPPED: ${BIN} is absent — build it with ` +
      `\`cargo build --release --locked --manifest-path src-tauri/Cargo.toml --example hands-e2e\``,
  )
}

let child: ChildProcess | undefined
let work: string
let svc: HandsService
let channel: StreamingRPCChannel<object, object> | undefined
/** Hello announcements received on the wire, and the identity they carried. */
let helloBridge: ShellHandsHelloBridge
/**
 * Every hello DISPATCHED, recorded at dispatch time.
 *
 * ⚠ Not the same as a subscriber list. The hello is sent once, immediately after
 * the peer's reader starts — which is during `beforeAll`'s `connect()`, before any
 * test can register a listener. So a test that asserted on `onHello` firing saw
 * nothing and reported a missing announcement that had in fact arrived. Recording
 * at dispatch is what actually proves the frame came over the wire.
 */
let helloLog: HandsHelloWire[]
let seenLaunchId: string | undefined

/**
 * The RAW `hands.*` API — the channel's own proxy, not `HandsService`.
 *
 * Needed because the service sits ON TOP of `decodeStream`, which consumes with
 * `for await` and therefore **discards a generator's terminal value**. Anything
 * about the terminal frame's `value` is invisible through the service (a test
 * asserting it there passes no matter what the wire carries), so the one test
 * that pins it has to use the raw channel.
 */
let rawHands: Record<string, unknown> | undefined

/** Drain a stream into an array (the other test files have their own copies). */
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const value of stream) out.push(value)
  return out
}

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
 *
 * ⚠ `expose` is REQUIRED for the hello. The peer announces identity with a
 * `notify`, which kkrpc delivers as an ordinary inbound call — so without a
 * handler the frame is dispatched to nothing and silently disappears (a notify
 * expects no reply, so no error would ever surface). The production path gets
 * this from `connectShellStdio`'s `expose`; this harness has to provide it.
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

  const helloHandlers = new Set<HandsHelloHandler>()
  helloLog = []
  let current: HandsHelloWire | undefined
  helloBridge = {
    onHello: (handler) => {
      helloHandlers.add(handler)
      return () => helloHandlers.delete(handler)
    },
    currentHello: () => current,
  }

  channel = new StreamingRPCChannel<object, object>(transport as never, {
    expose: {
      hands: {
        hello: (hello: HandsHelloWire) => {
          // Recorded at dispatch, so the wire delivery is provable even though
          // the test's own subscriber is registered later.
          helloLog.push(hello)
          current = hello
          seenLaunchId = hello.node.launchId
          for (const handler of [...helloHandlers]) handler(hello)
          return true
        },
      },
    },
  })
  // ⚠ `getAPI()` returns the ROOT proxy: the methods live under the `hands`
  // namespace, so the bridge takes `api.hands`, not `api`. Passing the root made
  // every call arrive as `unknown RPC method: stat` — which is what the first run
  // of this test reported.
  const api = channel.getAPI() as { hands: unknown }
  rawHands = api.hands as Record<string, unknown>
  const ctx = new Context()
  const service = new HandsService(ctx, {})
  service.attachShell({
    hands: api.hands,
    handsHello: helloBridge,
    shell: {},
  } as unknown as ShellStdioBridge)
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
    "a FAILING stat REJECTS through the real peer, with a parseable code",
    async () => {
      // ⚠ THE SEAM THIS FILE EXISTS FOR, applied to the failure path.
      //
      // `register_stat` used to be a sync `peer.on`, whose reply frame is always
      // `{"t":"r","v":…}` — no error arm — so a failure had to be returned AS the
      // value `{"error":"CODE: detail"}`. Measured then:
      //
      //     stat("\\.\NUL") RESOLVED to {"error":"EACCES: …"}  → .size undefined
      //
      // i.e. "cannot read it" reached the CALLER as "read it, no size". The Rust
      // unit test pins `stat_outcome`; this one pins the other half of the seam —
      // that the rejection survives base64/framing, and that `HandsService`
      // translates it into a `HandsError` whose `.code` a caller can branch on.
      //
      // An interior NUL is refused at the OS layer on every platform (Windows:
      // `os error 1`; Unix: `CString` → `NulError`), so this is not another
      // platform assumption.
      let caught: unknown
      try {
        await svc.stat("a\0b")
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(HandsError)
      const err = caught as HandsError
      // ⚠ THE EXPECTED CODE IS `EINVAL`, AND IT USED TO BE `EACCES` — the same
      // change the Rust unit test next to `stat_outcome` records. An interior NUL
      // is refused by the OS layer on every platform (`InvalidInput`), and the old
      // `classify` catch-all reported every unrecognised kind as `Denied`. That was
      // the bug: `EACCES` tells a caller to go and ask the user for permissions,
      // while a malformed path can never succeed on any machine. This file pinned
      // the buggy value end-to-end (it only runs when the release binary exists, so
      // the Rust-side change did not surface it locally) and went red on all three
      // desktop CI runners. It is exact on purpose: a disjunction here would let the
      // regression back in.
      expect(err.code).toBe("EINVAL")
      // The prefix must be STRIPPED into `.code`, not left in the message for
      // callers to parse — that is the whole point of the class.
      expect(err.message).not.toContain("EINVAL:")
      // And the code must not be the misleading one.
      expect(err.code).not.toBe("EACCES")
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
    "a finished stream ends with NO value, and the wire really carries none",
    async () => {
      // ⚠ Pins the TERMINAL FRAME's shape, which nothing asserted before.
      //
      // Rust sends `{"t":"sr","sid":…,"d":true}` with no `"v"` because
      // `StreamStep::Done` carries no payload (see `kkrpc_peer.rs`) and
      // `StreamSink::finish` takes no value.
      //
      // ⚠ kkrpc's remote consumer DOES decode a terminal `v` and hand it to the
      // waiting iterator — verified by experiment, not by reading: injecting
      // `"v": "LEAKED"` into the terminal frame makes the raw channel's final
      // result `{done:true, value:"LEAKED"}`. (An earlier claim of mine that the
      // JS side "ignores it anyway" was a misread of the `:667` short-circuit
      // branch; 1zyao corrected it, Lyric-ovo independently confirmed the line.)
      //
      // So WHY drive the raw API here rather than `svc.read`? Because `svc.read`
      // cannot see it: `decodeStream` consumes with `for await`, and `for await`
      // DISCARDS a generator's terminal value. Asserting through the service would
      // therefore pass even with the leak injected — an unfalsifiable test, which
      // is what the first version of this was. The raw channel is where the
      // contract is observable, so that is where it is pinned.
      const path = join(work, "terminal.bin")
      writeFileSync(path, "abc")
      const raw = (rawHands as { read: (p: string) => AsyncIterable<unknown> }).read(path)
      const iterator = raw[Symbol.asyncIterator]()

      const seen: Array<IteratorResult<unknown>> = []
      for (;;) {
        const result = await iterator.next()
        seen.push(result)
        if (result.done) break
      }

      const terminal = seen.filter((result) => result.done)
      expect(terminal).toHaveLength(1)
      // The contract: no value. `undefined` rather than `null` — sending an
      // explicit `null` would CHANGE the terminal type (a point 1zyao raised),
      // so this asserts the absence of a value, not a particular one.
      //
      // This WILL fail if anyone gives `StreamStep::Done` a payload without
      // wiring `"v"` through — and, equally, it will fail (correctly) if someone
      // starts sending a terminal value and expects consumers to read it.
      expect(terminal[0].value).toBeUndefined()
      expect(seen.length).toBeGreaterThan(1)
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

  test.skipIf(!binaryAvailable)(
    "list enumerates a real directory, with kinds, over the real peer",
    async () => {
      // The whole point of the primitive: these names are DISCOVERED, not
      // supplied. Before `list` existed the only way to learn that `a.txt` was
      // here would have been to guess the name and `stat` it.
      const dir = join(work, "listing")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "a.txt"), "aaa")
      writeFileSync(join(dir, "b.txt"), "bb")
      mkdirSync(join(dir, "sub"))

      const entries = (await collect(svc.list(dir))).flat()
      const byName = new Map(entries.map((entry) => [entry.name, entry]))

      expect([...byName.keys()].sort()).toEqual(["a.txt", "b.txt", "sub"])
      // Kind and size come back in the SAME call. That is what saves the N
      // round trips this primitive exists to save: a caller that got only names
      // would need one `stat` per entry.
      expect(byName.get("a.txt")?.kind).toBe("file")
      expect(byName.get("a.txt")?.size).toBe(3)
      expect(byName.get("sub")?.kind).toBe("dir")
    },
    30_000,
  )

  test.skipIf(!binaryAvailable)(
    "list batches through the real credit window without losing an entry",
    async () => {
      // A batch boundary bug drops entries SILENTLY, and a caller walking a
      // directory would conclude it ended early. 25 entries at batch 4 forces
      // several full batches plus a partial one.
      const dir = join(work, "batched")
      mkdirSync(dir, { recursive: true })
      for (let i = 0; i < 25; i++) {
        writeFileSync(join(dir, `f${String(i).padStart(2, "0")}.txt`), "x")
      }
      const batches = await collect(svc.list(dir, { batch: 4 }))
      const names = batches.flat().map((entry) => entry.name)

      expect(names).toHaveLength(25)
      expect(new Set(names).size).toBe(25)
      expect(batches.length).toBeGreaterThan(1)
      expect(Math.max(...batches.map((batch) => batch.length))).toBeLessThanOrEqual(4)
    },
    30_000,
  )

  test.skipIf(!binaryAvailable)(
    "stat previews a directory AND flags truncation, so a caller knows to list",
    async () => {
      // The preview is the cheap path; `truncated` is what stops a caller from
      // believing it has seen everything. Without it, a directory with more than
      // the preview size looks COMPLETE and the extra entries are never read.
      const small = join(work, "preview-small")
      mkdirSync(small, { recursive: true })
      writeFileSync(join(small, "only.txt"), "x")
      const smallStat = await svc.stat(small)
      expect(smallStat?.entries?.truncated).toBe(false)
      expect(smallStat?.entries?.items.map((entry) => entry.name)).toEqual(["only.txt"])

      const big = join(work, "preview-big")
      mkdirSync(big, { recursive: true })
      for (let i = 0; i < 40; i++) writeFileSync(join(big, `f${i}.txt`), "x")
      const bigStat = await svc.stat(big)
      expect(bigStat?.entries?.truncated).toBe(true)

      // And `list` really does return the rest — the flag is not a dead end.
      const all = (await collect(svc.list(big))).flat()
      expect(all).toHaveLength(40)
    },
    30_000,
  )

  test.skipIf(!binaryAvailable)(
    "stat of a FILE has no preview, which is distinct from an empty directory",
    async () => {
      // Three states must stay apart on the wire. Merging them would make "not a
      // directory" indistinguishable from "a directory with nothing in it".
      const file = join(work, "not-a-dir.txt")
      writeFileSync(file, "x")
      const fileStat = await svc.stat(file)
      expect(fileStat?.entries ?? null).toBeNull()

      const empty = join(work, "truly-empty")
      mkdirSync(empty, { recursive: true })
      const emptyStat = await svc.stat(empty)
      expect(emptyStat?.entries?.items).toEqual([])
      expect(emptyStat?.entries?.truncated).toBe(false)
    },
    30_000,
  )

  test.skipIf(!binaryAvailable)(
    "list on a FILE reports ENOTDIR, not an empty listing",
    async () => {
      // ⚠ On Windows `read_dir` on a file SUCCEEDS and yields nothing (measured),
      // so without the explicit guard a file would look like an EMPTY DIRECTORY —
      // a silent wrong answer rather than an error.
      const file = join(work, "not-a-directory.txt")
      writeFileSync(file, "x")
      let caught: unknown
      try {
        await collect(svc.list(file))
      } catch (error) {
        caught = error
      }
      expect((caught as { code?: string }).code).toBe("ENOTDIR")
    },
    30_000,
  )
})

describe("the shell's hello arrives on a real connection", () => {
  test.skipIf(!binaryAvailable)(
    "the brain learns the peer's cwd, home and environment without asking",
    async () => {
      // ⚠ The hello is sent ONCE, right after the peer's reader starts — i.e.
      // during `beforeAll`, before this test can register anything. So this
      // asserts on the DISPATCH LOG; the round trip below only proves the frame
      // is not still sitting unread in a pipe.
      await svc.stat(work)

      expect(helloLog.length).toBeGreaterThan(0)
      const hello = helloLog[0]
      // `schemaVersion` is what turns a version skew into a named refusal instead
      // of a pile of undefined fields.
      expect(hello.schemaVersion).toBe(1)
      expect(hello.node.launchId.length).toBeGreaterThan(0)
      // ⚠ DERIVED from the host's own platform, not hardcoded. The peer is a
      // local process, so `std::env::consts::OS` on the other end must agree with
      // `process.platform` here — and that agreement is the actual assertion.
      // Hardcoding "windows" made this test pass locally and FAIL on macOS and
      // Ubuntu, which is worse than not having it: a green local run said nothing
      // about the two platforms where it was red.
      const expectedPlatform =
        process.platform === "win32"
          ? "windows"
          : process.platform === "darwin"
            ? "macos"
            : process.platform
      expect(hello.node.platform).toBe(expectedPlatform)
      // The peer's OWN cwd — the value the brain previously had no way to obtain,
      // and the correct base for resolving a relative path.
      expect(hello.cwd.length).toBeGreaterThan(0)
      expect(typeof hello.home).toBe("string")
      // The environment arrives WITH the identity, not via a separate call, so it
      // cannot be confused with the brain's own `process.env`.
      expect(Object.keys(hello.env).length).toBeGreaterThan(0)
    },
    30_000,
  )

  test.skipIf(!binaryAvailable)(
    "a late subscriber still learns the identity, which is once per process",
    async () => {
      // ⚠ The hello is sent ONCE. A plain fan-out would mean anything registering
      // after it arrived (a plugin loaded later, a UI panel opened later) never
      // learns who the shell is — and would conclude there is no shell identity
      // rather than that it missed the announcement.
      const late: HandsHelloWire[] = []
      const stop = helloBridge.onHello((hello) => late.push(hello))
      await svc.stat(work)
      stop()

      const current = helloBridge.currentHello()
      expect(current).toBeDefined()
      // It must be the SAME node the earlier test saw, not a fresh/blank object.
      expect(current?.node.launchId).toBe(seenLaunchId)
      // And the replay must NOT be a second announcement: the shell sends one per
      // process, so a late subscriber sees no further dispatch...
      expect(late).toHaveLength(0)
      // ...which also pins that only ONE hello crossed the wire.
      expect(helloLog).toHaveLength(1)
    },
    30_000,
  )
})
