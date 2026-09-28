// End-to-end regression tests for the overreach warning of the three "curated
// services" (#24).
//
// Why this file exists on its own: `overreach.test.ts` pins **the rule itself**
// (checkGrant / findOverreach / formatOverreach), the raw `ctx.shell.*` escape
// hatch, and the one curated-service path `ctx.hands`. This file is dedicated to
// the other three parallel curated-service paths —
// `ctx.tray` / `ctx.shortcut` / `ctx.autostart`.
//
// ⚠ The silent failure this file has to hold back (that — not "nicer coverage" —
//   is the reason it exists): these three call sites have **never been asserted on
//   by any test**. `overreachWarning` lives only in their respective `record()`,
//   with no compile-time or runtime enforcement whatsoever — that is, you can
//   **delete those three lines outright** and the whole `bun run test` still stays
//   green. And the consequences are asymmetric:
//     - `ctx.autostart.setEnabled` writes a **persisted startup entry**;
//     - `ctx.shortcut.register` takes over a **global hotkey**;
//     - `ctx.tray.setGroups` replaces the **OS tray menu**.
//   All three are actions "a plugin can only perform by requesting the capability",
//   and `permissions` carries a matching grant key for each of them
//   (`autostart` / `shortcut` / `tray`). Once the warning line is deleted, a plugin
//   that never declared these capabilities in its manifest calling them becomes
//   **completely indistinguishable** from one that did declare them — exactly the
//   silence #24 set out to eliminate with "declared vs. actual".
//
// ⚠ So each service gets two cases: one "declared ⇒ must not warn" (anti-noise: a
//   check that always warns is no check at all), and one "not declared ⇒ must warn"
//   (anti-miss, i.e. the deletion experiment above). Without either one, this check
//   could degrade into a constant while staying green.
//
// ⚠ Reuse the shape of `runThroughLoader` from `overreach.test.ts` instead of
//   building a second one: a bare `ctx.plugin()` **cannot test this** (no
//   `fiber.entry` ⇒ `callerEntryId` returns `undefined` ⇒ the check is skipped by
//   #24's "host-internal call" rule). It must go through a real loader entry
//   (`cordis.yml` → include → entry) for the plugin to have a manifest it can be
//   compared against.

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import Include from "@cordisjs/plugin-include"
import Loader from "@cordisjs/plugin-loader"
import { Context } from "cordis"
import { createShellCapabilities, ShellHandle } from "../src/capability"
import type { VRCXKPluginManifest } from "../src/contracts/pluginManifest.generated"
import { DeepLinkService } from "../src/deeplink"
import { HandsService } from "../src/hands"
import { AutostartService } from "../src/shell-extras"
import { ShortcutService } from "../src/shortcut"
import type {
  ShellShortcutBridge,
  ShellStdioBridge,
  ShortcutRegistration,
  TraySetSnapshotResult,
} from "../src/stdio"
import { TrayService } from "../src/tray"
import type { TrayGroup, TrayMenuSnapshot } from "../src/tray-contract.generated"

function manifest(permissions?: Record<string, unknown>): VRCXKPluginManifest {
  return {
    id: "probe-plugin",
    version: "0.0.1",
    author: "test",
    name: "Probe",
    ...(permissions ? { permissions } : {}),
  } as unknown as VRCXKPluginManifest
}

/**
 * The smallest tray group that can actually run: contract validation
 * (source=host/plugin) must accept it.
 */
function trayGroup(id: string): TrayGroup {
  return { id, order: 0, label: null, visible: true, source: "plugin", items: [] }
}

/**
 * A fake stdio bridge that "swallows any call".
 *
 * All three services keep their books **before doing any real work** (`record()`
 * is the very first thing in each method body), but so that the semantics "a
 * rejected / failed call must also leave a warning behind" holds too, this bridge
 * always returns success: that way the warning cannot come from a failure path —
 * it can only come from `record()` itself.
 */
function fakeBridge() {
  const shortcutCalls: string[] = []
  const shortcutBridge: ShellShortcutBridge = {
    async register(accelerator: string): Promise<ShortcutRegistration> {
      shortcutCalls.push(`register:${accelerator}`)
      return { ok: true, accelerator }
    },
    async unregister(accelerator: string): Promise<ShortcutRegistration> {
      shortcutCalls.push(`unregister:${accelerator}`)
      return { ok: true, accelerator }
    },
    onPress() {
      return () => {}
    },
  }
  const trayPushes: TrayMenuSnapshot[] = []
  const trayPush = async (snapshot: TrayMenuSnapshot): Promise<TraySetSnapshotResult> => {
    trayPushes.push(snapshot)
    return { ok: true, revision: snapshot.revision }
  }
  const autostartCalls: boolean[] = []
  const deepLinkBridge = {
    onOpen() {
      return () => {}
    },
    async unregister(scheme: string) {
      return { ok: true, scheme, removed: true }
    },
  }
  const base = {
    tray: { setSnapshot: trayPush },
    shortcut: shortcutBridge,
    deepLink: deepLinkBridge,
    shell: {
      autostart: {
        isEnabled: async () => false,
        setEnabled: async (enabled: boolean) => {
          autostartCalls.push(enabled)
          return { ok: true }
        },
      },
    },
  }
  return {
    bridge: base as unknown as ShellStdioBridge,
    trayPush,
    shortcutCalls,
    autostartCalls,
    get trayPushes() {
      return trayPushes
    },
  }
}

type Surface = "tray" | "shortcut" | "autostart" | "deepLink"

/**
 * Run one plugin call through a **real loader entry**, and collect the service's
 * own callback lines.
 *
 * Same shape as `runThroughLoader` in `overreach.test.ts` (real loader entry +
 * real manifest lookup + real ShellHandle audit slot); only two things differ:
 *   1. only the one service under test is constructed here;
 *   2. audit lines go straight into an array instead of through the log pipeline —
 *      what is asserted is "did the service produce this line".
 */
async function runServiceThroughLoader(
  surface: Surface,
  declared: Record<string, unknown> | undefined,
  source: string,
): Promise<{
  audits: string[]
  pushes: TrayMenuSnapshot[]
  shortcutCalls: string[]
  autostartCalls: boolean[]
}> {
  const root = await mkdtemp(join(tmpdir(), `vrcxk-overreach-${surface}-`))
  await mkdir(join(root, "plugins"), { recursive: true })
  await writeFile(join(root, "plugins", "probe.ts"), source)
  await writeFile(join(root, "cordis.yml"), "- id: probe\n  name: ./plugins/probe.ts\n")

  const audits: string[] = []
  const fake = fakeBridge()
  const ctx = new Context()
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  const handle = new ShellHandle((line) => audits.push(line))
  handle.attach(fake.bridge)
  // Same as production: the registry is indexed by the **stable suffix** of
  // entry.id (`manifestRegistryOf(ctx).get(entryId)`). `declared === undefined`
  // means "this plugin registered no manifest at all" — in that case any warning
  // is noise, while the `[cap]` audit line must still appear as usual
  // (transparency does not depend on the manifest).
  const lookup = (entryId: string) =>
    entryId.endsWith(":probe") && declared ? manifest(declared) : undefined
  handle.useManifests(lookup)
  createShellCapabilities(ctx, handle)

  if (surface === "tray") {
    const tray = new TrayService(ctx, {
      push: fake.trayPush,
      log: (line) => audits.push(line),
    })
    tray.useManifests(lookup)
  } else if (surface === "shortcut") {
    const shortcut = new ShortcutService(ctx, {
      bridge: fake.bridge.shortcut,
      log: (line) => audits.push(line),
    })
    shortcut.useManifests(lookup)
  } else if (surface === "autostart") {
    const autostart = new AutostartService(ctx, { audit: (line) => audits.push(line) })
    autostart.attachShell(fake.bridge)
    autostart.useManifests(lookup)
  } else {
    const deepLink = new DeepLinkService(ctx, {
      bridge: fake.bridge.deepLink,
      log: (line) => audits.push(line),
    })
    deepLink.useManifests(lookup)
  }

  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({
    name: "cordis:include",
    config: { path: "./cordis.yml", enableLogs: false },
  })

  // Wait for the call to land (the `[cap]` audit line is the accounting evidence
  // common to all curated services), then wait one more tick so that async tails
  // such as the tray push have run to completion.
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline && !audits.some((line) => line.includes("[cap]"))) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  await new Promise((resolve) => setTimeout(resolve, 100))
  await rm(root, { recursive: true, force: true }).catch(() => {})
  return {
    audits,
    pushes: fake.trayPushes,
    shortcutCalls: fake.shortcutCalls,
    autostartCalls: fake.autostartCalls,
  }
}

describe("undeclared calls to ctx.tray / ctx.shortcut / ctx.autostart must warn (#24)", () => {
  test("ctx.tray.setGroups: warns when tray is undeclared", async () => {
    // The tray menu is OS-level visible state, and `permissions.tray` is a
    // declarable grant key. The declaration grants only `os`, so `tray.setGroups`
    // is undeclared — and the warning must name `tray`.
    const result = await runServiceThroughLoader(
      "tray",
      { os: true },
      `export function apply(ctx: any) {
         void ctx.tray.setGroups([{
           id: "plugin.probe", order: 0, label: null, visible: true, source: "plugin", items: [],
         }])
       }\n`,
    )
    const warn = result.audits.find((line) => line.includes("overreach"))
    expect(warn, "an undeclared ctx.tray.setGroups must produce an overreach warning").toBeDefined()
    expect(warn).toContain("tray.setGroups")
    expect(warn).toContain("`tray`")
    expect(warn).toContain("does not declare")
    // Also pin "it really did push the menu to the shell": this one is not about
    // the warning, it guarantees that the warning above was not produced on a path
    // that did nothing at all.
    expect(result.pushes.length).toBeGreaterThanOrEqual(1)
  }, 20_000)

  test("ctx.tray.setGroups: declared tray ⇒ no warning (anti-noise control)", async () => {
    // A check that also warns on a correct declaration is a check that trains
    // warnings into background noise. This case is the counterpart of the one
    // above: it guarantees that the warning above really comes from "the
    // declaration is missing", not from the tray path warning unconditionally.
    const result = await runServiceThroughLoader(
      "tray",
      { tray: true },
      `export function apply(ctx: any) {
         void ctx.tray.setGroups([{
           id: "plugin.probe", order: 0, label: null, visible: true, source: "plugin", items: [],
         }])
       }\n`,
    )
    expect(result.audits.some((line) => line.includes("[cap]"))).toBe(true)
    expect(result.audits.some((line) => line.includes("overreach"))).toBe(false)
    expect(result.pushes.length).toBeGreaterThanOrEqual(1)
  }, 20_000)

  test("ctx.shortcut.register: warns when shortcut is undeclared", async () => {
    // A global hotkey: once the registration succeeds, no log whatsoever can tell
    // "a plugin that declared it" apart from "a plugin that did not" — unless that
    // line inside record() exists.
    const result = await runServiceThroughLoader(
      "shortcut",
      { os: true },
      `export function apply(ctx: any) {
         void ctx.shortcut.register("CommandOrControl+Shift+K", () => {})
       }\n`,
    )
    const warn = result.audits.find((line) => line.includes("overreach"))
    expect(
      warn,
      "an undeclared ctx.shortcut.register must produce an overreach warning",
    ).toBeDefined()
    expect(warn).toContain("shortcut.register")
    expect(warn).toContain("`shortcut`")
    // The hotkey registration really reached the bridge (the service is not idling).
    expect(result.shortcutCalls).toContain("register:CommandOrControl+Shift+K")
  }, 20_000)

  test("ctx.shortcut.register: declared shortcut ⇒ no warning (anti-noise control)", async () => {
    const result = await runServiceThroughLoader(
      "shortcut",
      { shortcut: true },
      `export function apply(ctx: any) {
         void ctx.shortcut.register("CommandOrControl+Shift+K", () => {})
       }\n`,
    )
    expect(result.audits.some((line) => line.includes("[cap]"))).toBe(true)
    expect(result.audits.some((line) => line.includes("overreach"))).toBe(false)
    expect(result.shortcutCalls).toContain("register:CommandOrControl+Shift+K")
  }, 20_000)

  test("ctx.autostart.setEnabled: warns when autostart is undeclared", async () => {
    // The heaviest one: `setEnabled` writes a **persisted startup entry**, which is
    // still in effect after a reboot. A plugin that never wrote `autostart` into its
    // manifest doing this with nothing at all in the log is the direct
    // counterexample to what #24 calls "unexpected overreach must be visible".
    const result = await runServiceThroughLoader(
      "autostart",
      { os: true },
      `export function apply(ctx: any) {
         void ctx.autostart.setEnabled(true).catch(() => {})
       }\n`,
    )
    const warn = result.audits.find((line) => line.includes("overreach"))
    expect(
      warn,
      "an undeclared ctx.autostart.setEnabled must produce an overreach warning",
    ).toBeDefined()
    expect(warn).toContain("autostart.setEnabled")
    expect(warn).toContain("`autostart`")
    // The key evidence against idling: this call **really reached the shell's
    // persisted-write path**. Without this, "there is a warning" might have been
    // produced on an early-return branch that did no work. It also confirms that
    // the warning is not "only reported on failure" — the setEnabled here succeeds.
    expect(result.autostartCalls).toEqual([true])
  }, 20_000)

  test("ctx.autostart.setEnabled: declared autostart ⇒ no warning (anti-noise control)", async () => {
    const result = await runServiceThroughLoader(
      "autostart",
      { autostart: true },
      `export function apply(ctx: any) {
         void ctx.autostart.setEnabled(true).catch(() => {})
       }\n`,
    )
    expect(result.audits.some((line) => line.includes("[cap]"))).toBe(true)
    expect(result.audits.some((line) => line.includes("overreach"))).toBe(false)
    // The control group likewise has to prove the call really reached the service:
    // otherwise "no warning" might simply be because nothing happened at all.
    expect(result.autostartCalls).toEqual([true])
  }, 20_000)

  test("ctx.deepLink.onUrl: warns when deepLink is undeclared", async () => {
    // The fourth curated service (issue #41 gap ④). It is the mildest of the four in
    // isolation — subscribing to URLs writes nothing — but it is the one that makes an
    // activation OBSERVABLE, so an undeclared subscriber is exactly the case #24 exists to
    // surface: without the warning, a plugin reacting to `vrcxk://…` is indistinguishable
    // from one that never touched the capability.
    const result = await runServiceThroughLoader(
      "deepLink",
      { os: true },
      `export function apply(ctx: any) {
         ctx.deepLink.onUrl(() => {})
       }\n`,
    )
    const warn = result.audits.find((line) => line.includes("overreach"))
    expect(warn, "an undeclared ctx.deepLink.onUrl must produce an overreach warning").toBeDefined()
    expect(warn).toContain("deepLink.onUrl")
    expect(warn).toContain("`deepLink`")
  }, 20_000)

  test("ctx.deepLink.onUrl: declared deepLink ⇒ no warning (anti-noise control)", async () => {
    const result = await runServiceThroughLoader(
      "deepLink",
      { deepLink: true },
      `export function apply(ctx: any) {
         ctx.deepLink.onUrl(() => {})
       }\n`,
    )
    expect(result.audits.some((line) => line.includes("[cap]"))).toBe(true)
    expect(result.audits.some((line) => line.includes("overreach"))).toBe(false)
  }, 20_000)

  test("all three services only record, never warn, when the plugin has no manifest", async () => {
    // #24 is explicit: if nothing was ever promised, there is nothing to violate.
    // Warning on a plugin that has no manifest is noise, and it turns "warnings"
    // into something nobody reads. This case also guards the opposite direction —
    // when someone removes `if (!manifest) return undefined` from
    // `overreachWarning`, this goes red.
    const tray = await runServiceThroughLoader(
      "tray",
      undefined,
      `export function apply(ctx: any) {
         void ctx.tray.setGroups([{
           id: "plugin.probe", order: 0, label: null, visible: true, source: "plugin", items: [],
         }])
       }\n`,
    )
    expect(tray.audits.some((line) => line.includes("[cap]"))).toBe(true)
    expect(tray.audits.some((line) => line.includes("overreach"))).toBe(false)

    const shortcut = await runServiceThroughLoader(
      "shortcut",
      undefined,
      `export function apply(ctx: any) {
         void ctx.shortcut.register("CommandOrControl+Shift+K", () => {})
       }\n`,
    )
    expect(shortcut.audits.some((line) => line.includes("[cap]"))).toBe(true)
    expect(shortcut.audits.some((line) => line.includes("overreach"))).toBe(false)

    const autostart = await runServiceThroughLoader(
      "autostart",
      undefined,
      `export function apply(ctx: any) {
         void ctx.autostart.setEnabled(true).catch(() => {})
       }\n`,
    )
    expect(autostart.audits.some((line) => line.includes("[cap]"))).toBe(true)
    expect(autostart.audits.some((line) => line.includes("overreach"))).toBe(false)

    const deepLink = await runServiceThroughLoader(
      "deepLink",
      undefined,
      `export function apply(ctx: any) {
         ctx.deepLink.onUrl(() => {})
       }\n`,
    )
    expect(deepLink.audits.some((line) => line.includes("[cap]"))).toBe(true)
    expect(deepLink.audits.some((line) => line.includes("overreach"))).toBe(false)
  }, 30_000)

  test("calls outside a narrow grant are reported as out-of-scope (not undeclared)", async () => {
    // Complementary to the pure-function case in overreach.test.ts: that one pins
    // the wording, this one pins that the wording arriving **on the service path**
    // really is the same wording. The two call for different fixes (add the
    // capability vs. widen the list), so they cannot be merged into one sentence.
    const result = await runServiceThroughLoader(
      "tray",
      // The `tray` key exists but the list does not contain this entry — that is
      // "declared, but not in scope".
      { tray: [] },
      `export function apply(ctx: any) {
         void ctx.tray.setGroups([{
           id: "plugin.probe", order: 0, label: null, visible: true, source: "plugin", items: [],
         }])
       }\n`,
    )
    const warn = result.audits.find((line) => line.includes("overreach"))
    expect(warn).toBeDefined()
    expect(warn).toContain("declares `tray` but not this entry")
  }, 20_000)

  test("with no manifest lookup wired in, none of the three services warns (unwired ≠ plugin overreach)", async () => {
    // Same origin as the last case in `overreach.test.ts`: `overreachWarning`'s
    // `if (!lookup)` early return is **deliberate**. No registry means "the
    // manifest has not been read yet", not "this plugin declared nothing". Remove
    // that early return and every unwired host (tests, a shell-less dev mode) warns
    // on every single call.
    const audits: string[] = []
    const fake = fakeBridge()
    const ctx = new Context()
    const handle = new ShellHandle((line) => audits.push(line))
    handle.attach(fake.bridge)
    createShellCapabilities(ctx, handle)
    // None of the three services calls useManifests.
    const tray = new TrayService(ctx, { push: fake.trayPush, log: (line) => audits.push(line) })
    const shortcut = new ShortcutService(ctx, {
      bridge: fake.bridge.shortcut,
      log: (line) => audits.push(line),
    })
    const autostart = new AutostartService(ctx, { audit: (line) => audits.push(line) })
    autostart.attachShell(fake.bridge)
    // The three services really must be constructed (otherwise "no warning" below
    // might simply be because the services were never wired up at all, rather than
    // because the lookup table is absent — which would be another kind of false
    // green).
    expect(tray).toBeInstanceOf(TrayService)
    expect(shortcut).toBeInstanceOf(ShortcutService)
    expect(autostart.attached).toBe(true)

    await ctx.plugin(function unwiredPlugin(inner: Context) {
      const scoped = inner as unknown as {
        tray: { setGroups(groups: TrayGroup[]): Promise<unknown> }
        shortcut: { register(accelerator: string, handler: () => void): Promise<unknown> }
        autostart: { setEnabled(enabled: boolean): Promise<unknown> }
      }
      void scoped.tray.setGroups([trayGroup("plugin.probe")])
      void scoped.shortcut.register("CommandOrControl+Shift+K", () => {})
      void scoped.autostart.setEnabled(true)
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    // All three services kept their books (the calls really went through them)…
    for (const name of ["tray.setGroups", "shortcut.register", "autostart.setEnabled"]) {
      expect(
        audits.some((line) => line.includes(`-> ${name}`)),
        `${name} should have an accounting line`,
      ).toBe(true)
    }
    // …but there is no accusation of any kind.
    expect(audits.some((line) => line.includes("overreach"))).toBe(false)
    expect(tray.revision).toBeGreaterThanOrEqual(1)
  }, 20_000)

  // ---------------------------------------------------------------------------
  // The bridge must not be reachable from a plugin (#40 review, claim 1).
  // ---------------------------------------------------------------------------

  /**
   * ⚠ THE REGRESSION THIS PINS.
   *
   * A TypeScript `private` field is a **compile-time** modifier only. At runtime the
   * property is an ordinary own property, enumerable and readable by anyone holding the
   * service — so `private bridge?: ShellStdioBridge` handed every plugin the WHOLE shell
   * bridge with one property access. Measured by running a real plugin through a real
   * loader entry before the fix:
   *
   *     ctx.hands.bridge = VISIBLE
   *     Object.keys(ctx.hands) = ["ctx","name","bridge","auditLine","manifestLookup"]
   *
   * Three consequences, all of which this test keeps closed:
   *   1. the plugin skips `record()` ⇒ no `[cap]` audit line and no `#24` overreach
   *      warning, so an undeclared capability call becomes invisible;
   *   2. it skips the caller-fiber binding streams depend on ⇒ the
   *      "still producing after unload" leak reopens;
   *   3. the `shell.deepLink.register` narrowing was defeated by a property access.
   * `manifestLookup` leaked for the same reason, letting one plugin read another's
   * declared manifest.
   *
   * ⚠ Assert on the KEYS, not just `bridge === undefined`: a future edit that re-adds
   * the field under a different name (or adds a getter) would still be a leak, and a
   * `bridge`-only assertion would stay green.
   */
  test("a plugin cannot reach the shell bridge through the service instance", async () => {
    const seen: Record<string, unknown> = {}
    const audits: string[] = []
    const root = await mkdtemp(join(tmpdir(), "vrcxk-bridge-leak-"))
    await mkdir(join(root, "plugins"), { recursive: true })
    // `inject` is required for the property read at all (Cordis throws otherwise), and a
    // malicious plugin can declare it freely — which is exactly why the leak mattered.
    await writeFile(
      join(root, "plugins", "probe.ts"),
      `export const name = "probe"
export const inject = ["hands", "shortcut", "autostart"]
export function apply(ctx: any) {
  const g: any = globalThis
  g.__leakProbe = {}
  for (const name of ["hands", "shortcut", "autostart"]) {
    try {
      const svc = ctx[name]
      g.__leakProbe[name + ":keys"] = Object.keys(svc)
      g.__leakProbe[name + ":bridge"] = svc.bridge === undefined ? "undefined" : "VISIBLE"
      // Skip \`ctx\`/\`name\` deliberately: the service's own Cordis context legitimately
      // carries the capabilities namespace, so a "hands" key on it says nothing about a
      // bridge leak. Including it produced a false positive naming all three services.
      for (const key of Object.keys(svc)) {
        if (key === "ctx" || key === "name") continue
        const value = svc[key]
        if (value && typeof value === "object" && "__BRIDGE_MARKER" in value) {
          g.__leakProbe[name + ":LEAKED_VIA_" + key] = "VISIBLE"
        }
      }
    } catch (error) {
      g.__leakProbe[name + ":threw"] = String(error)
    }
  }
}
`,
    )
    await writeFile(join(root, "cordis.yml"), "- id: probe\n  name: ./plugins/probe.ts\n")

    const ctx = new Context()
    ctx.baseUrl = `${pathToFileURL(root).href}/`
    const fake = fakeBridge()
    const handle = new ShellHandle((line) => audits.push(line))
    handle.attach(fake.bridge)
    createShellCapabilities(ctx, handle)
    // A distinctive marker so a leak is unmistakable rather than merely "some object".
    ;(fake.bridge as unknown as Record<string, unknown>).__BRIDGE_MARKER = "LEAKED"
    // ⚠ `ctx.hands` must actually be provided: the probe plugin declares
    // `inject: ["hands", ...]`, and Cordis keeps such a plugin PENDING — `apply` never runs
    // and the probe reports nothing, which is why the anti-vacuous assertion below exists.
    const hands = new HandsService(ctx, { audit: (line) => audits.push(line) })
    hands.attachShell(fake.bridge)
    hands.useManifests(() => undefined)
    new ShortcutService(ctx, { bridge: fake.bridge.shortcut, log: (line) => audits.push(line) })
    const autostart = new AutostartService(ctx, { audit: (line) => audits.push(line) })
    autostart.attachShell(fake.bridge)

    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.plugin(Include, { path: "./cordis.yml", enableLogs: false })
    await new Promise((resolve) => setTimeout(resolve, 300))

    const probe =
      (globalThis as unknown as { __leakProbe?: Record<string, unknown> }).__leakProbe ?? {}
    for (const [key, value] of Object.entries(probe)) seen[key] = value
    await rm(root, { recursive: true, force: true }).catch(() => {})

    // Anti-vacuous: if the plugin never ran, every assertion below would "pass" for the
    // wrong reason (an empty object has no leaks). Require evidence it executed.
    expect(
      Object.keys(seen).length,
      "the probe plugin must have run and reported — an empty result is not evidence",
    ).toBeGreaterThan(0)

    // The load-bearing assertions.
    expect(seen["hands:bridge"], "ctx.hands must not expose the bridge").toBe("undefined")
    expect(seen["hands:keys"], "no bridge/manifest field may appear on ctx.hands").not.toContain(
      "bridge",
    )
    expect(seen["hands:keys"], "no manifestLookup field may appear on ctx.hands").not.toContain(
      "manifestLookup",
    )
    expect(seen["shortcut:bridge"], "ctx.shortcut must not expose the bridge").toBe("undefined")
    expect(seen["shortcut:keys"]).not.toContain("bridge")
    expect(seen["autostart:keys"]).not.toContain("bridge")
    expect(seen["autostart:keys"]).not.toContain("manifestLookup")

    // And nothing reachable from any enumerable key may carry the bridge.
    const leaked = Object.keys(seen).filter((key) => key.includes("LEAKED_VIA_"))
    expect(leaked, `bridge reachable through: ${leaked.join(", ")}`).toEqual([])
  }, 20_000)
})
