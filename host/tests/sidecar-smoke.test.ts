// Packaged sidecar smoke (issue #7 Batch A/C): launch the canonical
// `src-tauri/binaries/host-<triple>[.exe]` artifact, verify ready, then a
// graceful stop via the stdio RPC — the same protocol the Rust shell uses.
//
// The artifact is git-ignored and built by `bun run build:host`. When it is
// absent (clean checkout before the build step) these tests skip instead of
// failing; CI/dev must run `bun run build:host` first for real coverage.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { HOST_SPAWN_DETACHED, killTree, pipe, readReady, warmBun } from "./helpers"

const repoRoot = join(import.meta.dir, "..", "..")

function detectTriple(): string {
  const probe = spawnSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" })
  if (probe.status === 0 && probe.stdout) return probe.stdout.trim()
  throw new Error("cannot detect Rust target triple (rustc missing)")
}

const triple = detectTriple()
const artifact = join(
  repoRoot,
  "src-tauri",
  "binaries",
  `host-${triple}${triple.includes("windows") ? ".exe" : ""}`,
)
const available = existsSync(artifact)
/**
 * The artifact is git-ignored and produced by `bun run build:host`, so a clean
 * checkout legitimately lacks it. Absence is reported as a SKIP (never a silent
 * pass); set `VRCXK_REQUIRE_SIDECAR=1` (packaging/CI job) to require it.
 */
const requireArtifact = process.env.VRCXK_REQUIRE_SIDECAR === "1"

if (!available && !requireArtifact) {
  console.warn(
    `[sidecar-smoke] SKIPPED: ${artifact} is absent — build it with \`bun run build:host\` (set VRCXK_REQUIRE_SIDECAR=1 to require it)`,
  )
}

beforeAll(async () => {
  if (!available) return
  await warmBun()
}, 60_000)

let proc: ReturnType<typeof Bun.spawn> | undefined

afterAll(async () => {
  if (!proc) return
  killTree(proc.pid)
  // Wait for the 82MB artifact to actually exit before the file is reused by
  // another test/step (Windows keeps it locked while running).
  await proc.exited.catch(() => {})
  proc = undefined
}, 30_000)

test.skipIf(!available && !requireArtifact)(
  "canonical sidecar artifact exists (run bun run build:host first)",
  () => {
    // A real existence check: the old assertion compared a non-empty string
    // against toBeTruthy(), which could never fail.
    expect(
      existsSync(artifact),
      `missing ${artifact} — build with \`bun run build:host\` (or set VRCXK_REQUIRE_SIDECAR=1 to require it)`,
    ).toBe(true)
    expect(statSync(artifact).size).toBeGreaterThan(0)
  },
)

test.skipIf(!available)(
  "sidecar launches to ready and stops gracefully via stdio RPC",
  async () => {
    // The packaged shell spawns the sidecar with cwd = resource dir so the
    // host finds cordis.yml/plugins beside itself. In this repo the artifact
    // dir has no runtime seed yet (M1 decision: not bundled), so run with
    // cwd = host/ where the runtime files live — dev-mode parity.
    proc = Bun.spawn([artifact], {
      cwd: join(repoRoot, "host"),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // POSIX: the sidecar becomes its own process-group leader (setsid), so
      // killTree's kill(-pid) reaps host + any descendants in one signal — same
      // semantics as the Rust shell's process_group(0) / Job Object.
      // Windows: NOT detached (#33) — detached lets the child outlive the runner
      // (probe10: 8/8 survived); non-detached ties it to the runner's job object
      // so an interrupted run reaps it.
      detached: HOST_SPAWN_DETACHED,
      // The Rust shell always marks the child as shell-attached so the host
      // connects the kkrpc/stdio bridge (VRCXK_SHELL=1, see host.rs
      // start_host_process / host/src/index.ts).
      env: { ...process.env, VRCXK_SHELL: "1" },
    })
    // Cold start of the 82MB sidecar can exceed the 15s default on Windows.
    const ready = await readReady(pipe(proc.stderr, "stderr"), 60_000)
    expect(ready.port).toBeGreaterThan(0)
    expect(ready.token).toMatch(/^[0-9a-f]{64}$/)
    expect(ready.hostVersion).toBe("0.0.1")

    // Graceful stop via the stdio RPC (compact protocol the Rust Peer speaks).
    const frame = `${JSON.stringify({ t: "q", id: "smoke-stop", op: "call", p: ["stop"] })}\n`
    // Checked, not asserted: the sidecar is spawned with `stdin: "pipe"`, which
    // the type system cannot see. A missing pipe means the spawn options drifted.
    // `pipe()` also narrows away the `number` (file-descriptor) arm, which is what
    // made `stdin.write` / `.flush` / `.end` unreadable on the raw union.
    const stdin = pipe(proc.stdin, "stdin")
    stdin.write(frame)
    await stdin.flush?.()
    stdin.end?.()
    const exited = await proc.exited
    expect(exited).toBe(0)
  },
  90_000,
)
