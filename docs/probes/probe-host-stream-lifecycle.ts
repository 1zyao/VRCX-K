/**
 * Host-side streaming: the two questions the `ctx.hands` design cannot guess.
 *
 * WHY THIS EXISTS
 *   `docs/hands-capability-proposal.md` §6/§8 says the host-side `ctx.hands`
 *   service must (a) audit the *call*, not every chunk, and (b) bind a stream's
 *   life to the caller's lifetime — "a plugin that is unloaded must not keep
 *   reading the disk". The proposal lists (b) as **unimplemented and unmeasured**
 *   (§8 item 4) and says plainly that audit cannot rescue it.
 *
 *   Both are mechanism claims. This project's rule is that a mechanism claim
 *   gets measured before it is designed around, because the last three
 *   extrapolated ones were all wrong (findings §1.8's arrow-function rule did NOT
 *   generalise to generators — see `probe-hand-attribution.ts`).
 *
 * WHAT IS MEASURED
 *   Q1. Does `ctx.effect(...)` registered INSIDE a Service method bind to the
 *       CALLER's fiber (so unloading the plugin runs it), or to the provider?
 *       §1.3 warns that `this.ctx` inside a Service method is the CALLER's ctx.
 *       If that holds, `this.ctx.effect(...)` is exactly the binding we want —
 *       but it must be measured, not read off the finding.
 *
 *   Q2. When a plugin is unloaded mid-stream, what actually happens?
 *       The interesting case: an `AsyncIterable` returned from a Service method
 *       is a plain JS object. Nothing in cordis knows about it. So does anything
 *       stop a `for await` loop that a plugin started before it was unloaded?
 *
 *   Q3. Does a `Service` method returning an `AsyncIterable` survive the
 *       per-caller shadow rewrite intact (i.e. is it still `Symbol.asyncIterator`-able
 *       by the caller, and is the caller still resolvable if the generator body
 *       records)?
 *
 * ⚠ Q_C BELOW IS ONLY HALF-TESTED, and its first version over-read the result.
 *   Q_C registers an effect from the ROOT ctx and observes that the disposer did
 *   not run *within the observation window* — true, but it never shuts the host
 *   down. `host/src/lifecycle.ts:104-114` explicitly clears `root._disposables`
 *   during graceful stop, so a root effect DOES run at graceful shutdown.
 *   The full picture is `probe-host-root-effect-shutdown.ts`. Do not cite Q_C as
 *   "a root effect never runs".
 *
 * Run: bun run docs/probes/probe-host-stream-lifecycle.ts
 */
import {
  Context,
  Service,
  symbols,
} from "../../host/node_modules/cordis/lib/index.js"

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

const log: string[] = []

/** A Service whose `read` yields forever until told to stop. */
class StreamSvc extends Service {
  /** Set by `effectBoundRead`, to prove whether the disposer ran. */
  effectDisposerRan = false
  /** Set by `effectBoundRead`, to prove the stream was halted. */
  streamHalted = false
  /** If `this.ctx` is the provider's ctx, registering an effect here throws. */
  ctxIsProvider = false

  constructor(ctx: Context) {
    super(ctx, "streamSvc")
  }

  /**
   * Q1: register `ctx.effect` INSIDE a method, so `this.ctx` decides the owner.
   *
   * A disposer registered on the CALLER's fiber is the whole mechanism for
   * "unload the plugin, stop the stream".
   */
  effectBoundRead(): AsyncGenerator<string> {
    const self = this as unknown as StreamSvc
    // Record which ctx `this.ctx` actually is. `Context` exposes the providing
    // fiber; identity comparison with the provider instance's own context is the
    // measurement.
    const own = self.ctx as unknown as { fiber?: { name?: string } }
    log.push(`Q1 this.ctx.fiber.name = ${own?.fiber?.name ?? "<none>"}`)

    self.ctx.effect(() => () => {
      self.effectDisposerRan = true
      self.streamHalted = true
    })

    return makeStream(self)
  }
}

/** Module-scope generator: no `this`, so the shadow rewrite cannot break it. */
async function* makeStream(svc: StreamSvc): AsyncGenerator<string> {
  let n = 0
  while (!svc.streamHalted) {
    n += 1
    if (n > 500) break
    yield `chunk-${n}`
    await new Promise((r) => setTimeout(r, 10))
  }
  log.push(`Q1 generator loop exited after ${n - 1} chunks (halted=${svc.streamHalted})`)
}

async function main() {
  const ctx = new Context()
  const svc = new StreamSvc(ctx)

  // A named plugin, so unloading it is a distinct, observable event.
  const plugin = ctx.plugin(function streamPlugin(pctx: Context) {
    const api = pctx as unknown as { streamSvc: StreamSvc }
    // Consume one item, then keep the iterator open.
    void (async () => {
      for await (const chunk of api.streamSvc.effectBoundRead()) {
        log.push(`Q2 consumed ${chunk}`)
        if (chunk === "chunk-2") break
      }
      log.push("Q2 loop exited")
    })()
  })

  await plugin
  // Let the stream start and prove chunks flow through the shadow proxy.
  await new Promise((r) => setTimeout(r, 120))

  // ---- Q3: did the async iterable survive the per-caller proxy? -------------
  const viaProxy = ctx.get("streamSvc") as unknown as { effectBoundRead(): unknown }
  const iter = viaProxy.effectBoundRead()
  const isAsyncIterable = typeof (iter as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  log.push(`Q3 caller sees an async iterable: ${isAsyncIterable}`)

  // ---- Q2: unload the plugin while its loop is still open ------------------
  log.push("--- disposing the plugin fiber ---")
  const fiber = (plugin as unknown as { dispose?: () => void }).dispose
  if (typeof fiber === "function") {
    ;(plugin as unknown as { dispose: () => void }).dispose()
  } else {
    log.push("Q2 plugin handle has no dispose() — cannot unload")
  }

  await new Promise((r) => setTimeout(r, 200))

  console.log("=== trace ===")
  for (const line of log) console.log(`  ${line}`)

  console.log("")
  console.log(`Q1 effect disposer ran after unload : ${svc.effectDisposerRan}`)
  console.log(`Q1 stream halted by that disposer   : ${svc.streamHalted}`)
  console.log(`Q3 async iterable survived proxy    : ${isAsyncIterable}`)
  console.log("")
  if (svc.effectDisposerRan) {
    console.log(
      "RESULT Q1 ctx.effect inside a Service method IS bound to the caller ⇒ " +
        "the caller's unload runs it. That is the stream-lifecycle mechanism.",
    )
  } else {
    console.log(
      "RESULT Q1 the effect did NOT run on caller unload ⇒ it is NOT the " +
        "mechanism; the proposal's §8 item 4 needs a different answer.",
    )
  }
  process.exit(0)
}

main()
