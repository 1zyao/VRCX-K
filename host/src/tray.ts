// Host → shell tray ingress (TrayService).
//
// Ownership split (see docs/architecture-proposal.md and contracts/tray-menu.schema.json):
//   - Rust owns the tray icon, the core menu and the rendering/click routing.
//   - The host/plugins own their own groups only (`source: "host" | "plugin"`).
//     They are pushed to the shell as one `TrayMenuSnapshot` via the kkrpc/stdio
//     method `shell.tray.setSnapshot` (mirrors src-tauri/src/shell_sys.rs).
//   - A click on a host/plugin-owned item comes back as the shell → host
//     notification `tray.action` with `{ id, command, args }`.
//
// Design notes:
//   - Caching/diffing is REQUIRED: an identical snapshot (stable fingerprint of
//     the groups) is never pushed again — only a content change bumps the
//     revision and pushes.
//   - Rapid updates coalesce (same-microtask by default, or a short debounce via
//     `coalesceMs`) and pushes are serialized, so a slow shell call can never
//     reorder revisions.
//   - With no shell attached (`VRCXK_SHELL` unset) the service stays functional:
//     `setGroups` returns a `no-shell` verdict and the pending content is pushed
//     once a shell attaches (`attachShell`).

import { type Context, Service } from "cordis"
import type { VRCXKPluginManifest } from "./contracts/pluginManifest.generated"
import { callerName, overreachWarning } from "./overreach"
import type { TrayActionEvent, TraySetSnapshotResult } from "./stdio"
import { TRAY_SCHEMA_VERSION, validateTrayMenuSnapshot } from "./tray_contract"
import type { TrayGroup, TrayMenuSnapshot } from "./tray-contract.generated"

declare module "cordis" {
  interface Context {
    tray: TrayService
  }
}

export type TrayActionHandler = (action: TrayActionEvent) => void

/** Push one snapshot to the shell (absent = no shell attached). */
export type TrayPush = (snapshot: TrayMenuSnapshot) => Promise<TraySetSnapshotResult>

export type TrayVerdict =
  | { status: "pushed"; revision: number; changed: true }
  | { status: "unchanged"; revision: number; changed: false }
  /** Superseded by a later update inside the same coalescing window. */
  | { status: "coalesced"; revision: number }
  | { status: "no-shell"; revision: number }
  | { status: "invalid"; revision: number; error: string }
  | { status: "error"; revision: number; error: string }
  | { status: "closed"; revision: number }

export type TrayServiceOptions = {
  /** Push function; omit while no shell is attached. */
  push?: TrayPush
  /** Snapshot `generation` (host process generation); default 0. */
  generation?: number
  /** Coalescing window in ms. 0 (default) coalesces within one microtask. */
  coalesceMs?: number
  log?: (line: string) => void
}

type Waiter = (verdict: TrayVerdict) => void

/** Stable content fingerprint: key order in the payload must not matter. */
export function fingerprintGroups(groups: readonly TrayGroup[]): string {
  return JSON.stringify(canonicalize(groups))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Local contract validation for a host/plugin-owned group list. */
export function validateGroups(groups: readonly TrayGroup[]): string | undefined {
  if (!Array.isArray(groups)) return "groups must be an array"
  for (const group of groups) {
    const source = (group as { source?: unknown } | null | undefined)?.source
    if (source !== "host" && source !== "plugin") {
      return `group "${String((group as { id?: unknown } | undefined)?.id)}" has source ${String(source)}; the host may only push host/plugin-owned groups`
    }
  }
  // Full schema validation (ids, limits, host-target privilege rules, ...).
  const snapshot = {
    schemaVersion: TRAY_SCHEMA_VERSION,
    generation: 0,
    revision: 0,
    groups: [...groups],
  }
  if (!validateTrayMenuSnapshot(snapshot)) {
    const details = (validateTrayMenuSnapshot.errors ?? [])
      .map((error) => `${error.instancePath} ${error.message}`)
      .join("; ")
    return `invalid tray groups: ${details}`
  }
  return undefined
}

function normalizeAction(value: unknown): TrayActionEvent | undefined {
  if (!value || typeof value !== "object") return undefined
  const { id, command, args } = value as { id?: unknown; command?: unknown; args?: unknown }
  if (typeof id !== "string" || !id) return undefined
  if (typeof command !== "string" || !command) return undefined
  if (args !== undefined && !Array.isArray(args)) return undefined
  return { id, command, args: (args as unknown[] | undefined) ?? [] }
}

export class TrayService extends Service {
  private readonly generation: number
  private readonly coalesceMs: number
  private readonly logLine: (line: string) => void
  private readonly handlers = new Set<TrayActionHandler>()
  /** Manifest lookup for the `#24` check; see `record`. */
  private manifestLookup?: (entryId: string) => VRCXKPluginManifest | undefined

  private push?: TrayPush
  private closed = false

  /** Revision of the latest accepted content (monotonic; never reused). */
  private revisionValue = 0
  /** Fingerprint of the latest accepted content. */
  private contentFingerprint?: string
  /** Fingerprint the shell acknowledged. */
  private pushedFingerprint?: string
  private lastGroups?: TrayGroup[]

  private pendingGroups?: TrayGroup[]
  private pendingFingerprint?: string
  private pendingRevision = 0
  private waiters: Waiter[] = []
  private flushScheduled = false
  private flushTimer?: ReturnType<typeof setTimeout>
  /** Serializes pushes so revisions cannot be delivered out of order. */
  private chain: Promise<void> = Promise.resolve()

  constructor(ctx: Context, options: TrayServiceOptions = {}) {
    super(ctx, "tray")
    this.push = options.push
    this.generation = options.generation ?? 0
    this.coalesceMs = options.coalesceMs ?? 0
    this.logLine = options.log ?? (() => {})
  }

  /** Give the service the manifest registry so `#24` can compare declare vs actual. */
  useManifests(lookup: (entryId: string) => VRCXKPluginManifest | undefined): void {
    this.manifestLookup = lookup
  }

  /**
   * One audit line per caller-visible operation, plus the `#24` check.
   *
   * ⚠ `setGroups` is a PUBLIC method that replaces the OS tray menu, so it is a
   * capability a plugin requests — not, as an earlier draft of this comment
   * assumed, a host-only push. An earlier review pass had left `ctx.autostart`
   * and `ctx.shortcut` unchecked while claiming tray needed nothing; checking the
   * actual surface showed `setGroups` is callable and mutates shell state, so it
   * needs the same treatment. The pre-existing `logLine` calls below are
   * DIAGNOSTICS (invalid payloads, handler errors) and never name the caller.
   */
  private record(self: unknown, method: string, detail = ""): void {
    const who = callerName(self) ?? "<unknown>"
    this.logLine(`[cap] ${who} -> tray.${method}${detail ? ` ${detail}` : ""}`)
    const warning = overreachWarning(self, `tray.${method}`, this.manifestLookup)
    if (warning) this.logLine(warning)
  }

  /** Revision of the latest accepted content. */
  get revision(): number {
    return this.revisionValue
  }

  /** Whether a shell push function is attached. */
  get attached(): boolean {
    return !!this.push
  }

  /** Whether the shell holds the latest accepted content. */
  get inSync(): boolean {
    return (
      this.contentFingerprint !== undefined && this.contentFingerprint === this.pushedFingerprint
    )
  }

  // ── shell attachment ────────────────────────────────────────────────────

  /**
   * Attach the shell push function. Any content accepted while no shell was
   * attached is pushed now (a plugin usually calls setGroups during bootstrap,
   * before the stdio bridge exists).
   */
  attachShell(push: TrayPush): void {
    if (this.closed) return
    this.push = push
    if (
      this.contentFingerprint !== undefined &&
      this.contentFingerprint !== this.pushedFingerprint &&
      this.lastGroups
    ) {
      this.enqueue(this.lastGroups)
    }
  }

  detachShell(): void {
    this.push = undefined
  }

  // ── snapshot publication ────────────────────────────────────────────────

  /**
   * Publish the host/plugin-owned tray groups.
   *
   * Resolves with a verdict: `pushed` (content changed and the shell accepted
   * it), `unchanged` (identical fingerprint — no push, no revision bump),
   * `coalesced` (superseded by a later call in the same window), `no-shell`,
   * `invalid`, `error` or `closed`.
   */
  setGroups(groups: TrayGroup[]): Promise<TrayVerdict> {
    // Recorded BEFORE the work so a rejected or superseded call is still
    // attributed — an undeclared attempt must not go invisible by failing.
    this.record(this, "setGroups", `${groups.length} group(s)`)
    if (this.closed) return Promise.resolve({ status: "closed", revision: this.revisionValue })
    const invalid = validateGroups(groups)
    if (invalid) {
      this.logLine(`tray.setGroups rejected: ${invalid}`)
      return Promise.resolve({ status: "invalid", revision: this.revisionValue, error: invalid })
    }
    const fingerprint = fingerprintGroups(groups)
    if (fingerprint === this.contentFingerprint) {
      // Identical content: keep the newest object for a later resync but never
      // push or bump the revision again.
      this.lastGroups = groups
      return Promise.resolve({ status: "unchanged", revision: this.revisionValue, changed: false })
    }
    return this.enqueue(groups)
  }

  private enqueue(groups: TrayGroup[]): Promise<TrayVerdict> {
    if (this.pendingGroups) {
      // Supersede the queued update inside this coalescing window.
      const superseded = this.waiters.splice(0)
      const revision = this.revisionValue
      for (const waiter of superseded) waiter({ status: "coalesced", revision })
    }
    this.revisionValue += 1
    this.contentFingerprint = fingerprintGroups(groups)
    this.lastGroups = groups
    this.pendingGroups = groups
    this.pendingFingerprint = this.contentFingerprint
    this.pendingRevision = this.revisionValue
    const promise = new Promise<TrayVerdict>((resolve) => this.waiters.push(resolve))
    this.scheduleFlush()
    return promise
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return
    this.flushScheduled = true
    const run = () => {
      this.flushTimer = undefined
      this.flushScheduled = false
      this.flush()
    }
    if (this.coalesceMs > 0) this.flushTimer = setTimeout(run, this.coalesceMs)
    else queueMicrotask(run)
  }

  private flush(): void {
    const groups = this.pendingGroups
    const fingerprint = this.pendingFingerprint
    const revision = this.pendingRevision
    const waiters = this.waiters
    this.pendingGroups = undefined
    this.pendingFingerprint = undefined
    this.waiters = []
    if (!groups || fingerprint === undefined) return
    const snapshot: TrayMenuSnapshot = {
      schemaVersion: TRAY_SCHEMA_VERSION,
      generation: this.generation,
      revision,
      groups,
    }
    this.chain = this.chain.then(() => this.pushSnapshot(snapshot, fingerprint, revision, waiters))
  }

  private async pushSnapshot(
    snapshot: TrayMenuSnapshot,
    fingerprint: string,
    revision: number,
    waiters: Waiter[],
  ): Promise<void> {
    let verdict: TrayVerdict
    if (!this.push) {
      verdict = { status: "no-shell", revision }
    } else {
      try {
        const result = await this.push(snapshot)
        if (result?.ok) {
          this.pushedFingerprint = fingerprint
          verdict = { status: "pushed", revision, changed: true }
        } else {
          this.rollbackAccepted(fingerprint)
          verdict = {
            status: "error",
            revision,
            error: result?.error ?? "shell rejected the tray snapshot",
          }
        }
      } catch (error) {
        this.rollbackAccepted(fingerprint)
        verdict = { status: "error", revision, error: describe(error) }
      }
    }
    for (const waiter of waiters) waiter(verdict)
  }

  /**
   * A failed push must not swallow the content: allow the same groups to be
   * published again (the next setGroups retries instead of reporting
   * `unchanged`).
   */
  private rollbackAccepted(failedFingerprint: string): void {
    if (this.contentFingerprint === failedFingerprint)
      this.contentFingerprint = this.pushedFingerprint
  }

  // ── action fan-out ──────────────────────────────────────────────────────

  /**
   * Register a handler for shell → host `tray.action` notifications. Returns an
   * unsubscribe function.
   */
  onAction(handler: TrayActionHandler): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  /** Fan one shell `tray.action` payload out to every registered handler. */
  dispatchAction(action: unknown): boolean {
    const event = normalizeAction(action)
    if (!event) {
      this.logLine(`tray.action ignored (invalid payload): ${safeJson(action)}`)
      return false
    }
    const handlers = [...this.handlers]
    for (const handler of handlers) {
      try {
        handler(event)
      } catch (error) {
        this.logLine(`tray.action handler error: ${describe(error)}`)
      }
    }
    return handlers.length > 0
  }

  /** Stop publishing and drop handlers (host shutdown). */
  close(): void {
    this.closed = true
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    this.flushScheduled = false
    const waiters = this.waiters.splice(0)
    this.pendingGroups = undefined
    this.pendingFingerprint = undefined
    for (const waiter of waiters) waiter({ status: "closed", revision: this.revisionValue })
    this.handlers.clear()
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
