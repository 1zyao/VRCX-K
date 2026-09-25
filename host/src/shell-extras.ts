// Desktop-only shell capabilities added with the plugin round: `ctx.autostart`.
//
// WHY THIS IS A SERVICE AND NOT A RAW MIRROR
//   It is attributable and audited through `ctx.shell` already. It exists as a
//   curated service for the same reason `ctx.notify` does: SDK templates need one
//   stable entry point, and a plugin should not reach into the raw wire namespace
//   for a routine operation.
//
// ⚠ "ATTRIBUTABLE AND AUDITED THROUGH `ctx.shell` ALREADY" WAS A FALSE COMFORT.
//   The RAW mirror (`ctx.shell.autostart.*`) records `[cap]` lines and runs the
//   `#24` declare-vs-actual check. This service, added in the same PR, did
//   NEITHER: `AutostartService` took no audit callback and never called
//   `overreachWarning`, so a plugin could flip a PERSISTENT OS startup entry
//   without declaring `autostart` and leave no trace — while the escape hatch it
//   exists to replace was checked. Two independent reviewers found this.
//   `autostart` IS declarable (`contracts/plugin-manifest/.../$defs/Permissions`
//   has an `autostart` grant), so the check has something to compare against.
//   It now has `audit` + `useManifests` and a `record()` like `HandsService`.
//
// ⚠ NOT a security boundary — declare-and-warn visibility only (`#24`). A plugin
//   that wants to write a startup entry can call the OS itself. The real boundary
//   is M4's subprocess isolation.
//
// ⚠ DESKTOP-ONLY: the shell does not register `shell.autostart.*` on mobile at
//   all, so this service must report "unsupported" rather than pretending the OS
//   refused something.
//
// NOTE ON `os` AND `clipboard`: neither lives here. OS facts were folded into the
// existing `ctx.os` service and clipboard into a `buildNode` mirror in
// `capability.ts` — both are stateless pass-throughs with no lifecycle, so a
// purpose-built `Service` subclass would add ceremony without adding a guarantee.
// `autostart` differs only in needing to distinguish "no shell" from "this
// platform has no such capability", which a plain mirror cannot express.

import { type Context, Service } from "cordis"
import type { VRCXKPluginManifest } from "./contracts/pluginManifest.generated"
import { callerName, overreachWarning } from "./overreach"
import type { ShellStdioBridge } from "./stdio"

declare module "cordis" {
  interface Context {
    autostart: AutostartService
  }
}

/** The verdict shape the capability services share: never throw, always report. */
export type AutostartVerdict =
  | { status: "ok" }
  /** The shell is not attached (`VRCXK_SHELL` unset) — nothing was attempted. */
  | { status: "no-shell" }
  /** The shell has no such route (mobile) — the capability does not exist here. */
  | { status: "unsupported" }
  | { status: "error"; error: string }

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * "Start with the system" (desktop only).
 *
 * ⚠ The shell provides the MECHANISM only — nothing enables autostart at boot.
 * Whether the app should launch with the system is a user decision, so this
 * service never turns it on by itself; the UI owns the toggle.
 */
export class AutostartService extends Service {
  private bridge?: ShellStdioBridge
  /** Manifest lookup for the `#24` check; see the file header. */
  private manifestLookup?: (entryId: string) => VRCXKPluginManifest | undefined
  private readonly auditLine: (line: string) => void

  constructor(ctx: Context, options: { audit?: (line: string) => void } = {}) {
    super(ctx, "autostart")
    this.auditLine = options.audit ?? (() => {})
  }

  /** Give the service the manifest registry so `#24` can compare declare vs actual. */
  useManifests(lookup: (entryId: string) => VRCXKPluginManifest | undefined): void {
    this.manifestLookup = lookup
  }

  /**
   * One audit line per caller-visible operation, plus the `#24` check.
   *
   * ⚠ Records BEFORE the work, so a call that fails or has no shell is still
   * attributed — an undeclared attempt must not become invisible because it
   * happened to fail. Both entry points call this; see the file header for the
   * gap this closes.
   */
  private record(self: unknown, method: string): void {
    const who = callerName(self) ?? "<unknown>"
    this.auditLine(`[cap] ${who} -> autostart.${method}`)
    const warning = overreachWarning(self, `autostart.${method}`, this.manifestLookup)
    if (warning) this.auditLine(warning)
  }

  attachShell(bridge: ShellStdioBridge): void {
    this.bridge = bridge
  }

  detachShell(): void {
    this.bridge = undefined
  }

  /**
   * Whether the OS registration exists right now.
   *
   * `false` covers "off", "no shell" AND "mobile" — the caller that wants the
   * state of a toggle cannot act differently on those, and one that needs to know
   * whether the capability exists at all asks `supported`.
   *
   * ⚠ A READ FAILURE IS NOT `false`. This used to swallow a rejection into
   * `false` as well, which silently merged "cannot tell" into "off" — and the OS
   * registration may well exist (a reviewer's point). The doc comment above
   * listed only three cases for `false`; the `catch` invented a fourth. The
   * sibling `setEnabled` already returns a VERDICT for exactly this reason, so
   * this now returns one too: callers that only need a boolean use `isEnabled`,
   * which maps the indeterminate case to `undefined` rather than lying.
   */
  async readEnabled(): Promise<boolean | undefined> {
    const api = this.bridge?.shell.autostart
    if (!api) return false
    try {
      return await api.isEnabled()
    } catch {
      return undefined
    }
  }

  /** Convenience for toggle UIs: `undefined` (unknown) collapses to `false`. */
  async isEnabled(): Promise<boolean> {
    return (await this.readEnabled()) ?? false
  }
  /** Whether this platform has the capability at all. */
  get supported(): boolean {
    return this.bridge?.shell.autostart !== undefined
  }

  get attached(): boolean {
    return this.bridge !== undefined
  }

  /** Turn autostart on or off. A verdict, not a bool. */
  async setEnabled(enabled: boolean): Promise<AutostartVerdict> {
    this.record(this, "setEnabled")
    // Distinguishing "no shell" from "mobile" matters: the first is a waiting
    // state that will resolve, the second never will, and a UI offering a toggle
    // needs to know which it is looking at.
    if (!this.bridge) return { status: "no-shell" }
    const api = this.bridge.shell.autostart
    if (!api) return { status: "unsupported" }
    try {
      const verdict = await api.setEnabled(enabled)
      return verdict.ok ? { status: "ok" } : { status: "error", error: verdict.error ?? "refused" }
    } catch (error) {
      return { status: "error", error: describe(error) }
    }
  }
}
