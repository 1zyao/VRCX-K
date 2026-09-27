# The hands (Rust shell) and file transfer — what they can carry, measured

> **Status**: design investigation, **no production code changed**. Scope is the
> *hands* side only (`src-tauri/`): what it must grow to move real files, and
> which of the earlier assumptions survive contact with the actual bridges.
> Date: 2026-09. Follows `../transport-lab/FINDINGS.md`, which measured the
> *face⇄brain* (WebSocket) side and explicitly left the hands-side questions open
> in its §8.

## 0. Bottom line first

| Question | Answer | Confidence |
|---|---|---|
| Do the hands need `tauri-plugin-fs` today? | **No — and they should not get the IPC half of it.** Its Android `content://` bridge *is* worth taking (see §4). | Definite (source) |
| Is there any file I/O in the hands right now? | **None.** `src-tauri/Cargo.toml` has no fs crate; `src-tauri/capabilities/default.json` grants only `core`/`opener`/`notification`. | Definite (source) |
| Can Rust participate in kkrpc **streaming**? | **Yes.** A 429-line Rust peer does both directions over real OS pipes, byte-exact. | **Definite** (8/8 checks, real pipes) |
| Is base64 required to carry bytes? | **Not required — it is the cheap default.** A raw `Uint8Array` is destroyed by the stock line-based transport, and base64 is **102x** faster than *that*; a length-prefixed binary framing is a further **1.8–2.1x** over base64 (§5.1). The framing costs a bespoke format both ends must implement; base64 costs 33%. | **Definite** (both measured) |
| Does the brain→hands direction work with a bare argument list? | **Yes.** A report claimed the arg envelope breaks it; that is **falsified** — measured. | **Definite** (falsified claim) |
| Is `tauri::ipc::Response` the fast path for bytes? | **Yes** — but it is WebView-bound and irrelevant to the hands↔brain pipe. Do not use IPC for this. | Definite (source) |
| Android `content://` — does the stock dialog picker work? | **It picks, but the grant is NOT persistable** (`ACTION_GET_CONTENT`). Resume-after-interruption cannot be built on it. | Definite (source) |
| Is there a Tauri IPC size limit? | **No.** The "4 MB/10 MB limit" is folklore; the real ceiling is ~2 GB of WebView memory. | Definite (source + issues) |

**The one decision that matters**: move file bytes **Rust ⇄ bun over stdio**, in
**base64**, in **bounded chunks with a credit window**. Do **not** route them
through Tauri IPC (that is WebView-bound and would put GB into a ~2 GB heap). A
binary framing is *possible* by replacing the transport's platform and codec
(§5), but it is a bespoke format and buys ~33%; base64 is the right default.

---

## 1. The instrument, and how to re-run it

Nine runnable probes, promoted out of `.temp/` because this document cites them
(project rule: a second copy means promotion).

```
rust/                 a throwaway cargo crate (empty [workspace], NOT a VRCX-K member)
  src/main.rs         handio-probe    — encoding cost + byte-exact echo
  src/bin/stream.rs   handio-stream   — kkrpc streaming peer, BOTH directions
01-encoding-cost.mjs      drives handio-probe; prints the wire-cost table
02-stream-both-ways.mjs   drives handio-stream with real kkrpc 2.1.0
03-protocol-claims.mjs    falsifies/confirms specific claims against real kkrpc
04-binary-framing.mjs     replaces platform+codec with length-prefixed binary (§5.1)
cross-vm-server.mjs / cross-vm-rtt.mjs / cross-vm-sweep.sh / cross-vm-client.sh
                          the cross-VM hop — §7.1 (validated; see transport-lab §8.1)
cross-vm-guard.test.sh    asserts the sweep REFUSES a win32 node (§7.1, exit 0)
```

```bash
cargo build --release --manifest-path docs/probes/hand-io/rust/Cargo.toml
node docs/probes/hand-io/03-protocol-claims.mjs          # ~1 s, 6/6 checks
node docs/probes/hand-io/02-stream-both-ways.mjs --size=8388608
node docs/probes/hand-io/01-encoding-cost.mjs --size=1048576
```

Three design choices carry the trustworthiness, each bought with a mistake made
during this investigation:

| Design | The failure it prevents |
|---|---|
| **A real child process on real pipes**, not an in-memory transport pair | An in-memory pair shares an event loop and hides framing/serialization. The whole question is what the *pipe* does. |
| **Both ends verify** — DOWN by the brain, UP by Rust's own byte count + the on-disk file | A producer grading its own work. The transport-lab learned this first; it applies identically here. |
| **The "Rust" side sends bare args and hand-rolled frames, with no kkrpc on that path** | Otherwise a pass would only prove kkrpc agrees with itself, not that *our* peer interoperates. |

**Two bugs found in the instrument itself, both worth knowing:**

1. `02-…` first failed with `unknown RPC method: brain.file`. The probe called the
   producer *through the remote proxy* (`hands.brain.file(...)`), which sends a
   `call` frame to Rust. A producer must be a **local** iterable passed **as an
   argument**. The error was the instrument, not the transport.
2. `03-…` first hung with **both** the bare-arg and envelope-wrapped requests
   failing identically. A failure that does not change with the variable is the
   instrument: a mis-wired transport pair (the two `subscribe` handlers swapped).
   Fixed, then re-run.

---

## 2. The encoding measurement (stdio, Rust ⇄ JS)

`01-encoding-cost.mjs`, one payload, three carriers, real round trip through a
real Rust process. `exact` = every byte regenerated and compared, not hashed.

| payload | carrier | wire bytes | ratio | median | exact |
|---|---|---|---|---|---|
| 64 KiB | base64 | 87,437 | **1.33x** | 1.0 ms | ✅ |
| 64 KiB | numeric-keyed JSON | 747,189 | **11.40x** | 47.6 ms | ✅ |
| 1 MiB | base64 | 1,398,159 | **1.33x** | 9.5 ms | ✅ |
| 1 MiB | numeric-keyed JSON | 13,118,421 | **12.51x** | 1,080 ms | ✅ |
| 4 MiB | base64 | 5,592,463 | **1.33x** | 32.5 ms | ✅ |
| 4 MiB | numeric-keyed JSON | 55,806,933 | **13.31x** | 5,025 ms | ✅ |

- **base64 is 9.4–10.4x smaller and 112–155x faster** than the JSON object form.
- The JSON form's ratio *grows* with size (11.40 → 12.51 → 13.31) because the
  decimal byte values and index keys get longer. It is not a constant overhead.
- The **cause is arithmetic**: `JSON.stringify(new Uint8Array([1,2,255]))` is
  `{"0":1,"1":2,"2":255}` — ~10.3x for random bytes. This is the same mechanism
  the transport-lab measured at 11.4x on the WebSocket; the stdio number is
  independent and agrees.

**Unlike the WebSocket, stdio has no cliff.** The transport-lab found the JSON
form becoming *unusable* (6–20 of 64 frames, burning a 120 s timeout) at ≥1 MiB.
Here it degrades linearly and stays byte-exact — 16 MiB takes 19 s but completes.
That difference is real and is explained by §5: the two transports frame
differently, and the stdio reader has no per-message size ceiling to hit.

---

## 3. Streaming, both directions, over real pipes

`02-stream-both-ways.mjs` drives a **real Rust child process** with the **real
kkrpc 2.1.0 `StreamingRPCChannel`** over its actual stdin/stdout. 8 MiB payload.

| Direction | Carrier | Result | Throughput |
|---|---|---|---|
| **DOWN** hands→brain | base64 | byte-identical (sha256) | **140.5 MiB/s** |
| **UP** brain→hands | base64 | byte-identical (sha256) | **137.4 MiB/s** |
| **UP** brain→hands | raw `Buffer` | byte-identical | 12.3 MiB/s |
| **UP** brain→hands | raw `Uint8Array` | byte-identical | **1.4 MiB/s** |

**Carrier choice changes UP throughput by 101.6x** (58 ms vs 5,914 ms).

Also verified: a **1-byte file** round trips; an **exact multiple of the chunk
size** round trips (this is the "last read returns 0" path); and **breaking a
stream after one chunk returns control** instead of hanging.

### 3.1 What this proves about the hands

A Rust peer needs, and this probe implements, exactly:

- `t:"r"` reply whose value is a **stream-ref envelope** (`__kkrpc_next_stream__`)
  → the JS side materializes an async iterable. **No second connection.**
- `t:"sq"` inbound `pull` with credit `n` → **accumulate**, never set. Emit one
  `t:"sr"` per value, each with a **fresh id**.
- `t:"sq"` inbound `return`/`throw` → echo the **control frame's id**.
- Outbound `t:"sq"` `pull` for the consume direction, replenished after N values.
- The **deferred reply**: `hands.receive` does not answer until the stream ends.

This is **429 lines** of Rust including base64, file I/O, and both stream
directions (`rust/src/bin/stream.rs`). It is a **transport capability**, not a
protocol change.

### 3.2 The one shape that silently destroys data

A raw `Uint8Array` or `Buffer` in a kkrpc stream does **not** error — it arrives
as a plain object keyed by decimal index:

```
R-> {"t":"sr", ..., "v":{"type":"Buffer","data":[90,90,90,...]}}   # Node Buffer
R-> {"t":"sr", ..., "v":{"0":90,"1":90,"2":90,...}}                # Uint8Array
```

Both are *byte-exact through this probe* only because the probe deliberately
decodes those shapes. A naive Rust peer that expects a base64 `String` gets
nothing and **no error** — it just never receives data. This is why the choice of
carrier must be **explicit and typed at the boundary**, not incidental.

---

## 4. Tauri's own file APIs — what applies to the hands, and what does not

Read from the vendored crates in `D:\cargo\registry\src\…` (`tauri-plugin-fs`
2.5.2, `tauri-plugin-dialog` 2.7.2, `tauri` 2.11.5), not from docs.

### 4.1 `tauri-plugin-fs` is already in the tree — as a *transitive* dependency

`Cargo.lock` contains `tauri-plugin-fs v2.5.2`, pulled in by
`tauri-plugin-dialog` (`tauri-plugin-dialog` re-exports its `FilePath`:
`pub use tauri_plugin_fs::FilePath;`). So the *code* is compiled already; what is
absent is any **registered plugin instance** and any capability grant.

### 4.2 Its two resolvers differ on Android, and the docs overstate it

| `content://` **works** | `content://` **fails** |
|---|---|
| `open`, `read_file`, `read_text_file`, `write_file`, `write_text_file` | `create`, `copy_file`, `rename`, `read_dir`, `exists`, `truncate`, `mkdir`, `remove` |

`read_file` / `{write,read}_text_file` route through `resolve_file`, which
dispatches a `Url` straight to the platform bridge. The second column calls
`resolve_path`, which does `into_path()?` and therefore **cannot accept a URI**.
`stat`/`lstat` accept URLs only via an `#[cfg(target_os = "android")]` wrapper.
The official sentence *"works with any path format out of the box"* is true for
the first column only.

### 4.3 Bytes return as **raw octet-stream**, not base64 or a JSON array

`read_file_inner` ends with `Ok(tauri::ipc::Response::new(contents))`, and
`Response::new(Vec<u8>)` → `InvokeResponseBody::Raw(Vec<u8>)` →
`application/octet-stream` → JS `response.arrayBuffer()`.

**This is the #1 footgun**: returning `Vec<u8>` from a plain `#[tauri::command]`
**without** `tauri::ipc::Response` routes it through `serde_json` → a JSON number
array. The upstream issue (tauri#9190, still open) records a **140 MB file driving
RSS to 11.5 GB and crashing**; a maintainer's triage cut it to 300–700 MB with the
`Response` wrapper, and the official resolution was *"document that people should
use the `tauri::ipc::Response` type when returning a `Vec<u8>`."* The same trap
applies to `Channel<Vec<u8>>` / `Channel<&[u8]>`, whose own module docs say they
do **not** do the raw path — the official guide's chunked-read example uses the
slow form.

### 4.4 Why none of this is the hands' transport

Every one of those commands is **WebView-facing**. Our bytes must travel
**Rust ⇄ bun**, and bun is a child process with a pipe, not a WebView. Routing
them through IPC would add a hop into a ~2 GB heap for no benefit, and
`tauri::ipc::Channel` has **no backpressure** (fire-and-forget, buffered in Rust
memory). The hands should use `std::fs::File` directly and the stdio pipe.

**There is no IPC size limit** — searching the Tauri source for
`max_body_size` / `content_length_limit` / "payload too large" yields zero hits,
and neither the guide nor the IPC page mentions one. The real ceilings are WebView
memory (~2 GB) and a ~1 GB JS string bound enforced only by a `debug_assertions`
assert (so release builds silently do nothing). Claims of a "4 MB/10 MB limit"
are folklore.

### 4.5 Android `content://`: the stock picker is disqualifying for resume

`tauri-plugin-dialog`'s Android picker constructs
`Intent(Intent.ACTION_GET_CONTENT)` with a source comment
`// TODO: ACTION_OPEN_DOCUMENT ??`, and **a grep for
`takePersistableUriPermission` across the whole dialog plugin returns zero hits**.

`ACTION_GET_CONTENT`'s grant **cannot** be persisted: AOSP's
`UriGrantsManagerService.takePersistableUriPermission` throws `SecurityException`
unless the requested flags are a subset of those actually offered, and for a
`GET_CONTENT` grant the persistable set is empty. `ACTION_OPEN_DOCUMENT` is the
one that offers persistable grants.

**Consequence**: a file picked through the stock plugin on Android is accessible
only under a transient grant. It survives neither app restart nor reboot, so
**resume-after-interruption cannot be built on it**. Note this is genuinely
Android-only — on iOS `into_path()` *succeeds* (`file://` + security-scoped
access); people who lump "mobile" together get this wrong.

### 4.6 What Android actually needs (if/when it is built)

- **SAF, not a storage permission.** `READ_EXTERNAL_STORAGE` is a **no-op since
  API 33**; `WRITE_EXTERNAL_STORAGE` has no effect for `targetSdk ≥ 30`.
- `MANAGE_EXTERNAL_STORAGE` is **not a shortcut**: Play policy explicitly lists
  *"Any File selection activity where the user manually selects individual
  files"* as an **invalid use**, and names SAF as the remedy.
- **`ACTION_OPEN_DOCUMENT`** + `takePersistableUriPermission(...)`, re-validated
  on every launch. The grant limit is **512** (not the widely-repeated 128) and
  **exceeding it silently evicts the oldest**, so a stored URI must never be
  assumed valid.
- **Streaming works without copying**: `ContentResolver.openFileDescriptor` gives
  a real fd, and `tauri-plugin-fs`'s Android bridge already turns it into a
  `std::fs::File` via Kotlin
  `contentResolver.openAssetFileDescriptor(...)?.parcelFileDescriptor?.detachFd()`
  → Rust `File::from_raw_fd(fd)` (see `plugins/fs/src/android.rs`, `FsPlugin.kt`).
- ⚠ **Open with `"rw"` for resumability.** The `ContentResolver` docs are explicit
  that exclusive `"r"`/`"w"` modes *"could be a pipe or socket pair"*, while `"rw"`
  *"implies a file on disk that supports seeking"*. A seek that compiles can still
  fail at runtime. Also: `ParcelFileDescriptor.seekTo` is `@hide`, not public API.
- ⚠ `tauri-plugin-fs`'s `resolve_content_uri` ends in `else { unimplemented!() }`
  when the fd is null → a **panic**, not an error.

---

## 5. Why base64, and what a binary framing would actually cost

The two probe sets do **not** contradict each other, and it is worth being exact
about why, because an earlier draft of this section overstated the case and
claimed a collision that does not exist.

**They measured different layers.**

- In `transport-lab`, the `raw` arm is that lab's **own framing** (its
  `makeFrame`/`verifyFrame` protocol in `proto.mjs`: an 8-byte sequence number
  plus a length prefix) written directly to a bare `WebSocketServer`. **kkrpc is
  not in that path at all.** It answers "can a socket carry raw bytes, and how
  fast" — and the answer is yes, at 1.8x over base64.
- `hand-io` measures the **stock kkrpc stdio transport**, i.e.
  `jsonLineCodec` over `stdioPlatform`: `JSON.stringify` per message, bytes split
  on `"\n"`, and any line whose `trimStart()` does not begin with `{` **dropped**
  (`jsLikelyRpcFrame`). It answers "what does the production brain⇄hands bridge
  do with a `Uint8Array` today" — and the answer is that it destroys it.

**Both agree on the load-bearing fact**: kkrpc's built-in transports cannot carry
binary. `kkrpc/ws` is literally `JSON.stringify` with `transfer: false`, and
`nodeStdioTransport` advertises the same. The JSON numeric-keyed expansion is
~10.3x on both (transport-lab: 11.4x on ws; `hand-io`: 10.30–13.31x on stdio).

**What was overstated.** An earlier version of this section said a binary framing
"would collide with that splitter". That is only true while **`stdioPlatform` is
kept**. `createTransport({ platform, codec })` is a **public entry point**
(`kkrpc/transport`), and both halves are replaceable:

- The **platform** must be replaced, because the newline splitter and the
  `startsWith("{")` guard are properties of `stdioPlatform`, not of a pipe. A
  pipe is a byte stream and does not care about delimiters.
- The **codec** must be replaced, because `jsonLineCodec` stringifies.

So a binary framing on this pipe is **possible**; it is a **transport
replacement**, not a protocol change, and the kkrpc frame layer above it
(`t:"q"` / `t:"r"` / `t:"sq"` / `t:"sr"`) is untouched by it.

**Why base64 is still the right default.** Not because the alternative is
impossible, but because:

1. It costs **1.33x** and reaches **~140 MiB/s** — the same order as the raw
   figure the lab measured on ws (136.8 MB/s), on a *slower* transport.
2. A binary framing is a **bespoke format both ends must agree on**: header
   layout, length prefix endianness, payload-index conventions, and
   **desynchronisation recovery**. A line-based stream self-synchronises (skip
   the bad line); a length-prefixed stream that desynchronises is unrecoverable
   without a resync marker. `04-binary-framing.mjs` implements exactly this
   framing to make the cost concrete — and to make it a **measured** option
   rather than an assertion. See §5.1.
3. It is decided **at one seam**, and that seam can be revisited later without
   touching the RPC layer.

**⇒ If ~33% ever matters, replacing platform + codec is the correct lever.** It
should not be done now, and it must not be described as impossible.

### 5.1 The binary framing, measured (and the claim that was wrong)

`04-binary-framing.mjs` replaces **both** halves — a length-prefixed platform
(`[4-byte BE header length][header JSON][payload bytes]`, header referencing
payloads as `{"$b":0,"n":len}`) and a matching codec — and drives it over a real
child-process pipe with real kkrpc `StreamingRPCChannel` above it.

Paired runs, same machine, same payload size, one after the other:

| payload | base64, stock transport (`02-…`) | length-prefixed binary (`04-…`) | ratio |
|---|---|---|---|
| 4 MiB | 88.4 MiB/s | 169.0 MiB/s | 1.91x |
| 8 MiB | 107.5 MiB/s | 188.2 MiB/s | 1.75x |
| 16 MiB | 124.8 MiB/s | 259.6 MiB/s | 2.08x |

**4/4 checks passed, no desynchronisation.** The ratio sits around **1.8–2.1x**,
which is the same ~1.8x the transport-lab measured for raw frames on ws — a
reassuring independent agreement.

> ⚠ **Do not quote a single number from this.** Throughput on BOTH carriers rises
> with payload size (small transfers are dominated by per-chunk overhead), and
> repeat runs at 4 MiB gave 169.0 then 218.6 MiB/s for the binary arm — a ~30%
> spread on an idle-looking machine. **The ratio is the finding; the absolutes
> are not**, exactly as transport-lab §8 warns. A regression baseline must
> compare the two arms *in the same session at the same size*, never against a
> number hard-coded in a document.

> ⚠ **That probe uses a JS child, not the Rust binary, and the reason is the
> point.** `rust/src/bin/stream.rs` reads with `BufReader::lines()` — it is
> line-oriented by construction and cannot speak this framing without a matching
> reader. Driving it there would have measured the mismatch, not the framing.
> **⇒ Adopting this framing requires changing BOTH ends** (the JS platform+codec
> *and* the Rust reader, and `kkrpc_peer.rs`'s `read_line` loop). That cost is why
> base64 remains the right default; it is not why the alternative is impossible.

**What was wrong in the first version of this document.** It claimed a binary
framing "would collide with that splitter". That is true **only while
`stdioPlatform` is kept** — the newline splitter and the `startsWith("{")` guard
are properties of that platform, not of a pipe. The pipe is a byte stream. The
claim has been corrected in place rather than quietly deleted, because the
distinction (a *platform* limitation vs a *protocol* limitation) is exactly the
kind of thing that gets miscited later.

### 5.2 The falsified claim

A research report asserted that our peer's **bare argument list is wrong even for
non-streaming calls**, because "every argument is wrapped in
`{__kkrpc_next_arg__:"value",v:…}`". That is **false**, and measurably so:

```
L-> {"t":"q","id":"r-1","op":"call","p":["math","add"],"a":[2,3]}
    [brain] math.add called with [2,3]
R-> {"t":"r","id":"r-1","v":5}
```

krrpc's `decodeArgs` leaves a **non-envelope** argument untouched, so bare args
survive on the JS receive path. `src-tauri/src/kkrpc_peer.rs`'s `unwrap_arg` is
correct *and* necessary — for the **opposite** direction, where kkrpc **is** the
caller and therefore does wrap. `03-protocol-claims.mjs` pins both: bare args
work outward, and the envelope is stripped inward.

The report's related claim that there is **no published Rust implementation of
kkrpc streaming** is **confirmed** — `crates.io`'s `kkrpc` 0.6.1 speaks the old
JSON-mode protocol (`{method,args,type,version:"json"}`), GitHub `main` moved to
the compact protocol but was never republished and has **no `sq`/`sr` handling at
all**, and the README's `cargo add kkrpc-interop` names a crate that does not
exist. Our ~200-line peer is the only Rust peer there is.

---

## 6. Recommendation

**Shape.** The hands expose **two stateless primitives**, exactly as the
transport-lab's §6 argued from the folder-upload measurement:

- `hands.read(path) -> stream` — open, stream chunks, close. Resume from an
  offset is a parameter, not a second method.
- `hands.write(path, stream) -> {bytes}` — open, consume, flush, reply.

**Do not give the hands a "packing skill"** (no directory walking, no batch size,
no retry): those are business policy and belong in the brain. `06-folder-upload`
measured a per-file cost of one full RTT (320x at 5 ms), and the fix is
**batched requests from the brain**, not a smarter hand.

**Transport.** Rust ⇄ bun over the existing stdio pipe, base64 chunks, with a
credit window. Do **not** use Tauri IPC for payload.

**On binary framing.** It is a real, measured option (§5.1: 1.85x, `04-…`), not
an impossible one — but it is **not the first move**. It requires changing both
ends (JS platform+codec *and* the Rust reader), and its failure mode
(desynchronisation) is worse than the line protocol's (skip a bad line). Revisit
it only if 1.33x or ~140 MiB/s becomes the actual bottleneck, and then treat
`04-binary-framing.mjs` as the starting point rather than as a design.

**Chunking.** Bounded chunks, allocated incrementally —
`Buffer.alloc(1 GiB)` freezes the JS event loop for ~0.25 s (transport-lab §5).
Chunk size is a tuning knob; the probe used 256 KiB.

**Android, when it is built.** `ACTION_OPEN_DOCUMENT` + persisted grants (via
`tauri-plugin-fs`'s existing Android bridge, or `aiueo13/tauri-plugin-android-fs`
if per-URI persistence management is needed), `"rw"` open mode for seekability,
and **re-validate every persisted grant on launch**.

**Verification.** Keep `02-stream-both-ways.mjs` as the regression baseline: it is
the only thing in the repo that exercises Rust ⇄ kkrpc streaming over real pipes
in both directions.

---

## 7. Honest limits

- **Everything here is loopback**, on one Windows machine. Real-link RTT is the
  one variable not measured, and the transport-lab already showed RTT dominates
  folder upload. `02-…` has no `--host`; a cross-machine run would need a socket
  transport instead of stdio. **A cross-VM run IS now recorded in §7.1** (and its
  numbers in transport-lab §8.1), but at **0.4 ms RTT** it is far too fast to
  substitute for a real network — so this limit still stands for WAN behaviour.
- **Throughput absolutes are machine-dependent.** 140 MiB/s is one machine on a
  pipe, at one payload size. **The ratios are the finding**; the absolutes are not.
- **The Rust peer is a probe, not production code.** It handles the frame set the
  JS side actually sends when driven as in `02-…`. It does **not** implement
  callbacks (`t:"cb"`/`t:"cbr"`), `op:"ref"`, or the `op:"get"/"set"/"new"`
  operations — a production peer would need those (the existing
  `kkrpc_peer.rs` already does `q`/`r`/`cb`).
- **Android was not tested on a device.** §4.5–4.6 is source reading of the
  vendored crates plus AOSP and Play policy. The persistability conclusion follows
  from `ACTION_GET_CONTENT` + zero `takePersistableUriPermission` calls, which is
  strong, but no device was involved.
- **Not measured at all**: resume after interruption (the mechanism is designed
  here, not built); progress-reporting granularity and its cost; binding a stream
  to `ctx.effect` so plugin unload tears it down. These remain the open items from
  transport-lab §8.
- **`0.6.x`-era upstream claims** (crates.io `kkrpc` 0.6.1's protocol shape,
  `tauri-plugin-android-fs`'s maintenance status) come from the research reports
  and were not re-verified here; they are marked as such where they appear.

### 7.1 The cross-VM run: first blocked, then done (both recorded)

transport-lab §8 names **"everything is loopback"** as its biggest limit. A WSL
distro is a separate network namespace on a Hyper-V vSwitch, so it was used as a
real-hop host to close that gap.

**Attempt 1 — blocked by host policy, not the instrument.** With Windows Firewall
active on all three profiles, the hop failed and the cause was identifiable:

| Check | Result |
|---|---|
| WSL `eth0` / Windows vSwitch | `172.25.40.113/20` and `172.25.32.1` — **same subnet** |
| WSL routing | `default via 172.25.32.1 dev eth0` — correct |
| Adapter | `vEthernet (WSL (Hyper-V firewall))` — **Up** |
| TCP **inside** WSL | **succeeds** ⇒ the instrument is fine |
| Windows ↔ WSL TCP, both directions | **fails** |
| ICMP both directions | **100% loss** |
| Hyper-V `DefaultInboundAction` (ActiveStore) | `Block` |

An explicit inbound allow rule and setting the Hyper-V default to `Allow` **changed
nothing**. All host firewall changes were reverted (both stores back to original).

**Attempt 2 — succeeded once the user disabled the firewall.** The probe scripts
were then validated end-to-end, and the results are in transport-lab §8.1.

**⇒ Two traps make a FAKE cross-VM run easy to produce. Both were hit here:**

1. **`server.mjs` could not be reached off-loopback at all.** All three bind sites
   were hardcoded `127.0.0.1`, so §8's claim *"`client.mjs` accepts `--host`, so a
   real-interface run needs no new code"* was **false**. A `--bind` flag was added
   (default unchanged).
2. **A Windows `node.exe` launched from WSL via interop is a WINDOWS process.**
   It reports `process.platform === "win32"` and connects from `127.0.0.1` — so it
   measures **Windows loopback**, not the WSL hop, while looking perfectly
   plausible. The first sweep here produced 40 MB/s numbers that were entirely
   meaningless. A real hop needs a **Linux** node, not a Windows one — and a
   minimal WSL distro may ship no node and not be able to install one (its rootfs
   can be too small), in which case a statically-linked musl build extracted onto
   a mounted volume is the workaround. **Always check `process.platform` and the
   socket's local address before believing a cross-host number.**

Trap 2 is now **pinned by a test** rather than by a comment:
`cross-vm-guard.test.sh` feeds the sweep a win32 node, asserts it exits **2** with
a message naming the platform, and asserts a missing node exits **1** — so a
future edit that silently drops the guard fails loudly. (`sh cross-vm-guard.test.sh`.)

The sweep also has a **measured** RTT for the hop (see transport-lab §8.1):
**0.400 ms mean / 0.345 ms p50** over 50 samples, via `cross-vm-rtt.mjs`.

**What the successful run does and does not settle** is in transport-lab §8.1 —
briefly: it confirms the encoding ordering and the json-encoding collapse on a real
hop, but at **0.4 ms RTT it is far too fast to model a real network**, so the
folder-upload RTT sweep still rests on simulated delay.

## 关联

- Face⇄brain transport measurements (the WebSocket half of this picture):
  [`../transport-lab/FINDINGS.md`](../transport-lab/FINDINGS.md)
- kkrpc Rust↔npm protocol interop (M1-4 design input):
  [`../../kkrpc-interop-findings.md`](../../kkrpc-interop-findings.md)
- Mobile topology (why the brain moves and stdio breaks):
  [`../../mobile-feasibility.md`](../../mobile-feasibility.md)
- Device/session/multi-client design: [`../../host-sessions-design.md`](../../host-sessions-design.md)
- Probe conventions ([].every() trap, bare specifiers, biome coverage):
  [`../README.md`](../README.md)
