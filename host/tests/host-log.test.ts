// The host log file — the ONLY delivery channel for `#24`'s warnings in a
// release build.
//
// ⚠ WHY THIS TEST EXISTS. `#24`'s stated honest scope is "undeclared access
// becomes VISIBLE instead of silent". The warn goes to `log()` → stderr, and in a
// release build the shell is `windows_subsystem = "windows"` with no console, so
// stderr reaches nothing. Every audit line was written and discarded. The file is
// what makes the promise true, so the file is what gets pinned here.
//
// ⚠ These tests must spawn a CHILD process rather than import `log.ts` directly:
// the module resolves `VRCXK_LOG_DIR` exactly once (`resolved` flag) and caches
// the target, which is correct for a host that reads it once at startup. A test
// that set the variable and imported in-process would be measuring module cache
// state, not the behaviour. Spawning also mirrors production, where the SHELL
// passes the variable to the sidecar.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vrcxk-log-"))
  roots.push(dir)
  return dir
}

/**
 * The `log.ts` module as an import specifier for a generated snippet.
 *
 * ⚠ `pathToFileURL`, not `JSON.stringify(join(...))`. On Windows `join` produces
 * BACKSLASHES, and a `file:///E:\...` URL is invalid — worse, quoting a
 * backslash path into a `.ts` file makes each `\` an escape sequence in the
 * string literal. A generated child then fails to import and exits with an empty
 * stdout, which reads like "the module is broken" rather than "the specifier is
 * malformed". `pathToFileURL` gives a correct `file:///E:/...` URL on every
 * platform.
 */
function logModuleUrl(): string {
  return pathToFileURL(join(import.meta.dir, "..", "src", "log.ts")).href
}

/** Run a snippet with `VRCXK_LOG_DIR` set, in a child, and return its streams. */
function runWithLogDir(
  logDir: string,
  snippet: string,
): { stdout: string; stderr: string; exitCode: number } {
  const entry = join(logDir, "entry.ts")
  writeFileSync(entry, `import { log } from ${JSON.stringify(logModuleUrl())}\n${snippet}\n`)
  const proc = Bun.spawnSync(["bun", entry], {
    env: { ...process.env, VRCXK_LOG_DIR: logDir },
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode,
  }
}

describe("the host log file", () => {
  test("a log line reaches BOTH stderr and the file", () => {
    // Both, not either: stderr is what a developer running the host by hand
    // reads, the file is what survives a release build with no console.
    const dir = tempDir()
    const { stderr, exitCode } = runWithLogDir(dir, `log("a-capability-line")`)
    expect(exitCode).toBe(0)
    expect(stderr).toContain("a-capability-line")

    const file = join(dir, "host.log")
    const contents = readFileSync(file, "utf8")
    expect(contents).toContain("a-capability-line")
    // The file is timestamped so a support bundle can be ordered; stderr is not,
    // because a live reader does not need ISO strings in their terminal.
    expect(contents).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /m)
  })

  test("a %s specifier is substituted, not printed literally", () => {
    // ⚠ The regression guard for the `format` choice. The original patch replaced
    // `console.error("[host]", ...args)` with a plain `join(" ")`, which would
    // print the literal `%s`. Callers that use a specifier would silently change
    // output — a cosmetic bug that hides real arguments.
    const dir = tempDir()
    runWithLogDir(dir, `log("plugin %s called %s", "alpha", "hands.write")`)
    const contents = readFileSync(join(dir, "host.log"), "utf8")
    expect(contents).toContain("plugin alpha called hands.write")
    expect(contents).not.toContain("%s")
  })

  test("with NO VRCXK_LOG_DIR there is no file, and logging still works", () => {
    // The correct state in dev and in tests, where stderr IS readable. Absence
    // must never be an error: a host that refused to run without a log directory
    // would trade a small problem for a total one.
    //
    // ⚠ The probe writes to STDERR, not stdout, and that is not incidental:
    // importing `log.ts` REPLACES `console.log`/`info`/`debug` so that nothing can
    // reach stdout, which is reserved for the kkrpc/stdio framing. A test that
    // printed to stdout would see nothing at all — the module doing its job.
    const dir = tempDir()
    const entry = join(dir, "entry.ts")
    writeFileSync(
      entry,
      `import { log, hostLogPath } from ${JSON.stringify(logModuleUrl())}\n` +
        `log("stderr-only")\nconsole.error("path:" + String(hostLogPath()))\n`,
    )
    const env = { ...process.env }
    delete env.VRCXK_LOG_DIR
    const proc = Bun.spawnSync(["bun", entry], { env, stdout: "pipe", stderr: "pipe" })
    expect(proc.exitCode).toBe(0)
    const stderr = proc.stderr.toString()
    expect(stderr).toContain("stderr-only")
    expect(stderr).toContain("path:undefined")
    // Nothing may reach stdout: it carries the RPC framing, so a stray line there
    // is a protocol corruption, not a cosmetic problem.
    expect(proc.stdout.toString()).toBe("")
    expect(readdirSync(dir).filter((name) => name.startsWith("host.log"))).toEqual([])
  })

  test("the log rotates instead of growing without bound", () => {
    // A log that grows forever is a disk-space bug in a long-lived desktop app.
    // 2 MiB is the cap; writing past it must produce `host.log.1`, not a bigger
    // `host.log`.
    //
    // ⚠ TWO things about this test are deliberate, both learned from CI.
    //
    // 1. **It writes FEWER, LARGER lines than a naive "fill 2 MiB" loop.** The first
    //    version did `for (24000) log("x".repeat(100))` — the same ~2.4 MiB — and
    //    measured **3877 ms locally**, right against bun's 5000 ms default. On the
    //    windows-latest runner it crossed the line and failed with
    //    `this test timed out after 5000ms`, NOT with a rotation assertion.
    //
    //    ⚠ My first explanation for that — "`rotate()` stats on every line" — was
    //    WRONG, and an A/B at a FIXED line count disproved it: caching the size
    //    saved only ~23% (24000 lines: 4288 → 3316 ms). The dominant cost is
    //    **per-line work × line count** (each line does an ISO timestamp, a
    //    `console.error` to the captured stderr, and an `appendFileSync`), which is
    //    why the fix that actually works is writing **fewer lines**, not fewer
    //    bytes. 600 lines × 4 KiB ≈ 2.4 MiB reaches the same cap in ~244 ms.
    //    (`rotate`'s per-line `statSync` was still removed on its own merit — see
    //    `log.ts` — but it was never the thing that broke CI.)
    // 2. **The timeout is raised anyway**, because a loaded CI runner is not this
    //    machine: the point is to assert rotation, not to benchmark `appendFileSync`.
    const dir = tempDir()
    const { exitCode } = runWithLogDir(dir, `for (let i = 0; i < 600; i++) log("x".repeat(4096))`)
    expect(exitCode).toBe(0)
    const names = readdirSync(dir).filter((name) => name.startsWith("host.log"))
    expect(names).toContain("host.log")
    expect(
      names.some((name) => /^host\.log\.\d+$/.test(name)),
      `expected a rotated generation, saw: ${names.join(", ")}`,
    )
  }, 30_000)
})
