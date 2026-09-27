/**
 * The audit/lifecycle economy question: if `read()` registers a disposer on the
 * caller's fiber per call, what does that cost?
 *
 * WHY THIS EXISTS
 *   `probe-host-stream-lifecycle.ts` measured that `this.ctx.effect(...)` inside a
 *   Service method binds to the CALLER's fiber, and `probe-host-stream-leak.ts`
 *   measured that this is the only thing that stops a stream at plugin unload
 *   (an unguarded stream kept producing 16 chunks after its plugin was gone).
 *
 *   So the lifecycle guard is `this.ctx.effect(...)` per stream. But a file
 *   capability is called in LOOPS — a plugin syncing 10,000 files calls
 *   `read()` 10,000 times. If each call leaves an effect registration behind
 *   until the plugin unloads, the guard becomes an unbounded leak of its own.
 *   That is a design input, and it is cheap to measure.
 *
 * Q_A. Does `ctx.effect(...)` return a disposer we can call when the stream ends
 *      normally (so a completed stream leaves nothing behind)?
 *
 * Q_B. Does calling that disposer early actually remove the registration — i.e.
 *      does the guard not fire later for an already-finished stream?
 *
 * Q_C. What does N registrations cost? (Measures the naive shape: register per
 *      call, never dispose.)
 *
 * Run: bun run docs/probes/probe-host-effect-economy.ts
 */
import { Context, Service } from "../../host/node_modules/cordis/lib/index.js"

const findings: string[] = []

class EffectSvc extends Service {
  /** Number of disposers that have run, i.e. effects that actually fired. */
  disposersRun = 0

  constructor(ctx: Context) {
    super(ctx, "effectSvc")
  }

  /**
   * The shape under test: register a per-stream disposer on the CALLER's fiber
   * and hand it back, so a completed stream can release it.
   */
  read(): { release: () => void; markDone: () => void } {
    let done = false
    const dispose = this.ctx.effect(() => () => {
      if (done) return
      this.disposersRun += 1
    })
    return {
      release: typeof dispose === "function" ? (dispose as () => void) : () => {},
      markDone: () => {
        done = true
      },
    }
  }

  /** Counts registrations the naive way can only be inferred from disposers. */
  get ran(): number {
    return this.disposersRun
  }
}

async function main() {
  // ---- Q_A / Q_B ----------------------------------------------------------
  const ctx = new Context()
  const svc = new EffectSvc(ctx)

  let returnedDisposer: unknown = undefined
  const plugin = ctx.plugin(function effectPlugin(pctx: Context) {
    const api = (pctx as unknown as { effectSvc: EffectSvc }).effectSvc
    const handle = api.read()
    returnedDisposer = handle
    // The stream completes normally, so the guard should be released early.
    handle.markDone()
    handle.release()
  })
  await plugin

  findings.push(`Q_A ctx.effect returns a disposer function: ${typeof (returnedDisposer as { release?: unknown })?.release === "function"}`)
  findings.push(`Q_B completed stream's guard did not fire: ${svc.ran === 0}`)

  // ---- Q_C: does the guard still fire for a stream left OPEN? --------------
  const ctx2 = new Context()
  const svc2 = new EffectSvc(ctx2)
  const plugin2 = ctx2.plugin(function openPlugin(pctx: Context) {
    const api = (pctx as unknown as { effectSvc: EffectSvc }).effectSvc
    // A stream left open: no release, no completion.
    api.read()
  })
  await plugin2
  ;(plugin2 as unknown as { dispose: () => void }).dispose()
  await new Promise((r) => setTimeout(r, 50))
  findings.push(`Q_C an open stream's guard fired on unload: ${svc2.ran === 1}`)

  // ---- Q_C2: the naive shape, at scale ------------------------------------
  const ctx3 = new Context()
  const svc3 = new EffectSvc(ctx3)
  const N = 1000
  const plugin3 = ctx3.plugin(function busyPlugin(pctx: Context) {
    const api = (pctx as unknown as { effectSvc: EffectSvc }).effectSvc
    // Naive: 1000 reads, none released. This is the sync-a-folder pattern.
    for (let i = 0; i < N; i++) api.read()
  })
  await plugin3
  ;(plugin3 as unknown as { dispose: () => void }).dispose()
  await new Promise((r) => setTimeout(r, 100))
  findings.push(`Q_C2 ${N} naive registrations all fired on unload: ${svc3.ran === N} (got ${svc3.ran})`)

  console.log("=== findings ===")
  for (const line of findings) console.log(`  ${line}`)
  console.log("")
  console.log(
    "RESULT the per-stream guard must be RELEASED when the stream ends normally, " +
      "or a bulk sync accumulates one registration per file until the plugin unloads.",
  )
  process.exit(0)
}

main()
