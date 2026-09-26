// The hands error-code table is a MIRROR of the Rust one — this keeps it honest.
//
// WHY A TEST AND NOT A GENERATOR
//   `src-tauri/src/hands.rs`'s `Code` enum is the source of truth: the SHELL
//   writes the `CODE: detail` message prefix, and `HandsError` only parses it.
//   `HANDS_ERROR_CODES` in `host/src/stdio.ts` is therefore a second copy of a
//   list that lives in another language.
//
//   The obvious "generated artifact" route does not fit here, and that rejection
//   is recorded rather than left implicit: `scripts/check-contract-drift.ts`
//   byte-compares generated TypeScript against a JSON **Schema** through
//   `json2ts`, and there is no schema for these codes. Inventing one would mean a
//   new hand-maintained JSON file PLUS a generator PLUS a mirror — three copies
//   where there is currently one — which is the opposite of the fix.
//
//   So the drift is caught the cheap way: parse the Rust enum and compare set
//   equality in BOTH directions. One direction catches "a code was renamed in
//   Rust and the host still looks for the old spelling" (the failure that makes
//   `.code` silently `undefined`, and the one this repo already shipped once with
//   `ENOTDIR`); the other catches "the host advertises a code nothing can
//   produce", which is what `ECANCEL` was.
//
// ⚠ The Rust file is read as TEXT, not compiled. That is deliberate: this suite
//   runs on machines with no Rust toolchain, and the two things being compared are
//   both plain literals in a `match` arm — the shape that a rename would break is
//   exactly the shape this regex reads. If the Rust side stops looking like
//   `Code::X => "ESTRING"`, the test fails LOUDLY with the parse count rather than
//   silently comparing empty sets.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { HANDS_ERROR_CODES } from "../src/stdio"

const rustPath = join(import.meta.dir, "..", "..", "src-tauri", "src", "hands.rs")

/**
 * The `Code::Variant => "ESTRING"` arms of the Rust `Code` enum's `as_str`.
 *
 * Anchored on `Code::` so the surrounding `match` arms on other enums in the
 * same file cannot contribute, and requiring both halves so a comment cannot.
 */
function rustCodes(source: string): string[] {
  const found = [...source.matchAll(/Code::(\w+)\s*=>\s*"([A-Z]+)"/g)].map((match) => match[2])
  return [...new Set(found)].sort()
}

describe("HANDS_ERROR_CODES mirrors the Rust Code enum", () => {
  const source = readFileSync(rustPath, "utf8")
  const rust = rustCodes(source)
  const host = [...HANDS_ERROR_CODES].sort()

  test("the Rust enum was actually parsed", () => {
    // ⚠ A guard on the TEST, not on the code. If hands.rs is reformatted (say,
    // the match moves behind a helper) the regex goes quiet and BOTH comparisons
    // below would pass against an empty list — a green test asserting nothing,
    // which is the failure mode this repository keeps writing comments about.
    //
    // ⚠ The expected list is written out DELIBERATELY, even though it duplicates
    // the comparison below. Without it, a regex that silently started matching
    // nothing would satisfy "every Rust code is in the host list" vacuously; this
    // assertion is what makes that impossible. It is also the place a reviewer
    // looks to see the shell's whole vocabulary at a glance.
    expect(rust.length, `no Code::… => "…" arms found in ${rustPath}`).toBeGreaterThan(0)
    expect(rust, "the shell's error vocabulary changed — update the host mirror too").toEqual([
      "EACCES",
      "EEXIST",
      "EINTERNAL",
      "EINTR",
      "EINVAL",
      "EISDIR",
      "ENOENT",
      "ENOSPC",
      "ENOTDIR",
      "ESTALE",
      "EUNSUPPORTED",
    ])
  })

  test("every code the shell can emit is one the host parses", () => {
    // The direction that produced a real bug: a code added in Rust without a
    // matching entry here means `HandsError.code` is `undefined` for a message
    // that plainly carries a code, and a caller branching on `.code` silently
    // takes the wrong branch.
    //
    // ⚠ Compared as plain string sets. `HANDS_ERROR_CODES` is `as const`, so
    // `host` is a union-typed array and `Array.includes` would refuse a `string`
    // argument — this widens once, at the comparison, rather than weakening the
    // constant's type for the sake of the test.
    const hostSet: readonly string[] = host
    expect(rust.filter((code) => !hostSet.includes(code))).toEqual([])
  })

  test("every code the host parses is one the shell can emit", () => {
    // The other direction, and the one `ECANCEL` failed: an entry here that no
    // Rust path can produce advertises a branch that can never be taken. A
    // caller writing `if (error.code === "ECANCEL")` was writing dead code that
    // looked like handling.
    expect(host.filter((code: string) => !rust.includes(code))).toEqual([])
  })

  test("the list has no duplicates", () => {
    // `HandsError` builds a `Set` from this array, so a duplicate would be
    // invisible at runtime and only ever show up as a confusing diff here.
    expect(new Set(HANDS_ERROR_CODES).size).toBe(HANDS_ERROR_CODES.length)
  })
})
