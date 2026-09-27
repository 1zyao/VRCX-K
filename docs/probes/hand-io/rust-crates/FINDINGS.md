# Rust crates for the hands: what exists, and what was verified

> **Status**: ecosystem investigation for the hands' file capabilities.
> **No production code changed.** Companion to [`../FINDINGS.md`](../FINDINGS.md)
> (which establishes *what* the hands must do) — this answers *with which crates*.
> **Date**: 2026-09.
>
> **Measurement environment** (provenance for the numbers below): Windows x64,
> NTFS, rustc **1.97.1**. Where a claim depends on a specific platform or version
> that is stated inline. **Local setup gaps are deliberately NOT recorded here** —
> they are transient, they are not knowledge about the crates, and they rot as soon
> as the environment changes.
>
> **Method**: every crate fact below was read from the crates.io **JSON API** or
> the crate's own docs/source; every behavioural claim was then **compiled and
> run** in `rust-crates/`. Claims that are only read (not run) are marked.

## 0. Bottom line first

| Question | Answer | Confidence |
|---|---|---|
| Is there a published Rust crate for **kkrpc** (the transport)? | **No.** `kkrpc` on crates.io is stuck at 0.6.1 (2026-02-05, 2 versions ever, 48 downloads) and speaks the dead JSON-mode protocol. `kkrpc-interop`/`kkrpc-rs`/`kkrpc-rust` **do not exist** (verified 404). | **Definite** (registry + source) |
| …what about the repo's unreleased `main`? | **Still no streaming.** Its `interop/rust/src/lib.rs` is 1139 lines with `"sq"` **0** and `"sr"` **0** occurrences, and `Cargo.toml` still says `version = "0.6.1"`. | **Definite** (fetched + counted) |
| …so must we hand-write streaming? | **Yes.** ~200 lines extending the peer we already have. No upgrade path exists. | **Definite** |
| Do we need a crate for file **locking**? | **No — std has it.** `File::try_lock` compiles and runs on rustc 1.97.1. **Do not add fs2 or fs4 for locking.** | **Definite** (compiled + ran) |
| Do we need a crate for **append/roll**? | **No.** Append mode ignores a moved cursor (verified). | **Definite** (ran) |
| Do we need a crate for **resume**? | **No.** `seek(SeekFrom::Start(n))` *is* the mechanism; the choreography is ours. | **Definite** (ran) |
| Do we need a crate for **watching**? | **Yes, exactly one: `notify` 8 (stable).** It is the only piece with no std equivalent. | **Definite** (ran) |
| Is there a crate for **tailing** (stream new lines, handle rotation)? | **No maintained one.** `linemux` is alive in git but its published 0.3.0 pins **notify ^5** and has an open **100%-CPU** rotation bug (#76). **Hand-roll ~150 lines.** | Definite (registry + source) |
| Is `notify`'s licence a problem? | **No.** Core is **CC0-1.0** (public domain); companions are MIT/Apache-2.0. | **Definite** (upstream README) |
| Does a file-watch survive **log rotation**? | **Yes** — verified by experiment, twice, independently. | **Definite** (ran) |
| Is there a crate for **verified streaming**? | **Yes: `blake3` (+ `bao-tree`).** This is the one place *not* to hand-roll. | **Definite** (compiled; hashing measured) |
| Is there a crate for **resumable transfer** itself? | **No generic one.** Every real one brings its own transport (Zenoh/QUIC/SSH/S3). `zblob` is a **design template**, not a dependency. | Definite (registry + docs) |
| How do the hands **obtain a `File`**? | **`tauri-plugin-fs`'s `Fs<R>::open`** — it returns a real `std::fs::File` and is reachable from Rust. On desktop it *is* `std::fs`; **on Android it is the only way to turn a `content://` URI into a seekable file** (§8.1). | **Definite** (compiled) |
| Is the Android null-fd **panic** a blocker? | **No — minor defect, accepted.** It needs a provider that *returns* null; permissions/deletion/cloud **throw** and propagate as normal errors (§8.2). Not fixed now: the upstream fix is 2 lines, but **reproducing it needs an Android device + SDK**, which is a separate decision from the crate choice. | Definite (source) |

**⇒ The dependency set is `notify` + `blake3` (+ `bao-tree` if range proofs are
wanted). Everything else is the standard library plus our own protocol** — with
the file handle itself coming from `tauri-plugin-fs`'s Rust API, which is already
a transitive dependency.

---

## 1. The instrument, and how to re-run it

```
Cargo.toml          an isolated crate (empty [workspace] — NOT a VRCX-K member,
                    so it can never touch the root Cargo.lock)
src/main.rs         bin rust-probe : std primitives + notify + blake3 throughput
src/bin/rotation.rs bin rotation   : does a file watch survive log rotation?
```

```bash
cargo build --release --manifest-path docs/probes/hand-io/rust-crates/Cargo.toml
docs/probes/hand-io/rust-crates/target/release/rust-probe
docs/probes/hand-io/rust-crates/target/release/rotation
```

This exists because the investigation's most load-bearing conclusions were
**crate-selection** decisions, and those are exactly the kind that get made from
a README and turn out wrong. Compiling is the cheap falsification test.

---

## 2. `kkrpc` on crates.io: dead, and the repo does not help

Read from the crates.io JSON API, then verified against the actual source:

| Fact | Value |
|---|---|
| crates.io `kkrpc` versions | **only 0.6.0 and 0.6.1**, both **2026-02-05** |
| Max version ever | **0.6.1** — nothing newer |
| Downloads | **48** total |
| Protocol spoken | old JSON-mode `{method,args,type,version:"json"}` — **interoperates with nothing we use** |
| `kkrpc-interop` / `kkrpc-rs` / `kkrpc-rust` | **404 — do not exist** |
| Repo `main` peer | compact protocol ✅, but `"sq"`=0, `"sr"`=0 — **no streaming** |
| Repo `main` `Cargo.toml` | still `version = "0.6.1"` — the protocol was rewritten without a version bump |
| npm `kkrpc` | still **2.1.0**; npm `license` field still `null` (repo says Apache-2.0, README says MIT — contradiction unchanged) |

**The README's `cargo add kkrpc-interop` instruction names a crate that does not
exist.** "Wait for a republish" would not help either, because the unreleased code
has no streaming to publish.

⇒ **Hand-write it.** `src-tauri/src/kkrpc_peer.rs` already speaks compact `q`/`r`
and unwraps the `"value"` envelope; streaming is an extension of that file, and
[`../02-stream-both-ways.mjs`](../02-stream-both-ways.mjs) is its executable spec.

---

## 3. What the standard library already does (verified by running)

Output of `rust-probe` on Windows 11 / NTFS, rustc 1.97.1:

```
== standard library primitives ==
  resume via seek+write (byte-exact) : YES
  append mode ignores a moved cursor : YES
  std File::try_lock compiles/works  : YES
```

1. **Resume needs no crate.** Seek to the existing length, write the remainder;
   the result was byte-exact on re-read. That is the whole mechanism — the
   *bookkeeping* (where the offset came from, whether the far end agrees) is ours.
2. **Append mode is genuinely append-at-EOF**, not seek-then-write: the probe
   deliberately seeked to 0 first and the bytes still landed at the end. This is
   what makes a rolling log correct without a lock, and the std docs state the
   guarantee explicitly for the multi-writer case.
3. **File locking is in std** — `try_lock` compiled and ran. So **fs2 and fs4 are
   not needed for a single-writer guard.**
   - ⚠ `std::fs::File::lock/try_lock` require **Rust ≥ 1.89** (verified: the method
  compiled and ran under this repo's toolchain). An older toolchain would not
  have it, and the fix would be a crate after all.
   - ⚠ Windows: locking fails on a file opened **append-only**; open with
     `.read(true).append(true)` if it must be both locked and appended.

### 3.1 Corrections to the surrounding research (kept deliberately)

- **`fs2` is abandoned: last *source* commit is 2018-01-06**, matching its last
  publish. The GitHub API's `pushed_at` showed **2024-02-16**, which is a
  metadata/tag push, **not** source work — the commit graph is the truthful
  signal. *Do not use `pushed_at` to judge maintenance.* (A subagent caught this
  in my own data; the correction is recorded rather than quietly applied.)
- **`fs4` 1.1.0** (2026-04-28, MIT OR Apache-2.0) is the maintained successor and
  *does* add preallocation (`allocate`, `allocated_size`, `allocation_granularity`)
  — but we need none of that yet, and std covers locking. **Not adding it.**
- **`linemux` is NOT abandoned** — the repo had commits in Mar/Apr/May 2026
  (including a `notify` v8 bump). But its **published 0.3.0 is from 2022 and
  depends on `notify ^5`**, while the v8 work sits under `## [Unreleased]` with no
  new tag. So `linemux = "0.3"` would drag in an old `notify` alongside ours —
  a real co-dependency hazard. **Not adding it.**

---

## 4. `notify`: the one dependency this actually needs

| | |
|---|---|
| Version | **8.2.0** stable (2025-08-03); 9.0.0-rc.5 exists (2026-08-30) |
| Licence | **CC0-1.0** for the core crate. `notify-types`, `notify-debouncer-*`, `file-id` are **MIT OR Apache-2.0** |
| MSRV | 8.2.0 → **1.77**; 9.0.0-rc → 1.88 |
| Backends | Windows `ReadDirectoryChangesW`; Linux/**Android `inotify`**; macOS FSEvents; BSD kqueue |
| Maintained | Yes — ★3456, last push 2026-09-21, not archived |

**Licence is not a red line.** CC0 is the *most* permissive possible (public
domain dedication); the repo already accepts MIT/Apache. Verified from
`notify-rs/notify` README, which states it explicitly per package.

**Choose 8.2.0, not the 9.0.0-rc.** The rc is what adds `tokio`/`futures`
`EventHandler` impls and `Watcher::watched_paths()`, but it is a **pre-release**
and this project's own rules prefer pinned stability. The 8.x bridging pattern is
small and verified by compiling:

```
std::sync::mpsc::channel()  →  RecommendedWatcher::new(tx, Config::default())
  →  a dedicated std::thread doing blocking rx.recv()
  →  forwards into tokio::sync::mpsc::unbounded_channel()
  →  rx.recv().await
```

There is **no tokio-native watcher** — `notify`'s callback is invoked on its own
thread, so a plain `std::thread` hop is the honest bridge.

### 4.1 Rotation: verified twice, and it is nearly free

A single-**file** watch survives log rotation. Reproduced independently here
(`rotation` bin) on Windows/NTFS:

```
STEP 3: TRUE ROTATION (rename app.log -> app.log.1, create new app.log)
      -> Modify(Name(From)) paths=[...app.log]
      -> Create(Any)        paths=[...app.log]
      -> Modify(Any)        paths=[...app.log]
STEP 4 (decisive): append to the NEW file at the same path
      -> Modify(Any)        paths=[...app.log]        <-- STILL DELIVERED

RESULT file-watch SURVIVES log rotation; rotation CAN be detected via file_id
```

Mechanism (read in `notify/src/windows.rs`): Windows file watching is emulated by
watching the **parent directory** and filtering to the requested path, so the
watch follows the *path*, not the inode.

### 4.2 Detecting rotation/truncation: `file-id`, not `same-file`

The probe printed both ids, and they differ across the rename:

```
file_id before = HighRes { volume_serial_number: 7967539703792726223, file_id: 3659174699135412 }
file_id after  = HighRes { volume_serial_number: 7967539703792726223, file_id: 3096224745714224 }
id_changed     = true
```

- **`file-id` 0.2.3** (2025-08-03, MIT OR Apache-2.0) gives a **u128 HighRes** id
  on Windows via `GetFileInformationByHandleEx(FileIdInfo)` — correct on ReFS.
- **`same-file` uses the low-res 64-bit index**, and its own source warns that is
  "susceptible to bugs … where `nFileIndex{Low,High}` are not unique" (i.e. ReFS).
  **`file-id` is strictly better on Windows.**
- Detection rule: **`file_id` changed → the path is a different file → reopen and
  reset offset to 0.** `metadata().len() < offset` → in-place truncation → same reset.
- ⚠ Network/remote shares: MS documents that `GetFileInformationByHandle` "may
  fail, return partial information" there, so id-based detection is unreliable on
  network drives — fall back to length+content heuristics.

### 4.3 ⚠ Two `notify` gotchas, both measured here (`gotchas` bin)

```
== (a) watching a path that does not exist yet ==
  watch(nonexistent file) accepted : NO (errors)
  events delivered after it was created : 0
  FALLBACK: watch parent dir, filter by path : 2 event(s)

== (b) event amplification under a write burst ==
  200 appends through one handle -> 1 event(s)
```

**(a) A watch cannot be pre-installed on a path that does not exist yet.** `watch()`
errors, and even after the file is created nothing is delivered. **This is the
`tail -f`-on-startup case**, and the working shape is to **watch the parent
directory non-recursively and filter by path** — which is also what
`tail --follow=name` does. Design the hands' watch this way from the start.

**(b) Events coalesce; a debouncer is NOT needed for volume.** 200 appends through
one handle produced **1** event. So `notify-debouncer-mini` is unnecessary, and
`notify-debouncer-full` would be taken for a *different* reason only: it ships a
`FileIdMap` built on `file_id::get_file_id` that stitches rename `From`/`To` into
one event. Since we already use `file-id` directly for the same purpose (§4.2),
**neither debouncer is needed.**

### 4.4 ⚠ The Android gap: cfg-gated in, but never executed upstream

`notify` does pull **inotify on Android** (`RecommendedWatcher = INotifyWatcher`
for that target), so it *should* work. But upstream's Android CI is
**build-only** — `cargo ndk build`, no emulator, no `cargo test`, no device —
while its FreeBSD job *does* run tests and Android has **less** verification than
FreeBSD.

The one Android issue (notify#443 "Not working on aarch64/android") was closed on
the reporter's *workaround* (it had silently selected `PollWatcher`), not by a
maintainer verifying inotify on a device.

⇒ **Treat Android watching as unproven.** Budget a real device spike, and note
that the documented Linux `fs.inotify.max_user_watches` remedy is a `sysctl` an
unrooted Android app **cannot** perform — `PollWatcher` is the escape hatch.
This is the largest evidence gap in this document.

### 4.5 ⚠ The one place `notify` does **not** work: network/WSL paths

`notify`'s own docs carry this warning, and issue
[#254](https://github.com/notify-rs/notify/issues/254) (open since 2020, labelled
`A-bug`, `os-windows`) is titled *"missing events while watching a file on WSL"*.

**This is directly relevant to this project**, because the cross-VM work in
[transport-lab §8.1](../../transport-lab/FINDINGS.md) uses a WSL hop. Watching a
**Windows** path from **inside WSL** (or any network mount) may emit nothing.

⇒ **Watch the file on the machine that owns it.** Do not design a watch that
crosses the WSL/network boundary. (The hands-are-remote problem is exactly why
the hands, not the host, must own this watch — see §6.)

### 4.6 Two upstream Windows bugs in 8.2.0 — but only ONE is reproducible here

Both map onto requirements the hands actually have, and both were fixed only in the
9.0.0-rc line:

| Issue | Effect on us | Fixed in | Reproduced here? |
|---|---|---|---|
| **#963** — Windows emits nothing on `ReadDirectoryChangesW` buffer overflow (fixed `BUF_SIZE`, zero-byte completion ignored) | **A busy directory can silently lose events with no signal.** Bad for a log tailer, which must not silently miss lines. | **9.0.0-rc.5** (emits a `Flag::Rescan` event) | **No** — needs a deliberately overflowing directory; not attempted |
| **#730** — `unwatch()` returns before the watch is removed on Windows | **"Must stop cleanly when a caller unsubscribes"** is an explicit requirement | **9.0.0-rc.3** | **No — and it does NOT reproduce on EITHER version** (below) |

**#730 was tested on both versions with the SAME instrument, and did not reproduce
on either.** The paired check lives in one crate that depends on **both majors at
once** (Cargo package-renaming), so a single instrument measures both:

```
notify 9.0.0-rc.5 : rounds=5  clean=5  leaks=0
notify 8.2.0      : rounds=5  clean=5  leaks=0
```

See [`../notify-version/`](../notify-version/) (`unwatch_strict` and
`unwatch_strict_v8`). That the two majors compile into one binary is a useful
by-product: `tauri-plugin-fs` pins `notify = "8"`, so coexistence is possible if
we ever want the rc alongside it.

⚠ **An earlier run of the rc DID report "LEAK" — that was my instrument, not the
library.** The first probe did not drain the channel before `unwatch`, so a stale
event from the write *before* it was still queued and got counted as a leak. The
strict variant **drains immediately before `unwatch`**; both versions then read
clean. Same "a failure that does not vary with the variable is the instrument"
signature this probe set has hit repeatedly. The weak check is kept in
`notify9_probe` but now **labels its own output UNRELIABLE** rather than crying
LEAK, so it cannot mislead a future reader.

**⇒ Consequence for the recommendation: #730 is NOT evidence for the rc line.**
It could not be reproduced on 8.2.0, so it cannot be cited as a reason to leave
stable. #963 remains a *source-level* reason, and it was **not** reproduced either —
it is read from the changelog and the issue tracker, not observed.

### 4.7 ⇒ Version choice: **8.2.0 by default; rc only if you want the async path**

This section has been revised twice and the honest end state is *less* certain than
either earlier version, so the reasoning is spelled out rather than the verdict.

**What is actually verified:**

| Claim | Status |
|---|---|
| 9.0.0-rc.5 **builds and runs** with `features=["tokio"]` | ✅ verified (`notify9-probe`) |
| `tokio::sync::mpsc::UnboundedSender` implements `EventHandler` in the rc | ✅ verified (compilation) |
| `Watcher::watched_paths()` exists in the rc | ✅ verified (runtime: `Ok([(dir, NonRecursive)])`) |
| The rc delivers a real event | ✅ verified (`Create(File)`) |
| **8.2.0 has no `tokio`/`futures` feature, and no `watched_paths()`** | ✅ verified (cargo refuses the feature; E0599) |
| #730 leaks events on 8.2.0 | ❌ **NOT reproduced on 8.2.0** |
| #963 loses events on 8.2.0 | ⚠ read only, not attempted |

**So the honest trade is:**

- **Choose 8.2.0** if a stable release matters more than the async ergonomics. It
  does everything we need; the cost is a **~6-line std-channel + thread bridge**
  (verified pattern, §4.7a) instead of the rc's native `EventHandler`.
- **Choose 9.0.0-rc.5** only if the native `tokio` integration and
  `watched_paths()` are worth depending on a **pre-release that has sat in rc for
  ~8 months**. The rc's previously-claimed advantage on #730 **does not hold up**.

Either way **MSRV is not the deciding factor** — the rc needs 1.88, i.e. both
candidates fall inside this repo's declared toolchain requirement — and **no
dual-major risk exists** (`notify` is absent from our `Cargo.lock` and the
`tauri-plugin-fs` watch feature is off).

> ⚠ **Do not let a future reader re-derive the old verdict.** An earlier version of
> this document recommended the rc *because* of #730, on the strength of a single
> run each. Testing both versions with one instrument showed the leak on neither.
> The rc may still be the right call for ergonomics — but **not** for that reason.

**⇒ Default recommendation revised to `notify = "8"`.** It is the version whose
behaviour we can defend, and it keeps this project off a pre-release by default.

### 4.7a The verified 8.2.0 async bridge

`notify`'s handler runs on its own thread and `recv()` is blocking, so one
dedicated thread is required. This exact pattern compiled and ran (exit 0):

```rust
let (raw_tx, raw_rx) = std::sync::mpsc::channel::<notify::Result<Event>>();
let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
std::thread::spawn(move || {
    while let Ok(ev) = raw_rx.recv() {
        if tx.send(ev).is_err() { break }
    }
});
let mut w = notify::recommended_watcher(raw_tx)?;
// then: tokio::time::timeout(d, rx.recv()).await
```

There is **no tokio-native watcher**; `tokio::fs` documents file ops only.

### 4.8 `tauri-plugin-fs`'s watcher cannot be reused — it is webview-only

Read from the vendored source (`tauri-plugin-fs-2.5.2`):

- Its `watch` is a **`#[tauri::command] fn watch(webview: Webview<R>, …)`** that
  pushes events into a `tauri::ipc::Channel<notify::Event>` and registers the
  watcher in `webview.resources_table()`.
- The module is **private** (`#[cfg(feature = "watch")] mod watcher;`), and
  `FsExt` — the Rust-side entry point — exposes only `fs_scope`, `try_fs_scope`,
  `fs`. **There is no public Rust API to subscribe.**
- The feature is **optional and not in our `Cargo.lock`**; the `watch` command is
  also **not** in the plugin's default permission set.

⇒ To watch from Rust we need our **own** `notify` dependency. The plugin's watcher
is for the webview and is unreachable from the hands.

---

## 5. Integrity: `blake3`, and where to stop hand-rolling

```
== blake3 ==
  64 MiB hashed at 4195 MiB/s
  => compare with the measured stdio pipe (~140 MiB/s): hashing is NOT the bottleneck
```

Hashing is **~30x** the measured pipe rate, so per-chunk digests cost effectively
nothing. Per the transport-lab's caution, treat the absolute as machine-specific;
the *ordering* is what matters and it is not close.

- **`blake3` 1.8.7** (2026-08-20), licence `CC0-1.0 OR Apache-2.0 OR Apache-2.0
  WITH LLVM-exception`. Recommended for per-chunk digests: it is also a **Merkle
  tree**, which is what makes range verification possible without a second
  structure.
- **`bao-tree` 0.16.1** (2026-08-26, MIT OR Apache-2.0, ~807k downloads) provides
  *"BLAKE3 verified streaming with custom chunk groups and range set queries"*.
  This is the layer to **depend on rather than write**: a hand-rolled Merkle
  implementation is the classic place to be subtly wrong.
- ⚠ The widely-quoted "BLAKE3 is 14x SHA-256" is a **16 KiB/1-thread** figure from
  the official chart, on a non-SHA-NI build. Do not quote it as a general ratio.

**What NOT to add**: `xxhash-rust` is BSL-1.0 (not MIT/Apache — needs a licence
decision), `ranges` is **LGPL-3.0-or-later** (a red line for this repo), and
`crc32fast`/`sha2` are only needed if a non-cryptographic checksum were wanted.

---

## 6. Resumable transfer: no crate, and that is not a gap

### 6.0 Tailing (streaming appended lines) is hand-rolled too

No maintained crate does "stream new lines with rotation handling" correctly. The
closest, **`linemux`**, is the "repo alive / registry dead" case:

- Its **published 0.3.0 (2022-12-17) depends on `notify ^5`** — verified from the
  crates.io dependencies API — while the `notify` v8 work sits under
  `## [Unreleased]`. **`linemux = "0.3"` would therefore pull a second, old
  `notify`.**
- It has an **open 100%-CPU spin bug** on the rotation path (issue #76: a reader
  orphaned after `Remove(File)` returns `Ready(Ok(None))` **without registering a
  waker**), with the fix PR **unmerged**.
- Its rotation detection is **length-only** (`if size < *pos { *pos = 0 }`), so a
  rotate-then-regrow is missed — issue #57.

Every other tailing crate is abandoned (`tail` 2018 and not a tailer;
`chase` 2018 and **won't compile on Windows**; `fs-tail` 2020 and swallows errors;
`tailf` shells out to `tail(1)`). ⚠ `follow` and `logtail` are **GPL-3.0** — red line.

**⇒ ~150 lines of our own**, with these measured pitfalls (each is a documented
failure mode of a crate that got it wrong):

- **`Ok(0)` from `read` is ambiguous and NOT terminal** — it means "no data *now*",
  and std documents that later appends will be read. Never treat it as EOF.
- **Truncation leaves the offset past EOF**; the cursor does not follow.
- **Buffer and emit only on `\n`** — reads split at arbitrary bytes — and **cap the
  buffer** (`linemux`'s is unbounded).
- **Do not let the tailer own decoding** (`linemux` aborts the stream on Latin-1,
  issue #70); decode per line with `from_utf8_lossy`.
- **Never `continue` on a not-ready stream without registering a waker** — that is
  exactly the #76 spin.

### 6.1 Why there is no transfer crate

The honest answer, checked rather than assumed:

- **No generic crate** takes a caller-provided reader/writer or an arbitrary
  framed transport. Every candidate brings its own transport:
  `tauri-plugin-upload` (HTTP, and its source shows **one request, no offsets, no
  resume**), `tus`/`tus-rs`/`fileloft` (HTTP), `mftp` (SSH/QUIC), `sftpx` (QUIC),
  `zrb` (SSH).
- **`zblob` 0.3.0** (2026-08-15, MIT) is the closest thing to a specification of
  what we need — manifest-first, range-set queries, per-slice bao verification,
  a **persisted chunk bitfield** next to the `.part` file, `fsync → rename → dir
  fsync` for atomic puts, and chunk constants (default 256 KiB, min 64 KiB, max
  4 MiB). **Read it as a design template; do not depend on it** — it is
  Zenoh-coupled in its public API, at 0.3.0, with ~1k downloads and one maintainer.

**⇒ The choreography is ours** (~200 lines: offset + bitfield + verify), and the
`blake3`/`bao-tree` half is the part with a real, maintained crate.

---

## 7. Recommendation

**Add exactly four crates:**

| Crate | Version | Why | Licence |
|---|---|---|---|
| `notify` | **`8`** | the only capability with no std equivalent. **Revised back to stable** — the rc's claimed advantage (#730) did **not** reproduce on either version (§4.6–4.7) | **CC0-1.0** |
| `blake3` | `1` | per-chunk digests; Merkle structure for free | CC0/Apache-2.0 |
| `bao-tree` | `0.16` | range verification — do **not** hand-roll | MIT/Apache-2.0 |
| `file-id` | `0.2` | rotation detection on Windows (u128 HighRes) | MIT/Apache-2.0 |

⚠ **Why stable 8.2.0 and not the 9.0.0-rc line.** An earlier revision of this
document recommended the rc *because* 8.2.0 was said to leak events after
`unwatch` (#730). **That was tested on both versions with the same instrument and
reproduced on neither** (§4.6). #963 (silent event loss on buffer overflow) remains
a source-level concern that was **not** reproduced either. The rc does carry real
ergonomics — a native `tokio` `EventHandler` and `watched_paths()` — but that is a
trade to make on ergonomics, not on a bug we could not demonstrate. **If the async
bridge matters, §4.7a gives the verified ~6-line stable-version equivalent.**

**Do not add**: `kkrpc` (dead protocol), `kkrpc-interop` (nonexistent), `fs2`
(frozen 2018), `fs4` (std covers locking), `linemux` (published build pins
`notify ^5`), `tauri-plugin-upload` (no resume; HTTP-only), `tus*`/`fileloft`/
`mftp`/`sftpx`/`zblob` (own transports), `ranges` (LGPL — red line),
`xxhash-rust` (BSL-1.0).

**Everything else is the standard library plus our own protocol**, with
[`../02-stream-both-ways.mjs`](../02-stream-both-ways.mjs) as the executable spec
for the streaming half.

---

## 8. The file-access layer: a separate question, and a known upstream defect

§7 answers *which crates*. This section answers *how the hands obtain a `File` in
the first place* — a different layer, and one where a shipped defect needs a
precise scope so it is not feared out of proportion.

### 8.1 `tauri-plugin-fs`'s `Fs<R>` IS reachable from Rust (verified by compiling)

This reverses the earlier "it is webview-only" reading, which was true only of the
**command** surface (`watch`, `read_file`, …): those take `Webview<R>` +
`Channel` + `CommandScope`, live in a **private** module, and are unreachable.
But the plugin also exposes an inherent Rust API:

```rust
// verified: this function-pointer coercion COMPILES
let _sig: fn(&Fs<Wry>, FilePath, OpenOptions) -> io::Result<std::fs::File> =
    Fs::<Wry>::open;
```

- **Desktop**: `app.manage(Fs(app.clone()))` runs on every platform
  (`lib.rs:508`), so `app.fs()` does not panic; and `Fs::open` is literally
  `path_or_err(path)` then `std::fs::OpenOptions::from(opts).open(path)` —
  **no scope check**, i.e. a convenience layer, *not* a sandbox. Do not treat it
  as a security boundary.
- **Android**: `Fs::open` routes a `content://` URI through the SAF fd bridge
  (`openAssetFileDescriptor` → `detachFd` → `File::from_raw_fd`) and hands back a
  real, seekable `std::fs::File`. **This is the one thing std cannot do on
  Android**, and it is the entire reason to prefer `Fs<R>` over raw `std::fs`.

⇒ **The hands should take the file handle from `Fs<R>::open` and do everything
else with std** (seek/append/read). The value is *entirely* on the mobile side; on
desktop it is exactly `std::fs`.

### 8.2 The known defect, and its TRUE (much narrower) trigger

`src/android.rs:83` ends in `unimplemented!()` when the Kotlin side reports no fd
— the **only** panic site in the whole crate (iOS has no equivalent). Upstream
fixes it in **[PR #3236](https://github.com/tauri-apps/plugins-workspace/pull/3236)**
("fix crash on getting file descriptor from android content uri"), **open since
2026-01-26**, and the change is **2 lines**.

The PR's own description ("due to missing permissions or the file not existing")
is **imprecise**, and the imprecision matters — reading it literally overstates
the risk. Traced through AOSP `android14-release`:

| Situation | What happens | Result |
|---|---|---|
| No permission / grant expired | **throws** `FileNotFoundException("App op not allowed")` (`ContentProvider.enforceFilePermission`, L794-806) or `SecurityException` | ✅ propagates as a normal **reject** |
| No such provider | **throws** `FileNotFoundException("No content provider")` | ✅ reject |
| Document deleted / cloud fetch fails | **throws** | ✅ reject |
| **Provider explicitly `return null`** | `ContentResolver` has three `return null` exits (L1838/1881/1896) | 💥 **`unimplemented!()` → abort** |

**So the panic needs a provider that *returns* null rather than *throwing*** —
legal (the return is `@Nullable`, and AOSP keeps dedicated branches for it) but
**not the common path**. `ContentProvider.openFile`'s own default implementation
*throws*, so a provider must go out of its way to hit this.

Why it cannot be caught from our side (three independent blockers, all verified):
1. `panic = "abort"` in the workspace release profile (`Cargo.toml:30`);
2. Cargo **rejects** any attempt to narrow it — `` `panic` may not be specified in
   a `package` profile `` (tested);
3. even under `unwind`, the panic originates across a **Kotlin→JNI→Rust** frame,
   where unwinding is UB.

Measured contrast (same code, one line changed):

| profile | outcome |
|---|---|
| `abort` | exit `0xC0000409` — process died instantly, catch never ran |
| `unwind` | panic caught, process continued, exit 0 |

**Assessment: a minor defect — accepted, not fixed now.** Worst case is a crash
and restart, not data loss; the trigger is narrow; and the fix is understood. The
barrier to acting is not the patch (2 lines) but **verification**, which needs a
real Android device and SDK; that is a scheduled decision, not a crate choice.
**Revisit when the Android line actually starts**, and then patch locally or
cherry-pick #3236.

⚠ **Two facts not to lose with the verdict:**
- The **asset** branch has the same hole: `FsPlugin.kt:48` is
  `activity.assets.openFd(path).parcelFileDescriptor?.detachFd()` — the `?.`
  produces null just as the `content://` branch does. So this is **not**
  `content://`-only.
- **`adb shell content` cannot test this.** It goes through
  `getContentProviderExternal` + `provider.openFile(uri,"r",null)`, **bypassing
  `ContentResolver.openAssetFileDescriptor` entirely**, and runs as uid 2000
  (shell) holding no URI grant — so it probes *shell's* permissions, not the
  plugin's fd bridge. A run of it here produced `SecurityException` for every URI,
  i.e. **a failure that did not vary with the input**, which is the same
  instrument-error signature this repo has hit before.

---

## 9. Honest limits

- **All crate facts are registry/source reads plus one compile-and-run per
  behavioural claim.** Nothing was benchmarked under sustained load.
- **Windows-only measurements.** `notify`'s Android backend (inotify) is verified
  from its README, **not** on a device; Android app-scoped storage may restrict
  what is watchable at all.
- **The rotation probe ran on local NTFS.** §4.3 is precisely the warning that
  network/WSL paths behave differently — and that case was **not** reproduced here,
  only read.
- **`blake3`'s hashing rate is one machine, one buffer.** The ordering versus the
  pipe is the finding; the absolute is not.
- **Not measured**: real sustained I/O throughput by chunk size (64 KiB vs 1 MiB),
  `fsync` cost per write, and behaviour when the file is on a slow/removable
  volume. Any chunk-size number quoted from a blog is folklore until measured.
- **`notify` 9.0.0-rc.5 WAS exercised** (built, ran, tokio handler + `watched_paths()`
  + a real event all confirmed) — but its *claimed* bug-fix advantage did **not**
  reproduce, which is why the recommendation reverted to stable (§4.7).
- **Neither #963 nor #730 was reproduced.** #730 was tested on both versions and
  came back clean on both; #963 was not attempted (it needs a deliberately
  overflowing directory). So the 8.2.0-vs-rc trade rests on **source reading for
  #963** plus verified ergonomics differences — **not** on an observed failure.
- **§8's Android defect was never reproduced on a device.** The trigger is derived
  from AOSP source, and `adb shell content` provably cannot exercise the path
  (§8.2), so no device-free substitute exists. The "minor defect, accepted" verdict
  therefore rests on source analysis plus the cost of the alternative — not on an
  observed crash.
- **The `Fs<R>::open` signature was verified by compiling, not by calling it** —
  constructing an `AppHandle` needs a Tauri runtime. The desktop body was read in
  source, so "it is exactly `std::fs`" is solid; the Android fd bridge is
  **source-read only**.

## 关联

- What the hands must do, and the measured transport: [`../FINDINGS.md`](../FINDINGS.md)
- Executable spec for the streaming half: [`../02-stream-both-ways.mjs`](../02-stream-both-ways.mjs)
- Cross-machine measurements: [`../../transport-lab/FINDINGS.md`](../../transport-lab/FINDINGS.md)
- kkrpc Rust↔npm interop background: [`../../../kkrpc-interop-findings.md`](../../../kkrpc-interop-findings.md)
- Probe conventions: [`../../README.md`](../../README.md)
