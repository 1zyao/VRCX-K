import "./log"
import { readFile } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import Group from "@cordisjs/plugin-group"
import Include from "@cordisjs/plugin-include"
import type { Entry } from "@cordisjs/plugin-loader"
import Loader from "@cordisjs/plugin-loader"
import LoggerConsole from "@cordisjs/plugin-logger-console"
import Timer from "@cordisjs/plugin-timer"
import { Context } from "cordis"
import { RPCTransportClosedError } from "kkrpc"
import { createShellCapabilities, ShellHandle } from "./capability"
import { attachDevWatch, DevWatch, type DevWatchEvent } from "./dev-watch"
import { declaresHeartbeat, FIBER_ACTIVE, FIBER_FAILED } from "./fiber"
import { HandsService } from "./hands"
import { stopOnShellLost, stopOnStdinLoss } from "./lifecycle"
import { log, logWithSecret, REDACTED, redactUserPath } from "./log"
import { loadManifests, manifestRegistryOf } from "./manifests"
import { makeRestartRequester } from "./restart"
import { AutostartService } from "./shell-extras"
import { ShortcutService } from "./shortcut"
import { ShutdownSignal } from "./signal"
import { watchStdinClose } from "./stdin-watch"
import { connectShellStdio, type DevWatchPush } from "./stdio"
import { TrayService } from "./tray"
import { listenHostWs } from "./ws"

export { HOST_RESTART_EXIT as EXIT_RESTART } from "./api"

/** How long to wait for the include tree (and its plugin entries) to settle. */
const INCLUDE_SETTLE_TIMEOUT_MS = 15_000

// The fiber-state numbers and the heartbeat-declaration check live in
// `fiber.ts` so they can be unit-tested without booting a host (this module has
// top-level side effects).

type FiberLike = { uid?: number | null; state?: number; await?(): Promise<unknown> }

function fiberOf(entry: Entry): FiberLike | undefined {
  return (entry.fiber as FiberLike | null | undefined) ?? undefined
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error === undefined) return "unknown error"
  return String(error)
}

/** Normalize a DevWatchEvent into the JSON-safe wire shape for the shell. */
function toDevWatchPush(event: DevWatchEvent): DevWatchPush {
  const base: DevWatchPush = { type: event.type }
  if (event.type === "reload") {
    base.entryId = event.entryId
    base.status = event.result.status
    if (event.result.error !== undefined) {
      base.error =
        event.result.error instanceof Error
          ? event.result.error.message
          : String(event.result.error)
    }
  } else if (event.type === "change" || event.type === "unowned" || event.type === "ambiguous") {
    base.path = event.path
    if ("entryIds" in event && event.entryIds) base.entries = event.entryIds
  } else if (event.type === "config-refreshed") {
    base.entries = event.entries
  } else if (event.type === "config-error" || event.type === "watcher-error") {
    base.error = event.error instanceof Error ? event.error.message : String(event.error)
  }
  return base
}

/**
 * Validate the `VRCXK_DEV_WATCH_MAP` shape: a JSON object mapping entryId to an
 * array of path strings. A non-array value used to reach `entryRoots` and blow
 * up with an opaque TypeError; fail with a message that names the source.
 */
export function assertDevMap(value: unknown, source: string): Record<string, string[]> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source}: expected a JSON object mapping entryId -> string[]`)
  }
  for (const [entryId, roots] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(roots) || roots.some((root) => typeof root !== "string")) {
      throw new Error(`${source}: entry "${entryId}" must map to an array of path strings`)
    }
  }
  return value as Record<string, string[]>
}

async function readDevMap(): Promise<Record<string, string[]> | undefined> {
  const raw = process.env.VRCXK_DEV_WATCH_MAP
  if (!raw) return undefined
  try {
    return assertDevMap(JSON.parse(raw), "VRCXK_DEV_WATCH_MAP")
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    // Not inline JSON — treat as a path to a JSON file (env var first, file
    // path fallback relative to cwd).
    try {
      return assertDevMap(JSON.parse(await readFile(raw, "utf8")), raw)
    } catch (inner) {
      throw new Error(
        `VRCXK_DEV_WATCH_MAP file "${raw}" is not a valid dev map: ${describeError(inner)}`,
        {
          cause: inner,
        },
      )
    }
  }
}

/**
 * Wait for the include tree to settle, failing FAST on a broken include:
 *
 *   - the include entry's own fiber (missing/unreadable cordis.yml, import
 *     error) rejects with the original cause immediately — this used to spin
 *     the whole 15s settle timeout, which made a wrong-cwd startup look like a
 *     hang and broke the ws-heartbeat test's 5s budget;
 *   - a failed plugin entry inside the tree fails fast with its cause;
 *   - the healthy-but-not-yet-active case keeps a bounded settle wait, after
 *     which readiness is asserted (≥1 ACTIVE entry, plus the heartbeat service
 *     declared by cordis.yml) — the assertion the pre-#11 host had.
 */
async function waitForIncludeReady(ctx: Context, includeEntry: Entry): Promise<void> {
  const ownFiber = fiberOf(includeEntry)
  if (ownFiber?.await) {
    try {
      await ownFiber.await()
    } catch (cause) {
      throw new Error(`include plugin failed to assemble: ${describeError(cause)}`, { cause })
    }
  }

  const deadline = Date.now() + INCLUDE_SETTLE_TIMEOUT_MS
  let activeEntries = 0
  for (;;) {
    activeEntries = 0
    const subtree = includeEntry.subtree
    if (subtree) {
      for (const entry of subtree.entries()) {
        const fiber = fiberOf(entry)
        if (!fiber) continue
        if (fiber.state === FIBER_FAILED) {
          let cause: unknown
          try {
            await fiber.await?.()
          } catch (error) {
            cause = error
          }
          throw new Error(`${entry.id} plugin failed to assemble: ${describeError(cause)}`, {
            cause,
          })
        }
        if (fiber.state === FIBER_ACTIVE) activeEntries += 1
      }
    }
    const heartbeatReady = !declaresHeartbeat(includeEntry) || ctx.get("heartbeat") != null
    if (activeEntries > 0 && heartbeatReady) return
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (activeEntries === 0) {
    throw new Error("include tree did not become ready in time (no active plugin entry)")
  }
  throw new Error("heartbeat plugin failed to assemble")
}

async function bootstrap() {
  log("starting Cordis...")
  const ctx = new Context()
  ctx.baseUrl = `${pathToFileURL(process.cwd()).href}/`

  // Provide the shutdown signal service so plugins can participate in
  // graceful shutdown cooperatively via ctx.signal (see signal.ts).
  ctx.provide("signal", new ShutdownSignal())
  void ctx.signal // type guard — provided above

  // Tray service (issue: host → shell tray ingress). Always present so plugins
  // can inject `ctx.tray`; it reports "no shell" until the shell bridge
  // attaches, and resyncs whatever was requested in the meantime. It is a
  // cordis `Service` subclass so calls are attributable to the calling plugin
  // (M2-1); a plain `ctx.provide` object would lose that.
  const tray = new TrayService(ctx, { log: (line) => log(line) })
  // Stop publishing and drop action handlers on shutdown (no async work).
  ctx.effect(() => () => tray.close())

  // Global shortcut service (issue #6 callback): the shell owns OS
  // registration, this owns which chord runs which handler. Always present so
  // plugins can inject `ctx.shortcut`; with no shell it reports `no-shell`.
  const shortcuts = new ShortcutService(ctx, { log: (line) => log(line) })
  ctx.effect(() => () => shortcuts.close())

  // Capability surface (M2-1): the raw `ctx.shell` mirror plus the curated
  // `ctx.notify`/`ctx.dialog`/`ctx.window`/`ctx.os` services. Registered before
  // the loader so plugins can inject them; the shell bridge attaches later.
  const capabilities = new ShellHandle((line) => log(line))
  createShellCapabilities(ctx, capabilities)

  // File capability (M2). A `Service` subclass rather than a `buildNode` mirror
  // because it owns per-stream state: every `read`/`watch` registers a guard on
  // the CALLER's fiber, so unloading a plugin stops its in-flight stream. That is
  // a measured requirement, not a nicety — an unguarded stream kept producing
  // after its plugin was unloaded (docs/probes/probe-host-stream-leak.ts).
  //
  // Registered before the loader so plugins can inject `ctx.hands`; it reports
  // "no shell" until the bridge attaches, like tray/shortcut.
  const hands = new HandsService(ctx, {
    audit: (line) => log(line),
  })
  ctx.effect(() => () => hands.detachShell())

  // Desktop-only "start with the system". A `Service` because it must tell "no
  // shell yet" (a waiting state) apart from "this platform has no such route"
  // (permanent) — a plain mirror cannot express that distinction. Nothing enables
  // autostart at boot: the user owns that decision, this only exposes the switch.
  //
  // ⚠ It takes `audit` for the same reason `hands` does: this is the SUPPORTED
  // entry point for a PERSISTENT OS change, so an undeclared call to it must
  // leave a trace. Omitting the callback is what kept it invisible.
  const autostart = new AutostartService(ctx, { audit: (line) => log(line) })
  ctx.effect(() => () => autostart.detachShell())

  await ctx.plugin(Loader)

  // ── Upstream plugins we were re-implementing by hand ────────────────────
  //
  // Adopted after an upstream survey found Cordis already ships solutions for
  // problems this repo was solving itself (see docs/legacy-recon and the survey
  // notes). Two are registered BEFORE the loader so plugin entries can use them:
  //
  //   Timer  — ctx.timeout/interval/throttle/debounce, EVERY one registered via
  //            ctx.effect. This is why we do not need a lint that detects a bare
  //            setInterval: the sanctioned API cannot leak, so the discipline is
  //            the default path rather than a rule to remember (#19).
  //            ⚠ Access is inject-gated: a plugin touching ctx.interval without
  //              `inject: ['timer']` goes FAILED and never loads (measured —
  //              docs/probes/probe31.ts and the inject-failure check). The plugin
  //              template must declare it.
  //
  //   LoggerConsole — renders ctx.logger through console.log. Safe HERE only
  //            because `import "./log"` (line 1) patches console.log → stderr
  //            first; stdout carries the kkrpc/stdio protocol. Adopting this
  //            without that patch would write protocol frames onto the log
  //            channel.
  await ctx.plugin(Timer)
  await ctx.plugin(LoggerConsole, {})

  // Mount Include as a loader-tree builtin entry. This is the Cordis-standard
  // shape: the Include EntryTree is reachable via the loader Entry's
  // `.subtree`, which the dev watcher needs to map file events to plugin
  // Entries and to refresh config. `Include` stays a static import so
  // `bun build --compile` keeps it in the bundle (see M0 findings).
  ctx.loader.builtins.include = Include
  // `cordis:group` resolves through builtins — without this, a `group: true` /
  // `name: cordis:group` entry never materialises and its children are skipped
  // silently. (That exact omission invalidated an earlier probe: every scenario
  // reported loaded=[] including its own baseline.)
  ctx.loader.builtins.group = Group
  const includeId = await ctx.loader.create({
    name: "cordis:include",
    config: { path: "./cordis.yml", enableLogs: false },
  })
  const includeEntry = ctx.loader.resolve(includeId)

  // Wait for the include subtree + its plugin entries to settle.
  await waitForIncludeReady(ctx, includeEntry)

  // ── Manifest registry (M2-2) ───────────────────────────────────────────
  //
  // Every user entry's declaration is read from `<plugin-dir>/.vrcxk/manifest.json`
  // and indexed by the STABLE part of its entry id (probe11: the full id is
  // `<random-prefix>:<yaml-id>` and the prefix changes every run).
  //
  // A missing or invalid manifest is NOT fatal here. Refusing to load is a
  // separate, deliberate decision made before the entry is created; once a
  // plugin is in the tree, an absent declaration simply means there is nothing
  // to compare its capability usage against (design P2: show, never block).
  //
  // ⚠ THE RESULT USED TO BE DROPPED, and that made the registry a BLACK BOX: a
  // plugin whose manifest failed to register — an illegal one rejected by
  // `maxItems`, an id that disagrees with its entry, a present-but-malformed JSON
  // — looked exactly like a plugin that never shipped a manifest, and BOTH look
  // exactly like a plugin that is behaving. `findOverreach` returns `undefined`
  // for a plugin with no registered manifest (correctly — nothing was promised),
  // so `#24`'s whole question "which plugins are currently unconstrained?" had no
  // observable answer. That is the downstream half of the `maxItems` defect: the
  // rejection itself is reported by the loader, but nothing said how many
  // declarations the host ended up WITHOUT.
  //
  // So the outcome is logged in both directions. The counts are what makes
  // "unconstrained" countable at all; the names are what makes it actionable.
  // ⚠ Not a warning per skipped plugin: a plugin legitimately without a manifest
  // is the normal case today (the base plugins have none), and a log that warns
  // on every boot is a log nobody reads. `loadManifests` already warns for the
  // cases that are actually wrong (an unresolvable directory, a present-but-broken
  // manifest) — this line is the SUMMARY that was missing, not a second opinion
  // on each one.
  const manifestResult = await loadManifests(ctx, includeEntry)
  log(
    `manifests: ${manifestResult.loaded.length} registered ` +
      `(${manifestResult.loaded.join(", ") || "none"}), ` +
      `${manifestResult.skipped.length} without a usable declaration ` +
      `(${manifestResult.skipped.join(", ") || "none"})`,
  )

  // Enable overreach detection now that manifests exist (#24). Wired AFTER the
  // load, because the lookup reads the registry `loadManifests` just built — and
  // left OFF until then, so a plugin loading during bootstrap cannot produce a
  // "no manifest" warning for a manifest that simply had not been read yet.
  //
  // ⚠ Declare-and-warn only, never a refusal: plugins are in-process, so a
  // determined one can bypass this with a plain `import`. See `overreach.ts`.
  //
  // EVERY curated entry point gets the lookup, and that is the point: `#24` §2
  // requires the curated services and the raw mirror to be covered alike.
  //
  // ⚠ This block has now been wrong twice, in the same direction both times.
  // Wiring only `capabilities` left `ctx.hands` — the SUPPORTED entry point —
  // unchecked while the escape hatch was checked. Then `hands` was added but
  // `autostart` / `shortcut` were not, which two reviewers found independently.
  // The lesson is not "remember the third service": it is that NOTHING HERE IS
  // ENFORCED. A new service is covered only if this list is edited, so when you
  // add one, add it here AND give it `useManifests` + a `record()` — see the
  // checklist in `capability.ts`'s `record` comment.
  const registry = manifestRegistryOf(ctx)
  if (registry) {
    const lookup = (entryId: string) => registry.get(entryId)
    capabilities.useManifests(lookup)
    hands.useManifests(lookup)
    autostart.useManifests(lookup)
    shortcuts.useManifests(lookup)
    tray.useManifests(lookup)
  }

  // ── Dev watcher (issue #11) — strictly opt-in ──────────────────────────
  let devWatch: DevWatch | undefined
  let pushDevWatch: ((event: DevWatchPush) => void) | undefined
  if (process.env.VRCXK_DEV_WATCH === "1") {
    const include = includeEntry.subtree as unknown as InstanceType<typeof Include>
    if (!include) throw new Error("include subtree unavailable for dev watch")
    const devMap = await readDevMap()
    // fileURLToPath, NOT URL.pathname: `.pathname` yields "/E:/.../cordis.yml"
    // on Windows, which canonicalPath() turns into "E:\E:\..." so the config
    // hot-refresh never matched and chokidar watched a nonexistent directory.
    const configFile = fileURLToPath(new URL("./cordis.yml", ctx.baseUrl))
    const shellAttached = process.env.VRCXK_SHELL === "1"
    devWatch = new DevWatch({
      include,
      configFile,
      devMap,
      onState: (event) => {
        // Structured stderr log always.
        if (event.type === "reload") {
          const { entryId, result } = event
          log(
            `dev reload ${entryId}: ${result.status}${result.error ? ` (${String(result.error)})` : ""}`,
          )
        } else if (event.type === "started") {
          // Emitted once chokidar finished its initial scan (tests and humans
          // both need to know the watcher is live).
          log(`dev watch watching: ${event.roots.join(", ")}`)
        } else if (event.type === "config-refreshed") {
          log(`dev config refreshed: ${event.entries.join(", ")}`)
        } else if (event.type === "config-error" || event.type === "watcher-error") {
          // These used to be relayed to the shell only, so a dev session with
          // no shell attached never saw why the watcher was unhappy.
          log(`dev ${event.type}: ${String(event.error)}`)
        }
        // Cross-process relay (host → shell → face) when a shell is attached.
        pushDevWatch?.(toDevWatchPush(event))
      },
      onRestartRequired: makeRestartRequester(ctx, { shellAttached }),
    })
    await devWatch.start()
    log(`dev watch enabled (map: ${Object.keys(devMap ?? {}).length} explicit entries)`)
    // Close the watcher as part of root cleanup. `attachDevWatch` returns
    // close()'s promise from the disposer (gracefulStop awaits it) and gates
    // routing on ctx.signal.stopping.
    attachDevWatch(ctx, devWatch)
  }

  const ready = await listenHostWs(ctx)
  // `ready` is now the versioned handshake itself (see
  // contracts/host-ready/v1/host-ready.schema.json), so the version is part of
  // the payload rather than something this log line bolts on. The tests parse
  // this line, so it keeps the bare JSON object shape.
  //
  // ⚠ THE LINE IS REDACTED ON THE WAY TO THE FILE, and this is not optional.
  //
  // The handshake's REQUIRED fields include `token` — the per-launch kkrpc/ws
  // bearer token (32 random bytes, lowercase hex) that the face presents as
  // `?token=` to open the host's ws surface — and `paths`, which holds the host's
  // `cwd` and `execPath` as absolute paths that on Windows begin with the user's
  // account name.
  //
  // Until the rotating log file landed, this line only reached stderr — which in a
  // release build is `stderr(Stdio::inherit())` into a handle that leads nowhere
  // (`src-tauri/src/host.rs`, and this module's `log.ts` header). Now it lands ON
  // DISK, in a file whose stated purpose is to be "small enough to attach to a
  // report". So attaching a support bundle would have handed over a LIVE session
  // token and the user's directory layout.
  //
  // ⚠ REDACTED IN THE FILE, UNCHANGED ON STDERR — `logWithSecret`, not `log`.
  // The two consumers differ in kind: stderr is an ephemeral local pipe to whoever
  // spawned us, the file is a durable artifact that gets emailed. The token must
  // still be readable from stderr, because the host's OWN integration tests scrape
  // it there and then CONNECT with it (`host/tests/helpers.ts#readReady`, used by
  // `ws-heartbeat` / `stdin-loss` / `compile-smoke` / `sidecar-smoke`), and the
  // Rust shell never reads the value at all (it logs `token_len` only). See
  // `logWithSecret`'s comment for why that split is the honest one, not a
  // loophole.
  //
  // ⚠ REDACTED, not deleted, and the distinction is load-bearing. Those four tests
  // parse the line with `/\[host\] ready ({.*})/` and read `.token`, `.port`,
  // `.schemaVersion` and `.hostVersion` out of it. Dropping the key would turn
  // "the host announced itself" into "the host announced a malformed handshake"
  // for all four — a louder failure than the leak, but the wrong fix.
  //
  // ⚠ The redaction applies to the LOG ONLY. The very next statement sends the
  // REAL `ready` to the shell over stdio, because the shell is the party the token
  // authenticates; sanitizing the wire copy would break every ws connection while
  // every log-based test stayed green.
  const redactedReadyLine = JSON.stringify({
    ...ready,
    token: REDACTED,
    paths: {
      cwd: redactUserPath(ready.paths.cwd),
      execPath: redactUserPath(ready.paths.execPath),
    },
  })
  logWithSecret(`ready ${redactedReadyLine}`, `ready ${JSON.stringify(ready)}`)

  if (process.env.VRCXK_SHELL === "1") {
    const shell = connectShellStdio(ctx)
    // Announcing `ready` is a fire-and-observe call, not a startup gate.
    //
    // "The shell is gone" reaches us through TWO independent detectors, and both
    // must be absorbed or the exit code becomes a coin flip:
    //
    //   1. the READ side ends -> kkrpc rejects the pending call with
    //      `RPCTransportClosedError` (probe 15, cells A–D);
    //   2. a WRITE fails -> kkrpc rejects with the raw EPIPE error while
    //      `onClose` stays silent, because the read side is untouched
    //      (probe 16, cell E; `sawWriteFailure()` reports this).
    //
    // Case 2 is why this catch cannot key on the error type alone. Both mean the
    // shell died mid-handshake — the #33 case — so both take the same graceful
    // teardown. They differ only in the exit code they were previously given by
    // accident: case 1 reached `stopOnStdinLoss` (exit 0), case 2 fell through to
    // the catch-all (exit 1), and exit 1 is billed to the restart-storm budget
    // with no cause of the host's own.
    //
    // Why absorbed rather than propagated: BOTH exits are still reachable while
    // this call is outstanding — `stopOnStdinLoss` exits 0 and the bootstrap
    // catch-all below exits 1. The race was disarmed, NOT structurally removed:
    // consuming these rejections only means the second trigger never fires for
    // these causes. Anything that awaits here (a new startup step inside this
    // window) re-arms it.
    //
    // Anything that is NEITHER of the two is a genuine startup fault and must
    // keep reaching the fatal handler: a shell that does not know this method
    // (version-skewed sidecar), a handler that throws, a channel torn down
    // locally. The full reachable set is enumerated and discriminated in
    // `docs/probes/stdio-lifecycle/15-ready-rejection-taxonomy.ts` (A–D) and
    // `16-write-failure-rejection.ts` (E); the former also asserts `instanceof`
    // still matches across kkrpc's bundle chunks, since a split there would
    // silently turn this narrowing into a rethrow-everything.
    try {
      await shell.ready(ready)
    } catch (error) {
      const readSideGone = error instanceof RPCTransportClosedError
      const writeSideGone = shell.sawWriteFailure()
      if (!readSideGone && !writeSideGone) throw error
      log(
        `shell.ready not delivered (${describeError(error)}) — the shell is gone ` +
          `(${readSideGone ? "read side closed" : "write side failed"})`,
      )
      // Hand the teardown to the same stopping gate every other path uses, with
      // the dedicated exit code: the handshake never completed, so this is not a
      // clean stop (0), and the host is not at fault, so it must not be charged
      // as a crash (1). `stopOnShellLost` is a no-op if the read-side detector
      // already claimed the exit — the first trigger owns it.
      await stopOnShellLost(ctx)
    }
    // Tray ingress: push snapshots to the shell and fan shell `tray.action`
    // notifications back out to host/plugin handlers. Only wired when a shell
    // is attached — without VRCXK_SHELL the service stays in "no shell" mode.
    tray.attachShell((snapshot) => shell.tray.setSnapshot(snapshot))
    const offTrayAction = shell.tray.onAction((action) => tray.dispatchAction(action))
    ctx.effect(() => () => {
      offTrayAction()
    })
    // Shortcut callback (issue #6): the shell reports presses of the chords it
    // registered; the service routes them to the bound handler.
    shortcuts.attachShell(shell.shortcut)
    // Capability surface (M2-1): hand the shell API to the capability services.
    capabilities.attach(shell)
    // File capability (M2): the same bridge, so `ctx.hands` reads through the
    // one stdio channel. Attached here rather than at boot because the service is
    // provided before the shell exists (plugins may inject it meanwhile).
    hands.attachShell(shell)
    // Desktop-only extras. `ctx.os` and `ctx.clipboard` are stateless mirrors and
    // need no attach; only autostart carries shell-attachment state.
    autostart.attachShell(shell)
    // Bind the dev-watch relay now that the shell API proxy exists. Events
    // emitted before this point were logged only; the relay is fire-and-forget
    // so a shell without the handler (or a dropped pipe) never breaks dev.
    if (devWatch) {
      pushDevWatch = (event) => {
        void shell.shell.devWatchEvent(event).catch((error: unknown) => {
          log(`dev watch push failed: ${String(error)}`)
        })
      }
    }
  } else {
    // No shell supervises us (dev: `bun run dev:host`, test harnesses, agent
    // sessions). Watch the stdin pipe instead: when the last writer goes away
    // the pipe closes and we stop ourselves instead of orphaning (issue #33).
    // watchStdinClose is a no-op unless fd 0 is a real pipe — `ignore`/TTY/
    // file launches have no launcher lifetime to observe and must keep
    // running. With a shell attached the kkrpc transport owns the reader, so
    // this dedicated watch runs only here (see stdin-watch.ts).
    watchStdinClose(() => {
      void stopOnStdinLoss(ctx, "launcher")
    })
  }
}

let stopping = false

// SIGTERM is Unix-only; Windows graceful shutdown goes through stdio stop RPC.
process.on("SIGTERM", () => {
  if (stopping) return
  stopping = true
  log("SIGTERM — exiting 0")
  process.exit(0)
})

process.on("SIGINT", () => process.exit(0))

try {
  await bootstrap()
} catch (err) {
  console.error("[host] fatal bootstrap error", err)
  process.exit(1)
}

await new Promise(() => {})
