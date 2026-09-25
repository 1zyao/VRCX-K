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

/** Rotate `host.log` → `.1` → `.2` … keeping the newest `KEEP` files. */
function rotate(path: string): void {
  try {
    if (statSync(path).size < MAX_BYTES) return
  } catch {
    return // No file yet, or unreadable: nothing to rotate.
  }
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
  } catch {
    // Rotation is best-effort. Losing a rotation is better than losing the write.
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
  } catch {
    // See above: never let logging break the host.
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

/** Absolute path of the log file, or `undefined` when file logging is off. */
export function hostLogPath(): string | undefined {
  return logPath()
}
