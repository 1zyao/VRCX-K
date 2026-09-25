//! The hands' file capability: `hands.stat` / `hands.read` / `hands.write` /
//! `hands.watch` / `hands.list`.
//!
//! Scope, stated because it is easy to over-read: this is the **transport and
//! primitive layer** only. It is NOT the plugin-facing SDK — the `ctx.hands`
//! service, its types and its audit hook live on the brain side and are shaped
//! by [`../../docs/hands-capability-proposal.md`]. What lands here is the part
//! the proposal cannot decide on its own: the primitives, over the wire, with
//! real backpressure and real cancellation.
//!
//! # Why this set, and not more
//!
//! Measured, not chosen: the per-file cost of a remote round trip is a full RTT
//! (~1 RTT per file; at 5 ms RTT that is 320x slower than batching), so batch
//! sizing and retry belong to the caller. `docs/probes/transport-lab/FINDINGS.md`
//! §6.
//!
//! ⚠ **That measurement does NOT license "no enumeration primitive", and an
//! earlier revision of this file wrongly read it that way.** §6 measured
//! transferring N files whose names were ALREADY KNOWN, and concluded that
//! walking is caller policy. The premise — the caller can walk — holds only when
//! the caller can reach the filesystem. §7.1 of the same document is the case
//! this capability exists for: a REMOTE hands, where the brain cannot see the
//! disk at all. Without `hands.list` a caller cannot discover a single filename,
//! so "walking is policy" leaves it with no way to start.
//!
//! The split that survives both facts:
//!
//! - **Enumerate** — a capability. Only the hands can answer "what is here",
//!   so it is a primitive.
//! - **Match / sort / recurse / batch / retry** — policy. None of it needs
//!   filesystem access, so it stays with the caller.
//!
//! `hands.list` therefore lists ONE directory, non-recursively, unfiltered.
//!
//! # Path semantics (deliberately not inherited from the platform)
//!
//! The hands pass the caller's string to the OS, so the OS decides:
//!
//! - **Absolute paths** are the intended form and the only one the SDK
//!   documents.
//! - **Relative paths resolve against the hands' own process cwd** (verified).
//!   That is meaningless on a remote node, where the caller has no idea what the
//!   hands' cwd is — so callers must not rely on it.
//! - `..` **is resolved by the OS, and lexically**: `NOSUCHDIR\..\..` resolves
//!   even though `NOSUCHDIR` does not exist (verified). This is inherited
//!   behaviour, not a permission boundary.
//! - `~` and `%VAR%` are **NOT expanded** (verified: they are treated as
//!   literal names). Expansion is the caller's job, because only the caller
//!   knows the user's shell conventions — and the hands' environment may belong
//!   to a different machine.
//!
//! There is **no path confinement**: any path the hands process can reach is
//! reachable. That is a known, accepted property of this layer (the proposal
//! keeps authorisation coarse and at the primitive level, not the path level),
//! and it is written down here so no caller mistakes it for a sandbox.
//!
//! # Backpressure is not optional
//!
//! `read` and `watch` return kkrpc **stream references**, so the host pulls and
//! memory is `credit × chunk`, not file size. A consumer that stops taking
//! values stops the producer at the credit window (32 by default). The
//! alternative — one reply carrying all the bytes — is the thing that measured
//! as unusable at ≥1 MiB.
//!
//! # Chunking, and the one synchronous-CPU trap
//!
//! Every buffer here is allocated per chunk and bounded by [`CHUNK`]. A single
//! `vec![0; file_size]` is *synchronous* CPU in the caller's thread: measured at
//! ~0.25 s of frozen event loop for 1 GiB. So the rule is structural, not
//! stylistic — there is no code path that allocates a whole file.

use crate::kkrpc_peer::{
    DeferredReply, Peer, StreamProducer, StreamSink, StreamSource, StreamStep,
};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

/// Bytes per stream chunk. Sized to match the probe's proven value and to stay
/// well inside the credit window's memory bound (32 × 256 KiB = 8 MiB).
const CHUNK: usize = 256 * 1024;

/// Register every `hands.*` capability handler on the peer.
pub fn register_hands_handlers(peer: &Arc<Peer>) {
    register_stat(peer);
    register_read(peer);
    register_write(peer);
    register_watch(peer);
    register_list(peer);
}

// --- error surface ---------------------------------------------------------

/// The error codes the proposal fixes. Kept as a closed set because adding a
/// code later is a breaking change for callers that branch on it.
///
/// `ESTALE` is deliberately distinct from `ENOENT`: "the path is now a different
/// file" (reopen and reset the offset) and "the file is gone" (usually give up)
/// need opposite handling, and merging them forces callers to match on message
/// text. See the proposal's §2.2.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Code {
    NotFound,
    Denied,
    IsDir,
    /// The mirror of `EISDIR`: a directory operation was asked of a non-directory.
    ///
    /// Distinct from `EISDIR` because the fix differs: `EISDIR` means "you asked
    /// for file content on a directory" (read its entries instead), `ENOTDIR`
    /// means "you asked for a listing on a file" (stat it instead). Collapsing
    /// them would make one message explain both.
    NotDir,
    Stale,
    NoSpace,
    Unsupported,
}

impl Code {
    fn as_str(self) -> &'static str {
        match self {
            Code::NotFound => "ENOENT",
            Code::Denied => "EACCES",
            Code::IsDir => "EISDIR",
            Code::NotDir => "ENOTDIR",
            Code::Stale => "ESTALE",
            Code::NoSpace => "ENOSPC",
            Code::Unsupported => "EUNSUPPORTED",
        }
    }
}

/// Map an `io::Error` onto the closed code set.
///
/// The code is carried in the error message as a `CODE: detail` prefix rather
/// than as a structured field: kkrpc's error frame only carries `{n,m}` (name,
/// message) — see `dist/channel-*.js`'s `T()` encoder — so an extra property
/// would be dropped on the wire. A prefix survives and stays greppable.
fn encode_error(code: Code, detail: impl std::fmt::Display) -> String {
    format!("{}: {detail}", code.as_str())
}

fn classify(error: &std::io::Error) -> Code {
    match error.kind() {
        std::io::ErrorKind::NotFound => Code::NotFound,
        std::io::ErrorKind::PermissionDenied => Code::Denied,
        std::io::ErrorKind::IsADirectory => Code::IsDir,
        std::io::ErrorKind::StorageFull => Code::NoSpace,
        std::io::ErrorKind::Unsupported => Code::Unsupported,
        // Windows reports a directory handed to `File::open` for writing as
        // "access denied" rather than `IsADirectory`.
        std::io::ErrorKind::Other if error.to_string().contains("os error 5") => Code::Denied,
        _ => Code::Denied,
    }
}

// --- stat ------------------------------------------------------------------

/// `hands.stat(path) -> {size,id,mtimeMs,kind,entries} | null`
///
/// Returns `null` for a missing path instead of throwing: "does not exist" is a
/// normal answer to a question, and forcing callers into try/catch for control
/// flow is how error codes get ignored. **Any other failure throws**, so a path
/// that exists but cannot be read (permissions) reaches the caller as an error
/// rather than as a stat with no size.
///
/// # Why this is a DEFERRED handler rather than a plain `peer.on`
///
/// It does not stream, so `peer.on` looks like the natural fit — and it was the
/// original implementation. But a sync handler's reply frame is always
/// `{"t":"r","v":…}` (see `kkrpc_peer.rs`): there is **no error arm**, so the
/// failure had to be smuggled through the VALUE as `{"error":"CODE: detail"}`.
///
/// That produced a wrong answer rather than an error. Measured:
///
/// ```text
/// stat("\\.\NUL") RESOLVED to: {"error":"EACCES: …"}
///   -> .size is undefined
/// ```
///
/// A caller writing `(await ctx.hands.stat(p)).size` gets `undefined` instead of
/// a rejection — "cannot read it" is disguised as "read it, no size". The
/// `read`/`write`/`watch`/`list` handlers all use `on_deferred` and `reply.fail`
/// for exactly this reason; `stat` now does too, so all five agree.
fn register_stat(peer: &Arc<Peer>) {
    peer.on_deferred(
        "hands.stat",
        Arc::new(
            |reply: DeferredReply, args: Vec<Value>| match stat_outcome(&str_arg(&args, 0)) {
                Ok(stat) => reply.send(stat),
                Err(message) => reply.fail(message),
            },
        ),
    );
}

/// The three outcomes of a stat, as the WIRE sees them.
///
/// Split out from the handler so the reply SHAPE is unit-testable: the handler
/// itself needs a live `DeferredReply`, and the bug this guards against lived
/// precisely in the choice between "value" and "failure" — not in `stat_path`.
///
/// - `Ok(value)` → a normal reply. `Value::Null` means "not there", which is a
///   normal answer and must stay a value.
/// - `Err(message)` → `reply.fail`, carrying the `CODE: detail` prefix the host
///   parses back into `HandsError.code`.
fn stat_outcome(path: &str) -> Result<Value, String> {
    match stat_path(path) {
        Ok(stat) => Ok(stat),
        // "Does not exist" is a normal answer to a question. Forcing callers into
        // try/catch for control flow is how error codes get ignored.
        Err(error) if classify(&error) == Code::NotFound => Ok(Value::Null),
        // Everything else is a real failure and must NOT masquerade as a
        // successful stat — see `register_stat`'s doc for the measured bug.
        Err(error) => Err(encode_error(classify(&error), error)),
    }
}

fn stat_path(path: &str) -> std::io::Result<Value> {
    // `File::open` on a directory succeeds on Unix but not on Windows, so
    // branch on the type first and only open regular files (which is what
    // `file-id` needs).
    let meta = std::fs::metadata(path)?;
    let kind = if meta.is_dir() {
        "dir"
    } else if meta.is_file() {
        "file"
    } else {
        "other"
    };

    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|delta| delta.as_millis() as u64)
        .unwrap_or(0);

    // Identity is best-effort: a filesystem that cannot report one (some
    // network shares) must not turn `stat` into a failure, because size and
    // mtime are still useful. Callers that need rotation detection compare
    // `id` only when it is present.
    let id = file_id::get_file_id(path)
        .ok()
        .map(|id| format!("{id:?}"))
        .unwrap_or_default();

    // Listing the entries is BEST-EFFORT, for the same reason identity is: a
    // directory that can be stat'd but not read is a real state (execute-only
    // permission), and its size/mtime/kind are still true and still useful. So a
    // failed listing must not fail the `stat`.
    //
    // It must not be SILENT either. `entries` is null for a non-directory, and
    // an object for a directory — one that carries `error` when the listing
    // failed. That keeps three states apart that a single null would merge:
    // "not a directory", "an empty directory", and "a directory I cannot read".
    let entries = if kind == "dir" {
        match read_entries(path, STAT_PREVIEW_MAX) {
            Ok((items, truncated)) => json!({ "items": items, "truncated": truncated }),
            Err(error) => json!({ "items": [], "truncated": false, "error": error }),
        }
    } else {
        Value::Null
    };

    Ok(json!({
        "size": meta.len(),
        "id": id,
        "mtimeMs": mtime_ms,
        "kind": kind,
        // A BOUNDED preview, so "is this the directory I meant" is answerable
        // without a second round trip — the common case. `truncated` says
        // whether it is the whole story; a caller that needs every entry calls
        // `hands.list`, which streams and has no size bound.
        "entries": entries,
    }))
}

// --- list (producer) -------------------------------------------------------

/// How many entries `stat` may inline as a preview before `list` must be used.
///
/// Small on purpose. `stat` is called on hot paths (the read loop re-checks
/// identity per chunk), so its reply has to stay predictably cheap. A preview
/// answers "is this the directory I meant" without turning `stat` into a call
/// whose reply size depends on a directory the caller has not seen yet.
const STAT_PREVIEW_MAX: usize = 16;

/// One directory entry, as the wire shape.
fn entry_of(entry: &std::fs::DirEntry) -> Value {
    let name = entry.file_name().to_string_lossy().to_string();
    // `symlink_metadata`, not `metadata`: following a link here would make the
    // listing report the TARGET's type, so a broken link would look missing and
    // a link to a directory would look like a directory. The listing describes
    // what is IN the directory, which is the link itself.
    let meta = std::fs::symlink_metadata(entry.path());

    let (kind, size) = match &meta {
        Ok(meta) if meta.file_type().is_symlink() => ("symlink", meta.len()),
        Ok(meta) if meta.is_dir() => ("dir", 0),
        Ok(meta) if meta.is_file() => ("file", meta.len()),
        Ok(meta) => ("other", meta.len()),
        // An entry we cannot stat is still an entry. Reporting it as an error
        // would fail the whole listing for one unreadable file, and a caller
        // walking a directory needs to know it is there.
        Err(_) => ("other", 0),
    };

    json!({ "name": name, "kind": kind, "size": size })
}

/// Read at most `limit` entries, plus whether more remain.
fn read_entries(path: &str, limit: usize) -> Result<(Vec<Value>, bool), String> {
    let dir = std::fs::read_dir(path).map_err(|error| encode_error(classify(&error), error))?;
    let mut entries = Vec::new();
    let mut more = false;
    for entry in dir {
        let Ok(entry) = entry else {
            // A single unreadable entry must not fail the listing; it is skipped
            // and the caller still learns what else is there.
            continue;
        };
        if entries.len() >= limit {
            more = true;
            break;
        }
        entries.push(entry_of(&entry));
    }
    Ok((entries, more))
}

/// `hands.list(path) -> stream of entry batches`
///
/// # Why this is a primitive and not "caller policy"
///
/// The four-primitive design rests on "directory walking is the caller's job,
/// because the caller can do it". That premise holds only when the caller can
/// reach the filesystem — which is exactly what is NOT true here. The measured
/// case (`transport-lab/FINDINGS.md` §6-§7.1) is a REMOTE hands: the brain
/// cannot enumerate a disk it cannot see, so "walking is policy" would leave the
/// caller with no way to discover a single filename.
///
/// The split that does hold:
///
/// - **Enumerate** (what is in this directory?) — a capability, only the hands
///   can answer it, so it belongs here.
/// - **Match, sort, recurse, batch, retry** (which of those do I want, and in
///   what order?) — policy, needs no filesystem access, belongs to the caller.
///
/// So this lists ONE directory, non-recursively, in filesystem order, with no
/// pattern argument and no filtering. A glob or a recursive walk here would put
/// policy in the wrong layer and make the reply size unbounded by anything the
/// caller chose.
///
/// Streaming rather than a single reply: a directory's size is not knowable
/// before reading it, so one reply would reintroduce exactly the unbounded
/// message that measured as unusable at ≥1 MiB. The caller pulls batches and
/// stops when it wants to.
fn register_list(peer: &Arc<Peer>) {
    let target = Arc::clone(peer);
    peer.on_deferred(
        "hands.list",
        Arc::new(move |reply: DeferredReply, args: Vec<Value>| {
            let path = str_arg(&args, 0);
            let opts = args.get(1).cloned().unwrap_or_else(|| json!({}));
            // Batch size is a caller choice, bounded so a single frame cannot
            // grow without limit.
            let batch = opts
                .get("batch")
                .and_then(Value::as_u64)
                .unwrap_or(STAT_PREVIEW_MAX as u64)
                .clamp(1, 4096) as usize;

            // The not-a-directory check lives in `DirectoryReader::open`, so it
            // cannot be skipped by a second caller. Doing it again here would be
            // a second copy of the rule, which is how the two drift apart.
            match DirectoryReader::open(&path, batch) {
                Ok(reader) => {
                    if let Err(error) = target.open_stream(&reply_id(&reply), Box::new(reader)) {
                        reply.fail(error);
                    }
                }
                Err(error) => reply.fail(error),
            }
        }),
    );
}

/// Walks one directory, one batch of entries per chunk.
struct DirectoryReader {
    reader: std::fs::ReadDir,
    batch: usize,
    done: bool,
}

impl DirectoryReader {
    fn open(path: &str, batch: usize) -> Result<Self, String> {
        // The guard lives HERE, not only in the handler, and that placement is
        // the point: on Windows `read_dir` on a FILE SUCCEEDS and yields an
        // empty iterator (measured), so without this check a non-directory is
        // indistinguishable from an empty directory — the caller would conclude
        // "nothing there" about a path that exists. Checking here means every
        // caller of the reader gets that guarantee, not just the one handler
        // that happened to remember to look.
        let meta =
            std::fs::metadata(path).map_err(|error| encode_error(classify(&error), error))?;
        if !meta.is_dir() {
            return Err(encode_error(
                Code::NotDir,
                format!("{path} is not a directory"),
            ));
        }
        let reader =
            std::fs::read_dir(path).map_err(|error| encode_error(classify(&error), error))?;
        Ok(Self {
            reader,
            batch,
            done: false,
        })
    }
}

impl StreamProducer for DirectoryReader {
    fn next_chunk(&mut self) -> StreamStep {
        if self.done {
            return StreamStep::Done;
        }
        let mut entries = Vec::new();
        // Stop at the batch size even if more remain, so the reply frame stays
        // bounded by the caller's choice rather than by the directory.
        for entry in self.reader.by_ref() {
            let Ok(entry) = entry else {
                continue;
            };
            entries.push(entry_of(&entry));
            if entries.len() >= self.batch {
                break;
            }
        }
        if entries.is_empty() {
            self.done = true;
            return StreamStep::Done;
        }
        // NOTE: there is deliberately NO "short batch means finished" check here.
        // One was written and then removed, because it saved nothing: with or
        // without it, the consumer needs exactly one further `next_chunk` to
        // observe `Done` (traced across n=0,3,4,7,8,16 for every batch size — the
        // call count is identical). A "saving" that changes no observable
        // behaviour is dead code, and leaving it would put a claim in this
        // comment that no test can falsify. The stream terminates because this
        // arm returns `Done` on the next call, which is what the consumer sees.
        let bytes = serde_json::to_vec(&Value::Array(entries)).unwrap_or_else(|_| b"[]".to_vec());
        StreamStep::Chunk(bytes)
    }
}

// --- read (producer) -------------------------------------------------------

/// Read one file as a stream of chunks, optionally from an offset.
///
/// `offset` is a plain argument rather than a separate `resume` method:
/// `seek(SeekFrom::Start(n))` *is* the resumption mechanism, and inventing a
/// method for it would put a policy decision (when to resume) inside the hands.
fn register_read(peer: &Arc<Peer>) {
    let target = Arc::clone(peer);
    peer.on_deferred(
        "hands.read",
        Arc::new(move |reply: DeferredReply, args: Vec<Value>| {
            let path = str_arg(&args, 0);
            let opts = args.get(1).cloned().unwrap_or_else(|| json!({}));
            let offset = opts.get("offset").and_then(Value::as_u64).unwrap_or(0);

            match FileReader::open(&path, offset) {
                Ok(reader) => {
                    if let Err(error) = target.open_stream(&reply_id(&reply), Box::new(reader)) {
                        reply.fail(error);
                    }
                }
                Err(error) => reply.fail(error),
            }
        }),
    );
}

/// The `id` a [`DeferredReply`] will answer, so [`Peer::open_stream`] can write
/// the stream-ref as that request's reply.
fn reply_id(reply: &DeferredReply) -> String {
    reply.id().to_string()
}

struct FileReader {
    file: File,
    /// Identity captured at open, so a rotation *during* the read is reported
    /// rather than silently splicing two different files together.
    opened_id: String,
    path: PathBuf,
}

impl FileReader {
    fn open(path: &str, offset: u64) -> Result<Self, String> {
        let meta =
            std::fs::metadata(path).map_err(|error| encode_error(classify(&error), error))?;
        // ⚠ ONLY regular files. `is_dir` alone was not enough, and the omission was
        // a denial-of-service on this peer rather than a wrong answer:
        //
        //   - a FIFO blocks in `open` until a writer appears, and
        //   - a character device (`/dev/zero`, Windows `\\.\NUL`) never returns 0
        //     from `read`, so a 256 KiB chunk loop turns into a spin.
        //
        // Both run on the READER thread (`pump_producer`), so one call like that
        // stops `read_line` from ever running again: cancellation frames are never
        // seen and EVERY other in-flight RPC stalls until the shell's 30s timeout
        // kills the tree. A capability with no path fence (proposal §7.1) must not
        // let a caller wedge the whole channel by naming the wrong path.
        //
        // `is_file()` follows symlinks (`metadata`, not `symlink_metadata`), so a
        // link to a regular file still reads. Anything else is refused loudly
        // rather than left undefined — a hang is indistinguishable from a bug.
        if meta.is_dir() {
            return Err(encode_error(Code::IsDir, path));
        }
        if !meta.is_file() {
            return Err(encode_error(
                Code::Unsupported,
                format!("{path} is not a regular file (devices and FIFOs are not readable)"),
            ));
        }
        let mut file = File::open(path).map_err(|error| encode_error(classify(&error), error))?;
        if offset > 0 {
            file.seek(SeekFrom::Start(offset))
                .map_err(|error| encode_error(classify(&error), error))?;
        }
        Ok(Self {
            file,
            opened_id: identity(path),
            path: PathBuf::from(path),
        })
    }
}

impl StreamProducer for FileReader {
    fn next_chunk(&mut self) -> StreamStep {
        // Re-check identity on every chunk. A log that rotates mid-read would
        // otherwise appear as one continuous file, and the caller would commit
        // a spliced result. This is exactly the `ESTALE` case the proposal
        // separates from `ENOENT`.
        //
        // ⚠ An empty id is AMBIGUOUS and must not be treated as "unchanged".
        // `identity()` collapses two different states into `""`:
        //   (a) the filesystem cannot report an id (some network shares), and
        //   (b) the path no longer exists.
        // Treating both as "same" meant a file DELETED mid-read produced a clean
        // EOF and the caller got a success result — `ENOENT` reported as data.
        // Measured: `identity()` after an unlink returns `""`, and a read from the
        // still-open handle then returns the bytes with no error at all.
        //
        // So the two are separated here: (b) fails loudly, (a) skips the
        // comparison (the id is a rotation check, not the payload).
        let current = identity(&self.path);
        if current.is_empty() {
            if !path_exists(&self.path) {
                return StreamStep::Failed(encode_error(
                    Code::NotFound,
                    format!("{} was removed during read", self.path.display()),
                ));
            }
            // Present but unidentifiable: nothing to compare against, so continue.
        } else if !self.opened_id.is_empty() && current != self.opened_id {
            return StreamStep::Failed(encode_error(
                Code::Stale,
                format!("{} was replaced during read", self.path.display()),
            ));
        }

        let mut buffer = vec![0u8; CHUNK];
        match self.file.read(&mut buffer) {
            Ok(0) => StreamStep::Done,
            Ok(read) => {
                buffer.truncate(read);
                StreamStep::Chunk(buffer)
            }
            Err(error) => StreamStep::Failed(encode_error(classify(&error), error)),
        }
    }
}

// --- write (consumer) ------------------------------------------------------

/// Take a stream from the host and write it to a file.
///
/// The reply is **deferred** until the stream ends: the request is not
/// answerable at handler time, because "how many bytes did you write" is only
/// known after the last chunk. That is what [`Peer::on_deferred`] exists for.
///
/// `mode: "append"` ignores the cursor (verified behaviour): under multiple
/// writers, `seek(End)` + `write` has a race that append mode does not.
fn register_write(peer: &Arc<Peer>) {
    let target = Arc::clone(peer);
    peer.on_deferred(
        "hands.write",
        Arc::new(move |reply: DeferredReply, args: Vec<Value>| {
            let path = str_arg(&args, 0);
            let opts = args.get(2).cloned().unwrap_or_else(|| json!({}));
            // `write(path, data, opts?)` — the stream is argument 1, per the
            // proposal's signature. kkrpc rewrites an async-iterable argument
            // into a stream-ref envelope, which the peer unwraps first.
            let sid = stream_ref_id(&args, 1);

            let Some(sid) = sid else {
                reply.fail(encode_error(
                    Code::Unsupported,
                    "hands.write: argument 2 is not a stream reference",
                ));
                return;
            };

            match FileWriter::open(&path, &opts) {
                Ok(writer) => {
                    // The sink owns the reply: "how many bytes did you write" is
                    // only answerable after the last chunk arrives.
                    let sink = Box::new(DeferredWriter {
                        writer,
                        reply: reply.clone(),
                        mode: writer_mode(&opts),
                    });
                    // `consume_stream` opens the credit window, so the host
                    // starts sending only after this returns. If it refuses
                    // (duplicate stream id), the reply is still owed.
                    if let Err(error) = target.consume_stream(&sid, sink) {
                        reply.fail(encode_error(Code::Stale, error));
                    }
                }
                Err(error) => reply.fail(error),
            }
        }),
    );
}

fn writer_mode(opts: &Value) -> &'static str {
    match opts.get("mode").and_then(Value::as_str) {
        Some("append") => "append",
        Some("truncate") => "truncate",
        _ => "create",
    }
}

struct FileWriter {
    file: File,
}

impl FileWriter {
    fn open(path: &str, opts: &Value) -> Result<Self, String> {
        let offset = opts.get("offset").and_then(Value::as_u64);
        let mode = writer_mode(opts);
        if mode == "append" && offset.is_some_and(|offset| offset > 0) {
            return Err(encode_error(
                Code::Unsupported,
                "hands.write: `append` and `offset > 0` are mutually exclusive",
            ));
        }
        let mut options = OpenOptions::new();
        options.write(true).create(true);
        match mode {
            "append" => {
                options.append(true);
            }
            "truncate" => {
                options.truncate(true);
            }
            _ => {
                options.truncate(false);
            }
        }
        let mut file = options
            .open(path)
            .map_err(|error| encode_error(classify(&error), error))?;
        if let Some(offset) = offset {
            file.seek(SeekFrom::Start(offset))
                .map_err(|error| encode_error(classify(&error), error))?;
        }
        Ok(Self { file })
    }
}

struct DeferredWriter {
    writer: FileWriter,
    reply: DeferredReply,
    mode: &'static str,
}

impl StreamSink for DeferredWriter {
    fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.writer
            .file
            .write_all(bytes)
            .map_err(|error| encode_error(classify(&error), error))
    }

    fn finish(&mut self, outcome: Result<(), String>) {
        match outcome {
            Ok(()) => {
                // The end offset comes from the file's own cursor, so `append`
                // mode reports where the bytes actually landed rather than where
                // the caller asked them to start — the two differ by design.
                let written = self.writer.file.stream_position().unwrap_or(0);
                let _ = self.writer.file.flush();
                self.reply.send(json!({
                    "bytes": written,
                    "endOffset": written,
                    "mode": self.mode,
                }));
            }
            Err(message) => self.reply.fail(message),
        }
    }
}

// --- watch (event stream) --------------------------------------------------

/// Watch a path and emit change events.
///
/// Two behaviours that are not obvious and are both measured
/// (`docs/probes/hand-io/rust-crates/FINDINGS.md` §4.1, §4.3):
///
/// 1. **A path that does not exist yet cannot be watched.** `watch()` errors,
///    and creating the file afterwards still delivers nothing. So when the
///    target is absent, the parent directory is watched instead and events are
///    filtered down to the target — the same shape as `tail --follow=name`.
/// 2. **No debouncer is needed for volume.** 200 appends through one handle
///    produced a single event, so events already coalesce.
fn register_watch(peer: &Arc<Peer>) {
    let target = Arc::clone(peer);
    peer.on_deferred(
        "hands.watch",
        Arc::new(move |reply: DeferredReply, args: Vec<Value>| {
            let path = str_arg(&args, 0);
            let opts = args.get(1).cloned().unwrap_or_else(|| json!({}));
            let recursive = opts
                .get("recursive")
                .and_then(Value::as_bool)
                .unwrap_or(false);

            match FileWatcher::start(&path, recursive) {
                Ok(watcher) => {
                    if let Err(error) =
                        target.open_event_stream(&reply_id(&reply), Box::new(watcher))
                    {
                        reply.fail(error);
                    }
                }
                Err(error) => reply.fail(error),
            }
        }),
    );
}

struct FileWatcher {
    rx: Receiver<notify::Result<notify::Event>>,
    watcher: RecommendedWatcher,
    /// The exact path the caller asked about, **canonicalized**.
    ///
    /// Comparison must be on canonicalized paths, and getting this wrong is
    /// silent: `notify`'s macOS backend canonicalizes the paths it reports
    /// (`fsevent.rs` `append_path` → `canonicalize()`, then every event carries
    /// that resolved path), while the caller's string is whatever it typed. On
    /// macOS `/var` is a symlink to `/private/var`, and `std::env::temp_dir()`
    /// returns the `/var` form — so a raw comparison drops EVERY event and the
    /// watch looks like "nothing ever happens" rather than failing. That is
    /// exactly how this was caught: only the macOS CI job failed.
    target: PathBuf,
    /// Whether the watch had to move up to the parent (target absent at start).
    watching_parent: bool,
    /// The path the watch was ACTUALLY registered on — which is NOT `target`.
    ///
    /// ⚠ This field exists because `close()` used to unwatch `target`, and those
    /// two are different paths in three ordinary cases:
    ///
    ///   1. `target` is canonicalized (`comparable`) but `watch` is given the
    ///      caller's original string — so a symlinked ancestor (macOS `/var` →
    ///      `/private/var`) or any relative input makes them differ.
    ///   2. The target did not exist at start, so the watch went on the PARENT
    ///      while `target` is "parent + filename" — a path that was never
    ///      registered at all.
    ///
    /// `notify::unwatch` matches the path it was given, so unwatching `target`
    /// was a no-op in those cases: the watch outlived the stream, and `let _ =`
    /// swallowed the evidence. Keeping the registered path makes `close()` exact.
    registered: PathBuf,
}

/// Resolve a path for comparison with event paths.
///
/// Falls back to the input when canonicalization fails (the target may not
/// exist yet — the whole point of the parent-directory fallback), in which case
/// the parent is canonicalized instead so the leaf can still be compared.
fn comparable(path: &Path) -> PathBuf {
    if let Ok(resolved) = path.canonicalize() {
        return resolved;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => match parent.canonicalize() {
            Ok(resolved) => resolved.join(name),
            Err(_) => path.to_path_buf(),
        },
        _ => path.to_path_buf(),
    }
}

/// Does this event concern the watched path?
///
/// Compared on canonicalized forms so a symlinked ancestor (macOS `/var`) does
/// not make every event look unrelated. A raw `==` here is the bug described on
/// [`FileWatcher::target`].
fn event_concerns(event_path: &Path, target: &Path) -> bool {
    event_path == target || comparable(event_path) == target
}

impl FileWatcher {
    fn start(path: &str, recursive: bool) -> Result<Self, String> {
        let requested = PathBuf::from(path);
        // Always compare in canonical form; see the field docs.
        let target = comparable(&requested);
        let (tx, rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |event| {
            // A send failure means the consumer is gone; dropping is correct.
            let _ = tx.send(event);
        })
        .map_err(|error| encode_error(Code::Unsupported, error))?;

        let mode = if recursive {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        };

        // Try the target itself first: a recursive watch on a directory only
        // works there, and a file that exists is watched most directly.
        let watching_parent = match watcher.watch(&requested, mode) {
            Ok(()) => false,
            Err(_) => {
                let parent = requested
                    .parent()
                    .filter(|parent| !parent.as_os_str().is_empty())
                    .ok_or_else(|| {
                        encode_error(
                            Code::NotFound,
                            format!("{} does not exist and has no parent", requested.display()),
                        )
                    })?;
                // The parent must exist; if it does not, this path is not
                // watchable by any means and the caller needs to know now.
                if !parent.exists() {
                    return Err(encode_error(
                        Code::NotFound,
                        format!("{} does not exist", parent.display()),
                    ));
                }
                watcher
                    .watch(parent, RecursiveMode::NonRecursive)
                    .map_err(|error| encode_error(classify_anyhow(&error), error))?;
                true
            }
        };

        // ⚠ Remember what was ACTUALLY registered, not what was asked for.
        // `close()` must unwatch this exact path — see the field docs for the
        // three cases where it differs from `target`.
        let registered = if watching_parent {
            requested
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| requested.clone())
        } else {
            requested.clone()
        };

        Ok(Self {
            rx,
            watcher,
            target,
            watching_parent,
            registered,
        })
    }

    /// Translate one filesystem event into the proposal's `HandsChange` shape.
    fn change_of(event: &notify::Event) -> Option<Value> {
        use notify::EventKind;
        let kind = match event.kind {
            EventKind::Create(_) => "create",
            EventKind::Remove(_) => "remove",
            // A rename is reported as two name events; `replace` is the useful
            // summary for a rotation (the old file left, a new one arrived).
            EventKind::Modify(notify::event::ModifyKind::Name(_)) => "replace",
            EventKind::Modify(_) => "modify",
            EventKind::Access(_) => return None,
            _ => "modify",
        };
        let path = event.paths.first()?;
        Some(json!({
            "kind": kind,
            "path": path.to_string_lossy(),
            "id": identity(path),
        }))
    }
}

impl StreamSource for FileWatcher {
    fn next_value(&mut self, timeout: Duration) -> Option<Value> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                // Nothing happened this tick. `None` means "quiet", not "done".
                return None;
            }
            match self.rx.recv_timeout(remaining) {
                Ok(Ok(event)) => {
                    // Filter to the requested path when the watch sits on the
                    // parent, so a sibling's churn does not surface as a change
                    // to the target. Compared canonically — a raw equality here
                    // silently dropped every event on macOS (see `target`).
                    if self.watching_parent
                        && !event
                            .paths
                            .iter()
                            .any(|path| event_concerns(path, &self.target))
                    {
                        continue;
                    }
                    if let Some(change) = Self::change_of(&event) {
                        return Some(change);
                    }
                }
                Ok(Err(_)) => continue,
                Err(RecvTimeoutError::Timeout) => return None,
                Err(RecvTimeoutError::Disconnected) => return None,
            }
        }
    }

    fn close(&mut self) {
        // ⚠ Unwatch the REGISTERED path, not `target`. They differ whenever the
        // caller's string was relative, had a symlinked ancestor, or the target
        // did not exist so the watch moved to the parent — and `unwatch` matches
        // exactly, so the old `&self.target` was a silent no-op in those cases.
        //
        // ⚠ Keep `let _ =`? No — that is what hid this. A failure is reported to
        // stderr instead. It still must not PANIC (this runs on the stream
        // thread, and a panic there would take the stream down for a cleanup
        // problem), so an explicit log is the right middle ground: the stream
        // ends normally and the operator can see that a watch was left behind.
        if let Err(error) = self.watcher.unwatch(&self.registered) {
            eprintln!(
                "[shell] hands.watch: could not unwatch {} (registered as {}): {error}",
                self.target.display(),
                self.registered.display()
            );
        }
    }
}

// --- shared helpers --------------------------------------------------------

/// Best-effort file identity. An empty string means "this filesystem cannot say"
/// — a network share — and callers must treat that as "unknown", not as "same".
///
/// ⚠ It ALSO returns `""` when the path does not exist, which is a different
/// thing: "unknown" lets a check be skipped, "gone" must fail the read. Callers
/// that need to tell them apart must pair this with [`path_exists`] — see
/// `FileReader::next_chunk`.
fn identity(path: impl AsRef<Path>) -> String {
    file_id::get_file_id(path)
        .map(|id| format!("{id:?}"))
        .unwrap_or_default()
}

/// Does the path still exist?
///
/// `symlink_metadata` (not `metadata`) so a dangling symlink still counts as
/// present: the question is "is the directory entry still there", which is what
/// distinguishes a removed file from one whose id the filesystem cannot report.
fn path_exists(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// Read a stream reference out of an argument position, unwrapping the value
/// envelope first (kkrpc nests a stream ref inside a `"value"` envelope).
fn stream_ref_id(args: &[Value], index: usize) -> Option<String> {
    let value = args.get(index)?;
    value
        .get(crate::kkrpc_peer::STREAM_REF)
        .and_then(Value::as_str)
        .filter(|kind| *kind == "async-iterable")?;
    value.get("id").and_then(Value::as_str).map(str::to_string)
}

fn str_arg(args: &[Value], index: usize) -> String {
    args.get(index)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// `notify` hands back its own error type; only the io-ish part is useful here.
fn classify_anyhow(error: &notify::Error) -> Code {
    match error.kind {
        notify::ErrorKind::PathNotFound => Code::NotFound,
        notify::ErrorKind::Io(ref io) => classify(io),
        notify::ErrorKind::Generic(_) => Code::Unsupported,
        _ => Code::Unsupported,
    }
}

/// Re-exported so the tests can build a [`StreamSource`] without reaching into
/// the peer module's private items.
#[cfg(test)]
impl DeferredReply {
    /// A reply that records nothing and writes nowhere.
    ///
    /// Unit tests exercise the sink/source logic, which does not need a live
    /// transport; the deferred reply's wire behaviour is covered by the peer's
    /// own tests and by the end-to-end channel test.
    pub(crate) fn test_stub() -> Self {
        crate::kkrpc_peer::test_support::detached_reply()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "vrcxk-hands-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|delta| delta.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    /// The error text of an already-encoded failure.
    ///
    /// Written as a `match` rather than `expect_err` because the reader/writer
    /// types hold live handles and deliberately do not implement `Debug`.
    fn failure<T>(result: Result<T, String>) -> String {
        match result {
            Ok(_) => panic!("expected this to fail"),
            Err(message) => message,
        }
    }

    // --- stat ---------------------------------------------------------------

    #[test]
    fn stat_reports_size_identity_and_kind_for_a_file() {
        let dir = temp_dir("stat-file");
        let path = dir.join("a.txt");
        std::fs::write(&path, b"hello").expect("write");
        let stat = stat_path(path.to_str().unwrap()).expect("stat");
        std::fs::remove_dir_all(&dir).ok();

        assert_eq!(stat["size"], json!(5));
        assert_eq!(stat["kind"], json!("file"));
        assert!(
            stat["id"].as_str().is_some_and(|id| !id.is_empty()),
            "a local file must have an identity: {stat}"
        );
        assert!(stat["mtimeMs"].as_u64().is_some_and(|ms| ms > 0));
    }

    #[test]
    fn stat_reports_directories_rather_than_failing() {
        // Directories must be answerable: a caller deciding what to do next
        // needs to tell "a directory" from "nothing there".
        let dir = temp_dir("stat-dir");
        let stat = stat_path(dir.to_str().unwrap()).expect("stat");
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(stat["kind"], json!("dir"));
    }

    #[test]
    fn stat_of_a_missing_path_is_an_error_the_caller_maps_to_null() {
        let dir = temp_dir("stat-missing");
        let missing = dir.join("nope.txt");
        let error = stat_path(missing.to_str().unwrap()).expect_err("must fail");
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(classify(&error), Code::NotFound);
    }

    #[test]
    fn stat_reports_a_real_failure_as_an_error_not_as_a_value() {
        // ⚠ THE REGRESSION for the disguised failure. Every unit test above calls
        // `stat_path` directly, so none of them saw the choice that was wrong:
        // whether a failure travels as a VALUE or as a FAILURE.
        //
        // `register_stat` used to be a sync `peer.on`, whose reply arm is always
        // `{"t":"r","v":…}` — no error channel — so a failure had to be returned
        // as the value `{"error":"CODE: detail"}`. Measured through the real peer:
        //
        //     stat("\\.\NUL") RESOLVED to {"error":"EACCES: …"}  → .size undefined
        //
        // i.e. "cannot read it" reached the caller as "read it, no size", because
        // `(await ctx.hands.stat(p)).size` is `undefined` rather than a rejection.
        //
        // ⚠ THE OPERAND IS PLATFORM-INDEPENDENT ON PURPOSE. The first version of
        // this test used `cfg!(windows) { "\\.\NUL" } else { "/dev/null" }`, which
        // is red on BOTH unix platforms: `/dev/null` **stats fine** (it is a
        // character device, and `stat` is a metadata query — reporting
        // `kind:"other"` is more useful than failing). So the test only ever
        // passed on Windows, the one platform where the chosen operand happened to
        // fail. Same shape as the hardcoded `"windows"` assertion fixed earlier:
        // a platform assumption masquerading as a contract.
        //
        // An INTERIOR NUL is refused by the OS layer on every platform:
        //   - Windows: `metadata` → `os error 1`, `InvalidInput`
        //   - Unix:    the `CString` conversion → `NulError` → `InvalidInput`
        // Both are measured, and `classify` maps `InvalidInput` to `Denied` →
        // `EACCES`, so the assertion below is exact rather than a disjunction.
        let error =
            stat_outcome("a\0b").expect_err("a real failure must be a failure, not a value");
        assert!(
            error.starts_with("EACCES"),
            "the failure must carry a parseable code, got: {error}"
        );
        //
        // NOTE: `EUNSUPPORTED` is deliberately NOT accepted here. That code comes
        // from the regular-file guard in `FileReader::open` (the READ path);
        // `stat_path` has no such guard — it reports devices as `kind:"other"`.
        // Accepting it here would suggest `stat` can produce it, which it cannot.
    }

    #[test]
    fn stat_of_a_missing_path_still_answers_null_rather_than_failing() {
        // The contract the change above must NOT break: "does not exist" is a
        // normal answer, so it stays a VALUE (`null`) and must not become an
        // error. Without this, a handler that always failed would satisfy the
        // regression above while breaking every caller that branches on null.
        let value = stat_outcome("/definitely/not/here/vrcxk")
            .expect("a missing path is an answer, not a failure");
        assert_eq!(value, Value::Null);
    }

    // --- stat preview -------------------------------------------------------

    #[test]
    fn stat_of_a_file_has_no_entry_preview() {
        // `null`, not `[]`: "this is not a directory" and "this directory is
        // empty" are different answers, and one shape for both would merge them.
        let dir = temp_dir("stat-file-no-entries");
        let path = dir.join("a.txt");
        std::fs::write(&path, b"x").expect("write");
        let stat = stat_path(path.to_str().unwrap()).expect("stat");
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(stat["entries"], Value::Null);
    }

    #[test]
    fn stat_of_a_directory_previews_its_entries_without_truncation() {
        let dir = temp_dir("stat-dir-preview");
        std::fs::write(dir.join("a.txt"), b"x").expect("write");
        std::fs::create_dir(dir.join("sub")).expect("mkdir");
        let stat = stat_path(dir.to_str().unwrap()).expect("stat");
        std::fs::remove_dir_all(&dir).ok();

        let entries = &stat["entries"];
        assert_eq!(entries["truncated"], json!(false));
        let mut names: Vec<String> = entries["items"]
            .as_array()
            .expect("items")
            .iter()
            .map(|e| e["name"].as_str().unwrap().to_string())
            .collect();
        names.sort();
        assert_eq!(names, vec!["a.txt", "sub"]);
    }

    #[test]
    fn stat_preview_is_marked_truncated_at_the_boundary() {
        // The off-by-one that matters: a directory with EXACTLY `STAT_PREVIEW_MAX`
        // entries must not claim to be truncated (there is nothing more), and one
        // with a single extra MUST claim it (or the caller silently believes it
        // has seen everything and never calls `list`).
        let exact = temp_dir("stat-preview-exact");
        for i in 0..STAT_PREVIEW_MAX {
            std::fs::write(exact.join(format!("f{i}")), b"x").expect("write");
        }
        let stat = stat_path(exact.to_str().unwrap()).expect("stat");
        std::fs::remove_dir_all(&exact).ok();
        assert_eq!(
            stat["entries"]["truncated"],
            json!(false),
            "exactly {STAT_PREVIEW_MAX} entries is NOT truncated"
        );
        assert_eq!(
            stat["entries"]["items"].as_array().unwrap().len(),
            STAT_PREVIEW_MAX
        );

        let over = temp_dir("stat-preview-over");
        for i in 0..=STAT_PREVIEW_MAX {
            std::fs::write(over.join(format!("f{i}")), b"x").expect("write");
        }
        let stat = stat_path(over.to_str().unwrap()).expect("stat");
        std::fs::remove_dir_all(&over).ok();
        assert_eq!(
            stat["entries"]["truncated"],
            json!(true),
            "one more than the preview must be flagged, or the caller never lists"
        );
        assert_eq!(
            stat["entries"]["items"].as_array().unwrap().len(),
            STAT_PREVIEW_MAX
        );
    }

    #[test]
    fn stat_of_an_empty_directory_is_an_empty_preview_not_an_error() {
        let dir = temp_dir("stat-empty-dir");
        let stat = stat_path(dir.to_str().unwrap()).expect("stat");
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(stat["entries"]["items"], json!([]));
        assert_eq!(stat["entries"]["truncated"], json!(false));
        assert!(
            stat["entries"].get("error").is_none(),
            "an empty directory is not a failure"
        );
    }

    // --- list ---------------------------------------------------------------

    /// Drain a `DirectoryReader` into `(names, batches)`.
    ///
    /// ⚠ BOUNDED ON PURPOSE. The first version looped until `Done`, so a producer
    /// regression that never terminates made the TEST HANG rather than fail —
    /// observed twice while fault-injecting, and a hung suite with no failure line
    /// is far worse than a red one (it reads as a slow machine). Every drain loop
    /// in this file therefore has a call budget and panics past it.
    fn drain_list(path: &str, batch: usize) -> (Vec<String>, usize) {
        let mut reader = DirectoryReader::open(path, batch).expect("open");
        let mut names = Vec::new();
        let mut batches = 0;
        loop {
            assert!(
                batches < 10_000,
                "the stream produced {batches} batches without ending — the producer \
                 is not terminating"
            );
            match reader.next_chunk() {
                StreamStep::Chunk(bytes) => {
                    batches += 1;
                    let values: Vec<Value> = serde_json::from_slice(&bytes).expect("json array");
                    for value in values {
                        names.push(value["name"].as_str().unwrap().to_string());
                    }
                }
                StreamStep::Done => break,
                StreamStep::Failed(error) => panic!("unexpected failure: {error}"),
            }
        }
        names.sort();
        (names, batches)
    }

    #[test]
    fn list_returns_every_entry_in_a_directory() {
        let dir = temp_dir("list-all");
        std::fs::write(dir.join("b.txt"), b"yy").expect("write");
        std::fs::write(dir.join("a.txt"), b"x").expect("write");
        std::fs::create_dir(dir.join("sub")).expect("mkdir");
        let (names, _) = drain_list(dir.to_str().unwrap(), 2);
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(names, vec!["a.txt", "b.txt", "sub"]);
    }

    #[test]
    fn list_reports_kind_so_a_caller_can_tell_files_from_directories() {
        // The whole reason enumeration is a primitive: a caller that only got
        // names would need one `stat` per entry to know what to do with it —
        // N round trips, which is the cost §6 was about.
        let dir = temp_dir("list-kind");
        std::fs::write(dir.join("f.txt"), b"12345").expect("write");
        std::fs::create_dir(dir.join("d")).expect("mkdir");

        let mut reader = DirectoryReader::open(dir.to_str().unwrap(), 16).expect("open");
        let StreamStep::Chunk(bytes) = reader.next_chunk() else {
            panic!("expected one batch");
        };
        std::fs::remove_dir_all(&dir).ok();

        let values: Vec<Value> = serde_json::from_slice(&bytes).expect("json");
        let by_name = |name: &str| {
            values
                .iter()
                .find(|v| v["name"] == json!(name))
                .unwrap_or_else(|| panic!("{name} missing"))
                .clone()
        };
        assert_eq!(by_name("f.txt")["kind"], json!("file"));
        assert_eq!(by_name("f.txt")["size"], json!(5));
        assert_eq!(by_name("d")["kind"], json!("dir"));
    }

    #[test]
    fn list_batches_by_the_requested_size_and_does_not_lose_entries() {
        // Batching must partition, not truncate: the entries after the first
        // batch are the ones a boundary bug would silently drop.
        let dir = temp_dir("list-batching");
        for i in 0..7 {
            std::fs::write(dir.join(format!("f{i}")), b"x").expect("write");
        }
        let (names, batches) = drain_list(dir.to_str().unwrap(), 2);
        std::fs::remove_dir_all(&dir).ok();

        assert_eq!(names.len(), 7, "every entry must arrive: {names:?}");
        // 7 entries at 2 per batch: 2,2,2 then a SHORT batch of 1 that ends it.
        assert_eq!(batches, 4, "expected 3 full batches then a short one");
    }

    #[test]
    fn list_of_an_exact_multiple_ends_without_an_empty_trailing_batch() {
        // 4 entries at 2 per batch must produce exactly 2 batches. A "fill until
        // short" loop that only stops on a short batch would emit a third, empty
        // one — harmless here, but the same loop is what would spin forever if it
        // stopped only on error.
        let dir = temp_dir("list-exact");
        for i in 0..4 {
            std::fs::write(dir.join(format!("f{i}")), b"x").expect("write");
        }
        let (names, batches) = drain_list(dir.to_str().unwrap(), 2);
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(names.len(), 4);
        assert_eq!(batches, 2, "an exact multiple must not add an empty batch");
    }

    #[test]
    fn list_of_an_empty_directory_produces_no_batch_at_all() {
        let dir = temp_dir("list-empty");
        let (names, batches) = drain_list(dir.to_str().unwrap(), 8);
        std::fs::remove_dir_all(&dir).ok();
        assert!(names.is_empty());
        assert_eq!(batches, 0, "nothing to send means send nothing");
    }

    #[test]
    fn the_stream_terminates_after_the_last_entry_however_the_batches_fall() {
        // The real contract: the consumer must reach `Done`, and must not be
        // handed an unbounded number of empty batches on the way. This replaces a
        // test that asserted a "short batch ends the stream early" saving — that
        // saving turned out not to exist (the terminal call is needed either way),
        // and the check was removed rather than kept with a comment no test could
        // falsify.
        for (count, batch) in [(0usize, 8usize), (3, 8), (4, 2), (7, 2), (16, 16)] {
            let dir = temp_dir(&format!("list-terminates-{count}-{batch}"));
            for i in 0..count {
                std::fs::write(dir.join(format!("f{i}")), b"x").expect("write");
            }

            let mut reader = DirectoryReader::open(dir.to_str().unwrap(), batch).expect("open");
            let mut data_calls = 0;
            let mut empty_batches = 0;
            let mut calls = 0;
            loop {
                calls += 1;
                assert!(
                    calls < 100,
                    "the stream never terminated for {count}/{batch}"
                );
                match reader.next_chunk() {
                    StreamStep::Chunk(bytes) => {
                        let values: Vec<Value> =
                            serde_json::from_slice(&bytes).expect("json array");
                        if values.is_empty() {
                            empty_batches += 1;
                        } else {
                            data_calls += 1;
                        }
                    }
                    StreamStep::Done => break,
                    StreamStep::Failed(error) => panic!("unexpected failure: {error}"),
                }
            }
            std::fs::remove_dir_all(&dir).ok();

            assert_eq!(
                data_calls,
                count.div_ceil(batch),
                "{count} entries at batch {batch}: wrong number of data batches"
            );
            assert_eq!(
                empty_batches, 0,
                "{count} entries at batch {batch}: an empty batch is never useful and \
                 costs the caller a full round trip"
            );
        }
    }

    #[test]
    fn list_of_a_file_reports_not_a_directory_rather_than_failing_obscurely() {
        // A caller that guessed "dir" must be told exactly that, not handed
        // ENOENT (which would read as "it is gone" and send it down a retry path
        // that can never succeed).
        let dir = temp_dir("list-not-dir");
        let path = dir.join("a.txt");
        std::fs::write(&path, b"x").expect("write");
        // Matched rather than `expect_err`, because the Ok arm has no `Debug`.
        let error = match DirectoryReader::open(path.to_str().unwrap(), 8) {
            Ok(_) => panic!("listing a file must not succeed"),
            Err(error) => error,
        };
        std::fs::remove_dir_all(&dir).ok();
        assert!(
            error.starts_with("ENOTDIR:"),
            "expected ENOTDIR, got: {error}"
        );
    }

    // --- read ---------------------------------------------------------------

    #[test]
    fn read_streams_a_file_in_bounded_chunks() {
        // The bound is the point: memory must not scale with file size.
        let dir = temp_dir("read-chunks");
        let path = dir.join("big.bin");
        let payload = vec![7u8; CHUNK * 2 + 13];
        std::fs::write(&path, &payload).expect("write");

        let mut reader = FileReader::open(path.to_str().unwrap(), 0).expect("open");
        let mut collected = Vec::new();
        loop {
            match reader.next_chunk() {
                StreamStep::Chunk(bytes) => {
                    assert!(bytes.len() <= CHUNK, "chunk exceeded the bound");
                    collected.extend_from_slice(&bytes);
                }
                StreamStep::Done => break,
                StreamStep::Failed(message) => panic!("unexpected failure: {message}"),
            }
        }
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(collected, payload);
    }

    #[test]
    fn read_honours_an_offset_for_resumption() {
        // `seek` is the whole resumption mechanism, so an offset must produce
        // exactly the tail — this is what makes resume work without a new verb.
        let dir = temp_dir("read-offset");
        let path = dir.join("resume.bin");
        std::fs::write(&path, b"0123456789").expect("write");

        let mut reader = FileReader::open(path.to_str().unwrap(), 4).expect("open");
        let mut collected = Vec::new();
        loop {
            match reader.next_chunk() {
                StreamStep::Chunk(bytes) => collected.extend_from_slice(&bytes),
                StreamStep::Done => break,
                StreamStep::Failed(message) => panic!("unexpected failure: {message}"),
            }
        }
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(collected, b"456789");
    }

    #[test]
    fn read_of_a_replaced_file_fails_stale_rather_than_splicing() {
        // The failure this prevents is silent: rotation mid-read would return a
        // file that never existed on disk, and the caller would store it.
        let dir = temp_dir("read-stale");
        let path = dir.join("rotating.log");
        std::fs::write(&path, vec![1u8; CHUNK * 2]).expect("write");

        let mut reader = FileReader::open(path.to_str().unwrap(), 0).expect("open");
        assert!(matches!(reader.next_chunk(), StreamStep::Chunk(_)));

        // Rotate: move the old file aside and put a NEW file at the same path.
        std::fs::rename(&path, dir.join("rotating.log.1")).expect("rename");
        std::fs::write(&path, b"fresh").expect("write new");

        let outcome = reader.next_chunk();
        std::fs::remove_dir_all(&dir).ok();
        match outcome {
            StreamStep::Failed(message) => assert!(
                message.starts_with("ESTALE"),
                "a replaced file must report ESTALE, got: {message}"
            ),
            other => panic!(
                "expected ESTALE, got {}",
                match other {
                    StreamStep::Chunk(_) => "a chunk".to_string(),
                    StreamStep::Done => "a clean end".to_string(),
                    StreamStep::Failed(message) => message,
                }
            ),
        }
    }

    #[test]
    fn read_of_a_file_removed_mid_read_fails_rather_than_ending_cleanly() {
        // ⚠ THE REGRESSION for the empty-id ambiguity, and the failure it
        // prevented was silent: `identity()` returns `""` BOTH when the
        // filesystem cannot report an id AND when the path is gone, and the guard
        // treated every empty value as "unchanged". So a file DELETED mid-read
        // kept reading from the still-open handle and ended with a clean `Done` —
        // the caller stored a complete-looking result for a file that no longer
        // existed, with `ENOENT` never reported.
        //
        // Measured before the fix: after `remove_file`, `identity()` is empty, the
        // guard skips, and the open handle returns the remaining bytes with no
        // error at all.
        let dir = temp_dir("read-removed");
        let path = dir.join("vanishing.log");
        std::fs::write(&path, vec![7u8; CHUNK * 2]).expect("write");

        let mut reader = FileReader::open(path.to_str().unwrap(), 0).expect("open");
        assert!(matches!(reader.next_chunk(), StreamStep::Chunk(_)));

        // Delete the path while the handle stays open — the case the guard missed.
        std::fs::remove_file(&path).expect("remove");

        let outcome = reader.next_chunk();
        std::fs::remove_dir_all(&dir).ok();
        match outcome {
            StreamStep::Failed(message) => assert!(
                message.starts_with("ENOENT"),
                "a removed file must report ENOENT (not a clean end), got: {message}"
            ),
            other => panic!(
                "expected ENOENT, got {} — a deleted file must not look like a finished read",
                match other {
                    StreamStep::Chunk(_) => "a chunk".to_string(),
                    StreamStep::Done => "a clean end".to_string(),
                    StreamStep::Failed(message) => message,
                }
            ),
        }
    }

    #[test]
    fn read_of_a_file_that_simply_ends_still_reports_done() {
        // The control for the test above: the new ENOENT branch must not fire on a
        // file that is still there. Without this, "always fail" would pass the
        // regression while breaking every ordinary read.
        let dir = temp_dir("read-normal-end");
        let path = dir.join("short.log");
        std::fs::write(&path, b"abc").expect("write");
        let mut reader = FileReader::open(path.to_str().unwrap(), 0).expect("open");

        let mut chunks = 0;
        loop {
            match reader.next_chunk() {
                StreamStep::Chunk(_) => chunks += 1,
                StreamStep::Done => break,
                StreamStep::Failed(message) => panic!("unexpected failure: {message}"),
            }
        }
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(chunks, 1);
    }

    #[test]
    fn read_of_a_missing_file_reports_not_found_not_stale() {
        // The distinction the proposal insists on: these two need opposite
        // handling, so they must not collapse into one code.
        let dir = temp_dir("read-missing");
        let missing = dir.join("nope.bin");
        let error = FileReader::open(missing.to_str().unwrap(), 0)
            .err()
            .expect("must fail");
        std::fs::remove_dir_all(&dir).ok();
        assert!(error.starts_with("ENOENT"), "got: {error}");
    }

    #[test]
    fn read_of_a_directory_is_refused_rather_than_opened() {
        let dir = temp_dir("read-a-dir");
        let error = FileReader::open(dir.to_str().unwrap(), 0)
            .err()
            .expect("must refuse a directory");
        std::fs::remove_dir_all(&dir).ok();
        assert!(error.starts_with("EISDIR"), "got: {error}");
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_character_device_never_reaches_the_read_path() {
        // ⚠ Attempted regression test for the reader-thread wedge, KEPT because
        // what it pins is worth knowing — but it does NOT exercise the `is_file`
        // guard, and saying so is the point.
        //
        // Measured on Windows: `std::fs::metadata(r"\\.\NUL")` already FAILS with
        // `os error 1` (ERROR_INVALID_FUNCTION), so the call never reaches the new
        // guard — the OS refuses it a step earlier. (Node's `statSync` on the same
        // path SUCCEEDS and reports a character device, which is why this looked
        // testable; the two runtimes disagree, and Rust's behaviour is the one
        // that matters here.)
        //
        // So on Windows this asserts the *outcome* a caller sees — a prompt error,
        // never a hang — rather than the code path that produced it. The guard
        // itself is exercised on Unix, where `metadata` on a FIFO succeeds and
        // `is_file()` is false; that path is NOT covered by local or Windows CI
        // (no `mkfifo`) and is therefore an honest gap, recorded in the proposal's
        // unverified list rather than claimed as tested.
        let error = FileReader::open(r"\\.\NUL", 0)
            .err()
            .expect("a character device must not open");
        // Either code is correct here: EACCES when the OS refuses the stat first
        // (what Windows does today), EUNSUPPORTED when the guard is what refuses.
        assert!(
            error.starts_with("EACCES") || error.starts_with("EUNSUPPORTED"),
            "expected a prompt refusal (EACCES or EUNSUPPORTED), got: {error}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn read_of_a_fifo_is_refused_by_the_regular_file_guard() {
        // ⚠ THE REAL regression for the reader-thread wedge, and it only runs on
        // Unix because Windows has no `mkfifo`.
        //
        // A FIFO is the case the guard exists for: `metadata` SUCCEEDS on it and
        // `is_dir()` is false, so before the guard `File::open` would BLOCK here
        // until a writer appeared — on the reader thread, meaning cancellation
        // frames are never read and every other in-flight RPC stalls until the
        // shell kills the tree.
        //
        // `mkfifo` is invoked directly (no crate) and the test skips if the
        // command is unavailable, rather than asserting on a file that was never
        // created — a test that silently passes when its fixture is missing is
        // the failure mode this suite keeps guarding against.
        let dir = temp_dir("read-fifo");
        let fifo = dir.join("pipe");
        let made = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if !made {
            std::fs::remove_dir_all(&dir).ok();
            eprintln!("mkfifo unavailable; skipping the FIFO guard check");
            return;
        }

        // The stat must SUCCEED (else this proves nothing about the guard), and
        // the open must refuse without blocking.
        let meta = std::fs::metadata(&fifo).expect("metadata on a FIFO succeeds");
        assert!(!meta.is_dir(), "a FIFO is not a directory");

        let error = FileReader::open(fifo.to_str().unwrap(), 0)
            .err()
            .expect("a FIFO must be refused, not opened");
        std::fs::remove_dir_all(&dir).ok();
        assert!(
            error.starts_with("EUNSUPPORTED"),
            "expected EUNSUPPORTED from the regular-file guard, got: {error}"
        );
    }

    #[test]
    fn a_symlink_to_a_regular_file_is_still_readable() {
        // The guard uses `metadata` (following links), so refusing non-regular
        // files must NOT lock out the ordinary case of a symlinked log file.
        let dir = temp_dir("read-symlink-ok");
        let real = dir.join("real.txt");
        std::fs::write(&real, b"hello").expect("write");
        let link = dir.join("link.txt");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).expect("symlink");
        #[cfg(windows)]
        {
            // A file symlink needs elevation on Windows, so fall back to the real
            // path rather than skipping: the assertion that matters (a regular
            // file still opens) is preserved either way.
            if std::os::windows::fs::symlink_file(&real, &link).is_err() {
                let reader = FileReader::open(real.to_str().unwrap(), 0).expect("open real");
                drop(reader);
                std::fs::remove_dir_all(&dir).ok();
                return;
            }
        }
        let reader = FileReader::open(link.to_str().unwrap(), 0).expect("open symlink");
        drop(reader);
        std::fs::remove_dir_all(&dir).ok();
    }

    // --- write --------------------------------------------------------------

    #[test]
    fn write_creates_and_reports_the_end_offset() {
        let dir = temp_dir("write-create");
        let path = dir.join("out.bin");
        let writer = FileWriter::open(path.to_str().unwrap(), &json!({})).expect("open");
        let mut sink = DeferredWriter {
            writer,
            reply: DeferredReply::test_stub(),
            mode: "create",
        };
        sink.write(b"abc").expect("write");
        sink.write(b"de").expect("write");
        let written = sink.writer.file.stream_position().expect("position");
        sink.finish(Ok(()));
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(written, 5);
    }

    #[test]
    fn append_mode_ignores_a_moved_cursor() {
        // Documented and measured: this is the only correct shape for a rolling
        // log under concurrent writers, because seek-then-write races.
        let dir = temp_dir("write-append");
        let path = dir.join("log.txt");
        std::fs::write(&path, b"first").expect("seed");

        let mut writer =
            FileWriter::open(path.to_str().unwrap(), &json!({ "mode": "append" })).expect("open");
        // Move the cursor backwards; append must ignore it.
        writer.file.seek(SeekFrom::Start(0)).expect("seek");
        writer.file.write_all(b"+second").expect("write");
        let contents = std::fs::read_to_string(&path).expect("read");
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(contents, "first+second");
    }

    #[test]
    fn append_with_a_nonzero_offset_is_rejected_as_a_contradiction() {
        let dir = temp_dir("write-contradiction");
        let path = dir.join("x.txt");
        let error = FileWriter::open(
            path.to_str().unwrap(),
            &json!({ "mode": "append", "offset": 5 }),
        )
        .err()
        .expect("must fail");
        std::fs::remove_dir_all(&dir).ok();
        assert!(error.starts_with("EUNSUPPORTED"), "got: {error}");
    }

    // --- watch --------------------------------------------------------------

    #[test]
    fn watch_falls_back_to_the_parent_when_the_target_does_not_exist() {
        // Without this, tailing a log that has not been created yet fails — the
        // "application started before its log existed" case.
        let dir = temp_dir("watch-missing");
        let missing = dir.join("not-yet.log");
        let watcher = FileWatcher::start(missing.to_str().unwrap(), false).expect("start");
        let fell_back = watcher.watching_parent;
        drop(watcher);
        std::fs::remove_dir_all(&dir).ok();
        assert!(fell_back, "an absent target must watch its parent");
    }

    #[test]
    fn close_unwatches_the_path_that_was_registered_not_the_canonicalized_one() {
        // ⚠ THE REGRESSION for the silent no-op unwatch.
        //
        // `start` canonicalizes into `target` (via `comparable`) but hands the
        // CALLER's string to `watch`. `close` used to unwatch `&self.target`, so
        // in every case where those differ — a relative input, a symlinked
        // ancestor (macOS `/var` → `/private/var`), or the parent-directory
        // fallback — the unwatch matched nothing, the watch outlived the stream,
        // and `let _ =` discarded the error. This pins the invariant directly:
        // the path `close` will unwatch must equal the path `watch` was given.
        let dir = temp_dir("watch-unwatch");
        let target = dir.join("live.log");
        std::fs::write(&target, b"seed\n").expect("write");

        // (a) Target EXISTS: registration is on the caller's path, and the
        //     canonical form differs from it whenever `dir` contains a symlink
        //     (on macOS `temp_dir()` is the `/var` form).
        let watcher = FileWatcher::start(target.to_str().unwrap(), false).expect("start");
        assert!(!watcher.watching_parent);
        assert_eq!(
            watcher.registered,
            PathBuf::from(target.to_str().unwrap()),
            "close must unwatch exactly what watch was given"
        );
        drop(watcher);

        // (b) Target ABSENT: registration is on the PARENT, so unwatching the
        //     target would be a no-op — and `target` here is "parent + name",
        //     a path that was never registered at all.
        let missing = dir.join("not-yet.log");
        let watcher = FileWatcher::start(missing.to_str().unwrap(), false).expect("start");
        assert!(watcher.watching_parent);
        assert_eq!(
            watcher.registered, dir,
            "the fallback registers the PARENT, so that is what close must unwatch"
        );
        drop(watcher);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn watch_emits_a_create_for_a_file_that_did_not_exist() {
        let dir = temp_dir("watch-create");
        let target = dir.join("appears.log");
        let mut watcher = FileWatcher::start(target.to_str().unwrap(), false).expect("start");

        std::fs::write(&target, b"hello\n").expect("write");

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut seen = None;
        while seen.is_none() && std::time::Instant::now() < deadline {
            if let Some(change) = watcher.next_value(Duration::from_millis(200)) {
                seen = Some(change);
            }
        }
        watcher.close();
        std::fs::remove_dir_all(&dir).ok();

        let change = seen.expect("a create event for the new file");
        assert_eq!(change["kind"], json!("create"));
    }

    #[test]
    fn watch_filters_out_siblings_when_it_sits_on_the_parent() {
        // The fallback widens the watch to the whole directory, so without the
        // filter a neighbouring file's churn would be reported as a change to
        // the target — a silent correctness bug for a log tailer.
        let dir = temp_dir("watch-filter");
        let target = dir.join("wanted.log");
        let sibling = dir.join("unwanted.log");
        let mut watcher = FileWatcher::start(target.to_str().unwrap(), false).expect("start");
        assert!(watcher.watching_parent);

        // Create only the sibling; it must not be reported as the target.
        std::fs::write(&sibling, b"noise\n").expect("write");
        let observed = watcher.next_value(Duration::from_millis(700));
        watcher.close();
        std::fs::remove_dir_all(&dir).ok();

        assert!(
            observed.is_none(),
            "a sibling's change must not be attributed to the target: {observed:?}"
        );
    }

    #[test]
    fn watch_reports_modifications_to_an_existing_file() {
        let dir = temp_dir("watch-modify");
        let target = dir.join("live.log");
        std::fs::write(&target, b"start\n").expect("seed");
        let mut watcher = FileWatcher::start(target.to_str().unwrap(), false).expect("start");
        assert!(
            !watcher.watching_parent,
            "an existing file is watched directly"
        );

        std::fs::write(&target, b"start\nmore\n").expect("append");

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut count = 0;
        while count == 0 && std::time::Instant::now() < deadline {
            if watcher.next_value(Duration::from_millis(200)).is_some() {
                count += 1;
            }
        }
        watcher.close();
        std::fs::remove_dir_all(&dir).ok();
        assert!(count > 0, "a modification must be delivered");
    }

    #[test]
    fn a_missing_watch_target_inside_a_missing_directory_fails_loudly() {
        // Silently accepting this would give the caller a watch that can never
        // fire, which looks exactly like "nothing is happening".
        let dir = temp_dir("watch-nodir");
        let deeper = dir.join("no-such-dir").join("file.log");
        let error = FileWatcher::start(deeper.to_str().unwrap(), false)
            .err()
            .expect("must fail");
        std::fs::remove_dir_all(&dir).ok();
        assert!(error.starts_with("ENOENT"), "got: {error}");
    }

    // --- the symlinked-ancestor trap (found by macOS CI, not locally) -------

    #[test]
    fn event_paths_are_compared_canonically_so_a_symlinked_ancestor_matches() {
        // This is the platform trap that only macOS CI caught: `notify`'s
        // fsevent backend reports CANONICALIZED paths, while the caller passes
        // whatever it typed. On macOS `std::env::temp_dir()` yields `/var/...`
        // but events arrive as `/private/var/...`, because `/var` is a symlink.
        // A raw `==` therefore dropped every event and the watch looked like
        // "nothing ever happens" — a silent wrong answer, not an error.
        let dir = temp_dir("watch-canonical");
        let real = dir.canonicalize().expect("canonicalize");
        let target = real.join("appears.log");

        // Simulate what the backend reports: the canonical form of the same
        // path. On a platform without a symlinked ancestor these are equal, so
        // the assertion below is what would have failed on macOS.
        let reported = comparable(&target);
        assert!(
            event_concerns(&reported, &target),
            "a canonical event path must match the canonical target"
        );

        // And the negative direction must still hold: a sibling is not the
        // target, or the fallback filter would pass everything.
        let sibling = comparable(&real.join("other.log"));
        assert!(
            !event_concerns(&sibling, &target),
            "a sibling must not be mistaken for the target"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_target_that_does_not_exist_yet_still_yields_a_comparable_path() {
        // The parent-directory fallback watches a path that does not exist, so
        // canonicalization necessarily fails for it. The comparison must still
        // resolve the MISSING LEAF against the canonical parent, or the first
        // event after creation would be filtered out.
        let dir = temp_dir("watch-canonical-missing");
        let real = dir.canonicalize().expect("canonicalize");
        let missing = real.join("not-yet.log");

        let resolved = comparable(&missing);
        assert_eq!(
            resolved
                .parent()
                .and_then(|parent| parent.canonicalize().ok()),
            Some(real.clone()),
            "the missing leaf must resolve against its canonical parent"
        );
        assert!(event_concerns(&missing, &resolved));
        assert!(event_concerns(&resolved, &missing));

        std::fs::remove_dir_all(&dir).ok();
    }

    // --- error surface ------------------------------------------------------

    #[test]
    fn error_codes_are_prefixed_so_they_survive_the_wire() {
        // kkrpc's error frame only carries {name, message}; a structured field
        // would be dropped, so the code must live inside the message.
        assert_eq!(encode_error(Code::Stale, "x"), "ESTALE: x");
        assert_eq!(encode_error(Code::NotFound, "x"), "ENOENT: x");
        assert_ne!(Code::Stale.as_str(), Code::NotFound.as_str());
    }

    #[test]
    fn a_directory_read_is_reported_as_eisdir_not_as_a_generic_failure() {
        let dir = temp_dir("read-dir");
        let error = failure(FileReader::open(dir.to_str().unwrap(), 0));
        std::fs::remove_dir_all(&dir).ok();
        assert!(error.starts_with("EISDIR"), "got: {error}");
    }
}
