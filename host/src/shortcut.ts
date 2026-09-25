// Host-side global shortcut service (issue #6 callback path).
//
// Ownership split:
//   - the SHELL (Rust) owns OS registration, canonicalises the chord, filters
//     to registered chords and key-down edges, and reports each press over
//     kkrpc/stdio (`shortcut.pressed`);
//   - the HOST (brain) owns the MEANING: which chord runs which handler, and
//     what that handler should do.
//
// Chord identity is NEVER re-parsed here. `register` stores the binding under
// the canonical string the shell returned (`shift+control+KeyK`) and a press is
// matched against that exact string. A second parser on this side would be a
// silent failure mode: the two could disagree per platform and a registered
// chord would simply stop firing with nothing in the logs.
//
// With no shell attached (`VRCXK_SHELL` unset) the service stays usable: a
// `register` returns `no-shell` instead of throwing, and presses are simply
// never delivered.

import { type Context, Service } from "cordis"
import type { VRCXKPluginManifest } from "./contracts/pluginManifest.generated"
import { callerName, overreachWarning } from "./overreach"
import type { ShellShortcutBridge, ShortcutPressEvent, ShortcutRegistration } from "./stdio"

declare module "cordis" {
  interface Context {
    shortcut: ShortcutService
  }
}

export type ShortcutHandler = (event: ShortcutPressEvent) => void

export type ShortcutRegisterResult =
  /** The shell accepted and canonicalised the chord. */
  | { status: "registered"; accelerator: string }
  /** The shell refused it (bad syntax, or the OS already owns the chord). */
  | { status: "rejected"; error: string }
  /** No shell attached: nothing was registered. */
  | { status: "no-shell" }

export type ShortcutServiceOptions = {
  /** Shell bridge; omit while the shell is not attached. */
  bridge?: ShellShortcutBridge
  log?: (line: string) => void
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Validate a shell `shortcut.pressed` payload.
 *
 * A malformed payload is reported, not guessed at: inventing an accelerator
 * from a half-valid object would fire an unrelated handler.
 */
export function normalizePress(value: unknown): ShortcutPressEvent | undefined {
  if (!value || typeof value !== "object") return undefined
  const candidate = value as Partial<ShortcutPressEvent>
  if (typeof candidate.accelerator !== "string" || candidate.accelerator.length === 0) {
    return undefined
  }
  // The shell sends a Rust `u32`: a fractional, negative or non-finite id is a
  // contract violation, not something to coerce into a handler lookup.
  if (typeof candidate.id !== "number" || !Number.isInteger(candidate.id) || candidate.id < 0) {
    return undefined
  }
  return { accelerator: candidate.accelerator, id: candidate.id }
}

export class ShortcutService extends Service {
  private bridge?: ShellShortcutBridge
  private detach?: () => void
  private closed = false
  private readonly logLine: (line: string) => void
  /**
   * Manifest lookup for the `#24` declare-vs-actual check.
   *
   * ⚠ This service used to have NO caller attribution and NO overreach check on
   * its normal path — `logLine` calls below are DIAGNOSTICS (invalid payloads,
   * handler errors) and never name the caller. So a plugin could register a
   * global hotkey without declaring `shortcut`, and nothing recorded it, while
   * the raw `ctx.shell.shortcut.*` mirror DID both. That is the same inversion
   * `overreach.ts` documents for `ctx.hands`; see the call to
   * `overreachWarning` in `record`.
   */
  private manifestLookup?: (entryId: string) => VRCXKPluginManifest | undefined
  /** Bindings keyed by the shell's canonical accelerator. */
  private readonly bindings = new Map<string, ShortcutHandler>()

  constructor(ctx: Context, options: ShortcutServiceOptions = {}) {
    super(ctx, "shortcut")
    this.bridge = options.bridge
    this.logLine = options.log ?? (() => {})
  }

  /** Give the service the manifest registry so `#24` can compare declare vs actual. */
  useManifests(lookup: (entryId: string) => VRCXKPluginManifest | undefined): void {
    this.manifestLookup = lookup
  }

  /**
   * One audit line per caller-visible operation, plus the `#24` check.
   *
   * Called from `register`/`unregister` — the two entry points a plugin reaches
   * through `ctx.shortcut`. Recording only the failures (as the old diagnostics
   * did) is what made an undeclared call indistinguishable from a declared one.
   */
  private record(self: unknown, method: string, detail: string): void {
    const who = callerName(self) ?? "<unknown>"
    this.logLine(`[cap] ${who} -> shortcut.${method}${detail ? ` ${detail}` : ""}`)
    const warning = overreachWarning(self, `shortcut.${method}`, this.manifestLookup)
    if (warning) this.logLine(warning)
  }

  /**
   * Attach the shell bridge and subscribe to its press notifications.
   *
   * Safe to call again with a new bridge (a shell restart): the previous
   * subscription is dropped first, so presses are never fanned out twice.
   */
  attachShell(bridge: ShellShortcutBridge): void {
    if (this.closed) return
    this.detach?.()
    this.bridge = bridge
    this.detach = bridge.onPress((event) => this.dispatchPress(event))
  }

  detachShell(): void {
    this.detach?.()
    this.detach = undefined
    this.bridge = undefined
  }

  /** Register a chord and bind a handler to it. */
  async register(accelerator: string, handler: ShortcutHandler): Promise<ShortcutRegisterResult> {
    // Record BEFORE the work, so a call that fails (or has no shell) is still
    // attributed — an undeclared attempt must not become invisible just because
    // it did not succeed.
    this.record(this, "register", accelerator)
    const bridge = this.bridge
    if (this.closed || !bridge) return { status: "no-shell" }
    let registration: ShortcutRegistration
    try {
      registration = await bridge.register(accelerator)
    } catch (error) {
      return { status: "rejected", error: describe(error) }
    }
    if (!registration?.ok || !registration.accelerator) {
      return {
        status: "rejected",
        error: registration?.error ?? "shell refused the accelerator without a reason",
      }
    }
    // Bind under the SHELL's canonical spelling, never the caller's input.
    this.bindings.set(registration.accelerator, handler)
    return { status: "registered", accelerator: registration.accelerator }
  }

  /** Release a chord and drop its handler. */
  async unregister(accelerator: string): Promise<ShortcutRegisterResult> {
    this.record(this, "unregister", accelerator)
    const bridge = this.bridge
    if (this.closed || !bridge) return { status: "no-shell" }
    let registration: ShortcutRegistration
    try {
      registration = await bridge.unregister(accelerator)
    } catch (error) {
      return { status: "rejected", error: describe(error) }
    }
    if (!registration?.ok) {
      return {
        status: "rejected",
        error: registration?.error ?? "shell refused to unregister without a reason",
      }
    }
    // Key the removal the same way registration keyed the binding.
    this.bindings.delete(registration.accelerator ?? accelerator)
    return {
      status: "registered",
      accelerator: registration.accelerator ?? accelerator,
    }
  }

  /** Canonical accelerators currently bound to a handler. */
  get bound(): string[] {
    return [...this.bindings.keys()].sort()
  }

  /**
   * Fan one shell press out to the handler bound to that chord.
   *
   * Returns whether a handler ran. An unbound chord is not an error — the shell
   * may hold registrations this service never made — but it IS logged, because
   * a silent no-op is indistinguishable from a broken callback.
   */
  dispatchPress(press: unknown): boolean {
    if (this.closed) return false
    const event = normalizePress(press)
    if (!event) {
      this.logLine(`shortcut.pressed ignored (invalid payload): ${safeJson(press)}`)
      return false
    }
    const handler = this.bindings.get(event.accelerator)
    if (!handler) {
      this.logLine(`shortcut.pressed for unbound chord: ${event.accelerator}`)
      return false
    }
    try {
      handler(event)
    } catch (error) {
      // A throwing business handler must not kill the notification path.
      this.logLine(`shortcut.pressed handler error: ${describe(error)}`)
    }
    return true
  }

  /** Drop every binding and the shell subscription (host shutdown). */
  close(): void {
    this.closed = true
    this.detach?.()
    this.detach = undefined
    this.bridge = undefined
    this.bindings.clear()
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
