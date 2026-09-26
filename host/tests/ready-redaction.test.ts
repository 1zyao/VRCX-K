// The `ready` line as it is WRITTEN DOWN — and the redaction rules behind it.
//
// `host/src/index.ts` logs `ready <json>` at startup. Until the rotating log file
// landed that line only reached stderr, and in a release build stderr is
// `stderr(Stdio::inherit())` into a handle that leads nowhere (`src-tauri/src/host.rs`)
// — so nobody noticed what was IN it.
//
// What is in it: `contracts/host-ready/v1/host-ready.schema.json` makes `token` a
// REQUIRED field, and it is the per-launch kkrpc/ws bearer token the face presents
// as `?token=` to open the host's only RPC surface. `paths` is required too, and
// holds the host's `cwd` and `execPath` — absolute paths that on Windows begin
// with the user's account name. Now that the line lands on disk, in a file whose
// stated purpose is to be attached to a report, the support bundle would have
// carried a live session token.
//
// ⚠ WHAT IS PINNED HERE vs IN `startup-log.test.ts`
//   This file tests the RULES (`redactUserPath`, `redactForLog`) directly, so the
//   platform matrix — a Windows profile shape, a POSIX one, and a path that must
//   NOT be touched — can be asserted without fixtures or a real user profile.
//   `startup-log.test.ts` spawns the real host and greps the real log file, which
//   is what proves the rules are actually APPLIED at the call site. Neither half
//   is sufficient alone: rules that are correct but unwired, and a call site that
//   is wired to a wrong rule, both look green from one side.
//
// ⚠ These import `log.ts` in-process, unlike `host-log.test.ts` which must spawn a
//   child because `VRCXK_LOG_DIR` is resolved once and cached. The pure functions
//   here read no environment and hold no module state, so importing is the honest
//   way to test them — and much faster.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { REDACTED, redactForLog, redactUserPath } from "../src/log"

describe("redactUserPath", () => {
  test("a Windows user profile loses the account name but keeps the tail", () => {
    const redacted = redactUserPath("C:\\Users\\anna\\AppData\\Local\\VRCX-K\\host")
    expect(redacted).not.toContain("anna")
    // ⚠ The diagnostic half must SURVIVE. Blanking the whole path would pass the
    // assertion above and destroy the fact this log line exists for: this repo has
    // a recorded 2026-09 incident where a sidecar launched with the wrong cwd died
    // on a missing `cordis.yml`, and this is the line that named it.
    expect(redacted).toContain("AppData")
    expect(redacted).toContain("VRCX-K")
    expect(redacted).toContain("host")
    // `…` marks the elision, so the result cannot be mistaken for a real path.
    expect(redacted).toContain("…")
  })

  test("both POSIX spellings lose the account name too", () => {
    for (const path of ["/home/anna/src/vrcx-k", "/Users/anna/src/vrcx-k"]) {
      const redacted = redactUserPath(path)
      expect(redacted, path).not.toContain("anna")
      expect(redacted, path).toContain("vrcx-k")
    }
  })

  test("forward slashes on a Windows-shaped path still redact", () => {
    // ⚠ Not hypothetical: `cwd` can arrive derived from a `file://` URL, where
    // `fileURLToPath` has already normalised the separators. A redactor that only
    // understood backslashes would miss this and log the user's name.
    const redacted = redactUserPath("C:/Users/anna/AppData/VRCX-K")
    expect(redacted).not.toContain("anna")
    expect(redacted).toContain("AppData")
  })

  test("a path with NO user segment is left completely untouched", () => {
    // ⚠ THE CONTROL, and it is the one that keeps the fix honest. A blanket
    // "replace every absolute path" would pass every assertion above and destroy
    // the diagnostic. `…` must appear only where something was really removed.
    for (const path of [
      "E:\\builds\\vrcx-k\\host",
      "/srv/vrcx-k/host",
      // ⚠ The one that FOUND A BUG in the first version of this rule. macOS keeps
      // Homebrew under `/opt/home`, and a rule that looked for the `home` segment
      // ANYWHERE rewrote this to `…/home/…` — a path that does not exist, saying
      // nothing about where the host ran. The container must be at the ROOT.
      "/opt/home/data",
      // The same shape one level deeper: still not a profile.
      "/usr/local/home/svc",
      "",
    ]) {
      expect(redactUserPath(path), path).toBe(path)
    }
  })

  test("a user segment at the very END is not mangled", () => {
    // `C:\Users` names a container and nothing after it. Reading the next segment
    // unconditionally would delete the container and produce a path that reads as
    // a SHORTER, different directory — a silent wrong answer about where the host
    // ran, which is worse than the name it was trying to hide.
    expect(redactUserPath("C:\\Users")).toBe("C:\\Users")
    expect(redactUserPath("/home")).toBe("/home")
  })

  test("a user name that merely CONTAINS a container word is not confused for one", () => {
    // `/home/homeowner/...` has the container at index 1 and the name at index 2;
    // a substring or `includes` test would find the wrong index and elide the
    // wrong segment.
    expect(redactUserPath("/home/homeowner/src")).not.toContain("homeowner")
    expect(redactUserPath("/home/homeowner/src")).toContain("src")
  })
})

describe("redactForLog", () => {
  test("a credential-shaped key is replaced, and the key survives", () => {
    const out = redactForLog({
      port: 64050,
      token: "af92871c917e9ff478724e411c0e8ffbc96dd4463eb43e74d7521de2438f4089",
    }) as Record<string, unknown>
    expect(out.token).toBe(REDACTED)
    // ⚠ The good value is untouched: a redactor that blanked everything would be
    // indistinguishable from a log that was never written.
    expect(out.port).toBe(64050)
  })

  test("it reaches nested objects and arrays", () => {
    const out = redactForLog({
      runtime: { secret: "s", bunVersion: "1.4.2" },
      list: [{ password: "p" }, { credential: "c", ok: true }],
    }) as Record<string, unknown>
    expect((out.runtime as Record<string, unknown>).secret).toBe(REDACTED)
    expect((out.runtime as Record<string, unknown>).bunVersion).toBe("1.4.2")
    const list = out.list as Array<Record<string, unknown>>
    expect(list[0].password).toBe(REDACTED)
    expect(list[1].credential).toBe(REDACTED)
    expect(list[1].ok).toBe(true)
  })

  test("a key that merely CONTAINS a secret word is not redacted", () => {
    // ⚠ The over-redaction guard. `tokenCount` and `tokenizerId` are ordinary
    // numbers/ids; blanking them would silently remove figures a reader needs
    // while looking like the feature working.
    const out = redactForLog({
      tokenCount: 12,
      tokenizerId: "bpe",
      secretsSeen: 3,
      apiKeyRingSize: 4,
    }) as Record<string, unknown>
    expect(out.tokenCount).toBe(12)
    expect(out.tokenizerId).toBe("bpe")
    expect(out.secretsSeen).toBe(3)
    expect(out.apiKeyRingSize).toBe(4)
  })

  test("a self-referencing object does not recurse forever", () => {
    // ⚠ The failure mode of any graph-walking redactor, and it is a HANG rather
    // than a wrong value — so it is pinned rather than trusted. The depth bound is
    // what makes this terminate.
    const cycle: Record<string, unknown> = { name: "a" }
    cycle.self = cycle
    const out = redactForLog(cycle) as Record<string, unknown>
    expect(out.name).toBe("a")
    // The cycle is preserved as a finite chain rather than exploding.
    expect(out.self).toBeDefined()
  })

  test("scalars and null pass through", () => {
    expect(redactForLog("plain")).toBe("plain")
    expect(redactForLog(null)).toBeNull()
    expect(redactForLog(7)).toBe(7)
    expect(redactForLog(undefined)).toBeUndefined()
  })

  test("the placeholder is NOT token-shaped", () => {
    // ⚠ This is what makes `startup-log.test.ts`'s leak check meaningful. If the
    // placeholder were 64 hex characters, "no `[0-9a-f]{64}` in the log file"
    // could never pass and the assertion would be quietly weakened instead.
    expect(REDACTED).not.toMatch(/[0-9a-f]{64}/)
  })
})

describe("the call site applies the rules", () => {
  // ⚠ Asserted on the SOURCE because `index.ts` runs `bootstrap()` at module top
  // level: importing it from a test would start a real host and bind a port. The
  // end-to-end half lives in `startup-log.test.ts`, which spawns the process and
  // greps the file; this half names the exact expression, so a revert fails with a
  // message that says what was reverted.
  const source = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8")

  test("the token and paths are redacted on the way to the FILE", () => {
    expect(source).toContain("token: REDACTED")
    expect(source).toContain("cwd: redactUserPath(ready.paths.cwd)")
    expect(source).toContain("execPath: redactUserPath(ready.paths.execPath)")
    // `logWithSecret`, not `log`: the file gets the redacted argument and stderr
    // gets the original. A plain `log(\`ready …\`)` here would put the token back
    // on disk.
    expect(source).toContain("logWithSecret(`ready ")
    expect(source).toContain("redactedReadyLine")
  })

  test("the REAL handshake is still what is SENT to the shell", () => {
    // ⚠ The redaction must not leak onto the wire. `shell.ready(ready)` is what
    // authenticates this host to the shell; sending the placeholder there would
    // break every ws connection while every log-based test stayed green.
    expect(source).toContain("await shell.ready(ready)")
    expect(source).not.toContain("shell.ready({")
  })
})

describe("logWithSecret: stderr keeps the value, the FILE does not", () => {
  /**
   * Run `logWithSecret` in a CHILD with `VRCXK_LOG_DIR` set, and report both.
   *
   * ⚠ A child process, for the same reason `host-log.test.ts` needs one: `log.ts`
   * resolves the log path exactly once and caches it (`resolved` / `target`), so a
   * test that set the variable and imported in-process would be measuring module
   * cache state rather than behaviour. The specifier is built with
   * `pathToFileURL`, not string interpolation — a quoted Windows backslash path
   * becomes an escape sequence in the generated `.ts` file, and the child then dies
   * with an empty stdout, which reads like "the module is broken".
   */
  function runWithLogDir(
    logDir: string,
    secret: string,
    redacted: string,
  ): { stderr: string; file: string } {
    const entry = join(logDir, "entry.ts")
    const moduleUrl = pathToFileURL(join(import.meta.dir, "..", "src", "log.ts")).href
    writeFileSync(
      entry,
      `import { logWithSecret } from ${JSON.stringify(moduleUrl)}\n` +
        `logWithSecret(${JSON.stringify(redacted)}, ${JSON.stringify(secret)})\n`,
    )
    const proc = Bun.spawnSync(["bun", entry], {
      env: { ...process.env, VRCXK_LOG_DIR: logDir },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(proc.exitCode).toBe(0)
    return {
      stderr: proc.stderr.toString(),
      file: readFileSync(join(logDir, "host.log"), "utf8"),
    }
  }

  test("the secret reaches stderr and NOT the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "vrcxk-logsecret-"))
    try {
      const secret =
        'ready {"token":"af92871c917e9ff478724e411c0e8ffbc96dd4463eb43e74d7521de2438f4089"}'
      const redacted = 'ready {"token":"<redacted>"}'
      const { stderr, file } = runWithLogDir(dir, secret, redacted)

      // ⚠ stderr MUST keep it, and that is the half that looks wrong at a glance.
      // Four sibling tests scrape this pipe and connect with the value they find
      // there; the Rust shell never reads it (it logs `token_len`). See
      // `logWithSecret`'s comment for why that split is the honest one.
      expect(stderr).toContain(secret)
      // ⚠ And the FILE must not — asserted with a token-SHAPED pattern rather than
      // on the exact string, so a formatting change cannot smuggle one past.
      expect(file).toContain(redacted)
      expect(file).not.toMatch(/[0-9a-f]{64}/)
      // The file still goes through the shared write path, so it carries the same
      // timestamped `[host]` prefix and the same rotation bookkeeping.
      expect(file).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[host\] /m)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("with no log directory it writes to stderr only, and errors nothing", () => {
    // The dev and test state. Absence of `VRCXK_LOG_DIR` must never be an error,
    // and nothing may reach stdout — stdout carries the kkrpc/stdio framing, so a
    // stray line there is protocol corruption rather than a cosmetic problem.
    const dir = mkdtempSync(join(tmpdir(), "vrcxk-logsecret-none-"))
    try {
      const entry = join(dir, "entry.ts")
      const moduleUrl = pathToFileURL(join(import.meta.dir, "..", "src", "log.ts")).href
      writeFileSync(
        entry,
        `import { logWithSecret } from ${JSON.stringify(moduleUrl)}\n` +
          `logWithSecret("redacted-line", "secret-line")\n`,
      )
      const env = { ...process.env }
      delete env.VRCXK_LOG_DIR
      const proc = Bun.spawnSync(["bun", entry], { env, stdout: "pipe", stderr: "pipe" })
      expect(proc.exitCode).toBe(0)
      expect(proc.stderr.toString()).toContain("secret-line")
      expect(proc.stdout.toString()).toBe("")
      expect(readdirSync(dir).filter((name) => name.startsWith("host.log"))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
