// The host's STARTUP LOG LINES, end to end through the real `src/index.ts`.
//
// Two separate defects live here, and they are both about the same thing: a line
// that is written once at startup and then read by a human (or by a support
// bundle) long after the process that produced it is gone.
//
//   1. **The `ready` line carried a live bearer token and the user's paths.**
//      `contracts/host-ready/v1/host-ready.schema.json` makes `token` REQUIRED —
//      32 random bytes as lowercase hex, the credential the face presents as
//      `?token=` to open the host's ws surface. Until the rotating log file
//      landed the line only reached stderr, which in a release build leads
//      nowhere. Now it lands ON DISK, in a file whose stated purpose is to be
//      "small enough to attach to a report" — so the ordinary act of attaching a
//      support bundle would have handed over a live session token.
//
//   2. **The manifest load's outcome was DISCARDED.** `loadManifests` returns
//      `{loaded, skipped}` and the call site dropped it, so a plugin whose
//      declaration failed to register was indistinguishable from one that shipped
//      no declaration — and `findOverreach` returns `undefined` for both. That
//      made `#24`'s question ("which plugins are unconstrained?") unanswerable
//      from any artifact the host produced.
//
// ⚠ WHY THIS IS A CHILD-PROCESS TEST. Both defects are in the WIRING
// (`index.ts`'s bootstrap), not in a unit: `host-log.test.ts` proves `log.ts`
// writes to the file, and `manifest-wiring.test.ts` proves `loadManifests` returns
// the right counts. Neither can see whether the host actually logs the result or
// whether the logged handshake is the sanitized one. Only the real process can.
//
// ⚠ Both assertions read the LOG FILE, not stderr. That is the point of the
// exercise: stderr was never the leak, the file is. A test that asserted on
// stderr would pass against the unfixed code.

import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, join } from "node:path"
import { HOST_SPAWN_DETACHED, killTree, resolveBun, warmBun } from "./helpers"

const hostDir = join(import.meta.dir, "..")
const bun = resolveBun()

beforeAll(async () => {
  await warmBun()
}, 60_000)

const roots: string[] = []
const procs: Array<ReturnType<typeof Bun.spawn>> = []

afterEach(async () => {
  for (const proc of procs.splice(0)) killTree(proc.pid)
  // ⚠ killTree is `taskkill /T /F` and returns immediately; the dying host still
  // holds its cwd and its log file for a moment, and on Windows an `rm` that
  // arrives too early fails with EBUSY. Retried rather than ignored, because a
  // leaked temp tree per test run is a real (if quiet) cost — and the first
  // version of this hook did fail with exactly that EBUSY, as an AFTER-test error
  // that reads like the assertion that just ran was at fault.
  for (const root of roots.splice(0)) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(root, { recursive: true, force: true })
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  }
}, 20_000)

/**
 * A temp host root: `cordis.yml` + a heartbeat plugin, plus an optional second
 * plugin directory carrying whatever manifest the test wants.
 *
 * `index.ts` asserts readiness (≥1 ACTIVE entry, and the heartbeat declared by
 * `cordis.yml`), so a root without the heartbeat would fail bootstrap for a
 * reason unrelated to what is being measured.
 */
function makeHostRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "vrcxk-startup-log-"))
  roots.push(root)
  mkdirSync(join(root, "plugins"), { recursive: true })
  writeFileSync(
    join(root, "plugins", "heartbeat.ts"),
    `import type { Context } from "cordis"\n\nexport function apply(ctx: Context) {\n  ctx.provide("heartbeat", { ok: true })\n}\n`,
  )
  writeFileSync(join(root, "cordis.yml"), `- id: heartbeat\n  name: ./plugins/heartbeat.ts\n`)
  return root
}

/** Spawn the real entry script against `root`, with a log directory. */
function spawnHost(root: string) {
  const logDir = join(root, "logs")
  mkdirSync(logDir, { recursive: true })
  const proc = Bun.spawn([bun, join(hostDir, "src", "index.ts")], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: HOST_SPAWN_DETACHED,
    env: { ...process.env, VRCXK_LOG_DIR: logDir, VRCXK_SHELL: "0" },
  })
  procs.push(proc)
  return { proc, logDir }
}

/** Wait for a pattern to appear in the growing log file, or fail with its text. */
async function logFileWith(logDir: string, pattern: RegExp, timeoutMs = 30_000): Promise<string> {
  const path = join(logDir, "host.log")
  const deadline = Date.now() + timeoutMs
  let text = ""
  while (Date.now() < deadline) {
    try {
      text = readFileSync(path, "utf8")
    } catch {
      // Not created yet — the first line creates it.
      text = ""
    }
    if (pattern.test(text)) return text
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for ${pattern} in ${path}\n--- log ---\n${text}`)
}

test("the logged ready line parses, but carries NO live token and no user path", async () => {
  const root = makeHostRoot()
  const { proc, logDir } = spawnHost(root)

  // ⚠ Matched on the SHAPE the existing tests already parse
  // (`host/tests/helpers.ts#readReady` uses `/\[host\] ready ({.*})/`), which is
  // what forces the fix to REDACT rather than delete: a deleted `token` key turns
  // "the host announced itself" into "the host announced a malformed handshake"
  // for compile-smoke, sidecar-smoke, ws-heartbeat and stdin-loss.
  const log = await logFileWith(logDir, /\[host\] ready \{/)
  const match = log.match(/\[host\] ready (\{.*\})/)
  expect(match).not.toBeNull()

  const parsed = JSON.parse((match as RegExpMatchArray)[1]) as Record<string, unknown>
  // Still the handshake: the fields the tests and a human rely on are all there.
  expect(parsed.schemaVersion).toBe(1)
  expect(parsed.port).toBeGreaterThan(0)
  expect(parsed.hostVersion).toBeString()
  expect(parsed.token).toBe("<redacted>")

  // ⚠ THE ASSERTION THAT MATTERS, and it is on the RAW TEXT rather than on the
  // parsed field: a `token` property that happens to read `<redacted>` is
  // worthless if a real 64-hex token is sitting somewhere else on the same line.
  // The log file as a whole must contain no token-shaped string.
  expect(log).not.toMatch(/[0-9a-f]{64}/)

  // ⚠ THE PATH HALF, and this test found its own assertion by being wrong once.
  // The first version asserted `paths.cwd === root` on the theory that a temp
  // directory has no user segment. It does on Windows: `os.tmpdir()` is
  // `C:\Users\<account>\AppData\Local\Temp\…`, so the redaction fires on the
  // DEFAULT test fixture — which is a much better proof than a synthetic path.
  //
  // The account name is derived from `homedir()` rather than hardcoded, so the
  // assertion is about "the logged cwd does not contain the account the host is
  // running as" rather than about this machine.
  const paths = parsed.paths as { cwd: string; execPath: string }
  const account = basename(homedir())
  if (account && /[\\/](Users|home)[\\/]/i.test(root)) {
    expect(paths.cwd, "a profile-shaped cwd must not carry the account name").not.toContain(account)
    expect(paths.cwd).toContain("…")
  }
  // Either way the DIAGNOSTIC TAIL survives — the directory the host actually ran
  // in is still readable, which is the fact this log line exists for.
  expect(paths.cwd).toContain(basename(root))

  proc.kill()
}, 60_000)

test("the manifest outcome is LOGGED, so an unconstrained plugin is countable", async () => {
  const root = makeHostRoot()
  // A second plugin whose manifest is present but MALFORMED, plus a third with no
  // manifest at all. The host must boot in both cases (design P2: show, never
  // block) and must SAY how many declarations it ended up without — which is the
  // only artifact from which "which plugins are unconstrained by #24?" can be
  // answered.
  mkdirSync(join(root, "plugins", "broken", ".vrcxk"), { recursive: true })
  writeFileSync(join(root, "plugins", "broken", "index.ts"), `export function apply() {}\n`)
  writeFileSync(
    join(root, "plugins", "broken", ".vrcxk", "manifest.json"),
    // `version` is required to be semver; a non-version string is refused by the
    // contract, which is the "present but broken" case `loadManifests` warns on.
    JSON.stringify({ id: "broken", version: "not-a-version", author: "a", name: "B" }),
  )
  mkdirSync(join(root, "plugins", "bare"), { recursive: true })
  writeFileSync(join(root, "plugins", "bare", "index.ts"), `export function apply() {}\n`)
  writeFileSync(
    join(root, "cordis.yml"),
    `- id: heartbeat\n  name: ./plugins/heartbeat.ts\n` +
      `- id: broken\n  name: ./plugins/broken/index.ts\n` +
      `- id: bare\n  name: ./plugins/bare/index.ts\n`,
  )

  const { proc, logDir } = spawnHost(root)
  const log = await logFileWith(logDir, /manifests: /)

  const line = log.split("\n").find((entry) => entry.includes("manifests: "))
  expect(line).toBeDefined()
  // ⚠ The COUNTS are what make the black box countable...
  expect(line).toContain("0 registered")
  // ...and the NAMES are what make it actionable. `bare` (no manifest) and
  // `broken` (a manifest that was refused) are different problems with different
  // fixes, and before this line both were simply invisible.
  expect(line).toContain("bare")
  expect(line).toContain("broken")

  proc.kill()
}, 60_000)

// ---------------------------------------------------------------------------
// The FIRST import in `index.ts` is load-bearing, and nothing tested it.
//
// ⚠ THE SILENT FAILURE, named exactly. `src/index.ts` line 1 is `import "./log"`,
// which REPLACES `console.log` / `console.info` / `console.debug` with writers
// that go to stderr (and the rotating file). That has to happen before anything
// else can print, because in production this process is a kkrpc **stdio**
// sidecar: fd 1 is the protocol channel. Let the patch land late and a stray
// `console.log` writes a log line INTO the frame stream — a protocol corruption,
// not a cosmetic problem, and one that shows up as a transport error somewhere
// else entirely.
//
// ⚠ NOT HYPOTHETICAL: `index.ts` loads `@cordisjs/plugin-logger-console`, whose
// whole job is to render `ctx.logger` **through `console.log`**. The comment at
// that call site says it is "Safe HERE only because `import "./log"` (line 1)
// patches console.log → stderr first; stdout carries the kkrpc/stdio protocol.
// Adopting this without that patch would write protocol frames onto the log
// channel." So an auto-import sorter (or a hand edit) that moves `import "./log"`
// down one line — biome's `organizeImports` is enabled in this repo — turns a
// sanctioned plugin into a live protocol hazard, with no type error, no lint
// error and no failing test.
//
// ⚠ WHY THIS READS THE FILE AS TEXT, mirroring
// `the_desktop_only_helpers_are_gated_and_listed` in `src-tauri/src/shell_sys.rs`.
// The property is about the ORDER of a file, and no amount of importing or
// calling can observe it: `import "./log"` has no binding to assert on, and
// importing `index.ts` from a test would run `bootstrap()` at module top level
// and start a real host. The Rust side reached for the same tool for the same
// reason.
//
// ⚠ WHY NOT AN END-TO-END TEST INSTEAD (spawn the host, assert stdout carries no
// log line). Measured: it would be VACUOUS TODAY. `startup-log.test.ts`'s other
// two tests already read that process's stdout, and it is empty — nothing in the
// bootstrap logs through `console.log` until LoggerConsole has a logger event to
// render, so the moved import produces no observable stdout difference in a
// smoke run. A test that cannot fail against the broken code is worse than no
// test, so this pins the ORDER (which is the actual requirement) rather than a
// downstream symptom that is not reliably produced.
describe("the console patch is installed FIRST", () => {
  const source = readFileSync(join(hostDir, "src", "index.ts"), "utf8")
  const lines = source.split("\n")

  test("index.ts is non-empty and still exists (anti-vacuous guard)", () => {
    // ⚠ WITHOUT THIS, EVERY ASSERTION BELOW PASSES ON AN EMPTY FILE. A renamed or
    // emptied `index.ts` has no imports at all, so "the first import is
    // `./log`" would be checked against `undefined` and — depending on how it is
    // written — quietly succeed. Same guard, same reason, as the `lines.len() >
    // 100` check in `shell_sys.rs`.
    expect(lines.length).toBeGreaterThan(100)
    expect(source).toContain("bootstrap")
  })

  test("the first import is exactly `./log`, before any other import", () => {
    // Find the first import that is a DECLARATION, skipping blanks and comments
    // so a file header — which this repo writes on nearly every module — does not
    // change the answer.
    const first = lines.findIndex(
      (line) => line.startsWith("import ") || line.startsWith("export "),
    )
    expect(first, "index.ts declares no imports at all").toBeGreaterThanOrEqual(0)
    // The exact line, not "contains ./log": `import { log } from "./log"` (line
    // 17 of the real file) also matches a loose check, and it is a different
    // thing entirely — a named import does not run before the others.
    expect(
      lines[first].trim(),
      `the first import must be the side-effect-only \`import "./log"\`, found: ${JSON.stringify(lines[first])}`,
    ).toBe('import "./log"')
  })

  test("no OTHER module is imported before it", () => {
    // The failure this exists for is an ordering one, so the assertion is on the
    // POSITION of the patch rather than only on which line happens to be first.
    // Any import declared above `import "./log"` runs first — including the very
    // one that has no binding (`import "./something-else"`), which a
    // "check line 1 reads `import \"./log\"`" test alone would miss.
    const patchAt = lines.findIndex((line) => line.trim() === 'import "./log"')
    expect(patchAt, 'index.ts no longer has a bare `import "./log"`').toBeGreaterThanOrEqual(0)
    const earlier = lines
      .slice(0, patchAt)
      .filter((line) => line.startsWith("import ") || line.startsWith("export "))
    expect(earlier, `these run before the console patch: ${earlier.join(" | ")}`).toEqual([])
  })
})
