export const HOST_VERSION = "0.0.1"
export const HOST_RESTART_EXIT = 51

/**
 * The host tore down cooperatively because the shell became unreachable while
 * the startup handshake was still in flight.
 *
 * Why a dedicated code instead of 0 or 1 — both are actively wrong here:
 *
 *   - NOT 0: the handshake never completed, so the shell never learned our ws
 *     port and the app did not start. Exiting 0 would report a clean stop for a
 *     startup that failed. (`stopOnStdinLoss` uses 0 legitimately, because by
 *     then the shell and host have already agreed on a session.)
 *   - NOT 1: the shell's `classify_watch` treats every code except 51 as
 *     `Crashed` and feeds it to the restart-storm counter. Eight of those inside
 *     the stable window park the host in `Failed` permanently — punishing it for
 *     a failure that was never its own. `docs/shutdown-strategy-review.md` §5.4
 *     already ruled that `exit(1)` must be avoided for exactly this reason; this
 *     constant is that ruling's missing implementation.
 *
 * The shell maps it to a distinct, non-crash outcome and relaunches without
 * counting it against the storm budget. Must stay in step with
 * `HOST_STDIO_LOST_EXIT` in `src-tauri/src/host.rs`, which asserts the value.
 */
export const HOST_STDIO_LOST_EXIT = 52

export type HostWsAPI = {
  ping(): Promise<string>
  getVersion(): Promise<string>
  /**
   * Deep-link administration for the FACE (issue #41 §7.1 item 2).
   *
   * ⚠ Why the undo is here and not on `ctx.deepLink`: a cordis service is readable by
   * every plugin (inject gates readiness, not access), so a method there is a
   * plugin-visible capability. The owner's decision is "selective exposure" — the face
   * may undo, a plugin may not — and the ws API is the surface the face already uses for
   * `ping`/`getVersion`. The shell bounds what this can do: declared names only, and it
   * never removes a key it does not own.
   */
  deepLink: {
    /** Undo a registration under a name this build declares. */
    unregister(scheme: string): Promise<DeepLinkAdminOutcome>
  }
}

/**
 * The face-facing outcome of an undo attempt.
 *
 * `absent` is a success: asking "make sure this is not registered" twice is legitimate.
 * `no-shell` and `unsupported` are deliberately distinct — "there is no host to ask" and
 * "the shell said no" need different words in a UI.
 */
export type DeepLinkAdminOutcome =
  | { status: "removed" }
  | { status: "absent" }
  | { status: "unsupported"; error: string }
  | { status: "no-shell" }

/**
 * The bridge-backed implementation, bound when a shell attaches.
 *
 * ⚠ Not a `ctx` lookup: `hostWsAPI` is created at module load, before any shell exists,
 * and the shell can be replaced (a restart) or absent (a dev host) — so the live handler
 * is a module-level binding rather than a captured reference.
 */
type DeepLinkAdmin = { unregister(scheme: unknown): Promise<DeepLinkAdminOutcome> }

let deepLinkAdmin: DeepLinkAdmin | undefined

/** Bind (or clear, with `undefined`) the handler `hostWsAPI.deepLink` delegates to. */
export function bindDeepLinkAdmin(next: DeepLinkAdmin | undefined): void {
  deepLinkAdmin = next
}

export const hostWsAPI: HostWsAPI = {
  async ping() {
    return "pong"
  },
  async getVersion() {
    return HOST_VERSION
  },
  deepLink: {
    async unregister(scheme) {
      if (!deepLinkAdmin) return { status: "no-shell" }
      return deepLinkAdmin.unregister(scheme)
    },
  },
}
