// Host-side file capability: `ctx.hands` (M2 能力面).
//
// WHY THIS IS A SERVICE AND NOT A RAW MIRROR
//   `hands.stat/read/write/watch` are reachable directly through `ctx.shell`, but
//   every stream they open must be (a) attributable and (b) stopped when its
//   caller goes away. Neither is expressible on the raw wire mirror, so the
//   curated service exists for exactly those two jobs plus base64 decoding.
//
// THE TWO MEASURED RULES THIS FILE IMPLEMENTS (docs/hands-host-design.md §3-4)
//
//   1. **A stream outlives its caller unless something stops it.** Measured: a
//      stream with no guard kept producing chunks after its plugin was unloaded
//      (`docs/probes/probe-host-stream-leak.ts` — 16 chunks after unload). A plain
//      `AsyncIterable` is invisible to cordis, so the guard is explicit.
//
//   2. **The guard is `this.ctx.effect(...)`, and its registration must be
//      RELEASED when the stream ends.** `this.ctx` inside a Service method is the
//      CALLER's ctx (cordis findings §1.3), so one line covers both cases: a
//      plugin call lands on the plugin's fiber (stopped at unload), a host call
//      lands on the root ctx (stopped by `gracefulStop` step 3). But an unreleased
//      registration accumulates — measured: 1000 of them survived to unload
//      (`docs/probes/probe-host-effect-economy.ts`), so a bulk sync would build a
//      table as large as the file count.
//
//   Cost of the guard, measured: ~7.4 us per stream, ONE registration per stream
//   (`docs/probes/probe-host-option-a-cost.ts`). Negligible beside a round trip.
//
// ⚠ WHAT THIS FILE DOES NOT DO
//   - No directory walking, batching or retry: those are brain-side policy
//     (proposal §1). The measured per-file cost is a full RTT.
//   - No hard permission enforcement: `#24` (M2-8) is declare-and-warn only.
//     This is NOT a security boundary — an in-process plugin can `import fs`.

import { type Context, Service, symbols } from "cordis"
import type {
  HandsChange,
  HandsErrorCode,
  HandsReadOptions,
  HandsStatWire,
  HandsWriteOptions,
  HandsWriteResult,
  ShellStdioBridge,
} from "./stdio"

declare module "cordis" {
  interface Context {
    hands: HandsService
  }
}

/** One decoded chunk. `Uint8Array` because that is the documented contract. */
export type HandsChunk = Uint8Array

export type HandsStat = HandsStatWire

export type HandsAudit = (line: string) => void

/**
 * A file-capability failure the caller can branch on.
 *
 * The code is parsed from the shell's `CODE: detail` message prefix; a message
 * that carries no known code keeps the raw text and reports `code: undefined`
 * rather than inventing one. Guessing would be worse than admitting the gap: a
 * caller switching on a fabricated `ENOENT` would take the wrong branch.
 */
export class HandsError extends Error {
  readonly code: HandsErrorCode | undefined
  constructor(message: string) {
    super(message)
    this.name = "HandsError"
    const match = /^([A-Z]+):\s*(.*)$/s.exec(message)
    if (match && (HANDS_ERROR_CODE_SET as ReadonlySet<string>).has(match[1])) {
      this.code = match[1] as HandsErrorCode
      this.message = match[2]
    } else {
      this.code = undefined
    }
  }

  /** True when the path now refers to a DIFFERENT file (rotation). */
  get isStale(): boolean {
    return this.code === "ESTALE"
  }
}

const HANDS_ERROR_CODE_SET: ReadonlySet<string> = new Set([
  "ENOENT",
  "EACCES",
  "EISDIR",
  "ESTALE",
  "ENOSPC",
  "ECANCEL",
  "EUNSUPPORTED",
])

export type HandsServiceOptions = {
  /** Shell bridge; omit while the shell is not attached. */
  bridge?: ShellStdioBridge
  /** Transparent call record: one line per capability call, with its caller. */
  audit?: HandsAudit
}

/**
 * Resolve the calling plugin, exactly as `capability.ts` does.
 *
 * Duplicated rather than imported to keep this module free of a cycle with
 * `capability.ts` (which will import this one to register the surface).
 */
function callerName(self: unknown): string | null {
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
 * Decode one wire chunk into bytes.
 *
 * The shell sends base64, but kkrpc's stock JSON codec has no binary form, so
 * what actually arrives is a STRING (measured). `Uint8Array` is accepted too so
 * this keeps working if the transport ever gains a binary carrier — the
 * alternative is a silent mis-read the day that lands.
 */
export function decodeChunk(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (typeof value === "string") return new Uint8Array(Buffer.from(value, "base64"))
  throw new HandsError("EUNSUPPORTED: unrecognised chunk shape from the shell")
}

/** Validate one watch payload; a malformed one is dropped, not guessed at. */
export function normalizeChange(value: unknown): HandsChange | undefined {
  if (!value || typeof value !== "object") return undefined
  const candidate = value as Partial<HandsChange>
  if (typeof candidate.path !== "string" || candidate.path.length === 0) return undefined
  const kind = candidate.kind
  if (kind !== "create" && kind !== "modify" && kind !== "remove" && kind !== "replace") {
    return undefined
  }
  return {
    kind,
    path: candidate.path,
    ...(typeof candidate.id === "string" ? { id: candidate.id } : {}),
  }
}

export class HandsService extends Service {
  private bridge?: ShellStdioBridge
  private readonly auditLine: HandsAudit

  constructor(ctx: Context, options: HandsServiceOptions = {}) {
    super(ctx, "hands")
    this.bridge = options.bridge
    this.auditLine = options.audit ?? (() => {})
  }

  /** Attach or detach the shell bridge (services are provided before it exists). */
  attachShell(bridge: ShellStdioBridge): void {
    this.bridge = bridge
  }

  detachShell(): void {
    this.bridge = undefined
  }

  get attached(): boolean {
    return this.bridge !== undefined
  }

  private get api() {
    if (!this.bridge) {
      throw new HandsError("EUNSUPPORTED: no shell attached")
    }
    return this.bridge.hands
  }

  /**
   * One audit line per **call**, not per chunk.
   *
   * The audit's meaning is "this plugin asked to read this path" — a per-chunk
   * record would bury the real signal under thousands of lines for one file, and
   * the volume figures belong to metrics, not to the capability log. Attribution
   * survives either way (measured), so this is a volume decision.
   *
   * `args` are summarised, not dumped: a path is useful, a megabyte of base64 is
   * not. Recorded at CALL time so a caller that obtains an iterable and never
   * consumes it still leaves a trace.
   */
  private record(self: unknown, method: string, detail: string): void {
    const who = callerName(self) ?? "<unknown>"
    this.auditLine(`[cap] ${who} -> hands.${method} ${detail}`)
  }

  // --- the four primitives ------------------------------------------------
  //
  // ⚠ All class methods. An arrow-function property silently loses attribution
  // (cordis findings §1.8), and `#private` members THROW here because `this` is a
  // per-caller shadow, not the instance (proposal §6.2a).

  /** What is at this path — or `null` when there is nothing. */
  async stat(path: string): Promise<HandsStat | null> {
    this.record(this, "stat", JSON.stringify(path))
    try {
      return await this.api.stat(path)
    } catch (error) {
      throw asHandsError(error)
    }
  }

  /**
   * Read a file as bounded chunks, tied to the caller's lifetime.
   *
   * The guard is registered **now** (not on first `next()`), so a caller that
   * takes the iterable and never consumes it still cannot leave an unguarded
   * stream behind.
   */
  read(path: string, opts?: HandsReadOptions): AsyncIterable<HandsChunk> {
    this.record(this, "read", JSON.stringify(path))
    return this.guarded(async () => {
      const stream = this.api.read(path, opts)
      return decodeStream(stream)
    })
  }

  /** Write a stream of bytes; resolves with the true byte count. */
  async write(
    path: string,
    data: AsyncIterable<HandsChunk>,
    opts?: HandsWriteOptions,
  ): Promise<HandsWriteResult> {
    // The path is audited; the payload is deliberately not even touched here.
    this.record(this, "write", JSON.stringify(path))
    try {
      return await this.api.write(path, encodeStream(data), opts)
    } catch (error) {
      throw asHandsError(error)
    }
  }

  /** Watch a path. The iterable's end cancels the subscription. */
  watch(path: string, opts?: { recursive?: boolean }): AsyncIterable<HandsChange> {
    this.record(this, "watch", JSON.stringify(path))
    return this.guarded(async () => {
      const stream = this.api.watch(path, opts)
      return decodeChanges(stream)
    })
  }

  /**
   * Wrap a stream factory so its life is bound to the CALLER's fiber.
   *
   * `this.ctx` is the caller's ctx (findings §1.3), which is what makes one
   * registration cover both callers:
   *   - a plugin call lands on the plugin's fiber → stops at unload;
   *   - a host call lands on the root ctx → stopped by `gracefulStop` step 3.
   *
   * The disposer is a NO-OP on the normal path: `stop()` releases the
   * registration when the stream ends or is cancelled, so a bulk sync does not
   * accumulate one entry per file (measured: 1000 unreleased ones survive).
   */
  private guarded<T>(open: () => Promise<AsyncIterable<T>>): AsyncIterable<T> {
    const self = this
    return {
      [Symbol.asyncIterator]() {
        let iterator: AsyncIterator<T> | undefined
        let released = false

        // Registered on the CALLER's ctx. Kept in a closure, never on `this`:
        // `this` is a per-caller shadow, so an instance field would be shared
        // across callers and released by the wrong one.
        const release = self.registerGuard(() => {
          released = true
          void iterator?.return?.()
        })

        const stop = () => {
          if (released) return
          released = true
          release()
        }

        return {
          async next(): Promise<IteratorResult<T>> {
            if (released) return { done: true, value: undefined }
            if (!iterator) iterator = (await open())[Symbol.asyncIterator]()
            let result: IteratorResult<T>
            try {
              result = await iterator.next()
            } catch (error) {
              // ⚠ Stream failures must be translated too. `stat`/`write` wrap
              // their rejections, but a stream error surfaces from `next()`
              // inside kkrpc, so without this it escapes as a plain Error whose
              // `message` is `"EISDIR: …"` but whose `.code` is missing — a
              // caller branching on the code would silently take the wrong
              // path. Found by hands-e2e-integration.test.ts, which is the only
              // test that crosses the service/peer seam.
              stop()
              throw asHandsError(error)
            }
            // The stream ended on its own: drop the guard so a long session of
            // many small files does not accumulate registrations.
            if (result.done) stop()
            return result
          },
          async return(value?: unknown): Promise<IteratorResult<T>> {
            // Cancellation: release first, then let the underlying stream unwind
            // so its own teardown runs exactly once.
            stop()
            return { done: true, value: value as T }
          },
        }
      },
    }
  }

  /** Register the per-stream guard on the calling ctx and return its disposer. */
  private registerGuard(onAbort: () => void): () => void {
    const disposer = this.ctx.effect(() => () => {
      onAbort()
    })
    return typeof disposer === "function" ? (disposer as () => void) : () => {}
  }
}

/** Turn any thrown value into a `HandsError`, preserving an existing code. */
export function asHandsError(error: unknown): HandsError {
  if (error instanceof HandsError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new HandsError(message)
}

/** Base64-decode every chunk of a wire stream. */
async function* decodeStream(stream: AsyncIterable<unknown>): AsyncIterable<Uint8Array> {
  for await (const chunk of stream) {
    yield decodeChunk(chunk)
  }
}

/**
 * Re-encode bytes as base64 for the wire.
 *
 * ⚠ base64 is our CHOICE, not a protocol requirement. The shell accepts three
 * carriers (base64, Node `Buffer`, numeric `Uint8Array` maps) and base64 is the
 * cheapest of them — the other two cost 4-11x once JSON has seen them.
 *
 * But that ranking only holds while the stock JSON codec is in place. kkrpc lets
 * the platform and codec be replaced (`createTransport({ platform, codec })`), and
 * a length-prefixed binary framing over the SAME single pipe measures 1.8-2.1x
 * faster than base64 with no desynchronisation
 * (`docs/probes/hand-io/04-binary-framing.mjs`). The cost is changing both ends,
 * not impossibility — so do not describe base64 as a contract.
 */
async function* encodeStream(stream: AsyncIterable<Uint8Array>): AsyncIterable<string> {
  for await (const chunk of stream) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
    yield Buffer.from(bytes).toString("base64")
  }
}

/** Validate every change record, dropping malformed ones instead of guessing. */
async function* decodeChanges(stream: AsyncIterable<unknown>): AsyncIterable<HandsChange> {
  for await (const value of stream) {
    const change = normalizeChange(value)
    if (change) yield change
  }
}
