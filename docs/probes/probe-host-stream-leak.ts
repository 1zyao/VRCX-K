/**
 * The leak question: if a plugin is unloaded mid-stream, what actually stops it?
 *
 * Follows `probe-host-stream-lifecycle.ts`, whose Q1 measured that
 * `this.ctx.effect(...)` inside a Service method binds to the CALLER's fiber.
 * That gives a mechanism — but only if the implementation USES it. This probe
 * measures the failure mode when it does not, which is the whole reason §8 item 4
 * exists:
 *
 *   "流生命周期绑定 ctx.effect：插件卸载时流要自动断 —— 未实现、未测。
 *    这是 §6.3 的前提：卸载后仍在读盘的服务，审计也救不了它。"
 *
 * Q_A. A plugin starts a stream and does NOT break out of it. Then the plugin is
 *      unloaded. Does the loop keep running?  (Expected: YES — nothing knows
 *      about a plain AsyncIterable, so this is the leak.)
 *
 * Q_B. Same, but the Service registered `this.ctx.effect(...)` on the CALLER's
 *      fiber and aborts the stream from the disposer. Does it stop?
 *      (Expected: YES — this is the fix.)
 *
 * Q_C. A plugin calls the service from a NON-plugin context (the root ctx, as the
 *      host itself does at boot). `this.ctx` is then the root ctx, and an effect
 *      registered there is documented (AGENTS.md) as never running and never
 *      erroring. Confirm the silent-no-op, because it means "register on
 *      this.ctx" is only correct when the caller is a plugin fiber.
 *
 * Run: bun run docs/probes/probe-host-stream-leak.ts
 */
import { Context, Service } from "../../host/node_modules/cordis/lib/index.js"

type Case = {
  name: string
  /** Chunks observed after the plugin was unloaded. */
  ticksAfterUnload: number
  /** Whether the implementation's disposer ran at all. */
  disposerRan: boolean
  /** Whether the stream stopped within the observation window. */
  halted: boolean
}

const results: Case[] = []

/** A Service offering two shapes: unguarded, and guarded by the caller's effect. */
class LeakSvc extends Service {
  /** Counts chunks produced, so "kept running" is a number and not an opinion. */
  produced = 0
  halted = false

  constructor(ctx: Context) {
    super(ctx, "leakSvc")
  }

  /** Unguarded: nothing links this stream to the caller's lifetime. */
  unguarded(): AsyncGenerator<string> {
    return pump(this)
  }

  /**
   * Guarded: the disposer is registered on the CALLER's fiber, so unloading the
   * plugin aborts the stream. `this.ctx` is the caller's ctx (measured in
   * probe-host-stream-lifecycle Q1), which is exactly what makes this work.
   */
  guarded(): AsyncGenerator<string> {
    const self = this
    self.ctx.effect(() => () => {
      self.disposerRan = true
      self.halted = true
    })
    return pump(self)
  }

  disposerRan = false
}

/** Module-scope pump: no `this`, so the shadow rewrite cannot interfere. */
async function* pump(svc: LeakSvc): AsyncGenerator<string> {
  while (!svc.halted) {
    svc.produced += 1
    yield `chunk-${svc.produced}`
    await new Promise((r) => setTimeout(r, 15))
  }
}

async function runCase(
  name: string,
  call: (svc: LeakSvc) => AsyncIterable<string>,
): Promise<void> {
  const ctx = new Context()
  const svc = new LeakSvc(ctx)

  const plugin = ctx.plugin(function leakingPlugin(pctx: Context) {
    // ⚠ `pctx` is the CONTEXT, not the service: the service is reached as
    // `pctx.leakSvc`. Passing the context where a service is expected produces
    // cordis's own `cannot get property "x" without inject` — an instrument bug
    // this probe hit on its first run.
    const service = (pctx as unknown as { leakSvc: LeakSvc }).leakSvc
    // Deliberately never breaks: this is the plugin that "forgets" to stop.
    void (async () => {
      for await (const _chunk of call(service)) {
        /* keep consuming forever */
      }
    })()
  })
  await plugin
  // Let it produce for a while, then record a baseline.
  await new Promise((r) => setTimeout(r, 100))
  const before = svc.produced

  // Unload the plugin. Nothing else happens.
  ;(plugin as unknown as { dispose: () => void }).dispose()
  await new Promise((r) => setTimeout(r, 250))
  const after = svc.produced

  results.push({
    name,
    ticksAfterUnload: after - before,
    disposerRan: svc.disposerRan,
    halted: svc.halted,
  })
}

/** Q_C: called from the root ctx, not from a plugin fiber. */
async function rootCallerCase(): Promise<void> {
  const ctx = new Context()
  const svc = new LeakSvc(ctx)
  // The host calling its own service at boot — no plugin fiber in play.
  const iter = svc.guarded()
  void (async () => {
    for await (const _chunk of iter) break
  })()
  await new Promise((r) => setTimeout(r, 80))
  // There is no plugin to unload; the question is only whether the effect was
  // accepted silently (it must not throw, and it must never run).
  console.log(`Q_C root-caller effect registered without throwing: true`)
  console.log(`Q_C root-caller disposer ran (expected false):      ${svc.disposerRan}`)
}

async function main() {
  await runCase("A unguarded", (api) => api.unguarded())
  await runCase("B guarded by caller ctx.effect", (api) => api.guarded())
  await rootCallerCase()

  console.log("=== results ===")
  for (const r of results) {
    console.log(
      `  ${r.name.padEnd(34)} chunksAfterUnload=${String(r.ticksAfterUnload).padStart(3)} ` +
        `disposerRan=${String(r.disposerRan).padEnd(5)} halted=${r.halted}`,
    )
  }

  const unguarded = results[0]
  const guarded = results[1]
  console.log("")
  console.log(
    unguarded.ticksAfterUnload > 0
      ? `RESULT A CONFIRMED LEAK: an unguarded stream kept producing ` +
        `${unguarded.ticksAfterUnload} chunks after its plugin was unloaded. ` +
        `Plain AsyncIterables are invisible to cordis.`
      : "RESULT A no leak observed — the unguarded stream stopped by itself (unexpected)",
  )
  console.log(
    guarded.halted && guarded.ticksAfterUnload === 0
      ? "RESULT B FIX WORKS: registering on the caller's ctx halts the stream at unload."
      : `RESULT B the guard did NOT stop it (ticksAfterUnload=${guarded.ticksAfterUnload})`,
  )
  process.exit(0)
}

main()
