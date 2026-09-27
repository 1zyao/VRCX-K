/**
 * Swap-ability contract (the part of "third parties may replace our
 * implementation" that is checkable TODAY).
 *
 * The full replacement flow cannot be built yet — there are no third-party
 * implementations to swap in, so there is nothing to test end to end. What IS
 * testable now is that we do not block it:
 *
 *   1. A manifest may name a SERVICE in `dependencies`, not only a plugin id,
 *      so a dependent never bakes one implementation into its own declaration.
 *   2. A service name may not leak its implementation (`storageImpl`,
 *      `baseStorage`), because such a name can only ever be satisfied by that
 *      one implementation.
 *   3. `services.implements` must name services the host can actually resolve —
 *      the inventory is single-sourced from `capabilityInventory.ts`, which is
 *      itself pinned against the RUNNING host by `capability-surfaces.test.ts`.
 */
import { describe, expect, test } from "bun:test"
import manifestSchema from "../../contracts/plugin-manifest/v1/plugin-manifest.schema.json"
import {
  HOST_SERVICES,
  isHostService,
  REQUESTABLE_CAPABILITIES,
  SHELL_SUBDOMAINS,
} from "../src/contracts/capabilityInventory"
import { validatePluginManifest } from "../src/contracts/pluginContract"

const base = { id: "x", version: "1.0.0", author: "a", name: "X" }

describe("dependencies may name a service, not only a plugin id", () => {
  test("both spellings are accepted", () => {
    // kebab-case plugin id
    expect(validatePluginManifest({ ...base, dependencies: { "base-storage": "^1.0" } })).toBe(true)
    // camelCase service name — the spelling that makes replacement possible
    expect(validatePluginManifest({ ...base, dependencies: { storage: "^1.0" } })).toBe(true)
    // unused by v0 resolution, but the spelling must already be legal so that
    // adding third-party implementations later needs no manifest edits.
    expect(
      validatePluginManifest({ ...base, dependencies: { storage: "*", "audit-logger": "*" } }),
    ).toBe(true)
  })

  test("still rejects malformed keys", () => {
    for (const key of ["Storage", "storage_impl", "-lead", "stor age", ""]) {
      expect(validatePluginManifest({ ...base, dependencies: { [key]: "*" } })).toBe(false)
    }
  })
})

describe("service names must not leak an implementation", () => {
  test("rejects names that bake in one implementation", () => {
    // Each of these can only ever be satisfied by the implementation it names,
    // which is exactly what makes a drop-in replacement impossible.
    for (const name of [
      "storageImpl",
      "storageImplementation",
      "baseStorage",
      "coreStorage",
      "vrcxkStorage",
    ]) {
      expect(validatePluginManifest({ ...base, services: { implements: [name] } })).toBe(false)
      expect(validatePluginManifest({ ...base, services: { required: [name] } })).toBe(false)
    }
  })

  test("accepts capability-shaped names", () => {
    for (const name of ["storage", "friendPresence", "notify", "gameLog", "webApi"]) {
      expect(validatePluginManifest({ ...base, services: { implements: [name] } })).toBe(true)
    }
    // `impl` in the middle is fine — only a trailing Impl/Implementation is a smell.
    expect(validatePluginManifest({ ...base, services: { implements: ["implTracker"] } })).toBe(
      true,
    )
  })

  test("a service name must start lowercase, so it cannot be confused with a plugin id", () => {
    expect(validatePluginManifest({ ...base, services: { required: ["Storage"] } })).toBe(false)
  })
})

describe("the capability inventory is single-sourced", () => {
  test("every requestable capability is a real host service", () => {
    for (const capability of REQUESTABLE_CAPABILITIES) {
      expect(isHostService(capability)).toBe(true)
    }
  })

  test("the manifest schema's permission keys match the inventory exactly", () => {
    // If this fails, either add the capability to capabilityInventory.ts (and
    // prove the host provides it) or the schema was edited by hand.
    const schemaKeys = Object.keys(
      (manifestSchema.$defs as Record<string, { properties?: Record<string, unknown> }>).Permissions
        .properties ?? {},
    ).sort()
    expect(schemaKeys).toEqual([...REQUESTABLE_CAPABILITIES].sort())
  })

  test("the schema's shell sub-domains match the inventory exactly", () => {
    const defs = manifestSchema.$defs as Record<string, { enum?: string[] }>
    expect([...(defs.ShellSubdomain.enum ?? [])].sort()).toEqual([...SHELL_SUBDOMAINS].sort())
  })

  test("each narrow-grant `maxItems` equals its enum's length", () => {
    // ⚠ THE DRIFT BLIND SPOT that let a real bug ship.
    //
    // `check:contracts` only compares schema ↔ generated mirror BYTE FOR BYTE,
    // and json2ts copies `maxItems` into both. So when `list` was added to
    // `HandsPrimitive` but `hands.maxItems` stayed 4, the gate stayed green
    // while every manifest granting all five primitives became INVALID.
    //
    // The consequence was not a cosmetic error: an invalid manifest makes
    // `loadManifests` SKIP the plugin (with only a log line), so the plugin has
    // no manifest, and `findOverreach` returns undefined when there is no
    // manifest — meaning the `#24` warn silently switched OFF for exactly the
    // plugin that requested the most. The same drift already existed for
    // `shell` (maxItems 11 vs 15 sub-domains).
    //
    // Pinning enum length to `maxItems` makes that class of mistake impossible:
    // add a member to either enum and this fails until the cap is raised.
    const defs = manifestSchema.$defs as Record<string, { enum?: string[] }>
    const permissions = (
      manifestSchema.$defs as Record<string, { properties?: Record<string, unknown> }>
    ).Permissions.properties as Record<string, { oneOf?: Array<{ maxItems?: number }> }>

    for (const [key, defName] of [
      ["hands", "HandsPrimitive"],
      ["shell", "ShellSubdomain"],
    ] as const) {
      const enumLength = (defs[defName].enum ?? []).length
      // The array arm is the second `oneOf` branch (the first is `boolean`).
      const maxItems = permissions[key]?.oneOf?.find((arm) => arm.maxItems !== undefined)?.maxItems
      expect(maxItems).toBe(enumLength)
    }
  })

  test("a manifest granting every primitive and every sub-domain is VALID", () => {
    // The behavioural half of the pin above: it is not enough for the numbers to
    // match, the grant has to actually be accepted. Written against the enums so
    // it stays exhaustive as they grow — `every` over the schema is the same set
    // a plugin author would read off the docs.
    const defs = manifestSchema.$defs as Record<string, { enum?: string[] }>
    const ok = validatePluginManifest({
      ...base,
      permissions: {
        hands: [...(defs.HandsPrimitive.enum ?? [])],
        shell: [...(defs.ShellSubdomain.enum ?? [])],
      },
    })
    expect(validatePluginManifest.errors ?? []).toEqual([])
    expect(ok).toBe(true)
  })

  test("signal is a service but NOT a requestable capability", () => {
    // It is a lifecycle mechanism the host provides for cooperative shutdown,
    // not a privileged capability, so asking for it would be meaningless.
    expect(isHostService("signal")).toBe(true)
    expect((REQUESTABLE_CAPABILITIES as readonly string[]).includes("signal")).toBe(false)
    expect(
      validatePluginManifest({ ...base, permissions: { signal: true } as Record<string, boolean> }),
    ).toBe(false)
  })

  test("tray and shortcut are services (they are Service subclasses, not plain provides)", () => {
    // Regression guard: these two were once plain `ctx.provide` objects, which
    // silently lost caller attribution.
    expect(HOST_SERVICES).toContain("tray")
    expect(HOST_SERVICES).toContain("shortcut")
  })
})
