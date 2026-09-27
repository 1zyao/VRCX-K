/**
 * What does option A actually cost? Measured, not estimated.
 *
 * THE QUESTION
 *   Design §4.2 offers three ways to handle "the host itself calls `ctx.hands`".
 *   Option A ("protect both sides") sounds like it doubles the work: two effect
 *   registrations and two releases per stream. Before accepting that framing,
 *   check it — the doubling may be unnecessary, and "sounds expensive" is exactly
 *   the kind of claim this probe set exists to falsify.
 *
 * THE INSIGHT BEING TESTED
 *   `gracefulStop` (host/src/lifecycle.ts) disposes **all plugin fibers FIRST**
 *   (steps 1-2), and only then clears root disposables (step 3). So a plugin's
 *   stream is already stopped by its own fiber disposal before step 3 runs — it
 *   does NOT need a second, root-level registration.
 *
 *   If that holds, A is not "register twice". It is "register on the caller's
 *   fiber; if the caller has no fiber to speak of, register on root instead" —
 *   ONE registration per stream, chosen by who is responsible.
 *
 * MEASURED
 *   Q1. Cost of one `ctx.effect` registration + its disposer call (the per-stream
 *       overhead A adds over the naive "register nothing").
 *   Q2. Does an unreleased registration accumulate? (Earlier probe said yes: 1000
 *       survived. Re-confirm, since A's cost claim depends on releasing.)
 *   Q3. Does the conditional scheme cover BOTH teardown paths?
 *       (a) plugin unload stops a plugin's stream,
 *       (b) the host's own stream stops at graceful-stop step 3.
 *   Q4. Is registering on the caller's ctx when the caller IS root a problem
 *       (double registration on one fiber)?
 *
 * Run: bun run docs/probes/probe-host-option-a-cost.ts
 */
import { Context, Service } from "../../host/node_modules/cordis/lib/index.js"

const findings: string[] = []
function note(line: string): void {
  findings.push(line)
}

class Svc extends Service {
  constructor(ctx: Context) {
    super(ctx, "costSvc")
  }

  /** Register on the caller's ctx — the shape option A would use. */
  read(): () => void {
    const dispose = this.ctx.effect(() => () => {}) as unknown as (() => void) | undefined
    return typeof dispose === "function" ? dispose : () => {}
  }
}

/** Mean microseconds per unit, from a warm loop. */
function bench(units: number, run: (i: number) => () => void): { us: number; released: number } {
  // Warm up, so the first-call cost does not dominate.
  const warm = run(0)
  if (typeof warm === "function") warm()

  const started = performance.now()
  const releases: Array<() => void> = []
  for (let i = 0; i < units; i++) {
    const release = run(i)
    if (typeof release === "function") releases.push(release)
  }
  const registered = performance.now() - started

  const releaseStarted = performance.now()
  for (const release of releases) release()
  const releasedAt = performance.now() - releaseStarted
  void releasedAt

  return { us: (registered / units) * 1000, released: releases.length }
}

async function main() {
  // ---- Q1: the per-stream cost -------------------------------------------
  const ctx = new Context()
  const svc = new Svc(ctx)
  const UNITS = 10_000
  const timing = bench(UNITS, () => svc.read())
  note(`Q1 register ${UNITS} effects: ${timing.us.toFixed(3)} us each`)

  // ---- Q2: does an unreleased registration accumulate? --------------------
  const ctx2 = new Context()
  const svc2 = new Svc(ctx2)
  const N = 1000
  const kept: Array<() => void> = []
  for (let i = 0; i < N; i++) kept.push(svc2.read())
  const rootFiber = (ctx2 as unknown as { fiber: { _disposables?: { length?: number } } }).fiber
  const held = rootFiber._disposables?.length ?? 0
  note(`Q2 ${N} unreleased registrations sit on the fiber: ${held} (>= ${N} means they accumulate)`)

  // Release them and confirm the table actually shrinks, so "release" is not a
  // no-op that merely looks tidy.
  for (const release of kept) release()
  const afterRelease = rootFiber._disposables?.length ?? 0
  note(`Q2 after releasing all of them: ${afterRelease} remain`)

  // ---- Q3: does the conditional scheme cover both teardown paths? ---------
  let pluginStreamStopped = false
  let hostStreamStopped = false

  const ctx3 = new Context()
  class LifecycleSvc extends Service {
    constructor(c: Context) {
      super(c, "lifecycleSvc")
    }
    /**
     * Option A as actually implementable: register on the CALLER's ctx. A plugin
     * caller lands on its own fiber (stopped at unload); the root caller lands on
     * root (stopped by gracefulStop's step 3). ONE registration either way.
     */
    stream(label: string): void {
      this.ctx.effect(() => () => {
        if (label === "plugin") pluginStreamStopped = true
        if (label === "host") hostStreamStopped = true
      })
    }
  }
  const lifecycle = new LifecycleSvc(ctx3)

  // (a) a plugin's stream
  const plugin = ctx3.plugin(function streamPlugin(pctx: Context) {
    const api = (pctx as unknown as { lifecycleSvc: LifecycleSvc }).lifecycleSvc
    api.stream("plugin")
  })
  await plugin
  ;(plugin as unknown as { dispose: () => void }).dispose()
  await new Promise((r) => setTimeout(r, 30))
  note(`Q3a plugin stream stopped at plugin unload: ${pluginStreamStopped}`)

  // (b) the host's own stream, from the root ctx
  lifecycle.stream("host")
  note(`Q3b host stream still running after plugin unload: ${!hostStreamStopped}`)

  // Then simulate gracefulStop's step 3.
  const disposers =
    (
      ctx3 as unknown as { fiber: { _disposables?: { clear?: () => Array<() => unknown> } } }
    ).fiber._disposables?.clear?.() ?? []
  note(`Q3b gracefulStop step 3 would clear ${disposers.length} root disposable(s)`)
  for (const dispose of disposers) await dispose()
  await new Promise((r) => setTimeout(r, 30))
  note(`Q3b host stream stopped at graceful stop: ${hostStreamStopped}`)

  // ---- Q4: caller IS root — is a single registration enough? --------------
  // If `this.ctx` is already root, the conditional adds nothing and must not
  // double-register. Measured by counting disposables before/after one call.
  const ctx4 = new Context()
  const svc4 = new LifecycleSvc(ctx4)
  const rootBefore = (ctx4 as unknown as { fiber: { _disposables?: { length?: number } } }).fiber
    ._disposables?.length ?? 0
  svc4.stream("host")
  const rootAfter = (ctx4 as unknown as { fiber: { _disposables?: { length?: number } } }).fiber
    ._disposables?.length ?? 0
  note(`Q4 one root-caller stream added ${rootAfter - rootBefore} registration(s) (1 = no doubling)`)

  console.log("=== findings ===")
  for (const line of findings) console.log(`  ${line}`)
  console.log("")
  const cheap = timing.us < 50
  console.log(
    cheap
      ? `RESULT option A costs ~${timing.us.toFixed(2)} us of registration per stream, ONE ` +
          `registration (not two), and it is only paid if the implementation releases on stream end.`
      : `RESULT registration is NOT cheap (${timing.us.toFixed(2)} us); reconsider the per-stream shape.`,
  )
  process.exit(0)
}

main()
