import { afterEach, beforeAll, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { RPCChannel } from "kkrpc"
import { stdioJsonTransport } from "kkrpc/stdio"
import type { HostStdioAPI, ShellSysAPI } from "../src/stdio"
import type { HostWsReady } from "../src/ws"
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

test("host stdio ready then ping and stop", async () => {
  child = spawn(bun, ["src/index.ts"], {
    cwd: hostDir,
    env: { ...process.env, VRCXK_SHELL: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })

  let resolveReady: (info: HostWsReady) => void
  const ready = new Promise<HostWsReady>((resolve, reject) => {
    resolveReady = resolve
    setTimeout(() => reject(new Error("shell ready was not called")), 10_000)
  })

  const transport = stdioJsonTransport({
    readable: pipe(child.stdout, "stdout"),
    writable: pipe(child.stdin, "stdin"),
    lifecycle: pipe(child.stdout, "stdout"),
  })
  const channel = new RPCChannel<ShellSysAPI, HostStdioAPI>(transport, {
    // ⚠ Partial mock, and the generics are NOT the production order on purpose.
    // `RPCChannel<Local, Remote>`: `expose` provides Local, `getAPI()` returns
    // Remote. This test plays the SHELL, so it exposes `ShellSysAPI.ready` (what
    // the host calls) and drives `HostStdioAPI.ping/stop` (what the host serves)
    // — production is the mirror image (`stdio.ts` uses
    // `<HostStdioAPI, ShellSysAPI>` because the host is the one exposing).
    //
    // Only `ready` is implemented: the host never calls notify/dialog/window in
    // this scenario, so stubbing seven unused RPCs would be noise that could
    // itself drift. The cast is the same pattern
    // `hands-e2e-integration.test.ts` uses for its partial shell bridge.
    expose: {
      // `info` is annotated rather than inferred: the `as unknown as` cast below
      // erases the contextual type from this callback, so without it the
      // parameter is an implicit `any` (TS7006 under `strict`).
      async ready(info: HostWsReady) {
        resolveReady(info)
      },
    } as unknown as ShellSysAPI,
  })
  const host = channel.getAPI()

  const info = await ready
  expect(info.port).toBeGreaterThan(0)
  expect(info.token).toMatch(/^[0-9a-f]{64}$/)
  expect(await host.ping()).toBe("pong")
  expect(await host.stop()).toBe(true)

  const code = await new Promise<number | null>((resolve) => {
    if (!child) throw new Error("test did not spawn a host")
    child.once("exit", (exitCode) => resolve(exitCode))
  })
  expect(code).toBe(0)
  channel.destroy()
})
