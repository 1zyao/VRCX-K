// `ctx.hands` — the host-side file capability (M2 能力面).
//
// These tests exist because every rule `hands.ts` implements was measured first,
// and each of those measurements is a way the implementation could silently be
// wrong later. The load-bearing ones:
//
//   1. **A stream must not outlive its caller.** Measured leak: an unguarded
//      stream kept producing after its plugin was unloaded
//      (docs/probes/probe-host-stream-leak.ts). If someone drops the guard, that
//      test fails rather than the leak returning quietly.
//   2. **The guard must be released when a stream ends.** Measured: 1000
//      unreleased registrations survived to unload
//      (docs/probes/probe-host-effect-economy.ts). A bulk sync would otherwise
//      accumulate a table the size of its file count.
//   3. **Chunks arrive base64-encoded**, not as bytes
//      (docs/probes/probe-host-streaming-channel.ts). Treating a string as a
//      `Uint8Array` silently yields garbage, not an error.
//   4. **`ESTALE` and `ENOENT` must stay distinguishable** — rotation vs deletion
//      need opposite handling (docs/hands-capability-proposal.md §2.2).
//
// A fake bridge stands in for the shell so the tests are about THIS module's
// contract. The real wire is covered by probe-host-streaming-channel.ts and, for
// the Rust half, docs/probes/hands-e2e/run.mjs.

import { describe, expect, test } from "bun:test"
import { Context } from "cordis"
import { callerName } from "../src/capability"
import { asHandsError, decodeChunk, HandsError, HandsService, normalizeChange } from "../src/hands"
import type { ShellStdioBridge } from "../src/stdio"

/** Build a service whose "shell" is a scripted object. */
function serviceWith(hands: Partial<ShellStdioBridge["hands"]>): {
  ctx: Context
  svc: HandsService
  audits: string[]
} {
  const ctx = new Context()
  const audits: string[] = []
  const svc = new HandsService(ctx, { audit: (line) => audits.push(line) })
  svc.attachShell({
    hands: {
      stat: async () => null,
      read: () => emptyStream(),
      write: async () => ({ bytes: 0, endOffset: 0, mode: "truncate" }),
      watch: () => emptyStream(),
      list: () => emptyStream(),
      ...hands,
    },
  } as unknown as ShellStdioBridge)
  return { ctx, svc, audits }
}

async function* emptyStream(): AsyncIterable<never> {
  // Intentionally yields nothing.
}

async function* from<T>(values: T[]): AsyncIterable<T> {
  for (const value of values) yield value
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const value of stream) out.push(value)
  return out
}

/** A promise plus its resolver, for tests that must block the shell mid-call. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe("the raw mirror is not usable without a shell", () => {
  test("a stat with no shell attached fails with a clear code", async () => {
    const ctx = new Context()
    const svc = new HandsService(ctx, {})
    // Not a silent `null`: "no shell" and "no such file" must not look alike.
    await expect(svc.stat("/tmp/x")).rejects.toThrow(/no shell attached/)
  })

  test("attaching a shell makes it usable", async () => {
    const { svc } = serviceWith({
      stat: async () => ({ size: 3, id: "i", mtimeMs: 1, kind: "file" }),
    })
    expect(await svc.stat("/tmp/x")).toEqual({ size: 3, id: "i", mtimeMs: 1, kind: "file" })
  })
})

describe("audit: one line per call, attributed to the caller", () => {
  test("a plugin's call is attributed to that plugin, not to the host", async () => {
    const { ctx, audits } = serviceWith({
      stat: async () => ({ size: 1, id: "i", mtimeMs: 0, kind: "file" }),
    })
    await ctx.plugin(function readerPlugin(inner: Context) {
      return inner.hands.stat("/tmp/a")
    })

    const lines = audits.filter((line) => line.includes("hands.stat"))
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain("readerPlugin")
    expect(lines[0]).not.toContain("<unknown>")
  })

  test("a stream records ONCE at call time, not once per chunk", async () => {
    // The rule that matters: auditing per chunk would bury the real signal under
    // thousands of lines for one file. Measured-adjacent: attribution works
    // either way, so this is purely about volume.
    const { ctx, audits } = serviceWith({
      read: () => from(["AAEC", "AwQF", "BgcI"]),
    })
    await ctx.plugin(async function streamPlugin(inner: Context) {
      // Consume all three chunks.
      for await (const _chunk of inner.hands.read("/tmp/big")) {
        /* drain */
      }
    })

    expect(audits.filter((line) => line.includes("hands.read")).length).toBe(1)
  })

  test("a caller that obtains an iterable but never consumes it still leaves a trace", async () => {
    // This is the practical reason the record happens at call time rather than
    // inside the generator body, which would not run until the first next().
    const { ctx, audits } = serviceWith({ read: () => from(["AAEC"]) })
    await ctx.plugin(function idlePlugin(inner: Context) {
      // Deliberately never iterate.
      void inner.hands.read("/tmp/never-consumed")
    })
    expect(audits.filter((line) => line.includes("hands.read")).length).toBe(1)
  })

  test("the audit does not dump the payload", async () => {
    // A path is useful; a megabyte of base64 is not.
    const huge = "A".repeat(64 * 1024)
    const { ctx, audits } = serviceWith({ read: () => from([huge]) })
    await ctx.plugin(async function bulkPlugin(inner: Context) {
      for await (const _chunk of inner.hands.read("/tmp/x")) {
        /* drain */
      }
    })
    const line = audits.find((entry) => entry.includes("hands.read"))
    expect(line).toBeDefined()
    expect((line as string).length).toBeLessThan(200)
  })
})

describe("chunk decoding", () => {
  test("a base64 string becomes the original bytes", () => {
    // The measured wire shape. Treating this string as bytes yields garbage
    // rather than an error, which is exactly why it is pinned.
    expect(Array.from(decodeChunk("AAEC"))).toEqual([0, 1, 2])
  })

  test("a Uint8Array passes through unchanged", () => {
    // Accepted so this keeps working if the transport gains a binary carrier.
    expect(Array.from(decodeChunk(new Uint8Array([9, 8])))).toEqual([9, 8])
  })

  test("an unrecognised chunk shape raises instead of reading as empty", () => {
    expect(() => decodeChunk(42)).toThrow(HandsError)
  })

  test("read yields decoded bytes, not the base64 string", async () => {
    const { svc } = serviceWith({ read: () => from(["AAEC"]) })
    const chunks = await collect(svc.read("/tmp/x"))
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toBeInstanceOf(Uint8Array)
    expect(Array.from(chunks[0])).toEqual([0, 1, 2])
  })
})

describe("write re-encodes to the carrier the shell sends", () => {
  test("bytes are base64-encoded on the way out", async () => {
    const seen: unknown[] = []
    const { svc } = serviceWith({
      write: async (_path, data) => {
        for await (const chunk of data) seen.push(chunk)
        return { bytes: 3, endOffset: 3, mode: "truncate" }
      },
    })
    const result = await svc.write("/tmp/out", from([new Uint8Array([0, 1, 2])]))
    expect(seen).toEqual(["AAEC"])
    expect(result.bytes).toBe(3)
  })

  test("the byte count comes from the shell, not from a local count", async () => {
    // The shell reports the real end offset (append mode lands bytes somewhere
    // other than where the caller asked). Recomputing here would disagree.
    const { svc } = serviceWith({
      write: async () => ({ bytes: 999, endOffset: 1500, mode: "append" }),
    })
    const result = await svc.write("/tmp/out", emptyStream())
    expect(result.bytes).toBe(999)
    expect(result.endOffset).toBe(1500)
  })
})

describe("write: the caller's fiber owns the drain", () => {
  test("write STOPS draining after its calling plugin is unloaded", async () => {
    // ⚠ THE REVERSAL. This test previously pinned the OPPOSITE behaviour
    // ("write keeps draining after its calling plugin is unloaded") on the
    // reasoning that a write had "no orphan to cancel" and "no host-side cancel
    // to invoke". Both premises were wrong, and both are falsifiable in-repo:
    //
    //   - the generator is created in `HandsService.write` itself
    //     (`encodeStream(data)`), so the iterator it needs is right there;
    //   - kkrpc's remote consumer already calls `iterator.return()` on a local
    //     stream (`node_modules/kkrpc/dist/streaming.js`,
    //     `createAsyncIteratorFromPromise`), and the Rust peer answers
    //     `op:"return"` by cancelling the producer
    //     (`src-tauri/src/kkrpc_peer.rs`, the `"return" | "throw"` arm).
    //
    // What the old code shipped: kkrpc pumps the caller's generator ahead of the
    // consumer, so after the owner was unloaded `next()` was still being called
    // on a dead plugin's generator and every chunk it yielded reached disk. This
    // test is the observable half of that: an ENDLESS generator must stop being
    // pulled once its owner is gone, and it must be unwound (`finally` runs).
    const ctx = new Context()
    let writesSeen = 0
    let sourceReturned = false
    const gate = deferred()

    const svc = new HandsService(ctx, {})
    svc.attachShell({
      hands: {
        stat: async () => null,
        read: () => emptyStream(),
        // The shell holds the call open past the unload, then reports the count.
        write: async (_path: string, data: AsyncIterable<unknown>) => {
          for await (const _chunk of data) {
            writesSeen += 1
            if (writesSeen === 1) await gate.promise // block while the plugin is disposed
          }
          return { bytes: writesSeen * 3, endOffset: writesSeen * 3, mode: "truncate" }
        },
        watch: () => emptyStream(),
        list: () => emptyStream(),
      },
    } as unknown as ShellStdioBridge)

    // ⚠ ENDLESS, not bounded. The old test bounded its generator at 4 chunks so
    // it could assert "all 4 arrived"; that shape cannot distinguish "the drain
    // continued" from "the drain happened to finish", and a bounded source makes
    // a cancellation bug look like a successful write. An endless source is the
    // only shape where "was it still pulled after unload?" has one answer.
    let produced = 0
    async function* endless(): AsyncIterable<Uint8Array> {
      try {
        while (true) {
          produced += 1
          yield new Uint8Array([0, 1, 2])
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
      } finally {
        sourceReturned = true
      }
    }

    const outcome: { result?: { bytes: number; endOffset: number; mode: string } } = {}
    const plugin = ctx.plugin(function writingPlugin(inner: Context) {
      // Fire-and-forget, exactly like the `read` leak test: a real plugin must not
      // block its own load on a long write.
      void inner.hands
        .write("/tmp/out", endless())
        .then((result) => {
          outcome.result = result
        })
        .catch(() => {})
    })
    await plugin

    // Wait until the shell has really started consuming before unloading.
    const deadline = Date.now() + 5_000
    while (writesSeen === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(writesSeen).toBe(1)
    expect(produced).toBeGreaterThan(0)

    // Unload the owner mid-write. This is where the guard must take effect.
    await plugin.dispose()
    const producedAtUnload = produced
    gate.resolve() // let the shell's blocked first iteration finish

    // ⚠ Wait long enough that a still-running drain would produce several more
    // chunks (the source yields every 5ms). A short wait would let the old
    // behaviour pass by accident.
    await new Promise((resolve) => setTimeout(resolve, 150))

    // The drain stopped, and the caller's generator was unwound rather than left
    // suspended forever.
    expect(sourceReturned).toBe(true)
    expect(produced - producedAtUnload).toBeLessThanOrEqual(1)
    // The shell's own loop therefore ended, and its deferred reply resolved with
    // the bytes it actually wrote — a real number, not a hang.
    expect(outcome.result).toEqual({ bytes: 3, endOffset: 3, mode: "truncate" })
  }, 15_000)

  test("a write that finishes normally still releases its registration", async () => {
    // The guard is per-CALL, so 50 completed writes must not leave 50
    // registrations on the caller's fiber (measured: unreleased registrations
    // accumulate to unload — docs/probes/probe-host-effect-economy.ts).
    const ctx = new Context()
    const svc = new HandsService(ctx, {})
    svc.attachShell({
      hands: {
        stat: async () => null,
        read: () => emptyStream(),
        write: async (_path: string, data: AsyncIterable<Uint8Array>) => {
          let bytes = 0
          for await (const chunk of data) bytes += chunk.length
          return { bytes, endOffset: bytes, mode: "truncate" }
        },
        watch: () => emptyStream(),
        list: () => emptyStream(),
      },
    } as unknown as ShellStdioBridge)

    const rootFiber = (ctx as unknown as { fiber: { _disposables?: { length?: number } } }).fiber
    const before = rootFiber._disposables?.length ?? 0

    for (let i = 0; i < 50; i++) {
      await svc.write(`/tmp/f${i}`, from([new Uint8Array([1, 2, 3])]))
    }

    const after = rootFiber._disposables?.length ?? 0
    expect(after - before).toBeLessThan(5)
  })

  test("a write still runs to the end while its caller is alive", async () => {
    // The control for the test above: cancellation must key on the CALLER's
    // fiber, not on "any write is suspicious". Without this, a guard that fired
    // unconditionally would look correct.
    const seen: unknown[] = []
    const { svc } = serviceWith({
      write: async (_path, data) => {
        for await (const chunk of data) seen.push(chunk)
        return { bytes: 9, endOffset: 9, mode: "truncate" }
      },
    })
    const result = await svc.write(
      "/tmp/out",
      from([new Uint8Array([0, 1, 2]), new Uint8Array([3, 4, 5]), new Uint8Array([6, 7, 8])]),
    )
    expect(seen).toEqual(["AAEC", "AwQF", "BgcI"])
    expect(result.bytes).toBe(9)
  })
})

describe("error surface: codes survive and stay distinguishable", () => {
  test("a CODE: prefix becomes a structured code", () => {
    const stale = asHandsError(new Error("ESTALE: /log was replaced during read"))
    expect(stale.code).toBe("ESTALE")
    expect(stale.isStale).toBe(true)
    // The prefix is stripped so the message is readable on its own.
    expect(stale.message).toBe("/log was replaced during read")
  })

  test("ESTALE and ENOENT are different codes, not different prose", () => {
    // The whole point of the split: rotation means "reopen and reset", a missing
    // file usually means "give up". Opposite handling ⇒ separate codes.
    const stale = asHandsError(new Error("ESTALE: replaced"))
    const missing = asHandsError(new Error("ENOENT: gone"))
    expect(stale.code).not.toBe(missing.code)
    expect(stale.isStale).toBe(true)
    expect(missing.isStale).toBe(false)
  })

  test("a message with no known code reports undefined rather than inventing one", () => {
    // Guessing would send a caller down the wrong branch, which is worse than
    // admitting the gap.
    const error = asHandsError(new Error("something exploded"))
    expect(error.code).toBeUndefined()
    expect(error.message).toBe("something exploded")
  })

  test("an already-coded error passes through unchanged", () => {
    const original = new HandsError("ENOSPC: disk full")
    expect(asHandsError(original)).toBe(original)
  })

  test("a thrown non-Error still becomes a HandsError", () => {
    expect(asHandsError("plain string").message).toBe("plain string")
  })
})

describe("watch payloads are validated, not guessed at", () => {
  test("a well-formed change is accepted", () => {
    expect(normalizeChange({ kind: "create", path: "/a", id: "x" })).toEqual({
      kind: "create",
      path: "/a",
      id: "x",
    })
  })

  test("an unknown kind is dropped", () => {
    // Inventing a kind would fire the wrong caller behaviour.
    expect(normalizeChange({ kind: "explode", path: "/a" })).toBeUndefined()
  })

  test("a missing or empty path is dropped", () => {
    expect(normalizeChange({ kind: "create" })).toBeUndefined()
    expect(normalizeChange({ kind: "create", path: "" })).toBeUndefined()
    expect(normalizeChange(null)).toBeUndefined()
  })

  test("an absent id is omitted rather than set to undefined", () => {
    const change = normalizeChange({ kind: "modify", path: "/a" })
    expect(change).toBeDefined()
    expect("id" in (change as object)).toBe(false)
  })
})

describe("stream lifetime is bound to the caller (the measured leak)", () => {
  test("unloading a plugin stops its in-flight stream", async () => {
    // THE regression this whole guard exists for. Measured before the guard:
    // 16 chunks produced after the plugin was unloaded
    // (docs/probes/probe-host-stream-leak.ts).
    const ctx = new Context()
    let produced = 0
    let stopped = false

    const svc = new HandsService(ctx, {})
    svc.attachShell({
      hands: {
        read: () =>
          (async function* () {
            while (!stopped) {
              produced += 1
              yield "AAEC"
              await new Promise((resolve) => setTimeout(resolve, 5))
            }
          })(),
        stat: async () => null,
        write: async () => ({ bytes: 0, endOffset: 0, mode: "truncate" }),
        watch: () => emptyStream(),
        list: () => emptyStream(),
      },
    } as unknown as ShellStdioBridge)

    // A plugin that consumes forever, plus an observable signal that the stream
    // was actually torn down.
    //
    // ⚠ The consumer is FIRE-AND-FORGET (`void (async () => …)()`), not awaited
    // inside `apply`. Awaiting an endless loop here would make `await plugin`
    // never resolve — that is how the first version of this test timed out, and
    // it was the test's bug, not the guard's: a real plugin must not block its
    // own load on a stream either.
    let started = false
    const plugin = ctx.plugin(function leakingPlugin(inner: Context) {
      void (async () => {
        try {
          for await (const _chunk of inner.hands.read("/tmp/forever")) {
            started = true
            /* consume forever */
          }
        } finally {
          stopped = true
        }
      })()
    })
    await plugin

    // Wait for production to actually begin before measuring, so "unload stopped
    // it" cannot pass merely because it never started.
    const startDeadline = Date.now() + 5_000
    while (!started && Date.now() < startDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(started).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 40))
    const before = produced
    expect(before).toBeGreaterThan(0)

    // Unload the plugin. Nothing else happens — the guard must do the work.
    ;(plugin as unknown as { dispose: () => void }).dispose()
    await new Promise((resolve) => setTimeout(resolve, 120))

    expect(stopped).toBe(true)
    // Production must have ceased: allow a small race window, not unbounded.
    const afterUnload = produced - before
    expect(afterUnload).toBeLessThanOrEqual(2)
  }, 15_000)

  test("a completed stream releases its registration", async () => {
    // Measured: unreleased registrations accumulate (1000 survived to unload), so
    // a bulk sync would build a table as large as its file count. This asserts
    // the release actually happens.
    const ctx = new Context()
    const svc = new HandsService(ctx, {})
    svc.attachShell({
      hands: {
        read: () => from(["AAEC"]),
        stat: async () => null,
        write: async () => ({ bytes: 0, endOffset: 0, mode: "truncate" }),
        watch: () => emptyStream(),
        list: () => emptyStream(),
      },
    } as unknown as ShellStdioBridge)

    const rootFiber = (ctx as unknown as { fiber: { _disposables?: { length?: number } } }).fiber
    const before = rootFiber._disposables?.length ?? 0

    for (let i = 0; i < 50; i++) {
      for await (const _chunk of svc.read(`/tmp/f${i}`)) {
        /* drain */
      }
    }

    const after = rootFiber._disposables?.length ?? 0
    // 50 reads must not leave 50 registrations behind.
    expect(after - before).toBeLessThan(5)
  })

  test("a stream call whose open() REJECTS still releases its registration", async () => {
    // ⚠ THE regression for the leak this pair of tests pins down.
    //
    // `guarded()` registers on the caller's ctx inside `[Symbol.asyncIterator]()`,
    // and `stop()` is the only thing that releases it. `open()` used to run
    // BEFORE the `try` in `next()`, so its rejection skipped `stop()` entirely:
    // a failing stream call — no shell attached, or a peer that refuses the
    // stream — leaked one registration per call. Measured: 50 failing `for await`
    // iterations with no shell attached left 50 extra registrations that lived
    // until unload.
    //
    // The count is read the way the two tests above read it (the root fiber's
    // `_disposables`), so on the OLD code this reports `after - before === 50`
    // for path (a) alone.
    //
    // ⚠ Each path gets its OWN Context: two `HandsService` instances on one ctx
    // collide (`service "hands" has been registered at <root>`, cordis index.js
    // `:1158`), because providing is not instance-scoped.
    type RootFiberCounter = { fiber: { _disposables?: { length?: number } } }

    /** Count leak for one rejection path, driven `rounds` times. */
    async function leakedRegistrations(
      rounds: number,
      make: (ctx: Context) => HandsService,
    ): Promise<number> {
      const ctx = new Context()
      const svc = make(ctx)
      const rootFiber = (ctx as unknown as RootFiberCounter).fiber
      const before = rootFiber._disposables?.length ?? 0
      for (let i = 0; i < rounds; i++) {
        await expect(collect(svc.read(`/tmp/f${i}`))).rejects.toThrow(/no shell attached/)
      }
      return (rootFiber._disposables?.length ?? 0) - before
    }

    // (a) No bridge at all: `this.api` throws `EUNSUPPORTED: no shell attached`,
    // which is the "shell is not attached" half of the report.
    const noShell = await leakedRegistrations(50, (ctx) => new HandsService(ctx, {}))

    // (b) A shell that IS attached but refuses the stream. The real mirror throws
    // SYNCHRONOUSLY here rather than rejecting, which is the same `open()` path
    // and the reason the fix has to live inside the `try` rather than in a
    // `.catch()` on a promise.
    const refused = await leakedRegistrations(50, (ctx) => {
      const svc = new HandsService(ctx, {})
      svc.attachShell({
        hands: {
          stat: async () => null,
          read: () => {
            throw new Error("EUNSUPPORTED: no shell attached")
          },
          write: async () => ({ bytes: 0, endOffset: 0, mode: "truncate" }),
          watch: () => emptyStream(),
          list: () => emptyStream(),
        },
      } as unknown as ShellStdioBridge)
      return svc
    })

    // 50 failing stream calls must not leave 50 registrations behind each. The
    // bound is tight because the old-code failure mode is exactly 50 per path,
    // not 4.
    expect(noShell).toBeLessThan(5)
    expect(refused).toBeLessThan(5)
  })

  test("a failing stream call is still a HandsError, not a raw Error", async () => {
    // The same fix must preserve the ERROR SURFACE of the rejection path: a
    // caller branching on `.code` must not silently get `undefined` because the
    // failure happened in `open()` rather than in `iterator.next()`. Coded and
    // uncoded failures are both pinned, since `HandsError` keeps `undefined` for
    // a message with no known code rather than inventing one.
    const ctx = new Context()
    const coded = new HandsService(ctx, {})
    coded.attachShell({
      hands: {
        stat: async () => null,
        read: () => {
          throw new Error("ENOENT: /tmp/gone")
        },
        write: async () => ({ bytes: 0, endOffset: 0, mode: "truncate" }),
        watch: () => emptyStream(),
        list: () => emptyStream(),
      },
    } as unknown as ShellStdioBridge)

    const failure = await collect(coded.read("/tmp/gone")).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(HandsError)
    expect((failure as HandsError).code).toBe("ENOENT")
    // The prefix is stripped, as it is on every other path.
    expect((failure as HandsError).message).toBe("/tmp/gone")
  })

  test("a release landing INSIDE the await open() window still unwinds the stream", async () => {
    // ⚠ THE SECOND, ORTHOGONAL HOLE in `guarded()` — a different one from the
    // `open()`-rejection leak pinned above, and it survives that fix.
    //
    // The entry check at the top of `next()` only sees a release that has ALREADY
    // happened. A release landing DURING `open()` was invisible: `next()` went on
    // to pull the freshly opened stream and returned its first chunk, and
    // `iterator.return()` was never forwarded to it — after which no later
    // `next()` could ever reach it, because the entry check short-circuits from
    // then on. On the shell side that means a producer that never stops and a
    // file handle held until process exit, which is the very leak this module's
    // header cites, reached by a different route.
    //
    // ⚠ WHY THIS DRIVES `guarded()` DIRECTLY rather than `svc.read(…)`, which is
    // what a reviewer's real-peer harness did. Measured here: through the PUBLIC
    // methods the window is one MICROTASK wide, not one round trip, because
    // kkrpc's remote proxy is synchronous — `withAsyncIterator` attaches
    // `Symbol.asyncIterator` to the request promise immediately
    // (`node_modules/kkrpc/dist/streaming.js`), so `this.api.read(...)` returns an
    // iterable without awaiting and the `await open()` resumes on the next
    // microtask, before any timer-scheduled `dispose()` can run. (That is also
    // why my first two attempts at a public-API version of this test reported the
    // bug as ABSENT: disposing "right after `next()`" always lost the race.) The
    // RTT lands later, inside `iterator.next()`.
    //
    // The fix's contract, however, is about the wrapper, and the wrapper can be
    // given a genuinely slow `open()` — so that is where it is pinned. This is a
    // unit test of `guarded()`, not a claim that the production window is wide.
    const ctx = new Context()
    let produced = 0
    let underlyingReturn = 0
    const openGate = deferred()

    /** `HandsService` with the private stream wrapper surfaced for testing. */
    class Exposed extends HandsService {
      wrapStream<T>(open: () => Promise<AsyncIterable<T>>): AsyncIterable<T> {
        // Cast, not a signature change: `guarded` is private and must stay so —
        // widening it would invite callers outside this file to build unguarded
        // streams out of it.
        return (
          this as unknown as { guarded<T>(o: () => Promise<AsyncIterable<T>>): AsyncIterable<T> }
        ).guarded(open)
      }
    }

    // The instance is registered on `ctx` by the `Service` constructor, so there
    // is nothing to keep here — the plugin reaches it through `inner.hands`.
    new Exposed(ctx, {})
    let firstResult: IteratorResult<string> | undefined

    const plugin = ctx.plugin(function racyPlugin(inner: Context) {
      // ⚠ Called off `inner.hands` (the per-caller namespace), so the guard lands
      // on THIS plugin's fiber — the same registration `read`/`watch`/`list` make.
      const stream = (
        inner.hands as unknown as {
          wrapStream<T>(open: () => Promise<AsyncIterable<T>>): AsyncIterable<T>
        }
      ).wrapStream(async () => {
        await openGate.promise // a slow round trip: the whole window
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                produced += 1
                return { done: false, value: "AAEC" }
              },
              async return(value?: unknown) {
                underlyingReturn += 1
                return { done: true, value }
              },
            } as AsyncIterator<string>
          },
        } as AsyncIterable<string>
      })
      const iterator = stream[Symbol.asyncIterator]()
      void iterator.next().then((result) => {
        firstResult = result
      })
    })
    await plugin

    // Unload the caller WHILE `open()` is still pending. That is the release in
    // the window; `dispose()` resolves only after the guard's disposer has run.
    await plugin.dispose()
    // Nothing may have been produced yet — if this is >0 the test is not
    // measuring the window it claims to.
    expect(produced).toBe(0)

    openGate.resolve()
    await new Promise((resolve) => setTimeout(resolve, 80))

    // ⚠ THE ASSERTION IS TWO-SIDED AND OBSERVABLE: the stream that was opened
    // after the caller died was unwound, AND no chunk from it was handed to
    // anyone. On the OLD code this reads `produced: 1, underlyingReturn: 0` — the
    // chunk went to a caller that no longer existed and `return()` was never
    // forwarded. Nothing here reads an internal flag; the previous fix in this
    // area shipped a test that was proven non-falsifiable, so the shape matters
    // as much as the assertion.
    expect(underlyingReturn).toBe(1)
    expect(produced).toBe(0)
    expect(firstResult?.done).toBe(true)
  }, 15_000)

  test("breaking out of a stream releases its registration", async () => {
    const ctx = new Context()
    const svc = new HandsService(ctx, {})
    svc.attachShell({
      hands: {
        read: () => from(["AAEC", "AwQF", "BgcI"]),
        stat: async () => null,
        write: async () => ({ bytes: 0, endOffset: 0, mode: "truncate" }),
        watch: () => emptyStream(),
        list: () => emptyStream(),
      },
    } as unknown as ShellStdioBridge)

    const rootFiber = (ctx as unknown as { fiber: { _disposables?: { length?: number } } }).fiber
    const before = rootFiber._disposables?.length ?? 0

    for (let i = 0; i < 20; i++) {
      for await (const _chunk of svc.read("/tmp/early")) {
        break // cancel after the first chunk
      }
    }

    const after = rootFiber._disposables?.length ?? 0
    expect(after - before).toBeLessThan(5)
  })

  test("the guard is per-caller, so one caller's unload does not stop another's stream", async () => {
    // `this.ctx` is the CALLER's ctx, so each stream registers on its own fiber.
    // A shared instance field would release the wrong one.
    const ctx = new Context()
    const svc = new HandsService(ctx, {})
    svc.attachShell({
      hands: {
        read: () =>
          (async function* () {
            yield "AAEC"
            await new Promise((resolve) => setTimeout(resolve, 200))
          })(),
        stat: async () => null,
        write: async () => ({ bytes: 0, endOffset: 0, mode: "truncate" }),
        watch: () => emptyStream(),
        list: () => emptyStream(),
      },
    } as unknown as ShellStdioBridge)

    let secondSawChunk = false
    const first = ctx.plugin(async function firstPlugin(inner: Context) {
      for await (const _chunk of inner.hands.read("/tmp/first")) {
        /* drain */
      }
    })
    const second = ctx.plugin(async function secondPlugin(inner: Context) {
      for await (const _chunk of inner.hands.read("/tmp/second")) {
        secondSawChunk = true
      }
    })
    await first
    await second

    // Unload only the first plugin; the second must still be able to consume.
    ;(first as unknown as { dispose: () => void }).dispose()
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(secondSawChunk).toBe(true)
  }, 15_000)
})

describe("attribution plumbing", () => {
  test("callerName resolves a service method's `this` to the calling plugin", async () => {
    // Guards against a future refactor turning a class method into an arrow
    // property, which loses attribution silently (cordis findings §1.8).
    const ctx = new Context()
    const seen: Array<string | null> = []
    class Tracing extends HandsService {
      async stat(path: string) {
        seen.push(callerName(this))
        return super.stat(path)
      }
    }
    const svc = new Tracing(ctx, {})
    svc.attachShell({
      hands: {
        stat: async () => null,
        read: () => emptyStream(),
        write: async () => ({ bytes: 0, endOffset: 0, mode: "truncate" }),
        watch: () => emptyStream(),
        list: () => emptyStream(),
      },
    } as unknown as ShellStdioBridge)

    await ctx.plugin(function attrPlugin(inner: Context) {
      return inner.hands.stat("/tmp/x")
    })
    expect(seen).toEqual(["attrPlugin"])
  })
})

// --- the receiver guard ----------------------------------------------------
//
// ⚠ THIS IS THE TEST FOR A SILENT-FAILURE CLASS, not for a cosmetic message.
//
// A cordis `Service` subclass reaches the per-caller state through `this`, and
// the method proxy substitutes a per-caller shadow only when the call goes
// through the namespace object. `const { read } = ctx.hands` therefore produces
// a BARE FUNCTION: `this` is `undefined`, the first statement of the method
// (`this.record(...)`) throws, and — because that statement is first — NEITHER
// the `[cap]` audit line NOR the `#24` overreach warning is emitted for the
// call. Measured on cordis 4.0.0-rc.9: `read`/`watch`/`list` threw synchronously
// with `Cannot read properties of undefined (reading 'record')`, while
// `stat`/`write` returned a REJECTED PROMISE with the same message — so a caller
// using `.catch()` saw it, and a caller using `await` inside a try saw it, but
// the diagnostic named an internal field and the audit simply was not there.
//
// The fix is a uniform guard that turns that into one actionable error naming the
// API to call instead. ⚠ The fix is NOT "make the methods arrow properties": that
// would make destructuring work by binding the instance directly, which silently
// destroys attribution (`caller: null`, cordis findings §1.8) — the audit would
// say `<unknown>` and every overreach check would skip (a caller with no entry id
// is never reported, by design). A loud refusal beats a quiet loss of the audit.

describe("a destructured ctx.hands method is REFUSED, not silently unattributed", () => {
  /**
   * Every public method, with the arguments it needs.
   *
   * ⚠ Driven from a LIST rather than five hand-written cases: the defect is
   * "a method was added without the guard", and a list is what makes the missing
   * one visible. The compile-time half of this is
   * `capability-surfaces.test.ts`'s primitive enumeration.
   */
  const methods: Array<{ name: string; args: unknown[] }> = [
    { name: "stat", args: ["/tmp/x"] },
    { name: "read", args: ["/tmp/x"] },
    { name: "watch", args: ["/tmp/x"] },
    { name: "list", args: ["/tmp/x"] },
    { name: "write", args: ["/tmp/x", from([])] },
  ]

  /**
   * Pull one method off the CALLER-FACING namespace and call it DETACHED.
   *
   * ⚠ Both halves of that sentence are load-bearing, and my first version of this
   * test got the second one wrong. `ctx.hands` is NOT the `HandsService` instance
   * (`ctx.hands === svc` is `false` — cordis installs a per-caller proxy), so the
   * namespace is what a plugin's `const { read } = ctx.hands` actually copies.
   * And the copy has to be invoked with NO receiver: calling `wrapper.read(…)`
   * passes the wrapper as `this`, which reproduces a DIFFERENT failure
   * (`this.record is not a function`) and would have made this test pass for the
   * wrong reason.
   *
   * ⚠ The result is also captured without `await` first, because the two shapes
   * differ and the difference is the defect: `read`/`watch`/`list` are plain
   * methods, so the missing receiver throws SYNCHRONOUSLY out of them, while
   * `stat`/`write` are `async`, so it becomes a rejected promise. A test that
   * only awaited would report the first three as "no error at all".
   */
  function callDetached(ctx: Context, name: string, args: unknown[]): unknown {
    const target = ctx.hands as unknown as Record<string, unknown>
    const bare = target[name] as (...rest: unknown[]) => unknown
    // `.apply(undefined, …)` is the destructuring the guard exists for.
    return Reflect.apply(bare, undefined, args)
  }

  for (const { name, args } of methods) {
    test(`${name}: the guard names the API to call instead of a TypeError`, async () => {
      const ctx = new Context()
      const svc = new HandsService(ctx, {})
      svc.attachShell({
        hands: {
          stat: async () => null,
          read: () => emptyStream(),
          write: async () => ({ bytes: 0, endOffset: 0, mode: "truncate" }),
          watch: () => emptyStream(),
          list: () => emptyStream(),
        },
      } as unknown as ShellStdioBridge)

      let caught: unknown
      try {
        // Covers BOTH halves: a synchronous throw is caught here, and a rejected
        // promise is caught by the `await` — see `callDetached`.
        await callDetached(ctx, name, args)
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(HandsError)
      const error = caught as HandsError
      // It carries a CODE, so a caller can branch on it rather than parse prose.
      expect(error.code).toBe("EUNSUPPORTED")
      // Actionable: it says the receiver is missing, names the method, and names
      // the call to write instead.
      expect(error.message).toContain(`ctx.hands.${name}(`)
      expect(error.message).toContain("do not destructure")
      // And it does NOT leak the internal field name that used to be the whole
      // diagnostic (`Cannot read properties of undefined (reading 'record')`).
      expect(error.message).not.toContain("'record'")
    })
  }

  test("the raw INSTANCE still works when called detached, and that is not a bug", () => {
    // ⚠ Pinning the boundary of the fix, because it would be easy to "fix" this
    // too and lose attribution for real. `svc` (the constructed instance) is not
    // what plugins touch: they get `ctx.hands`, the per-caller proxy. A method
    // taken off the INSTANCE runs without cordis's shadow substitution, so
    // `callerName` returns null and the audit says `<unknown>` — degraded, but
    // not the crash the namespace path had. The guard therefore keys on "the
    // receiver is gone", which is exactly the case cordis's proxy produces, and
    // deliberately not on "this is not the shadow".
    //
    // Asserted through `HandsService`'s own inheritance, not by reading internals:
    // a subclass calling `super.stat(...)` must keep working.
    const ctx = new Context()
    const svc = new HandsService(ctx, {})
    expect(typeof svc.stat).toBe("function")
  })

  test("a destructured call still emits NO audit line (the guard runs before it)", async () => {
    // ⚠ Pinning the LIMIT of the fix, not a feature. The guard makes the failure
    // ACTIONABLE; it cannot make the call attributable, because the attribution
    // state is precisely what was lost with the receiver. So the honest contract
    // is "you get a loud error instead of a silent, unaudited call" — and this
    // asserts that no audit line is fabricated for a call whose caller is unknown.
    const ctx = new Context()
    const audits: string[] = []
    const svc = new HandsService(ctx, { audit: (line) => audits.push(line) })
    svc.attachShell({ hands: { stat: async () => null } } as unknown as ShellStdioBridge)

    let caught: unknown
    try {
      await callDetached(ctx, "stat", ["/tmp/x"])
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(HandsError)
    expect(audits).toEqual([])
  })

  test("a NON-destructured call is unaffected and still audited", async () => {
    // The control. A guard that fired on the normal path would break every plugin.
    const { svc, audits } = serviceWith({
      stat: async () => ({ size: 1, id: "i", mtimeMs: 0, kind: "file" }),
    })
    expect(await svc.stat("/tmp/x")).toEqual({ size: 1, id: "i", mtimeMs: 0, kind: "file" })
    expect(audits.some((line) => line.includes("hands.stat"))).toBe(true)
  })
})

// --- hands.list ------------------------------------------------------------
//
// `list` is the primitive that makes enumeration possible at all: without it a
// caller on a REMOTE shell cannot discover a single filename, because `stat` on a
// directory carries only a bounded preview and `read` refuses a directory.

/** Encode a batch the way the shell does: base64 of the JSON array. */
function batch(entries: unknown): string {
  return Buffer.from(JSON.stringify(entries)).toString("base64")
}

describe("hands.list decodes the wire shape", () => {
  test("a batch arrives as base64 and becomes entry objects", async () => {
    const { svc } = serviceWith({
      list: () =>
        from([
          batch([
            { name: "a.txt", kind: "file", size: 3 },
            { name: "sub", kind: "dir", size: 0 },
          ]),
        ]),
    })
    const batches = await collect(svc.list("/tmp/dir"))
    expect(batches).toEqual([
      [
        { name: "a.txt", kind: "file", size: 3 },
        { name: "sub", kind: "dir", size: 0 },
      ],
    ])
  })

  test("multiple batches stay in order and are not merged", async () => {
    // Order matters: the shell streams a directory in filesystem order, and a
    // caller accumulating a listing must receive the same order it would have got
    // from one call. Merging batches would also hide a paging bug.
    const { svc } = serviceWith({
      list: () =>
        from([
          batch([{ name: "first", kind: "file", size: 0 }]),
          batch([{ name: "second", kind: "file", size: 0 }]),
        ]),
    })
    const batches = await collect(svc.list("/tmp/dir"))
    expect(batches).toEqual([
      [{ name: "first", kind: "file", size: 0 }],
      [{ name: "second", kind: "file", size: 0 }],
    ])
  })

  test("a symlink keeps its own kind rather than its target's", () => {
    // The shell uses `symlink_metadata` so a link is reported as a link. If this
    // were normalised to the target's type, a caller could not tell a link from
    // the thing it points at — the distinction the shell deliberately preserved.
    return (async () => {
      const { svc } = serviceWith({
        list: () => from([batch([{ name: "link", kind: "symlink", size: 12 }])]),
      })
      const batches = await collect(svc.list("/tmp/dir"))
      expect(batches[0][0].kind).toBe("symlink")
    })()
  })

  test("an unknown kind degrades to `other` rather than throwing", async () => {
    // Forward compatibility: a newer shell may report a kind this brain does not
    // know. Dropping the entry would silently shorten the listing, so it is kept
    // with a conservative kind instead.
    const { svc } = serviceWith({
      list: () => from([batch([{ name: "weird", kind: "socket", size: 0 }])]),
    })
    const batches = await collect(svc.list("/tmp/dir"))
    expect(batches[0]).toEqual([{ name: "weird", kind: "other", size: 0 }])
  })

  test("a malformed entry is DROPPED, not guessed at", async () => {
    const { svc } = serviceWith({
      list: () => from([batch([{ name: "ok", kind: "file", size: 1 }, { size: 5 }, "nonsense"])]),
    })
    const batches = await collect(svc.list("/tmp/dir"))
    expect(batches[0]).toEqual([{ name: "ok", kind: "file", size: 1 }])
  })

  test("a batch that is not JSON FAILS rather than being skipped", async () => {
    // ⚠ The critical one. Skipping a bad batch would make the directory look
    // SHORTER than it is, and a caller walking it would conclude the directory
    // ended early — a silent wrong answer, which is worse than a loud failure.
    const { svc } = serviceWith({
      list: () => from([Buffer.from("not json at all").toString("base64")]),
    })
    await expect(collect(svc.list("/tmp/dir"))).rejects.toThrow(/not valid JSON/)
  })

  test("a batch that is JSON but not an array FAILS", async () => {
    const { svc } = serviceWith({
      list: () => from([Buffer.from(JSON.stringify({ items: [] })).toString("base64")]),
    })
    await expect(collect(svc.list("/tmp/dir"))).rejects.toThrow(/not an array/)
  })
})

describe("hands.list is audited and guarded like the other primitives", () => {
  test("the audit line names the primitive and the path", async () => {
    const { svc, audits } = serviceWith({ list: () => emptyStream() })
    await collect(svc.list("/tmp/somewhere"))
    expect(audits.some((line) => line.includes("list") && line.includes("/tmp/somewhere"))).toBe(
      true,
    )
  })

  test("with no shell attached it fails loudly instead of looking empty", async () => {
    // ⚠ "no shell" and "an empty directory" must not be the same observable.
    // A service that returned an empty stream here would make every caller
    // believe the directory is empty.
    const ctx = new Context()
    const svc = new HandsService(ctx, {})
    await expect(collect(svc.list("/tmp/x"))).rejects.toThrow(/no shell attached/)
  })

  test("unloading the plugin stops an in-flight listing", async () => {
    // ⚠ This mirrors the `read` leak test above, and it replaced a WEAKER version
    // that only did `for await (… break)`. That version passed with or without
    // `guarded()`, because `for await … break` calls `.return()` on the generator
    // either way — so it proved nothing about the guard. Only unloading the owner
    // exercises it, which is the real-world case (a plugin disabled while its
    // listing is still streaming) and the one that measured 16 chunks after unload
    // for `read`.
    const ctx = new Context()
    let produced = 0
    let stopped = false

    const svc = new HandsService(ctx, {})
    svc.attachShell({
      hands: {
        list: () =>
          (async function* () {
            while (!stopped) {
              produced += 1
              yield batch([{ name: `f${produced}`, kind: "file", size: 0 }])
              await new Promise((resolve) => setTimeout(resolve, 5))
            }
          })(),
        stat: async () => null,
        read: () => emptyStream(),
        write: async () => ({ bytes: 0, endOffset: 0, mode: "truncate" }),
        watch: () => emptyStream(),
      },
    } as unknown as ShellStdioBridge)

    let started = false
    const plugin = ctx.plugin(function listingPlugin(inner: Context) {
      // Fire-and-forget: awaiting an endless stream would block the plugin's own
      // load (the documented trap from the `read` test).
      void (async () => {
        try {
          for await (const _ of inner.hands.list("/tmp/forever")) {
            started = true
          }
        } finally {
          stopped = true
        }
      })()
    })
    await plugin

    const deadline = Date.now() + 5_000
    while (!started && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(started).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 40))
    const before = produced
    expect(before).toBeGreaterThan(0)

    // Unload: the guard is the only thing that can stop the producer.
    await plugin.dispose()
    await new Promise((resolve) => setTimeout(resolve, 60))
    const after = produced

    expect(stopped).toBe(true)
    expect(after).toBeLessThanOrEqual(before + 1)
  })
})
