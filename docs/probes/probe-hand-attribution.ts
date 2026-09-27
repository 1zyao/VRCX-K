/**
 * Does a STREAMING method lose its caller attribution?
 *
 * WHY THIS EXISTS
 *   `docs/hands-capability-proposal.md` §6.2 asserts a design rule for `ctx.hands`:
 *   the audit hook for `read()`/`watch()` must fire **at call time**, because
 *   putting it inside an async generator body would lose attribution — the
 *   generator body does not run until the first `next()`, and it does not carry
 *   the caller's `this`.
 *
 *   That was derived from cordis's documented shadow-rewrite behaviour
 *   (docs/cordis-runtime-findings.md §1.8: arrow functions silently drop
 *   attribution), NOT measured for the generator case. This probe measures it.
 *
 *   It is the same class of mistake this probe set keeps catching: asserting a
 *   mechanism from a neighbouring fact instead of running it.
 *
 * WHAT IS TESTED
 *   One `Service` with three shapes, each called the same way by a plugin:
 *     A. normal method, record synchronously        -> expect caller resolved
 *     B. async generator, record INSIDE the body    -> the claim says: LOST
 *     C. normal method that records then RETURNS an
 *        async generator (the proposed shape)       -> expect caller resolved
 *
 *   B vs C is the whole question. If B also resolves, the proposal's rule is
 *   over-cautious and should say so; if B loses it, the rule is load-bearing.
 *
 * Run: bun run docs/probes/probe-hand-attribution.ts
 */
import { Context, Service, symbols } from "../../host/node_modules/cordis/lib/index.js"

/** Resolve the calling plugin's identity, exactly as host/src/capability.ts does. */
function callerName(self: unknown): string | null {
  if (self == null) return null
  const caller = (self as Record<PropertyKey, unknown>)[symbols.caller] as
    | { fiber?: { name?: string; runtime?: { name?: string }; entry?: { id?: string } } }
    | undefined
  const fiber = caller?.fiber
  if (!fiber) return null
  const entryId = fiber.entry?.id
  if (!entryId) return fiber.name ?? null
  return fiber.runtime?.name ? `${entryId}#${fiber.runtime.name}` : entryId
}

type Result = { shape: string; who: string | null; when: string }

class HandsLike extends Service {
  results: Result[] = []

  constructor(ctx: Context) {
    super(ctx, "handsLike")
  }

  // --- A: normal method, records synchronously ------------------------------
  sync(): Result {
    const who = callerName(this)
    const r = { shape: "A sync method", who, when: "at call" }
    this.results.push(r)
    return r
  }

  // --- B: async generator, records INSIDE the body --------------------------
  // The body does not execute until the first next(); this is the shape the
  // proposal says is WRONG.
  async *insideBody(): AsyncGenerator<string> {
    const who = callerName(this)
    this.results.push({ shape: "B record inside generator", who, when: "first next()" })
    yield "chunk"
  }

  // --- C: records at call time, then returns a generator (the proposed shape) --
  //
  // ⚠ NOTE, learned by running this: using `this.#private()` here THROWS.
  // cordis's `createShadowMethod` rewrites `thisArg` to a per-caller shadow object
  // (cordis/lib/index.js:136-143), so `this` inside a Service method is NOT the
  // instance — only a shadow that prototypally sees public members. A private
  // field/method therefore fails. That is a real constraint on implementers and is
  // recorded separately; here it just means the generator must be reached through
  // a captured reference, not `this.#…`.
  atCallTime(): AsyncGenerator<string> {
    const who = callerName(this)
    this.results.push({ shape: "C record at call, return gen", who, when: "at call" })
    return chunks()
  }
}

/** Module-scope generator: no `this` needed, so the shadow rewrite cannot break it. */
async function* chunks(): AsyncGenerator<string> {
  yield "chunk"
}

async function main() {
  const ctx = new Context()
  const svc = new HandsLike(ctx as unknown as Context)

  // A plugin calls all three, the way a plugin would: through the Service, so
  // cordis's per-caller shadow is in play.
  const plugin = ctx.plugin(function namedPlugin(pctx: Context) {
    const api = pctx as unknown as { handsLike: HandsLike }
    api.handsLike.sync()

    // B: consume the stream (this is what triggers the body)
    void (async () => {
      for await (const _ of api.handsLike.insideBody()) break
    })()

    // C: the proposed shape
    void (async () => {
      for await (const _ of api.handsLike.atCallTime()) break
    })()
  })

  await plugin
  // Let both generators actually run.
  await new Promise((r) => setTimeout(r, 150))
  // No ctx.stop() — cordis has no such method here; the process simply ends
  // (same teardown style as docs/probes/probe8.ts).

  console.log("=== caller attribution per shape ===")
  for (const r of svc.results) {
    const verdict = r.who === null ? "LOST (null)" : r.who
    console.log(`  ${r.shape.padEnd(34)} when=${r.when.padEnd(12)} who=${verdict}`)
  }

  const b = svc.results.find((r) => r.shape.startsWith("B"))
  const c = svc.results.find((r) => r.shape.startsWith("C"))
  const a = svc.results.find((r) => r.shape.startsWith("A"))

  console.log("")
  if (!a || !b || !c) {
    console.log("RESULT INCONCLUSIVE — a shape did not report at all")
    process.exit(1)
  }
  console.log(
    b.who === null
      ? "RESULT B LOST attribution ⇒ the proposal's rule (§6.2) is LOAD-BEARING"
      : "RESULT B KEPT attribution ⇒ the proposal OVERSTATES the risk; fix it",
  )
  if (a.who !== null && c.who !== null) {
    console.log("  (A and C both resolved — they are the safe shapes)")
  } else {
    console.log(`  ⚠ A or C failed to resolve: A=${a.who} C=${c.who}`)
  }
  process.exit(0)
}

main()
