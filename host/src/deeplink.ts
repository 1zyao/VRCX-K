// Host-side deep-link service (issue #41 gap ④).
//
// Ownership split, the same as `shortcut` and `tray`:
//   - the SHELL proves a URL arrived — the OS handed it to us and it comes over
//     kkrpc/stdio as `deepLink.opened`;
//   - the HOST owns what the URL MEANS (which account, which instance, …).
//
// # ⚠ Why this service had to exist at all
//
// The shell has had the forwarding path since M1 and the bridge has had `onOpen`, but
// NOTHING on this side ever subscribed. So a URL that arrived was indistinguishable from
// one that never did — that is gap ④, and it is also why the macOS real-device
// verification had to insert a temporary log line to have anything to assert on
// (`docs/probes/mac-deeplink/FINDINGS.md` §5). With this service in place, "a URL arrived"
// is observable in the product, which is what makes the acceptance criterion testable at
// all.
//
// # What is deliberately NOT here
//
// `unregister` is not a method of this service. A cordis service is readable by every
// plugin (inject is a readiness gate, not an access gate — measured, see
// `docs/cordis-runtime-findings.md`), so putting the undo here would expose it to plugins,
// which is precisely what the owner's "selective exposure" decision rules out
// (issue #41 §7.1 item 2). The face reaches the undo through `HostWsAPI.deepLink` instead,
// and the shell bounds it to the declared names.
//
// With no shell attached the service stays usable: `onUrl` registers and simply never
// fires, and inbound payloads are validated rather than guessed at.

import { type Context, Service } from "cordis"
import type { VRCXKPluginManifest } from "./contracts/pluginManifest.generated"
import { callerName, overreachWarning } from "./overreach"
import { createSecretSlot } from "./service-secret"
import type { DeepLinkEvent, ShellDeepLinkBridge } from "./stdio"

declare module "cordis" {
  interface Context {
    deepLink: DeepLinkService
  }
}

/**
 * One parsed `vrcxk://…` URL.
 *
 * `verb` and `id` are named after the shape the incumbent app proved out
 * (`vrcx://user/usr_x`, `vrcx://world/wrld_x` — see `docs/hands-prior-art.md` §2.2), which
 * is "path is the command". Parsing lives on the BRAIN side on purpose: the shell only
 * proves arrival, and a shell that interpreted URLs would have to know product semantics.
 */
export type DeepLinkTarget = {
  /** Lowercased scheme, e.g. `vrcxk`. */
  scheme: string
  /**
   * The command part: the authority when the URL has one (`vrcxk://user/usr_1` → `user`),
   * otherwise the first path segment (`vrcxk:///user/usr_1` → `user`). Empty when neither.
   */
  verb: string
  /** The id/argument part, percent-decoded. Empty when the URL has none. */
  id: string
  /** Query parameters; a repeated name keeps the last value. */
  params: Record<string, string>
  /** The URL exactly as the OS handed it over — what a handler should log or re-parse. */
  raw: string
}

export type DeepLinkHandler = (target: DeepLinkTarget, event: DeepLinkEvent) => void

export type DeepLinkServiceOptions = {
  /** Shell bridge; omit while the shell is not attached. */
  bridge?: ShellDeepLinkBridge
  log?: (line: string) => void
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Parse one custom-scheme URL into a {@link DeepLinkTarget}, or `undefined` when it is not
 * a URL at all.
 *
 * ⚠ Two shapes reach this, and both are real: `scheme://verb/id` (what a user types and
 * what VRCX's own URLs look like) parses with the verb as the URL AUTHORITY, while
 * `scheme:///verb/id` puts it in the path. Treating the first form's authority as part of
 * the id — or dropping the second entirely — would silently break one of them.
 */
export function parseDeepLink(raw: string): DeepLinkTarget | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  // `new URL` accepts anything with a scheme-ish prefix; require a scheme to be present so
  // a bare path cannot masquerade as one.
  const scheme = url.protocol.replace(/:$/, "").toLowerCase()
  if (!scheme) return undefined

  const segments = url.pathname.split("/").filter((part) => part.length > 0)
  const authority = url.hostname
  const verb = authority.length > 0 ? authority : (segments.shift() ?? "")
  const id = decodeURIComponent(segments.shift() ?? "")

  const params: Record<string, string> = {}
  for (const [name, value] of url.searchParams) {
    params[name] = value
  }
  return { scheme, verb: decodeURIComponent(verb), id, params, raw }
}

/**
 * Validate a `deepLink.opened` payload.
 *
 * A malformed payload is reported, never guessed at: inventing a URL from a half-valid
 * object would fire a handler for something the OS never delivered.
 */
export function normalizeOpened(value: unknown): DeepLinkEvent | undefined {
  if (!value || typeof value !== "object") return undefined
  const urls = (value as Partial<DeepLinkEvent>).urls
  if (!Array.isArray(urls) || urls.length === 0) return undefined
  if (!urls.every((url) => typeof url === "string" && url.length > 0)) return undefined
  return { urls: urls as string[] }
}

export type DeepLinkUnregisterOutcome =
  /** The shell removed a registration it owned. */
  | { status: "removed" }
  /** Nothing was registered under that name — asking twice is fine. */
  | { status: "absent" }
  /** This shell predates the route (or refuses to touch a foreign key). */
  | { status: "unsupported"; error: string }
  /** No shell attached: nothing was attempted. */
  | { status: "no-shell" }

/**
 * Ask the shell to undo a registration, mapping its verdict to an outcome the face can
 * branch on without knowing the wire shape.
 *
 * Exported separately from the service because the caller is `HostWsAPI.deepLink`, not
 * `ctx.deepLink` — see the header comment for why the undo is not a plugin-visible method.
 */
export async function unregisterDeclaredScheme(
  bridge: ShellDeepLinkBridge | undefined,
  scheme: unknown,
): Promise<DeepLinkUnregisterOutcome> {
  if (typeof scheme !== "string" || scheme.length === 0) {
    return { status: "unsupported", error: "scheme must be a non-empty string" }
  }
  if (!bridge?.unregister) return { status: "no-shell" }
  let result: Awaited<ReturnType<NonNullable<ShellDeepLinkBridge["unregister"]>>>
  try {
    result = await bridge.unregister(scheme)
  } catch (error) {
    // The shell refuses foreign keys and undeclared names by replying `ok:false`; a
    // rejection here means the transport failed, which must not look like a refusal.
    return { status: "unsupported", error: describe(error) }
  }
  if (!result?.ok) {
    return {
      status: "unsupported",
      error: result?.error ?? "the shell refused the removal without a reason",
    }
  }
  return result.removed ? { status: "removed" } : { status: "absent" }
}

/**
 * ⚠ Bridge and manifest lookup live in {@link createSecretSlot} slots, not in fields: a
 * `private` field is only private at compile time, and reading one off a real plugin was
 * measured to hand over the whole bridge (`service-secret.ts`).
 */
const bridgeSlot = createSecretSlot<ShellDeepLinkBridge>()
const lookupSlot = createSecretSlot<(entryId: string) => VRCXKPluginManifest | undefined>()

export class DeepLinkService extends Service {
  private detach?: () => void
  private closed = false
  private readonly logLine: (line: string) => void
  private readonly handlers = new Set<DeepLinkHandler>()

  constructor(ctx: Context, options: DeepLinkServiceOptions = {}) {
    super(ctx, "deepLink")
    if (options.bridge) this.attachShell(options.bridge)
    this.logLine = options.log ?? (() => {})
  }

  /** Give the service the manifest registry so `#24` can compare declare vs actual. */
  useManifests(lookup: (entryId: string) => VRCXKPluginManifest | undefined): void {
    lookupSlot.set(this, lookup)
  }

  /**
   * One audit line per caller-visible operation, plus the `#24` check.
   *
   * Recorded BEFORE the work, so an undeclared attempt that fails (or has no shell) is
   * still attributed — the lesson from `hands`, where only the failures were recorded and
   * an undeclared call therefore looked like a declared one.
   */
  private record(self: unknown, method: string, detail: string): void {
    const who = callerName(self) ?? "<unknown>"
    this.logLine(`[cap] ${who} -> deepLink.${method}${detail ? ` ${detail}` : ""}`)
    const warning = overreachWarning(self, `deepLink.${method}`, lookupSlot.get(this))
    if (warning) this.logLine(warning)
  }

  /**
   * Attach the shell bridge and subscribe to its URL notifications.
   *
   * Safe to call again with a new bridge (a shell restart): the previous subscription is
   * dropped first, so an activation is never fanned out twice.
   */
  attachShell(bridge: ShellDeepLinkBridge): void {
    if (this.closed) return
    this.detach?.()
    bridgeSlot.set(this, bridge)
    this.detach = bridge.onOpen((event) => this.dispatch(event))
  }

  detachShell(): void {
    this.detach?.()
    this.detach = undefined
    bridgeSlot.clear(this)
  }

  /**
   * Subscribe to inbound URLs. Returns an unsubscribe function.
   *
   * A subscription is the plugin-facing half of this capability: it lets a plugin react to
   * an activation without being able to create or destroy one.
   */
  onUrl(handler: DeepLinkHandler): () => void {
    this.record(this, "onUrl", "")
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  /** How many URL handlers are registered. Diagnostics, and what a test can assert on. */
  get subscriberCount(): number {
    return this.handlers.size
  }

  /**
   * Fan one shell notification out: validate, parse, **log**, then hand each URL to the
   * subscribers. Returns how many URLs were delivered.
   *
   * ⚠ The log line is not debug noise. It is the product's only evidence that a URL
   * arrived when no plugin is interested — before this existed, an activation that reached
   * the host left no trace anywhere (gap ④).
   */
  dispatch(event: unknown): number {
    if (this.closed) return 0
    const opened = normalizeOpened(event)
    if (!opened) {
      this.logLine(`deepLink.opened ignored (invalid payload): ${safeJson(event)}`)
      return 0
    }
    let delivered = 0
    for (const raw of opened.urls) {
      const target = parseDeepLink(raw)
      if (!target) {
        this.logLine(`deepLink.opened ignored (unparseable URL): ${raw}`)
        continue
      }
      delivered += 1
      const suffix = target.id ? `/${target.id}` : ""
      this.logLine(`deepLink.opened ${target.scheme}://${target.verb}${suffix}`)
      for (const handler of [...this.handlers]) {
        try {
          handler(target, opened)
        } catch (error) {
          // A throwing business handler must not kill the notification path.
          this.logLine(`deepLink handler error: ${describe(error)}`)
        }
      }
    }
    return delivered
  }

  /** Drop every subscription and the shell registration (host shutdown). */
  close(): void {
    this.closed = true
    this.detach?.()
    this.detach = undefined
    bridgeSlot.clear(this)
    this.handlers.clear()
  }
}
