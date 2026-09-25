// Unit tests for dev-reload.ts: cache invalidation + reload state machine
// with injected fake dependencies (no real Cordis runtime needed).
import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  collectCacheKeysUnderRoots,
  invalidateCache,
  moduleCache,
  type ReloadDeps,
  reloadPluginEntry,
} from "../src/dev-reload"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vrcxk-reload-"))
  roots.push(root)
  const pluginDir = join(root, "plugins")
  await Bun.$`mkdir -p ${pluginDir}`.quiet()
  const entryFile = join(pluginDir, "index.ts")
  const utilFile = join(pluginDir, "util.ts")
  await writeFile(entryFile, "export function apply() {}\n")
  await writeFile(utilFile, "export const v = 1\n")
  return { root, pluginDir, entryFile, utilFile }
}

type FiberLike = {
  uid: number | null
  dispose(): Promise<void>
  runtime?: { callback?: unknown }
  await(): Promise<unknown>
}

function fakeEntry(
  overrides: Partial<{ fiber: FiberLike | null; id: string; config: unknown; root: string }> = {},
) {
  const root = overrides.root ?? "C:/work"
  let fiber: FiberLike | null = overrides.fiber ?? null
  const entry = {
    id: overrides.id ?? "test",
    options: {
      id: "test",
      name: "./plugins/index.ts",
      config: overrides.config ?? {},
    },
    parent: {
      tree: {
        ctx: { baseUrl: `file:///${root.replaceAll("\\", "/")}/` },
      },
    },
    getOuterStack: () => [],
    loader: { unwrapExports: (exports: unknown) => exports },
    get fiber() {
      return fiber
    },
    set fiber(value: FiberLike | null) {
      fiber = value
    },
  }
  return entry as unknown as Parameters<typeof reloadPluginEntry>[0]
}

function makeDeps(overrides: Partial<ReloadDeps> = {}): ReloadDeps {
  const applyLog: string[] = []
  return {
    loadEntryModule: async () => ({ apply: () => {} }),
    pluginOnEntryCtx: async (_entry, plugin, config) => {
      const callback = (plugin as { apply?: unknown }).apply ?? plugin
      void config
      return {
        uid: 99,
        await: async () => {
          applyLog.push("await")
          if (typeof callback === "function") {
            ;(callback as () => void)()
          } else if (callback && typeof callback === "object") {
            ;(callback as { apply: () => void }).apply()
          }
        },
      }
    },
    log: () => {},
    ...overrides,
  }
}

describe("collectCacheKeysUnderRoots", () => {
  test("collects only keys under the given roots (Windows separators folded)", () => {
    const cache: Record<string, unknown> = {
      "C:\\work\\plugins\\index.ts": {},
      "c:/work/plugins/util.ts": {},
      "C:\\work\\plugins\\sub\\a.ts": {},
      "C:\\work\\other.ts": {},
      "C:\\work\\plugins-evil.ts": {},
    }
    const keys = collectCacheKeysUnderRoots(["C:\\work\\plugins"], cache)
    expect(keys.sort()).toEqual([
      "C:\\work\\plugins\\index.ts",
      "C:\\work\\plugins\\sub\\a.ts",
      "c:/work/plugins/util.ts",
    ])
  })

  test("invalidateCache deletes only the matching keys", () => {
    const cache: Record<string, unknown> = {
      "C:\\work\\plugins\\index.ts": {},
      "C:\\work\\plugins\\util.ts": {},
      "C:\\work\\node_modules\\x.ts": {},
    }
    const dropped = invalidateCache(["C:\\work\\plugins"], cache)
    expect(dropped).toBe(2)
    expect(cache["C:\\work\\plugins\\index.ts"]).toBeUndefined()
    expect(cache["C:\\work\\node_modules\\x.ts"]).toBeDefined()
  })
})

describe("reloadPluginEntry state machine", () => {
  test("returns skipped when the entry has no fiber", async () => {
    const entry = fakeEntry()
    const result = await reloadPluginEntry(entry, ["./plugins"], makeDeps())
    expect(result.status).toBe("skipped")
  })

  test("keeps old fiber when the fresh import fails (strong rollback)", async () => {
    const disposeCalls: string[] = []
    const oldFiber: FiberLike = {
      uid: 1,
      runtime: { callback: function oldApply() {} },
      dispose: async () => {
        disposeCalls.push("dispose")
        ;(oldFiber as { uid: number | null }).uid = null
      },
      await: async () => {},
    }
    const entry = fakeEntry({ fiber: oldFiber })
    const result = await reloadPluginEntry(
      entry,
      ["./plugins"],
      makeDeps({
        loadEntryModule: async () => {
          throw new Error("syntax error")
        },
      }),
    )
    expect(result.status).toBe("kept-old")
    expect(result.phase).toBe("import")
    expect(disposeCalls).toHaveLength(0) // old fiber untouched
  })

  test("keeps old fiber when the module is not a plugin", async () => {
    const oldFiber: FiberLike = {
      uid: 1,
      runtime: { callback: function oldApply() {} },
      dispose: async () => {
        ;(oldFiber as { uid: number | null }).uid = null
      },
      await: async () => {},
    }
    const entry = fakeEntry({ fiber: oldFiber })
    const result = await reloadPluginEntry(
      entry,
      ["./plugins"],
      makeDeps({
        loadEntryModule: async () => ({ notAPlugin: true }),
      }),
    )
    expect(result.status).toBe("kept-old")
    expect(result.phase).toBe("import")
  })

  test("restores old module when the new fiber apply fails", async () => {
    const applyCalls: string[] = []
    const oldFiber = {
      uid: 1,
      runtime: {
        callback: function oldApply() {
          applyCalls.push("old")
        },
      },
      dispose: async () => {
        applyCalls.push("dispose")
        ;(oldFiber as { uid: number | null }).uid = null
      },
      await: async () => {},
    }
    const entry = fakeEntry({ fiber: oldFiber })
    let failOnce = true
    const deps = makeDeps({
      loadEntryModule: async () => ({ apply: () => applyCalls.push("new") }),
      pluginOnEntryCtx: async (_entry, plugin) => {
        // first call = the new plugin (fails); second call = restore (old callback succeeds)
        if (failOnce) {
          failOnce = false
          const newApply = (plugin as { apply: () => void }).apply
          return {
            uid: 2,
            await: async () => {
              newApply()
              throw new Error("apply exploded")
            },
          }
        }
        return {
          uid: 3,
          await: async () => {
            ;(plugin as { apply: () => void }).apply()
          },
        }
      },
    })
    const result = await reloadPluginEntry(entry, ["./plugins"], deps)
    expect(result.status).toBe("restored-old")
    expect(result.phase).toBe("swap")
    expect(applyCalls).toContain("old") // old module restored
  })

  test("returns restart-required when restore also fails", async () => {
    const oldFiber: FiberLike = {
      uid: 1,
      runtime: { callback: function oldApply() {} },
      dispose: async () => {
        ;(oldFiber as { uid: number | null }).uid = null
      },
      await: async () => {},
    }
    const entry = fakeEntry({ fiber: oldFiber })
    const result = await reloadPluginEntry(
      entry,
      ["./plugins"],
      makeDeps({
        loadEntryModule: async () => ({ apply: () => {} }),
        pluginOnEntryCtx: async () => {
          throw new Error("always fails")
        },
      }),
    )
    expect(result.status).toBe("restart-required")
    expect(result.phase).toBe("swap")
  })

  test("reloads successfully and swaps entry.fiber", async () => {
    const calls: string[] = []
    const oldFiber = {
      uid: 1,
      runtime: {
        callback: function oldApply() {
          calls.push("old-apply")
        },
      },
      dispose: async () => {
        calls.push("dispose")
        ;(oldFiber as { uid: number | null }).uid = null
      },
      await: async () => {},
    }
    const entry = fakeEntry({ fiber: oldFiber })
    const deps = makeDeps({
      loadEntryModule: async () => ({ apply: () => calls.push("new-apply") }),
      pluginOnEntryCtx: async () => ({
        uid: 5,
        await: async () => calls.push("new-await"),
      }),
    })
    const result = await reloadPluginEntry(entry, ["./plugins"], deps)
    expect(result.status).toBe("reloaded")
    expect(calls).toEqual(["dispose", "new-await"])
  })

  test("keeps old fiber when the fresh import times out", async () => {
    const oldFiber: FiberLike = {
      uid: 1,
      runtime: { callback: function oldApply() {} },
      dispose: async () => {
        ;(oldFiber as { uid: number | null }).uid = null
      },
      await: async () => {},
    }
    const entry = fakeEntry({ fiber: oldFiber })
    const disposeCalls: string[] = []
    const result = await reloadPluginEntry(
      entry,
      ["./plugins"],
      makeDeps({
        timeoutMs: 30,
        loadEntryModule: () => new Promise<never>(() => {}), // never resolves
        pluginOnEntryCtx: async () => {
          disposeCalls.push("unexpected")
          return { uid: 2, await: async () => {} }
        },
      }),
    )
    expect(result.status).toBe("kept-old")
    expect(result.phase).toBe("import")
    expect(disposeCalls).toHaveLength(0) // old fiber untouched
    expect(Object.is(entry.fiber, oldFiber)).toBe(true)
  })

  test("returns timeout when the new fiber build times out and restore also times out", async () => {
    const oldFiber: FiberLike = {
      uid: 1,
      runtime: { callback: function oldApply() {} },
      dispose: async () => {
        ;(oldFiber as { uid: number | null }).uid = null
      },
      await: async () => {},
    }
    const entry = fakeEntry({ fiber: oldFiber })
    const result = await reloadPluginEntry(
      entry,
      ["./plugins"],
      makeDeps({
        timeoutMs: 30,
        loadEntryModule: async () => ({ apply: () => {} }),
        pluginOnEntryCtx: () => new Promise<never>(() => {}), // swap AND restore both hang
      }),
    )
    // The swap timed out and restore failed: the abandoned fiber may still come
    // up, so the live state is unknown → `timeout` (G).
    expect(result.status).toBe("timeout")
    expect(result.phase).toBe("swap")
    expect(String(result.error)).toMatch(/timed out/)
  })

  test("returns timeout when the new fiber await times out and restore fails", async () => {
    const oldFiber: FiberLike = {
      uid: 1,
      runtime: { callback: function oldApply() {} },
      dispose: async () => {
        ;(oldFiber as { uid: number | null }).uid = null
      },
      await: async () => {},
    }
    const entry = fakeEntry({ fiber: oldFiber })
    let call = 0
    const result = await reloadPluginEntry(
      entry,
      ["./plugins"],
      makeDeps({
        timeoutMs: 30,
        loadEntryModule: async () => ({ apply: () => {} }),
        pluginOnEntryCtx: async () => {
          call += 1
          if (call === 1) return { uid: 2, await: () => new Promise<never>(() => {}) } // await hangs
          throw new Error("restore also fails")
        },
      }),
    )
    expect(result.status).toBe("timeout")
    expect(result.phase).toBe("swap")
  })

  test("returns timeout when the old fiber dispose times out", async () => {
    const oldFiber: FiberLike = {
      uid: 1,
      runtime: { callback: function oldApply() {} },
      dispose: () => new Promise<never>(() => {}), // never disposes
      await: async () => {},
    }
    const entry = fakeEntry({ fiber: oldFiber })
    const result = await reloadPluginEntry(
      entry,
      ["./plugins"],
      makeDeps({
        timeoutMs: 30,
        loadEntryModule: async () => ({ apply: () => {} }),
      }),
    )
    // Half-torn entry, abandoned disposer may still be running → unknown state.
    expect(result.status).toBe("timeout")
    expect(result.phase).toBe("swap")
    expect(Object.is(entry.fiber, oldFiber)).toBe(true) // never rebuilt over a half-torn fiber
  })

  test("returns restored-old when the new fiber build times out but restore succeeds", async () => {
    const oldFiber: FiberLike = {
      uid: 1,
      runtime: { callback: function oldApply() {} },
      dispose: async () => {
        ;(oldFiber as { uid: number | null }).uid = null
      },
      await: async () => {},
    }
    const entry = fakeEntry({ fiber: oldFiber })
    let call = 0
    const result = await reloadPluginEntry(
      entry,
      ["./plugins"],
      makeDeps({
        timeoutMs: 30,
        loadEntryModule: async () => ({ apply: () => {} }),
        pluginOnEntryCtx: async () => {
          call += 1
          if (call === 1) return new Promise<never>(() => {}) // swap hangs
          return { uid: 3, await: async () => {} } // restore succeeds
        },
      }),
    )
    // Restore is a KNOWN state, so a swap timeout is not reported as `timeout`.
    expect(result.status).toBe("restored-old")
    expect(result.phase).toBe("swap")
  })

  test("returns restart-required when the old fiber dispose throws", async () => {
    const oldFiber: FiberLike = {
      uid: 1,
      runtime: { callback: function oldApply() {} },
      dispose: async () => {
        throw new Error("disposer exploded")
      },
      await: async () => {},
    }
    const entry = fakeEntry({ fiber: oldFiber })
    const result = await reloadPluginEntry(
      entry,
      ["./plugins"],
      makeDeps({
        loadEntryModule: async () => ({ apply: () => {} }),
      }),
    )
    expect(result.status).toBe("restart-required")
    expect(result.phase).toBe("swap")
    // Entry was NOT rebuilt over the half-torn fiber.
    expect(Object.is(entry.fiber, oldFiber)).toBe(true)
  })

  test("returns restart-required when there is no old callback to restore", async () => {
    // old fiber without a runtime callback → restore is impossible.
    const oldFiber = {
      uid: 1,
      dispose: async () => {
        ;(oldFiber as { uid: number | null }).uid = null
      },
      await: async () => {},
    }
    const entry = fakeEntry({ fiber: oldFiber })
    const result = await reloadPluginEntry(
      entry,
      ["./plugins"],
      makeDeps({
        loadEntryModule: async () => ({ apply: () => {} }),
        pluginOnEntryCtx: async () => {
          throw new Error("new fiber fails")
        },
      }),
    )
    expect(result.status).toBe("restart-required")
    expect(result.phase).toBe("swap")
  })

  test("restores the require.cache snapshot when the fresh import fails", async () => {
    const { root, entryFile, utilFile } = await fixture()
    const oldFiber: FiberLike = {
      uid: 1,
      runtime: { callback: function oldApply() {} },
      dispose: async () => {
        ;(oldFiber as { uid: number | null }).uid = null
      },
      await: async () => {},
    }
    const entry = fakeEntry({ fiber: oldFiber, root })
    // Seed the real require.cache with sentinels for the entry + its util.
    const cache = require.cache as unknown as Record<string, unknown>
    const entryKey = entryFile
    const utilKey = utilFile
    cache[entryKey] = { sentinel: "entry-v1" }
    cache[utilKey] = { sentinel: "util-v1" }
    try {
      const result = await reloadPluginEntry(
        entry,
        [join(root, "plugins")],
        makeDeps({
          loadEntryModule: async () => {
            throw new Error("syntax error")
          },
        }),
      )
      expect(result.status).toBe("kept-old")
      // Strong rollback: both cache entries are back (they were deleted before
      // the import attempt and restored on failure).
      expect(cache[entryKey]).toEqual({ sentinel: "entry-v1" })
      expect(cache[utilKey]).toEqual({ sentinel: "util-v1" })
    } finally {
      delete cache[entryKey]
      delete cache[utilKey]
    }
  })

  test("invalidates an explicitly injected cache instead of the runtime cache", async () => {
    const { root, entryFile } = await fixture()
    const oldFiber: FiberLike = {
      uid: 1,
      runtime: { callback: function oldApply() {} },
      dispose: async () => {
        ;(oldFiber as { uid: number | null }).uid = null
      },
      await: async () => {},
    }
    const entry = fakeEntry({ fiber: oldFiber, root })
    const cache: Record<string, unknown> = { [entryFile]: { sentinel: "injected" } }
    const result = await reloadPluginEntry(
      entry,
      [join(root, "plugins")],
      makeDeps({
        cache,
        loadEntryModule: async () => {
          throw new Error("syntax error")
        },
      }),
    )
    expect(result.status).toBe("kept-old")
    // Deleted for the import attempt, restored by the strong rollback.
    expect(cache[entryFile]).toEqual({ sentinel: "injected" })
  })
})

describe("module cache defaults (ESM safety)", () => {
  test("moduleCache resolves a usable cache object and never throws", () => {
    expect(typeof moduleCache()).toBe("object")
    expect(collectCacheKeysUnderRoots(["C:\\definitely-not-loaded"])).toEqual([])
    expect(invalidateCache(["C:\\definitely-not-loaded"])).toBe(0)
  })

  // Bun injects a lexical `require` into every module, so the ReferenceError
  // this guards against cannot be reproduced inside the bun test runner. Node
  // ESM has no `require` at all — run the real import there when node exists.
  const nodeAvailable = spawnSync("node", ["--version"], { encoding: "utf8" }).status === 0

  test.skipIf(!nodeAvailable)(
    "imports and runs under a pure ESM runtime (node) without require",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "vrcxk-reload-esm-"))
      roots.push(dir)
      const moduleUrl = pathToFileURL(join(import.meta.dir, "..", "src", "dev-reload.ts")).href
      const probe = join(dir, "probe.mjs")
      await writeFile(
        probe,
        `import { moduleCache, collectCacheKeysUnderRoots } from ${JSON.stringify(moduleUrl)}\n` +
          `console.log(JSON.stringify({ hasRequire: typeof require !== "undefined", ok: typeof moduleCache() === "object", keys: collectCacheKeysUnderRoots(["nope"]).length }))\n`,
      )
      const proc = Bun.spawn(["node", probe], { stdout: "pipe", stderr: "pipe" })
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      expect(stderr).toBe("")
      expect(code).toBe(0)
      expect(JSON.parse(stdout.trim())).toEqual({ hasRequire: false, ok: true, keys: 0 })
    },
    60_000,
  )
})
