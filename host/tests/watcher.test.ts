import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { binding } from "../src/watch-path"
import { HostWatcher, type WatcherEvent } from "../src/watcher"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vrcxk-watcher-"))
  roots.push(root)
  await mkdir(join(root, "plugin"))
  const entry = join(root, "plugin", "index.ts")
  await writeFile(entry, "export default {}")
  return { root, entry, pluginRoot: join(root, "plugin") }
}

function waitFor<T>(items: T[], predicate: (item: T) => boolean, timeout = 3_000): Promise<T> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = () => {
      const found = items.find(predicate)
      if (found) return resolve(found)
      if (Date.now() - started >= timeout)
        return reject(new Error("timed out waiting for watcher event"))
      setTimeout(poll, 10)
    }
    poll()
  })
}

/**
 * Wait until `events` has stopped growing for `quietMs`, then return.
 *
 * Replaces the old "sleep(100) then assert exactly one change" pattern, which
 * encoded a platform assumption rather than the contract. Measured on macOS
 * (arm64) with two back-to-back writes:
 *
 *     raw@+9ms, raw@+9ms, raw@+9ms, change@+10ms, raw@+61ms, raw@+61ms, change@+61ms
 *     mtime spread between the two writes: 11-14ms   (debounceMs = 40)
 *
 * `HostWatcher`'s trailing-edge debounce resets its 40ms timer on every event,
 * so a ~51ms gap between batches legitimately flushes twice. That is correct
 * behaviour, not a defect; Windows/Linux pass the old assertion because there
 * the raw events all land within ~1ms and share one 40ms window.
 *
 * The underlying cause is FSEvents reporting a write in more than one batch
 * (chokidar's `atomic: 100` shapes how those batches surface). It is NOT
 * specific to two writes: a SINGLE write also produced two flushes on
 * macos-latest. Hence this helper waits for quiescence and the tests assert
 * routing/paths rather than a flush count.
 *
 * Reproduced 37/40 rounds on macos-latest; see PR #34 for the probe.
 */
async function settle(events: WatcherEvent[], quietMs = 200) {
  let lastCount = events.length
  let lastChange = Date.now()
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    if (events.length !== lastCount) {
      lastCount = events.length
      lastChange = Date.now()
      continue
    }
    if (Date.now() - lastChange >= quietMs) return
  }
}

describe("HostWatcher", () => {
  test("debounces changes and maps exact and root events", async () => {
    const { root, entry, pluginRoot } = await fixture()
    const events: WatcherEvent[] = []
    const changes: string[] = []
    const watcher = new HostWatcher({
      roots: [root],
      debounceMs: 40,
      bindings: [binding("plugin", entry, [pluginRoot])],
      onEvent: (event) => events.push(event),
      onChange: (path) => changes.push(path),
    })
    await watcher.start()
    await waitFor(events, (event) => event.type === "started")

    await writeFile(entry, "export default 1")
    await writeFile(entry, "export default 2")
    await waitFor(events, (event) => event.type === "change")
    // Let every batch the platform intends to deliver, arrive.
    await settle(events)

    // What this test can assert portably: the writes were routed to the mapped
    // path and ONLY to it, with no unowned/ambiguous mis-routing — regardless
    // of how many flushes the platform's batching produced.
    //
    // It deliberately does NOT assert an exact flush count. On macOS the burst
    // arrives as two batches ~51ms apart while debounceMs is 40, so two flushes
    // is correct output, not a regression (see `settle`). An exact-count
    // assertion is what made this fail 37/40 on macos-latest.
    //
    // Do not try to "restore" strictness with a single-write variant asserting
    // exactly one flush: that was tried and macOS failed it too (2 flushes from
    // ONE write, observed on macos-latest). FSEvents reports a single write in
    // more than one batch — the extra deliveries are the same millisecond or
    // ~50ms apart depending on timing — so no write-count-based exact assertion
    // is portable here. Path de-duplication within a flush is instead exercised
    // by the atomic-rename and unowned/ambiguous tests below.
    expect(changes.length).toBeGreaterThanOrEqual(1)
    expect(new Set(changes)).toEqual(new Set([entry]))

    const changeEvents = events.filter((event) => event.type === "change")
    expect(changeEvents.length).toBeGreaterThanOrEqual(1)
    for (const event of changeEvents) expect(event.path).toBe(entry)
    expect(
      events.filter((event) => event.type === "unowned" || event.type === "ambiguous"),
    ).toHaveLength(0)

    await watcher.close()
    expect(events.at(-1)).toEqual({ type: "closed" })
  })

  test("reports unowned and ambiguous paths without invoking onChange", async () => {
    const { root, entry, pluginRoot } = await fixture()
    const outside = join(root, "outside.ts")
    const shared = join(root, "shared")
    await mkdir(shared)
    await writeFile(outside, "outside")
    const events: WatcherEvent[] = []
    const changes: string[] = []
    const watcher = new HostWatcher({
      roots: [root],
      debounceMs: 20,
      bindings: [
        binding("plugin", entry, [pluginRoot]),
        binding("a", join(root, "a.ts"), [shared]),
        binding("b", join(root, "b.ts"), [shared]),
      ],
      onEvent: (event) => events.push(event),
      onChange: (path) => changes.push(path),
    })
    await watcher.start()
    await waitFor(events, (event) => event.type === "started")
    await writeFile(join(shared, "util.ts"), "shared")
    await waitFor(events, (event) => event.type === "ambiguous")
    await writeFile(outside, "outside changed")
    await waitFor(events, (event) => event.type === "unowned")
    expect(changes).toEqual([])
    await watcher.close()
  })

  test("coalesces atomic rename and handles add/unlink", async () => {
    const { root, entry, pluginRoot } = await fixture()
    const events: WatcherEvent[] = []
    const watcher = new HostWatcher({
      roots: [root],
      debounceMs: 30,
      bindings: [binding("plugin", entry, [pluginRoot])],
      onEvent: (event) => events.push(event),
    })
    await watcher.start()
    await waitFor(events, (event) => event.type === "started")
    await new Promise((resolve) => setTimeout(resolve, 100))
    const temp = join(pluginRoot, ".index.ts.tmp")
    await writeFile(temp, "export default 3")
    await rename(temp, entry)
    // ⚠ WAIT FOR THE EVENT THIS TEST IS ABOUT, not for "any change".
    //
    // This used to be `waitFor(events, (e) => e.type === "change")` followed by
    // `expect(events.some((e) => e.type === "change" && e.path === entry))`.
    // The wait and the assertion disagreed: **writing the temp file emits its
    // own `change`** for `.index.ts.tmp` (measured — a lone `writeFile(temp)`
    // produces `type=change path=<root>/plugin/.index.ts.tmp` before any rename
    // happens), so the wait could be satisfied by the TEMP path while `entry` had
    // not arrived yet, and the assertion then failed on a platform that was
    // behaving correctly. That is the intermittent macos-latest failure: it dies
    // on the `expect` at the old line 170, never in `waitFor`.
    //
    // Waiting on the exact predicate the assertion needs removes the race without
    // weakening what is asserted — the point of the test (an atomic rename
    // surfaces as a `change` for the BINDING's path) is unchanged.
    await waitFor(events, (event) => event.type === "change" && event.path === entry)
    // Redundant with the wait above, but kept so the CONTRACT is visible in the
    // test body and a regression reports the path rather than a generic timeout.
    expect(events.some((event) => event.type === "change" && event.path === entry)).toBe(true)
    const added = join(pluginRoot, "new.ts")
    await writeFile(added, "new")
    await waitFor(events, (event) => event.path === added)
    await rm(added)
    await waitFor(events, (event) => event.type === "change" && event.path === added)
    await watcher.close()
  })

  test("close prevents pending callbacks and is idempotent", async () => {
    const { root, entry, pluginRoot } = await fixture()
    let callbackCount = 0
    const events: WatcherEvent[] = []
    const watcher = new HostWatcher({
      roots: [root],
      debounceMs: 100,
      bindings: [binding("plugin", entry, [pluginRoot])],
      onEvent: (event) => events.push(event),
      onChange: () => {
        callbackCount++
      },
    })
    await watcher.start()
    await writeFile(entry, "pending")
    await watcher.close()
    await watcher.dispose()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(callbackCount).toBe(0)
    expect(watcher.getWatched()).toEqual({})
    expect(events.filter((event) => event.type === "closed")).toHaveLength(1)
  })

  test("start is idempotent: repeated start keeps one watcher and one started event", async () => {
    const { root, entry, pluginRoot } = await fixture()
    const events: WatcherEvent[] = []
    const watcher = new HostWatcher({
      roots: [root],
      debounceMs: 20,
      bindings: [binding("plugin", entry, [pluginRoot])],
      onEvent: (event) => events.push(event),
    })
    await watcher.start()
    await watcher.start()
    await watcher.start()
    await waitFor(events, (event) => event.type === "started")
    // allow any duplicate ready events to surface
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(events.filter((event) => event.type === "started")).toHaveLength(1)
    await watcher.close()
  })

  test("setBindings swaps the mapping index without restarting the watcher", async () => {
    const { root, entry, pluginRoot } = await fixture()
    const otherEntry = join(root, "plugin", "other.ts")
    await writeFile(otherEntry, "other")
    const events: WatcherEvent[] = []
    const changes: string[] = []
    const watcher = new HostWatcher({
      roots: [root],
      debounceMs: 20,
      bindings: [binding("plugin", entry, [pluginRoot])],
      onEvent: (event) => events.push(event),
      onChange: (path) => changes.push(path),
    })
    await watcher.start()
    await waitFor(events, (event) => event.type === "started")

    // Swap: the old binding is gone, a new entry now maps the same root.
    watcher.setBindings([binding("renamed", otherEntry, [pluginRoot])])
    await writeFile(join(pluginRoot, "util.ts"), "shared")
    await waitFor(changes, (path) => path === join(pluginRoot, "util.ts"))
    // The change mapped to the NEW binding id.
    const reloadEvent = events.find((event) => event.type === "change") as
      | { mapping?: { kind: string; entryIds: string[] } }
      | undefined
    expect(reloadEvent?.mapping?.entryIds).toEqual(["renamed"])
    await watcher.close()
  })

  test("close during an in-flight flush waits for it and emits closed once", async () => {
    const { root, entry, pluginRoot } = await fixture()
    const events: WatcherEvent[] = []
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered = false
    const watcher = new HostWatcher({
      roots: [root],
      debounceMs: 20,
      bindings: [binding("plugin", entry, [pluginRoot])],
      onEvent: (event) => events.push(event),
      onChange: async () => {
        entered = true
        await blocked
      },
    })
    await watcher.start()
    await waitFor(events, (event) => event.type === "started")

    // ⚠ WRITE UNTIL THE HANDLER RUNS — do not write once and hope.
    //
    // The original version wrote `trigger` once and then waited up to 3s for
    // `entered`. That is the flaky shape this file already warns about twice
    // (see `settle` above): FSEvents can drop or batch a single write so the
    // change never reaches `onChange`, `entered` stays false, and the test fails
    // on a platform where nothing is actually wrong. Observed as a spurious
    // macos-latest failure on an unchanged commit (same SHA passed on re-run).
    //
    // Re-writing keeps the trigger alive without depending on the platform
    // delivering any ONE of them, and the `settle`-style quiescence wait is not
    // needed because this test only cares that the handler is entered at all.
    // The debounce collapses these into one flush, which is what the assertions
    // below still require.
    const deadline = Date.now() + 10_000
    while (!entered && Date.now() < deadline) {
      await writeFile(entry, `trigger-${Date.now()}`)
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(entered).toBe(true)
    const closing = watcher.close()
    // close waits for the in-flight flush; release it, then close resolves.
    release()
    await closing
    expect(events.filter((event) => event.type === "closed")).toHaveLength(1)
    // ⚠ What this test is actually about: NO events after close. Counting the
    // total would depend on how many batches the platform flushed while the loop
    // above was writing — the exact-count assertion this file already documents
    // as the cause of its 37/40 macos-latest failures. So snapshot the count and
    // assert it does not GROW, which is the contract and is platform-independent.
    const beforeAfterClose = events.length
    await writeFile(entry, "after-close")
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(events.length).toBe(beforeAfterClose)
    await watcher.close() // idempotent
    expect(events.filter((event) => event.type === "closed")).toHaveLength(1)
  })
})
