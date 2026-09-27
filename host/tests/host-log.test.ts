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
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
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
  const proc = Bun.spawnSync([process.execPath, entry], {
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
    const proc = Bun.spawnSync([process.execPath, entry], { env, stdout: "pipe", stderr: "pipe" })
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

// ---------------------------------------------------------------------------
// `MAX_BYTES` / `KEEP` / the degradation path.
//
// ⚠ WHY THE ROTATION TEST ABOVE IS NOT ENOUGH, and this block exists.
// "a rotated generation exists somewhere" is satisfied by a rotation that runs
// on every line, by `KEEP = 1`, and by `KEEP = 100`. Meanwhile the two numbers
// that decide whether a long-lived desktop app eats the disk — the size cap and
// the retention count — were asserted NOWHERE, and neither was the branch that
// runs when rotation FAILS. All three are silent when wrong:
//
//   - `KEEP` too large: the log directory grows without bound again, one
//     generation at a time, and nothing warns.
//   - `MAX_BYTES` too large: the file simply gets bigger, which is the exact
//     "a log that grows without bound is a disk-space bug" this module's header
//     says it exists to prevent.
//   - the degradation path: `rotate`'s catch is what keeps a failed rotation
//     from becoming a failed WRITE. Delete it and the throw escapes into
//     `write`'s own catch — still no crash, but `knownSize` is dropped and, if
//     the escaping error were ever allowed to leave `write`, stderr logging
//     would go with it.
//
// ⚠ HOW THE LIMITS ARE PINNED, and why it is a LITERAL plus a source read
// rather than just one of them. The behaviour assertions use hardcoded literals
// (3 generations, ~1.5 MB vs ~2.6 MB) because an expectation COMPUTED from the
// constant under test moves with the bug and proves nothing — an early version
// of the retention test did exactly that and survived a `KEEP = 5` injection.
// The source read is the second half: it fails first, naming the constant, when
// someone edits `MAX_BYTES`/`KEEP` without revisiting this block. So the changed
// constant produces a message that says WHICH constant moved and that the file's
// expectations must move with it, instead of a bare name-list diff.
// ---------------------------------------------------------------------------

/** Where `log.ts` keeps the two rotation limits. Restated only as the expression. */
const DECLARED_MAX_BYTES = /const MAX_BYTES = 2 \* 1024 \* 1024\b/
/** Same for the retention count. */
const DECLARED_KEEP = /const KEEP = (\d+)\b/

/** `host.log`, plus every `host.log.N` generation, sorted by name. */
function logFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name === "host.log" || /^host\.log\.\d+$/.test(name))
    .sort()
}

/**
 * Make rotation impossible on ANY platform, without a filesystem privilege.
 *
 * ⚠ WHY NOT A READ-ONLY DIRECTORY, which is what the task description
 * suggested. Measured on Windows (this repo's shipping platform) in a temp
 * directory: `mkdirSync` a `host.log.3`, leave it non-empty, then run the real
 * module with `VRCXK_LOG_DIR` pointing there — `rmSync(path, { force: true })`
 * rethrows **`ERR_FS_EISDIR`** and every one of the 8 markers still reaches
 * stderr and the file. So it degrades, but for a reason the test cannot state
 * honestly: on Windows everything under this repo's tree is a directory the
 * process may still unlink from, and `chmod 0o555` did not stop a rename
 * either. A "read-only directory" fixture would therefore be asserting a
 * permission model the test does not actually have.
 *
 * ⚠ WHY NOT AN EXISTING `host.log.1` DIRECTORY EITHER, which was the other
 * candidate: `renameSync(file -> empty directory)` SUCCEEDS on Windows, so a
 * fixture built on that would quietly rotate the log and the test would pass
 * while measuring nothing.
 *
 * The `.3` slot is the one that works because it is the first thing `rotate`
 * touches (`rmSync`), so the failure lands exactly on the degradation branch
 * under test rather than on a later rename.
 */
function blockRotation(dir: string): void {
  mkdirSync(join(dir, "host.log.3"))
  // `rmSync(..., { force: true })` only ignores a MISSING path; a non-empty
  // directory still fails, because removing one needs `recursive: true`.
  writeFileSync(join(dir, "host.log.3", "occupied.txt"), "blocks rmSync\n")
}

describe("rotation limits and the degradation path", () => {
  test("the retention count really is KEEP generations, and the oldest is gone", () => {
    // ⚠ WHAT A SILENTLY WRONG `KEEP` COSTS. The rotation loop is
    // `rmSync(host.log.KEEP)` then shift `.KEEP-1` → `.KEEP`, so `KEEP` is not
    // an aesthetic: it is the only reason the number of files in the log
    // directory is bounded at all. The move loop swallows its own errors (a
    // generation that "does not exist yet" is normal), which means a wrong
    // `KEEP` produces no error anywhere — just a directory with more files in
    // it than anyone intended.
    //
    // The content assertions are the half that distinguishes "KEEP files exist"
    // from "the NEWEST KEEP generations exist". A rotation that shifted the
    // wrong way, or that never removed the oldest, would leave `.1`/`.2`/`.3`
    // present and still fail the two `toContain`s below.
    const source = readFileSync(join(import.meta.dir, "..", "src", "log.ts"), "utf8")
    const declared = source.match(DECLARED_KEEP)
    expect(declared, "log.ts no longer declares `const KEEP = <n>`").not.toBeNull()
    const keep = Number((declared as RegExpMatchArray)[1])
    expect(keep).toBeGreaterThan(0)

    const dir = tempDir()
    // ⚠ ~16 KiB lines rather than 4 KiB, and that is a COST decision the same
    // way the existing rotation test's line count was. Reaching three rotations
    // needs > 3 × MAX_BYTES ≈ 6 MiB; at 4 KiB lines that is ~1600 lines, and
    // the per-line cost (ISO timestamp + `console.error` to a captured pipe +
    // `appendFileSync`) measured ~0.7 ms each, i.e. seconds — on a loaded CI
    // runner, the 5 s default timeout. 700 × 16 KiB reaches the same byte count
    // in 700 lines (~0.5 s measured locally, ~2.6× the margin).
    const { exitCode } = runWithLogDir(
      dir,
      `log("OLDEST-GENERATION-" + "o".repeat(16384))\n` +
        `for (let i = 0; i < 700; i++) log("n".repeat(16384))\n` +
        `log("NEWEST-GENERATION-" + "e".repeat(1024))`,
    )
    expect(exitCode).toBe(0)

    // ⚠ THE EXPECTED NAME LIST IS A LITERAL, NOT DERIVED FROM `KEEP`. A first
    // version built it as `Array.from({ length: keep })` from the same source
    // read above — which made the assertion CIRCULAR, and the injection
    // experiment proved it: with `KEEP = 5` that `toEqual` still PASSED, because
    // the expectation had moved with the bug. Only the content check further
    // down caught it. A test whose expectation is computed from the thing under
    // test is not a test.
    expect(logFiles(dir), "expected exactly the newest 3 generations").toEqual([
      "host.log",
      "host.log.1",
      "host.log.2",
      "host.log.3",
    ])

    // The oldest generation is GONE, not merely renamed...
    expect(readdirSync(dir)).not.toContain("host.log.4")
    expect(readFileSync(join(dir, "host.log.1"), "utf8")).not.toContain("OLDEST-GENERATION-")
    // ...and the newest content is still there, which is what a support bundle
    // is actually read for. Without this pair the assertions above would also
    // pass against a rotation that discarded everything.
    const history = ["host.log", "host.log.1", "host.log.2", "host.log.3"]
      .map((name) => readFileSync(join(dir, name), "utf8"))
      .join("")
    expect(history).toContain("NEWEST-GENERATION-")

    // ⚠ The cross-check that turns the source read into a SIGNAL rather than
    // decoration: 3 is still the declared retention, so the literal above is
    // still the right literal. Change `KEEP` and this fails naming the constant,
    // instead of leaving a bare name-list diff to be reverse-engineered.
    expect(keep, "`KEEP` in log.ts no longer matches the generations asserted above").toBe(3)
  }, 30_000)

  test("the declared size cap is what actually triggers a rotation", () => {
    // ⚠ THE SIZE THRESHOLD WAS NEVER PINNED. The existing rotation test writes
    // ~2.4 MiB and only asks whether some generation appeared, so it stays green
    // if `MAX_BYTES` doubles — the file just gets bigger, silently, which is the
    // disk-space bug the module header says rotation exists to prevent.
    //
    // ⚠ THIS ASSERTS NOTHING ABOUT THE SOURCE, deliberately. An earlier version
    // checked the declared constant in the SAME test, and the injection
    // experiment showed why that is the wrong shape: with `MAX_BYTES` raised to 8
    // MiB the source check threw first, so the byte bracket below never ran. A
    // later `MAX_BYTES` edit that ALSO updated the source would then have been
    // reported as "fixed" while the behaviour it was supposed to bracket was
    // never exercised at all. So the constant's own value is pinned by its own
    // test, and this one is purely about what the running module does.
    //
    // Two runs bracket the threshold, and the assertions are deliberately
    // ASYMMETRIC: over the cap rotation is OBLIGATORY, under it the log must
    // simply still be a log. Rounds of `appendFileSync` overshoot the cap by at
    // most one line, so "under the cap ⇒ no rotation" is not asserted as an exact
    // boundary — measured, that would be a test that fails on a line-length
    // change for no reason.
    const under = tempDir()
    // 380 × ~4033 B ≈ 1.53 MB, comfortably below the 2 MiB cap.
    expect(
      runWithLogDir(under, `for (let i = 0; i < 380; i++) log("x".repeat(4000))`).exitCode,
    ).toBe(0)
    expect(logFiles(under)).toEqual(["host.log"])

    const over = tempDir()
    // 650 × ~4033 B ≈ 2.62 MB, comfortably over. Rotation is size-based, and it
    // uses the size it knew BEFORE the line, so the final `host.log` restarts
    // from the bytes written since — asserted only as "well under the cap",
    // because pinning the exact residue would pin the loop count too.
    expect(
      runWithLogDir(over, `for (let i = 0; i < 650; i++) log("x".repeat(4000))`).exitCode,
    ).toBe(0)
    // Measured with the real cap: `host.log.1` = 2097160 B, `host.log` = 524290 B.
    expect(
      statSync(join(over, "host.log.1")).size,
      "a log grown past MAX_BYTES must have been rotated, not kept whole",
    ).toBeGreaterThan(1024 * 1024)
    expect(statSync(join(over, "host.log")).size).toBeLessThan(1024 * 1024)
  }, 30_000)

  test("the two rotation limits are still the ones this file brackets", () => {
    // ⚠ A SIGNPOST, IN ITS OWN TEST ON PURPOSE. See the note above: folded into
    // the bracket test it would mask the behaviour it was meant to annotate.
    // Alone, it fails first and says WHICH constant moved, so a deliberate change
    // to `MAX_BYTES` or `KEEP` is told to revisit this file's literals instead of
    // leaving only a name-list or byte-size diff to reverse-engineer.
    const source = readFileSync(join(import.meta.dir, "..", "src", "log.ts"), "utf8")
    // ⚠ Asserted on the MATCHED TEXT, never on `source`. Matched against the whole
    // file, a failure prints every line of `log.ts` into the test output —
    // measured, and it buries the one line that mattered.
    expect(
      source.match(DECLARED_MAX_BYTES)?.[0],
      "`MAX_BYTES` moved: the size bracket in the test above must be re-measured",
    ).toBe("const MAX_BYTES = 2 * 1024 * 1024")
    expect(
      source.match(DECLARED_KEEP)?.[0],
      "`KEEP` moved: the generation list in the retention test above must be updated",
    ).toBe("const KEEP = 3")
  })

  test("a rotation that CANNOT happen degrades: no throw, no lost log", () => {
    // ⚠ THE BRANCH NOBODY EXERCISED. `rotate` has two catches — one per rename
    // that tolerates a generation that does not exist yet, and the outer one
    // that is the actual degradation path. `write` has a third. Nothing tested
    // any of them, so a change that let a rotation error escape would be caught
    // only by a user whose log directory had gone strange, whose symptom would
    // be a host that stopped logging — the exact failure `#24` exists to make
    // impossible.
    //
    // "No throw" alone is nearly vacuous here (both callers already swallow), so
    // it is asserted from three sides at once: the process exits 0, the marker
    // that still fails to rotate is nonetheless on stderr, and it is also IN THE
    // FILE — because the failure mode worth preventing is not a crash, it is a
    // log that quietly stops being written.
    const dir = tempDir()
    blockRotation(dir)

    // ~300 KiB lines, so the 2 MiB cap is crossed after 8 lines instead of after
    // 600. The cap itself is reached on line 7; every line from there on hits the
    // blocked `.3`, which is [MAX_BYTES, real test]'s case without 600 spawn-time
    // appends to pay for.
    const markers = Array.from({ length: 8 }, (_, index) => `DEGRADED-LINE-${index}-MARKER`)
    const { stderr, stdout, exitCode } = runWithLogDir(
      dir,
      markers.map((marker) => `log(${JSON.stringify(marker)} + "d".repeat(300 * 1024))`).join("\n"),
    )

    // (a) Rotation genuinely could not happen. Without this the test would
    //     silently become a second copy of the happy path — and it is exactly
    //     what catches the fixture drifting away from the `rmSync` it targets.
    expect(readdirSync(dir)).toContain("host.log.3")

    // (b) Degrading is not throwing. `rotate`'s catch is what keeps a failed
    //     rotation from escaping into `write`, and a crash here would be the
    //     worst possible trade: a host that cannot log must not also stop.
    expect(exitCode).toBe(0)
    // (c) Nothing may reach stdout: it carries the kkrpc/stdio framing, so a
    //     stray line there is protocol corruption, not cosmetics.
    expect(stdout).toBe("")

    // (d) The log SURVIVED. Both halves matter and they fail differently: a lost
    //     stderr marker means the throw escaped far enough to kill logging
    //     entirely, a lost FILE marker means the write path gave up silently.
    //
    // ⚠ Compared as LISTS OF MISSING MARKERS rather than with a per-marker
    // `toContain`. Measured: `toContain` prints the whole haystack on failure,
    // and each of these lines is ~300 KiB — the failing assertion buried its own
    // message under a wall of `dddd…`. A list of what is absent is both shorter
    // and more informative, since it names every marker that went missing rather
    // than stopping at the first.
    const file = readFileSync(join(dir, "host.log"), "utf8")
    expect(
      markers.filter((marker) => !stderr.includes(marker)),
      "missing from stderr",
    ).toEqual([])
    expect(
      markers.filter((marker) => !file.includes(marker)),
      "missing from the log file",
    ).toEqual([])
    // The file really did pass the cap while rotation was blocked — i.e. the
    // degradation was reached, and the fallback is "keep appending", not
    // "truncate" or "stop".
    expect(statSync(join(dir, "host.log")).size).toBeGreaterThan(2 * 1024 * 1024)
  }, 30_000)
})
