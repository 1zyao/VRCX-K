import { describe, expect, test } from "bun:test"
import {
  assertTrayMenuSnapshot,
  type TrayMenuSnapshot,
  validateTrayMenuSnapshot,
} from "../src/tray_contract"

// ⚠ GENERIC over the target, because the schema DISCRIMINATES on it.
// `HostAction.target` is `"host"` ONLY; `CoreAction.target` is `"core" | "app"`.
// A plain `target: "host" | "core" | "app"` parameter widened every result to the
// union, so a default-constructed action could not be placed in a
// `source: "host"` group — reported only once `host/tests` joined a tsc program.
// Inferring `T` from the argument keeps each call's literal, so
// `action(id)` is a host action and `action(id, "app")` is a core/app one, which
// is exactly what the privilege-escalation cases below need to express.
function action<T extends "host" | "core" | "app" = "host">(id: string, target: T = "host" as T) {
  return {
    kind: "action" as const,
    id,
    order: 0,
    label: id,
    enabled: true,
    visible: true,
    action: { target, command: "do.work", args: [], danger: "safe" as const, confirm: false },
  }
}

const valid: TrayMenuSnapshot = {
  schemaVersion: 1,
  generation: 0,
  revision: 1,
  groups: [
    {
      id: "host",
      order: 0,
      label: null,
      visible: true,
      source: "host",
      items: [action("host.action")],
    },
  ],
}

describe("tray contract schema", () => {
  test("accepts a canonical snapshot", () => {
    expect(validateTrayMenuSnapshot(valid)).toBe(true)
    expect(() => assertTrayMenuSnapshot(valid)).not.toThrow()
  })

  test("rejects unknown fields", () => {
    const invalid = { ...valid, unexpected: true }
    expect(validateTrayMenuSnapshot(invalid)).toBe(false)
    expect(() => assertTrayMenuSnapshot(invalid)).toThrow(/invalid tray menu snapshot/)
  })

  test("rejects non-canonical casing", () => {
    const invalid = { ...valid, schema_version: 1 }
    expect(validateTrayMenuSnapshot(invalid)).toBe(false)
  })

  test("rejects unsafe generation and revision numbers", () => {
    expect(validateTrayMenuSnapshot({ ...valid, generation: Number.MAX_SAFE_INTEGER + 1 })).toBe(
      false,
    )
    expect(validateTrayMenuSnapshot({ ...valid, revision: Number.MAX_SAFE_INTEGER + 1 })).toBe(
      false,
    )
  })

  test("allows core and app targets only in Rust-owned core groups", () => {
    const core = {
      ...valid,
      groups: [
        {
          id: "core.application",
          order: 0,
          label: null,
          visible: true,
          source: "core",
          items: [action("core.app.restart", "app")],
        },
      ],
    }
    expect(validateTrayMenuSnapshot(core)).toBe(true)

    const nestedCore = {
      ...core,
      groups: [
        {
          ...core.groups[0],
          items: [
            {
              kind: "submenu",
              id: "core.submenu",
              order: 0,
              label: "Core",
              enabled: true,
              visible: true,
              items: [action("core.window.show", "core")],
            },
          ],
        },
      ],
    }
    expect(validateTrayMenuSnapshot(nestedCore)).toBe(true)
  })

  test("rejects source-target privilege escalation recursively", () => {
    const hostToCore = {
      ...valid,
      groups: [{ ...valid.groups[0], items: [action("host.escalate", "core")] }],
    }
    expect(validateTrayMenuSnapshot(hostToCore)).toBe(false)

    const pluginToApp = {
      ...valid,
      groups: [
        {
          id: "plugin.menu",
          order: 0,
          label: null,
          visible: true,
          source: "plugin",
          items: [action("plugin.escalate", "app")],
        },
      ],
    }
    expect(validateTrayMenuSnapshot(pluginToApp)).toBe(false)

    const nestedHostToCore = {
      ...valid,
      groups: [
        {
          ...valid.groups[0],
          items: [
            {
              kind: "submenu",
              id: "host.submenu",
              order: 0,
              label: "Host",
              enabled: true,
              visible: true,
              items: [action("host.nested.escalate", "core")],
            },
          ],
        },
      ],
    }
    expect(validateTrayMenuSnapshot(nestedHostToCore)).toBe(false)

    const coreToHost = {
      ...valid,
      groups: [
        {
          id: "core.window",
          order: 0,
          label: null,
          visible: true,
          source: "core",
          items: [action("core.window.show", "host")],
        },
      ],
    }
    expect(validateTrayMenuSnapshot(coreToHost)).toBe(false)
  })
})
