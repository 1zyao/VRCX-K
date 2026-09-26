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
//   - No RECURSION, glob matching, sorting or cross-directory batching: those are
//     brain-side policy (proposal §1). ⚠ But enumeration itself IS here (`list`):
//     the "walking is the caller's job" rule assumed the caller can reach the
//     filesystem, which is false for a remote shell. The measured per-file cost
//     being a full RTT is why BATCHING is the caller's job, not why enumerating
//     is.
//   - No hard permission enforcement: `#24` (M2-8) is declare-and-warn only.
//     This is NOT a security boundary — an in-process plugin can `import fs`.

import { type Context, Service } from "cordis"
import type { VRCXKPluginManifest } from "./contracts/pluginManifest.generated"
import { callerName, overreachWarning } from "./overreach"
import type {
  HandsChange,
  HandsErrorCode,
  HandsListOptions,
  HandsListWire,
  HandsReadOptions,
  HandsStatWire,
  HandsWriteOptions,
  HandsWriteResult,
  ShellStdioBridge,
} from "./stdio"
import { HANDS_ERROR_CODES } from "./stdio"

declare module "cordis" {
  interface Context {
    hands: HandsService
  }
}

/** One decoded chunk. `Uint8Array` because that is the documented contract. */
export type HandsChunk = Uint8Array

export type HandsStat = HandsStatWire

/** One entry from `hands.list` / a `stat` directory preview. */
export type HandsListEntry = HandsListWire

/**
 * One streamed batch of entries.
 *
 * An array, not a page object: the shell streams raw batches and the caller's
 * own looping code is what accumulates. Keeping paging metadata (offsets, "next
 * token") out means there is no second, contradictory notion of position to get
 * out of step with the stream.
 */
export type HandsListBatch = HandsListEntry[]

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

/**
 * The codes `HandsError` will accept.
 *
 * ⚠ Derived from `HANDS_ERROR_CODES`, NOT written out again. This used to be a
 * hand-maintained `Set` literal, and adding `ENOTDIR` to the wire contract
 * without adding it here produced a `HandsError` whose `message` said `ENOTDIR:`
 * while `code` was `undefined` — so a caller branching on `.code` silently took
 * the wrong branch. Deriving makes that class of drift impossible.
 */
const HANDS_ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(HANDS_ERROR_CODES)

/**
 * Refuse a call whose receiver was lost, with an error that says what to do.
 *
 * ⚠ WHY THIS EXISTS AT ALL. A cordis `Service` subclass reaches its per-caller
 * state through `this`: the method proxy substitutes a per-caller shadow only
 * when the call goes through the namespace object (`thisArg === outer`). Write
 * `const { read } = ctx.hands` and the copy is a BARE FUNCTION, so `this` is
 * `undefined` and the first statement of the method — `this.record(...)` —
 * throws the opaque `Cannot read properties of undefined (reading 'record')`.
 * Measured on cordis 4.0.0-rc.9: `read`/`watch`/`list` throw synchronously,
 * `stat`/`write` return a rejected promise, and because `record` is the first
 * statement NEITHER the `[cap]` audit line NOR the `#24` overreach warning is
 * ever emitted for that call.
 *
 * `capability.ts` says destructuring "only loses attribution, falls back to
 * null, and does not throw". That is true for the CLOSURE-style mirrors it
 * builds (`buildNode`), and FALSE for every `Service` subclass — `hands`,
 * `tray`, `shortcut`, `autostart`. This guard is the difference between an
 * actionable message and a TypeError that names an internal field.
 *
 * ⚠ A module-level function, NOT a private method, and that is load-bearing: a
 * method would be reached through the very `this` that is missing, so the guard
 * would throw the same TypeError it exists to replace.
 *
 * ⚠ Do NOT "fix" this by rewriting the methods as arrow-function PROPERTIES.
 * That does make destructured calls work — by binding the instance directly —
 * but it SILENTLY destroys caller attribution (`caller: null`, cordis findings
 * §1.8), so every audit line would say `<unknown>` and every overreach check
 * would skip (a caller with no entry id is never reported, by design). A loud
 * refusal to destructure is strictly better than a quiet loss of the audit.
 */
function assertReceiver(receiver: unknown, method: string): void {
  if (receiver === undefined || receiver === null) {
    throw new HandsError(
      `EUNSUPPORTED: ctx.hands.${method}(…) was called without its receiver — ` +
        `do not destructure it. Cordis supplies the per-caller \`this\` only for a ` +
        `call that goes through \`ctx.hands\`; a destructured or otherwise detached ` +
        `copy (\`const { ${method} } = ctx.hands\`) is a bare function, so the call ` +
        `cannot be attributed to its plugin and is REFUSED rather than silently ` +
        `losing its audit line. Call \`ctx.hands.${method}(…)\` directly.`,
    )
  }
}

export type HandsServiceOptions = {
  /** Shell bridge; omit while the shell is not attached. */
  bridge?: ShellStdioBridge
  /** Transparent call record: one line per capability call, with its caller. */
  audit?: HandsAudit
}

/**
 * Decode one wire chunk into bytes.
 *
 * The shell sends base64, but kkrpc's stock JSON codec has no binary form, so
 * what actually arrives is a STRING (measured). `Uint8Array` is accepted too so
 * this keeps working if the transport ever gains a binary carrier — the
 * alternative is a silent mis-read the day that lands.
 */
/**
 * Strict base64, matching what the SHELL already does.
 *
 * ⚠ `Buffer.from(value, "base64")` NEVER throws — it decodes whatever it can and
 * silently drops the rest. Measured:
 *
 *     "!!!not-base64!!!"  -> 7 bytes (garbage)   "日本語" -> 0 bytes
 *     "AAE" (len 3)       -> 2 bytes             "a"      -> 0 bytes
 *     "QUJD!"             -> 3 bytes             "  QUJD  " -> 3 bytes
 *
 * So an illegal carrier became garbage written to a FILE, or an empty chunk, with
 * no error anywhere — while `kkrpc_peer.rs`'s `decode_chunk` rejects the same
 * input with `bad base64 chunk`. The discipline was half-applied: the shell
 * refused what the host accepted, so a corrupt frame was caught in one direction
 * and silently written in the other.
 *
 * The regex is the RFC 4648 alphabet with correct padding, and it also rejects
 * whitespace and stray characters that `Buffer.from` tolerates. Length is checked
 * because `"AAE"` is not a legal encoding of anything — the standard requires
 * whole 4-character groups.
 */
const BASE64_STRICT = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export function decodeChunk(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (typeof value === "string") {
    if (!BASE64_STRICT.test(value)) {
      // Name the length, not the content: this string IS the payload, and echoing
      // it into a log or an error message is how a file's bytes end up somewhere
      // they were never meant to be.
      throw new HandsError(
        `EUNSUPPORTED: chunk is not valid base64 (${value.length} characters); ` +
          "the shell sends standard base64 with padding",
      )
    }
    return new Uint8Array(Buffer.from(value, "base64"))
  }
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
  /**
   * Manifest lookup for `#24` overreach detection.
   *
   * Set by `useManifests` once the registry exists. `undefined` means "manifests
   * are not loaded", which is NOT the same as "this plugin is undeclared" — see
   * `overreachWarning`, which returns nothing in that case rather than warning on
   * every call.
   */
  private manifestLookup?: (entryId: string) => VRCXKPluginManifest | undefined

  constructor(ctx: Context, options: HandsServiceOptions = {}) {
    super(ctx, "hands")
    this.bridge = options.bridge
    this.auditLine = options.audit ?? (() => {})
  }

  /**
   * Enable overreach detection by supplying the manifest registry lookup.
   *
   * ⚠ Required for `#24` to cover this service at all. Without it `ctx.hands` is
   * audited but never checked, which is how the supported entry point ended up
   * unchecked while the raw mirror was covered.
   */
  useManifests(lookup: (entryId: string) => VRCXKPluginManifest | undefined): void {
    this.manifestLookup = lookup
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

    // Overreach: declared vs actual (#24).
    //
    // ⚠ `ctx.hands` is the SUPPORTED entry point and it had NO check before
    // this — the raw escape hatch (`ctx.shell.hands.*`) was checked while this
    // was not, which is the exact inversion `#24` exists to prevent. It is the
    // same shared helper the mirror uses, so the rule cannot drift between them.
    const warning = overreachWarning(self, `hands.${method}`, this.manifestLookup)
    if (warning) this.auditLine(warning)
  }

  // --- the four primitives ------------------------------------------------
  //
  // ⚠ All class methods. An arrow-function property silently loses attribution
  // (cordis findings §1.8), and `#private` members THROW here because `this` is a
  // per-caller shadow, not the instance (proposal §6.2a).

  /** What is at this path — or `null` when there is nothing. */
  async stat(path: string): Promise<HandsStat | null> {
    assertReceiver(this, "stat")
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
    assertReceiver(this, "read")
    this.record(this, "read", JSON.stringify(path))
    return this.guarded(async () => {
      const stream = this.api.read(path, opts)
      return decodeStream(stream)
    })
  }

  /**
   * Write a stream of bytes; resolves with the true byte count.
   *
   * # Why this primitive IS guarded — and the reversal that put it here
   *
   * `read`/`watch`/`list` hand back a stream the CALLER pulls; `write` is handed
   * a stream the caller PRODUCES. An earlier revision of this method reasoned
   * that the difference made a guard unnecessary, on these grounds:
   *
   *   1. "the consumer of the caller's bytes is the SHELL, inside the pending
   *      `this.api.write(...)`, and that drain lives exactly as long as the call";
   *   2. "there is no host-side cancel for a deferred-reply call to invoke
   *      anyway — `guarded()`'s abort path ends in `iterator.return()`, which a
   *      write has no equivalent of".
   *
   * ⚠ BOTH ARE FALSE, and each one is checkable in this repository:
   *
   *   - The generator is RIGHT HERE: `encodeStream(data)` is created in this
   *     method, so the "equivalent of `iterator.return()`" is a call on an
   *     iterator this module owns. (It was always ownable; the old shape simply
   *     passed the generator straight to kkrpc and dropped the handle.)
   *   - The wire-level cancel already exists. kkrpc's remote consumer calls
   *     `iterator.return()` on its local stream when the host stops pulling
   *     (`node_modules/kkrpc/dist/streaming.js`, `createAsyncIteratorFromPromise`),
   *     and the Rust peer answers `op:"return"` by cancelling the producer's
   *     source and acknowledging it (`src-tauri/src/kkrpc_peer.rs`, the
   *     `"return" | "throw"` arm). So a cancelled write is a NORMAL wire event,
   *     not an unimplementable one.
   *
   * So the drain does NOT necessarily "live exactly as long as the call". kkrpc
   * pumps the caller's generator ahead of the consumer (it pulls when its credit
   * budget allows — `pumpRemoteStream`'s `consumedSincePull` rule in the file
   * above), so after the owning plugin is unloaded we can still be calling
   * `next()` on a dead plugin's generator, and every chunk it yields is another
   * write reaching disk on behalf of an owner that no longer exists. That is the
   * leak this guard closes: the caller's fiber is the write's lifetime, the same
   * rule the other four primitives follow.
   *
   * ⚠ THE TRADE-OFF, stated honestly rather than hidden: stopping a write
   * mid-stream leaves a PARTIAL file, and the shell's deferred reply then reports
   * the bytes written so far as a completed write — a caller that had survived
   * would see success with a short file. Two things bound that risk here: the
   * only actor that can end the guard early is the caller going away (it has no
   * expectation left to violate), and kkrpc reads a host-side `return` as a
   * normal end-of-stream, so the reply is a real number rather than a hang. The
   * old behaviour is not "safe by comparison" either — it reported `bytes: 12`
   * for a write whose owner had been unloaded after 3.
   *
   * Audit coverage is unchanged: `record` still runs at CALL time, so a write
   * that is started and then abandoned still leaves its trace (same rule as
   * `read`).
   */
  async write(
    path: string,
    data: AsyncIterable<HandsChunk>,
    opts?: HandsWriteOptions,
  ): Promise<HandsWriteResult> {
    assertReceiver(this, "write")
    // The path is audited; the payload is deliberately not even touched here.
    this.record(this, "write", JSON.stringify(path))

    // Registered BEFORE the first `await`, so the guard covers the whole call
    // including the window before the shell has asked for its first chunk.
    const lifetime = { cancelled: false }
    const release = this.registerGuard(() => {
      lifetime.cancelled = true
    })

    try {
      return await this.api.write(
        path,
        // ⚠ `encodeStream` is INSIDE the wrapper on purpose: the wrapper must
        // check the guard before every pull, and a pull of `encodeStream` is what
        // transitively pulls the CALLER's generator. Wrapping the other way round
        // would check after the caller's chunk had already been produced.
        transferWhileCallerAlive(encodeStream(data), lifetime),
        opts,
      )
    } catch (error) {
      throw asHandsError(error)
    } finally {
      // Always: the registration is per-CALL, so leaving it behind would grow the
      // caller's fiber once per write (measured: 1000 unreleased registrations
      // survived to unload — `docs/probes/probe-host-effect-economy.ts`).
      release()
    }
  }

  /** Watch a path. The iterable's end cancels the subscription. */
  watch(path: string, opts?: { recursive?: boolean }): AsyncIterable<HandsChange> {
    assertReceiver(this, "watch")
    this.record(this, "watch", JSON.stringify(path))
    return this.guarded(async () => {
      const stream = this.api.watch(path, opts)
      return decodeChanges(stream)
    })
  }

  /**
   * One directory's entries, as a stream of batches.
   *
   * # Why this is not "caller policy"
   *
   * An earlier revision of this service exposed only `stat`/`read`/`write`/
   * `watch`, on the reasoning that enumeration is the caller's job. That holds
   * only when the caller can reach the filesystem — and the case this whole
   * capability exists for is a REMOTE shell, where the brain cannot see the disk.
   * Without this, a plugin cannot discover a single filename.
   *
   * What stays on the caller's side: recursion, globbing, sorting, batching
   * ACROSS directories and retry — none of which needs filesystem access.
   *
   * # Guards
   *
   * ⚠ The caller may **break early**; the drain must then cancel rather than
   * leave the producer running. That is `guarded()`'s job, same as `read`.
   *
   * ⚠ A batch arrives as a JSON **array of entries**, so it is base64-decoded
   * then parsed — the shell serialises the batch itself, and this is the only
   * place that knows the encoding (same discipline as `decodeChunk`).
   */
  list(path: string, opts?: HandsListOptions): AsyncIterable<HandsListBatch> {
    assertReceiver(this, "list")
    this.record(this, "list", JSON.stringify(path))
    return this.guarded(async () => {
      const stream = this.api.list(path, opts)
      return decodeBatches(stream)
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
          // ⚠ Both failure modes, because `return()` can fail EITHER way:
          //
          //   - it REJECTS (a remote stream's return travels over the wire, which
          //     is exactly what kkrpc does), or
          //   - it THROWS SYNCHRONOUSLY, which `Promise.resolve(x).catch(...)`
          //     does NOT catch — the expression throws before `Promise.resolve`
          //     is ever called (verified: the sync throw escapes).
          //
          // So the call itself is wrapped. This runs on the two paths most likely
          // to coincide with a half-dead transport — plugin unload and shell
          // disappearance — and this repo has already been bitten by an unhandled
          // rejection on exactly that shape (`Include.write`). The stream is being
          // torn down regardless, so the error is swallowed deliberately — but
          // visibly, not by omission.
          try {
            void Promise.resolve(iterator?.return?.(undefined)).catch(() => {})
          } catch {
            /* teardown continues; the guard has already been released */
          }
        })

        const stop = () => {
          if (released) return
          released = true
          release()
        }

        return {
          async next(): Promise<IteratorResult<T>> {
            if (released) return { done: true, value: undefined }
            let result: IteratorResult<T>
            try {
              // ⚠ `open()` MUST run inside this try, not before it. It is the call
              // most likely to reject — "no shell attached" is a plain
              // `HandsError`, and a peer refusal travels over the wire — and a
              // rejection here used to skip `stop()` entirely, so the guard
              // registered in `[Symbol.asyncIterator]()` above was never
              // released. Measured consequence: 50 failing `for await` iterations
              // against an unattached shell left 50 registrations on the caller's
              // fiber, all of them surviving until unload (pinned by "a stream
              // call whose open() REJECTS still releases its registration"). The
              // success path is untouched: `open()` still runs exactly once
              // (guarded by `!iterator`) and its failure now takes the same
              // `stop()` + `asHandsError` path as `iterator.next()`.
              //
              // ⚠ AND `open()` MUST BE RE-CHECKED AFTER IT RETURNS. That is a
              // SECOND, orthogonal hole from the one the `try` closes: the entry
              // check (`if (released) …` at the top of `next()`) only sees a
              // release that has ALREADY happened, and nothing re-read the flag
              // between the `await` completing and the freshly opened stream
              // being pulled.
              //
              // The window is not theoretical: in production `open()` is a full
              // kkrpc round trip, so the WHOLE RTT is a window in which the
              // caller can go away — its fiber disposed (plugin unload) or its
              // consumer `return()`ed (an early `break`). What the old shape did
              // when a release landed there: `next()` still returned the first
              // chunk produced by the new stream, `return()` was never forwarded
              // to it, and no later `next()` could reach it (the entry check
              // short-circuits from then on) — so on the shell side a producer
              // kept pumping and a file handle stayed open until the process
              // exited. That is precisely the unguarded-stream leak this module's
              // header cites (16 chunks after unload), reached by a different
              // route.
              //
              // ⇒ The release is re-read, and the stream we JUST opened is
              // unwound, with the same `void` + sync-throw tolerance the guard's
              // own disposer uses: kkrpc's `return()` travels the wire and can
              // reject, and a transport that is already gone can throw
              // synchronously.
              if (!iterator) {
                const opened = await open()
                if (released) {
                  // `released` is only ever set by the guard's disposer or by
                  // `stop()`, and `stop()` is what calls the disposer — so at
                  // this point the registration is already released and there is
                  // nothing left to release. The only thing to unwind is the
                  // stream that was just opened.
                  const orphan = opened[Symbol.asyncIterator]()
                  try {
                    void Promise.resolve(orphan.return?.(undefined)).catch(() => {})
                  } catch {
                    /* the caller is gone; there is nobody to report this to */
                  }
                  return { done: true, value: undefined }
                }
                iterator = opened[Symbol.asyncIterator]()
              }
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

/**
 * Forward `source` while the caller is still alive, then stop.
 *
 * This is `guarded()`'s mirror image, and the asymmetry is the whole reason it is
 * a second function rather than a flag on the first:
 *
 *   - `guarded()` returns the iterable the CALLER consumes, so its guard has to
 *     be checked on the caller's own `next()` — the caller is doing the pulling.
 *   - here the SHELL (through kkrpc) is the puller and the caller only supplied
 *     the bytes, so the check belongs on every forwarded chunk.
 *
 * ⚠ A guard is re-read BEFORE each pull, not after: `for await` pulls the source
 * and only then lets this generator see the value, so checking afterwards would
 * let one more chunk of the dead plugin's generator reach disk on every check.
 * The check is `cancelled` — a plain object rather than a closure boolean because
 * the guard is registered on the caller's ctx by `write`, which owns the object.
 *
 * ⚠ Returning instead of throwing is deliberate. kkrpc reads the end of this
 * generator as a NORMAL end-of-stream and lets the shell finish the deferred
 * reply (`StreamSink::finish(Ok(..))`), so the caller gets "N bytes written" —
 * a truncated file reported as a completed write. That is the price of stopping
 * at all; a thrown error would instead surface as a write FAILURE, which is a
 * worse lie for the same file. Both are bounded by the fact that only the
 * caller's own disappearance can trigger this (see `write`'s comment).
 */
async function* transferWhileCallerAlive(
  source: AsyncIterable<string>,
  lifetime: { cancelled: boolean },
): AsyncIterable<string> {
  const iterator = source[Symbol.asyncIterator]()
  try {
    while (!lifetime.cancelled) {
      const result = await iterator.next()
      if (result.done) return
      yield result.value
    }
  } finally {
    // Let the caller's generator unwind exactly once, whichever way we left the
    // loop — including the `cancelled` exit, where the source has NOT finished.
    // `return()` can reject (a generator whose body throws in its `finally`) or
    // throw synchronously, so the call is wrapped like every other teardown here.
    try {
      void Promise.resolve(iterator.return?.(undefined)).catch(() => {})
    } catch {
      /* teardown continues */
    }
  }
}

/** Validate every change record, dropping malformed ones instead of guessing. */
async function* decodeChanges(stream: AsyncIterable<unknown>): AsyncIterable<HandsChange> {
  for await (const value of stream) {
    const change = normalizeChange(value)
    if (change) yield change
  }
}

/**
 * Decode one `hands.list` batch.
 *
 * The wire value is base64 (the shell serialises the whole batch), so it is
 * decoded to text and parsed. ⚠ A batch that fails to parse is reported, NOT
 * skipped: silently dropping a batch would make a directory look like it has
 * fewer entries than it does, and a caller walking it would conclude the
 * directory ended early. That is the "silent wrong answer" failure this file
 * keeps guarding against.
 */
function decodeBatch(value: unknown): HandsListBatch {
  const bytes = decodeChunk(value)
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"))
  } catch (error) {
    throw new HandsError(
      `EUNSUPPORTED: hands.list batch is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  if (!Array.isArray(parsed)) {
    throw new HandsError("EUNSUPPORTED: hands.list batch is not an array")
  }
  return parsed.map(normalizeEntry).filter((entry): entry is HandsListEntry => entry !== undefined)
}

/** One listing entry, or `undefined` when the shape is not one we recognise. */
function normalizeEntry(value: unknown): HandsListEntry | undefined {
  if (!value || typeof value !== "object") return undefined
  const entry = value as { name?: unknown; kind?: unknown; size?: unknown }
  if (typeof entry.name !== "string") return undefined
  const kind =
    entry.kind === "file" || entry.kind === "dir" || entry.kind === "symlink" ? entry.kind : "other"
  return {
    name: entry.name,
    kind,
    size: typeof entry.size === "number" ? entry.size : 0,
  }
}

/** Decode every batch of a `hands.list` stream. */
async function* decodeBatches(stream: AsyncIterable<unknown>): AsyncIterable<HandsListBatch> {
  for await (const value of stream) {
    yield decodeBatch(value)
  }
}
