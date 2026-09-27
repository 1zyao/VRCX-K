// Issue #33 regression suite: a host started WITHOUT the Rust shell must stop
// itself when its launcher's stdin pipe closes, and must NOT stop when stdin
// is not a launcher lifetime (the null device `ignore` spawns use).
//
// Before the fix every teardown route needed an external peer, so a shell-less
// host only died as its launcher's collateral — and launchers that spawn
// detached (or go through `bun run`'s cmd.exe shim chain on Windows) never
// delivered it. See docs/probes/probe10.ts for the detached measurement and
// host/src/stdin-watch.ts for why EOF is guarded by an fd check: `ignore`
// reaches EOF in ~3ms, so an unguarded "EOF means stop" would kill every
// ignore-spawned host at startup. The guard accepts a FIFO OR a socket —
// libuv implements stdio pipes as socketpairs on POSIX, so `isFIFO()` alone
// silently disarms the watch there (this suite caught exactly that on CI).

import { afterEach, beforeAll, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { dispose, RPCChannel, wrap } from "kkrpc"
import { stdioJsonTransport } from "kkrpc/stdio"
import { webSocketClientTransport } from "kkrpc/ws"
import type { HostWsAPI } from "../src/api"
import { HOST_SPAWN_DETACHED, killTree, pipe, readReady, resolveBun, warmBun } from "./helpers"

const hostDir = join(import.meta.dir, "..")
const bun = resolveBun()

beforeAll(async () => {
  await warmBun()
}, 60_000)

let proc: ReturnType<typeof Bun.spawn> | undefined

/**
 * The host process spawned by the current test.
 *
 * Every test assigns `proc` before using it, so an absent one means the fixture
 * got out of order — worth throwing over rather than asserting past.
 */
function hostProc(): ReturnType<typeof Bun.spawn> {
  if (!proc) throw new Error("test did not spawn a host process")
  return proc
}

afterEach(() => {
  if (proc) killTree(proc.pid)
  proc = undefined
})

/** Fail the test with `what` instead of hanging when `promise` never settles. */
function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} (deadline ${ms}ms)`)), ms),
    ),
  ])
}

test("shell-less host stops itself when the launcher's stdin pipe closes", async () => {
  proc = Bun.spawn([bun, "src/index.ts"], {
    cwd: hostDir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: HOST_SPAWN_DETACHED,
    env: { ...process.env, VRCXK_SHELL: "0" },
  })
  await readReady(pipe(proc.stderr, "stderr"))
  // Let the stdin watch take its reader before we pull the pipe.
  await new Promise((r) => setTimeout(r, 300))

  // The launcher disappearing IS the write end going away.
  pipe(hostProc().stdin, "stdin").end?.()

  const code = await withDeadline(proc.exited, 20_000, "host did not stop after stdin closed")
  expect(code).toBe(0)
}, 30_000)

test("shell-less host does NOT stop when stdin is the null device", async () => {
  proc = Bun.spawn([bun, "src/index.ts"], {
    cwd: hostDir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: HOST_SPAWN_DETACHED,
    env: { ...process.env, VRCXK_SHELL: "0" },
  })
  const ready = await readReady(pipe(proc.stderr, "stderr"))

  // A missing fd guard would surface the null device's immediate EOF (~3ms) as
  // a stop signal and kill the host at startup — give it ample time to misfire.
  let exited: number | null = null
  await Promise.race([
    proc.exited.then((code) => (exited = code)),
    new Promise((r) => setTimeout(r, 2500)),
  ])
  expect(exited).toBe(null)

  // Still serving, not just still alive.
  const api = wrap<HostWsAPI>(
    webSocketClientTransport({ url: `ws://127.0.0.1:${ready.port}?token=${ready.token}` }),
  )
  expect(await api.ping()).toBe("pong")
  dispose(api)
}, 60_000)

test("shell-attached host stops when the shell end of stdin goes away", async () => {
  proc = Bun.spawn([bun, "src/index.ts"], {
    cwd: hostDir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: HOST_SPAWN_DETACHED,
    env: { ...process.env, VRCXK_SHELL: "1" },
  })
  await readReady(pipe(proc.stderr, "stderr"))
  // Let connectShellStdio's transport take its reader before we pull the pipe.
  await new Promise((r) => setTimeout(r, 500))

  // No stop RPC — closing the write end is the "shell died" signal (#33). The
  // host is free to be mid-`await shell.ready` when it lands.
  pipe(hostProc().stdin, "stdin").end?.()

  const code = await withDeadline(
    proc.exited,
    20_000,
    "host did not stop after the shell end closed",
  )
  expect(code).toBe(0)
}, 40_000)

// Regression: the official stdio transport delivers `onClose`, and kkrpc
// rejects every pending request immediately before invoking it. A shell that
// dies while `shell.ready` is still in flight therefore turns that RPC into a
// rejection. If that rejection escaped to the bootstrap catch-all it would
// `process.exit(1)` — and it would race the stdin-loss path, which exits 0.
// Both the exit code and the observability line are pinned here so a future
// refactor of either hook fails loudly instead of silently picking a winner.
test("shell dying mid-handshake is a clean stop, not a fatal bootstrap error", async () => {
  proc = Bun.spawn([bun, "src/index.ts"], {
    cwd: hostDir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: HOST_SPAWN_DETACHED,
    env: { ...process.env, VRCXK_SHELL: "1" },
  })
  // Collect stderr from the very first byte: `readReady` releases its lock but
  // consumes the `ready` line, and we assert on that whole transcript below.
  const stderrChunks: string[] = []
  const collector = (async () => {
    try {
      for await (const chunk of pipe(hostProc().stderr, "stderr") as ReadableStream<Uint8Array>) {
        stderrChunks.push(new TextDecoder().decode(chunk))
      }
    } catch {
      // killTree during afterEach tears the pipe down under us; the assertions
      // below only need what arrived before exit.
    }
  })()
  const seen = () => stderrChunks.join("")
  const deadline = Date.now() + 15_000
  while (!/\[host\] ready /.test(seen())) {
    if (Date.now() > deadline) throw new Error(`host never became ready\n${seen()}`)
    await new Promise((r) => setTimeout(r, 20))
  }

  // Pull the pipe immediately: `shell.ready` is outstanding right now, which is
  // exactly the race this test pins.
  pipe(hostProc().stdin, "stdin").end?.()

  const code = await withDeadline(
    proc.exited,
    20_000,
    "host did not stop after the shell end closed",
  )
  await collector
  const stderr = seen()

  expect(stderr).not.toContain("fatal bootstrap error")
  expect(code).toBe(0)
  // The `onClose` hook is the sole stop trigger on this path, and it reports
  // why the peer went away.
  expect(stderr).toMatch(/\[host\] shell (closed its stdio|stdio broke \()/)
  expect(stderr).toContain("stdin closed (shell is gone)")
  // One peer death must produce exactly one stop: kkrpc fires `onClose` once,
  // but a regression that also re-armed a stdin listener would double it.
  expect(stderr.match(/stdin closed \(shell is gone\)/g)).toHaveLength(1)
}, 40_000)

test("a genuine startup failure still exits loudly instead of being swallowed", async () => {
  // The shell here is a peer that does NOT expose `ready` — a version-skewed or
  // otherwise broken sidecar. kkrpc turns that call into an error rejection that
  // is NOT `RPCTransportClosedError`, so bootstrap must rethrow it and exit 1.
  //
  // This is the counterweight to the case above: absorbing the shell-death
  // rejection must not also absorb failures that mean "startup is broken". The
  // blanket catch this replaced exited 0 here with only a log line, leaving the
  // UI waiting for a `ready` that had already failed.
  //
  // Uses node's `spawn` (not `Bun.spawn`) because kkrpc's stdio transport needs
  // Node-style streams: it calls `.on`/`.off` on the lifecycle object.
  const child = spawn(bun, ["src/index.ts"], {
    cwd: hostDir,
    env: { ...process.env, VRCXK_SHELL: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  const stderrChunks: string[] = []
  pipe(child.stderr, "stderr").on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString()))

  try {
    // Attach as the shell, but expose nothing — `ready` is therefore unknown,
    // and the peer answers the call with an error frame.
    const transport = stdioJsonTransport({
      readable: pipe(child.stdout, "stdout"),
      writable: pipe(child.stdin, "stdin"),
      lifecycle: pipe(child.stdout, "stdout"),
    })
    const channel = new RPCChannel(transport, { expose: {} })

    const code = await withDeadline(
      new Promise<number | null>((resolve) => child.once("exit", resolve)),
      20_000,
      "host did not exit on a broken ready handshake",
    )

    expect(stderrChunks.join("")).toContain("fatal bootstrap error")
    expect(code).toBe(1)
    channel.destroy()
  } finally {
    // No throw here on purpose: this is a `finally`, and throwing would replace
    // whatever the test actually failed on. A missing pid is reported by the
    // assertion path instead of being escalated into a teardown error.
    if (child.pid !== undefined) killTree(child.pid)
  }
}, 40_000)

test("stdinIsPeerChannel classifies the real fd 0 (pipe vs ignore)", async () => {
  const moduleUrl = pathToFileURL(join(hostDir, "src", "stdin-watch.ts")).href
  // The child reports the raw fd facts alongside the verdict, so a
  // platform-specific failure names the actual fd type instead of just "false".
  const probe = `Promise.all([import(${JSON.stringify(moduleUrl)}), import("node:fs")]).then(([m, fs]) => {
    const st = fs.fstatSync(0)
    console.log(JSON.stringify({
      peer: m.stdinIsPeerChannel(),
      fifo: st.isFIFO(),
      socket: st.isSocket(),
      char: st.isCharacterDevice(),
      file: st.isFile(),
    }))
  })`
  const ask = (stdin: "pipe" | "ignore") =>
    Bun.spawn([bun, "-e", probe], { cwd: hostDir, stdin, stdout: "pipe", stderr: "pipe" })

  const piped = ask("pipe")
  const pipedFacts = JSON.parse((await new Response(pipe(piped.stdout, "stdout")).text()).trim())
  pipe(piped.stdin, "stdin").end?.()
  expect(pipedFacts.peer, `piped fd 0 facts: ${JSON.stringify(pipedFacts)}`).toBe(true)
  await piped.exited

  const ignored = ask("ignore")
  const ignoredFacts = JSON.parse(
    (await new Response(pipe(ignored.stdout, "stdout")).text()).trim(),
  )
  expect(ignoredFacts.peer, `ignored fd 0 facts: ${JSON.stringify(ignoredFacts)}`).toBe(false)
  await ignored.exited
}, 30_000)
