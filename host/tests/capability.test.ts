import { describe, expect, test } from "bun:test"
import { Context } from "cordis"
import { createShellCapabilities, ShellHandle } from "../src/capability"
import type { ShellStdioBridge } from "../src/stdio"

// Acceptance ⑥ for M2-1: a plugin reaches tray/notify/dialog through BOTH the
// curated domain services and the raw `ctx.shell` mirror, and each call is
/** An async iterable that yields nothing — what the `hands` streams need. */
async function* emptyStream(): AsyncIterable<never> {
  // Intentionally yields nothing.
}

// attributed to the calling plugin. `seen` proves the call reached the shell;
// `audit` proves the capability layer knew who called.
function fakeBridge(seen: string[]): ShellStdioBridge {
  const shell: ShellStdioBridge["shell"] = {
    notify: async (title, body) => {
      seen.push(`notify:${title}:${body}`)
      return true
    },
    dialog: {
      message: async (text) => {
        seen.push(`message:${text}`)
        return true
      },
      ask: async () => "",
      pickFile: async () => null,
    },
    openUrl: async () => true,
    openPath: async () => true,
    reveal: async () => true,
    shortcut: {
      register: async (accelerator) => {
        seen.push(`register:${accelerator}`)
        return { ok: true }
      },
      unregister: async () => ({ ok: true }),
      isRegistered: async () => false,
    },
    window: {
      show: async () => true,
      hide: async () => true,
      minimize: async () => true,
      maximize: async () => true,
      unmaximize: async () => true,
      focus: async () => true,
      close: async () => true,
    },
    app: {
      info: async () => ({ name: "VRCX-K", version: "0.0.1", identifier: "com.vrcxk.app" }),
      exit: async () => true,
    },
    path: {
      dir: async () => ({ config: "", data: "", cache: "", temp: "", home: "" }),
      resolve: async () => "",
    },
    devWatchEvent: async () => true,
    // ⚠ `clipboard` and `os` were added to `ShellStdioBridge` by the hands PR, and
    // this fake was not updated with them. Nothing failed, because `host/tests`
    // is in NO tsconfig program — the type error only surfaced when the tests
    // were added to one. Kept here so the fake matches the interface it claims to
    // implement.
    clipboard: {
      writeText: async () => true,
      readText: async () => null,
    },
    os: {
      info: async () => ({
        platform: "win32",
        version: "10.0.0",
        family: "windows",
        arch: "x86_64",
        locale: null,
        hostname: "test-host",
      }),
    },
    tray: {
      setSnapshot: async () => {
        seen.push("tray")
        return { ok: true, revision: 1 }
      },
    },
  }
  return {
    ready: async () => {},
    shell,
    // `hands` is part of `ShellStdioBridge` since this PR. The curated-call tests
    // here never reach it, but the bridge type requires it — and leaving it out
    // was invisible until `host/tests` joined a tsc program.
    hands: {
      stat: async () => null,
      read: () => emptyStream(),
      write: async () => ({ bytes: 0, endOffset: 0, mode: "truncate" }),
      watch: () => emptyStream(),
      list: () => emptyStream(),
    },
    tray: { setSnapshot: async () => ({ ok: true, revision: 1 }), onAction: () => () => {} },
    shortcut: {
      register: async () => ({ ok: true }),
      unregister: async () => ({ ok: true }),
      onPress: () => () => {},
    },
    // `handsHello` (the shell→brain identity announcement) and `sawWriteFailure`
    // (the EPIPE detector) are also part of the bridge. Nothing in this file
    // exercises them; they are here so the fake satisfies the interface it is
    // declared to return — which no tsconfig checked until now.
    handsHello: {
      onHello: () => () => {},
      currentHello: () => undefined,
    },
    sawWriteFailure: () => false,
    // `deepLink` predates this PR; it was missing here all along and only became
    // visible once `host/tests` joined a tsc program. `onOpen` is the local
    // fan-out registration, not an RPC.
    deepLink: { onOpen: () => () => {} },
  }
}

describe("capability surface (M2-1)", () => {
  test("both the curated and raw paths reach the shell and are attributed", async () => {
    const seen: string[] = []
    const audit: string[] = []
    const ctx = new Context()
    const handle = new ShellHandle((line) => audit.push(line))
    createShellCapabilities(ctx, handle)
    handle.attach(fakeBridge(seen))

    await ctx.plugin(function capabilityPlugin(inner: Context) {
      void inner.notify.send("hello", "world")
      void inner.dialog.message("curated")
      void inner.shell.notify("raw", "title")
      void inner.shell.dialog.message("raw-dialog")
      void inner.shell.tray.setSnapshot({ groups: [] } as never)
    })

    expect(seen).toContain("notify:hello:world")
    expect(seen).toContain("message:curated")
    expect(seen).toContain("notify:raw:title")
    expect(seen).toContain("message:raw-dialog")
    expect(seen).toContain("tray")

    const lines = audit.join("\n")
    expect(lines).toContain("capabilityPlugin -> notify.send")
    expect(lines).toContain("capabilityPlugin -> dialog.message")
    expect(lines).toContain("capabilityPlugin -> shell.notify")
    expect(lines).toContain("capabilityPlugin -> shell.dialog.message")
    expect(lines).toContain("capabilityPlugin -> shell.tray.setSnapshot")
  })

  test("with no shell attached the call is still audited and returns a safe fallback", async () => {
    const audit: string[] = []
    const ctx = new Context()
    const handle = new ShellHandle((line) => audit.push(line))
    createShellCapabilities(ctx, handle)

    let pending: Promise<boolean> | undefined
    await ctx.plugin(function lonelyPlugin(inner: Context) {
      pending = inner.notify.send("a", "b")
    })

    expect(await pending).toBe(false)
    expect(audit.some((line) => line.includes("lonelyPlugin -> notify.send"))).toBe(true)
  })

  // `CapabilitySpec` is an index signature, so a deleted mirror entry still
  // compiles while the `ctx.shell` declaration keeps advertising it — the plugin
  // then gets `is not a function` at runtime. `RawShellSpec` pins the top level;
  // this pins the nested namespaces.
  test('the raw shell mirror enumerates every ShellSysAPI["shell"] method', () => {
    const ctx = new Context()
    createShellCapabilities(ctx, new ShellHandle(() => {}))
    // `Service` adds own `ctx`/`name`; every other own key is a mirror entry.
    const keys = (node: object) =>
      Object.getOwnPropertyNames(node)
        .filter((key) => key !== "ctx" && key !== "name")
        .sort()

    expect(keys(ctx.shell)).toEqual(
      [
        "app",
        "autostart",
        "clipboard",
        "deepLink",
        "devWatchEvent",
        "dialog",
        "notify",
        "openPath",
        "openUrl",
        "os",
        "path",
        "reveal",
        "shortcut",
        "tray",
        "window",
      ].sort(),
    )
    expect(keys(ctx.shell.dialog)).toEqual(["ask", "message", "pickFile"])
    expect(keys(ctx.shell.window)).toEqual([
      "close",
      "focus",
      "hide",
      "maximize",
      "minimize",
      "show",
      "unmaximize",
    ])
    expect(keys(ctx.shell.shortcut)).toEqual(["isRegistered", "register", "unregister"])
    expect(keys(ctx.shell.app)).toEqual(["exit", "info"])
    expect(keys(ctx.shell.path)).toEqual(["dir", "resolve"])
    expect(keys(ctx.shell.tray)).toEqual(["setSnapshot"])
  })
})
