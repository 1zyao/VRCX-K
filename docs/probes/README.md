# Probe dev pitfalls (dogfooding `docs/probes/`, measured 2026-09)

> Applies to anything under `docs/probes/` — and to any throwaway experiment in `.temp/`.

- **`ctx.plugin()` is async, and it does not error if you forget to await**: the plugin stays in `LOADING` and the output is entirely empty. `probe.ts` v1 was lost to this ("every plugin was still LOADING when the report printed"). Always `await ctx.plugin(...)`.
- **`fn.name = "x"` is a read-only property** — assigning throws `TypeError`. Use `Object.defineProperty` if you really need to fake a name.
- **`[].every()` is `true`**: any "wait until all rows have settled" loop that forgets `rows.length > 0` breaks on the very first iteration **without erroring**. Symptom is "nothing was collected", not a failure. Bit us once in `probe122.ts`; check for it in every collection loop.
- **PowerShell wraps bun's stderr as `NativeCommandError`**, masking the real error message. Prefer `bun run <file>` over inline `node -e` / `bun -e`, and prefer a `.cjs` file over inline `-e` (in PowerShell `&` inside a double-quoted `-e "..."` is a reserved word).
- **`docs/probes/` cannot resolve `host/node_modules`**: reference host-only dependencies explicitly as `../../host/node_modules/...` (existing convention; see `probe11`). **Check the depth**: a probe in a subdirectory needs one more `../` (`../../../host/node_modules/...`, as `stdio-lifecycle/*` does).
- **Not every bare specifier is a hoisting accident — check `package.json` before "fixing" one.** A dependency declared in the **root** `package.json` (e.g. `kkrpc`, used by `src/host.ts` and also by probes) resolves from the repo root legitimately, so `import ... from "kkrpc"` in a probe is not itself a violation. The rule above exists for **host-only** dependencies (`cordis`, `@cordisjs/*`, `isomorphic-git`), which are absent from the root and would only resolve by luck.
- **`bun -e` resolves bare specifiers against the CWD, not against your probe file.** A probe that spawns `bun -e "<code>"` (see `stdio-lifecycle/13-final-matrix.ts`) breaks the moment it is run from another directory, and the failure is **silent**: the child dies on import, prints nothing, and the probe reports "nothing fired" instead of "never ran". Resolve such modules in the parent with `Bun.resolveSync` / `pathToFileURL(...)` and inline the absolute `file://` URL. When a child can fail this way, assert on the child's own `shapeHonored`-style echo and exit non-zero rather than printing a table of `undefined`.
- **⚠ RESTORING A FILE FROM A BACKUP MAKES CARGO RUN THE OLD BINARY — "Finished in 0.1s" is the tell.** `Copy-Item` / `cp -p` preserve the SOURCE's mtime, so after `cp backup.rs src/hands.rs` the file can be OLDER than the artifact built from the faulty version. Cargo compares mtimes, decides nothing changed, and the test run measures the **injected** code while you read the fixed source — so a passing run and a failing run are both meaningless. Cost: three separate confusing investigations in one session (a "test failure" that was actually the fault injection still compiled in; and its mirror image, a green run over a fix that was not built).
  - **Detect:** compare `Get-Item <source> | % LastWriteTime` against the artifact's, or watch for the missing `Compiling` line.
  - **Fix:** touch the source after restoring — `(Get-Item src-tauri/src/hands.rs).LastWriteTime = Get-Date` — or run `cargo clean -p hands-e2e` before re-testing.
  - **The general rule:** any fault-injection / restore cycle must force the rebuild, or the experiment is measuring nothing.
- **Files under `docs/probes/` are NOT covered by the `biome` gate.** `biome.json`'s
  `files.includes` lists `src/` (ts/tsx/**css**), `host/src/`, `host/tests/`,
  `host/plugins/`, `scripts/`, `packages/`, `examples/`, and the root
  `vite.config.ts` / `index.ts` / `index.html` — so `bun run check:js` reports
  "Checked 84 files" while the repo holds ~124 `.ts`/`.tsx` files (plus CSS/HTML).
  **A probe here can be unformatted, unsorted, and lint-dirty without CI noticing.**
  This is deliberate (probes are throwaway experiment code, and they carry their own
  conventions above), not an oversight — but do not read a green `check:js` as
  "the whole repo is clean". If a probe gets **promoted** to durable code (moved into
  `host/tests/`, `scripts/`, …), it enters the gate at that moment and must be formatted
  then. Still outside `includes`: `contracts/*.schema.json` (has its own semantic check
  in `check:contracts`), `docs/**/*.html` (generated arch diagram), and the local-state
  JSON under `.agent-teams/` / `.mnemon/`.
- **`.sh` files are never in the `biome` gate.** `biome` has no shell support and
  `scripts/` only lists `**/*.ts`, so the three Android scripts
  (`android-smoke.sh`, `android-debug-sign.sh`, `android-smoke.test.sh`) are **not**
  covered by `check:js`. They are covered by **`bash -n` + shellcheck locally** and by
  **CI's `static-gates` step 13** (`bash scripts/android-smoke.test.sh`, which pins the
  crash-criteria of `android-smoke.sh`). Two different concerns — a green `check:js`
  says nothing about shell scripts.

## `stdio-lifecycle/` (subdirectory)

The stdio lifecycle investigation behind PR #38. Read
[`stdio-lifecycle/FINDINGS.md`](stdio-lifecycle/FINDINGS.md) first — it carries the
mechanism (flowing mode, not the lock) and §4 lists the exact runnable commands.
Five of its 23 probes were promoted; the rest stayed in `.temp/` and are gone.

```
bun run docs/probes/stdio-lifecycle/13-final-matrix.ts   # the consolidated matrix, ~50s
bun run docs/probes/stdio-lifecycle/15-ready-rejection-taxonomy.ts   # shell.ready error shapes
$env:N="3"; bun run docs/probes/stdio-lifecycle/12-rpcchannel-repeat.ts
```

Note `04` and `09` need a real pipe on fd 0 to reproduce the documented readings
(pipe a byte in); `11` is normally run *via* `12`. See FINDINGS §4.3.

## `transport-lab/` (subdirectory)

The binary/stream transport investigation of 2026-09. Read
[`transport-lab/FINDINGS.md`](transport-lab/FINDINGS.md) first — §0 is the answer
table, §1 explains why the instrument can be trusted, §8 states exactly what the
loopback measurements do NOT license.

It answers one question that decides how file transfer is built: **what can
actually carry bytes between the face and the brain?** The headline results are
that raw binary WS frames are correct and fast, base64 is unnecessary, and
kkrpc's built-in ws transport (which JSON-serialises a `Uint8Array` into
`{"0":12,…}`, 11.4x expansion) cannot carry binary at all above 64 KiB.

Unlike the single-file probes, this set is a **client/server instrument**: a
long-lived `server.mjs` plus per-cell probe processes, so the two ends are
genuinely separate processes and the sender never grades its own work.

```
node docs/probes/transport-lab/server.mjs --base-port=47000          # background
node docs/probes/transport-lab/01-transport-matrix.mjs --quick=true --repeats=2 --base-port=47000
node docs/probes/transport-lab/03-head-of-line-server.mjs --port=46100   # background
node docs/probes/transport-lab/04-shared-vs-separate.mjs --port=46100
node docs/probes/transport-lab/05-event-loop.mjs --sizeMiB=1024
node docs/probes/transport-lab/06-folder-upload.mjs --files=1000 --rttMs=5
```

⚠ **On Windows, `spawn("bun")` does not work** — PATH holds an npm shim, not a
`Win32` executable. Set `E2E_BUN` to the real binary; the probes that spawn a
runtime read it. See FINDINGS §9.

## `hand-io/` (subdirectory, includes a Rust crate)

The hands-side (`src-tauri`) counterpart to `transport-lab/`. Read
[`hand-io/FINDINGS.md`](hand-io/FINDINGS.md) first — §0 is the answer table, §7
lists what is *not* measured.

`transport-lab` measured the **face⇄brain WebSocket**; this one measures the
**brain⇄hands stdio** path where the peer is Rust, which is a different transport
with a different framing and therefore different conclusions. §5 corrects an
earlier overstatement here: raw binary is wrong for the *stock* stdio transport,
but a length-prefixed framing is **possible** by replacing both the platform and
the codec (measured at **1.8–2.1x** over base64, §5.1) — so base64 is the cheap
**default**, not the only option.

```
cargo build --release --manifest-path docs/probes/hand-io/rust/Cargo.toml
node docs/probes/hand-io/03-protocol-claims.mjs    # ~1s, 6/6 — falsifies a disputed claim
node docs/probes/hand-io/02-stream-both-ways.mjs   # real Rust child, real pipes, both directions
node docs/probes/hand-io/01-encoding-cost.mjs --size=1048576
node docs/probes/hand-io/04-binary-framing.mjs     # replaces platform+codec; needs BOTH ends
```

### `hand-io/notify-version/` — the version A/B probe

Answers one narrow question that kept flipping: **`notify` 8.2.0 or 9.0.0-rc.5?**

Its distinguishing feature is that it depends on **both majors at once** (Cargo
package-renaming: `notify` = the rc, `notify_v8` = version 8), so one instrument
measures both rather than two crates being compared across sessions.

```bash
cargo build --release --manifest-path docs/probes/hand-io/notify-version/Cargo.toml
docs/probes/hand-io/notify-version/target/release/unwatch_strict      # rc: leak check
docs/probes/hand-io/notify-version/target/release/unwatch_strict_v8   # 8.2.0: same check
docs/probes/hand-io/notify-version/target/release/notify9_probe       # rc feature surface
```

⚠ **`notify9_probe`'s `(4b)` line is deliberately weak and self-labels as
UNRELIABLE.** It does not drain the channel before `unwatch`, so a queued event can
look like a leak — which is exactly the false "LEAK" this probe first produced.
Use `unwatch_strict` for a verdict. See
[rust-crates/FINDINGS.md §4.6](hand-io/rust-crates/FINDINGS.md).

⚠ A **separate crate** from `rust-crates/` on purpose: it needs its own dependency
resolution (two majors), and mixing that into the other crate would confuse what
that one is measuring. It also carries an empty `[workspace]`.

### `hand-io/rust-crates/` — the crate-selection probe

A **second, independent** crate that answers "with which crates?", as opposed to
the first one's "what must the hands do?". Read
[`rust-crates/FINDINGS.md`](hand-io/rust-crates/FINDINGS.md) §0 first.

```bash
cargo build --release --manifest-path docs/probes/hand-io/rust-crates/Cargo.toml
docs/probes/hand-io/rust-crates/target/release/rust-probe    # std primitives + notify + blake3
docs/probes/hand-io/rust-crates/target/release/rotation      # rotation survival + file_id
docs/probes/hand-io/rust-crates/target/release/gotchas       # nonexistent path; event coalescing
docs/probes/hand-io/rust-crates/target/release/unwatch_leak  # events after unwatch (#730)
docs/probes/hand-io/rust-crates/target/release/fs_handle     # Fs<R>::open signature (Android fd bridge)
```

It exists because the load-bearing conclusions were **crate-selection** decisions,
and those get made from READMEs and turn out wrong. Its headline result is that
**only `notify` (+ `blake3`/`bao-tree`/`file-id`) is actually needed** — locking,
append, and resume are all standard library, verified by compiling and running.

⚠ It is a **separate crate** from `hand-io/rust/` on purpose: different
dependencies, different question. Both carry an empty `[workspace]` so neither can
touch the root `Cargo.lock` (verified: the root lockfile is untouched after a build).

⚠ `file-id` is the right tool for **rotation detection** on Windows (u128 HighRes,
correct on ReFS); `same-file` uses the low-res 64-bit index and its own source
warns that is not unique there.

⚠ **`fs_handle` depends on real `tauri` + `tauri-plugin-fs`**, which pulls a large
dependency tree and makes this crate much slower to build from cold than the
others. It verifies the **signature** of `Fs<R>::open` by function-pointer
coercion plus `FilePath` behaviour — it cannot *call* `open`, because that needs a
live `AppHandle`. See FINDINGS §8.1.

⚠ **`adb shell content` must not be used to test the Android fd path.** It bypasses
`ContentResolver.openAssetFileDescriptor`, runs as uid 2000 without a URI grant, and
so measures the *shell's* permissions rather than the plugin's bridge. FINDINGS §8.2
records the failed attempt.

⚠ **`04-…` is the one probe that does NOT drive the Rust binary** — that binary
reads with `BufReader::lines()` and cannot speak a length-prefixed framing, so
driving it there would measure the mismatch rather than the framing. It spawns a
JS peer instead. See FINDINGS §5.1.

⚠ `cross-vm-server.mjs` + `cross-vm-sweep.sh` + `cross-vm-rtt.mjs` +
`cross-vm-client.sh` are the cross-VM (WSL) instruments, now **validated**. They
drive the **landed** `transport-lab/client.mjs` against a Windows-side
`server.mjs` started with `--bind=0.0.0.0`. Two traps produce fake results:
**①** the lab's server hardcoded `127.0.0.1`, so no other host could reach it at
all (a `--bind` flag was added); **②** a Windows `node.exe` launched from WSL via
interop runs as a **Windows** process and egresses from `127.0.0.1` — check
`process.platform` and the socket's local address before trusting any cross-host
number. Trap ② is pinned by `sh hand-io/cross-vm-guard.test.sh`, which asserts the
sweep **refuses** a win32 node. See [transport-lab §8.1](transport-lab/FINDINGS.md)
and [hand-io §7.1](hand-io/FINDINGS.md).

⚠ **The Rust crate is deliberately NOT a workspace member** — its `Cargo.toml`
carries an empty `[workspace]` table so `cargo build` cannot touch the root
`Cargo.lock` or the `src-tauri` build. Its `target/` is covered by a dedicated
`.gitignore` rule (`/target/` is root-anchored and would not match it).

⚠ `02-…` and `03-…` import `kkrpc/streaming`, which resolves from the **root**
`package.json` (see the bare-specifier rule above).

## `hands-e2e/` (subdirectory, includes a Rust crate)

The **end-to-end** counterpart to `hand-io/`: the same real-child-on-real-pipes
shape, but driving the **shipped** capability code
(`src-tauri/src/hands.rs` + `kkrpc_peer.rs`) rather than a throwaway probe peer.
The Rust binary pulls those two files in with `#[path]`, so it compiles the real
sources — it cannot drift from what ships.

```bash
cargo build --release --locked --manifest-path src-tauri/Cargo.toml --example hands-e2e
node docs/probes/hands-e2e/run.mjs      # 9/9 checks, ~2 s
```

It is driven by the real `kkrpc` 2.1.0 `StreamingRPCChannel`, so a pass means our
hand-written Rust peer interoperates with stock kkrpc — not that it agrees with
itself. Covered: `stat` (including the null-for-missing contract), `read` with a
resumption offset, `write` with a deferred reply, `watch` on a path that does
**not exist yet** (the parent-directory fallback), and early termination.

⚠ **Why not run the Tauri app itself**: it needs a webview and a window, so it
cannot run headless in CI. The file capability has no Tauri dependency at all, so
mounting it on a bare stdio loop is strictly more focused — a pass cannot come
from an unrelated part of the app happening to work.

⚠ **The chunk carrier must be base64, and this is the trap the first run hit.**
kkrpc's stock transport JSON-stringifies and JSON has no bytes, so yielding a raw
`Uint8Array` does NOT send binary — it sends `{"0":65,"1":66,…}` at **11.4x** the
payload ([`hand-io/FINDINGS.md`](hand-io/FINDINGS.md) §2). The probe now sends
base64 on purpose and says so in a comment; the peer decodes all three shapes so
a host that forgets still transfers correctly rather than silently corrupting.

### `hands-e2e/hol.mjs` — head-of-line blocking on the real peer

```bash
node docs/probes/hands-e2e/hol.mjs --size=134217728 --samples=100
```

Result: **p50 barely moves (1.16–1.28x) but p95 degrades ~51–59x**, and latency
recovers after the stream stops. That **corrects** §5's "bulk will make
interaction feel stuck" — the cost is in the tail, not the median.

⚠ The cause was **not** separated by this probe; `hol-credit.mjs` below is what
does it. A loopback measurement also cannot license any cross-machine conclusion —
the same discipline as [`transport-lab`](transport-lab/FINDINGS.md) §8.

### `hands-e2e/hol-credit.mjs` — WHAT the tail scales with (the cause)

Separates the three candidate causes for the tail above, by comparing two probe
positions **at the same credit and in the same run**, so throughput and per-chunk
cost are held constant and only "is the producer mid-batch?" varies:

```bash
node docs/probes/hands-e2e/hol-credit.mjs --sizeMiB=64 --credits=4,8,16,32
```

| credit | MID p95 (producer pumping) | END p95 (credit exhausted) |
|---|---|---|
| 4 | 6.9 ms | 0.34 ms |
| 16 | 28.5 ms | 0.55 ms |
| 32 | 50.8 ms | 0.32 ms |

**The tail is linear in the outstanding credit (~1.7 ms/chunk), and END is flat
at idle.** ⇒ the reader thread is starved by `pump_producer`'s
`for _ in 0..credit` loop: it does not return to `read_line` until the whole batch
is emitted. This also **explains the raw 51x**: kkrpc's consumer opens with
`pull n=32` and replenishes 16 at a time (`node_modules/kkrpc/dist/streaming.js`),
so 1.7 × 32 ≈ 54 ms (measured max 55.7) and 1.7 × 16 ≈ 27 ms (measured p95 24.3).

⚠ **The first version of this probe was invalid and is worth knowing about**: it
probed only at batch END, where the producer is *necessarily* blocked awaiting
credit — so it measured the idle window and reported "the tail does not scale with
credit" (1.2–1.8x). **A failure that does not vary with the variable is the
instrument** (this README's own rule). MID and END must be compared at the same
credit.

⚠ **Reducing credit is not a free fix**: at credit=1 the tail vanishes (0.44 ms)
but throughput drops 171 → 87 MiB/s, and sending one chunk per pull would
**deadlock** — kkrpc's consumer replenishes only after 16 values
(`!(consumedSincePull < 16)`).

## Host-side streaming probes (single-file, root of `docs/probes/`)

These four answer what the `ctx.hands` design cannot guess. See
[`../hands-host-design.md`](../hands-host-design.md).

| probe | answers |
|---|---|
| `probe-host-streaming-channel.ts` | Can the host's stdio channel carry streams at all? Is `StreamingRPCChannel` a drop-in for ordinary RPC? **6/6** |
| `probe-host-stream-lifecycle.ts` | Does `this.ctx.effect(...)` inside a Service method bind to the CALLER's fiber? |
| `probe-host-stream-leak.ts` | If a plugin is unloaded mid-stream, does anything stop it? (**measured leak**: 16 chunks after unload) |
| `probe-host-effect-economy.ts` | Does a per-stream `ctx.effect` registration need releasing, or does it accumulate? (**1000 registrations all survived to unload**) |

```bash
bun run docs/probes/probe-host-streaming-channel.ts
bun run docs/probes/probe-host-stream-lifecycle.ts
bun run docs/probes/probe-host-stream-leak.ts
bun run docs/probes/probe-host-effect-economy.ts
```

⚠ `probe-host-streaming-channel.ts` also measured something that changes a
signature's meaning: **the host receives base64 STRINGS, not `Uint8Array`** (the
stock JSON codec has no binary form). So the proposal's
`AsyncIterable<Uint8Array>` requires the HOST SIDE to decode — it is not a
pass-through.

## `probe-hand-attribution.ts` (single-file, root of `docs/probes/`)

Does a **streaming** Service method keep its caller attribution? Written to test a
claim in [`../hands-capability-proposal.md`](../hands-capability-proposal.md) §6.2 —
and it **overturned that claim**: all three shapes (sync method / record inside an
async generator body / record then return a generator) resolve the caller fine. The
real rule is about audit *volume*, not attribution.

```bash
bun run docs/probes/probe-hand-attribution.ts
```

It also demonstrated a separate, harder constraint by crashing on the first run:
**`this` inside a Service method is a per-caller shadow object, not the instance**, so
`this.#privateMethod()` throws. See the proposal §6.2a and cordis `lib/index.js:136-143`.

## Re-running

```
bun run docs/probes/probeN.ts
```