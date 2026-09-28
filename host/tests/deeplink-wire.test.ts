// Wire-level test of the shell → host `deepLink.opened` notification (issue #41 gap ④).
//
// ⚠ The case this file exists for is the STARTUP WINDOW, and it is a measured one, not a
// hypothetical: on macOS the URL that LAUNCHES the app arrives after the host's expose table
// exists but BEFORE `ctx.deepLink` subscribes to the notification, so a plain fan-out emitted
// it into an empty handler set and the activation vanished — with nothing in any log. The host
// half of that fix is `fanout(..., { retainUntilSubscribed: true })`; this file pins it.
//
// The hand-built frames assert the COMPACT protocol shape of the pinned `kkrpc 2.1.0`, the
// same shape `src-tauri/src/kkrpc_peer.rs` speaks (mirrors `shortcut-wire.test.ts`).
import { describe, expect, test } from "bun:test"
import type { RPCMessage, Transport } from "kkrpc"
import { connectShellStdio, type DeepLinkEvent } from "../src/stdio"

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function memoryTransport() {
  const sent: RPCMessage[] = []
  let listener: ((message: RPCMessage) => void) | undefined
  const transport: Transport<RPCMessage> = {
    send(message) {
      sent.push(message)
    },
    subscribe(next) {
      listener = next
      return () => {
        listener = undefined
      }
    },
  }
  return {
    transport,
    sent,
    /** Deliver one frame as if the Rust shell had sent it. */
    deliver(message: unknown) {
      listener?.(message as RPCMessage)
    },
  }
}

/** One `deepLink.opened` notification, exactly as the shell sends it. */
function openedFrame(id: string, urls: string[]) {
  return { t: "q", id, op: "call", p: ["deepLink", "opened"], a: [{ urls }] }
}

describe("host ↔ shell deep-link notification", () => {
  test("a URL that arrives BEFORE any subscriber is handed to the first one", async () => {
    const wire = memoryTransport()
    const bridge = connectShellStdio({} as never, { transport: wire.transport })

    // ⚠ The startup window: the shell notifies, nobody is listening yet.
    wire.deliver(openedFrame("req-1", ["vrcxk://user/usr_1"]))
    await tick()

    const seen: DeepLinkEvent[] = []
    bridge.deepLink.onOpen((event) => seen.push(event))
    expect(
      seen,
      "the activation that arrived during startup must reach the first subscriber — dropping " +
        "it is the behaviour that made a cold-start link do nothing",
    ).toEqual([{ urls: ["vrcxk://user/usr_1"] }])
  })

  test("it is handed over ONCE: a second subscriber does not get a duplicate", async () => {
    const wire = memoryTransport()
    const bridge = connectShellStdio({} as never, { transport: wire.transport })
    wire.deliver(openedFrame("req-1", ["vrcxk://user/usr_1"]))
    await tick()

    const first: DeepLinkEvent[] = []
    const second: DeepLinkEvent[] = []
    bridge.deepLink.onOpen((event) => first.push(event))
    bridge.deepLink.onOpen((event) => second.push(event))
    expect(first.length, "the retained activation goes to the first subscriber").toBe(1)
    expect(
      second.length,
      "the retention is a startup HANDOFF, not a replay queue: a second subscriber must not " +
        "act on an activation the first one already handled",
    ).toBe(0)
  })

  test("one slot: only the LATEST activation survives the startup window", async () => {
    const wire = memoryTransport()
    const bridge = connectShellStdio({} as never, { transport: wire.transport })
    wire.deliver(openedFrame("req-1", ["vrcxk://user/old"]))
    wire.deliver(openedFrame("req-2", ["vrcxk://user/new"]))
    await tick()

    const seen: DeepLinkEvent[] = []
    bridge.deepLink.onOpen((event) => seen.push(event))
    expect(seen).toEqual([{ urls: ["vrcxk://user/new"] }])
  })

  test("once subscribed, every activation fans out as usual", async () => {
    const wire = memoryTransport()
    const bridge = connectShellStdio({} as never, { transport: wire.transport })
    const seen: string[] = []
    bridge.deepLink.onOpen((event) => seen.push(...event.urls))

    wire.deliver(openedFrame("req-1", ["vrcxk://user/usr_1"]))
    wire.deliver(openedFrame("req-2", ["vrcxk://world/wrld_2", "vrcxk://world/wrld_3"]))
    await tick()

    expect(seen).toEqual(["vrcxk://user/usr_1", "vrcxk://world/wrld_2", "vrcxk://world/wrld_3"])
  })

  test("a throwing subscriber does not stop the others or break the channel", async () => {
    const wire = memoryTransport()
    const bridge = connectShellStdio({} as never, { transport: wire.transport })
    const errors: unknown[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => errors.push(args)
    try {
      const reached: string[] = []
      bridge.deepLink.onOpen(() => {
        throw new Error("boom")
      })
      bridge.deepLink.onOpen((event) => reached.push(event.urls[0] ?? ""))
      wire.deliver(openedFrame("req-1", ["vrcxk://user/usr_1"]))
      await tick()
      expect(reached).toEqual(["vrcxk://user/usr_1"])
      expect(errors.length).toBeGreaterThan(0)
    } finally {
      console.error = originalError
    }
  })

  test("the unregister route reaches the shell and its verdict comes back", async () => {
    const wire = memoryTransport()
    const bridge = connectShellStdio({} as never, { transport: wire.transport })
    expect(typeof bridge.deepLink.unregister).toBe("function")

    const result = bridge.deepLink.unregister?.("vrcxk")
    // Reply to the pending call the way the Rust route does.
    await tick()
    const call = wire.sent.find((message) => (message as { op?: string }).op === "call")
    expect(call).toBeDefined()
    wire.deliver({
      t: "r",
      id: (call as { id: string }).id,
      op: "resolve",
      v: { ok: true, scheme: "vrcxk", removed: true },
    })
    expect(await result).toEqual({ ok: true, scheme: "vrcxk", removed: true })
  })
})
