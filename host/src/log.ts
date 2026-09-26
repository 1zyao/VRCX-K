// Host logging. Everything goes to stderr, PLUS a rotating file when the shell
// tells us where to put one.
//
// ⚠ WHY A FILE IS NOT OPTIONAL. `#24`'s whole honest scope is "undeclared access
// becomes VISIBLE instead of silent". For a long time this module wrote only to
// stderr — and in a RELEASE build the shell is `windows_subsystem = "windows"`
// (`src-tauri/src/main.rs`), so there is no console and the host is spawned with
// `stderr(Stdio::inherit())` into a handle that leads nowhere. Every `[cap]`
// audit line and every overreach warning was written and discarded: the feature
// promised visibility and delivered none. The shell now passes `VRCXK_LOG_DIR`
// (it owns the app data directory; a sidecar must not guess it), and this module
// appends there as well.
//
// The file is the DELIVERY channel; stderr stays because it is what a developer
// running the host by hand actually reads, and dropping it would make local work
// worse to fix a production problem.
//
// Rotation is by SIZE and keeps a fixed number of files. A log that grows without
// bound is a disk-space bug in a long-lived desktop app — the same class of
// mistake as `Buffer.alloc(fileSize)`, which this repo already has a rule against.

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { format } from "node:util"

/** Base name of the log file inside `VRCXK_LOG_DIR`. */
const LOG_FILE = "host.log"
/** Rotate once the file passes this size. Small enough to attach to a report. */
const MAX_BYTES = 2 * 1024 * 1024
/** How many rotated files to keep (`host.log.1` … `host.log.N`). */
const KEEP = 3

let target: string | undefined
let resolved = false

/**
 * Resolve the log path once, and create the directory.
 *
 * `VRCXK_LOG_DIR` absent means "no file logging" — the correct state in dev and
 * in tests, where stderr is readable. That is NOT an error and must never be
 * reported as one.
 */
function logPath(): string | undefined {
  if (resolved) return target
  resolved = true
  const dir = process.env.VRCXK_LOG_DIR
  if (!dir) return undefined
  try {
    mkdirSync(dir, { recursive: true })
    target = join(dir, LOG_FILE)
  } catch {
    // An unwritable log directory must not take the host down: logging is a
    // diagnostic, and a host that refuses to start because it cannot log has
    // traded a small problem for a total one.
    target = undefined
  }
  return target
}

/**
 * Our best knowledge of the log file's current size, or `undefined` if unknown.
 *
 * `rotate` used to call `statSync` on EVERY line. That is worth removing on its own
 * terms — it is one syscall per line to answer a question whose answer changes by
 * a few hundred bytes — but ⚠ **do not credit it with more than it is worth**:
 * measured A/B at a fixed line count, caching the size saved **~23%**
 * (24000 lines: 4288 ms → 3316 ms). It is NOT what made the Windows CI test time
 * out; see the note on the rotation test in `host/tests/host-log.test.ts`, where
 * the real cost is per-line work × line count.
 *
 * Tracking the size in-process is EXACT, not an approximation, because this module
 * is the only writer of this file and every write goes through `write` below.
 * `undefined` means "we have not looked yet" — the first write of a process stats
 * once to learn the existing size, and after a rotation we stat once more. So the
 * steady state is one `statSync` per `MAX_BYTES`, not one per line.
 */
let knownSize: number | undefined

/** Rotate `host.log` → `.1` → `.2` … keeping the newest `KEEP` files. */
function rotate(path: string): void {
  if (knownSize === undefined) {
    try {
      knownSize = statSync(path).size
    } catch {
      knownSize = 0 // No file yet: the next append creates it.
    }
  }
  if (knownSize < MAX_BYTES) return
  try {
    rmSync(`${path}.${KEEP}`, { force: true })
    for (let index = KEEP - 1; index >= 1; index -= 1) {
      try {
        renameSync(`${path}.${index}`, `${path}.${index + 1}`)
      } catch {
        // That generation does not exist yet — normal until the log fills.
      }
    }
    renameSync(path, `${path}.1`)
    knownSize = 0
  } catch {
    // Rotation is best-effort. Losing a rotation is better than losing the write.
    knownSize = undefined // Resync from the filesystem on the next line.
  }
}

/** One line, timestamped so a support bundle can be ordered. */
function write(line: string): void {
  const stamped = `${new Date().toISOString()} ${line}\n`
  console.error(line)
  const path = logPath()
  if (!path) return
  try {
    rotate(path)
    appendFileSync(path, stamped)
    if (knownSize !== undefined) knownSize += Buffer.byteLength(stamped)
  } catch {
    // See above: never let logging break the host.
    knownSize = undefined
  }
}

console.log = (...args: unknown[]) => {
  write(format(...args))
}
console.info = (...args: unknown[]) => {
  write(format(...args))
}
console.debug = (...args: unknown[]) => {
  write(format(...args))
}

/**
 * The log function the rest of the host uses.
 *
 * ⚠ Formats with `node:util.format`, NOT `args.join(" ")`. The original patch
 * called `console.error("[host]", ...args)`, which means a caller writing
 * `log("%s failed", id)` gets Node's format substitution. A naive join would
 * print the literal `%s` instead — silently changing the output of every call
 * site that uses a specifier. `format` keeps the exact previous behaviour while
 * letting the same string reach the file.
 *
 * ⚠ Keeps the `[host]` prefix on stderr for compatibility with everything that
 * greps it (tests, CI, the docs), while the FILE gets a timestamped line. That
 * split is deliberate: stderr is read live by a human, the file is read later by
 * someone who needs to know WHEN.
 */
export function log(...args: unknown[]): void {
  write(`[host] ${format(...args)}`)
}

/**
 * Log an **unredacted** line: stderr gets the full text, the FILE gets a redacted
 * one.
 *
 * ⚠ WHY THIS SPLIT EXISTS AT ALL, because "redact only the file" sounds like a
 * loophole and is not one.
 *
 * The two consumers are different in kind:
 *
 *   - **stderr** is a live, in-process channel to whoever SPAWNED us — in
 *     production that is the Rust shell over an inherited handle
 *     (`stderr(Stdio::inherit())` in `src-tauri/src/host.rs`), and in dev and in
 *     tests it is a human or a harness. Nothing is persisted.
 *   - **the FILE** is a rotating artifact on disk whose stated purpose (see this
 *     module's header) is to be small enough to attach to a support report. It
 *     outlives the session and it travels.
 *
 * The leak this function exists to close is the FILE, and the value that must
 * travel on stderr is the `ready` handshake's `token`: it is the credential the
 * FACE needs to open the host's ws surface, and
 *
 *   - the Rust shell never consumes it (it reads the handshake off kkrpc stdio
 *     and logs `token_len`, never the value — see `src-tauri/src/host.rs`'s
 *     `"[shell] host ready port={} token_len={}"`), but
 *   - the host's OWN integration tests do: `host/tests/helpers.ts#readReady`
 *     scrapes stderr, and `ws-heartbeat` / `stdin-loss` / `compile-smoke` /
 *     `sidecar-smoke` then CONNECT with that token. A redacted stderr breaks all
 *     four, and rewriting four tests to reach the token some other way would mean
 *     inventing a channel that does not exist in production.
 *
 * So the honest arrangement is: the value is available on the ephemeral local
 * channel that already carried it, and it is removed from the durable one. This
 * is NOT a security boundary and must not be described as one — anyone who can
 * read the host's stderr can already read its memory. It is the difference
 * between "a secret is in a file that gets emailed" and "a secret was on a pipe".
 *
 * ⚠ `redacted` is built EAGERLY by the caller rather than passed as a transform,
 * so a formatter bug cannot silently skip it: the argument has already been
 * computed by the time this function runs.
 */
export function logWithSecret(redacted: string, secret: string): void {
  // stderr: the full line, exactly as before this function existed.
  console.error(`[host] ${secret}`)
  // The file: the redacted one, through the normal path so rotation, stamping and
  // the size bookkeeping all stay in one place.
  const path = logPath()
  if (!path) return
  const stamped = `${new Date().toISOString()} [host] ${redacted}\n`
  try {
    rotate(path)
    appendFileSync(path, stamped)
    if (knownSize !== undefined) knownSize += Buffer.byteLength(stamped)
  } catch {
    // Same rule as `write`: never let logging break the host.
    knownSize = undefined
  }
}

/** Absolute path of the log file, or `undefined` when file logging is off. */
export function hostLogPath(): string | undefined {
  return logPath()
}

/**
 * The placeholder that replaces a secret before it reaches a log.
 *
 * ⚠ Deliberately NOT token-shaped. A 64-hex-character stand-in would make "there
 * is no `[0-9a-f]{64}` anywhere in the log file" impossible to assert, and that
 * assertion is what `host/tests/startup-log.test.ts` uses as its leak check.
 */
export const REDACTED = "<redacted>"

/**
 * Replace every value of a credential-shaped key, keeping the key and the shape.
 *
 * ⚠ WHY A KEY-NAME RULE AND NOT A VALUE-SHAPE RULE. The value this exists for is
 * the `ready` handshake's `token`: 32 random bytes as lowercase hex, i.e. 64
 * characters that look exactly like a git SHA, a file id or a hash. There is no
 * way to recognise it BY VALUE without also redacting things a log genuinely
 * needs. So the rule is the one the shell already uses for the environment it
 * forwards (`src-tauri/src/hands_hello.rs` redacts by name), and for the same
 * reason: a name is something an author chooses, and a chosen name can be checked.
 *
 * ⚠ This is a LOGGING aid, not a security boundary, and it must not be described
 * as one. It catches a field that someone logs by the name we agreed on; it cannot
 * catch ``log(`token=${ready.token}`)`` — a template string has no field name left
 * to match. That limit is why the call site does NOT rely on this as a filter:
 * `index.ts` builds the redacted handshake EXPLICITLY (`token: REDACTED` plus
 * `redactUserPath` on each path), so the secret is gone by construction rather
 * than by a pattern that could miss. This function is for the remaining case —
 * a whole object being logged — and is applied at that point if and when one
 * appears. It is exported so that call site can use it rather than re-inventing a
 * key list; it is deliberately NOT wired into `log()` itself, because silently
 * rewriting every argument of every log call would redact legitimate diagnostics
 * and make the log lie in a new way.
 *
 * The key match is case-insensitive and ANCHORED on the words that name a secret
 * in this codebase, not on a substring — `tokenCount` and `tokenizerId` are
 * ordinary fields, and redacting them would silently blank out numbers a reader
 * needs while looking like the feature working.
 */
export function redactForLog(value: unknown): unknown {
  return redactValue(value, 0)
}

/** Keys whose value is a secret and must never reach a log line. */
const SECRET_KEY = /^(token|secret|password|passwd|credential|credentials|api[_-]?key|auth)$/i

/**
 * How deep [redactForLog] will walk.
 *
 * ⚠ A depth bound, not a size bound, because the danger here is a CYCLE: a
 * redactor that walks an object graph can be handed one that points back at
 * itself, and the failure is an unbounded recursion rather than a wrong log line.
 * The handshake being redacted is three levels deep, so this is generous.
 */
const REDACT_MAX_DEPTH = 6

function redactValue(value: unknown, depth: number): unknown {
  if (depth >= REDACT_MAX_DEPTH) return value
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1))
  if (value === null || typeof value !== "object") return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : redactValue(item, depth + 1)
  }
  return out
}

/**
 * Drop the user-identifying segment of an absolute path, keeping its tail.
 *
 * ⚠ WHY A PATH NEEDS ITS OWN RULE. The `ready` handshake carries the host's `cwd`
 * and `execPath` as REQUIRED fields, and on Windows those begin with the user's
 * account name. A support bundle is a file that gets emailed, so
 * `C:\Users\anna\…` in it is a disclosure — but the path's TAIL is the whole
 * diagnostic: this repo has a recorded 2026-09 incident where a sidecar launched
 * with the wrong cwd died on a missing `cordis.yml`, and the log line is what
 * named it. Blanking paths wholesale would trade that away for a directory name.
 *
 * The rule is therefore segment-based rather than name-shaped: only the KNOWN
 * containers (`Users`, `home`) are treated as personal, and only the ONE segment
 * after them is dropped. A name-shaped heuristic would be both over-inclusive
 * (redacting an ordinary directory called `data`) and under-inclusive (missing a
 * profile under a non-English spelling of "users").
 *
 * ⚠ THE CONTAINER MUST SIT AT THE ROOT — index 1, i.e. directly under the volume
 * or the leading `/`. That restriction is not tidiness; it is what stops the rule
 * from eating ordinary system directories. Measured: without it, `/opt/home/data`
 * (where macOS keeps Homebrew) was rewritten to `…/home/…`, which is a path that
 * does not exist and says nothing about where the host ran. Every real profile
 * shape does put the container there — `C:\Users\anna` (index 1, after the drive)
 * and `/home/anna` / `/Users/anna` (index 1, after the empty root segment) — so
 * the restriction costs no coverage.
 *
 * ⚠ ACCEPTED LIMIT, stated rather than discovered later: a UNC path such as
 * `\\server\Users\anna` puts the container at index 3 and is therefore NOT
 * redacted here. The host's `cwd`/`execPath` are local-process facts and this
 * project's own launch path (`resolve_host_launch`) never produces a UNC root,
 * so covering it would mean a more permissive rule to guard a case that cannot
 * currently arise — a worse trade for the common paths above.
 *
 * `…` marks the elision explicitly, so a reader cannot mistake the result for a
 * real absolute path that simply does not exist.
 */
export function redactUserPath(path: string): string {
  if (!path) return path
  // Both separators: a Windows path can arrive with forward slashes, and
  // `execPath` is backslash-separated while a `file://`-derived cwd may not be.
  // One separator would miss half the cases on the platform this ships to.
  const parts = path.split(/[\\/]+/)
  // See above: the container is only treated as personal in the root position.
  const container = parts[1]
  // No container, or the container IS the last segment (so there is no user name
  // after it): nothing to elide, and inventing one would be worse than leaving it.
  if (container !== "Users" && container !== "home") return path
  if (parts.length < 3) return path
  // Skip the root, the container AND the name; keep everything below the user's
  // own directory, which is where the diagnostic value lives.
  const kept = parts.slice(3)
  return kept.length > 0 ? `…/${container}/…/${kept.join("/")}` : `…/${container}/…`
}
