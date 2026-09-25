// The host ready handshake is the FIRST frame the host sends and the only place
// the remote consumers — the Rust shell and the face, neither of which can call
// `process.platform` for the host — learn how to reach the host's ws surface and
// what environment it runs in. It used to be an undocumented `{ port, token }`
// literal duplicated in three files with no schema and no drift gate; these
// tests pin the contract that replaced it.
//
// Same shape as host-lifecycle-contract.test.ts: the committed mirror is checked
// against the canonical schema at RUNTIME, so the schema and the TypeScript
// cannot quietly diverge (the generated file is also byte-gated by
// `bun run check:contracts`).

import { expect, test } from "bun:test"
import {
  HOST_READY_SCHEMA_ID,
  HOST_READY_SCHEMA_VERSION,
  isHostReady,
  toArch,
  toPlatform,
} from "../src/contracts/hostReady"
import { collectHostEnvironment } from "../src/host-environment"

/**
 * The shape this file actually reads out of the schema.
 *
 * ⚠ `properties` used to be `Record<string, unknown>`, which made ALL eight
 * accesses below (`.const`, `.type`, `.pattern`, …) `unknown` and therefore
 * errors — under `strict`, `unknown` has no properties. The annotation was the
 * bug, not the assertions: these tests read specific JSON-Schema keywords, so
 * the type should say so. Fields are optional because a given property may use
 * any subset (e.g. an `enum` instead of a `const`).
 *
 * Appearing only now is the point: `host/tests` was in no tsconfig program, so
 * an over-wide annotation here was never checked.
 */
type JsonSchemaProperty = {
  const?: unknown
  type?: string | string[]
  pattern?: string
  enum?: unknown[]
  minimum?: number
  maximum?: number
  /** `extra` is bounded by this; compared against the parity corpus below. */
  maxProperties?: number
  items?: JsonSchemaProperty
  /** Nested object schemas — `host.properties.*` is read two levels down. */
  properties?: Record<string, JsonSchemaProperty>
  [key: string]: unknown
}

const schemaPath = new URL("../../contracts/host-ready/v1/host-ready.schema.json", import.meta.url)
const schema = (await Bun.file(schemaPath).json()) as {
  $id: string
  additionalProperties: boolean
  required: string[]
  properties: Record<string, JsonSchemaProperty>
}

const env = collectHostEnvironment()

const valid = {
  schemaVersion: HOST_READY_SCHEMA_VERSION,
  port: 43120,
  token: "a".repeat(64),
  hostVersion: "0.0.1",
  ...env,
}

test("the schema is the versioned canonical contract", () => {
  expect(schema.$id).toBe(HOST_READY_SCHEMA_ID)
  expect(schema.properties.schemaVersion.const).toBe(1)
  // additionalProperties:false is what makes an unexpected field a contract
  // violation rather than something both sides silently ignore.
  expect(schema.additionalProperties).toBe(false)
  expect(schema.required).toEqual([
    "schemaVersion",
    "port",
    "token",
    "hostVersion",
    "runtime",
    "host",
    "paths",
    "capacity",
  ])
})

test("the guard accepts the handshake the host actually builds", () => {
  // Not a hand-written fixture: this is the real collector output, so the guard
  // and the producer cannot drift apart.
  expect(isHostReady(valid)).toBe(true)
  expect(schema.properties.port.minimum).toBe(1)
  expect(schema.properties.port.maximum).toBe(65535)
  expect(schema.properties.token.pattern).toBe("^[0-9a-f]{64}$")
})

test("the collector reports facts that are true of this process", () => {
  // Cross-check against the same APIs rather than hard-coding machine values.
  expect(env.runtime.bunVersion).toBe(Bun.version)
  expect(env.runtime.nodeVersion).toBe(process.version)
  expect(env.host.mode).toBe(Bun.isStandaloneExecutable ? "compiled" : "source")
  expect(env.paths.cwd).toBe(process.cwd())
  expect(env.paths.execPath).toBe(process.execPath)
  expect(env.capacity.cpuCount).toBeGreaterThanOrEqual(1)
  // Memory exceeds 32 bits on ordinary machines, which is why the schema uses a
  // safe-integer bound rather than u32.
  expect(env.capacity.totalMemBytes).toBeGreaterThan(0)
  expect(env.capacity.capturedAtMs).toBeGreaterThan(0)
})

test("the platform vocabulary is the one plugin-manifest already fixed", () => {
  // Emitting the raw process.platform spelling would give the same machine two
  // names across two contracts, so the translation is explicit and total.
  expect(toPlatform("win32")).toBe("windows")
  expect(toPlatform("darwin")).toBe("macos")
  expect(toPlatform("linux")).toBe("linux")
  expect(() => toPlatform("freebsd")).toThrow()
  expect(toArch("x64")).toBe("x64")
  expect(toArch("arm64")).toBe("arm64")
  expect(() => toArch("ia32")).toThrow()
  // The contract's enums must match what the mapper can produce.
  // `hostProperties` is checked rather than `!`-asserted: a missing `properties`
  // here means the schema itself lost its shape, which is worth failing loudly on
  // with a name instead of throwing "cannot read property of undefined" later.
  const hostProperties = schema.properties.host.properties
  if (!hostProperties) throw new Error("schema.properties.host.properties is missing")
  expect(hostProperties.platform.enum).toEqual(["windows", "linux", "macos"])
  expect(hostProperties.arch.enum).toEqual(["x64", "arm64"])
})

test("the guard rejects a wrong schema version", () => {
  expect(isHostReady({ ...valid, schemaVersion: 2 })).toBe(false)
  expect(isHostReady({ ...valid, schemaVersion: "1" })).toBe(false)
})

test("the guard rejects a port the shell could not connect to", () => {
  // 0 is not "pick any port": the host binds an ephemeral port and reports what
  // the OS assigned, so 0 means the bind result was lost.
  expect(isHostReady({ ...valid, port: 0 })).toBe(false)
  expect(isHostReady({ ...valid, port: 65536 })).toBe(false)
  expect(isHostReady({ ...valid, port: "43120" })).toBe(false)
})

test("the guard rejects a token that is not the promised shape", () => {
  expect(isHostReady({ ...valid, token: "A".repeat(64) })).toBe(false)
  expect(isHostReady({ ...valid, token: "a".repeat(63) })).toBe(false)
  expect(isHostReady({ ...valid, token: "z".repeat(64) })).toBe(false)
  expect(isHostReady({ ...valid, token: 42 })).toBe(false)
})

test("the guard rejects a malformed environment group", () => {
  expect(isHostReady({ ...valid, runtime: { bunVersion: "1.4.2" } })).toBe(false)
  expect(isHostReady({ ...valid, runtime: { bunVersion: "", nodeVersion: "v1" } })).toBe(false)
  // Raw process spellings must not be accepted on the wire.
  expect(isHostReady({ ...valid, host: { ...env.host, platform: "win32" } })).toBe(false)
  expect(isHostReady({ ...valid, host: { ...env.host, arch: "ia32" } })).toBe(false)
  expect(isHostReady({ ...valid, host: { ...env.host, mode: "prod" } })).toBe(false)
  expect(isHostReady({ ...valid, paths: { cwd: "" } })).toBe(false)
  expect(isHostReady({ ...valid, capacity: { ...env.capacity, cpuCount: 0 } })).toBe(false)
})

test("the guard rejects extra fields and non-objects", () => {
  // An unexpected key means the two sides disagree about the handshake, which
  // is exactly what this contract exists to catch.
  expect(isHostReady({ ...valid, extra: undefined, surprise: true })).toBe(false)
  expect(isHostReady({ ...valid, schema_version: 1 })).toBe(false)
  expect(isHostReady(null)).toBe(false)
  expect(isHostReady([valid])).toBe(false)
  expect(isHostReady("ready")).toBe(false)
})

test("the shared contract module stays free of host-only globals", async () => {
  // `src/host.ts` (the face) imports this module, and the frontend tsconfig
  // carries no Bun/node types on purpose. A `process`/`Bun`/`node:*` reference
  // here typechecks fine for the host but breaks `bun run typecheck` for the
  // face — which is exactly how this was caught once already. Pin the split.
  const source = await Bun.file(new URL("../src/contracts/hostReady.ts", import.meta.url)).text()
  const code = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
    .join("\n")
  expect(code).not.toMatch(/\bprocess\./)
  expect(code).not.toMatch(/\bBun\./)
  expect(code).not.toMatch(/from "node:/)
})

test("the extension slot accepts bounded scalar additions", () => {
  // This is what keeps the road from narrowing: a future fact can travel
  // without a schema-version bump, while the named groups stay strict.
  expect(
    isHostReady({ ...valid, extra: { buildId: "abc123", beta: true, score: 0.5, none: null } }),
  ).toBe(true)
  // Absent/empty is legal — "nothing extra", not "malformed".
  expect(isHostReady({ ...valid, extra: {} })).toBe(true)
})

test("the extension slot is bounded, not a free-for-all", () => {
  expect(schema.properties.extra.maxProperties).toBe(32)
  const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 1]))
  expect(isHostReady({ ...valid, extra: tooMany })).toBe(false)
  // camelCase keys only, scalar values only.
  expect(isHostReady({ ...valid, extra: { "bad-key": 1 } })).toBe(false)
  expect(isHostReady({ ...valid, extra: { nested: { a: 1 } } })).toBe(false)
  expect(isHostReady({ ...valid, extra: { list: [1, 2] } })).toBe(false)
})

// The Rust mirror reads this SAME corpus (via include_str!). That is the point:
// the two implementations once disagreed about `extra` — Rust accepted nested
// objects, arrays, bad keys and oversized maps that this guard rejected — and
// testing each side against its own hand-written table could not have caught it.
const corpusPath = new URL(
  "../../contracts/host-ready/v1/guard-parity.corpus.json",
  import.meta.url,
)
const corpus = (await Bun.file(corpusPath).json()) as {
  maxProperties: number
  cases: Array<{ name: string; expect: boolean; extra: Record<string, unknown> }>
}

test("the shared extra parity corpus agrees with the schema bound", () => {
  // `maxProperties` is optional in the schema type, so the comparison against a
  // definite number is a real assertion rather than a formality. `toBeDefined()`
  // does NOT narrow the type (bun's matcher returns void), so the guard is an
  // explicit throw — it both narrows and names the missing side, instead of
  // silently comparing `number` to `undefined`.
  const extras = schema.properties.extra
  const bound = extras.maxProperties
  if (typeof bound !== "number") {
    throw new Error("schema.properties.extra.maxProperties is not a number")
  }
  expect(corpus.maxProperties).toBe(bound)
  expect(corpus.cases.length).toBeGreaterThan(0)
})

test("TS guard agrees with the shared extra parity corpus", () => {
  // Name the offending cases, not just a count, so a drift identifies itself.
  const disagreements = corpus.cases
    .map((c) => ({
      name: c.name,
      expect: c.expect,
      got: isHostReady({ ...valid, extra: c.extra }),
    }))
    .filter((r) => r.got !== r.expect)
    .map((d) => `${d.name}: expected ${d.expect}, got ${d.got}`)
  expect(disagreements).toEqual([])
})
