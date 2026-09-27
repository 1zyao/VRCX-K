/**
 * The capability inventory — ONE list, derived from what the host actually
 * provides, so a plugin's declaration can be checked against reality.
 *
 * WHY THIS EXISTS
 *   Two separate things were drifting towards their own private copies of the
 *   same list:
 *
 *     1. the manifest contract, whose `permissions` object enumerates the
 *        capability keys a plugin may request, and
 *     2. the runtime, where those capabilities are created across
 *        `capability.ts` (shell + four curated services), `tray.ts`, `shortcut.ts`
 *        and `index.ts` (signal).
 *
 *   A schema enum that is a hand-written copy of a runtime list will eventually
 *   disagree with it — at which point a plugin cannot request a capability that
 *   exists, or can request one that does not. That is the same "second source of
 *   truth" failure this project keeps removing, so the list lives here and both
 *   sides reference it.
 *
 *   The `permissions` contract test asserts every key below is still present in
 *   the schema, and `capability-surfaces.test.ts` asserts every key is really
 *   provided at runtime. Add a capability here only when the host provides it.
 */

/** Curated domain services and raw escape hatches the host provides. */
export const HOST_SERVICES = [
  "shell",
  "notify",
  "dialog",
  "window",
  "os",
  "tray",
  "shortcut",
  "signal",
  "hands",
  "clipboard",
  "autostart",
] as const
export type HostService = (typeof HOST_SERVICES)[number]

/**
 * The subset of `HOST_SERVICES` a manifest may declare under `permissions`.
 *
 * `signal` is absent on purpose: it is a lifecycle mechanism the host provides
 * for cooperative shutdown, not a privileged capability, so requesting it is
 * meaningless. Everything else is requestable.
 */
export const REQUESTABLE_CAPABILITIES = [
  "shell",
  "notify",
  "dialog",
  "window",
  "os",
  "tray",
  "shortcut",
  "hands",
  "clipboard",
  "autostart",
] as const satisfies readonly HostService[]
export type RequestableCapability = (typeof REQUESTABLE_CAPABILITIES)[number]

/**
 * The file primitives `hands` can be granted at, one entry per primitive.
 *
 * Primitive granularity (not a single boolean, not a path scope). `hands` is a
 * sharper permission than `ctx.shell` — it reaches the whole disk — so a plugin
 * should be able to say "read and stat, never write". Path-scoped grants are
 * deliberately NOT modelled yet: they need a matcher both sides honour, and the
 * enforcement layer is `#13`/M4, not this stage.
 *
 * Must stay in sync with `HandsService`'s methods in `host/src/hands.ts`; the
 * inventory tests pin that.
 *
 * ⚠ `list` is a primitive, not caller policy. An earlier revision omitted it on
 * the reasoning that enumeration belongs to the brain — which assumes the brain
 * can reach the filesystem. For a REMOTE shell it cannot, so without `list` a
 * plugin cannot discover a single filename.
 */
export const HANDS_PRIMITIVES = ["stat", "read", "write", "watch", "list"] as const
export type HandsPrimitive = (typeof HANDS_PRIMITIVES)[number]

/**
 * Sub-domains of the raw `ctx.shell` mirror.
 *
 * `ctx.shell` is the escape hatch that mirrors the shell API one-for-one, and it
 * can only be granted at this granularity — per-method narrowing is not
 * implementable for it. Must stay in sync with `RAW_SHELL` in `capability.ts`;
 * a test pins that.
 */
export const SHELL_SUBDOMAINS = [
  "notify",
  "openUrl",
  "openPath",
  "reveal",
  "dialog",
  "window",
  "shortcut",
  "app",
  "path",
  "devWatchEvent",
  "tray",
  "clipboard",
  "os",
  "autostart",
  "deepLink",
] as const
export type ShellSubdomain = (typeof SHELL_SUBDOMAINS)[number]

export function isHostService(value: string): value is HostService {
  return (HOST_SERVICES as readonly string[]).includes(value)
}

export function isRequestableCapability(value: string): value is RequestableCapability {
  return (REQUESTABLE_CAPABILITIES as readonly string[]).includes(value)
}
