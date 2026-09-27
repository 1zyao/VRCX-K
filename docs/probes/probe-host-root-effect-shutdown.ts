/**
 * Does a root-context effect EVER run? The earlier probe said "no" — verify.
 *
 * WHY THIS NEEDS RE-MEASURING
 *   `probe-host-stream-lifecycle.ts` Q_C reported that an effect registered from
 *   the ROOT ctx never runs ("root-caller disposer ran (expected false): false").
 *   But that probe only waited for a timeout. It never shut the host down.
 *
 *   `host/src/lifecycle.ts:104-114` does something specific:
 *
 *     // 3. Root fiber's own disposables
 *     const disposers = root._disposables?.clear() ?? []
 *     for (const dispose of disposers) await dispose()
 *
 *   So a root effect is not "never executed" — it is executed by the host's OWN
 *   shutdown path, explicitly, because cordis does not collect it automatically.
 *   That distinction changes the design answer, so it is measured rather than
 *   inferred from either reading or from the earlier probe.
 *
 * Q1. Does an effect registered on the root ctx land in `root._disposables`?
 * Q2. Does clearing `root._disposables` (what gracefulStop does) run it?
 * Q3. Does a PLUGIN's effect also run at shutdown, through fiber disposal?
 * Q4. Control: does disposing a plugin run ONLY its own effect, not root's?
 *
 * Run: bun run docs/probes/probe-host-root-effect-shutdown.ts
 */
import { Context, Service } from "../../host/node_modules/cordis/lib/index.js"

const findings: string[] = []

class Svc extends Service {
  rootDisposers = 0
  constructor(ctx: Context) {
    super(ctx, "rootEffectSvc")
  }

  /** Register on whatever ctx the CALLER has — root or a plugin fiber. */
  register(label: string): void {
    this.ctx.effect(() => () => {
      if (label === "root") this.rootDisposers += 1
      findings.push(`disposer ran: ${label}`)
    })
  }
}

async function main() {
  const ctx = new Context()
  const svc = new Svc(ctx)

  // ---- Q1: register from the ROOT ctx ------------------------------------
  svc.register("root")

  const rootFiber = (ctx as unknown as { fiber: { _disposables?: { length?: number } } }).fiber
  const rootCount = rootFiber._disposables?.length ?? 0
  findings.push(`Q1 root._disposables length after a root effect: ${rootCount}`)

  // ---- Q3: register from a PLUGIN fiber ----------------------------------
  const plugin = ctx.plugin(function effectPlugin(pctx: Context) {
    const api = (pctx as unknown as { rootEffectSvc: Svc }).rootEffectSvc
    api.register("plugin")
  })
  await plugin

  // ---- Q4: dispose ONLY the plugin — root's must survive ------------------
  ;(plugin as unknown as { dispose: () => void }).dispose()
  await new Promise((r) => setTimeout(r, 30))
  const pluginRan = findings.includes("disposer ran: plugin")
  const rootRanEarly = findings.includes("disposer ran: root")
  findings.push(`Q4 plugin effect ran on plugin dispose: ${pluginRan}`)
  findings.push(`Q4 root effect did NOT run on plugin dispose: ${!rootRanEarly}`)

  // ---- Q2: simulate gracefulStop's root-disposables step ------------------
  const disposers = (
    rootFiber as unknown as { _disposables?: { clear?: () => Array<() => unknown> } }
  )._disposables?.clear?.()
  const cleared = disposers?.length ?? 0
  findings.push(`Q2 gracefulStop would clear ${cleared} root disposable(s)`)
  for (const dispose of disposers ?? []) {
    await dispose()
  }
  await new Promise((r) => setTimeout(r, 30))
  const rootRanAtShutdown = findings.includes("disposer ran: root")

  console.log("=== trace ===")
  for (const line of findings) console.log(`  ${line}`)
  console.log("")
  console.log(
    rootRanAtShutdown
      ? "RESULT a ROOT effect DOES run — but only because gracefulStop clears root._disposables " +
          "explicitly. It does not run on plugin unload, and not on a hard kill."
      : "RESULT a ROOT effect does NOT run even at graceful shutdown — the host's step 3 missed it.",
  )
  process.exit(0)
}

main()
