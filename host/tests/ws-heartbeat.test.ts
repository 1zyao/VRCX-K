import { afterEach, beforeAll, expect, test } from "bun:test"
import { join } from "node:path"
import { dispose, wrap } from "kkrpc"
import { webSocketClientTransport } from "kkrpc/ws"
import type { HostWsAPI } from "../src/api"
import { HOST_VERSION } from "../src/api"
import {
  drain,
  HOST_SPAWN_DETACHED,
  killTree,
  pipe,
  readReady,
  resolveBun,
  warmBun,
} from "./helpers"

const hostDir = join(import.meta.dir, "..")
const bun = resolveBun()

beforeAll(async () => {
  await warmBun()
}, 60_000)

type HostProc = ReturnType<typeof Bun.spawn>

let proc: HostProc | undefined

afterEach(() => {
  if (proc) killTree(proc.pid)
  proc = undefined
})

async function spawnHost() {
  proc = Bun.spawn([bun, "src/index.ts"], {
    cwd: hostDir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // POSIX: host becomes its own process-group leader (setsid), so
    // killTree's kill(-pid) reaps it in one signal (Rust-shell parity).
    // Windows: NOT detached (#33) — probe10 measured a detached host
    // outliving its parent 8/8; non-detached ties it to the runner's job
    // object so an interrupted run reaps it.
    detached: HOST_SPAWN_DETACHED,
  })
  const ready = await readReady(pipe(proc.stderr, "stderr"))
  return { proc, ready }
}

test("host ws ping and getVersion", async () => {
  const { proc: child, ready } = await spawnHost()
  expect(ready.port).toBeGreaterThan(0)
  expect(ready.token).toMatch(/^[0-9a-f]{64}$/)
  expect(ready.hostVersion).toBe(HOST_VERSION)

  const stdout = await drain(pipe(child.stdout, "stdout"))
  expect(stdout).toBe("")

  const api = wrap<HostWsAPI>(
    webSocketClientTransport({
      url: `ws://127.0.0.1:${ready.port}?token=${ready.token}`,
    }),
  )
  expect(await api.ping()).toBe("pong")
  expect(await api.getVersion()).toBe(HOST_VERSION)
  dispose(api)
})

test("wrong cwd cannot assemble cordis.yml and exits non-zero", async () => {
  proc = Bun.spawn([bun, join(hostDir, "src/index.ts")], {
    cwd: import.meta.dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const code = await proc.exited
  const stderr = await new Response(pipe(proc.stderr, "stderr")).text()
  expect(code).not.toBe(0)
  expect(stderr).toContain("fatal bootstrap error")
  expect(stderr).toMatch(/config file not found|heartbeat plugin failed/)
  proc = undefined
})

test("host ws rejects a wrong token", async () => {
  const { ready } = await spawnHost()
  const socket = new WebSocket(`ws://127.0.0.1:${ready.port}?token=wrong`)
  const closed = await new Promise<{ code: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket did not close")), 5000)
    socket.addEventListener("close", (event) => {
      clearTimeout(timer)
      resolve({ code: event.code })
    })
    socket.addEventListener("error", () => {})
  })
  expect(closed.code).toBe(1008)
})
