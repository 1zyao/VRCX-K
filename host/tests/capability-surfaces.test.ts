/**
 * Pin the capability INVENTORY against the RUNNING host.
 *
 * `capabilityInventory.ts` is only a single source of truth if something fails
 * when it disagrees with reality. Otherwise it is just a third hand-written copy
 * of the same list, with better intentions.
 *
 * This boots the real services the way `host/src/index.ts` does and asserts every
 * declared service is actually retrievable from the context. If someone renames
 * or drops a service, the inventory stops matching and this fails — rather than a
 * plugin later discovering that a capability it declared cannot be resolved.
 */
import { describe, expect, test } from "bun:test"
import { Context } from "cordis"
import { createShellCapabilities, ShellHandle } from "../src/capability"
import {
  HANDS_PRIMITIVES,
  HOST_SERVICES,
  REQUESTABLE_CAPABILITIES,
  SHELL_SUBDOMAINS,
} from "../src/contracts/capabilityInventory"
import { HandsService } from "../src/hands"
import { AutostartService } from "../src/shell-extras"
import { ShortcutService } from "../src/shortcut"
import { ShutdownSignal } from "../src/signal"
import { TrayService } from "../src/tray"

/** Build a context carrying exactly the services the host provides at boot. */
function bootServices(): Context {
  const ctx = new Context()
  // Mirrors host/src/index.ts: provide the shutdown signal, construct the
  // Service subclasses, then register the capability surface.
  ctx.provide("signal", new ShutdownSignal())
  new TrayService(ctx, { log: () => {} })
  new ShortcutService(ctx, { log: () => {} })
  new HandsService(ctx, {})
  new AutostartService(ctx)
  createShellCapabilities(ctx, new ShellHandle(() => {}))
  return ctx
}

describe("declared capabilities really exist at runtime", () => {
  test("every HOST_SERVICE is resolvable from the context", () => {
    const ctx = bootServices()
    for (const name of HOST_SERVICES) {
      expect(ctx.get(name), `service "${name}" is declared but not provided`).toBeTruthy()
    }
  })

  test("every REQUESTABLE_CAPABILITY is a HOST_SERVICE and is resolvable", () => {
    const ctx = bootServices()
    for (const name of REQUESTABLE_CAPABILITIES) {
      expect(HOST_SERVICES as readonly string[]).toContain(name)
      expect(ctx.get(name), `capability "${name}" cannot be requested: not provided`).toBeTruthy()
    }
  })

  test("the raw ctx.shell mirror exposes exactly the declared sub-domains", () => {
    const ctx = bootServices()
    const shell = ctx.get("shell") as unknown as Record<string, unknown>
    // `Service` adds own `ctx`/`name`; every other own key is a mirror entry.
    const keys = Object.getOwnPropertyNames(shell)
      .filter((key) => key !== "ctx" && key !== "name")
      .sort()
    expect(keys).toEqual([...SHELL_SUBDOMAINS].sort())
  })

  test("ctx.hands exposes exactly the declared primitives", () => {
    // The inventory's HANDS_PRIMITIVES is only a single source of truth if
    // something fails when the service drifts from it. A renamed or dropped
    // primitive would otherwise let a plugin request a permission that cannot be
    // satisfied — the same failure this whole file exists to prevent.
    const ctx = bootServices()
    const hands = ctx.get("hands") as unknown as Record<string, unknown>
    // Walk to the prototype: the methods are class methods, so they are not
    // own properties of the per-caller shadow.
    const all = Object.getOwnPropertyNames(Object.getPrototypeOf(hands) as object).filter(
      (key) => key !== "constructor",
    )

    // ⚠ WHY THIS IS NOT JUST A FILTERED COMPARISON.
    //
    // The first version was `getOwnPropertyNames(...).filter(in HANDS_PRIMITIVES)` compared
    // to the inventory. That is **one-directional**: because the filter discards everything
    // not already in the list, a `hands.delete()` added to the service would be filtered
    // out and the test would stay green — so the "single source of truth" claim went
    // unenforced in the direction that matters most (a NEW capability becoming reachable
    // without a manifest grant key).
    //
    // Wiring methods are legitimately not primitives, but they must be named EXPLICITLY
    // rather than dropped by a filter, so that adding a method fails this test until
    // someone decides which bucket it belongs in.
    //
    // ⚠ This list caught two REAL findings when it was first tightened:
    //   · `api` — a `private get` returning the RAW bridge API. Reachable at runtime
    //     (accessors live on the prototype and fire through the Cordis per-caller shadow),
    //     and reaching it skips `record()`: no `[cap]` audit line, no `#24` warning.
    //     Now a module-level `rawApi()`; see `hands.ts`.
    //   · `record` — likewise reachable, and worse: a plugin could call it to WRITE
    //     arbitrary `[cap]` lines into the audit log. Now module-level `record()`.
    // `guarded`/`registerGuard` stay as members on purpose: they are not an escalation (a
    // plugin can already do the same with `ctx.effect`) and the `private` modifier would
    // only imply a boundary that does not exist.
    const WIRING = [
      "useManifests",
      "attachShell",
      "detachShell",
      "attached",
      "guarded",
      "registerGuard",
    ]
    const unexpected = all.filter(
      (key) => !(HANDS_PRIMITIVES as readonly string[]).includes(key) && !WIRING.includes(key),
    )
    expect(
      unexpected,
      `neither a declared primitive nor listed wiring, so a plugin could reach it with no ` +
        `manifest grant key: ${unexpected.join(", ")}. Add it to HANDS_PRIMITIVES (and the ` +
        `schema) or to WIRING with a reason.`,
    ).toEqual([])

    // The other direction: every declared primitive must actually exist.
    for (const primitive of HANDS_PRIMITIVES) {
      expect(all, `the inventory declares \`${primitive}\` but the service lacks it`).toContain(
        primitive,
      )
    }

    // Anti-vacuous: a walk that found nothing would satisfy both checks above trivially.
    expect(all.length, "the prototype walk found no methods at all").toBeGreaterThan(0)
  })
})
