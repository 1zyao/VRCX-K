import type { Context } from "cordis"
import type { RPCMessage, Transport } from "kkrpc"
import { nodeStdioTransport } from "kkrpc/stdio"
import { StreamingRPCChannel } from "kkrpc/streaming"
import { HOST_RESTART_EXIT, hostWsAPI } from "./api"
import { gracefulStopWithTimeout, stopOnStdinLoss } from "./lifecycle"
import { stdinIsPeerChannel } from "./stdin-watch"
import type { TrayMenuSnapshot } from "./tray-contract.generated"
import type { HostWsReady } from "./ws"

/** Result of `shell.tray.setSnapshot` (mirrors src-tauri/src/shell_sys.rs). */
export type TraySetSnapshotResult = {
  ok: boolean
  revision: number
  error?: string
}

/** Payload of the shell → host `tray.action` notification. */
export type TrayActionEvent = {
  id: string
  command: string
  args: unknown[]
}

/**
 * Result of `shell.shortcut.register` / `unregister` (mirrors
 * `src-tauri/src/shortcut.rs#ShortcutRegistration`).
 *
 * `accelerator` is the CANONICAL spelling the shell produced
 * (`shift+control+KeyK`). Callers must match `shortcut.pressed` events against
 * this string rather than re-parsing their own input: chord identity has one
 * implementation (the plugin's parser, in Rust).
 */
export type ShortcutRegistration = {
  ok: boolean
  accelerator?: string
  error?: string
}

/** Payload of the shell → host `shortcut.pressed` notification. */
export type ShortcutPressEvent = {
  /** Canonical spelling of the chord that was pressed. */
  accelerator: string
  /** Plugin hotkey id: `(modifiers.bits() << 16) | key`. */
  id: number
}

/** Host API exposed to the Rust shell (LocalAPI). */
export type HostStdioAPI = {
  ping(): Promise<string>
  stop(): Promise<boolean>
  restart(): Promise<boolean>
  /** Shell → host tray notifications. */
  tray: {
    /** A host/plugin-owned tray item was clicked. */
    action(action: TrayActionEvent): boolean
  }
  /** Shell → host global shortcut notifications (issue #6 callback). */
  shortcut: {
    /** A chord the host registered was pressed (key-down edge only). */
    pressed(event: ShortcutPressEvent): boolean
  }
  /** Shell → host deep-link notifications (desktop only). */
  deepLink: {
    /** One or more URLs the OS handed to the app (a custom scheme was opened). */
    opened(event: DeepLinkEvent): boolean
  }
  /** Shell → host identity announcement (sent once per shell process). */
  hands: {
    /** Who this shell node is, and its environment. */
    hello(hello: HandsHelloWire): boolean
  }
}

/** Dialog options for message/ask. */
export type DialogOptions = {
  title?: string
  kind?: "info" | "warning" | "error"
  buttons?: "ok" | "okCancel" | "yesNo" | "yesNoCancel"
}

/** Pick-file options. */
export type PickFileOptions = {
  multiple?: boolean
  directory?: boolean
  save?: boolean
}

/** App metadata returned by `shell.app.info()`. */
export type AppInfo = {
  name: string
  version: string
  identifier: string
}

/** Well-known directory kinds for `shell.path.resolve`. */
export type PathKind = "config" | "data" | "cache" | "temp" | "home"

/**
 * The `hands` file primitives exposed by the shell (Rust).
 *
 * Mirrors `src-tauri/src/hands.rs`.
 *
 * ⚠ An earlier version of this comment said directory walking was "deliberately
 * ABSENT: the per-file cost is a full round trip, so batching belongs on the
 * brain side". That reasoning had a missing premise — it assumed the brain can
 * reach the filesystem. On a REMOTE hands (the case this whole capability
 * exists for) it cannot, so without `list` a caller cannot discover a single
 * filename. `transport-lab/FINDINGS.md` §6 measured batching for files whose
 * names were ALREADY KNOWN; §7.1 is the remote case.
 *
 * The split that holds: **enumerate** is a capability (only the shell can answer
 * it) and lives here; **match / sort / recurse / batch / retry** are policy, need
 * no filesystem access, and stay on the brain side.
 */
export type HandsSysAPI = {
  /** `null` for a missing path — "does not exist" is an answer, not an error. */
  stat(path: string): Promise<HandsStatWire | null>
  /**
   * A **stream reference**, not data. ⚠ Each yielded chunk arrives as a **base64
   * STRING**, not bytes: kkrpc's stock JSON codec has no binary form (measured in
   * `docs/probes/probe-host-streaming-channel.ts`). The decoding belongs to
   * `hands.ts`, which re-exposes `AsyncIterable<Uint8Array>`.
   */
  read(path: string, opts?: HandsReadOptions): AsyncIterable<unknown>
  /**
   * Consumes a stream and answers when it ends, so the reply is DEFERRED on the
   * Rust side: "how many bytes" is only knowable after the last chunk.
   */
  write(
    path: string,
    data: AsyncIterable<unknown>,
    opts?: HandsWriteOptions,
  ): Promise<HandsWriteResult>
  /** Also a stream reference; yields change records. */
  watch(path: string, opts?: HandsWatchOptions): AsyncIterable<unknown>
  /**
   * One directory's entries, as a stream of batches. **Not recursive, no
   * pattern argument** — see the note above; recursion and matching are the
   * caller's job.
   *
   * Streaming rather than a single reply because a directory's size is not
   * knowable before reading it, and an unbounded single frame is exactly what
   * measured as unusable at ≥1 MiB.
   */
  list(path: string, opts?: HandsListOptions): AsyncIterable<unknown>
}

/** One entry as the shell reports it. */
export type HandsListWire = {
  name: string
  /**
   * `symlink` is separate from `file`/`dir` on purpose: the listing describes
   * what is IN the directory, so a link is reported as a link rather than as its
   * target's type (the shell uses `symlink_metadata` for this).
   */
  kind: "file" | "dir" | "symlink" | "other"
  /** 0 for directories; for a symlink, the link's own length. */
  size: number
}

export type HandsListOptions = {
  /**
   * Entries per streamed batch. Bounded by the shell (1..4096); the default is
   * small because it is also the `stat` preview size.
   */
  batch?: number
}

/** One file's identity and size. Batch sizing and resume both need it. */
export type HandsStatWire = {
  size: number
  /**
   * Monotonic file identity, stable across `rename`. Empty string means the
   * filesystem could not report one (some network shares) — treat that as
   * "unknown", never as "same".
   */
  id: string
  mtimeMs: number
  kind: "file" | "dir" | "other"
  /**
   * A BOUNDED preview of a directory's entries.
   *
   * ⚠ Three states, and they are not interchangeable:
   * - `null` — not a directory (never an empty array; that would merge "a file"
   *   with "an empty directory")
   * - `{ items: [], truncated: false }` — an empty directory
   * - `{ items: [...], error: "..." }` — a directory that could not be read
   *   (execute-only permission). `stat` itself still succeeds, because size and
   *   mtime are still true; the failure is reported rather than swallowed.
   */
  entries?: HandsStatEntriesWire | null
}

export type HandsStatEntriesWire = {
  items: HandsListWire[]
  /** True when there are more entries than the preview; call `list` for all. */
  truncated: boolean
  /** Present only when the entries could not be read. */
  error?: string
}

export type HandsReadOptions = {
  /** Byte offset to start at. Resumption is exactly this — no separate method. */
  offset?: number
  chunkSize?: number
}

export type HandsWriteOptions = {
  /**
   * Start offset. Omitted = 0.
   *
   * ⚠ Combine with `truncate: false` to RESUME a transfer from the `endOffset`
   * a previous `read`/`write` reported. Leaving the default `truncate` on while
   * passing an offset cuts the file at that offset, which is almost never what a
   * resumer means.
   */
  offset?: number
  /**
   * Cut the file at the write position before writing. **Defaults to `true`.**
   *
   * ⚠ This default is the fix for a corruption, not a preference. It used to be
   * implemented as `mode: "create"`, which did NOT truncate while the contract
   * documented "overwrite from 0" — so rewriting a file with shorter content left
   * the old tail behind. Measured through a real peer: writing 11 bytes over a
   * 20-byte JSON file produced `{"alpha":9}"beta":2}`, invalid JSON, reported as
   * SUCCESS. Pass `false` when appending or resuming.
   */
  truncate?: boolean
  /**
   * Open with `O_APPEND` instead of seeking, so concurrent writers cannot lose
   * each other's writes. Mutually exclusive with `offset > 0` and with an
   * explicit `truncate: true`.
   */
  append?: boolean
}

export type HandsWatchOptions = {
  recursive?: boolean
}

export type HandsWriteResult = {
  /** Bytes THIS call wrote — not the resulting file size. */
  bytes: number
  /** Where the cursor now sits, which is what a resumer passes back as `offset`. */
  endOffset: number
  /**
   * Which intent the shell actually applied. Derived from the flags, not echoed
   * from an input field, so it reports what happened even when the caller passed
   * nothing.
   */
  mode: "truncate" | "overwrite" | "append"
}

/**
 * One change event from `hands.watch`.
 *
 * `path` is the path the **shell's** watcher reported, which on some platforms is
 * canonicalized (macOS resolves `/var` to `/private/var`). Do not compare it to a
 * caller-supplied string without normalizing both — that mistake silently
 * dropped every event on macOS.
 */
export type HandsChange = {
  kind: "create" | "modify" | "remove" | "replace"
  path: string
  id?: string
}

/**
 * The error codes the file primitives use, carried as a `CODE: detail` prefix on
 * the message because kkrpc's error frame only carries `{name, message}`.
 *
 * ⚠ `ESTALE` is deliberately distinct from `ENOENT`: after a rotation the path is
 * a DIFFERENT file (reopen and reset the offset), whereas a missing file usually
 * means give up. Opposite handling, so they must not collapse.
 */
export const HANDS_ERROR_CODES = [
  "ENOENT",
  "EACCES",
  "EISDIR",
  // The mirror of EISDIR, and separate for the same reason: "you asked for file
  // content on a directory" (read its entries instead) and "you asked for a
  // listing on a file" (stat it instead) need different fixes.
  "ENOTDIR",
  "ESTALE",
  "ENOSPC",
  "ECANCEL",
  "EUNSUPPORTED",
] as const
export type HandsErrorCode = (typeof HANDS_ERROR_CODES)[number]

/**
 * The hands → brain hello (`hands.hello`), sent once per shell process.
 *
 * # Why this exists
 *
 * The stdio channel used to be one-way in the identity sense: the brain
 * announced itself (`ready`, carrying the BRAIN's cwd/execPath/runtime) and the
 * shell said nothing, so every fact read from the shell arrived with no owner.
 * The brain could not tell which machine — or which process — it was talking to.
 *
 * Tagging each payload with a `source` field would be a per-field discipline: it
 * must be remembered everywhere, and one omission produces a value that looks
 * local but is not. Announcing identity ONCE binds the whole channel to a node
 * instead, so later facts belong to it by construction.
 *
 * ⚠ `launchId` is per-LAUNCH, not a durable device identity: the shell has no
 * persistence yet, so a stable id would change anyway. Durable per-device
 * identity is issue #13's problem (it needs credentials, not a random string).
 */
export type HandsHelloWire = {
  schemaVersion: number
  node: {
    /** Per-launch. Distinguishes two runs of the shell on this machine. */
    launchId: string
    platform: string
    arch: string
    family: string
    /** The shell build's own version — tells "upgraded" from "misbehaving". */
    shellVersion: string
  }
  /** Absolute path; empty when unavailable (see `cwdError`). */
  cwd: string
  /** Set when the cwd could not be read, so "" is not ambiguous. */
  cwdError: string | null
  /** The SHELL's home — the right base for expanding `~`, not the brain's. */
  home: string
  /**
   * The shell's environment.
   *
   * ⚠ Credential-shaped names are redacted to `"<redacted>"` by name. That
   * heuristic is partial and is a LOGGING aid, not a security boundary — on one
   * machine the brain already shares this environment.
   *
   * ⚠ This is the NODE's environment. The brain's own `process.env` is a
   * different thing as soon as the hands are remote, and the two must not be
   * conflated: same-looking key, different machine.
   */
  env: Record<string, string>
}

export type HandsHelloHandler = (hello: HandsHelloWire) => void

/**
 * Dev-watch event pushed host → shell → face (issue #11 wiring). This is a
 * #11-owned event shape (not a #7 lifecycle DTO): plain camelCase JSON, errors
 * reduced to strings so kkrpc JSON transport never sees Error objects.
 */
export type DevWatchPush = {
  type: string
  entryId?: string
  path?: string
  status?: string
  error?: string
  entries?: string[]
}

/**
 * Shell (Rust) API exposed to the host — the system capability surface.
 * Mirrors `src-tauri/src/shell_sys.rs` exactly; each nested member maps to a
 * dot-namespaced kkrpc method on the Rust side.
 *
 * Plugin access goes through the `ctx.shell` capability mirror (capability.ts),
 * which rebuilds these namespaces as cordis `Service`s so every call is
 * attributable; `ctx.notify`/`ctx.dialog`/`ctx.window`/`ctx.os` are the curated
 * equivalents. Adding a method here does not expose it by itself — the mirror
 * spec in capability.ts must list it too.
 */
export type ShellSysAPI = {
  ready(info: HostWsReady): Promise<void>
  shell: {
    notify(title: string, body: string): Promise<boolean>
    dialog: {
      message(text: string, opts?: DialogOptions): Promise<boolean>
      ask(text: string, opts?: DialogOptions): Promise<string>
      pickFile(opts?: PickFileOptions): Promise<string | string[] | null>
    }
    openUrl(url: string): Promise<boolean>
    openPath(path: string): Promise<boolean>
    reveal(path: string): Promise<boolean>
    shortcut: {
      register(accelerator: string): Promise<ShortcutRegistration>
      unregister(accelerator: string): Promise<ShortcutRegistration>
      isRegistered(accelerator: string): Promise<boolean>
    }
    window: {
      show(): Promise<boolean>
      hide(): Promise<boolean>
      minimize(): Promise<boolean>
      maximize(): Promise<boolean>
      unmaximize(): Promise<boolean>
      focus(): Promise<boolean>
      close(): Promise<boolean>
    }
    app: {
      info(): Promise<AppInfo>
      exit(code?: number): Promise<boolean>
    }
    path: {
      dir(): Promise<Record<PathKind, string>>
      resolve(kind: PathKind): Promise<string>
    }
    /** Fire-and-forget dev-watch event relay to the shell (which emits `dev-watch` to the face). */
    devWatchEvent(event: DevWatchPush): Promise<boolean>
    /**
     * Tray ingress (host → shell). `shell.tray.setSnapshot` mirrors
     * `src-tauri/src/shell_sys.rs`; the payload is the `TrayMenuSnapshot` from
     * contracts/tray-menu.schema.json and may only contain host/plugin-owned
     * groups.
     */
    tray: {
      setSnapshot(snapshot: TrayMenuSnapshot): Promise<TraySetSnapshotResult>
    }
    /**
     * Clipboard. Text only: the plugin also does images and HTML, but the brain's
     * use is user IDs / instance links / avatar URLs, and a narrower wire surface
     * is a smaller thing to keep honest.
     */
    clipboard: {
      writeText(text: string): Promise<boolean>
      /** `null` when there is nothing to read or the read failed — "" is a valid value. */
      readText(): Promise<string | null>
    }
    /** Cross-platform OS facts. Read as one object; eight routes would be eight partial reads. */
    os: {
      info(): Promise<OsInfo>
    }
    /**
     * Desktop-only routes. ABSENT on mobile rather than returning `{ok:false}`, so
     * a call there fails loudly ("unknown RPC method") instead of implying the OS
     * refused a request it never saw. Callers must handle their absence.
     */
    autostart?: {
      isEnabled(): Promise<boolean>
      setEnabled(enabled: boolean): Promise<{ ok: boolean; error?: string }>
    }
    deepLink?: {
      register(scheme: string): Promise<{ ok: boolean; scheme: string; error?: string }>
      isRegistered(scheme: string): Promise<boolean>
    }
  }
  /**
   * File primitives (M2 能力面). Registered by the shell unconditionally — unlike
   * the tray surface they have no Tauri dependency — so these are always present
   * on an attached shell. Plugin access goes through the `ctx.hands` service so
   * every call is attributable; this raw entry is the wire mirror.
   */
  hands: HandsSysAPI
}

/** Cross-platform OS facts (`shell.os.info`). */
export type OsInfo = {
  platform: string
  version: string
  family: string
  arch: string
  /** `null` when the OS cannot report a locale. */
  locale: string | null
  hostname: string
}

/**
 * A deep link the OS handed to the app (`deepLink.opened`).
 *
 * Desktop only: the shell registers no such route on mobile. `urls` is a list
 * because one activation can carry several — the plugin reports them together.
 */
export type DeepLinkEvent = {
  urls: string[]
}

/**
 * Host-facing view of the shell bridge.
 *
 * `tray.setSnapshot` is the same remote `shell.tray.setSnapshot` call, exposed
 * as a host-side namespace so the tray service has one dependency; `onAction`
 * is a purely local registration (the shell → host `tray.action` notification
 * arrives on the exposed API, not through the remote proxy).
 */
export type ShellTrayBridge = {
  setSnapshot(snapshot: TrayMenuSnapshot): Promise<TraySetSnapshotResult>
  onAction(handler: (action: TrayActionEvent) => void): () => void
}

/**
 * Host-facing view of the shortcut side of the shell bridge.
 *
 * `register`/`unregister` are the same remote `shell.shortcut.*` calls (so a
 * caller can drive them without holding the whole proxy); `onPress` is a purely
 * local registration — the shell → host `shortcut.pressed` notification arrives
 * on the exposed API, not through the remote proxy.
 */
export type ShellShortcutBridge = {
  register(accelerator: string): Promise<ShortcutRegistration>
  unregister(accelerator: string): Promise<ShortcutRegistration>
  onPress(handler: (event: ShortcutPressEvent) => void): () => void
}

/**
 * Host-facing view of the deep-link side of the shell bridge (desktop only).
 *
 * A purely local registration: `deepLink.opened` arrives on the exposed API, not
 * through the remote proxy.
 */
export type ShellDeepLinkBridge = {
  onOpen(handler: (event: DeepLinkEvent) => void): () => void
}

export type ShellStdioBridge = ShellSysAPI & {
  tray: ShellTrayBridge
  shortcut: ShellShortcutBridge
  /** Desktop only; the shell registers no such notification on mobile. */
  deepLink: ShellDeepLinkBridge
  /**
   * Who the shell is, and its environment (`hands.hello`).
   *
   * `onHello` fires for every hello (normally once per shell process — a restart
   * is a new process and therefore a new hello). `currentHello()` returns the one
   * already received, which is what a LATE subscriber needs: a once-per-process
   * announcement would otherwise be missed forever by anything registering after
   * it arrived.
   */
  handsHello: ShellHandsHelloBridge
  /**
   * Whether a write to the shell has already failed (EPIPE). See
   * `withWriteFailureObserver` for why the sending-side signal needs its own
   * detector. Always `false` for a test-supplied transport, which owns its
   * streams and has no real pipe to break.
   */
  sawWriteFailure: () => boolean
}

/** Local access to the shell's hello (`hands.hello`). */
export type ShellHandsHelloBridge = {
  /** Subscribe. Returns an unsubscribe function. */
  onHello(handler: HandsHelloHandler): () => void
  /** The most recent hello, or `undefined` if none has arrived yet. */
  currentHello(): HandsHelloWire | undefined
}

/**
 * A local handler set for a shell → host notification.
 *
 * `tray.action` and `shortcut.pressed` both arrive on the exposed API and must
 * fan out to every local subscriber without one throwing handler breaking the
 * RPC channel. One implementation, so the two cannot drift apart.
 */
function fanout<T>(label: string) {
  const handlers = new Set<(value: T) => void>()
  return {
    on(handler: (value: T) => void): () => void {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    emit(value: T): void {
      for (const handler of [...handlers]) {
        try {
          handler(value)
        } catch (error) {
          console.error(`[host] ${label} handler error`, error)
        }
      }
    },
  }
}

/**
 * The host's stdio transport — the upstream one, unmodified.
 *
 * kkrpc's `nodeStdioTransport()` uses `process.stdin` directly as the readable
 * and auto-wires `lifecycle` to it. That is the whole point: `RPCChannel`
 * subscribes internally (`readable.on("data")`), which is what resumes stdin,
 * and only a flowing stdin emits `end`/`close` — so `onClose` actually fires.
 *
 * Why the previous hand-rolled shape could never deliver `onClose` (measured
 * exhaustively; see `docs/probes/stdio-lifecycle/FINDINGS.md`):
 *
 *   1. `lifecycle` alone never unpauses stdin. `process.stdin` is a paused
 *      `ReadStream`; `on("end")`/`on("close")`/`on("error")` — exactly what
 *      kkrpc's `lifecycle` attaches — leave `readableFlowing === null`. Only
 *      `on("data")` resumes it, and a paused stdin never emits end/close.
 *   2. Holding `Bun.stdin.stream().getReader()` locks the SAME native readable
 *      (`process.stdin !== Bun.stdin.stream()`, but coupled natively), so every
 *      rescue route — including `process.stdin.resume()` — THROWS
 *      `ERR_INVALID_STATE: ReadableStream is locked`.
 *
 * Do NOT reintroduce a `Bun.stdin.stream()` reader here. `watchStdinClose()` in
 * stdin-watch.ts takes that reader for the shell-less case, and the two are
 * mutually exclusive in BOTH orderings (measured).
 *
 * ASYMMETRY worth knowing before reading `connectShellStdio`: this transport
 * takes stdin's reader UNCONDITIONALLY once constructed — `RPCChannel`
 * subscribes on construction, and that subscription (`readable.on("data")`) is
 * precisely what puts stdin into flowing mode at all. Only the STOP is gated, on
 * `stdinIsPeerChannel()`. So a `VRCXK_SHELL=1` host whose fd 0 is not a pipe
 * (the null device, a TTY, a redirected file) still has no self-stop path: the
 * transport holds the reader and nothing acts on the close. That is unchanged
 * from before this transport swap — the old pump's `onDone` sat behind the
 * identical guard — so it is a pre-existing limitation, not a regression. It is
 * simply sharper now that the reader is always taken.
 *
 * The transport's `onClose` is wired to the stop path in `connectShellStdio`.
 * It first REJECTS every pending request (`handleTransportClose`), which is why
 * `bootstrap` treats a failed `shell.ready` as an expected outcome rather than a
 * fatal error — see the comment there.
 */
function bunStdioTransport() {
  return nodeStdioTransport()
}

/**
 * A transport that RECORDS write failures and otherwise behaves identically.
 *
 * WHY THIS EXISTS: kkrpc reports "the peer is gone" through two independent
 * paths, and the official transport only surfaces the first:
 *
 *   1. the read side ends  -> `handleTransportClose` rejects pending calls with
 *      `RPCTransportClosedError`, and `onClose` fires (probe 15, cells A–D);
 *   2. a WRITE fails (EPIPE) -> `handleWriteFailure` rejects the matching call
 *      with the raw write error, and `onClose` does NOT fire, because the read
 *      side is still healthy and nothing ended it (probe 16, cell E — measured).
 *
 * Case 2 is the same physical event seen from the sending side, and it is the
 * one that matters at startup: `ready` is the FIRST frame the host writes, so a
 * shell that dies just before/while we announce ourselves can only be noticed
 * this way.
 *
 * The observer is deliberately PASSIVE: it re-throws unchanged, so kkrpc still
 * rejects the pending call and the existing control flow is untouched. Swallowing
 * the error here would convert a fast failure into a 30-second timeout, which is
 * strictly worse. Verified: the call still rejects with the same plain Error and
 * a healthy transport records nothing (probe 18).
 *
 * Detecting EPIPE is safe to read as "peer gone": a write to a pipe whose reader
 * is alive-but-idle blocks or buffers rather than failing, so the error only
 * appears once every read end is closed (measured — probe 18).
 */
export function withWriteFailureObserver(inner: Transport<RPCMessage>) {
  const state = { failed: false }
  // Derive the parameter list from the interface rather than naming
  // `Transferable` directly: that type lives in the DOM lib, which the host's
  // tsconfig (correctly) does not include.
  type SendArgs = Parameters<NonNullable<Transport<RPCMessage>["send"]>>
  const transport: Transport<RPCMessage> = {
    ...inner,
    send(...args: SendArgs) {
      const result = inner.send?.(...args)
      if (result instanceof Promise) {
        return result.catch((error: unknown) => {
          state.failed = true
          throw error
        })
      }
      return result
    },
  }
  return { transport, state }
}

/**
 * Connect the host to the Rust shell over kkrpc/stdio.
 *
 * `expose` is the host API the shell can call (ping/stop/restart + the
 * `tray.action` and `shortcut.pressed` notifications); the returned bridge is
 * the shell's API the host can call (ready + shell.*, plus the local
 * `tray.onAction` / `shortcut.onPress` registrations).
 *
 * stop/restart run a real graceful fiber teardown before exiting — M1-3
 * issue #8: dispose fibers in reverse order, then exit 0 (stop) or 51
 * (restart).
 *
 * `options.transport` exists for tests (an in-memory transport pair); the
 * default is the real bun stdio transport.
 */
export function connectShellStdio(
  ctx: Context,
  options: { transport?: Transport<RPCMessage> } = {},
): ShellStdioBridge {
  const trayActions = fanout<TrayActionEvent>("tray.action")
  const shortcutPresses = fanout<ShortcutPressEvent>("shortcut.pressed")
  const deepLinks = fanout<DeepLinkEvent>("deepLink.opened")
  // Separate from the others because it is ONCE per shell process, not an event
  // stream: a late subscriber would otherwise miss it forever. `currentHello`
  // holds the last one so `onHello` can answer immediately — the same reason
  // `ShellHandle` remembers the tray snapshot rather than only fanning it out.
  const hellos = fanout<HandsHelloWire>("hands.hello")
  let currentHello: HandsHelloWire | undefined
  // #33: EOF on the shell's stdin channel means the shell is gone. Its
  // ProcessTree Job Object would hard-reap us anyway — this turns that into the
  // same graceful teardown the stop RPC uses. Only a peer channel (pipe on
  // Windows, socketpair on POSIX — see stdin-watch.ts) carries that meaning; a
  // test-supplied transport owns unrelated streams.
  //
  // `onClose` is the sole peer-death trigger for the shell-attached path. It
  // carries a `reason`, but read that as OBSERVABILITY ONLY — it is not a
  // behaviour switch:
  //
  //   - The ternary below only picks a log line; nothing branches on it.
  //   - kkrpc maps a stream `error` to the error object, but that arm has never
  //     been observed here. On Windows a clean exit (FIN) and an abrupt one
  //     (RST) are INDISTINGUISHABLE at the reader, so in practice `reason` is
  //     always `undefined` (measured, both teardowns — FINDINGS.md §3.3). Do not
  //     build "the shell crashed vs exited" logic on it.
  //
  // It is still a real improvement over the old boolean callback: one signal
  // instead of two, and it can in principle say why.
  const usesDefaultTransport = options.transport === undefined
  const watchStdinLoss = usesDefaultTransport && stdinIsPeerChannel()
  // Wrap the real transport so a WRITE failure is observable. Without this the
  // sending-side death signal (EPIPE) is invisible: `onClose` watches the read
  // side and stays silent, so the only trace would be a bare rejection from
  // `shell.ready` that nothing distinguishes from a genuine startup error.
  // A test-supplied transport is used as-is — it owns its streams.
  const observed = usesDefaultTransport ? withWriteFailureObserver(bunStdioTransport()) : undefined
  // Narrow once, so neither consumer below needs a non-null assertion: either we
  // built the observed wrapper (default transport) or the caller supplied one.
  // The guard is a real check, not a formality — a caller that passes an
  // explicit `undefined` would otherwise reach RPCChannel with no transport.
  const transport = observed ? observed.transport : options.transport
  if (!transport) {
    throw new TypeError("host stdio: no transport available (neither default nor supplied)")
  }
  // `StreamingRPCChannel`, not the base `RPCChannel`, so this ONE channel can
  // carry the `hands.*` stream frames (`t:"sq"` / `t:"sr"`) as well as ordinary
  // RPC. The base channel has no stream routing at all — measured: the compiled
  // `channel-*.js` contains zero occurrences of either tag — so a stream frame
  // would be silently dropped and `hands.read` could never arrive.
  //
  // Streaming is a strict superset here: `StreamingRPCChannel extends RPCChannel`
  // and both directions of ordinary request/response were verified unchanged
  // through it (nested namespaces, `expose`, and a test-supplied transport), see
  // docs/probes/probe-host-streaming-channel.ts (6/6) and
  // docs/hands-host-design.md §1. The added cost is per-stream state, which is
  // why the base channel remains right for the face⇄brain ws path.
  const channel = new StreamingRPCChannel<HostStdioAPI, ShellSysAPI>(transport, {
    onClose: watchStdinLoss
      ? (reason) => {
          console.error(
            reason
              ? `[host] shell stdio broke (${reason.name}: ${reason.message}) — graceful shutdown`
              : "[host] shell closed its stdio — graceful shutdown",
          )
          void stopOnStdinLoss(ctx, "shell")
        }
      : undefined,
    expose: {
      ping: () => hostWsAPI.ping(),
      stop: async () => {
        console.error("[host] stop requested — graceful shutdown")
        const acquired = await gracefulStopWithTimeout(ctx, "stop")
        if (!acquired) {
          // A shutdown is already in progress (e.g. dev-watch restart
          // requester); the first trigger owns the exit. Do not exit 0 here —
          // the process is already leaving (0 or 51).
          return true
        }
        setTimeout(() => process.exit(0), 10)
        return true
      },
      restart: async () => {
        console.error("[host] restart requested — graceful shutdown then exit 51")
        const acquired = await gracefulStopWithTimeout(ctx, "restart")
        if (!acquired) {
          // Already shutting down; the first trigger owns the exit.
          return true
        }
        setTimeout(() => process.exit(HOST_RESTART_EXIT), 10)
        return true
      },
      tray: {
        // `tray.action` (shell → host): fan out to every registered handler.
        // A handler throwing must never break the RPC channel.
        action: (action: TrayActionEvent) => {
          trayActions.emit(action)
          return true
        },
      },
      shortcut: {
        // `shortcut.pressed` (shell → host, issue #6 callback): the shell
        // already filtered to registered chords and key-down edges.
        pressed: (event: ShortcutPressEvent) => {
          shortcutPresses.emit(event)
          return true
        },
      },
      deepLink: {
        // `deepLink.opened` (shell → host, desktop only): the OS handed the app
        // one or more URLs. The shell only proves they arrived — the brain owns
        // what a URL means.
        opened: (event: DeepLinkEvent) => {
          deepLinks.emit(event)
          return true
        },
      },
      hands: {
        // `hands.hello` (shell → host): who the shell is, and its environment.
        // Sent once per shell process, right after the reader starts.
        //
        // Registered as a NOTIFICATION target, not a request: the shell does not
        // wait for an answer, so a brain too old to know this method just logs an
        // unknown call and carries on. That is what makes the two sides
        // deployable independently.
        hello: (hello: HandsHelloWire) => {
          // Remember before emitting: a subscriber registered later must still be
          // able to learn who the shell is (see `currentHello`).
          currentHello = hello
          hellos.emit(hello)
          return true
        },
      },
    },
  })
  const remote = channel.getAPI()
  // Build the bridge explicitly. The remote proxy is function-shaped and its
  // `set` trap turns property assignment into an RPC, so own properties must
  // NOT be added on top of it (Object.create(remote) + `bridge.tray = ...`
  // silently sends a "set" frame and leaves `tray` undefined).
  return {
    ready: (info) => remote.ready(info),
    shell: remote.shell,
    // The file primitives are reached through the same remote proxy. Re-exported
    // here so `HandsService` has one dependency and plugins never touch the raw
    // wire surface for file access.
    hands: remote.hands,
    handsHello: {
      onHello: (handler) => hellos.on(handler),
      currentHello: () => currentHello,
    },
    tray: {
      setSnapshot: (snapshot) => remote.shell.tray.setSnapshot(snapshot),
      onAction: (handler) => trayActions.on(handler),
    },
    shortcut: {
      register: (accelerator) => remote.shell.shortcut.register(accelerator),
      unregister: (accelerator) => remote.shell.shortcut.unregister(accelerator),
      onPress: (handler) => shortcutPresses.on(handler),
    },
    deepLink: {
      onOpen: (handler) => deepLinks.on(handler),
    },
    /**
     * Whether a write to the shell has already failed. Bootstrap consults this
     * when `ready` rejects: a rejection that coincides with a failed write is
     * the sending-side "shell is gone" signal (exit 52), NOT a startup fault.
     */
    sawWriteFailure: () => observed?.state.failed ?? false,
  }
}
