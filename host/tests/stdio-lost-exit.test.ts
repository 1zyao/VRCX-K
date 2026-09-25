// Exit 52: losing the shell mid-handshake is a clean stop, not a crash.
//
// Issue background — kkrpc reports "the peer is gone" through TWO independent
// paths, and before this change only one of them was handled:
//
//   1. the READ side ends -> `RPCTransportClosedError`  (handled, exit 0)
//   2. a WRITE fails (EPIPE) -> a raw error, `onClose` stays SILENT, so the
//      rejection reached the bootstrap catch-all and exited 1 (probe 16).
//
// Exit 1 is not merely uninformative here: the shell's `classify_watch` reads
// every non-51 code as a crash and charges it to the restart-storm budget, so
// eight of them inside the stable window park the host in `Failed`. The host did
// nothing wrong, so it must not be billed for it.
//
// This test drives the REAL host binary and pins the exit code, which is the
// only way to prove the write-side detector is actually wired into bootstrap —
// the unit tests in host_ready/host.rs cover the classification, not the wiring.

import { afterEach, beforeAll, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { killTree, pipe, resolveBun, warmBun } from "./helpers"

const hostDir = join(import.meta.dir, "..")
const bun = resolveBun()

beforeAll(async () => {
  await warmBun()
}, 60_000)

let child: ReturnType<typeof spawn> | undefined

afterEach(() => {
  if (child?.pid) killTree(child.pid)
  child = undefined
})

/** Exit code the host reports; the shell's `HOST_STDIO_LOST_EXIT`. */
const STDIO_LOST_EXIT = 52

test("a write failure during the handshake stops the host with the dedicated code", async () => {
  child = spawn(bun, ["src/index.ts"], {
    cwd: hostDir,
    env: { ...process.env, VRCXK_SHELL: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })

  const stderr: string[] = []
  // Checked rather than asserted: `spawn` types the pipes as optional (they come
  // from `stdio`), while this test always passes ["pipe","pipe","pipe"].
  const errPipe = pipe(child.stderr, "stderr")
  const outPipe = pipe(child.stdout, "stdout")
  errPipe.on("data", (c: Buffer) => stderr.push(c.toString()))

  // `child` is the module-level `let` (`| undefined`, cleared in `afterEach`).
  // TypeScript does not carry the assignment from the `spawn` call above across
  // these statements, so it must be narrowed once here — the helper below is the
  // local equivalent of `hostProc()` in `stdin-loss.test.ts`, and it throws a
  // NAMED error rather than producing `undefined` at the `.once` call.
  const spawned = child
  if (!spawned) throw new Error("test did not spawn a host process")
  const exited = new Promise<number | null>((resolve) =>
    spawned.once("exit", (exitCode) => resolve(exitCode)),
  )

  // Break our read end of the host's stdout IMMEDIATELY, before it writes the
  // `ready` frame.
  //
  // Timing matters and is not incidental: `shell.ready()` is the host's first
  // stdout write, and it follows the `[host] ready` STDERR line by only the time
  // it takes to build the stdio bridge. Waiting for that log line and then
  // destroying stdout loses the race — the frame is already in the pipe — and the
  // host then just keeps running, which is what an earlier version of this test
  // did (it timed out rather than failing on the wrong code). Destroying first
  // makes the very next write fail with EPIPE.
  //
  // We deliberately do NOT close the host's stdin, so the READ-side detector
  // (`onClose`) stays silent and cannot mask the result: whatever exit code we
  // observe is attributable to the WRITE path alone.
  outPipe.destroy()

  const code = await Promise.race([
    exited,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`host did not exit\n${stderr.join("")}`)), 20_000),
    ),
  ])

  const log = stderr.join("")
  // The dedicated code, NOT 0 (which would claim a clean session) and NOT 1
  // (which the shell would bill as a crash and count toward the storm cap).
  expect(code).toBe(STDIO_LOST_EXIT)
  // And the reason must be legible in the log, naming the sending side.
  expect(log).toContain("shell went away during the ready handshake")
  expect(log).toMatch(/write side failed|read side closed/)
  // Crucially, it must NOT have gone through the fatal bootstrap handler, which
  // is the path that produced exit 1 before this change.
  expect(log).not.toContain("fatal bootstrap error")
}, 40_000)
