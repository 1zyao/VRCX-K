// Overreach detection (#24 / M2-8): compare what a plugin DECLARED against what
// it actually CALLS, and warn when the call was never declared.
//
// WHAT THIS IS, AND WHAT IT IS NOT (read this before extending it)
//   It is **declare-and-warn**. It is NOT an enforcement layer, and it must never
//   become one here:
//     - There is no "subject" to authorise against yet. The only actor today is
//       "whichever local frontend happens to be connected", so a hard refusal
//       would be guessing. The enforcement layer is #13 (session identity +
//       tiered authorisation).
//     - Plugins are IN-PROCESS (T0/T1), so a plugin that wants the clipboard can
//       `import` a module and bypass this entirely. The real boundary is M4's
//       subprocess isolation. Claiming otherwise would be a false guarantee.
//   What it DOES buy: accidental misuse and undeclared access become VISIBLE
//   instead of silent, which is `#24`'s stated honest scope.
//
// THE TWO PATHS THAT MUST BOTH BE COVERED (#24 §2)
//   1. the curated services (`ctx.notify`, `ctx.dialog`, …) — attribution is
//      natural because they are `Service`s;
//   2. the raw `ctx.shell.*` escape hatch — this needed M2-1's transparent call
//      record first, which is why the audit hook exists at all.
//
// ⚠ AN EARLIER VERSION OF THIS COMMENT WAS FALSE, and the code matched the
//   comment rather than the requirement: it claimed "both funnel through
//   `ShellHandle.record`". Only path 2 does. `ctx.hands` is a `Service` with its
//   OWN audit line (`hands.ts`'s `record`), so the check lived in
//   `ShellHandle.record` alone and **the supported entry point went unchecked
//   while the escape hatch was checked** — the exact inversion `#24` exists to
//   prevent.
//
//   Both call sites now go through `overreachWarning` below, so the rule has one
//   implementation.
//
//   ⚠ That is a STATEMENT ABOUT THOSE TWO CALL SITES, NOT A GUARANTEE. An earlier
//   version of this comment claimed "a new service cannot silently opt out of
//   it" — which was false the moment it was written: the SAME PR added
//   `ctx.autostart`, and `ctx.tray` / `ctx.shortcut` were already there, none of
//   which call this function. Two independent reviewers read that sentence and
//   were briefly misled by it (one went looking for an identifier,
//   `overreachVerdict`, that does not exist).
//
//   There is no compile-time or runtime enforcement: a new curated service is
//   checked ONLY if its author calls `overreachWarning` from its own `record`.
//   The real constraint is the checklist in `capability.ts`'s `record` comment
//   and the `overreach.test.ts` case that enumerates the covered entry points —
//   consult those when adding a service, and do not describe this as automatic.
//
// ⚠ WHY THE CHECK KEYS ON `entry.id` AND NOT ON `callerName`
//   `callerName` decorates the id with a `#runtimeName` suffix for humans. The
//   manifest registry is indexed by the RAW `entry.id`. Feeding the decorated
//   name to the lookup would miss every manifest and the check would silently
//   never fire — a warn that never warns is worse than no warn, because it reads
//   as "nobody overreached".

import { symbols } from "cordis"
import type { Permissions, VRCXKPluginManifest } from "./contracts/pluginManifest.generated"

/**
 * The calling entry's id, or `undefined` when the caller has no entry.
 *
 * Lives here rather than in `capability.ts` so this module owns the whole
 * declaration-vs-actual rule and `capability.ts` can import from it. (The reverse
 * direction would be a cycle.)
 *
 * `callerName` is for HUMANS (it appends a `#runtimeName` suffix); this is for
 * LOOKUPS. Overreach checking needs the RAW `entry.id`, because that is the key
 * the manifest registry is indexed by — feeding it a decorated name would miss
 * every manifest and the check would silently never fire.
 *
 * `undefined` means a bare `ctx.plugin()` with no loader entry. That case is
 * host-internal and must NOT be reported as over-privilege: a plugin without an
 * entry has no manifest to violate.
 */
export function callerEntryId(self: unknown): string | undefined {
  if (self == null) return undefined
  const caller = (self as Record<PropertyKey, unknown>)[symbols.caller] as
    | { fiber?: { entry?: { id?: string } } }
    | undefined
  return caller?.fiber?.entry?.id
}

/**
 * The calling plugin as a HUMAN-readable name, for `[cap]` audit lines.
 *
 * ⚠ Did NOT live here until now — it was a private function in `hands.ts`,
 * duplicated there "to keep this module free of a cycle with `capability.ts`".
 * That reasoning was about `capability.ts`, not about THIS module, and the copy
 * meant every other curated service that wanted an audit line had to either
 * duplicate it again or go without. `ctx.autostart` / `ctx.shortcut` went
 * without: they had no caller attribution at all, which is how an undeclared
 * call became indistinguishable from a declared one (both reviewers found it).
 * One definition here lets a service add attribution without a second copy.
 *
 * The `#runtimeName` suffix is deliberate and is for humans only — anything that
 * needs to LOOK SOMETHING UP must use `callerEntryId` above, because the
 * manifest registry is keyed by the raw `entry.id`.
 *
 * `null` means "no caller could be resolved", which callers render as
 * `<unknown>`; it is not an error.
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

/** How a declaration was written: `true` (whole domain) or a narrow list. */
type Grant = boolean | readonly string[] | undefined

/**
 * The capability a `hands.*` / `clipboard.*` / … method belongs to.
 *
 * Derived from the method path so both entry points (curated service and raw
 * mirror) resolve to the SAME capability key — the manifest grants capabilities,
 * not method names.
 */
export function capabilityOf(method: string): string | undefined {
  // `method` is the `<namespace>.<name>` string the audit hook already builds.
  const namespace = method.split(".")[0]
  if (!namespace) return undefined
  // The curated services ARE the capability keys (`notify`, `dialog`, `window`,
  // `os`, `tray`, `shortcut`, `hands`, `clipboard`, `autostart`).
  return namespace
}

/**
 * Is `method` covered by the declaration for `capability`?
 *
 * Three outcomes, and the third is the point:
 *   - `"granted"`   — declared, so nothing to report;
 *   - `"undeclared"` — the manifest did not mention this capability at all;
 *   - `"out-of-scope"` — the manifest declared the capability NARROWLY and this
 *     specific entry is not in the list (e.g. `hands: ["stat"]` then calling
 *     `write`). The two are reported differently because the fix differs: add the
 *     capability, or widen the list.
 */
export function checkGrant(
  grant: Grant,
  capability: string,
  method: string,
): "granted" | "undeclared" | "out-of-scope" {
  if (grant === undefined) return "undeclared"
  if (grant === true) return "granted"
  if (grant === false) return "out-of-scope"
  if (!Array.isArray(grant)) return "undeclared"

  // The declaration may name either the capability's sub-entry (`read` for
  // `hands.read`) or the raw shell sub-domain (`notify` for `shell.notify`).
  const leaf = method.split(".").slice(1).join(".")
  if (grant.includes(leaf) || grant.includes(method)) return "granted"
  // A bare capability name in the list also counts as a grant of that capability.
  if (grant.includes(capability)) return "granted"
  return "out-of-scope"
}

/**
 * The raw `ctx.shell.*` mirror needs its own mapping.
 *
 * `ctx.shell` is granted at SUB-DOMAIN granularity (method-level narrowing is not
 * implementable for it — `#24`/`#17`), so a raw call maps to its second segment:
 * `shell.window.show` → `window`, `shell.notify` → `notify`. And because the raw
 * mirror can reach domains the curated services also cover, a plugin may declare
 * EITHER `shell: ["window"]` or `window: true` — both must satisfy it.
 */
export function rawShellSubdomain(method: string): string | undefined {
  const parts = method.split(".")
  if (parts[0] !== "shell" || parts.length < 2) return undefined
  return parts[1]
}

export type OverreachFinding = {
  entryId: string
  method: string
  capability: string
  reason: "undeclared" | "out-of-scope"
}

/**
 * Decide whether one call is over-privileged.
 *
 * Returns `undefined` when the call is fine OR when no judgement is possible:
 *   - no entry id (bare `ctx.plugin()`) → host-internal, has no manifest to
 *     violate. `#24` is explicit that this must not be reported as overreach;
 *   - no manifest registered → nothing was declared, but also nothing was
 *     promised. Reported as `undeclared` ONLY when a manifest exists, because
 *     warning about a plugin that never shipped a manifest would be noise that
 *     trains people to ignore the warn.
 */
export function findOverreach(
  entryId: string | undefined,
  method: string,
  manifest: VRCXKPluginManifest | undefined,
): OverreachFinding | undefined {
  if (!entryId) return undefined
  if (!manifest) return undefined

  const permissions: Permissions | undefined = manifest.permissions
  const capability = capabilityOf(method)
  if (!capability) return undefined

  // A raw `ctx.shell.<sub>.*` call may be granted either as `shell: ["<sub>"]`
  // or as the sub-domain's own capability (`window: true`). Check both, because
  // the manifest contract allows either spelling and a plugin should not be
  // warned for choosing the one the docs recommend.
  const viaShell = method.startsWith("shell.")
  const shellSub = rawShellSubdomain(method)
  if (viaShell && shellSub) {
    const shellGrant = (permissions as Record<string, Grant> | undefined)?.shell
    if (checkGrant(shellGrant, "shell", `shell.${shellSub}`) === "granted") return undefined
    const ownGrant = (permissions as Record<string, Grant> | undefined)?.[shellSub]
    if (checkGrant(ownGrant, shellSub, method) === "granted") return undefined
    // Report against whichever spelling the manifest actually used, so the
    // message points at something the author can edit.
    //
    // ⚠ `target` must be the GRANT's key, not the call's sub-domain. Reporting
    // the sub-domain named a capability the author never declared: with
    // `shell: ["notify"]` and a call to `shell.window.show`, the old code said
    // "it declares `window` but not this entry" — and `window` appears nowhere in
    // that manifest. An author following that advice would add `window` instead
    // of widening `shell`, which is exactly the wrong edit this comment exists to
    // prevent. (`shell` is what `checkGrant` is asked about below, so the two
    // arguments now agree.)
    const viaShellGrant = shellGrant !== undefined
    const target = viaShellGrant ? "shell" : shellSub
    const grant = viaShellGrant ? shellGrant : ownGrant
    const verdict = checkGrant(grant, target, method)
    return {
      entryId,
      method,
      capability: target,
      reason: verdict === "undeclared" ? "undeclared" : "out-of-scope",
    }
  }

  const grant = (permissions as Record<string, Grant> | undefined)?.[capability]
  const verdict = checkGrant(grant, capability, method)
  if (verdict === "granted") return undefined
  return {
    entryId,
    method,
    capability,
    reason: verdict === "undeclared" ? "undeclared" : "out-of-scope",
  }
}

/** One line, phrased so the reader can act without opening the source. */
export function formatOverreach(finding: OverreachFinding): string {
  const advice =
    finding.reason === "undeclared"
      ? `it does not declare \`${finding.capability}\``
      : `it declares \`${finding.capability}\` but not this entry`
  return (
    `[cap-warn] overreach: ${callerLabel(finding.entryId)} called ${finding.method} but ${advice}. ` +
    `Declaration only (not enforced) — see #24 and docs/cordis-runtime-findings.md §1.9`
  )
}

/**
 * Display form for an entry id.
 *
 * The prefix is per-run random (`plugin-loader/lib/index.js:176`), so it is
 * noise in a log line; the suffix is the stable part humans and the registry key
 * on.
 */
export function callerLabel(entryId: string): string {
  const index = entryId.lastIndexOf(":")
  return index === -1 ? entryId : entryId.slice(index + 1)
}

/**
 * The ONE place a capability call is checked against a manifest.
 *
 * Both entry points call this — `ShellHandle.record` for the raw mirror and
 * `HandsService.record` for the curated `ctx.hands` service — so the rule has a
 * single implementation. Before this existed the check lived only in
 * `ShellHandle.record`, and `ctx.hands` (the SUPPORTED entry point) went
 * unchecked while the escape hatch was checked.
 *
 * Returns the warn line to log, or `undefined` when there is nothing to report.
 * Taking the lookup as an argument keeps this free of any registry/context
 * dependency, so both callers can pass whatever they hold.
 *
 * ⚠ Still declare-and-warn only. See the header.
 */
export function overreachWarning(
  self: unknown,
  method: string,
  lookup: ((entryId: string) => VRCXKPluginManifest | undefined) | undefined,
): string | undefined {
  // No lookup means "manifests are not loaded yet" (or a shell-less/test host),
  // NOT "this plugin is undeclared". Warning here would fire on every call in
  // every test that wires a service without the registry.
  if (!lookup) return undefined
  const entryId = callerEntryId(self)
  // No entry (a bare `ctx.plugin()`) or no registered manifest means there is
  // nothing to violate: `#24` calls the first case out by name, and the second is
  // a plugin that never shipped a manifest. Accusing either would be noise.
  if (!entryId) return undefined
  const finding = findOverreach(entryId, method, lookup(entryId))
  return finding ? formatOverreach(finding) : undefined
}
