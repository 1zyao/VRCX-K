# Transport lab — what can actually carry a file between the face and the brain, measured

> **Scope**: binary/stream transport between the three parties, measured locally.
> bun **1.4.2** / node **v24.9.0**, Windows x64, kkrpc **2.1.0**, ws **8.21.3**.
> **Date**: 2026-09-23 · measured on branch `docs/transport-lab`.
> **All measurements are LOOPBACK (127.0.0.1)** — see §8 for what that does and does
> not license.
>
> **Why this is in the repo**: the conclusions below decide how file transfer,
> folder upload and long-lived subscriptions are built, and `host/` will cite
> them. Per `AGENTS.md` §临时工作区 → 转正触发点, evidence that becomes a design
> basis cannot stay in `.temp/`.
>
> **Provenance**: developed under `.temp/lab/` (18 scripts). What is kept here is
> the instrument that produced the numbers, plus the reports it wrote. Six scripts
> were discarded as superseded — see §7.3 for which and why.

---

## 0. Bottom line first

| Question | Answer | Confidence |
|---|---|---|
| Can `kkrpc/streaming` carry binary over ws? | **Yes**, byte-exact, both directions | **Definite** (56 cells × 3 repeats: 49/51 TCP/WS cells byte-exact in every run, the two exceptions being the json cells; 5/5 UDP cells losing, so the detector works) |
| Does raw binary work, or is base64 required? | **Raw binary works and is ~1.8x faster.** base64 is NOT required | **Definite** (56 cells × 3 repeats) |
| Does kkrpc's built-in ws transport work for this? | **No.** It JSON-serialises a `Uint8Array` into `{"0":12,…}` — **11.4x expansion**, **29.7x slower**, and at ≥1 MiB it **fails outright** (6–20 of 64 frames, every run timing out) | **Definite** (arithmetic + measurement) |
| Do we need a thread pool for file I/O? | **No.** Every async file API keeps the event loop free — **1.37 ms max lag against a 15.78 ms idle floor, node, 256 MiB** (the lower figures sometimes quoted are the **bun** half, which has **no checked-in artifact** — see §5) | **Definite for node**; **bun unverified** |
| …is there any I/O constraint at all? | **Yes: `Buffer.alloc(N)` is synchronous CPU.** It froze the loop for **64 ms at 256 MiB** (node, artifact) ⇒ **allocate in chunks, never `Buffer.alloc(fileSize)`** | **Definite for node** (the older "~0.25 s at 1 GiB" is a per-byte extrapolation, not a measurement) |
| Can bulk share the RPC tunnel "at low priority"? | **No.** Interactive RPC p50 goes 0.66 ms → **321 ms** (max 488 ms). A **separate connection** keeps it at 14 ms. ⚠ **Ordering is the finding, not the multiple** — that run had `n<30` in-transfer samples and the file warns against quoting it; a smaller-payload re-run compresses 740x → 2.0x. ⚠ **The checked-in run is the smaller one, and reports different absolutes again** — see §3 | **Definite** (own probe process) |
| Is the producer bounded when the consumer stalls? | **Yes**, exactly the credit window: **32 chunks (8 MiB)** after the consumer took one chunk and stopped, vs **256 chunks (64 MiB)** ungated — **8x** | **Definite** |
| Folder upload: one request per file, or packed? | **Per-file cost is one full RTT.** At 5 ms RTT that is **320x** slower; it grows linearly. ⚠ The **checked-in artifact is a different (loopback) configuration** — 200 files, `--rttMs` unset — so it is NOT the evidence for the RTT table | **Definite** (RTT sweep); **the 200-file 78x ratio is loopback-only** |
| Does concurrency help? | **In throughput yes — the checked-in run measures 2.17x at 4 levels** — but **budget by memory, not by throughput**. An older 4-level run measured only 1.26x on a different machine; the two runs disagree on the multiple and agree only on the shape | **Provisionally definite** — artifact says 2.17x; the 1.26x run is **not in the repo** and is not reproducible here. Neither figure is re-derivable without re-running |
| Does cancellation stop a producer? | **Yes**, promptly, in both gated and raw shapes (`0 further chunks after close` in both arms) | **Definite** ([`results/backpressure-report.txt`](results/backpressure-report.txt)) |

**The one hard conclusion that holds regardless of anything else**: **kkrpc's
built-in ws transport cannot carry binary.** Everything else is a design input.

---

## 1. The instrument, and why it can be trusted

```
proto.mjs     ONE definition of every rule, shared by both ends
server.mjs    one long-lived process: tcp + ws + udp, both directions, three encodings
client.mjs    one probe process, one cell, one machine-readable RESULT line
01..07        the seven experiments (matrix, backpressure, head-of-line, …)
results/      the reports and raw JSON each experiment wrote
```

Four design decisions carry the trustworthiness, and each one exists because an
earlier attempt got it wrong:

| Design | The failure it prevents |
|---|---|
| **`down` verified by the client, `up` by the SERVER** | A producer grading its own work. Early rounds verified only the receiving side, so a broken instrument looked like a broken library. |
| **Every frame carries an 8-byte sequence number** | Positional comparison **cannot distinguish a duplicate from a drop**. That ambiguity produced a wrong verdict in two separate rounds. |
| **Bytes are regenerated and compared EXACTLY** (no hash) | Hash collisions, and two ends disagreeing about how "expected" is computed. |
| **UDP is included as a falsification control** | A detector that never reports loss detects nothing. UDP loses 5/5 cells here, so the exact TCP/WS cells are meaningful rather than vacuous. |

Flag parsing in every probe normalises `--kebab-case` to `camelCase`. `server.mjs`
originally documented `--base-port=` while reading `args.basePort`, so the flag
was **silently ignored** and the server bound its default port — the symptom was
`ECONNREFUSED` on the requested port, which reads like a crash rather than a
misspelled key.

---

## 2. Encoding: what the bytes ride in (decisive)

`ws`, 64 frames, down, client = `ws` package. Same payload, three carriers:

| Encoding | 64 KiB | 1 MiB | 4 MiB |
|---|---|---|---|
| **raw** (native binary WS frame) | ✅ 136.8 MB/s | ✅ **217.2 MB/s** | ✅ **206.6 MB/s** |
| base64 (text frame) | ✅ 77.1 MB/s | ✅ 86.2 MB/s | ✅ 80.2 MB/s |
| **json** (numeric-keyed object = **kkrpc built-in**) | ✅ **4.6 MB/s** | ❌ **0/3, 6–8 of 64 frames** | ❌ **0/3, 11–20 of 64 frames** |

- The built-in encoding is **29.7x slower** at 64 KiB.
- **At ≥1 MiB it is not slow, it is unusable**: every repeat reached only 6–20
  frames and **consumed the entire 120 s timeout** — deterministic across 3/3
  runs, so not jitter.
- The cause is arithmetic, not measurement error: `JSON.stringify(new
  Uint8Array(65536))` yields `{"0":12,"1":13,…}`, i.e. **11.4x the payload**
  (64 KiB → a 747 KB text frame). `kkrpc/dist/ws.js` is literally
  `JSON.stringify` with `capabilities.transfer === false`.

**⇒ base64 is NOT required.** It is the cheapest encoding JSON can express, not
the cheapest possible: raw is 1.8x faster at 64 KiB and never loses.

### 2.1 Everything else was byte-exact

| Axis | Result |
|---|---|
| **tcp vs ws** (raw, 64 KiB, down) | tcp 150.5, ws 136.8 MB/s — **both 3/3 exact** |
| **down vs up** | down 136.8, up 185.0 MB/s — **both 3/3 exact** (up verified by the server) |
| **client: `ws` package vs runtime global** | 136.8 vs **203.9 MB/s — both 3/3 exact** |
| **frame size** 16 KiB → 4 MiB | raw exact throughout; 4 MiB sustained 206–254 MB/s |
| **volume** 8 / 64 / 256 frames | all 3/3 exact |

The client row matters for the product: `src/host.ts` builds its client through
kkrpc's `webSocketClientTransport`, which constructs the **runtime's global
`WebSocket`**. That client works and is faster ⇒ an earlier "global WebSocket
duplicates frames" reading was an instrument artifact, not a product risk.

---

## 3. Head-of-line blocking: bulk must not share the RPC tunnel

128 MiB transfer, probe on **its own connection in its own process** (a probe
measuring itself on the receiving client is measuring the wrong thing — its event
loop is saturated by inbound frames).

| Topology | RPC idle p50 | during p50 | during **max** | vs idle (max) |
|---|---|---|---|---|
| **shared tunnel** | 0.66 ms | **321 ms** | **488 ms** | **740x** |
| **separate connection** | 0.50 ms | 14.3 ms | 75.3 ms | 151x |

⚠ **The table above is NOT what the checked-in artifact says, and the artifact is
the smaller re-run this document already warns about.** `results/priority-report.txt`
is a 64 MiB (`--frames=1024`) run and reports its own numbers:

| Topology | RPC idle p50 | during p50 | during max | ratio (from its own verdict) |
|---|---|---|---|---|
| shared-tunnel | 0.57 ms | 96.76 ms | 130.67 ms | 170x (n<30) |
| separate-connection | 0.48 ms | 17.66 ms | 66.69 ms | **37x (n<30)** — verdict line: **"SHARING is 2.0x worse"** |

So the repo contains **two mutually inconsistent absolute sets** for this
comparison (488/75.3 ms vs 130.67/66.69 ms), both with `n<30` in-transfer
samples, and **only the second is checkable from the checked-in evidence**. The
prose below already resolves this the right way — *cite the ordering, not the
multiple* — but the top table's absolutes must not be quoted as "the" measurement.

Raw evidence for the second set:
[`results/priority-report.txt`](results/priority-report.txt). ⚠ That run recorded
**`n<30` in-transfer samples** — the probe says so itself (`only 0/2 topologies
produced >=30 in-transfer samples`; during `n=4` in both) — which is why the ratio
here is 2.0x rather than 740x. **Cite the ordering, not the multiple.**

**The conclusion the evidence supports: a shared tunnel blocks an interactive call
for tens to hundreds of milliseconds, while a separate connection is an order of
magnitude better but still not at idle.**

The residual ~67 ms on the separate path is **not** the socket: it is the measuring
server's single-threaded send loop, which cannot answer a ping while pushing bulk.
**The sender must yield in slices** regardless of topology.

> Re-running `04-shared-vs-separate.mjs` at a smaller payload (64 MiB, `--frames=1024`)
> reproduces the ordering but compresses everything — shared max 130.7 ms vs
> separate 66.7 ms, i.e. **2.0x** rather than 6.5x — and neither run reaches 30
> in-transfer samples, so the probe prints a warning instead of a quotable
> percentile. **The direction is stable; the magnitude depends on payload size
> and on how many probes land inside the transfer.** Use `--frames=2048
> --size=65536 --pingMs=5` to reproduce the table above.

---

## 4. Backpressure: is the producer bounded?

Consumer opens the stream, takes **one** chunk, then stops pulling.

| Arm | produced while stalled | implied in-flight | bounded |
|---|---|---|---|
| **kkrpc/streaming** | **32 chunks** | **8 MiB** | ✅ |
| no flow control (control) | 256 chunks | 64 MiB | ❌ |

**32 is exactly kkrpc's initial credit constant** — verified against the shipped
source map, not inferred: `STREAM_CREDIT_WINDOW = 32` and
`STREAM_CREDIT_REPLENISH = 16` in `dist/streaming.js.map`
(`sendStreamPull(streamId, STREAM_CREDIT_WINDOW)` on first pull, replenished once
16 values have been consumed). So flow control is real and does the work. Memory
while streaming a large file is `credit × chunk size`, **not the file size** — here
32 × 0.25 MiB = 8 MiB. That is what makes "streaming" true rather than nominal.

⚠ **Corrected from an earlier version of this table, which read `2048 chunks /
2048 MiB` and `64x`.** Those values were the probe's *default* `--total`, not the
setting the checked-in run used: the artifact ran with `--chunk=262144` (0.25 MiB)
and an effective total of 256 chunks. The artifact's own conclusion line —
`=> gating constrains the producer by 8x` — was right and this document was wrong.

Cancellation: **0 further chunks produced after close**, in both arms.

> The first version of this experiment reported "0 chunks produced ⇒ bounded",
> which was **vacuous**: the consumer never called `readFile()`, so the generator
> never started. A "bounded" reading is only meaningful when the stream actually
> opened; the file now guards on that.

---

## 5. Event loop: is a thread pool needed?

Event loop, **two runtimes, two independent processes** (the original claim).
⚠ **Only the node column is re-derivable from the repo.** The checked-in
`results/evloop-report.txt` is the **node** half and is a **256 MiB** payload
(`05-event-loop.mjs` invoked without `--sizeMiB`; the script's default is 1024, so
the artifact either predates that default or was produced with an explicit flag).
The **bun** column, and the `1 GiB` this section used to state as its payload, are
**not backed by any checked-in artifact** — see the note under the table.

| Operation | node max lag (256 MiB, artifact) | bun max lag (unverified, no artifact) |
|---|---|---|
| IDLE floor | 15.78 ms | 2.6 ms (unverified) |
| **CONTROL `readFileSync`** | **0 samples (frozen 95.7 ms)** | **0 samples (frozen 532 ms)** (unverified) |
| `fs/promises readFile` | 1.37 ms | 2.0 ms (unverified) |
| `Bun.file().arrayBuffer()` | — (node cannot run it) | 2.2 ms (unverified) |
| `Bun.file().stream()` chunked | — (node cannot run it) | 3.2 ms (unverified) |
| `handle.write` slices | **no checked-in row** (see the note below) | **no checked-in row** |
| `writeFile` one call | **1.35 ms** | 2.3 ms (unverified) |
| `createWriteStream` 64 KiB | **no checked-in row** | **no checked-in row** |
| **`Buffer.alloc` + fill (pure CPU)** | **frozen 64 ms, 0 samples** | **frozen 273 ms, 0 samples** (unverified) |

⚠ **What this table used to claim and why it is now marked.** An earlier version
listed `handle.write` 8 MiB slices (16.2 / 2.6 ms), `createWriteStream` 64 KiB
(16.0 / 6.5 ms) and a 1 GiB payload for every row. **The currently checked-in
`evloop-report.txt` has no `handle.write` row and no `createWriteStream` row at
all**, and it is 256 MiB, not 1 GiB. Those rows are therefore **not reproducible
from the repository** — they most plausibly came from a bun-side run of the older
`evloop.mjs` that §7.3 records as discarded. They are left marked rather than
deleted, because the constraint they support (§5's conclusion) is independently
carried by the two `CONTROL` rows. **Settling them needs a bun run of the current
script plus a re-added slice/write-stream row** — do not quote them as measured.

- Disk measured at **2.4–2.8 GB/s**, network at **0.14–0.26 GB/s** — the disk is
  **~10x faster**, so I/O is not even the throughput bottleneck.
- **⇒ No thread pool.** Concurrency stays a tuning knob, not a structural need.
- **But `Buffer.alloc(N)` is synchronous CPU work**: the artifact freezes the loop
  for **64 ms at 256 MiB** (~275 ms at 1 GiB by the same per-byte cost, which is
  where the old "~0.25 s" figure came from) ⇒ **read/write in bounded chunks;
  never allocate the whole file up front.**

> A BLOCKING call produces **ZERO** lag samples, not many — the timer never fires
> while the loop is frozen. The first version read `null` as "no lag" and then as
> "instrument broken"; both are wrong. Zero samples across a long call is maximal
> blocking, and is scored as such.
>
> An earlier reading blamed `writeFile` for a 266 ms stall. **That was the
> instrument**: `Buffer.alloc(1 GiB)` sat inside the timed closure. The write
> paths themselves sit at the idle floor.

---

## 6. Folder upload: per-file cost is one round trip

1000 files × 4 KiB, same connection, **identical total bytes** in both modes:

| RTT | one request per file (1000) | packed (1 request) | ratio |
|---|---|---|---|
| 0 ms (loopback) | 87 ms | 20 ms | 4.3x |
| **1 ms** | 1586 ms | 18 ms | **88x** |
| **5 ms** | 6071 ms | 19 ms | **320x** |
| **20 ms** | 21117 ms | 38 ms | **556x** |
| **50 ms** | 51204 ms | 81 ms | **632x** |

Loopback hides this because RTT ≈ 0. On a real link the cost is **88–632x** and
grows linearly with file count.

⚠ **The checked-in artifact is a different configuration and must not be read as
the evidence for the table above.** `results/folder-report.txt` is a **loopback**
run — 200 files × 4096 B, `--rttMs` unset — and it reports `packed is 78.26x the
speed of one-request-per-file` at 66 files/s. Note **both loops are hidden**: the
`66 files/s` is itself a loopback artifact (the artifact separately extrapolates
`10,000 files … ~151.5s one-by-one`), and **78.26x does not correspond to any row
above** — the 1000-file / 0 ms cell measured **4.3x**. The two loopback runs
disagree, most plausibly because the packed arm's terminator wait dominates at
200 files (13 frames) in a way it does not at 1000. **Do not quote 78.26x beside
the RTT ratios**; it is a small-folder, no-injected-RTT measurement.
**The 1/5/20/50 ms rows above are not independently
re-derivable from anything in `results/`** — they would need
`06-folder-upload.mjs --files=1000 --rttMs=<n>` re-run.

Note also that the probe's `--rttMs` is an **injected server-side delay, not a
network** (§8): it models the cost of a round trip without modelling a real link,
so treat these ratios as a cost model rather than a measurement of any network.

**Three shapes, and the recommendation is the middle one:**

| Shape | Requests | Strength | Cost |
|---|---|---|---|
| per-file | N | exact progress, single-file retry | N × RTT |
| **batched (N files/request)** | **N/K** | **no archive dependency; batch-granular progress and retry** | needs a batch size |
| packed blob | 1 | fastest | zip/tar dependency; only whole-blob progress; one bad file re-sends everything |

**Do not give the hands a "packing skill."** §5 shows the shell's I/O is not the
bottleneck, and packing would bind archive format, progress semantics and resume
into the shell. Directory walking, batch sizing and retry are **business policy
and belong in the brain (`host/`)**, which needs only stateless primitives from
the hands: read one file, write one file.

⚠ **This paragraph used to say "two stateless primitives", and that count is now
wrong in a way that matters.** The hands ship **five** — `stat` / `read` / `write` /
`watch` / **`list`** — because **enumeration had to become a capability too**: "walk
the directory in the brain" presumes the brain can reach that disk, and this whole
capability exists for the case where it cannot. `list` lists **one** directory,
non-recursively, unfiltered; **recursion, patterns, sorting and batching stay
policy**. See [`../../hands-capability-proposal.md`](../../hands-capability-proposal.md)
§1.1, which records the correction and the direct measurement behind it
(`stat(dir)` returns no entries; `read(dir)` raises `EISDIR`). **This does not
change the §6 conclusion** — packing still belongs in the brain — but the
reasoning must not rest on a primitive count that is no longer true.

---

## 7. Concurrency, and what was thrown away

### 7.1 Concurrency buys throughput — and costs memory

⚠ **This section was inverted relative to its own artifact.** It used to report
**"1.26x at best ⇒ sequential or small batches"**. The only concurrency artifact in
the repo, `results/conc2-report.txt`, says the opposite: `scaling vs level 1 :
2.17x` and its own conclusion line reads **"parallelism DOES raise aggregate
throughput, so it is worth offering"**. The document also printed a 4-level table
(1/2/4/8 at 240 MiB) while the artifact ran **two levels** (1 and 4) at 16 MiB per
transfer. Corrected to the artifact below.

`07-concurrency.mjs`, one connection **per transfer**, verifier = the client
(`results/conc2-report.txt`, 4 MiB per file = 64 × 64 KiB, node v24.9.0):

| level | exact | wall | aggregate | fastest/slowest | heap delta | verified |
|---|---|---|---|---|---|---|
| 1 | 1/1 | 56 ms | 72 MB/s | 26 / 26 ms | +3.1 MiB | 4/4 MiB |
| 4 | 4/4 | 102 ms | **156.4 MB/s** | 41 / 94 ms | +0.8 MiB | 16/16 MiB |

**2.17x at 4 levels.** The recommendation follows from the artifact's own verdict,
which is a *memory-budget* argument rather than a "don't parallelise" one:

> Budget by MEMORY, not by throughput: each stream costs buffers, and the heap
> delta above is the price per level on this machine.

⚠ **What is not settled, and must not be quoted.** An older run of this probe
reported a **1.26x** best case and a 4-level table topping out at **366.2 MB/s**
with a **+23.3 MiB** heap delta at level 4. **That run is not in the repo** (no
`conc2-report.txt` matches it; `results/README.md` repeated its conclusion) and its
numbers are **not reproducible from anything checked in**. Two runs on two
machines disagree on the multiple (1.26x vs 2.17x) while agreeing on the shape
(level 1 is the baseline; aggregate rises with level; memory is the real cost).
**Which is right cannot be decided here** — settling it needs
`node docs/probes/transport-lab/07-concurrency.mjs --sizeMiB=16` re-run on the
current machine, with the level set stated. Note also that the two runs differ in
level depth (1/2/4/8 vs 1/4), so they are **not** a like-for-like comparison even
before the machine difference.

Also note the artifact's own caveat, which the 4-level table obscures: **heap delta
was LOWER at level 4 (+0.8 MiB) than at level 1 (+3.1 MiB)** here, so this single
run does not by itself demonstrate the "memory rises with level" claim either.
Interference rose as expected (L1 = 0 ms, L4 = 53 ms).

### 7.2 Two failures that were mine, and the patterns they reveal

1. **Frames built 8 bytes short** ⇒ every frame "corrupt" at every level,
   including level 1. **A failure that does not change with the variable is a
   probe bug**, not a property of the system.
2. **The failure message omitted a counter.** `exact` was false while the text
   read `missing=0 corrupt=0`, because the real failure was on `duplicates` —
   the one column not printed. **Omitting a column has now hidden a real result
   twice in this investigation** (also §7.3's first entry).

### 7.3 Superseded scripts, deliberately not kept

| Discarded | Replaced by | Why |
|---|---|---|
| `evloop.mjs` | `05-event-loop.mjs` | The 256 MiB payload was served from page cache (2.35 GB/s), so the blocking control never blocked; `setInterval` also drifted 10.3 ms on an IDLE process. |
| `conc.mjs` | `07-concurrency.mjs` | Multiplexed N files onto ONE socket with a fileId tag. The demultiplexing was the only complexity and the only place a bug could hide — and it hid two. One connection per transfer removes it entirely, and §3 already showed separate connections are the better topology. |
| `evloop.mjs` variants, `isolate-write.mjs`, `extract.cjs`, `folder-sweep.mjs`, `conc-tail.txt`, `ceiling.ts`, `fragmentation.ts`, `sequence.ts`, `pin.ts`, `frame-size.ts`, `final.ts`, `isolation.ts`, `binary-transport.ts`, `probe-stream.ts`, `rawws-matrix.ts`, `kkrpc-matrix.ts`, `inflight.ts` | this set | In-process instruments. Their readings (4703 duplicate events from 64 frames sent; a "1 MiB frame ceiling") **did not reproduce across processes and were never explained**. They are superseded and **must not be cited**. |

---

## 8. Honest limits

- **Everything here is loopback** except the cross-VM section added below (§8.1).
  Real-network RTT is the one variable this set does NOT measure, and §6 shows RTT
  is decisive for folder upload. ⚠ **The original claim here — "`client.mjs`
  accepts `--host`, so a real-interface run needs no new code" — was FALSE**, and
  is corrected in §8.1: `server.mjs` hardcoded `127.0.0.1` on all three bind sites,
  so no other host could reach it at all. A `--bind` flag was added.

### 8.1 The cross-VM run (done, 2026-09)

A genuinely cross-VM measurement now exists: a **Linux** node inside a WSL distro
driving this lab's own `client.mjs` against a Windows-side `server.mjs` started
with `--bind=0.0.0.0`. Same instrument, no new probe code; see
`hand-io/cross-vm-sweep.sh` and `hand-io/FINDINGS.md` §7.2.

**RTT across the hop: 0.400 ms mean, 0.345 ms p50, 0.495 ms p95** (50 samples,
measured — not assumed).

⚠ **Two traps that make a fake cross-VM run easy to produce, both hit here:**

1. **The server could not be reached off-loopback** until `--bind` was added (above).
2. **A Windows `node.exe` launched from WSL via interop runs as a WINDOWS process.**
   It reports `process.platform === "win32"` and connects with
   `local=127.0.0.1` → `remote=<vSwitch IP>`, i.e. **Windows loopback**, not the
   WSL hop. Numbers taken that way look plausible and are meaningless. The
   working setup is a real **Linux** node; a minimal WSL distro may ship none and
   may be unable to install one, in which case a musl build extracted onto a
   mounted volume is the workaround.
   **Always check `process.platform` and the socket's local address before
   believing a cross-host number.**

64 MiB total per cell, **two independent cross-VM runs** (the spread is shown
because single numbers here are not reproducible — cross-VM uses musl node
v24.18.1, loopback used Windows node v24.9.0, so the delta mixes runtime and
network):

| cell | cross-VM (run A / run B) | loopback | cross-VM / loopback |
|---|---|---|---|
| ws down, raw | 155.0 / **129.0** MB/s | 168.9 MB/s | 0.76–0.92x |
| ws down, base64 | 65.2 / **69.6** MB/s | 71.3 MB/s | 0.91–0.98x |
| ws down, raw, `client=global` | — / **191.0** MB/s | 203.9 MB/s | 0.94x |
| ws up, raw | 66.5 / **74.0** MB/s | 135.6 MB/s | 0.49–0.55x |
| tcp down, raw | 90.0 / **95.1** MB/s | 101.6 MB/s | 0.89–0.94x |
| ws down, **json** | **5/64 frames, 120 s timeout** | (same failure) | — |

⚠ **The absolute numbers move 20%+ between runs** (ws raw: 155.0 then 129.0). As
§8 already says for the original set: **ratios and orderings are the finding;
absolutes are not.** Do not quote a single cell.

Three things this **confirms** rather than overturns:

- **The json-encoding failure reproduces across a real hop**, twice: 5 of 64
  frames and the full 120 s timeout, the same deterministic collapse §2 reports on
  loopback. The headline "kkrpc's built-in transport cannot carry binary" holds on
  a real link.
- **raw > base64 keeps its ordering** (155.0/129.0 vs 65.2/69.6 cross-VM;
  168.9 vs 71.3 loopback), i.e. the encoding conclusion is not a loopback
  artifact.
- **`client=global` beats the `ws` package cross-VM too** (191.0 vs 129.0 in the
  same run), matching the loopback ordering and strengthening the §2 note that the
  runtime's global `WebSocket` — what `src/host.ts` actually ships — is the better
  client.

And one thing it does **NOT** settle:

- **The hop is far too fast to model a real network.** 0.4 ms is ~0.3 ms above
  loopback. §6's decisive regime is 5–50 ms, where folder upload degrades 320–632x.
  **This run therefore does not license any conclusion about real-world WAN
  behaviour**; it only removes "never left the machine" as an objection. Producing
  the high-RTT case needs `tc netem` (absent here, and `NET_ADMIN` alone would not
  install it) or a real remote host. **The folder-upload RTT sweep still rests on
  the probe's simulated `--rttMs`, which is a delay injection, not a network.**
- **Throughput absolutes vary with machine load.** The `spread` column in
  `matrix-report.txt` shows up to 132 MB/s of variation. **Ratios are stable;
  absolutes are not.**
- **tcp dipped to 68 MB/s at 4 MiB while ws held 206 MB/s** — not investigated;
  likely the probe's own `Buffer.concat` accumulation in `TcpFramer`, i.e.
  instrument overhead rather than a protocol difference.
- **Not measured at all**: resume after interruption; progress-reporting
  granularity and its cost; binding a stream's life to `ctx.effect` so a plugin
  unload tears it down; Android `content://` (a real device returns an opaque URI
  from `pickFile`, not a path, and that has never been verified).
- ~~the hands have **no file I/O primitive in `src-tauri` yet**~~ — **this is no
  longer true and the sentence is struck rather than deleted so the change is
  visible.** The hands now ship **five** file primitives —
  `hands.stat` / `hands.read` / `hands.write` / `hands.watch` / **`hands.list`** —
  in `src-tauri/src/hands.rs`, with `register_hands_handlers` wiring them onto a
  `Peer`. They are driven end-to-end over real OS pipes with the real production
  modules by [`../hands-e2e/run.mjs`](../hands-e2e/run.mjs) (its own driver is
  `src-tauri/examples/hands-e2e.rs`), and the capability surface is specified in
  [`../../hands-capability-proposal.md`](../../hands-capability-proposal.md).
  ⚠ **The five-primitive count is a correction of this document's older claim of
  "four"**: enumeration had to become a capability too, because "directory walking
  belongs in the brain" only holds when the brain can reach that disk at all —
  which is exactly what this capability exists to avoid. See that proposal's §1.1.
  ⚠ Everything that *consumes* these primitives over the real bridge is still
  measured elsewhere, not here: this lab measures **transport**, and the bridge's
  own end-to-end results live in `../hands-e2e/` and `../hand-io/`.
- **The earlier in-process anomalies were never explained.** They did not
  reproduce across processes, and the instruments that produced them are gone.
  This is recorded rather than quietly dropped, because "we could not reproduce
  it" is not the same as "it was not real".

---

## 9. Re-running

```bash
# the general server (tcp 47000 / ws 47001 / udp 47002) as a background task
node docs/probes/transport-lab/server.mjs --base-port=47000

# ...and to let ANOTHER HOST reach it (required for a cross-VM/cross-machine run;
# the default stays loopback). See §8.1.
node docs/probes/transport-lab/server.mjs --base-port=47800 --bind=0.0.0.0

# the full matrix, 3 repeats per cell (~10 min; the json-encoded 1/4 MiB cells
# each burn a 120 s timeout by design — that IS the finding)
node docs/probes/transport-lab/01-transport-matrix.mjs --repeats=3 --base-port=47000
node docs/probes/transport-lab/01-transport-matrix.mjs --quick=true --repeats=2 --base-port=47000

# one cell by hand
node docs/probes/transport-lab/client.mjs --transport=ws --port=47001 \
  --direction=down --frames=64 --size=65536 --encoding=raw --client=global

# a cell against a REMOTE server (this is what §8.1 did, from a WSL linux node):
node docs/probes/transport-lab/client.mjs --transport=ws --host=172.25.32.1 \
  --port=47801 --direction=down --frames=64 --size=1048576 --encoding=raw --client=ws
# ⚠ do NOT launch the client with a Windows node.exe from inside WSL and call it
# cross-VM: interop runs it as a Windows process and it egresses from 127.0.0.1.
# Check `process.platform` and the socket's local address. See §8.1.

# the rest are self-contained (each starts what it needs)
node docs/probes/transport-lab/02-backpressure.mjs
node docs/probes/transport-lab/05-event-loop.mjs --sizeMiB=1024
node docs/probes/transport-lab/06-folder-upload.mjs --files=1000 --rttMs=5
node docs/probes/transport-lab/07-concurrency.mjs --sizeMiB=16

# head-of-line needs its own server first (it answers RPC pings too)
node docs/probes/transport-lab/03-head-of-line-server.mjs --port=46100
node docs/probes/transport-lab/03-head-of-line.mjs --port=46100 --frames=2048 --size=65536
node docs/probes/transport-lab/04-shared-vs-separate.mjs --port=46100
```

**On Windows `spawn("bun")` fails** — the name on PATH is an npm shim, not a
`Win32` executable. Pass the real binary (e.g.
`%APPDATA%\npm\node_modules\bun\bin\bun.exe`) via `E2E_BUN`; the probes that spawn
a runtime read that variable.

## 关联

- Device/session/multi-client design (the #13 line): [`../../host-sessions-design.md`](../../host-sessions-design.md)
- Mobile topology (why the brain moves and stdio breaks): [`../../mobile-feasibility.md`](../../mobile-feasibility.md)
- Cordis runtime rules any implementation must follow: [`../../cordis-runtime-findings.md`](../../cordis-runtime-findings.md)
- Probe conventions ([].every() trap, bare specifiers, biome coverage): [`../README.md`](../README.md)
