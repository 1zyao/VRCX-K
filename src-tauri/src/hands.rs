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
    /// The request was malformed for this path or this call.
    ///
    /// ⚠ Carved out of `Denied` rather than added for its own sake. `EACCES`
    /// means "authorisation is missing", and a caller acts on that by re-prompting
    /// the user or declaring the path off limits. `EINVAL` means the request could
    /// never have worked on any machine — retrying, re-prompting or widening
    /// permissions all waste the caller's time. Reporting one as the other is the
    /// mistake this variant exists to stop; see `classify`.
    Invalid,
    /// The target is already there and this call refuses to clobber it.
    ///
    /// Carved out of `Denied` for the same reason: "it exists" and "you may not
    /// touch it" lead to different fixes (pick another name vs change permissions).
    Exists,
    /// The call was interrupted before it completed.
    ///
    /// ⚠ The disposition is the opposite of `EACCES`: an interrupted operation is
    /// USUALLY RETRYABLE, and that is precisely what "access denied" tells a
    /// caller not to do.
    Interrupted,
    /// An internal fault in the hands themselves — never a statement about a path.
    ///
    /// ⚠ Its one producer is a POISONED `streams` lock (`Mutex::lock` failing,
    /// i.e. another thread panicked while holding the stream table). That used to
    /// be reported as `ESTALE`, which the host maps to `HandsError.isStale` — so a
    /// caller branching on it re-read the file, which cannot help a poisoned lock.
    Internal,
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
            Code::Invalid => "EINVAL",
            Code::Exists => "EEXIST",
            Code::Interrupted => "EINTR",
            Code::Internal => "EINTERNAL",
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

/// ⚠ THE PREVIOUS VERSION OF THIS FUNCTION FELL THROUGH TO `Denied`, and what it
/// got wrong was the caller's DISPOSITION, not the wording. It named only
/// `NotFound` / `PermissionDenied` / `IsADirectory` / `StorageFull` /
/// `Unsupported` (plus one substring guess at `"os error 5"`), so everything else
/// — `ENOTDIR`, `EINVAL`, `ELOOP`, `ENAMETOOLONG`, `AlreadyExists`, `Interrupted`
/// — came out as `EACCES: …`. But the closed code set exists precisely so a
/// caller can branch on it: `EACCES` says "authorisation is missing" (re-prompt
/// the user, declare the path off limits), while the truth was "this request can
/// never work" or "you were interrupted, try again". Both were told to stop and
/// ask for permission.
///
/// The sharpest case: a path that names a non-directory THROUGH a trailing
/// separator (`<dir>/a.txt/`). Measured on Windows: `ERROR_DIRECTORY` (267), which
/// std already surfaces as `ErrorKind::NotADirectory`; on Linux/macOS the same
/// shape is raw `ENOTDIR`. Both used to reach the catch-all and become `EACCES`,
/// for a path where permissions were never the issue. `NotADirectory` now maps to
/// `NotDir` — the code the enum already had, and which `DirectoryReader::open` was
/// the sole producer of.
///
/// ⚠ The raw-code tables below were added and then most of them REMOVED, because
/// measurement did not support them. On rustc 1.97 / Windows the codes this bug is
/// about are already mapped to real `ErrorKind`s by std: 267 → `NotADirectory`,
/// 183 and 80 → `AlreadyExists`, 145 → `DirectoryNotEmpty`, 5 → `PermissionDenied`.
/// A hardcoded `winerror.h` table would therefore have been unreachable code
/// carrying a comment claiming it was load-bearing — the same class of mistake as
/// the bug being fixed. The one table that survives is Unix's, where `ENOTDIR`,
/// `ELOOP` and `ENAMETOOLONG` genuinely reach the catch-all as `Other`/`InvalidInput`
/// and the raw errno is the only thing that distinguishes them.
fn classify(error: &std::io::Error) -> Code {
    use std::io::ErrorKind;

    // ⚠ Before the kind match, because the kind is the coarser signal and loses
    // the distinction that matters here: `ELOOP` and `ENAMETOOLONG` both arrive as
    // `ErrorKind::InvalidInput` on Unix, so without this they are indistinguishable
    // from `EINVAL` — yet "break the symlink loop / shorten the path" and "the
    // argument is malformed" are different fixes for the caller.
    #[cfg(unix)]
    if let Some(errno) = error.raw_os_error() {
        if let Some(code) = classify_errno(errno) {
            return code;
        }
    }

    match error.kind() {
        ErrorKind::NotFound => Code::NotFound,
        ErrorKind::PermissionDenied => Code::Denied,
        ErrorKind::IsADirectory => Code::IsDir,
        ErrorKind::NotADirectory => Code::NotDir,
        ErrorKind::StorageFull => Code::NoSpace,
        ErrorKind::Unsupported => Code::Unsupported,
        ErrorKind::InvalidInput => Code::Invalid,
        ErrorKind::InvalidData => Code::Invalid,
        ErrorKind::AlreadyExists => Code::Exists,
        ErrorKind::Interrupted => Code::Interrupted,
        // ⚠ The catch-all is an EXPLICIT `Unsupported`, not `Denied`. Reusing
        // `Denied` here is what produced the bug above; and inventing a mapping for
        // an error nobody has classified would be worse than admitting the gap.
        // `EUNSUPPORTED` is already in the wire contract and already means "we do
        // not have a code for this", which is exactly true.
        //
        // One deliberate exception, kept from the original: Windows reports a
        // directory handed to `OpenOptions::open` for writing as "access denied",
        // and that IS a permission answer, so it must stay `EACCES`. Measured: that
        // shape arrives as `ErrorKind::PermissionDenied` with raw 5 — caught by the
        // arm above, not by this one. This guard is therefore defence in depth for
        // a std that classifies it as `Other` instead; it is not the arm doing the
        // work today, and saying so is the point of the comment.
        ErrorKind::Other if error.raw_os_error() == Some(5) => Code::Denied,
        _ => Code::Unsupported,
    }
}

/// The Unix errno values the kind match cannot separate, so `ELOOP` /
/// `ENAMETOOLONG` / `ENOTDIR` stop collapsing into one code.
///
/// ⚠ Only called on Unix. `ENOTDIR` and `EISDIR` are included because they are the
/// two shapes this finding is about; the rest are the neighbours that share a kind
/// with them.
///
/// ⚠ The values come from `libc`, not from literals: `ENOTDIR` is 20 on x86_64
/// Linux but 31 on mips and 4 or 21 on sparc, so a literal table would be silently
/// wrong on those targets while passing on the machine that wrote it. Android
/// agrees with the asm-generic table, which is why this is safe for the Android
/// build.
///
/// Returning `None` means "the kind match is good enough for this one"; it is not
/// an error path.
#[cfg(unix)]
fn classify_errno(errno: i32) -> Option<Code> {
    match errno {
        libc::ENOTDIR => Some(Code::NotDir),
        // Not `Denied`, which is what the catch-all used to say: a symlink loop is
        // a request that can never resolve, not a permission the caller lacks.
        libc::ELOOP => Some(Code::Invalid),
        libc::ENAMETOOLONG => Some(Code::Invalid),
        libc::EINVAL => Some(Code::Invalid),
        libc::EEXIST => Some(Code::Exists),
        libc::EINTR => Some(Code::Interrupted),
        libc::EISDIR => Some(Code::IsDir),
        libc::ENOSPC => Some(Code::NoSpace),
        _ => None,
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
        // ⚠ AN OFFSET PAST EOF MUST FAIL, and the failure it used to produce was
        // the OPPOSITE of the truth — silently.
        //
        // `seek(SeekFrom::Start(n))` past the end is legal on every platform, so
        // the seek succeeded; the following `read` then returned 0 immediately,
        // which `next_chunk` reports as `StreamStep::Done`. The caller received a
        // SUCCESSFUL, EMPTY stream: "the read finished", when what had actually
        // happened is "the file is shorter than the point you asked to resume
        // from". The proposal (§2.2) classifies exactly that situation as
        // `ESTALE` — the file was truncated underneath you, start over.
        //
        // The consequence was a wrong-correctness resume: a caller resuming a
        // truncated transfer read the empty stream as "already complete" and
        // committed a partial file as whole. That is the failure mode `ESTALE`
        // exists to prevent, and it was the one case producing `Done`.
        //
        // Equality is allowed on purpose: `offset == len` is a legitimate
        // "resume at the very end" and yields the same empty-but-finished answer
        // the caller asked for. Only a STRICTLY larger offset is a contradiction.
        if offset > meta.len() {
            return Err(encode_error(
                Code::Stale,
                format!(
                    "{path} is {} bytes but offset {offset} was requested — the file is \
                     shorter than the resume point, so it was truncated or replaced; \
                     reopen it and restart from 0",
                    meta.len()
                ),
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
                    // Resolved by `open` already; re-resolving cannot fail here
                    // (it validated the same `opts`), but the error is propagated
                    // rather than unwrapped so a future divergence is loud.
                    let mode = match write_intent(&opts) {
                        Ok(intent) => intent.label(),
                        Err(error) => {
                            reply.fail(error);
                            return;
                        }
                    };
                    // The sink owns the reply: "how many bytes did you write" is
                    // only answerable after the last chunk arrives.
                    let sink = Box::new(DeferredWriter {
                        writer,
                        reply: reply.clone(),
                        mode,
                    });
                    // `consume_stream` opens the credit window, so the host
                    // starts sending only after this returns. If it refuses,
                    // the reply is still owed.
                    if let Err(error) = target.consume_stream(&sid, sink) {
                        // `consume_refusal` returns the FULL message, because the
                        // dead-transport case must stay un-prefixed — see its docs.
                        reply.fail(consume_refusal(&error));
                    }
                }
                Err(error) => reply.fail(error),
            }
        }),
    );
}

/// How a write should open the file.
///
/// ⚠ WHY THIS REPLACED A `mode` ENUM, and what the enum got wrong.
///
/// The old `mode: "create" | "truncate" | "append"` made ONE field carry TWO
/// independent decisions, and its default resolved them in a way that corrupted
/// files. Measured through a real peer: writing 11 bytes over a 20-byte JSON file
/// replied `{bytes: 11, endOffset: 11, mode: "create"}` while the file on disk
/// became `{"alpha":9}"beta":2}` — invalid JSON, reported as success. The default
/// did not truncate, but the contract said "overwrite from 0".
///
/// The two decisions are genuinely orthogonal:
///
/// | caller intent | offset | truncate |
/// |---|---|---|
/// | rewrite a file (config, export) | omitted | **implied true** |
/// | resume a transfer (from `endOffset`) | given | **implied false** |
/// | patch bytes in place | given, explicit `false` also fine | false |
/// | append to a rolling log | — | **`append: true`** |
///
/// So `truncate` DEFAULTS TO "truncate IFF no offset was given": a plain rewrite
/// (the corrupting case) truncates, while `{offset: N}` — the natural way to
/// resume — is read as "in place" rather than refused. Either intent can still
/// override, and an explicit contradiction is refused below.
///
/// ⚠ `append` stays its own flag rather than being "offset = end": it opens with
/// `O_APPEND`, which makes concurrent writers race-free. `seek(end)` then `write`
/// is a read-modify-write and loses data when two writers interleave; that is
/// measured (`append_mode_ignores_a_moved_cursor`) and is the whole reason a
/// rolling log works.
#[derive(Debug, Clone, Copy)]
struct WriteIntent {
    /// Where to start writing. `None` = 0 (or the end, for `append`).
    offset: Option<u64>,
    /// Cut the file to ZERO before writing. ⚠ Not "at the write position" —
    /// truncation here is always to zero, which is why `truncate` with a
    /// nonzero `offset` is refused rather than documented.
    ///
    /// Defaults to `offset.is_none()`: an offset means "in place", a bare
    /// rewrite means "replace". See the struct docs for the table.
    truncate: bool,
    /// Open with `O_APPEND` instead of seeking.
    append: bool,
}

impl WriteIntent {
    /// The name reported back to the caller, for observability.
    fn label(self) -> &'static str {
        if self.append {
            "append"
        } else if self.truncate {
            "truncate"
        } else {
            "overwrite"
        }
    }
}

/// Parse `{ offset, truncate, append }`, refusing contradictions rather than
/// silently picking a winner.
fn write_intent(opts: &Value) -> Result<WriteIntent, String> {
    // ⚠ A STALE `mode` KEY MUST BE REFUSED, NOT IGNORED — measured, and the
    // consequence is data loss.
    //
    // `mode` was this API's request key until it was replaced by the flags above.
    // Ignoring it is NOT a compatible no-op: the old default was "do not
    // truncate", while the new default is "rewrite", so an unchanged caller
    // sending `{mode: "append"}` silently got the opposite of what it asked for.
    // Measured through a real peer: a 44-byte file, `{mode: "append"}`, 5 bytes
    // sent ⇒ reply `{bytes: 5, mode: "truncate"}` and the file on disk was
    // **5 bytes** — the caller's existing content was gone.
    //
    // Refusing keeps the promise made one function away: "a malformed option is
    // refused, never guessed at". A loud failure is the only safe answer for a
    // request whose meaning changed underneath it.
    if let Some(stale) = opts.get("mode") {
        return Err(encode_error(
            Code::Unsupported,
            format!(
                "hands.write: `mode` was replaced by `truncate`/`offset`/`append` and is no \
                 longer read; ignoring it would change what this call does. Replace \
                 {stale} with the equivalent flags (append: `{{ \"append\": true }}`, \
                 overwrite-in-place: `{{ \"truncate\": false, \"offset\": N }}`)"
            ),
        ));
    }

    let offset = match opts.get("offset") {
        None | Some(Value::Null) => None,
        Some(value) => Some(value.as_u64().ok_or_else(|| {
            encode_error(
                Code::Unsupported,
                format!("hands.write: `offset` must be a non-negative integer, got {value}"),
            )
        })?),
    };
    let truncate = match opts.get("truncate") {
        // ⚠ An EXPLICIT offset implies "in place", so the rewrite default must not
        // apply. Otherwise `{offset: 5}` — the natural way to resume — would be
        // refused by the contradiction check below, and the only working spelling
        // would be `{offset: 5, truncate: false}`. That is a footgun: the safe
        // reading of "write at this offset" is "do not destroy what is before it".
        //
        // The corrupting case this default exists for never passes an offset: it
        // is a plain rewrite, where truncation is what the caller wants.
        None | Some(Value::Null) => offset.is_none(),
        Some(Value::Bool(flag)) => *flag,
        Some(other) => {
            return Err(encode_error(
                Code::Unsupported,
                format!("hands.write: `truncate` must be a boolean, got {other}"),
            ));
        }
    };
    let append = match opts.get("append") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(other) => {
            return Err(encode_error(
                Code::Unsupported,
                format!("hands.write: `append` must be a boolean, got {other}"),
            ));
        }
    };

    // Contradictions are refused, not resolved. Each of these has an obvious
    // "what the caller probably meant", and guessing is how the previous design
    // produced a silent overwrite of a file it never truncated.
    if append && offset.is_some_and(|offset| offset > 0) {
        return Err(encode_error(
            Code::Unsupported,
            "hands.write: `append` and `offset > 0` are mutually exclusive",
        ));
    }
    if append && truncate && opts.get("truncate").is_some() {
        // `truncate: true` + `append: true` is self-defeating: appending to a file
        // that was just emptied always writes at 0. Refusing beats silently
        // ignoring one of the two.
        return Err(encode_error(
            Code::Unsupported,
            "hands.write: `append` and `truncate: true` are mutually exclusive \
             (appending to a truncated file always starts at 0)",
        ));
    }
    if truncate && offset.is_some_and(|offset| offset > 0) {
        // ⚠ REFUSED, and the earlier version of this code ALLOWED it on a wrong
        // premise. It claimed this was a legitimate "cut the tail" operation.
        // Measured through a real peer: `{truncate: true, offset: 5}` on a 20-byte
        // file, 3 bytes written, produced `00 00 00 00 00 42 42 42` — the head is
        // ZEROED, not preserved, because `O_TRUNC` empties the whole file and the
        // subsequent `seek(5)` only leaves a NUL hole. There is no "truncate at
        // the write position" primitive here; truncation is always to zero.
        //
        // So the combination's only real meaning would be "write NULs then my
        // data", which is not something a caller should get by accident. Refused
        // rather than documented, because a doc cannot stop the corruption.
        return Err(encode_error(
            Code::Unsupported,
            "hands.write: `truncate: true` with `offset > 0` zero-fills everything \
             before the offset (truncation is always to zero, not to the write \
             position). Pass `truncate: false` to patch in place, or omit `offset` \
             to rewrite the whole file",
        ));
    }

    Ok(WriteIntent {
        offset,
        // `append: true` without an explicit `truncate` must not truncate.
        truncate: truncate && !append,
        append,
    })
}

/// `Debug` so tests can `.expect_err(...)` on the `Result` — the Ok type has to
/// be printable for the panic message, and a file handle has no useful Debug.
#[derive(Debug)]
struct FileWriter {
    file: File,
    /// Bytes accepted by this writer. See [`DeferredWriter::finish`].
    written: u64,
}

impl FileWriter {
    fn open(path: &str, opts: &Value) -> Result<Self, String> {
        // `write_intent` owns every contradiction check (append+offset,
        // append+truncate, unknown values), so nothing is re-validated here.
        let intent = write_intent(opts)?;

        // ⚠ Refuse anything that is not a regular file BEFORE opening it, for the
        // same reason `FileReader::open` does: `OpenOptions::open` on a FIFO with
        // write access BLOCKS until a reader appears, and this runs inline on the
        // ONE reader thread — so the cancellation frame cannot be read, every
        // inbound RPC stalls to the 30s timeout, and only `kill_tree` recovers.
        // This is the write-side twin of the read-side guard; fixing only the
        // read half left the same wedge reachable through `hands.write`.
        //
        // A MISSING path is allowed through: `create(true)` below is how callers
        // make a new file, and that is a normal use, not a wedge. A directory is
        // refused here so both platforms agree on the code (`EISDIR`), instead of
        // one giving `EACCES` and the other `EISDIR`.
        match std::fs::metadata(path) {
            Ok(meta) if meta.is_dir() => {
                return Err(encode_error(
                    Code::IsDir,
                    format!("hands.write: {path} is a directory"),
                ));
            }
            Ok(meta) if !meta.is_file() => {
                return Err(encode_error(
                    Code::Unsupported,
                    format!("hands.write: {path} is not a regular file"),
                ));
            }
            // A regular file: exactly what we want.
            Ok(_) => {}
            // Does not exist yet — `create(true)` will make it.
            Err(error) if classify(&error) == Code::NotFound => {}
            Err(error) => return Err(encode_error(classify(&error), error)),
        }

        let mut options = OpenOptions::new();
        options.write(true).create(true);
        if intent.append {
            options.append(true);
        } else if intent.truncate {
            options.truncate(true);
        }
        let mut file = options
            .open(path)
            .map_err(|error| encode_error(classify(&error), error))?;
        // Seeking is meaningless with `O_APPEND` (the kernel forces every write to
        // the end), and `write_intent` has already refused the contradictory
        // combination, so this only runs for a real offset.
        if let Some(offset) = intent.offset {
            file.seek(SeekFrom::Start(offset))
                .map_err(|error| encode_error(classify(&error), error))?;
        }
        Ok(Self { file, written: 0 })
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
            .map_err(|error| encode_error(classify(&error), error))?;
        // ⚠ Count what THIS call wrote, not where the cursor ended up.
        self.writer.written += bytes.len() as u64;
        Ok(())
    }

    fn finish(&mut self, outcome: Result<(), String>) {
        match outcome {
            Ok(()) => {
                // ⚠ `bytes` and `endOffset` are DIFFERENT NUMBERS and used to be
                // the same one. Both came from the file cursor, so `append` to a
                // 1 MiB file reported `bytes: 1048581` after writing 5 bytes —
                // measured through a real peer. A caller that wants to show "5 B
                // written" or to verify its own byte count got the file size
                // instead, and the two coincide only when writing a fresh file.
                //
                //   bytes     = what THIS call wrote (caller-facing)
                //   endOffset = where the cursor now is (needed to resume)
                //
                // `endOffset` still comes from the cursor, so `append` keeps
                // reporting where the bytes actually landed rather than where the
                // caller asked them to start.
                let written = self.writer.written;
                let end_offset = self.writer.file.stream_position().unwrap_or(written);
                let _ = self.writer.file.flush();
                self.reply.send(json!({
                    "bytes": written,
                    "endOffset": end_offset,
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
    /// The mode the watch was ACTUALLY registered with — the value `notify` was
    /// handed, not a copy of the caller's request.
    ///
    /// ⚠ `#[cfg(test)]`-only, and that is a deliberate trade rather than tidiness.
    /// Nothing in production reads it; it exists so the regression test can assert
    /// what the call site really passed. The alternative considered and REJECTED
    /// after measurement was a behavioural test — the two modes are
    /// indistinguishable through `next_value` for a parent watch, so such a test
    /// passed on the broken code. See `watch_and_report_mode`.
    #[cfg(test)]
    registered_mode: RecursiveMode,
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

/// Are two path components equal, folding case only where the platform does?
///
/// ⚠ WHY THIS EXISTS, and the silent failure it removes.
///
/// [`event_concerns`] used `PathBuf` equality, which is byte equality: there was
/// no case folding anywhere in this file. On Windows and macOS — where the
/// filesystem is case-INSENSITIVE by default — a caller that watched `app.log`
/// while the file was created as `App.Log` had EVERY event silently dropped. The
/// watch looked like "nothing ever happens" rather than failing, which is the
/// worst possible symptom (see the `target` field docs for the same shape caused
/// by canonicalization).
///
/// That path is not a corner: it is precisely the PARENT-WATCH FALLBACK — "watch
/// the parent, wait for the target to appear" — where `target` is built from the
/// caller's string and the file on disk is created (by another program, from
/// another naming convention) with whatever case it likes. On Windows the caller
/// has no way to predict it: `CreateFile("App.Log")` creates `App.Log` and
/// `C:\x\App.Log` stats fine through the spelling `app.log`.
///
/// ⚠ THE UNIX BEHAVIOUR IS UNCHANGED, DELIBERATELY. On a case-sensitive
/// filesystem `App.Log` and `app.log` are two DIFFERENT files, so folding there
/// would attribute one file's events to the other — trading a dropped event for a
/// misattributed one, which is worse (a log tailer would follow the wrong file).
/// Hence the `cfg`: the fold is compiled in only where the platform folds names.
///
/// The fold is ASCII-only, matching `PathBuf`'s own `eq_ignore_ascii_case`-style
/// semantics that the standard library offers. Non-ASCII case folding (Turkish
/// dotless i, Greek final sigma, …) needs Unicode tables and locale context that
/// neither the OS API nor this layer has; Windows' own case-insensitivity is
/// closer to an upcase table than to a full fold, so ASCII is the honest bound.
/// A non-ASCII filename that differs only in case may still be missed — recorded
/// here rather than papered over with a hand-rolled table that would be wrong in
/// the other direction.
fn component_eq(left: &std::ffi::OsStr, right: &std::ffi::OsStr) -> bool {
    if left == right {
        return true;
    }
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        // ⚠ `to_string_lossy` rather than requiring `&str`: this comparison runs
        // for EVERY event path, and a path that is not valid UTF-8 (perfectly
        // legal on both platforms) must not be the reason an event is dropped.
        // The lossy form is only used for the CASE-insensitive second opinion;
        // the exact `==` above already answered for byte-identical paths.
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        false
    }
}

/// Does this path equal `target`, component by component, with the platform's
/// own case sensitivity?
///
/// `PathBuf ==` cannot be used directly because it is always case-SENSITIVE; see
/// [`component_eq`] for why folding unconditionally would be wrong on Unix.
fn paths_eq_platform(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    // Only the two platforms that fold need the walk, and the walk allocates, so
    // it is skipped entirely where folding is not compiled in.
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (left, right);
        false
    }
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        let mut left_components = left.components();
        let mut right_components = right.components();
        loop {
            match (left_components.next(), right_components.next()) {
                (None, None) => return true,
                (Some(a), Some(b)) => {
                    if !component_eq(a.as_os_str(), b.as_os_str()) {
                        return false;
                    }
                }
                _ => return false,
            }
        }
    }
}

/// Does this event concern the watched path?
///
/// Compared on canonicalized forms so a symlinked ancestor (macOS `/var`) does
/// not make every event look unrelated, and with the platform's case sensitivity
/// so a `App.Log`/`app.log` difference on Windows does not do the same. A raw
/// `==` here is the bug described on [`FileWatcher::target`].
fn event_concerns(event_path: &Path, target: &Path) -> bool {
    paths_eq_platform(event_path, target) || paths_eq_platform(&comparable(event_path), target)
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
        let mut registered_mode = mode;
        let watching_parent = match watcher.watch(&requested, mode) {
            Ok(()) => false,
            // ⚠ ONLY "the path is not there" may fall back to the parent. The
            // decision is a named unit (`classify_watch_refusal`) rather than an `if`
            // guard, so at least the DECISION is testable.
            //
            // ⚠ HONEST LIMIT, measured: the call site's USE of that decision is NOT
            // end-to-end falsifiable on Windows. No non-absence refusal is reachable
            // from a unit test — probed with a NUL path, a path under a missing
            // parent, a 300-char leaf and a duplicate watch, and every one either
            // succeeded or came back as `Generic(...)` with `exists() == false`. So
            // mutating this `match` to hardcode `TryParent` (the literal old `Err(_)`
            // swallow) leaves every test GREEN, and no test here pretends otherwise.
            // What IS pinned is `classify_watch_refusal`'s contract, which is where
            // the reasoning lives.
            Err(error) => {
                match classify_watch_refusal(&error, &requested) {
                    WatchRefusal::Report(code) => {
                        return Err(encode_error(code, error));
                    }
                    WatchRefusal::TryParent => {}
                }
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
                // ⚠ THE FALLBACK HONOURS THE CALLER'S `recursive`, and it used to
                // hardcode `NonRecursive` right here while `mode` — computed three
                // lines above from the caller's flag — was discarded.
                //
                // The lie that produced: a caller asking to watch a
                // not-yet-created DIRECTORY TREE (the ordinary "tail -f a log dir
                // that the app has not made yet" shape) got a NonRecursive watch
                // on the parent. `notify` on Linux/macOS delivers the parent's own
                // events only, so the moment the tree appeared and files changed
                // inside it, nothing was ever reported — while the caller believed
                // it was watching the tree, exactly the silent-drop symptom the
                // `target` docs describe for macOS canonicalization.
                //
                // There is no "recursive is meaningless for a parent" argument
                // here: the parent may itself be a directory, and watching it
                // recursively is well-defined and is what was asked for. When the
                // target is a FILE the promise is weaker by nature (a recursive
                // watch on a file behaves as a non-recursive one), but that is the
                // platform's constraint, not a reason to silently downgrade the
                // mode the caller chose.
                //
                // ⚠ The registration goes through `register_watch` so the mode that
                // was ACTUALLY passed to `notify` is the value returned to the
                // caller — see that function for why a stored copy of `mode` was
                // not good enough.
                watch_and_report_mode(&mut watcher, parent, mode)
                    .map_err(|error| encode_error(classify_anyhow(&error), error))
                    .map(|actually| registered_mode = actually)?;
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
            #[cfg(test)]
            registered_mode,
            registered,
        })
    }

    /// Translate one filesystem event into the proposal's `HandsChange` shape.
    ///
    /// ⚠ `target` is a parameter, and it is the whole point of this signature.
    ///
    /// The previous version took no target and reported `event.paths.first()`.
    /// That was wrong in exactly the multi-path case, and multi-path is not
    /// exotic: a rename WITHIN one directory is a single
    /// `Modify(Name(Both))` event carrying `paths = [from, to]`, and notify's own
    /// `Event::paths` documentation says the order puts the source first and the
    /// destination LAST.
    ///
    /// So for a caller watching `app.log`, an atomic-write rotation produces a
    /// `[app.log.tmp, app.log]` event — the FILTER admitted it (it tests
    /// `.any(...)`, and `app.log` is in there), and then the report described
    /// `app.log.tmp`. Both the `path` and the `id` pointed at the wrong file:
    /// the `id` is taken from that same path, so a caller comparing it against
    /// `stat(app.log).id` to detect rotation saw a mismatch and concluded the file
    /// had been replaced — when the event it was handed was "your file was just
    /// written". A temp-file name reaches the caller as if it were the watched
    /// path.
    ///
    /// Selecting the matching path fixes the report at the source. When nothing
    /// matches (the watch is on the target itself, so no filtering happened, or
    /// the event concerns a path the caller did not ask about), the first path is
    /// the best available answer and is kept.
    fn change_of(event: &notify::Event, target: &Path) -> Option<Value> {
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
        // ⚠ `find`, not `first`. Prefer the path that IS the watched target; fall
        // back to the first only when none of them matches. See the docs above.
        let path = event
            .paths
            .iter()
            .find(|path| event_concerns(path, target))
            .or_else(|| event.paths.first())?;
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
                    if let Some(change) = Self::change_of(&event, &self.target) {
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
        // `MaxFilesWatch` is the inotify limit, and it is NOT a path problem —
        // `Unsupported` is the honest "there is no code for this" with the detail
        // preserved in the message.
        _ => Code::Unsupported,
    }
}

/// What to do about a refusal from `watch()`.
///
/// ⚠ This enum exists so the decision is ONE named, testable unit rather than an
/// `if` guard whose else-branch no test can reach. Before it, the fallback was
/// written as `Err(error) if watch_refusal_is_absent(...) => { … }` / `Err(error)
/// => report`, and the predicate could be tested while the SHAPE — "is the guard
/// consulted at all, or is every error swallowed as before?" — could not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WatchRefusal {
    /// The target is absent (or the backend says so): watch the parent instead.
    TryParent,
    /// A real failure, carrying the code to report. Never a fallback.
    Report(Code),
}

/// Decide how to react to a `watch()` refusal.
///
/// ⚠ The contract, stated once: ONLY absence falls back to the parent. Everything
/// else is reported as itself. The old code was `Err(_)`, which read every failure
/// as "not there yet" and answered it by watching the parent — so a permission
/// fault, a watch-limit fault or a backend fault reached the caller as `ENOENT`,
/// and a caller that treats absence as retryable would retry forever against a
/// condition that cannot change.
fn classify_watch_refusal(error: &notify::Error, requested: &Path) -> WatchRefusal {
    if watch_refusal_is_absent(error, requested) {
        WatchRefusal::TryParent
    } else {
        WatchRefusal::Report(classify_anyhow(error))
    }
}

/// Is this `watch()` refusal "the path is not there"?
///
/// ⚠ THIS IS DELIBERATELY NOT `matches!(error.kind, ErrorKind::PathNotFound)`, and
/// the reason is measured in notify's own source rather than assumed.
///
/// The two backends that matter classify a MISSING path DIFFERENTLY:
///
/// | backend | a path that does not exist |
/// |---|---|
/// | Linux (inotify) | `ErrorKind::PathNotFound` |
/// | macOS (fsevent) | `ErrorKind::PathNotFound` |
/// | **Windows** | **`ErrorKind::Generic("Input watch path is neither a file nor a directory.")`** |
///
/// Windows' `add_watch` (`notify-8.2.0/src/windows.rs:169`) opens with
/// `if !path.is_dir() && !path.is_file() { return Err(Error::generic("Input watch
/// path is neither a file nor a directory.").add_path(path)) }`, so an absent
/// target is a `Generic` there. Gating on the kind alone would therefore have made
/// the parent-directory fallback DEAD ON WINDOWS — the regression would have
/// looked like "the target does not exist" now failing with `EUNSUPPORTED`
/// instead of being watched, which is the very case the fallback exists for.
/// (Measured: every `watch_falls_back_*` test failed with
/// `EUNSUPPORTED: Input watch path is neither a file nor a directory.`)
///
/// So absence is decided by asking the FILESYSTEM, not by trusting the kind: if
/// the path is genuinely not there, it is absent regardless of how the backend
/// worded it, and the parent fallback applies. If it IS there, then a refusal is a
/// real failure (permissions, watch limits, a backend fault) and is reported as
/// itself.
///
/// The `PathNotFound` kind is still honoured as a positive signal, because on Unix
/// it is what makes the answer independent of a TOCTOU race between the `watch`
/// call and this check: the backend already knows the path was missing.
fn watch_refusal_is_absent(error: &notify::Error, requested: &Path) -> bool {
    if matches!(error.kind, notify::ErrorKind::PathNotFound) {
        return true;
    }
    // A `Generic` refusal from the Windows backend is the only other shape that
    // means "you gave me nothing to watch", and it is confirmed against the disk
    // rather than matched on its message text (which is upstream's to change).
    if matches!(error.kind, notify::ErrorKind::Generic(_)) {
        return !requested.exists();
    }
    // Every remaining kind is an `Io` error or a watch-limit fault: those describe
    // a real failure and must reach the caller as one.
    false
}

/// Register a watch and return the mode that was ACTUALLY passed to `notify`.
///
/// ⚠ THIS FUNCTION EXISTS SOLELY TO MAKE THE MODE FALSIFIABLE, and the reason is
/// worth the indirection. The bug in finding 2a was that the parent fallback
/// hardcoded `NonRecursive` while `mode` — computed correctly a few lines above
/// from the caller's flag — was discarded. The first version of the regression test
/// stored `mode` in a struct field and asserted the field; re-injecting the bug left
/// it GREEN (measured), because that field recorded the INTENT that the broken code
/// also computed correctly. Asserting a stored copy of the input is not a test of
/// the call.
///
/// ⚠ The obvious alternative — assert the BEHAVIOUR — was measured and does not
/// work either, and that measurement is the whole justification for this shape. A
/// recursive and a non-recursive watch of the same parent produce IDENTICAL output
/// through `next_value`, because the parent-watch filter admits only events whose
/// path IS the target, and a subdirectory's events are dropped in BOTH modes.
/// Probed with a not-yet-created target directory, a file created inside it
/// afterwards, and a sibling file in the parent: both modes reported exactly the
/// same two events (the target's own create+modify) and nothing else. There is no
/// behavioural difference for a black-box test to observe on this platform through
/// this API, so a "behavioural" test would have been green on the broken code too.
///
/// What IS observable is what the call site hands to `notify`, so that is what is
/// returned. `watch` is still the only thing doing the work; the return value is the
/// argument it was given, so a future edit that hardcodes the mode again (or
/// otherwise passes something different) changes the returned value and fails
/// `the_parent_fallback_honours_the_callers_recursive_flag`. That is a real
/// falsification, unlike re-reading `mode`.
fn watch_and_report_mode<W: Watcher>(
    watcher: &mut W,
    path: &Path,
    mode: RecursiveMode,
) -> notify::Result<RecursiveMode> {
    watcher.watch(path, mode).map(|()| mode)
}

/// The text `kkrpc_peer::close_streams` fails every consumer with.
/// than an oversight. `kkrpc_peer::TRANSPORT_CLOSED` is private to that module and
/// this file may not edit it, so the two literals are kept byte-identical by this
/// comment plus the assertion in `transport_closed_text_matches_the_peer`. The
/// alternative — inventing a second spelling of "the transport is dead" — is
/// precisely the bug being fixed: a caller that branches on a dead transport must
/// see ONE string whether the news arrives through a sink's `finish` or through
/// this refusal. `crate::kkrpc_peer`'s own tests pin the peer side
/// (`assert_eq!(message, TRANSPORT_CLOSED)`), so if that literal ever moves, this
/// one is the other half to move with it.
const TRANSPORT_CLOSED_TEXT: &str = "host stdio closed";

/// Turn a refused [`Peer::consume_stream`] into the message the caller receives.
///
/// ⚠ ALL THREE CAUSES USED TO BE ENCODED AS `Stale`, and that is a wrong ACTION,
/// not merely a wrong label. The host's `HandsError.isStale` is literally
/// `code === "ESTALE"` (`host/src/hands.ts`) and means "the path now refers to a
/// DIFFERENT file — reopen and reset the offset", so a caller that branches on it
/// RE-READS the file. For every one of the three causes below that is wasted work
/// against a condition that has not changed, and for two of them it is also
/// misleading about what actually broke:
///
/// | cause | old code | code now | why the caller acts differently |
/// |---|---|---|---|
/// | this sid is already being consumed | `ESTALE` | `EUNSUPPORTED` | the request is malformed; a re-read cannot make it succeed |
/// | the stream-table lock is poisoned | `ESTALE` | `EINTERNAL` | an internal fault; retrying cannot help |
/// | the transport is already gone | `ESTALE` | `host stdio closed` (raw) | the pipe is down; reconnect, do not re-read |
///
/// ⚠ The third is deliberately NOT a `Code`. [`TRANSPORT_CLOSED_TEXT`] is what
/// `close_streams` fails every other consumer with, so the message BEGINS with
/// that exact text and a caller matching on "the transport is dead" sees one
/// spelling of it regardless of which path noticed. Because it is un-prefixed it
/// parses to `code: undefined` — the honest "no file-level code applies" that
/// `HandsError` documents for an unrecognised message — and crucially `isStale`
/// is `false`, which is the whole point.
///
/// ⚠ `EUNSUPPORTED` for the duplicate is not a new wire code: it is already in the
/// contract and already means "we cannot honour this request", so the host's
/// `HANDS_ERROR_CODES` keeps working unchanged. `EINTERNAL` IS new, and the honest
/// consequence is that the host parses it to `code: undefined` until the host-side
/// list gains it — still a strict improvement, because the previous `ESTALE` made
/// `isStale` true and sent the caller down the re-read path for an internal fault.
///
/// The cause is read from the refusal TEXT because `consume_stream` returns
/// `Result<(), String>`. It matches the substrings the peer itself writes, and the
/// peer's own test pins `"is already being consumed"` — so if that wording
/// changes, that test goes red rather than this mapping silently reverting to a
/// single code for all three.
fn consume_refusal(error: &str) -> String {
    if error.contains("is already being consumed") {
        // A second consumer for one sid. The request cannot be honoured, and
        // telling the caller "your file rotated" sends it to re-read for nothing.
        encode_error(Code::Unsupported, error)
    } else if error.contains("poisoned") {
        // `Mutex::lock` failing is a poisoned lock: another thread panicked while
        // holding the stream table, so the stream state is not trustworthy.
        encode_error(Code::Internal, error)
    } else {
        // The remaining failure mode in `consume_stream` is its own opening
        // `pull` write failing — i.e. the transport end. Report it the way
        // `close_streams` does, not as a file-state code. The peer's own message
        // is appended so the diagnostic detail is not lost, but the message now
        // BEGINS with the transport text — which is what a caller matching on it
        // (and what `isStale`, which is false here for any of these) keys off.
        format!("{TRANSPORT_CLOSED_TEXT}: {error}")
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
        //
        // ⚠ THE EXPECTED CODE CHANGED FROM `EACCES` TO `EINVAL` (finding 1). The
        // old comment here read "`classify` maps `InvalidInput` to `Denied` →
        // `EACCES`, so the assertion below is exact rather than a disjunction" —
        // true at the time, and it was describing the bug, not a contract: a
        // malformed path is not a permission failure, and a caller that saw
        // `EACCES` would go and ask the user for rights that were never the
        // problem. The assertion is still exact; only the value moved.
        let error =
            stat_outcome("a\0b").expect_err("a real failure must be a failure, not a value");
        assert!(
            error.starts_with("EINVAL"),
            "the failure must carry a parseable code, and a NUL is a malformed \
             path, not a denied one; got: {error}"
        );
        assert!(
            !error.starts_with("EACCES"),
            "⚠ EACCES would send the caller to fix permissions for a NUL byte: {error}"
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
            FileWriter::open(path.to_str().unwrap(), &json!({ "append": true })).expect("open");
        // Move the cursor backwards; append must ignore it.
        writer.file.seek(SeekFrom::Start(0)).expect("seek");
        writer.file.write_all(b"+second").expect("write");
        let contents = std::fs::read_to_string(&path).expect("read");
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(contents, "first+second");
    }

    #[test]
    fn bytes_counts_what_this_call_wrote_not_the_resulting_file_size() {
        // ⚠ THE REGRESSION for the conflated counter. `bytes` and `endOffset` both
        // came from the file cursor, so appending 5 bytes to a 1 MiB file reported
        // `bytes: 1048581` — measured through a real peer. A caller showing
        // "5 B written", or checking its own byte count, got the file size; the
        // two agree only when writing a fresh file, which is why it survived.
        //
        // ⚠ It asserts the REPLY FRAME, not `writer.written`. The first version
        // read the field directly, so re-injecting the bug (making `bytes` the
        // cursor again) left it GREEN — it checked the input to the fix rather
        // than its output. A capturing reply shows what a caller really receives.
        let dir = temp_dir("write-bytes");
        let path = dir.join("big.bin");
        std::fs::write(&path, vec![b'A'; 1024 * 1024]).expect("seed");

        let writer =
            FileWriter::open(path.to_str().unwrap(), &json!({ "append": true })).expect("open");
        let (reply, sink_bytes) = crate::kkrpc_peer::test_support::reply_with_sink();
        let mut sink = DeferredWriter {
            writer,
            reply,
            mode: "append",
        };
        sink.write(b"12345").expect("write");
        sink.finish(Ok(()));
        std::fs::remove_dir_all(&dir).ok();

        let frame = crate::kkrpc_peer::test_support::last_frame(&sink_bytes);
        assert_eq!(
            frame["v"]["bytes"],
            json!(5),
            "`bytes` must be what THIS call wrote, not the resulting file size"
        );
        assert_eq!(
            frame["v"]["endOffset"],
            json!(1024 * 1024 + 5),
            "`endOffset` stays the cursor position, which is what a resumer needs"
        );
    }

    #[test]
    fn truncate_with_an_offset_is_refused_because_it_zero_fills_the_head() {
        // ⚠ THE CORRUPTION REGRESSION, and the earlier code ALLOWED this on a
        // wrong premise: its comment called the pair a legitimate "cut the tail".
        // Measured through a real peer — a 20-byte file, `{truncate: true,
        // offset: 5}`, 3 bytes written, gave `00 00 00 00 00 42 42 42`: the head
        // is ZEROED, not preserved, because `O_TRUNC` empties the whole file and
        // the following `seek(5)` leaves a NUL hole. There is no "truncate at the
        // write position" primitive; truncation is always to zero.
        let error = write_intent(&json!({ "truncate": true, "offset": 5 }))
            .expect_err("truncate + offset must be refused, not zero-fill the head");
        assert!(
            error.starts_with("EUNSUPPORTED"),
            "the refusal must carry a parseable code, got: {error}"
        );
        assert!(
            error.contains("truncate: false"),
            "the error must name the fix (patch in place), got: {error}"
        );
        // The two legitimate neighbours must still work: patch in place, or
        // rewrite the whole file.
        assert!(write_intent(&json!({ "truncate": false, "offset": 5 })).is_ok());
        assert!(write_intent(&json!({ "truncate": true })).is_ok());
        assert!(write_intent(&json!({ "offset": 5 })).is_ok());
    }

    #[test]
    fn a_stale_mode_key_is_refused_rather_than_silently_ignored() {
        // ⚠ THE DATA-LOSS REGRESSION. `mode` was the request key before the flags
        // replaced it, and ignoring it is NOT a compatible no-op: the old default
        // did not truncate while the new default rewrites. Measured through a real
        // peer — a 44-byte file, `{mode: "append"}`, 5 bytes sent ⇒ the file on
        // disk was 5 bytes. The caller's existing content was destroyed while it
        // believed it was appending.
        let error = write_intent(&json!({ "mode": "append" }))
            .expect_err("a stale `mode` must be refused, not ignored");
        assert!(
            error.starts_with("EUNSUPPORTED"),
            "the refusal must carry a parseable code, got: {error}"
        );
        // The message must be actionable: it names the replacement flags, because
        // the caller has to change its request either way.
        assert!(
            error.contains("append") && error.contains("truncate"),
            "the error should name the replacements, got: {error}"
        );
        // Every stale value is refused, including one that would have been valid
        // before: `create` was the old default and is not a flag now.
        for stale in ["append", "create", "truncate", ""] {
            assert!(
                write_intent(&json!({ "mode": stale })).is_err(),
                "stale mode {stale:?} must be refused"
            );
        }
    }

    #[test]
    fn an_unrecognised_write_flag_is_refused_rather_than_downgraded() {
        // ⚠ THE REGRESSION for the silent downgrade. The old `mode` field returned
        // `"create"` for ANY unrecognised input, and `create` did NOT truncate — so
        // a typo silently meant "overwrite the head and keep the old tail".
        // Measured: 100 bytes over a 10 240-byte file replied `endOffset: 100`
        // while the file stayed 10 240 bytes.
        //
        // The field is gone, but the LESSON is what survives: a malformed option is
        // refused, never guessed at.
        for bad in [
            json!({ "offset": "5" }),
            json!({ "truncate": "yes" }),
            json!({ "truncate": 1 }),
            json!({ "append": "no" }),
            json!({ "append": 0 }),
        ] {
            let error =
                write_intent(&bad).expect_err("a malformed option must be refused, not downgraded");
            assert!(
                error.starts_with("EUNSUPPORTED"),
                "the refusal must carry a parseable code, got: {error}"
            );
        }
    }

    #[test]
    fn the_default_intent_rewrites_the_file() {
        // ⚠ THE CORRUPTION REGRESSION, stated as the contract it should have been.
        //
        // The old default did NOT truncate, so rewriting a file with shorter
        // content left the old tail behind — measured: an 11-byte write over a
        // 20-byte JSON file produced `{"alpha":9}"beta":2}`, invalid JSON, reported
        // as SUCCESS. The documented contract always said "overwrite from 0", so
        // the default must truncate.
        let intent = write_intent(&json!({})).expect("default");
        assert!(intent.truncate, "the default must rewrite, not patch");
        assert!(!intent.append);
        assert_eq!(intent.offset, None);
        assert_eq!(intent.label(), "truncate");
    }

    #[test]
    fn resuming_a_transfer_never_truncates() {
        // The other half of the split: a caller resuming from `read`'s `endOffset`
        // must be able to say "do NOT cut the file" explicitly. Under the old
        // design that was the DEFAULT, which is why the corrupting case above had
        // to ask for `mode: "truncate"` — and why forgetting it silently produced a
        // corrupt file.
        let intent = write_intent(&json!({ "offset": 4096, "truncate": false })).expect("resume");
        assert!(!intent.truncate);
        assert_eq!(intent.offset, Some(4096));
        assert_eq!(intent.label(), "overwrite");
    }

    #[test]
    fn contradictory_write_intents_are_refused() {
        // Guessing which side the caller meant is how the old design produced a
        // silent partial overwrite. Each contradiction names itself instead.
        for bad in [
            json!({ "append": true, "offset": 5 }),
            json!({ "append": true, "truncate": true }),
        ] {
            let error = write_intent(&bad).expect_err("a contradiction must be refused");
            assert!(
                error.starts_with("EUNSUPPORTED"),
                "the refusal must carry a parseable code, got: {error}"
            );
        }
        // ⚠ `append: true` WITHOUT an explicit `truncate` is NOT a contradiction:
        // it means "append", so the rewrite default is turned off rather than
        // treated as a conflict the caller never expressed.
        let intent = write_intent(&json!({ "append": true })).expect("append");
        assert!(intent.append);
        assert!(
            !intent.truncate,
            "append must not inherit the rewrite default"
        );
        assert_eq!(intent.label(), "append");
    }

    #[test]
    fn writing_to_a_directory_is_refused_with_eisdir_on_every_platform() {
        // ⚠ The write-side twin of the read guard. `OpenOptions::open` on a
        // directory succeeds on Unix and fails with `EACCES` on Windows, so the
        // two platforms disagreed on the code; worse, `open(FIFO, O_WRONLY)`
        // BLOCKS and this runs inline on the ONE reader thread.
        let dir = temp_dir("write-dir");
        let error = FileWriter::open(dir.to_str().unwrap(), &json!({}))
            .expect_err("a directory must not be opened for writing");
        std::fs::remove_dir_all(&dir).ok();
        assert!(
            error.starts_with("EISDIR"),
            "both platforms must agree on EISDIR, got: {error}"
        );
    }

    #[test]
    fn a_missing_write_target_is_still_created() {
        // The control for the guard above: refusing non-regular files must NOT
        // refuse a path that simply does not exist yet — `create(true)` is how
        // callers make a new file, and that is the common case.
        let dir = temp_dir("write-new");
        let path = dir.join("fresh.bin");
        FileWriter::open(path.to_str().unwrap(), &json!({}))
            .expect("a missing path must still be creatable");
        let exists = path.exists();
        std::fs::remove_dir_all(&dir).ok();
        assert!(exists, "create(true) must have made the file");
    }

    #[test]
    fn writing_through_a_file_reports_not_a_directory() {
        // ⚠ This is the `write`-side producer for `ENOTDIR`, which before this
        // change existed NOWHERE outside `DirectoryReader::open`. The path names a
        // non-directory through a trailing separator, the shape that yields
        // `ENOTDIR` on every platform (see the `stat` twin above).
        //
        // It matters that `write` can produce it too: a caller that guessed "this is
        // a directory I can write into" gets `ENOTDIR` from both primitives rather
        // than one code from `list` and a fabricated `EACCES` from `write`.
        let dir = temp_dir("write-notdir");
        let file = dir.join("a.txt");
        std::fs::write(&file, b"x").expect("write");
        let through = format!("{}{}", file.display(), std::path::MAIN_SEPARATOR);

        let error = match FileWriter::open(&through, &json!({})) {
            Ok(_) => panic!("a file named as a directory must not open for writing"),
            Err(error) => error,
        };
        std::fs::remove_dir_all(&dir).ok();

        assert!(
            error.starts_with("ENOTDIR"),
            "expected ENOTDIR from the write path, got: {error}"
        );
        assert!(
            !error.starts_with("EACCES"),
            "⚠ EACCES is the pre-fix answer: it sends the caller to fix permissions \
             for a path shape that no permission can fix"
        );
    }

    #[test]
    fn append_with_a_nonzero_offset_is_rejected_as_a_contradiction() {
        let dir = temp_dir("write-contradiction");
        let path = dir.join("x.txt");
        let error = FileWriter::open(
            path.to_str().unwrap(),
            &json!({ "append": true, "offset": 5 }),
        )
        .expect_err("must fail");
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

    // --- finding 2: the fallback discarded `recursive`, and swallowed errors --

    #[test]
    fn the_parent_fallback_honours_the_callers_recursive_flag() {
        // ⚠ THE REGRESSION for finding 2a. The fallback registered the parent with
        // a hardcoded `RecursiveMode::NonRecursive` while the `mode` computed from
        // the caller's flag was discarded — so a caller asking to watch a
        // not-yet-created DIRECTORY TREE got the parent's own events only, and
        // every change inside the tree was silently dropped after the tree
        // appeared. It believed it was watching the tree.
        //
        // ⚠⚠ THE SECOND VERSION OF THIS TEST WAS ALSO WRONG, AND THE MEASUREMENT IS
        // THE REASON THIS ONE LOOKS ODD.
        //
        // Version 1 asserted a struct field holding `mode`. Green on the broken code
        // — the field recorded the intent the broken code also computed.
        //
        // Version 2 asserted the BEHAVIOUR (recursive vs non-recursive watch of the
        // same parent, then a file written into a subdirectory). Also green on the
        // broken code, because the two modes are INDISTINGUISHABLE through this API:
        // the parent-watch filter admits only events whose path IS the target, so a
        // subdirectory's events are dropped in BOTH modes. Probed directly — a
        // not-yet-created target directory, a file created inside it afterwards, and
        // a sibling file — and both modes reported exactly the same two events (the
        // target's own create and modify) and nothing else. There is no black-box
        // difference to observe.
        //
        // So the value asserted is the mode `notify` was ACTUALLY HANDED, returned by
        // the single call site (`watch_and_report_mode`). It is falsifiable in the
        // way that matters: re-injecting the hardcoded `NonRecursive` changes what
        // the call site passes, which changes this value, which fails the test
        // (verified by fault injection, not asserted).
        let dir = temp_dir("watch-fallback-mode");
        let tree = dir.join("not-yet-dir");

        let recursive = FileWatcher::start(tree.to_str().unwrap(), true).expect("start");
        assert!(
            recursive.watching_parent,
            "the fixture must exercise the fallback, or this proves nothing"
        );
        assert_eq!(
            recursive.registered_mode,
            RecursiveMode::Recursive,
            "⚠ a recursive request must stay recursive through the parent fallback; \
             this is the mode notify was actually given"
        );
        let registered = recursive.registered.clone();
        drop(recursive);

        // The non-recursive direction must not be silently upgraded either: the fix
        // is "honour what was asked", not "always recurse".
        let flat = FileWatcher::start(tree.to_str().unwrap(), false).expect("start");
        assert!(flat.watching_parent);
        assert_eq!(
            flat.registered_mode,
            RecursiveMode::NonRecursive,
            "a non-recursive request must not be silently upgraded"
        );
        assert_eq!(
            flat.registered, registered,
            "both fallbacks register the same parent; only the mode differs"
        );
        drop(flat);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_non_recursive_request_stays_non_recursive_when_the_target_exists() {
        // The control for the test above: honouring the flag must not change the
        // already-correct DIRECT registration path, which goes through the same
        // `watcher.watch(&requested, mode)` call. Both directions are asserted so
        // the control cannot be satisfied by a constant.
        let dir = temp_dir("watch-direct-mode");
        let target = dir.join("live.log");
        std::fs::write(&target, b"x").expect("write");

        let flat = FileWatcher::start(target.to_str().unwrap(), false).expect("start");
        assert!(!flat.watching_parent);
        assert_eq!(flat.registered_mode, RecursiveMode::NonRecursive);
        drop(flat);

        let deep = FileWatcher::start(target.to_str().unwrap(), true).expect("start");
        assert!(!deep.watching_parent);
        assert_eq!(deep.registered_mode, RecursiveMode::Recursive);
        drop(deep);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_watch_refusal_that_is_not_absence_is_not_treated_as_absence() {
        // ⚠ THE REGRESSION for finding 2b. The fallback arm used to be `Err(_)`, so
        // EVERY `notify` failure was read as "the path does not exist" and answered
        // by watching the parent. A permission failure, a watch-limit failure or a
        // backend fault was therefore reported to the caller as `ENOENT` ("not there
        // yet") — and a caller that treats absence as retryable would retry forever
        // against a condition that cannot change.
        //
        // ⚠⚠ THE FIRST VERSION OF THIS TEST WAS NOT FALSIFIABLE, AND THE MEASUREMENT
        // THAT SHOWED IT IS WORTH RECORDING. It asserted only that
        // `watch_refusal_is_absent` says `false` for an `Io` error. Mutating the
        // Windows `Generic` branch to `return true` left it GREEN — because on
        // Windows the absence decision does not go through that branch at all for
        // the cases the test constructs. Probed: notify's Windows backend reports
        // EVERY unwatchable path as
        // `Generic("Input watch path is neither a file nor a directory.")` with
        // `exists() == false` — including a path containing a NUL byte, which is
        // malformed rather than absent. So the predicate is exercised, but the
        // branch the mutation touched is not.
        //
        // What the guard actually has to get right is the CALL SITE: "a refusal that
        // is not absence must not be answered by falling back to the parent". That is
        // asserted end-to-end below via a path whose PARENT also does not exist —
        // the one shape where absence and non-absence are distinguishable through the
        // public entry point, because the fallback would otherwise report the
        // parent's absence rather than the refusal's own code.
        let dir = temp_dir("watch-refusal-taxonomy");
        let present = dir.join("here.log");
        std::fs::write(&present, b"x").expect("write");

        // (a) `PathNotFound` IS absence, whatever the disk says now.
        assert!(
            watch_refusal_is_absent(&notify::Error::path_not_found(), &present),
            "PathNotFound is the backend saying 'absent' and must fall back"
        );

        // (b) An `Io` error is a REAL failure even when the path is missing: it
        //     describes the backend failing, not the path being absent. This is the
        //     case the old `Err(_)` mislabelled. ⚠ THIS IS THE FALSIFIABLE CORE:
        //     flipping the final `false` of `watch_refusal_is_absent` to `true` makes
        //     it red (verified by fault injection).
        let io_error = notify::Error::io(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "denied",
        ));
        assert!(
            !watch_refusal_is_absent(&io_error, &present),
            "⚠ an io refusal on a path that EXISTS is not absence; the old `Err(_)` \
             called it 'not there yet' and the caller would retry forever"
        );
        assert!(
            !watch_refusal_is_absent(&io_error, &dir.join("missing.log")),
            "⚠ even for a missing path an io error is a backend failure, not a \
             clean 'absent' — reporting it as ENOENT hides the real cause"
        );

        // (c) `MaxFilesWatch` is the inotify limit: also a real failure.
        assert!(
            !watch_refusal_is_absent(
                &notify::Error::new(notify::ErrorKind::MaxFilesWatch),
                &present
            ),
            "the watch limit is not absence, and must not send the caller to retry"
        );

        // ⚠ (d) THE DECISION UNIT. `classify_watch_refusal` is what the call site
        // consumes, so pinning it pins the contract: a refusal that is NOT absence
        // must come back as `Report(..)`, never `TryParent`.
        //
        // ⚠ MEASURED LIMITS, RECORDED RATHER THAN PAPERED OVER — two of them:
        //
        //   1. Producing a real non-absence refusal from `notify` is not possible on
        //      this platform. Probed: a NUL path, a path under a missing parent, a
        //      300-char leaf, and a duplicate watch — every one either succeeded or
        //      came back as `Generic("Input watch path is neither a file nor a
        //      directory.")` with `exists() == false`.
        //   2. Consequently the call site's USE of this decision is NOT falsifiable
        //      either: mutating it to hardcode `TryParent` (the literal old `Err(_)`
        //      swallow) leaves this test GREEN — verified by fault injection, not
        //      assumed. Only the predicate/decision contract is pinned.
        //
        // The `Io` and `MaxFilesWatch` shapes below are real `notify::Error`s a
        // backend does produce; they are simply not reachable from a unit test's
        // filesystem. Asserting them here is a contract test, and is labelled as one.
        assert_eq!(
            classify_watch_refusal(&io_error, &present),
            WatchRefusal::Report(Code::Denied),
            "⚠ a permission refusal must be REPORTED, not answered by watching the \
             parent — this is the old `Err(_)` swallow"
        );
        assert_eq!(
            classify_watch_refusal(
                &notify::Error::new(notify::ErrorKind::MaxFilesWatch),
                &present
            ),
            WatchRefusal::Report(Code::Unsupported),
            "the watch limit must be reported, never treated as absence"
        );
        assert_eq!(
            classify_watch_refusal(&notify::Error::path_not_found(), &present),
            WatchRefusal::TryParent,
            "the genuine absence case must still fall back"
        );

        // (e) A malformed path is REFUSED (not silently accepted), and — on Windows
        //     — is reported as absent, because the backend cannot tell the two
        //     apart. Pinning the behaviour that exists means a future change to it
        //     is deliberate; see the limitation note above.
        let malformed = FileWatcher::start("a\0b", false)
            .err()
            .expect("a malformed path must still be refused rather than accepted");
        std::fs::remove_dir_all(&dir).ok();
        assert!(
            !malformed.starts_with("EACCES"),
            "a malformed path must not be dressed up as a permission failure: {malformed}"
        );
    }

    // --- finding 3: a multi-path event reported the WRONG file ----------------

    #[test]
    fn a_two_path_event_reports_the_target_not_the_first_path() {
        // ⚠ THE REGRESSION for finding 3, and the old code's filter is what let it
        // through: the filter asks `.any(path == target)`, so an event with
        // `paths = [tmp, target]` was ADMITTED — and then `change_of` reported
        // `.first()`, i.e. `tmp`.
        //
        // This is not a hypothetical shape. On Linux a rename within one directory
        // is a single `Modify(Name(Both))` event carrying `[from, to]` in that
        // order (notify's own `Event::paths` docs: source first, target LAST), and
        // an atomic-write rotation (`write .tmp`, `rename .tmp -> app.log`) is
        // exactly that. So a log tailer was handed a temp-file name and the temp
        // file's `id`, and a caller comparing that `id` against `stat(app.log).id`
        // saw a mismatch and concluded "the file rotated" on an event that meant
        // "your file was just written".
        //
        // The event is CONSTRUCTED rather than provoked, deliberately: the
        // ordering is a backend contract, not something this platform will
        // reproduce on demand, and the bug lived in the selection — not in getting
        // the event.
        let dir = temp_dir("watch-rename-paths");
        let target = dir.join("app.log");
        let temp = dir.join("app.log.tmp");
        std::fs::write(&target, b"new").expect("write target");
        std::fs::write(&temp, b"tmp").expect("write temp");

        let canonical_target = comparable(&target);
        let event = notify::Event {
            kind: notify::EventKind::Modify(notify::event::ModifyKind::Name(
                notify::event::RenameMode::Both,
            )),
            // Source FIRST, destination LAST — the order notify documents.
            paths: vec![temp.clone(), canonical_target.clone()],
            attrs: Default::default(),
        };

        // The filter must admit it (this is what made the bug reachable) ...
        assert!(
            event
                .paths
                .iter()
                .any(|path| event_concerns(path, &canonical_target)),
            "the fixture must be an event the filter admits, or it tests nothing"
        );

        let change = FileWatcher::change_of(&event, &canonical_target).expect("a change");
        std::fs::remove_dir_all(&dir).ok();

        assert_eq!(
            change["path"],
            json!(canonical_target.to_string_lossy()),
            "⚠ the event's SECOND path is the watched file; reporting the temp name \
             both misnames the path and mis-attributes the id"
        );
        assert_ne!(
            change["path"],
            json!(temp.to_string_lossy()),
            "the temp name must never be reported as the watched path"
        );
    }

    #[test]
    fn a_two_path_event_still_falls_back_to_the_first_when_nothing_matches() {
        // The control for the test above: the target-matching preference must not
        // make the report EMPTY when no path matches (a direct watch on the target
        // applies no filter, so such events do legitimately arrive). The first path
        // remains the best available answer.
        let dir = temp_dir("watch-unmatched-paths");
        let target = dir.join("watched.log");
        let other = dir.join("unrelated.log");

        let unrelated_event = notify::Event {
            kind: notify::EventKind::Modify(notify::event::ModifyKind::Any),
            paths: vec![other.clone(), dir.join("second.log")],
            attrs: Default::default(),
        };

        let change = FileWatcher::change_of(&unrelated_event, &target)
            .expect("an event with paths must still produce a change");
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(
            change["path"],
            json!(other.to_string_lossy()),
            "with no matching path the first is still the best answer"
        );
    }

    #[test]
    fn an_event_with_no_paths_is_skipped_rather_than_reported() {
        // `change_of` returns `Option`; a pathless event must stay `None` so the
        // caller keeps waiting instead of receiving a change with no path.
        let event = notify::Event {
            kind: notify::EventKind::Modify(notify::event::ModifyKind::Any),
            paths: Vec::new(),
            attrs: Default::default(),
        };
        assert!(FileWatcher::change_of(&event, Path::new("/nowhere")).is_none());
    }

    // --- finding 5: case-sensitive comparison dropped real events -------------

    #[test]
    fn path_comparison_follows_the_platforms_case_sensitivity() {
        // ⚠ THE REGRESSION for finding 5. `event_concerns` used `PathBuf`
        // equality, which is byte equality and therefore always case-SENSITIVE.
        //
        // On Windows and macOS (`component_eq` folds) a caller watching `app.log`
        // while the file is created as `App.Log` had EVERY event dropped — the
        // watch looked like "nothing ever happens". That is exactly the
        // parent-watch fallback, where `target` comes from the caller's string and
        // the file is created by another program with its own capitalization.
        //
        // ⚠ The Unix direction is asserted too, and it is not decoration: folding
        // on a case-sensitive filesystem would MIS-ATTRIBUTE one file's events to
        // the other, trading a dropped event for a wrong one (a log tailer would
        // follow the wrong file). Both halves are required.
        let upper = Path::new("/tmp/App.Log");
        let lower = Path::new("/tmp/app.log");

        if cfg!(any(target_os = "windows", target_os = "macos")) {
            assert!(
                event_concerns(upper, lower),
                "⚠ on a case-insensitive platform `App.Log` and `app.log` are the \
                 SAME file, so dropping the event is wrong"
            );
            assert!(
                event_concerns(lower, upper),
                "the fold must be symmetric, or half the events still vanish"
            );
        } else {
            assert!(
                !event_concerns(upper, lower),
                "⚠ on a case-sensitive filesystem these are DIFFERENT files; folding \
                 here would attribute one file's events to the other"
            );
        }

        // The platform-independent half: a path that is genuinely different is
        // never a match, so the fold cannot degrade into "everything matches".
        assert!(!event_concerns(Path::new("/tmp/other.log"), lower));
        assert!(event_concerns(lower, lower));
    }

    #[test]
    fn a_recursive_watch_still_reports_a_case_difference_on_this_platform() {
        // ⚠ THE END-TO-END SHAPE OF FINDING 5, and the ONLY shape where it can
        // actually fire — which a measurement made clear, and which is why this
        // test is written the way it is rather than the obvious way.
        //
        // Measured on Windows: `path.canonicalize()` NORMALIZES CASE (it returns
        // the on-disk spelling), and `comparable` canonicalizes whenever it can. So
        // for a file that EXISTS, `target` already carries the on-disk case and a
        // raw `==` would have matched. The case bug therefore cannot be reproduced
        // by creating the file first and watching the other spelling — that version
        // of this test passed on the BROKEN code, i.e. it proved nothing.
        //
        // It fires exactly where canonicalization FAILS: the parent-watch fallback,
        // where the target does not exist yet. `start` then builds `target` as
        // `canonical_parent.join(caller's leaf)`, so `target` keeps the CALLER's
        // capitalization, while the event for the newly created file canonicalizes
        // to the on-disk spelling. Different case ⇒ every event dropped ⇒ the watch
        // looks like "nothing ever happens" for the whole life of the file.
        //
        // ⚠ IT DRIVES `next_value` THROUGH THE REAL FILTER, not `change_of` alone,
        // because the drop happens in the `watching_parent` filter — testing the
        // helper would have gone green while the watch still dropped everything.
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            // On a case-sensitive filesystem the behaviour is deliberately the
            // opposite, and `path_comparison_follows_the_platforms_case_sensitivity`
            // pins that half. Asserting it here too would mean watching a file that
            // genuinely does not exist and expecting an event, which is wrong.
        }
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            let dir = temp_dir("watch-case-fallback");
            // The caller asks for lower case; it does not exist yet.
            let requested = dir.join("app.log");
            let on_disk = dir.join("App.Log");

            let mut watcher =
                FileWatcher::start(requested.to_str().unwrap(), false).expect("start");
            assert!(
                watcher.watching_parent,
                "⚠ the fixture must exercise the FALLBACK: with an existing file, \
                 canonicalization already normalizes case and this proves nothing"
            );

            // The file appears with different capitalization, as another program
            // would create it.
            std::fs::write(&on_disk, b"hello\n").expect("write");

            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let mut seen = None;
            while seen.is_none() && std::time::Instant::now() < deadline {
                if let Some(change) = watcher.next_value(Duration::from_millis(200)) {
                    seen = Some(change);
                }
            }
            watcher.close();
            std::fs::remove_dir_all(&dir).ok();

            let change = seen.expect(
                "⚠ a differently-cased file appearing at the watched path must be \
                 reported; silence here IS the bug (the caller believes it watches a \
                 tree that never changes)",
            );
            assert!(
                change["path"]
                    .as_str()
                    .is_some_and(|path| path.to_ascii_lowercase().ends_with("app.log")),
                "the reported path must be the watched file, got: {change}"
            );
        }
    }

    // --- finding 4: an offset past EOF was a successful empty stream ----------

    #[test]
    fn an_offset_past_the_end_is_stale_rather_than_a_finished_read() {
        // ⚠ THE REGRESSION for finding 4, and the old behaviour was a WRONG ANSWER
        // rather than an error: `seek` past EOF is legal, the following `read`
        // returned 0, and `next_chunk` turned that into `StreamStep::Done`. The
        // caller received a successful, EMPTY stream — "the read finished" — when
        // the truth was "the file is shorter than your resume point", which the
        // proposal classifies as `ESTALE` ("truncated, start over").
        //
        // The consequence was a resume that silently committed a partial file as
        // whole: the one situation ESTALE exists to distinguish was the one
        // situation that produced `Done`.
        let dir = temp_dir("read-offset-past-eof");
        let path = dir.join("short.bin");
        std::fs::write(&path, b"0123456789").expect("write");

        let error = FileReader::open(path.to_str().unwrap(), 11)
            .err()
            .expect("⚠ an offset past EOF must FAIL, not yield an empty successful stream");
        std::fs::remove_dir_all(&dir).ok();

        assert!(
            error.starts_with("ESTALE"),
            "the file was truncated relative to the resume point, so the answer is \
             ESTALE (start over), got: {error}"
        );
        // The message must be actionable: it names both sizes, because the caller
        // has to decide whether the truncation is expected.
        assert!(
            error.contains("10") && error.contains("11"),
            "the error should name the file length and the requested offset, got: {error}"
        );
    }

    #[test]
    fn an_offset_exactly_at_the_end_is_still_a_clean_empty_read() {
        // ⚠ THE CONTROL, and the boundary is the whole subtlety: `offset == len`
        // is a legitimate "resume at the very end" and must still produce the clean
        // empty result. Refusing it too would break resumption whose last write
        // happened to land exactly on the end — the common case for a completed
        // transfer.
        let dir = temp_dir("read-offset-at-eof");
        let path = dir.join("exact.bin");
        std::fs::write(&path, b"0123456789").expect("write");

        let mut reader = FileReader::open(path.to_str().unwrap(), 10).expect("open at the end");
        let outcome = reader.next_chunk();
        std::fs::remove_dir_all(&dir).ok();

        match outcome {
            StreamStep::Done => {}
            other => panic!(
                "offset == len is a clean end, got {}",
                match other {
                    StreamStep::Chunk(_) => "a chunk".to_string(),
                    StreamStep::Done => "done".to_string(),
                    StreamStep::Failed(message) => message,
                }
            ),
        }
    }

    #[test]
    fn an_offset_inside_the_file_is_unaffected_by_the_eof_guard() {
        // The second control: the new guard must not fire on an ordinary resume.
        let dir = temp_dir("read-offset-inside");
        let path = dir.join("mid.bin");
        std::fs::write(&path, b"0123456789").expect("write");

        let mut reader = FileReader::open(path.to_str().unwrap(), 4).expect("open mid-file");
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

    // --- finding 6: three consume_stream causes shared one code ---------------

    #[test]
    fn a_refused_consume_is_not_reported_as_stale() {
        // ⚠ THE REGRESSION for finding 6. `hands.write` encoded EVERY
        // `consume_stream` failure as `ESTALE`, and the host's `isStale` is
        // literally `code === "ESTALE"` — a promise that "the path now refers to a
        // DIFFERENT file, reopen and reset the offset". A caller branching on it
        // RE-READS the file. For all three real causes that is the wrong action.
        //
        // The three causes are asserted against the exact strings
        // `kkrpc_peer::consume_stream` produces, so this fails if the mapping
        // collapses back — or if the peer's wording moves without this being
        // updated.
        //
        //   (a) duplicate consume — the peer's own test pins this wording.
        let duplicate = consume_refusal("stream s-9 is already being consumed");
        assert!(
            duplicate.starts_with("EUNSUPPORTED"),
            "a duplicate consume is a malformed request, not a rotated file: {duplicate}"
        );
        assert!(
            !duplicate.starts_with("ESTALE"),
            "⚠ ESTALE makes `isStale` true and sends the caller off to re-read"
        );

        //   (b) a poisoned stream-table lock — `Mutex::lock` returning `Err`, which
        //       `consume_stream` stringifies via `map_err(|err| err.to_string())`.
        let poisoned = consume_refusal("poisoned lock: another task failed inside");
        assert!(
            poisoned.starts_with("EINTERNAL"),
            "a poisoned lock is an internal fault, not a file state: {poisoned}"
        );

        //   (c) the transport already gone — `consume_stream`'s opening `pull`
        //       write failing. It must carry the SAME text `close_streams` uses, so
        //       a caller matches one spelling of "the pipe is dead".
        let dead = consume_refusal("host stdio closed");
        assert!(
            dead.contains(TRANSPORT_CLOSED_TEXT),
            "the transport-dead case must reuse the peer's own text: {dead}"
        );
        assert!(
            !dead.starts_with("ESTALE") && !dead.starts_with("EUNSUPPORTED"),
            "⚠ a dead transport is not a file-level condition, so it gets no \
             file-level code: {dead}"
        );

        // All three must be distinct, which is the finding stated directly.
        assert_ne!(duplicate, poisoned);
        assert_ne!(duplicate, dead);
        assert_ne!(poisoned, dead);
    }

    #[test]
    fn a_dead_transport_keeps_the_peers_own_message_for_diagnostics() {
        // The peer's `write` error text must survive inside the message — the point
        // of the change is to add the transport marker, not to replace the detail.
        let refusal = consume_refusal("no transport attached");
        assert!(
            refusal.contains("no transport attached"),
            "the underlying failure must not be swallowed: {refusal}"
        );
    }

    #[test]
    fn transport_closed_text_matches_the_peer() {
        // ⚠ This is the tripwire for the duplicated literal. `kkrpc_peer::TRANSPORT_CLOSED`
        // is private to that module and this file may not edit it, so the coupling
        // cannot be expressed in code — a behaviour test is the next best thing.
        //
        // It drives the REAL `Peer::close_streams` path: a peer over an in-memory
        // writer whose reader hits EOF fails every registered consumer sink with
        // that literal. If the peer renames it, this goes red and the two move
        // together.
        //
        // The race is removed rather than tolerated: the reader blocks on a gate
        // until the consumer is registered, so `close_streams` cannot run before
        // there is something for it to fail. A flaky version of this test would be
        // worse than none — it would be "fixed" by loosening the assertion, which
        // is exactly how this coupling would rot.
        use crate::kkrpc_peer::{Peer, StreamSink};
        use std::sync::atomic::{AtomicBool, Ordering};

        /// A reader that returns EOF only once released.
        struct GateReader(Arc<AtomicBool>);
        impl Read for GateReader {
            fn read(&mut self, _out: &mut [u8]) -> std::io::Result<usize> {
                while !self.0.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(2));
                }
                Ok(0) // EOF
            }
        }

        /// Records the single `finish` outcome the peer hands it.
        struct OutcomeSink(Arc<std::sync::Mutex<Option<Result<(), String>>>>);
        impl StreamSink for OutcomeSink {
            fn write(&mut self, _bytes: &[u8]) -> Result<(), String> {
                Ok(())
            }
            fn finish(&mut self, outcome: Result<(), String>) {
                *self.0.lock().expect("outcome") = Some(outcome);
            }
        }

        let gate = Arc::new(AtomicBool::new(false));
        // A writer that accepts everything: the opening `pull` must succeed, or
        // the consumer is never registered and there is nothing to fail.
        let peer = Peer::new(std::io::sink());
        peer.start_reader(GateReader(Arc::clone(&gate)));

        let recorded = Arc::new(std::sync::Mutex::new(None));
        peer.consume_stream("s-eof", Box::new(OutcomeSink(Arc::clone(&recorded))))
            .expect("the opening pull must be written before EOF");

        // Let the reader reach EOF, which is what runs `close_streams`.
        gate.store(true, Ordering::SeqCst);

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while recorded.lock().expect("outcome").is_none() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        let settled = recorded
            .lock()
            .expect("outcome")
            .clone()
            .expect("a closed transport must fail the consumer sink");

        match settled {
            Err(message) => assert_eq!(
                message, TRANSPORT_CLOSED_TEXT,
                "⚠ `kkrpc_peer::close_streams` changed its text; this file's \
                 TRANSPORT_CLOSED_TEXT must move with it"
            ),
            Ok(()) => panic!("a closed transport must fail the consumer, not finish it cleanly"),
        }
    }

    #[test]
    fn a_transport_that_refuses_the_opening_pull_is_reported_as_transport_dead() {
        // The other half of finding 6(c), driven through the REAL peer rather than
        // a hand-written string: a writer that refuses everything makes
        // `consume_stream`'s opening `pull` fail, which is the transport-dead case.
        //
        // ⚠ It asserts OUR mapping on the REAL error text, so a change to what
        // `consume_stream` returns — which would silently re-route the case — is
        // caught here instead of in production.
        use crate::kkrpc_peer::{Peer, StreamSink};

        struct RefusingWriter;
        impl Write for RefusingWriter {
            fn write(&mut self, _data: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "pipe is gone",
                ))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "pipe is gone",
                ))
            }
        }

        struct SilentSink;
        impl StreamSink for SilentSink {
            fn write(&mut self, _bytes: &[u8]) -> Result<(), String> {
                Ok(())
            }
            fn finish(&mut self, _outcome: Result<(), String>) {}
        }

        let peer = Peer::new(RefusingWriter);
        let refusal = peer
            .consume_stream("s-dead", Box::new(SilentSink))
            .expect_err("a refusing transport must not register a consumer");

        let message = consume_refusal(&refusal);
        assert!(
            message.starts_with(TRANSPORT_CLOSED_TEXT),
            "the transport-dead case must be reported as the transport being dead, \
             got: {message}"
        );
        assert!(
            !message.starts_with("ESTALE"),
            "⚠ ESTALE is the bug: it makes `isStale` true for a dead pipe"
        );
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
    fn a_path_that_runs_through_a_file_reports_not_a_directory() {
        // ⚠ THE REGRESSION for finding 1. The shape is a non-directory named
        // THROUGH a trailing separator — `<dir>/a.txt/` — and it is `ENOTDIR` on
        // both platforms:
        //
        //   - Windows: `ERROR_DIRECTORY` (267), which std surfaces as
        //     `ErrorKind::NotADirectory` (measured).
        //   - Linux/macOS: raw `ENOTDIR` — `ErrorKind::Other` carrying the errno,
        //     which is why `classify_errno` reads it.
        //
        // Before the fix BOTH reached the catch-all and were encoded as `EACCES`,
        // so `stat` told the caller "permission denied" about a path where
        // permissions were never involved, and `list` said the same through a
        // different route.
        //
        // ⚠ THE FINDING'S OWN EXAMPLE WAS WRONG, and the correction is recorded
        // here because the test would otherwise have been written against it.
        // It claimed `<dir>/a.txt/child` returns `null` on Windows and `ENOTDIR` on
        // Linux. Measured on Windows (rustc 1.97): that exact path gives
        // `NotFound` / raw 3 (`ERROR_PATH_NOT_FOUND`) — the SAME disposition as
        // Linux only in the sense that both fail, but with a different code, and
        // Windows reports `ENOENT` because the intermediate component is not a
        // directory. `ERROR_DIRECTORY` is produced by the trailing-separator and
        // `read_dir`-on-a-file shapes instead (measured: `read_dir(file)` also
        // gives 267). The trailing-separator form is used below because it yields
        // `ENOTDIR` on EVERY platform, which is what makes this a portable
        // regression test rather than a Windows-only or Unix-only one.
        let dir = temp_dir("classify-notdir");
        let file = dir.join("a.txt");
        std::fs::write(&file, b"x").expect("write");
        // A trailing separator on a path that is a FILE, not a directory.
        let through = format!("{}{}", file.display(), std::path::MAIN_SEPARATOR);

        let error = stat_path(&through).expect_err("a file named as a directory must fail");
        let code = classify(&error);
        std::fs::remove_dir_all(&dir).ok();

        assert_eq!(
            code,
            Code::NotDir,
            "expected ENOTDIR for a file named as a directory, got {} ({error})",
            code.as_str()
        );
        assert_ne!(
            code,
            Code::Denied,
            "⚠ EACCES is the bug: it tells the caller to fix permissions, and no \
             permission was ever involved"
        );
    }

    #[test]
    fn listing_through_a_file_reports_not_a_directory() {
        // The same shape through the `list` path, which is what a caller hits when
        // it guesses "dir" and is wrong. `DirectoryReader::open` already guards on
        // `is_dir()` and returns `ENOTDIR` — this pins that the guard still fires
        // now that `classify` also produces `NotDir`, so the two cannot drift into
        // agreeing by accident.
        let dir = temp_dir("classify-notdir-list");
        let file = dir.join("a.txt");
        std::fs::write(&file, b"x").expect("write");

        let error = match DirectoryReader::open(file.to_str().unwrap(), 8) {
            Ok(_) => panic!("listing a file must not succeed"),
            Err(error) => error,
        };
        std::fs::remove_dir_all(&dir).ok();
        assert!(error.starts_with("ENOTDIR"), "got: {error}");
    }

    #[test]
    fn a_failure_nobody_classified_is_reported_as_unsupported_not_denied() {
        // ⚠ The catch-all itself is the finding. It used to be `Denied`, so ANY
        // errno the match did not name was reported to the caller as "access
        // denied" — a claim about authorisation that nothing had established.
        //
        // An unclassified error is constructed directly (an `io::Error` with a
        // kind nothing maps and no raw OS code), because the whole point is the
        // arm no real call reaches predictably. `Unsupported` is the honest
        // answer and is already in the wire contract; `Denied` is a fabrication.
        let error = std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "torn off");
        assert_eq!(
            classify(&error),
            Code::Unsupported,
            "an unmapped error must not be reported as a permission problem"
        );
    }

    #[test]
    fn the_named_errno_kinds_no_longer_collapse_into_eacces() {
        // Each of these was `EACCES` before the fix. They are asserted through
        // `classify` (not through a real filesystem call) because several are
        // awkward or impossible to produce portably, and the mapping IS the fix.
        use std::io::ErrorKind;
        let cases = [
            (ErrorKind::NotADirectory, Code::NotDir),
            (ErrorKind::InvalidInput, Code::Invalid),
            (ErrorKind::AlreadyExists, Code::Exists),
            (ErrorKind::Interrupted, Code::Interrupted),
        ];
        for (kind, expected) in cases {
            let error = std::io::Error::new(kind, "synthetic");
            let got = classify(&error);
            assert_eq!(
                got,
                expected,
                "{kind:?} must map to {}, not {}",
                expected.as_str(),
                got.as_str()
            );
            assert_ne!(got, Code::Denied, "{kind:?} is not a permission failure");
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_errno_that_share_a_kind_are_told_apart() {
        // ⚠ The reason `classify_errno` exists. On Unix `ELOOP` and
        // `ENAMETOOLONG` both arrive as `ErrorKind::InvalidInput`, so the kind
        // match alone cannot separate them from `EINVAL` — the raw errno is the
        // only distinguishing signal. All of these used to fall into the catch-all
        // and be reported as `EACCES`.
        //
        // Each case pins its EXACT code, not merely "not EACCES": `ENOTDIR` in
        // particular must be `NotDir` (its own fix), while the path-limit pair
        // shares `Invalid` because their fix ("shorten it / break the loop") is the
        // same. Asserting only "not denied" would pass if all three collapsed into
        // one wrong-but-not-EACCES code.
        for (errno, expected, name) in [
            (libc::ENOTDIR, Code::NotDir, "ENOTDIR"),
            (libc::ELOOP, Code::Invalid, "ELOOP"),
            (libc::ENAMETOOLONG, Code::Invalid, "ENAMETOOLONG"),
        ] {
            let error = std::io::Error::from_raw_os_error(errno);
            let got = classify(&error);
            assert_eq!(
                got,
                expected,
                "{name} (errno {errno}) must map to {}, got {}",
                expected.as_str(),
                got.as_str()
            );
            assert_ne!(
                got,
                Code::Denied,
                "⚠ {name} must not be reported as a permission failure"
            );
        }
    }

    #[test]
    fn a_windows_directory_opened_for_writing_stays_a_permission_error() {
        // ⚠ The ONE case the original catch-all's special case was right about, and
        // it must survive the rewrite. Measured on Windows:
        // `OpenOptions::write(true).create(true).open(dir)` → `PermissionDenied`
        // with raw 5, which is genuinely "you may not write here" — `EACCES` is the
        // correct disposition even though the path is a directory.
        //
        // `EISDIR` would also be defensible, and `FileWriter::open` refuses that
        // separately before ever opening. What must NOT happen is the code becoming
        // `EUNSUPPORTED` just because the error's kind is unremarkable.
        #[cfg(windows)]
        {
            let dir = temp_dir("classify-write-dir");
            // `.truncate(false)` is explicit because clippy is right that
            // `create(true)` alone does not say what happens to existing content.
            // Here the open is EXPECTED TO FAIL on a directory, so neither choice
            // could ever act on a file — but stating it keeps the intent readable
            // and the lint meaningful rather than silenced.
            let error = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(false)
                .open(&dir)
                .expect_err("a directory cannot be opened for writing");
            let code = classify(&error);
            std::fs::remove_dir_all(&dir).ok();
            assert_eq!(
                code,
                Code::Denied,
                "a directory opened for writing is a permission answer, got {}",
                code.as_str()
            );
        }
        // On Unix the same call also fails with EACCES-shaped permission denial or
        // EISDIR depending on the mode bits, and `FileWriter::open` refuses it
        // before reaching `classify` — so this asserts only the Windows branch
        // rather than inventing a Unix expectation that the write path never sees.
    }

    #[test]
    fn every_code_has_a_distinct_wire_prefix() {
        // ⚠ The code set is what a caller BRANCHES on, so two variants sharing a
        // prefix would be a silent mis-branch rather than a compile error. This
        // pins that adding the new codes did not collide with an existing one.
        let all = [
            Code::NotFound,
            Code::Denied,
            Code::IsDir,
            Code::NotDir,
            Code::Stale,
            Code::NoSpace,
            Code::Unsupported,
            Code::Invalid,
            Code::Exists,
            Code::Interrupted,
            Code::Internal,
        ];
        let mut seen: Vec<&'static str> = Vec::new();
        for code in all {
            assert!(
                !seen.contains(&code.as_str()),
                "{} is produced by two variants",
                code.as_str()
            );
            seen.push(code.as_str());
        }
        assert_eq!(seen.len(), all.len());
    }

    #[test]
    fn a_directory_read_is_reported_as_eisdir_not_as_a_generic_failure() {
        let dir = temp_dir("read-dir");
        let error = failure(FileReader::open(dir.to_str().unwrap(), 0));
        std::fs::remove_dir_all(&dir).ok();
        assert!(error.starts_with("EISDIR"), "got: {error}");
    }
}
