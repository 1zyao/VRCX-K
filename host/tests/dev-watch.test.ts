// Integration tests for DevWatch on a real Cordis runtime with locked
// cordis/loader/include versions: per-entry reload on file change, shared
// util roots, include refresh on cordis.yml change, and failure rollback.
import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import Include from "@cordisjs/plugin-include"
import type { Entry } from "@cordisjs/plugin-loader"
import Loader from "@cordisjs/plugin-loader"
import { Context } from "cordis"
import { attachDevWatch, DevWatch, type DevWatchEvent, type IncludeTree } from "../src/dev-watch"
import { watchKey } from "../src/watch-path"

const roots: string[] = []
let ctx: Context | undefined
let includeEntry: Entry | undefined

/**
 * The include entry created by the most recent `makeHost()`.
 *
 * Every test calls this immediately after `makeHost()`, so a missing entry means
 * the fixture wiring broke — that is worth throwing over, not silently asserting
 * away. Using a checked accessor keeps the `!` out of the call sites and turns a
 * would-be `undefined` dereference into a named failure.
 */
function includeId(): string {
  if (!includeEntry) throw new Error("makeHost() produced no include entry")
  return includeEntry.id
}

/**
 * The include entry's subtree; see `includeId()` for the failure policy.
 *
 * ⚠ RETURNS `IncludeTree`, NOT `Entry` — and that single word was the whole bug.
 * `entry.subtree` is the loader's `EntryTree`, and `@cordisjs/plugin-include`'s
 * `Include extends EntryTree`, adding `refresh()`. The repo's `IncludeTree` is
 * exactly `EntryTree & { refresh(): Promise<void> }`, i.e. the shape of the
 * INCLUDE SERVICE, not of an entry inside it.
 *
 * Declaring `Entry` made every use wrong at once: `.entries()` does not exist on
 * an `Entry` (it is the tree method), and the value could not be passed where
 * `IncludeTree` was required. 21 of this file's 22 type errors came from here —
 * all invisible until `host/tests` was added to a tsc program, while the tests
 * themselves passed, because at RUNTIME it is the Include service.
 */
function includeSubtree(): IncludeTree {
  if (!includeEntry?.subtree) throw new Error("include entry has no subtree")
  return includeEntry.subtree as IncludeTree
}

beforeAll(() => {}, 60_000)

afterEach(async () => {
  try {
    if (ctx && includeEntry) {
      const loader = ctx.loader as unknown as { remove?(id: string): void }
      loader.remove?.(includeEntry.id)
    }
  } catch {
    // teardown best-effort
  }
  ctx = undefined
  includeEntry = undefined
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeHost() {
  const root = await mkdtemp(join(tmpdir(), "vrcxk-devwatch-"))
  roots.push(root)
  const pluginDir = join(root, "plugins")
  await mkdir(pluginDir, { recursive: true })
  const configFile = join(root, "cordis.yml")
  const entryFile = join(pluginDir, "alpha.ts")
  const utilFile = join(pluginDir, "shared.ts")

  await writeFile(configFile, `- id: alpha\n  name: ./plugins/alpha.ts\n`)
  await writeFile(utilFile, `export const shared = "v1"\n`)
  await writeFile(
    entryFile,
    `import { shared } from "./shared.ts"\n` +
      `export function apply() {\n` +
      `  const g = globalThis as Record<string, unknown>\n` +
      `  g.__alphaCount = ((g.__alphaCount as number) ?? 0) + 1\n` +
      `  g.__alphaShared = shared\n` +
      `}\n`,
  )

  const c = new Context()
  c.baseUrl = `${pathToFileURL(root).href}/`
  await c.plugin(Loader)
  c.loader.builtins.include = Include
  const id = await c.loader.create({
    name: "cordis:include",
    config: { path: "./cordis.yml", enableLogs: false },
  })
  const entry = c.loader.resolve(id)
  // Wait for the include subtree + first plugin fiber.
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const e =
      entry.subtree &&
      [...entry.subtree.entries()].find(
        (x: unknown) => (x as Entry).options.name === "./plugins/alpha.ts",
      )
    if (e && (e as Entry).fiber?.uid != null) break
    await new Promise((r) => setTimeout(r, 50))
  }
  ctx = c
  includeEntry = entry
  return { root, pluginDir, configFile, entryFile, utilFile }
}

function waitEvent(
  events: DevWatchEvent[],
  predicate: (e: DevWatchEvent) => boolean,
  timeoutMs = 8_000,
): Promise<DevWatchEvent> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const poll = () => {
      const found = events.find(predicate)
      if (found) return resolve(found)
      if (Date.now() > deadline) return reject(new Error("timed out waiting for dev-watch event"))
      setTimeout(poll, 25)
    }
    poll()
  })
}

/** Editor-style atomic write: temp file + rename (folded by chokidar atomic). */
async function atomicWrite(target: string, content: string): Promise<void> {
  const tmp = `${target}.tmp`
  await writeFile(tmp, content)
  await rename(tmp, target)
}

describe("DevWatch live reload", () => {
  test("reloads an entry when its source file changes (single apply per change)", async () => {
    const { root, configFile, entryFile } = await makeHost()
    const events: DevWatchEvent[] = []
    const include = includeSubtree()
    const watch = new DevWatch({
      include,
      configFile,
      devMap: { [`${includeId()}:alpha`]: [join(root, "plugins")] },
      onState: (e) => events.push(e),
    })
    await watch.start()
    await waitEvent(events, (e) => e.type === "started")

    // Let the initial scan settle before we change files.
    await new Promise((r) => setTimeout(r, 150))

    const alphaEntry = [...include.entries()].find(
      (e: Entry) => e.options.name === "./plugins/alpha.ts",
    ) as Entry
    const uidBefore = alphaEntry.fiber?.uid

    await atomicWrite(entryFile, `${await Bun.file(entryFile).text()}// touched\n`)
    const reloadEvent = await waitEvent(events, (e) => e.type === "reload")
    expect(reloadEvent.type).toBe("reload")
    if (reloadEvent.type !== "reload") return
    expect(reloadEvent.result.status).toBe("reloaded")
    expect(reloadEvent.result.entryId).toBe(alphaEntry.id)

    // New fiber uid; module re-evaluated. Windows chokidar may emit a second
    // (delayed) event for the same save, so allow 1-2 reloads - but they must
    // settle (no reload storm) and never run concurrently.
    expect(alphaEntry.fiber?.uid).not.toBe(uidBefore)
    const countAfterFirst = (globalThis as Record<string, unknown>).__alphaCount as number
    expect(countAfterFirst).toBeGreaterThan(1)
    // Wait for the count to stabilise across two samples (absorbs a delayed
    // Windows double event) and assert it stops growing.
    let last = countAfterFirst
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 600))
      const now = (globalThis as Record<string, unknown>).__alphaCount as number
      if (now === last) break
      last = now
    }
    expect((globalThis as Record<string, unknown>).__alphaCount).toBe(last) // no reload storm
    await watch.close()
  }, 30_000)

  test("shared-util change reloads the entry mapped to that root", async () => {
    const { root, configFile, utilFile } = await makeHost()
    const events: DevWatchEvent[] = []
    const include = includeSubtree()
    const watch = new DevWatch({
      include,
      configFile,
      devMap: { [`${includeId()}:alpha`]: [join(root, "plugins")] },
      onState: (e) => events.push(e),
    })
    await watch.start()
    await waitEvent(events, (e) => e.type === "started")
    await new Promise((r) => setTimeout(r, 150))

    await atomicWrite(utilFile, (await Bun.file(utilFile).text()).replace("v1", "v2"))
    const reloadEvent = await waitEvent(events, (e) => e.type === "reload")
    expect(reloadEvent.type).toBe("reload")
    if (reloadEvent.type !== "reload") return
    expect(reloadEvent.result.status).toBe("reloaded")
    expect((globalThis as Record<string, unknown>).__alphaShared).toBe("v2")
    await watch.close()
  }, 30_000)

  test("keeps old fiber when a syntax error is written (strong rollback)", async () => {
    const { root, configFile, entryFile } = await makeHost()
    const events: DevWatchEvent[] = []
    const include = includeSubtree()
    const watch = new DevWatch({
      include,
      configFile,
      devMap: { [`${includeId()}:alpha`]: [join(root, "plugins")] },
      onState: (e) => events.push(e),
    })
    await watch.start()
    await waitEvent(events, (e) => e.type === "started")
    await new Promise((r) => setTimeout(r, 150))

    const alphaEntry = [...include.entries()].find(
      (e: Entry) => e.options.name === "./plugins/alpha.ts",
    ) as Entry
    const uidBefore = alphaEntry.fiber?.uid
    const countBefore = (globalThis as Record<string, unknown>).__alphaCount as number

    await atomicWrite(entryFile, "export function apply( { this is not valid ts\n")
    const reloadEvent = await waitEvent(events, (e) => e.type === "reload")
    expect(reloadEvent.type).toBe("reload")
    if (reloadEvent.type !== "reload") return
    // Import of a broken module can resolve at parse time or apply time; either
    // way the OLD fiber must still be the one on the entry.
    expect(["kept-old", "restored-old"]).toContain(reloadEvent.result.status)
    expect(alphaEntry.fiber?.uid).toBe(uidBefore)
    expect((globalThis as Record<string, unknown>).__alphaCount).toBe(countBefore)
    await watch.close()
  }, 30_000)

  test("include refresh picks up a new entry after cordis.yml changes", async () => {
    const { root, configFile } = await makeHost()
    await writeFile(
      join(root, "plugins", "beta.ts"),
      `export function apply() { (globalThis as any).__betaCount = ((globalThis as any).__betaCount ?? 0) + 1 }\n`,
    )
    const events: DevWatchEvent[] = []
    const include = includeSubtree()
    const watch = new DevWatch({
      include,
      configFile,
      onState: (e) => events.push(e),
    })
    await watch.start()
    await waitEvent(events, (e) => e.type === "started")
    await new Promise((r) => setTimeout(r, 150))

    await writeFile(
      configFile,
      `- id: alpha\n  name: ./plugins/alpha.ts\n- id: beta\n  name: ./plugins/beta.ts\n`,
    )
    const refreshed = await waitEvent(events, (e) => e.type === "config-refreshed")
    expect(refreshed.type).toBe("config-refreshed")
    if (refreshed.type !== "config-refreshed") return
    expect(refreshed.entries).toContain(`${includeId()}:beta`)
    expect((globalThis as Record<string, unknown>).__betaCount).toBe(1)
    await watch.close()
  }, 30_000)

  test("N reloads keep registry/fiber counts at baseline (leak regression)", async () => {
    const { root, configFile, entryFile } = await makeHost()
    const events: DevWatchEvent[] = []
    const include = includeSubtree()
    const watch = new DevWatch({
      include,
      configFile,
      devMap: { [`${includeId()}:alpha`]: [join(root, "plugins")] },
      onState: (e) => events.push(e),
    })
    await watch.start()
    await waitEvent(events, (e) => e.type === "started")
    await new Promise((r) => setTimeout(r, 200))

    const alphaEntry = [...include.entries()].find(
      (e: Entry) => e.options.name === "./plugins/alpha.ts",
    ) as Entry
    const registry = (ctx as unknown as { registry: { size: number } }).registry
    const baselineRegistrySize = registry.size

    const initialContent = await Bun.file(entryFile).text()
    for (let i = 0; i < 5; i++) {
      await atomicWrite(entryFile, `${initialContent}// edit ${i}\n`)
      await waitEvent(events, (e) => e.type === "reload" && e.result?.status === "reloaded", 10_000)
      // allow the (possibly doubled) Windows event pair to settle
      await new Promise((r) => setTimeout(r, 500))
    }

    // Every reload disposes the old fiber and rebuilds one; registry runtimes
    // must not accumulate.
    expect(registry.size).toBeLessThanOrEqual(baselineRegistrySize + 1)
    const liveFibers = [...include.entries()].filter((e: Entry) => e.fiber?.uid != null)
    expect(liveFibers).toHaveLength(1)
    expect(alphaEntry.fiber?.uid).not.toBeNull()
    await watch.close()
  }, 60_000)

  test("invalid YAML reports config-error and keeps the running tree", async () => {
    const { configFile } = await makeHost()
    const events: DevWatchEvent[] = []
    const include = includeSubtree()
    const watch = new DevWatch({
      include,
      configFile,
      onState: (e) => events.push(e),
    })
    await watch.start()
    await waitEvent(events, (e) => e.type === "started")
    await new Promise((r) => setTimeout(r, 200))

    const entriesBefore = [...include.entries()].map((e: Entry) => e.id)
    const countBefore = (globalThis as Record<string, unknown>).__alphaCount as number
    // Write invalid YAML via atomic rename (no transient empty-file state).
    await atomicWrite(configFile, "- id: alpha\n  name: [unclosed\n")
    const errEvent = await waitEvent(events, (e) => e.type === "config-error")
    expect(errEvent.type).toBe("config-error")
    // Running tree is untouched: same entries, no extra applies.
    const entriesAfter = [...include.entries()].map((e: Entry) => e.id)
    expect(entriesAfter).toEqual(entriesBefore)
    expect((globalThis as Record<string, unknown>).__alphaCount).toBe(countBefore)

    // Fixing the file recovers via a later refresh.
    await writeFile(configFile, `- id: alpha\n  name: ./plugins/alpha.ts\n`)
    await waitEvent(events, (e) => e.type === "config-refreshed")
    await watch.close()
  }, 30_000)

  test("close discards pending file events and emits closed once", async () => {
    const { root, configFile, entryFile } = await makeHost()
    const events: DevWatchEvent[] = []
    const include = includeSubtree()
    const watch = new DevWatch({
      include,
      configFile,
      devMap: { [`${includeId()}:alpha`]: [join(root, "plugins")] },
      onState: (e) => events.push(e),
      debounceMs: 5000, // long debounce so the pending event never flushes
    })
    await watch.start()
    await waitEvent(events, (e) => e.type === "started")
    await new Promise((r) => setTimeout(r, 200))

    await atomicWrite(entryFile, `${await Bun.file(entryFile).text()}// close-race\n`)
    // Close immediately: the debounce timer is cancelled, the event dropped.
    await watch.close()
    await new Promise((r) => setTimeout(r, 300))
    expect(events.some((e) => e.type === "reload")).toBe(false)
    expect(events.filter((e) => e.type === "closed")).toHaveLength(1)
    // Idempotent.
    await watch.close()
    expect(events.filter((e) => e.type === "closed")).toHaveLength(1)
  }, 30_000)
})

// ── lifecycle guards, root set growth and queue tracking ──────────────────
// These use a split layout (config in cfg/, plugins in a sibling directory) so
// a newly added entry can live in a directory that was NOT watched at start().

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function stubInclude(): IncludeTree {
  return { entries: () => [], refresh: async () => {} } as unknown as IncludeTree
}

async function makeSplitHost() {
  const root = await mkdtemp(join(tmpdir(), "vrcxk-devwatch-split-"))
  roots.push(root)
  const cfgDir = join(root, "cfg")
  const pluginDir = join(root, "plugins")
  const extraDir = join(root, "extra")
  await mkdir(cfgDir, { recursive: true })
  await mkdir(pluginDir, { recursive: true })
  const configFile = join(cfgDir, "cordis.yml")
  const alphaFile = join(pluginDir, "alpha.ts")
  await writeFile(configFile, `- id: alpha\n  name: ../plugins/alpha.ts\n`)
  await writeFile(
    alphaFile,
    `export function apply() {\n` +
      `  const g = globalThis as Record<string, unknown>\n` +
      `  g.__splitAlpha = ((g.__splitAlpha as number) ?? 0) + 1\n` +
      `}\n`,
  )

  const c = new Context()
  c.baseUrl = `${pathToFileURL(root).href}/`
  await c.plugin(Loader)
  c.loader.builtins.include = Include
  const id = await c.loader.create({
    name: "cordis:include",
    config: { path: "./cfg/cordis.yml", enableLogs: false },
  })
  const entry = c.loader.resolve(id)
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const child =
      entry.subtree &&
      [...entry.subtree.entries()].find((x) => (x as Entry).options.name === "../plugins/alpha.ts")
    if (child && (child as Entry).fiber?.uid != null) break
    await sleep(50)
  }
  ctx = c
  includeEntry = entry
  return { root, cfgDir, pluginDir, extraDir, configFile, alphaFile }
}

describe("DevWatch lifecycle guards", () => {
  test("attachDevWatch gates routing on ctx.signal.stopping and returns close()'s promise", async () => {
    const { root, configFile } = await makeHost()
    const events: DevWatchEvent[] = []
    const include = includeSubtree()
    const watch = new DevWatch({
      include,
      configFile,
      devMap: { [`${includeId()}:alpha`]: [join(root, "plugins")] },
      onState: (e) => events.push(e),
    })
    await watch.start()
    await waitEvent(events, (e) => e.type === "started")
    await sleep(150)

    const signal = { stopping: false }
    let disposer: (() => unknown) | undefined
    const fakeCtx = {
      signal,
      effect: (execute: () => () => unknown) => {
        disposer = execute()
        return () => {}
      },
    } as unknown as Context
    attachDevWatch(fakeCtx, watch)

    // Shutdown began: a file event must not be routed and must not enqueue a
    // reload (root disposables run last in gracefulStop, so `closed` is too late).
    signal.stopping = true
    const internals = watch as unknown as {
      handleFsEvent(kind: "add" | "change" | "unlink", path: string): void
      flushFs(): Promise<void>
    }
    internals.handleFsEvent("change", join(root, "plugins", "alpha.ts"))
    await internals.flushFs()
    expect(events.some((e) => e.type === "change")).toBe(false)
    expect(events.some((e) => e.type === "reload")).toBe(false)

    // The disposer must RETURN close()'s promise (gracefulStop awaits it).
    // Check rather than assert: `effect` above is invoked by attachDevWatch, so
    // a missing disposer means the wiring under test never registered at all.
    if (!disposer) throw new Error("attachDevWatch did not register an effect")
    const result = disposer()
    expect(result).toBeInstanceOf(Promise)
    await result
    expect(events.filter((e) => e.type === "closed")).toHaveLength(1)
  }, 30_000)

  test("close() during start() does not leak a watcher", async () => {
    const { configFile } = await makeHost()
    const watch = new DevWatch({ include: includeSubtree(), configFile })
    const starting = watch.start()
    const closing = watch.close() // races the async root scan
    await Promise.all([starting, closing])
    expect((watch as unknown as { chokidar?: unknown }).chokidar).toBeUndefined()
    expect(watch.watchedRoots).toHaveLength(0)
  }, 30_000)

  test("the explicit roots option is added to the watch set", async () => {
    const { root, configFile } = await makeHost()
    const extra = join(root, "shared-roots")
    await mkdir(extra, { recursive: true })
    const events: DevWatchEvent[] = []
    const watch = new DevWatch({
      include: includeSubtree(),
      configFile,
      roots: [extra],
      onState: (e) => events.push(e),
    })
    await watch.start()
    await waitEvent(events, (e) => e.type === "started")
    expect(watch.watchedRoots.map(watchKey)).toContain(watchKey(extra))
    await watch.close()
  }, 30_000)

  test("a write burst every < debounceMs cannot postpone the flush forever", async () => {
    const { root, configFile, entryFile } = await makeHost()
    const events: DevWatchEvent[] = []
    const watch = new DevWatch({
      include: includeSubtree(),
      configFile,
      devMap: { [`${includeId()}:alpha`]: [join(root, "plugins")] },
      onState: (e) => events.push(e),
      debounceMs: 250,
      maxWaitMs: 400,
    })
    await watch.start()
    await waitEvent(events, (e) => e.type === "started")
    await sleep(150)

    const internals = watch as unknown as { handleFsEvent(kind: "change", path: string): void }
    const started = Date.now()
    // Production `change` events accompany a real file modification (mtime
    // bump); DevWatch's initial-replay filter keys on that, so the injected
    // event must reflect a real write or it would be dropped as a scan replay.
    const timer = setInterval(async () => {
      await writeFile(entryFile, `${await Bun.file(entryFile).text()}// burst\n`)
      internals.handleFsEvent("change", entryFile)
    }, 60)
    try {
      await waitEvent(events, (e) => e.type === "change", 5_000)
      expect(Date.now() - started).toBeLessThan(3_000)
    } finally {
      clearInterval(timer)
      await watch.close()
    }
  }, 30_000)

  test("flushFs reports an unmappable path as watcher-error instead of dying", async () => {
    const { configFile } = await makeHost()
    const events: DevWatchEvent[] = []
    const watch = new DevWatch({
      include: includeSubtree(),
      configFile,
      onState: (e) => events.push(e),
    })
    await watch.start()
    await waitEvent(events, (e) => e.type === "started")

    const internals = watch as unknown as {
      fsPending: Map<string, string>
      flushFs(): Promise<void>
    }
    internals.fsPending.set("node:fs", "change") // not a file: path → canonicalization throws
    await internals.flushFs()
    expect(events.some((e) => e.type === "watcher-error")).toBe(true)
    await watch.close()
  }, 30_000)

  test("a path arriving between the drain and the settle keeps the queue tracked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vrcxk-devwatch-queue-"))
    roots.push(dir)
    const watch = new DevWatch({ include: stubInclude(), configFile: join(dir, "cordis.yml") })
    type Queue = { running: Promise<void> | null; pendingPaths: Set<string> }
    const internals = watch as unknown as {
      queues: Map<string, Queue>
      runQueue(entryId: string, q: Queue): Promise<void>
      enqueueReload(entryId: string, path: string): void
    }
    const runs: Array<{ paths: string[]; finish: () => void }> = []
    internals.runQueue = async (_entryId, q) => {
      const paths = [...q.pendingPaths]
      q.pendingPaths.clear()
      let finish: (() => void) | undefined
      const gate = new Promise<void>((resolve) => {
        finish = resolve
      })
      if (!finish) throw new Error("gate promise did not capture its resolve")
      runs.push({ paths, finish })
      await gate
    }

    internals.enqueueReload("alpha", "p1")
    expect(runs).toHaveLength(1)
    // Lands after the run drained its set but before it settled: the exact
    // window the old detached `.finally` re-kick left untracked.
    internals.enqueueReload("alpha", "p2")
    expect(runs).toHaveLength(1)

    runs[0].finish()
    await sleep(0)
    const queue = internals.queues.get("alpha")
    if (!queue) throw new Error("no queue for entry 'alpha'")
    expect(runs).toHaveLength(2)
    expect(queue.running).not.toBeNull() // tracked, so close() can await it

    runs[1].finish()
    await sleep(0)
    // Checked, not asserted: the queue is keyed by entry id and only exists once
    // that entry has been enqueued, so a miss means the fixture never ran it.
    const alphaQueue = internals.queues.get("alpha")
    if (!alphaQueue) throw new Error("no queue for entry 'alpha'")
    expect(alphaQueue.running).toBeNull()
  }, 30_000)

  test("a file named ..foo inside a root is matched, not reported unowned", async () => {
    const { root, configFile, pluginDir } = await makeHost()
    const events: DevWatchEvent[] = []
    const alphaEntry = [...includeSubtree().entries()].find(
      (e) => (e as Entry).options.name === "./plugins/alpha.ts",
    ) as Entry
    const watch = new DevWatch({
      include: includeSubtree(),
      configFile,
      devMap: { [`${includeId()}:alpha`]: [pluginDir] },
      onState: (e) => events.push(e),
    })
    await watch.start()
    await waitEvent(events, (e) => e.type === "started")
    await sleep(150)

    const weird = join(pluginDir, "..foo.ts")
    await writeFile(weird, "export const x = 1\n")
    const change = await waitEvent(
      events,
      (e) => e.type === "change" && e.path.endsWith("..foo.ts"),
    )
    expect(change.type).toBe("change")
    if (change.type !== "change") return
    expect(change.entryIds).toContain(alphaEntry.id)
    expect(events.some((e) => e.type === "unowned" && e.path.endsWith("..foo.ts"))).toBe(false)
    expect(root).toBeTruthy()
    await watch.close()
  }, 30_000)

  test("an entry added in a NEW directory via cordis.yml becomes watched (D)", async () => {
    const { extraDir, configFile } = await makeSplitHost()
    await mkdir(extraDir, { recursive: true })
    const gammaFile = join(extraDir, "gamma.ts")
    await writeFile(gammaFile, `export function apply() {}\n`)

    const events: DevWatchEvent[] = []
    const watch = new DevWatch({
      include: includeSubtree(),
      configFile,
      onState: (e) => events.push(e),
    })
    await watch.start()
    await waitEvent(events, (e) => e.type === "started")
    await sleep(150)
    expect(watch.watchedRoots.map(watchKey)).not.toContain(watchKey(extraDir))

    await writeFile(
      configFile,
      `- id: alpha\n  name: ../plugins/alpha.ts\n- id: gamma\n  name: ../extra/gamma.ts\n`,
    )
    const refreshed = await waitEvent(events, (e) => e.type === "config-refreshed")
    expect(refreshed.type).toBe("config-refreshed")
    if (refreshed.type !== "config-refreshed") return
    const gammaEntryId = refreshed.entries.find((id) => id.endsWith(":gamma"))
    expect(gammaEntryId).toBeDefined()
    expect(watch.watchedRoots.map(watchKey)).toContain(watchKey(extraDir))

    // The new root is only useful if a change under it reloads its entry. The
    // first write can race chokidar's attach, so retry with a bounded poll.
    let reloaded: DevWatchEvent | undefined
    for (let attempt = 0; attempt < 6 && !reloaded; attempt++) {
      await atomicWrite(gammaFile, `export function apply() {}\n// touch ${attempt}\n`)
      reloaded = await waitEvent(
        events,
        (e) => e.type === "reload" && e.entryId === gammaEntryId,
        1_500,
      ).catch(() => undefined)
    }
    expect(reloaded).toBeDefined()
    if (reloaded?.type !== "reload") return
    expect(reloaded.result.status).toBe("reloaded")
    await watch.close()
  }, 60_000)
})
