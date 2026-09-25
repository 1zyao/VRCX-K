// Overreach detection (#24 / M2-8): a call is compared against what the caller
// DECLARED, and an undeclared call is reported.
//
// The rules pinned here are the ones that make the feature trustworthy, and every
// one of them is a way it could silently fail:
//
//   1. It must WARN, never refuse. `#24` is explicit: there is no "subject" to
//      authorise against yet (#13), so a hard refusal would be guessing.
//   2. A caller with NO entry (bare `ctx.plugin()`) must NOT be reported. It has
//      no manifest to violate, and `#24` calls this case out by name.
//   3. A caller with no REGISTERED manifest must NOT be reported either —
//      warning about a plugin that never shipped a manifest is noise, and noise
//      trains people to ignore the warn.
//   4. The lookup must key on the RAW `entry.id`, not the display name. The
//      display name carries a `#runtimeName` suffix; feeding that to the registry
//      would miss every manifest and the warn would never fire — a warn that
//      never warns is worse than none, because it reads as "nobody overreached".
//   5. A narrow grant must be respected: `hands: ["stat"]` then calling `write`
//      is out-of-scope, not granted.
//   6. Both call paths must be covered: the curated services AND the raw
//      `ctx.shell.*` mirror (`#24` §2).

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
import { HandsService } from "../src/hands"
import { checkGrant, findOverreach, formatOverreach, rawShellSubdomain } from "../src/overreach"
import type { ShellStdioBridge } from "../src/stdio"

function manifest(permissions?: Record<string, unknown>): VRCXKPluginManifest {
  return {
    id: "probe-plugin",
    version: "0.0.1",
    author: "test",
    name: "Probe",
    ...(permissions ? { permissions } : {}),
  } as unknown as VRCXKPluginManifest
}

/** An async iterable that yields nothing — the empty-stream shape the bridge wants. */
async function* emptyAsync(): AsyncIterable<never> {
  // Intentionally yields nothing.
}

/** A no-op bridge: the calls must reach the shell for the audit hook to fire. */
function fakeBridge(): ShellStdioBridge {
  const ok = async () => true
  return {
    // The `hands` namespace is only reached by the `ctx.hands` coverage tests.
    // `write` takes a stream and resolves; `stat` answers null so the granted-call
    // control does not depend on a real file.
    hands: {
      stat: async () => null,
      read: () => emptyAsync(),
      write: async () => ({ bytes: 0, endOffset: 0, mode: "create" }),
      watch: () => emptyAsync(),
      list: () => emptyAsync(),
    },
    shell: {
      notify: ok,
      openUrl: ok,
      openPath: ok,
      reveal: ok,
      dialog: { message: ok, ask: async () => "", pickFile: async () => null },
      window: {
        show: ok,
        hide: ok,
        minimize: ok,
        maximize: ok,
        unmaximize: ok,
        focus: ok,
        close: ok,
      },
      shortcut: {
        register: async () => ({ ok: true }),
        unregister: async () => ({ ok: true }),
        isRegistered: async () => false,
      },
      app: { info: async () => ({ name: "n", version: "v", identifier: "i" }), exit: ok },
      path: {
        dir: async () => ({ config: "", data: "", cache: "", temp: "", home: "" }),
        resolve: async () => "",
      },
      devWatchEvent: ok,
      clipboard: { writeText: ok, readText: async () => null },
      os: {
        info: async () => ({
          platform: "win32",
          version: "10",
          family: "windows",
          arch: "x86_64",
          locale: null,
          hostname: "h",
        }),
      },
      tray: { setSnapshot: async () => ({ ok: true, revision: 0 }) },
    },
  } as unknown as ShellStdioBridge
}

describe("the pure grant check", () => {
  test("an absent declaration is undeclared", () => {
    expect(checkGrant(undefined, "notify", "notify.send")).toBe("undeclared")
  })

  test("`true` grants the whole capability", () => {
    expect(checkGrant(true, "notify", "notify.send")).toBe("granted")
  })

  test("`false` is out-of-scope, not undeclared", () => {
    // The distinction matters: `false` is an explicit refusal, so the fix is
    // "widen it", whereas absent is "you never mentioned it".
    expect(checkGrant(false, "notify", "notify.send")).toBe("out-of-scope")
  })

  test("a narrow list grants only what it names", () => {
    expect(checkGrant(["send"], "notify", "notify.send")).toBe("granted")
    expect(checkGrant(["other"], "notify", "notify.send")).toBe("out-of-scope")
  })

  test("naming the capability itself counts", () => {
    expect(checkGrant(["notify"], "notify", "notify.send")).toBe("granted")
  })

  test("the full method path also counts", () => {
    expect(checkGrant(["notify.send"], "notify", "notify.send")).toBe("granted")
  })
})

describe("the raw shell mirror maps to its sub-domain", () => {
  test("shell.window.show maps to window", () => {
    expect(rawShellSubdomain("shell.window.show")).toBe("window")
  })

  test("a one-segment shell call maps to itself", () => {
    expect(rawShellSubdomain("shell.notify")).toBe("notify")
  })

  test("a non-shell method has no sub-domain", () => {
    expect(rawShellSubdomain("notify.send")).toBeUndefined()
  })
})

describe("findOverreach: who must NOT be warned about", () => {
  test("a caller with no entry is never reported", () => {
    // #24 §3: a bare `ctx.plugin()` is host-internal and has no manifest to
    // violate. Reporting it would be a false accusation.
    expect(findOverreach(undefined, "notify.send", manifest({ notify: true }))).toBeUndefined()
  })

  test("a caller with no registered manifest is never reported", () => {
    // Nothing was promised, so nothing was broken. Warning here would be noise.
    expect(findOverreach("4daad489:no-manifest", "notify.send", undefined)).toBeUndefined()
  })

  test("a correctly declared call is not reported", () => {
    expect(findOverreach("4daad489:p", "notify.send", manifest({ notify: true }))).toBeUndefined()
  })
})

describe("findOverreach: who MUST be warned about", () => {
  test("calling a capability the manifest never mentions", () => {
    const finding = findOverreach("4daad489:p", "notify.send", manifest({ os: true }))
    expect(finding).toBeDefined()
    expect(finding?.capability).toBe("notify")
    expect(finding?.reason).toBe("undeclared")
    expect(finding?.entryId).toBe("4daad489:p")
  })

  test("calling outside a narrow grant", () => {
    const finding = findOverreach(
      "4daad489:p",
      "hands.write",
      manifest({ hands: ["stat", "read"] }),
    )
    expect(finding?.reason).toBe("out-of-scope")
    expect(finding?.capability).toBe("hands")
  })

  test("a narrow grant that DOES cover the call is fine", () => {
    expect(findOverreach("4daad489:p", "hands.read", manifest({ hands: ["read"] }))).toBeUndefined()
  })

  test("a raw shell call is covered by a shell sub-domain grant", () => {
    expect(
      findOverreach("4daad489:p", "shell.window.show", manifest({ shell: ["window"] })),
    ).toBeUndefined()
  })

  test("a raw shell call is also covered by the capability's own grant", () => {
    // The manifest contract allows either spelling; a plugin must not be warned
    // for choosing the one the docs recommend.
    expect(
      findOverreach("4daad489:p", "shell.window.show", manifest({ window: true })),
    ).toBeUndefined()
  })

  test("a raw shell call outside the granted sub-domains is reported", () => {
    const finding = findOverreach(
      "4daad489:p",
      "shell.window.show",
      manifest({ shell: ["notify"] }),
    )
    expect(finding).toBeDefined()
    // ⚠ `shell`, NOT `window`. The manifest says `shell: ["notify"]`, so the key
    // the author must edit is `shell` — reporting `window` named a capability
    // that appears nowhere in their manifest, and following that message would
    // add the wrong grant. (This assertion previously pinned `"window"`, which is
    // the defect: the test froze the wrong behaviour as expected.)
    expect(finding?.capability).toBe("shell")
    // The reason must still distinguish "never mentioned it" from "mentioned it
    // narrowly" — the fix differs, so the wording must too.
    expect(finding?.reason).toBe("out-of-scope")
  })

  test("the undeclared spelling still reports the sub-domain's own name", () => {
    // The other branch of the same choice: when the manifest has no `shell` key
    // at all, the call can only be satisfied by the sub-domain's own capability,
    // so THAT is the key to name.
    const finding = findOverreach("4daad489:p", "shell.window.show", manifest({ notify: true }))
    expect(finding?.capability).toBe("window")
    expect(finding?.reason).toBe("undeclared")
  })

  test("the warn line names the key the author can actually edit", () => {
    // The finding's `capability` is only useful if it reaches the message — this
    // asserts the whole path, since that is what a plugin author reads.
    const finding = findOverreach(
      "4daad489:p",
      "shell.window.show",
      manifest({ shell: ["notify"] }),
    )
    const line = formatOverreach(finding as NonNullable<typeof finding>)
    expect(line).toContain("declares `shell` but not this entry")
    expect(line).not.toContain("declares `window`")
  })
})

describe("the warn line is actionable", () => {
  test("it names the call, the capability and the fix", () => {
    const finding = findOverreach("4daad489:p", "notify.send", manifest({ os: true }))
    const line = formatOverreach(finding as NonNullable<typeof finding>)
    expect(line).toContain("overreach")
    expect(line).toContain("notify.send")
    expect(line).toContain("does not declare")
    // It must say outright that nothing was blocked, or a reader will assume it
    // was — which is the misunderstanding #24 exists to prevent.
    expect(line).toContain("not enforced")
  })

  test("the per-run random prefix is stripped from the display name", () => {
    // The prefix changes every run, so it is noise in a log line.
    const finding = findOverreach("4daad489:p", "notify.send", manifest({ os: true }))
    const line = formatOverreach(finding as NonNullable<typeof finding>)
    expect(line).toContain("p called")
    expect(line).not.toContain("4daad489")
  })
})

describe("end to end through the real capability surface and a real loader entry", () => {
  /**
   * Run one plugin call through a REAL loader entry.
   *
   * ⚠ A bare `ctx.plugin()` will NOT work here, and the first version of this
   * test made exactly that mistake: a bare plugin fiber has no `fiber.entry`, so
   * `callerEntryId` returns `undefined` and the check correctly skips it (#24:
   * host-internal callers have no manifest to violate). The check can only fire
   * for a caller that HAS an entry — which is the production shape, where every
   * plugin comes from `cordis.yml` through the loader. So the test must build the
   * same shape, or it would "prove" the feature is broken when it is not.
   */
  async function runThroughLoader(
    declared: Record<string, unknown>,
    source: string,
    opts: { withHands?: boolean } = {},
  ): Promise<{ audits: string[]; entryId: string }> {
    const root = await mkdtemp(join(tmpdir(), "vrcxk-overreach-"))
    await mkdir(join(root, "plugins"), { recursive: true })
    await writeFile(join(root, "plugins", "probe.ts"), source)
    await writeFile(join(root, "cordis.yml"), "- id: probe\n  name: ./plugins/probe.ts\n")

    const audits: string[] = []
    const ctx = new Context()
    ctx.baseUrl = `${pathToFileURL(root).href}/`
    const handle = new ShellHandle((line) => audits.push(line))
    handle.attach(fakeBridge())
    // Mirrors production: the registry is keyed by the entry's STABLE suffix,
    // which is what `manifestRegistryOf(ctx).get(entryId)` does.
    const lookup = (entryId: string) =>
      entryId.endsWith(":probe") ? manifest(declared) : undefined
    handle.useManifests(lookup)
    createShellCapabilities(ctx, handle)

    // ⚠ The CURATED hands service, which is the supported entry point. It needs
    // the SAME lookup: an earlier version gave it none, so `ctx.hands.*` was
    // audited but never checked while the raw mirror was — the exact inversion
    // `#24` exists to prevent. Opt-in here so the raw-path tests stay honest
    // about which service they are exercising.
    if (opts.withHands) {
      const hands = new HandsService(ctx, { audit: (line) => audits.push(line) })
      hands.attachShell(fakeBridge())
      hands.useManifests(lookup)
    }

    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const includeId = await ctx.loader.create({
      name: "cordis:include",
      config: { path: "./cordis.yml", enableLogs: false },
    })

    // Poll for the call to land, then clean up.
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline && !audits.some((line) => line.includes("[cap]"))) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
    await rm(root, { recursive: true, force: true }).catch(() => {})
    return { audits, entryId: includeId }
  }

  test("a declared curated-service call produces NO overreach line", async () => {
    const { audits } = await runThroughLoader(
      { notify: true },
      `export function apply(ctx: any) { void ctx.notify.send("a", "b") }\n`,
    )
    expect(audits.some((line) => line.includes("[cap]"))).toBe(true)
    expect(audits.some((line) => line.includes("overreach"))).toBe(false)
  }, 20_000)

  test("an undeclared curated-service call DOES produce an overreach line", async () => {
    // The whole point: the manifest exists (the plugin promised something) and
    // does not mention `notify`.
    const { audits } = await runThroughLoader(
      { os: true },
      `export function apply(ctx: any) { void ctx.notify.send("a", "b") }\n`,
    )
    const warn = audits.find((line) => line.includes("overreach"))
    expect(warn).toBeDefined()
    expect(warn).toContain("notify.send")
    expect(warn).toContain("probe")
  }, 20_000)

  test("the RAW ctx.shell path is covered too (#24 requires both)", async () => {
    const { audits } = await runThroughLoader(
      { notify: true },
      `export function apply(ctx: any) { void ctx.shell.window.show() }\n`,
    )
    const warn = audits.find((line) => line.includes("overreach"))
    expect(warn).toBeDefined()
    expect(warn).toContain("window")
  }, 20_000)

  test("⚠ the CURATED ctx.hands path IS checked (it was not, before this)", async () => {
    // THE REGRESSION for the coverage inversion. `ctx.hands` is the SUPPORTED
    // entry point, and it had no overreach check at all: the check lived only in
    // `ShellHandle.record`, so the raw escape hatch was covered and this was not.
    //
    // The manifest declares `hands: ["stat"]` and the plugin calls `write`, so the
    // warn must name `hands` and say the entry is out of scope (not "undeclared" —
    // the capability WAS declared, narrowly; the two need different fixes).
    const { audits } = await runThroughLoader(
      { hands: ["stat"] },
      `export function apply(ctx: any) {
         void (async () => {
           try { for await (const _ of ctx.hands.write("/tmp/x", (async function* () {})())) {} } catch {}
         })()
       }\n`,
      { withHands: true },
    )
    const warn = audits.find((line) => line.includes("overreach"))
    expect(warn).toBeDefined()
    expect(warn).toContain("hands.write")
    expect(warn).toContain("declares `hands` but not this entry")
  }, 20_000)

  test("a ctx.hands call the manifest DOES grant is not reported", async () => {
    // The control: the new check must not fire on a correct declaration, or it
    // would be noise that trains people to ignore the warn.
    const { audits } = await runThroughLoader(
      { hands: ["stat"] },
      `export function apply(ctx: any) { void ctx.hands.stat("/tmp/x").catch(() => {}) }\n`,
      { withHands: true },
    )
    expect(audits.some((line) => line.includes("[cap]"))).toBe(true)
    expect(audits.some((line) => line.includes("overreach"))).toBe(false)
  }, 20_000)

  test("a plugin with no registered manifest produces no warn, but is still audited", async () => {
    // The lookup returns undefined for everything, i.e. "no manifest on disk".
    const root = await mkdtemp(join(tmpdir(), "vrcxk-overreach-none-"))
    await mkdir(join(root, "plugins"), { recursive: true })
    await writeFile(
      join(root, "plugins", "probe.ts"),
      `export function apply(ctx: any) { void ctx.notify.send("a", "b") }\n`,
    )
    await writeFile(join(root, "cordis.yml"), "- id: probe\n  name: ./plugins/probe.ts\n")

    const audits: string[] = []
    const ctx = new Context()
    ctx.baseUrl = `${pathToFileURL(root).href}/`
    const handle = new ShellHandle((line) => audits.push(line))
    handle.attach(fakeBridge())
    handle.useManifests(() => undefined)
    createShellCapabilities(ctx, handle)
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.loader.create({
      name: "cordis:include",
      config: { path: "./cordis.yml", enableLogs: false },
    })

    const deadline = Date.now() + 8_000
    while (Date.now() < deadline && !audits.some((line) => line.includes("[cap]"))) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
    await rm(root, { recursive: true, force: true }).catch(() => {})

    // The call IS audited (transparency is independent of the manifest)…
    expect(audits.some((line) => line.includes("[cap]"))).toBe(true)
    // …but nothing is accused: nothing was promised.
    expect(audits.some((line) => line.includes("overreach"))).toBe(false)
  }, 20_000)

  test("with the check disabled, no warnings appear at all", async () => {
    // A host with no loader wired (tests, shell-less dev mode) must not start
    // warning about every call.
    const audits: string[] = []
    const ctx = new Context()
    const handle = new ShellHandle((line) => audits.push(line))
    handle.attach(fakeBridge())
    // Note: `useManifests` deliberately NOT called.
    createShellCapabilities(ctx, handle)
    await ctx.plugin(function bare(inner: Context) {
      void (inner as unknown as { notify: { send(t: string, b: string): void } }).notify.send(
        "a",
        "b",
      )
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(audits.some((line) => line.includes("overreach"))).toBe(false)
  })
})
