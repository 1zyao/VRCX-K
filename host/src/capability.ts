import { type Context, Service, symbols } from "cordis"
import type { VRCXKPluginManifest } from "./contracts/pluginManifest.generated"
import { callerEntryId, overreachWarning } from "./overreach"
import type { AppInfo, OsInfo, PathKind, ShellStdioBridge, ShellSysAPI } from "./stdio"

// Re-exported so callers that already import the caller helpers from this module
// keep working; the implementation lives in `overreach.ts`, which owns the whole
// declaration-vs-actual rule (importing the other way would be a cycle).
export { callerEntryId }

type ShellApi = ShellSysAPI["shell"]

/**
 * The raw `ctx.shell` surface: `ShellSysAPI["shell"]` key-for-key, except two
 * methods are nullable here. With no shell attached the capability returns
 * `null` instead of throwing (the "never throws" guarantee), so `app.info` and
 * `path.dir` must not claim a value is always present — otherwise the type
 * invites a plugin to dereference `null`. (`dialog.pickFile` is already
 * nullable in the wire type, so it needs no adjustment.)
 */
export type ShellCapability = Omit<ShellApi, "app" | "path"> & {
  app: Omit<ShellApi["app"], "info"> & { info(): Promise<AppInfo | null> }
  path: Omit<ShellApi["path"], "dir"> & { dir(): Promise<Record<PathKind, string> | null> }
}

export type CapabilityAudit = (line: string) => void

/**
 * Identity of the calling plugin, or null when the call cannot be attributed.
 *
 * `entry.id` is the primary key: the entry is the installable unit (it owns
 * config/inject/reload), and M2-8 builds its registry on `entry.id`.
 *
 * `fiber.name` alone is NOT an identity — it walks up the parent chain
 * (cordis/lib/index.js:789-796). An apply-only module (`export function apply`,
 * e.g. `host/plugins/heartbeat.ts`) reaches the loader as a namespace; the
 * loader's `unwrapExports` (plugin-loader rc.6:623-628) hands back a namespace
 * with no `name` property, so `runtime.name` is undefined. (The separate guard
 * at cordis/lib/index.js:1365-1366 blanks a plain function literally named
 * "apply".) Such a plugin therefore resolves to the enclosing `Include`, i.e.
 * the two-plugins-look-identical failure this surface exists to prevent.
 *
 * Under a loader, `entry` is INHERITED by plugins an entry starts
 * (`internal/plugin` sets `fiber.entry = fiber.parent[Entry.key]`,
 * plugin-loader rc.6:577-581). Appending the fiber's own `runtime.name`
 * distinguishes nested callers ONLY when that name exists — a **named function
 * expression** (`ctx.plugin(function named(inner) {...})`). An anonymous arrow
 * (`runtime.name === ""`), an object literal `{ apply() {} }`, and an apply-only
 * module namespace have no own name, so they fall back to the bare `entry.id`
 * and collapse onto their enclosing entry. `entry.id` is the prefix (and the
 * M2-8 registry key) either way. `docs/probes/probe8.ts` measures this: 6
 * entry-scoped callers yield only 4 composite identities, and only the
 * named-function shapes get a `#suffix`.
 *
 * With no entry the code falls back to `fiber.name`. The loader sets `entry`
 * from `fiber.parent[Entry.key]`, so a plugin started on the **root Context has
 * no entry even while a loader is live**. ⚠ That fallback is not a real
 * identity: an anonymous root-level plugin audits as `"root"`, exactly what a
 * genuine host call resolves to — the two are indistinguishable. Root-level
 * plugins are host-internal wiring, not installable plugins; do not rely on it.
 *
 * `entry.id` carries a per-run random prefix (plugin-loader/lib/index.js:176,
 * e.g. `4daad489:shapes`); consumers must treat the prefix as opaque and match
 * on the suffix.
 *
 * `self` is undefined when a caller destructures the method
 * (`const { notify } = ctx.shell`): there is no `this` to read the caller from,
 * so fall back to null rather than throwing.
 */
export function callerName(self: unknown): string | null {
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

/**
 * Shared, mutable handle to the shell bridge.
 *
 * It is created before any plugin loads (plugins may inject the capability
 * services during load) and the shell attaches later, so every method reads
 * `handle.shell` lazily and reports "no shell" until then.
 */
export class ShellHandle {
  bridge?: ShellStdioBridge
  /**
   * Looks up a plugin's manifest by `entry.id`, for overreach detection (#24).
   *
   * Injected rather than imported so `capability.ts` keeps no dependency on the
   * manifest registry (which is built during bootstrap and lives behind a
   * WeakMap). Absent means the check is OFF — a host with no loader (tests, the
   * shell-less dev mode) has no manifests to compare against, and must not start
   * warning about every call.
   */
  private manifestLookup?: (entryId: string) => VRCXKPluginManifest | undefined

  constructor(private readonly audit: CapabilityAudit) {}

  /** Enable overreach detection by supplying the manifest registry lookup. */
  useManifests(lookup: (entryId: string) => VRCXKPluginManifest | undefined): void {
    this.manifestLookup = lookup
  }

  attach(bridge: ShellStdioBridge): void {
    this.bridge = bridge
  }

  detach(): void {
    this.bridge = undefined
  }

  get shell(): ShellApi | undefined {
    return this.bridge?.shell
  }

  /** Transparent call record: one line per capability call, with its caller. */
  record(self: unknown, method: string, args: unknown[]): void {
    // `callerName` returns null only when attribution was lost (e.g. a
    // destructured call). Never label that as the host: a real host caller
    // resolves through the same proxy to "root", so "<host>" would actively
    // misattribute plugin behaviour instead of admitting the gap.
    const who = callerName(self) ?? "<unknown>"
    const detail = args.length > 0 ? ` ${args.map(describe).join(", ")}` : ""
    this.audit(`[cap] ${who} -> ${method}${detail}`)

    // Overreach: declared vs actual (#24). Warn only — never refuse. See
    // `overreach.ts` for why an enforcement layer cannot exist at this stage.
    //
    // ⚠ This is the RAW mirror's call site. The curated services have their own
    // audit hooks, and each of them must call `overreachWarning` too — the check
    // does not live "in `record`" for every path just because it lives in this
    // one. `ctx.hands` was unchecked for exactly that reason.
    const warning = overreachWarning(self, method, this.manifestLookup)
    if (warning) this.audit(warning)
  }
}

function describe(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value.length > 60 ? `${value.slice(0, 57)}...` : value)
  }
  if (value === null || typeof value !== "object") return String(value)
  if (Array.isArray(value)) return `[${value.length}]`
  return "{...}"
}

/**
 * A capability namespace node.
 *
 * Every node must be a cordis `Service` instance: only then does cordis wrap
 * each method with a per-caller shadow and expose `this[symbols.caller]`
 * (docs/cordis-runtime-findings.md §1.7). A plain object property would
 * silently lose the caller.
 */
class CapabilityNode extends Service {}

// `any[]` is deliberate and must stay: the curated specs below rely on
// parameter contravariance, so `unknown[]` makes every one of them fail to
// assign (`Argument of type 'unknown' is not assignable to 'string'`). The
// wrapper forwards arguments verbatim and never inspects them, so this is the
// one place where `any` buys real flexibility rather than hiding a mistake.
// biome-ignore lint/suspicious/noExplicitAny: contravariance needs `any`, see above
type CapabilityMethod = (shell: ShellApi | undefined, ...args: any[]) => unknown
type CapabilitySpec = { [key: string]: CapabilityMethod | CapabilitySpec }

/**
 * Compile-time guard for the raw mirror: every `ShellApi` key must be present.
 * `CapabilitySpec` is an index signature, so without this a deleted mirror entry
 * compiles fine while the `ctx.shell` declaration still advertises it — the
 * plugin gets `is not a function` at runtime. (Nested namespaces are pinned by
 * the key-completeness test in capability.test.ts.)
 */
type RawShellSpec = { [K in keyof ShellApi]: CapabilitySpec[string] }

function buildNode(
  ctx: Context,
  name: string,
  handle: ShellHandle,
  spec: CapabilitySpec,
): CapabilityNode {
  const node = new CapabilityNode(ctx, name)
  for (const [key, entry] of Object.entries(spec)) {
    if (typeof entry === "function") {
      const method = entry
      // A normal function (NOT an arrow) so cordis's shadow rewrite can hand it
      // the calling plugin's context; the arrow form would drop attribution.
      Object.defineProperty(node, key, {
        configurable: true,
        value: function (this: unknown, ...args: unknown[]) {
          handle.record(this, `${name}.${key}`, args)
          return method(handle.shell, ...args)
        },
      })
    } else {
      Object.defineProperty(node, key, {
        configurable: true,
        value: buildNode(ctx, `${name}.${key}`, handle, entry),
      })
    }
  }
  return node
}

const DIALOG_SPEC: CapabilitySpec = {
  message: (s, text, opts) => (s ? s.dialog.message(text, opts) : Promise.resolve(false)),
  ask: (s, text, opts) => (s ? s.dialog.ask(text, opts) : Promise.resolve("")),
  pickFile: (s, opts) => (s ? s.dialog.pickFile(opts) : Promise.resolve(null)),
}

const WINDOW_SPEC: CapabilitySpec = {
  show: (s) => (s ? s.window.show() : Promise.resolve(false)),
  hide: (s) => (s ? s.window.hide() : Promise.resolve(false)),
  minimize: (s) => (s ? s.window.minimize() : Promise.resolve(false)),
  maximize: (s) => (s ? s.window.maximize() : Promise.resolve(false)),
  unmaximize: (s) => (s ? s.window.unmaximize() : Promise.resolve(false)),
  focus: (s) => (s ? s.window.focus() : Promise.resolve(false)),
  close: (s) => (s ? s.window.close() : Promise.resolve(false)),
}

const NOTIFY_SPEC: CapabilitySpec = {
  send: (s, title, body) => (s ? s.notify(title, body) : Promise.resolve(false)),
}

const OS_SPEC: CapabilitySpec = {
  openUrl: (s, url) => (s ? s.openUrl(url) : Promise.resolve(false)),
  openPath: (s, path) => (s ? s.openPath(path) : Promise.resolve(false)),
  reveal: (s, path) => (s ? s.reveal(path) : Promise.resolve(false)),
  appInfo: (s) => (s ? s.app.info() : Promise.resolve(null)),
  appExit: (s, code) => (s ? s.app.exit(code) : Promise.resolve(false)),
  pathDir: (s) => (s ? s.path.dir() : Promise.resolve(null)),
  pathResolve: (s, kind) => (s ? s.path.resolve(kind) : Promise.resolve("")),
  // Cross-platform OS facts (platform/arch/version/family/locale/hostname).
  // Added to `ctx.os` rather than a new service because `#17` already designated
  // `ctx.os` as the low-risk misc bucket, and a second service named for the OS
  // would be a genuine ambiguity for plugin authors.
  platformInfo: (s) => (s ? s.os.info() : Promise.resolve(null)),
}

const CLIPBOARD_SPEC: CapabilitySpec = {
  writeText: (s, text) => (s ? s.clipboard.writeText(text) : Promise.resolve(false)),
  readText: (s) => (s ? s.clipboard.readText() : Promise.resolve(null)),
}

/**
 * Raw escape hatch: mirrors the shell API one-for-one. Kept deliberately thin
 * so a plugin is never blocked on the host adding a curated method — but every
 * call is audited, and the curated services below are what SDK templates use.
 *
 * `tray.setSnapshot` and `shortcut.*` are included for completeness, but they
 * bypass the bookkeeping of the `ctx.tray` / `ctx.shortcut` services: a raw
 * tray snapshot leaves `TrayService`'s fingerprint cache describing a menu the
 * shell no longer shows, and a raw shortcut registration leaves
 * `ShortcutService.bindings` empty so presses are dropped as unbound. Those two
 * services are the supported entry points; treat the raw forms as last resort.
 */
const RAW_SHELL: RawShellSpec = {
  notify: (s, title, body) => (s ? s.notify(title, body) : Promise.resolve(false)),
  openUrl: (s, url) => (s ? s.openUrl(url) : Promise.resolve(false)),
  openPath: (s, path) => (s ? s.openPath(path) : Promise.resolve(false)),
  reveal: (s, path) => (s ? s.reveal(path) : Promise.resolve(false)),
  dialog: DIALOG_SPEC,
  window: WINDOW_SPEC,
  shortcut: {
    register: (s, accelerator) =>
      s ? s.shortcut.register(accelerator) : Promise.resolve({ ok: false, error: "no-shell" }),
    unregister: (s, accelerator) =>
      s ? s.shortcut.unregister(accelerator) : Promise.resolve({ ok: false, error: "no-shell" }),
    isRegistered: (s, accelerator) =>
      s ? s.shortcut.isRegistered(accelerator) : Promise.resolve(false),
  },
  app: {
    info: (s) => (s ? s.app.info() : Promise.resolve(null)),
    exit: (s, code) => (s ? s.app.exit(code) : Promise.resolve(false)),
  },
  path: {
    dir: (s) => (s ? s.path.dir() : Promise.resolve(null)),
    resolve: (s, kind) => (s ? s.path.resolve(kind) : Promise.resolve("")),
  },
  devWatchEvent: (s, event) => (s ? s.devWatchEvent(event) : Promise.resolve(false)),
  clipboard: CLIPBOARD_SPEC,
  // OS facts live at `shell.os.info` but the curated surface is `ctx.os.platformInfo`
  // (see OS_SPEC). The raw mirror still has to cover the key — the compile-time
  // guard in `RawShellSpec` exists precisely to catch a key that is on the wire but
  // unreachable through the mirror.
  os: {
    info: (s) => (s ? s.os.info() : Promise.resolve(null)),
  },
  // Desktop-only routes. `?? ` guards because the shell does not register them on
  // mobile at all: a raw mirror that assumed their presence would throw a
  // TypeError there instead of reporting "unsupported".
  autostart: {
    isEnabled: (s) => (s?.autostart ? s.autostart.isEnabled() : Promise.resolve(false)),
    setEnabled: (s, enabled) =>
      s?.autostart
        ? s.autostart.setEnabled(enabled)
        : Promise.resolve({ ok: false, error: "unsupported" }),
  },
  deepLink: {
    // ⚠ NO `register`. Removed alongside the curated form (see
    // `DeepLinkCapability`) because the raw mirror is the OTHER way to reach the
    // same shell route — leaving it here would make the narrowing theatre: a
    // plugin would still be one property access away from a persistent registry
    // write it cannot undo. Both layers move together or neither does.
    isRegistered: (s, scheme) =>
      s?.deepLink ? s.deepLink.isRegistered(scheme) : Promise.resolve(false),
  },
  tray: {
    setSnapshot: (s, snapshot) =>
      s
        ? s.tray.setSnapshot(snapshot)
        : Promise.resolve({ ok: false, revision: 0, error: "no-shell" }),
  },
}

export type NotifyCapability = {
  send(title: string, body: string): Promise<boolean>
}

export type OsCapability = {
  openUrl(url: string): Promise<boolean>
  openPath(path: string): Promise<boolean>
  reveal(path: string): Promise<boolean>
  appInfo(): Promise<AppInfo | null>
  appExit(code?: number): Promise<boolean>
  pathDir(): Promise<Record<PathKind, string> | null>
  pathResolve(kind: PathKind): Promise<string>
  /**
   * Cross-platform OS facts (platform/arch/version/family/locale/hostname), or
   * `null` with no shell. This is "which machine am I on" — the multi-device
   * direction (#13) needs it, and it is the cheapest source for platform-
   * conditional behaviour.
   */
  platformInfo(): Promise<OsInfo | null>
}

/** Text-only clipboard access. */
export type ClipboardCapability = {
  writeText(text: string): Promise<boolean>
  /** `null` when there is nothing to read, or no shell. */
  readText(): Promise<string | null>
}

/**
 * "Start with the system" (desktop only).
 *
 * ⚠ Mechanism only: nothing here enables autostart by itself, because whether the
 * app launches with the system is the user's decision.
 */
export type AutostartCapability = {
  isEnabled(): Promise<boolean>
  setEnabled(enabled: boolean): Promise<{ ok: boolean; error?: string }>
}

/**
 * Custom URL schemes (desktop only — the shell registers no such route on mobile).
 *
 * ⚠ `register` IS DELIBERATELY ABSENT. It writes
 * `HKCU\Software\Classes\<scheme>` and there is no unregister route, so a single
 * call makes a PERSISTENT, machine-wide change that this application cannot undo
 * — and `HKCU` outranks `HKLM`, so claiming a class that already exists (measured
 * with `exefile`) would redirect every `.exe` on the machine to this app.
 *
 * ⚠ It is also the wrong half to expose FIRST. The event path is not wired: the
 * shell calls `deepLink.opened` for inbound URLs, but `tauri.conf.json` declares no
 * `schemes`, so upstream stops before emitting and nothing ever arrives. Exposing
 * `register` therefore buys the SIDE EFFECT with none of the FEATURE. Wiring the
 * four missing pieces (unregister route, `schemes` config, uninstall cleanup, and
 * a consumer for `opened`) is tracked separately; until then `isRegistered` stays
 * because reading the current state is harmless and useful for diagnosis.
 *
 * The shell-side route still exists and is still validated; it is simply not
 * reachable from a plugin. See `shell_sys.rs` for the validation and the note on
 * why `HKCU` collisions matter.
 */
export type DeepLinkCapability = {
  isRegistered(scheme: string): Promise<boolean>
}

/**
 * Register the capability services on `ctx`.
 *
 * Two layers, both attributable: the raw `ctx.shell` mirror and the curated
 * `ctx.notify`/`ctx.dialog`/`ctx.window`/`ctx.os` domain services. Must run
 * before plugins load (they may inject these).
 *
 * `ctx.hands` is NOT built here: it is a `Service` subclass with its own state
 * (a shell attachment and per-stream lifecycle guards), so `host/src/index.ts`
 * constructs it the way it constructs `TrayService`/`ShortcutService`. The raw
 * `hands.*` wire mirror is reachable through `ctx.shell.hands` for the escape-
 * hatch path, but the curated service is the supported entry point — only it
 * binds a stream's life to its caller.
 */
export function createShellCapabilities(ctx: Context, handle: ShellHandle): void {
  buildNode(ctx, "shell", handle, RAW_SHELL)
  buildNode(ctx, "notify", handle, NOTIFY_SPEC)
  buildNode(ctx, "dialog", handle, DIALOG_SPEC)
  buildNode(ctx, "window", handle, WINDOW_SPEC)
  buildNode(ctx, "os", handle, OS_SPEC)
  buildNode(ctx, "clipboard", handle, CLIPBOARD_SPEC)
}

declare module "cordis" {
  interface Context {
    /**
     * Raw shell surface (M2-1). `ShellSysAPI["shell"]` key-for-key (see
     * `ShellCapability` for the two nullable methods); every call is audited
     * with the calling plugin. Prefer the curated services below, which exist so
     * SDK templates have one stable, typed entry point.
     */
    shell: ShellCapability
    notify: NotifyCapability
    dialog: ShellSysAPI["shell"]["dialog"]
    window: ShellSysAPI["shell"]["window"]
    os: OsCapability
    clipboard: ClipboardCapability
  }
}
