/**
 * Per-service storage that a plugin **cannot reach** but a method call **still resolves**.
 *
 * # Why this module exists
 *
 * Services hold things a plugin must never touch: the `ShellStdioBridge` (which would let a
 * plugin skip `record()` and with it the `[cap]` audit line and the `#24` overreach warning,
 * skip the caller-fiber binding streams depend on, and defeat the `deepLink.register`
 * narrowing) and the manifest lookup (which would let one plugin read another's declared
 * manifest).
 *
 * # The three approaches that were measured, and why two of them are wrong
 *
 * **1. `private bridge?: ShellStdioBridge` — LEAKS.** A TypeScript `private` is a
 * compile-time modifier only; at runtime the property is an ordinary enumerable own
 * property. Measured with a real plugin through a real loader entry:
 *
 *     ctx.hands.bridge = VISIBLE
 *     Object.keys(ctx.hands) = ["ctx","name","bridge","auditLine","manifestLookup"]
 *
 * **2. A module-level `WeakMap` keyed by `this` — SILENTLY BREAKS.** `this` inside a method
 * reached through `ctx.<service>` is a Cordis **per-caller shadow**, a different object
 * identity from the constructed instance, so `get(this)` MISSES. Measured: with the bridge
 * attached, a plugin call returned `{"status":"no-shell"}`. The leak was closed and the
 * capability broke with it — a worse outcome than the leak, because it is invisible until
 * someone uses the feature.
 *
 * **3. A symbol-keyed property holding the value — LEAKS.** `Object.getOwnPropertySymbols`
 * reveals the symbol and `svc[symbol]` returns the value. Measured.
 *
 * # What this does instead
 *
 * A symbol-keyed property holds an **opaque token**; the real value lives in a module-level
 * `WeakMap` keyed by that token. Two properties make it work:
 *
 * - the property read **forwards through the shadow** (measured), so a method still
 *   resolves its own storage;
 * - a plugin that reflects out the symbol gets a bare `{}` with no way to read this
 *   module's map, so the token is useless to it.
 *
 * ⚠ This is **not** a capability boundary against a hostile plugin in the same process —
 * nothing in-process is. It removes the *accidental* reach that a `private` field implies,
 * which is the thing `#24` and the `deepLink.register` narrowing actually rely on.
 */

/** Create one opaque-value slot. Each call makes an independent, module-private slot. */
export function createSecretSlot<T>(): {
  set(target: object, value: T): void
  get(target: object): T | undefined
  clear(target: object): void
  has(target: object): boolean
} {
  const key = Symbol("vrcxk.secret")
  const values = new WeakMap<object, T>()

  return {
    set(target: object, value: T): void {
      const token = {}
      Object.defineProperty(target, key, {
        value: token,
        // Non-enumerable so it does not appear in `Object.keys`, spread, or JSON —
        // the reflective routes that made approach 1 leak.
        enumerable: false,
        writable: false,
        // Configurable so a shell restart can replace the token rather than throwing.
        configurable: true,
      })
      values.set(token, value)
    },
    get(target: object): T | undefined {
      const token = (target as Record<symbol, unknown>)[key]
      return token === undefined ? undefined : values.get(token as object)
    },
    clear(target: object): void {
      delete (target as Record<symbol, unknown>)[key]
    },
    has(target: object): boolean {
      return (target as Record<symbol, unknown>)[key] !== undefined
    },
  }
}
