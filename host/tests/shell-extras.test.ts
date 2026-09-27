// `ctx.autostart` — the desktop-only "start with the system" capability.
//
// Why it is a `Service` at all (and `os`/`clipboard` are not): it has to tell
// "the shell is not attached yet" apart from "this platform has no such route".
// The first is a waiting state that resolves; the second never will. A UI that
// offers a toggle has to know which it is looking at, and a plain pass-through
// mirror cannot express the difference — it would collapse both into `false`.
//
// The rules pinned here, each with the failure it prevents:
//   1. Nothing enables autostart at boot — the user owns that decision.
//   2. `setEnabled` reports a verdict, never throws.
//   3. Mobile ("unsupported") stays distinguishable from "no shell".

import { describe, expect, test } from "bun:test"
import { Context } from "cordis"
import { AutostartService } from "../src/shell-extras"
import type { ShellStdioBridge } from "../src/stdio"

/** A service with a scripted shell bridge. */
function serviceWith(autostart?: ShellStdioBridge["shell"]["autostart"]): {
  ctx: Context
  svc: AutostartService
} {
  const ctx = new Context()
  const svc = new AutostartService(ctx)
  svc.attachShell({
    shell: autostart ? { autostart } : {},
  } as unknown as ShellStdioBridge)
  return { ctx, svc }
}

describe("autostart never turns itself on", () => {
  test("attaching a shell does not enable autostart", async () => {
    // The shell provides the MECHANISM; whether the app launches with the system
    // is the user's decision. If attaching ever started calling `setEnabled(true)`
    // this fails — which is the point, because that would be a silent
    // system-level change made on the user's behalf.
    let enableCalls = 0
    const { svc } = serviceWith({
      isEnabled: async () => false,
      setEnabled: async () => {
        enableCalls += 1
        return { ok: true }
      },
    })
    await Promise.resolve()
    expect(enableCalls).toBe(0)
    expect(await svc.isEnabled()).toBe(false)
  })
})

describe("setEnabled reports a verdict instead of throwing", () => {
  test("a successful change reports ok", async () => {
    const { svc } = serviceWith({
      isEnabled: async () => false,
      setEnabled: async () => ({ ok: true }),
    })
    expect(await svc.setEnabled(true)).toEqual({ status: "ok" })
  })

  test("an OS refusal carries the reason", async () => {
    // "The OS refused to register" is actionable (show it), whereas a bare
    // `false` is indistinguishable from "the user asked for off".
    const { svc } = serviceWith({
      isEnabled: async () => false,
      setEnabled: async () => ({ ok: false, error: "access denied" }),
    })
    expect(await svc.setEnabled(true)).toEqual({ status: "error", error: "access denied" })
  })

  test("a thrown bridge error becomes a verdict, not an exception", async () => {
    const { svc } = serviceWith({
      isEnabled: async () => false,
      setEnabled: async () => {
        throw new Error("pipe broke")
      },
    })
    expect(await svc.setEnabled(true)).toEqual({ status: "error", error: "pipe broke" })
  })

  test("a refusal with no message still names the outcome", async () => {
    const { svc } = serviceWith({
      isEnabled: async () => false,
      setEnabled: async () => ({ ok: false }),
    })
    expect(await svc.setEnabled(false)).toEqual({ status: "error", error: "refused" })
  })
})

describe("no-shell and unsupported are different answers", () => {
  test("with no shell attached the verdict is no-shell", async () => {
    const ctx = new Context()
    const svc = new AutostartService(ctx)
    expect(await svc.setEnabled(true)).toEqual({ status: "no-shell" })
    expect(svc.attached).toBe(false)
  })

  test("on a platform without the route the verdict is unsupported", async () => {
    // The shell registers no `shell.autostart.*` on mobile. Reporting
    // "unsupported" is the difference between "try again later" and "this will
    // never work here" — a toggle must not look merely disabled forever.
    const { svc } = serviceWith(undefined)
    expect(await svc.setEnabled(true)).toEqual({ status: "unsupported" })
    expect(svc.supported).toBe(false)
    expect(svc.attached).toBe(true)
  })

  test("isEnabled is false in every unavailable case, without throwing", async () => {
    const bare = new AutostartService(new Context())
    expect(await bare.isEnabled()).toBe(false)
    const { svc } = serviceWith(undefined)
    expect(await svc.isEnabled()).toBe(false)
  })

  test("detaching returns the service to no-shell", async () => {
    const { svc } = serviceWith({
      isEnabled: async () => true,
      setEnabled: async () => ({ ok: true }),
    })
    expect(await svc.isEnabled()).toBe(true)
    svc.detachShell()
    expect(await svc.isEnabled()).toBe(false)
    expect(await svc.setEnabled(true)).toEqual({ status: "no-shell" })
  })
})

describe("autostart is attributed like every other capability", () => {
  test("a plugin's setEnabled call is reachable and resolves", async () => {
    const ctx = new Context()
    const svc = new AutostartService(ctx)
    svc.attachShell({
      shell: {
        autostart: {
          isEnabled: async () => false,
          setEnabled: async () => ({ ok: true }),
        },
      },
    } as unknown as ShellStdioBridge)

    // ⚠ `ctx.plugin()` resolves to the FIBER, not the callback's return value —
    // awaiting it and asserting on the result stringifies a cyclic structure.
    // The verdict is captured in a closure instead.
    let verdict: unknown
    await ctx.plugin(function togglePlugin(inner: Context) {
      void inner.autostart.setEnabled(true).then((result) => {
        verdict = result
      })
    })
    // Let the fire-and-forget promise settle.
    for (let i = 0; i < 50 && verdict === undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    expect(verdict).toEqual({ status: "ok" })
  })
})
