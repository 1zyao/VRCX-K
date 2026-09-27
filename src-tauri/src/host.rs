use crate::host_lifecycle::{
    reduce_command, HostCommand, HostCommandResult, HostDesiredState, HostLifecycleFacade,
    HostLifecycleState, HostSnapshot,
};
use crate::kkrpc_peer::Peer;
use crate::process_tree::ProcessTree;
use crate::shell_sys::register_shell_handlers;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

pub const HOST_RESTART_EXIT: i32 = 51;

/// The host gave up because the shell became unreachable mid-handshake.
///
/// The host discovered the shell was gone from the SENDING side (a write failed
/// with EPIPE) rather than from the read side that `onClose` watches, and tore
/// down cooperatively. See `host/src/api.ts`'s `HOST_STDIO_LOST_EXIT` for why
/// neither 0 nor 1 is acceptable here; the reason the code exists at all is that
/// `classify_watch` would otherwise bill this to the restart-storm budget and
/// park the host in `Failed` after eight occurrences inside the stable window.
///
/// The parity test at the bottom of this file asserts the value matches the
/// host's constant, so the two sides cannot drift apart silently.
pub const HOST_STDIO_LOST_EXIT: i32 = 52;

/// Why a spawn attempt failed to produce a ready host.
///
/// A plain `String` was not enough once the host gained a second, non-fault
/// exit: the supervisor must charge a STARTUP failure to the storm budget but
/// must NOT charge a shell-lost teardown, and string-matching an exit code
/// through a formatted message is exactly the kind of coupling that breaks
/// silently when someone rewords the message.
enum SpawnFailure {
    /// A real startup fault (bind failure, no `ready`, bad ping). Retryable, and
    /// it accumulates toward the storm cap.
    Retry(String),
    /// The host exited `HOST_STDIO_LOST_EXIT`: it lost the shell mid-handshake
    /// and stopped itself cleanly. Not the host's fault, so it is relaunched
    /// immediately and never billed to the storm budget.
    StdioLost,
}

impl std::fmt::Display for SpawnFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SpawnFailure::Retry(reason) => write!(f, "{reason}"),
            SpawnFailure::StdioLost => write!(
                f,
                "host exited {HOST_STDIO_LOST_EXIT} (shell lost mid-handshake)"
            ),
        }
    }
}

impl From<String> for SpawnFailure {
    fn from(reason: String) -> Self {
        SpawnFailure::Retry(reason)
    }
}

impl From<&str> for SpawnFailure {
    fn from(reason: &str) -> Self {
        SpawnFailure::Retry(reason.to_string())
    }
}

///
/// The host discovered the shell was gone from the SENDING side (a write failed
/// with EPIPE) rather than from the read side that `onClose` watches, and tore
/// down cooperatively. See `host/src/api.ts`'s `HOST_STDIO_LOST_EXIT` for why
/// neither 0 nor 1 is acceptable here; the reason it exists at all is that
/// `classify_watch` would otherwise bill this to the restart-storm budget and
/// park the host in `Failed` after eight occurrences inside the stable window.
///
/// The parity test at the bottom of this file asserts the value matches the
/// host's constant, so the two sides cannot drift apart silently.
// A cooperative stop is allowed to take time while the host remains responsive.
// This is also the watchdog budget: it starts when the stop request is sent,
// is shared by the RPC wait and child-exit wait, and ends by killing the process
// tree. A user-initiated force kill takes a separate immediate path.
const STOP_TIMEOUT: Duration = Duration::from_secs(30);
// Leaves a small response-frame margin inside the shared 30s watchdog budget.
const STOP_RPC_TIMEOUT: Duration = Duration::from_secs(28);
const MAX_SPAWN_FAILURES: u32 = 8;
const INITIAL_BACKOFF: Duration = Duration::from_millis(500);
const MAX_BACKOFF: Duration = Duration::from_secs(8);
// A freshly ready host must stay up this long before its crash/restart streak
// is forgiven. Rapid ready→exit loops (crash or exit 51) inside this window
// therefore accumulate toward the storm cap instead of resetting forever.
const STABLE_WINDOW: Duration = Duration::from_secs(30);

/// Tunable crash/restart storm policy.
///
/// Production defaults (`StormPolicy::default()`):
/// - `stable_window`: 30s — a host that reaches Ready must stay up this long
///   before its crash/restart streak is forgiven;
/// - `initial_backoff` / `max_backoff`: 500ms .. 8s — exponential backoff
///   between respawn attempts inside a storm;
/// - `max_failures`: 8 — after this many windowed exits the supervisor parks
///   in `Failed` until an explicit Start/Restart.
///
/// Tests may construct a HostState with a compressed policy (short window,
/// small backoff, lower cap) so the storm paths are exercised without
/// multi-second sleeps. This is a configuration surface, not a test-only
/// backdoor: operators could tune the same values later.
#[derive(Clone, Copy, Debug)]
struct StormPolicy {
    stable_window: Duration,
    initial_backoff: Duration,
    max_backoff: Duration,
    max_failures: u32,
}

impl Default for StormPolicy {
    fn default() -> Self {
        Self {
            stable_window: STABLE_WINDOW,
            initial_backoff: INITIAL_BACKOFF,
            max_backoff: MAX_BACKOFF,
            max_failures: MAX_SPAWN_FAILURES,
        }
    }
}

// `HostReady` is the versioned handshake contract — see `host_ready.rs` and
// `contracts/host-ready/v1/host-ready.schema.json`. It is re-exported here
// because this module owns the spawn path that produces it.
pub use crate::host_ready::HostReady;

#[cfg(test)]
pub struct HostSession {
    pub tree: ProcessTree,
    pub peer: Arc<Peer>,
    pub ready: HostReady,
}

struct HostInner {
    generation: u64,
    command_epoch: u64,
    stopping: bool,
    tree: Option<ProcessTree>,
    peer: Option<Arc<Peer>>,
    ready: Option<HostReady>,
    lifecycle: HostSnapshot,
    fail_streak: u32,
    backoff: Duration,
    /// When the current generation reached Ready; used to decide whether an
    /// exit happened inside the stable window (streak not forgiven) or after
    /// it (streak forgiven). Cleared on adopt, set on promote_ready.
    ready_at: Option<Instant>,
    /// Whether the bridge-reader failure of THIS generation has already been
    /// recorded into the snapshot.
    ///
    /// The peer's `link_failure()` is monotonic (the first failure wins), so a
    /// poll without this latch would rewrite `last_error` every 30 ms forever.
    /// Reset with the rest of the generation in `clear()`.
    bridge_failure_recorded: bool,
}

impl HostInner {
    fn clear(&mut self) {
        self.tree = None;
        self.peer = None;
        self.ready = None;
        // The child is gone: a snapshot must never advertise a dead pid/port.
        self.lifecycle.pid = None;
        self.lifecycle.port = None;
        // Per-generation: the next generation's reader thread must be able to
        // record its OWN failure, so the latch cannot outlive the peer it describes.
        self.bridge_failure_recorded = false;
    }
}

impl Default for HostInner {
    fn default() -> Self {
        Self {
            generation: 0,
            command_epoch: 0,
            stopping: false,
            tree: None,
            peer: None,
            ready: None,
            lifecycle: HostSnapshot::new(),
            fail_streak: 0,
            backoff: INITIAL_BACKOFF,
            ready_at: None,
            bridge_failure_recorded: false,
        }
    }
}

/// Single source of truth for host process state and the command bus that
/// drives the supervisor.
///
/// # Threading model
/// `dispatch()` runs on the caller thread (Tauri IPC, tray router). It never
/// blocks on process I/O: it reduces the command against the public snapshot,
/// fences `stopping`, and enqueues the command on a channel. The dedicated
/// supervisor thread (see `supervise_loop`) is the *only* thread that spawns,
/// stops, force-kills or reloads the host, so commands are serialized and a
/// double-spawn race is impossible by construction. Generation is still
/// allocated only after a real `Command::spawn` succeeds (see
/// `spawn_host_into`); stop/force only advance the internal command epoch.
pub struct HostState {
    inner: Mutex<HostInner>,
    /// Commands accepted by `dispatch` are delivered here. `supervise_loop`
    /// takes the receiver exactly once; senders may be cloned freely.
    command_tx: Sender<HostCommand>,
    command_rx: Mutex<Option<Receiver<HostCommand>>>,
    storm: StormPolicy,
}

impl Default for HostState {
    fn default() -> Self {
        Self::with_storm_policy(StormPolicy::default())
    }
}

impl HostState {
    /// Build a state with a custom storm policy. Production uses the default;
    /// tests compress the window/backoff/cap so storm paths run quickly.
    fn with_storm_policy(storm: StormPolicy) -> Self {
        let (command_tx, rx) = channel();
        let inner = HostInner {
            backoff: storm.initial_backoff,
            ..HostInner::default()
        };
        Self {
            inner: Mutex::new(inner),
            command_tx,
            command_rx: Mutex::new(Some(rx)),
            storm,
        }
    }

    fn take_command_rx(&self) -> Option<Receiver<HostCommand>> {
        self.command_rx.lock().expect("host rx").take()
    }

    fn command_tx(&self) -> Sender<HostCommand> {
        self.command_tx.clone()
    }

    fn wants_running(&self) -> bool {
        let inner = self.inner.lock().expect("host");
        inner.lifecycle.desired == HostDesiredState::Running && !inner.stopping
    }

    fn desired(&self) -> HostDesiredState {
        self.inner.lock().expect("host").lifecycle.desired
    }
}

impl HostLifecycleFacade for HostState {
    fn snapshot(&self) -> HostSnapshot {
        self.lifecycle_snapshot()
    }

    fn dispatch(&self, command: HostCommand) -> HostCommandResult {
        HostState::dispatch(self, command)
    }
}

impl HostState {
    pub fn snapshot(&self) -> Option<HostReady> {
        self.inner.lock().expect("host").ready.clone()
    }

    pub fn lifecycle_snapshot(&self) -> HostSnapshot {
        self.inner.lock().expect("host").lifecycle.clone()
    }

    /// Accept a host lifecycle command and hand it to the supervisor.
    ///
    /// This is the stable entry point used by the Tauri IPC command
    /// (`dispatch_host_command`) and, through the `HostLifecycleFacade`
    /// trait, by the #6 tray router. The returned `HostCommandResult` is the
    /// *synchronous* reducer verdict (Accepted/Noop/Rejected) against the
    /// current snapshot; Accepted additionally fences `stopping` and wakes the
    /// supervisor, which performs the real process orchestration off-thread.
    pub fn dispatch(&self, command: HostCommand) -> HostCommandResult {
        let mut inner = self.inner.lock().expect("host");
        let result = reduce_command(&mut inner.lifecycle, command);
        if matches!(result, HostCommandResult::Accepted { .. }) {
            // Fence the supervisor against the previous intent before the
            // worker observes the command. Only Start/Restart clear stopping;
            // stop/force latch it so the watch loop aborts and cannot relaunch.
            match command {
                HostCommand::Start | HostCommand::Restart => {
                    inner.stopping = false;
                    // A user-intended start resets the crash storm bookkeeping
                    // so a Failed host can recover without a full app restart.
                    inner.fail_streak = 0;
                    inner.backoff = self.storm.initial_backoff;
                    inner.lifecycle.next_retry_ms = None;
                }
                HostCommand::GracefulStop | HostCommand::ForceKill => inner.stopping = true,
                HostCommand::Reload => {}
            }
            inner.command_epoch = inner.command_epoch.wrapping_add(1);
            if let Err(err) = self.command_tx().send(command) {
                eprintln!("[shell] supervisor unavailable, command dropped: {err:?}");
            }
        }
        result
    }

    pub fn is_stopping(&self) -> bool {
        self.inner.lock().expect("host").stopping
    }

    #[cfg(test)]
    pub fn child_id(&self) -> Option<u32> {
        self.inner
            .lock()
            .expect("host")
            .tree
            .as_ref()
            .map(ProcessTree::id)
    }

    pub fn peer(&self) -> Option<Arc<Peer>> {
        self.inner.lock().expect("host").peer.clone()
    }

    /// True while a host process is adopted (Starting or Ready).
    fn has_child(&self) -> bool {
        self.inner.lock().expect("host").tree.is_some()
    }

    /// Supervisor-only force kill after dispatch latched `Stopped`. Kills and
    /// reaps the whole process tree; the host must not be relaunched.
    fn force_kill_stopped(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().expect("host");
        if inner.tree.is_none() {
            return Ok(());
        }
        inner.peer = None;
        inner.ready = None;
        inner.lifecycle.phase = HostLifecycleState::Stopping;
        inner.lifecycle.last_exit = None;
        let tree = inner.tree.take();
        drop(inner);
        let mut tree = tree.ok_or("host process tree vanished")?;
        tree.kill_tree();
        self.finish_stopped();
        Ok(())
    }

    /// Reset crash/backoff state for a user-intended start or restart.
    fn reset_storm_state(&self) {
        let mut inner = self.inner.lock().expect("host");
        inner.fail_streak = 0;
        inner.backoff = self.storm.initial_backoff;
        inner.lifecycle.attempt = 0;
        inner.lifecycle.next_retry_ms = None;
    }

    /// The current generation reached Ready and has run for at least the
    /// stable window, so its next exit is treated as a fresh incident rather
    /// than part of a storm.
    fn exited_stably(&self) -> bool {
        let inner = self.inner.lock().expect("host");
        match inner.ready_at {
            Some(since) => since.elapsed() >= self.storm.stable_window,
            // No ready this generation (e.g. spawn failure): never stable.
            None => false,
        }
    }

    /// Account for a child exit on the supervisor thread.
    ///
    /// - Exits after the stable window forgive the previous streak first
    ///   (crash restarts counting from one; a cooperative exit-51 restart is
    ///   a legitimate request and does not count at all).
    /// - Exits inside the window (crash *or* exit 51) accumulate the streak,
    ///   so rapid ready→exit loops hit the storm cap instead of looping
    ///   forever.
    ///
    /// Returns true when the caller must back off before respawning.
    fn note_exit(&self, is_restart_request: bool) -> bool {
        let stable = self.exited_stably();
        let mut inner = self.inner.lock().expect("host");
        if stable {
            inner.fail_streak = 0;
            inner.backoff = self.storm.initial_backoff;
        }
        if is_restart_request {
            if stable {
                // Legitimate cooperative reload after stable runtime: the
                // host asked to restart; relaunch immediately, no penalty.
                inner.lifecycle.attempt = 0;
                inner.lifecycle.next_retry_ms = None;
                return false;
            }
            // Restart storm inside the window is treated like a crash loop.
            inner.fail_streak = inner.fail_streak.saturating_add(1);
            inner.lifecycle.attempt = inner.fail_streak;
            return true;
        }
        inner.fail_streak = inner.fail_streak.saturating_add(1);
        inner.lifecycle.attempt = inner.fail_streak;
        true
    }

    fn mark_failed(&self) {
        let mut inner = self.inner.lock().expect("host");
        inner.lifecycle.phase = HostLifecycleState::Failed;
        inner.lifecycle.next_retry_ms = None;
        inner.lifecycle.pid = None;
        inner.lifecycle.port = None;
        inner.lifecycle.last_error = Some("host restart storm cap reached".into());
    }

    /// Record why a spawn attempt failed, so the reason reaches the SNAPSHOT.
    ///
    /// Before this existed the cause lived only in `eprintln!` output: the tray
    /// and the UI showed `phase: backoff`/`failed` with a `lastError` that was
    /// either `None` or the generic storm-cap message. That is how a rejected
    /// `ready` handshake surfaced as the misleading "host did not call ready()
    /// within 10s" — the shell knew the host HAD called ready and had been
    /// refused, but that knowledge never left stderr.
    ///
    /// Kept separate from `mark_failed` because the two carry different text and
    /// sit on different paths: this records the informative FIRST failure of a
    /// streak, while `mark_failed` records the terminal giving-up state.
    fn record_spawn_error(&self, reason: &str) {
        let mut inner = self.inner.lock().expect("host");
        // Clamp to the schema's `lastError` maxLength so a long message cannot
        // produce a snapshot the contract's own guard would reject.
        inner.lifecycle.last_error = Some(reason.chars().take(4096).collect());
    }

    /// Restore the running intent after a Restart command stopped the current
    /// generation (dispatch already reduced phase=Starting, desired=Running;
    /// the stop helper temporarily latched Stopped/Stopping over it).
    fn resume_running(&self) {
        let mut inner = self.inner.lock().expect("host");
        inner.stopping = false;
        inner.lifecycle.desired = HostDesiredState::Running;
        // dispatch(Restart) reduced phase=Starting; the stop helpers may have
        // overwritten it with Stopping/Stopped, so restore the reduced phase.
        inner.lifecycle.phase = HostLifecycleState::Starting;
    }

    fn bump_streak(&self) {
        let mut inner = self.inner.lock().expect("host");
        inner.fail_streak = inner.fail_streak.saturating_add(1);
        inner.lifecycle.attempt = inner.fail_streak;
    }

    fn double_backoff(&self) {
        let mut inner = self.inner.lock().expect("host");
        inner.backoff = inner.backoff.saturating_mul(2).min(self.storm.max_backoff);
        inner.lifecycle.next_retry_ms = Some(inner.backoff.as_millis() as u64);
    }

    fn streak_capped(&self) -> bool {
        let inner = self.inner.lock().expect("host");
        inner.fail_streak >= self.storm.max_failures
    }

    fn fail_streak(&self) -> u32 {
        self.inner.lock().expect("host").fail_streak
    }

    fn backoff(&self) -> Duration {
        self.inner.lock().expect("host").backoff
    }

    /// Supervisor-only host-cooperative reload: tell a Ready host to tear down
    /// and exit 51. The running segment then spawns the next generation.
    ///
    /// This is fire-and-forget on purpose: the supervisor thread must keep
    /// polling the child (`try_wait`) and servicing commands while the host
    /// runs its up-to-25s graceful teardown. The restart outcome is observed
    /// through the child's exit status (`WatchOutcome::RestartRequested`), not
    /// through this RPC's response.
    fn host_reload(&self) {
        let Some(peer) = self.peer() else {
            let mut inner = self.inner.lock().expect("host");
            inner.lifecycle.last_error = Some("reload requested without a ready host".into());
            return;
        };
        if let Err(err) = peer.notify("restart", vec![]) {
            let mut inner = self.inner.lock().expect("host");
            inner.lifecycle.last_error = Some(format!("host reload request failed: {err}"));
        }
    }

    /// Latch a terminal desired state (`Stopped`/`AppExit`) and fence the
    /// current command epoch. Process teardown is performed by the caller.
    fn latch_desired(&self, desired: crate::host_lifecycle::HostDesiredState) {
        let mut inner = self.inner.lock().expect("host");
        inner.stopping = true;
        inner.command_epoch = inner.command_epoch.wrapping_add(1);
        inner.lifecycle.phase = HostLifecycleState::Stopping;
        inner.lifecycle.desired = desired;
    }

    pub fn latch_app_exit(&self) {
        self.latch_desired(crate::host_lifecycle::HostDesiredState::AppExit);
    }

    #[cfg(test)]
    pub fn request_stop(&self) {
        self.request_stop_with_timeout(STOP_TIMEOUT);
    }

    pub fn request_app_exit_graceful(&self) {
        self.request_stop_with_desired(
            STOP_TIMEOUT,
            crate::host_lifecycle::HostDesiredState::AppExit,
        );
    }

    /// Cooperative stop of the current host generation: latch `Stopped`, call
    /// the `stop` RPC, wait for child exit within `timeout`, then kill the
    /// process tree if the deadline expires. The host is not relaunched.
    pub fn request_stop_with_timeout(&self, timeout: Duration) {
        self.request_stop_with_desired(timeout, crate::host_lifecycle::HostDesiredState::Stopped);
    }

    fn request_stop_with_desired(
        &self,
        timeout: Duration,
        desired: crate::host_lifecycle::HostDesiredState,
    ) {
        // Start one watchdog before writing the RPC. A wedged host must not
        // receive a fresh child-exit wait after consuming the RPC timeout.
        let deadline = Instant::now() + timeout;
        self.latch_desired(desired);
        let peer = self.inner.lock().expect("host").peer.clone();
        if let Some(peer) = peer {
            let _ = peer.call_timeout("stop", vec![], stop_rpc_timeout(deadline));
        }
        while Instant::now() < deadline {
            let child_gone = {
                let mut inner = self.inner.lock().expect("host");
                match inner.tree.as_mut() {
                    None => true,
                    Some(tree) => matches!(tree.try_wait(), Ok(Some(_))),
                }
            };
            if child_gone {
                // Take the tree out under the lock and drop it outside: its
                // Drop kills the process tree, which must not run while the
                // state lock is held (dispatch callers would block on it).
                let tree = {
                    let mut inner = self.inner.lock().expect("host");
                    inner.peer = None;
                    inner.ready = None;
                    inner.lifecycle.pid = None;
                    inner.lifecycle.port = None;
                    inner.tree.take()
                };
                drop(tree);
                self.finish_stopped();
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        self.reap_tree();
        self.finish_stopped();
    }

    /// Record a completed stop in the public snapshot (child already cleared).
    /// The desired state stays whatever the stop latched (Stopped/AppExit).
    fn finish_stopped(&self) {
        let mut inner = self.inner.lock().expect("host");
        inner.lifecycle.phase = HostLifecycleState::Stopped;
        inner.lifecycle.pid = None;
        inner.lifecycle.port = None;
        inner.lifecycle.next_retry_ms = None;
    }

    #[cfg(test)]
    pub fn force_kill_running(&self) {
        let mut inner = self.inner.lock().expect("host");
        if let Some(tree) = inner.tree.as_mut() {
            tree.kill_tree();
        }
    }

    pub fn force_app_exit(&self) {
        self.latch_app_exit();
        self.reap_tree();
    }

    fn reap_tree(&self) {
        let mut tree = {
            let mut inner = self.inner.lock().expect("host");
            inner.peer = None;
            inner.ready = None;
            inner.lifecycle.pid = None;
            inner.lifecycle.port = None;
            inner.tree.take()
        };
        if let Some(tree) = tree.as_mut() {
            tree.kill_tree();
        }
    }

    fn adopt_inflight(
        &self,
        generation: u64,
        tree: ProcessTree,
        peer: Arc<Peer>,
    ) -> Result<(), ProcessTree> {
        let mut inner = self.inner.lock().expect("host");
        if inner.stopping || inner.generation != generation {
            return Err(tree);
        }
        inner.tree = Some(tree);
        inner.peer = Some(peer);
        inner.ready = None;
        inner.ready_at = None;
        inner.lifecycle.generation = generation;
        inner.lifecycle.phase = HostLifecycleState::Starting;
        inner.lifecycle.pid = inner.tree.as_ref().map(ProcessTree::id);
        Ok(())
    }

    fn promote_ready(&self, generation: u64, ready: HostReady) -> Result<HostReady, ()> {
        let mut inner = self.inner.lock().expect("host");
        if inner.stopping || inner.generation != generation || inner.tree.is_none() {
            return Err(());
        }
        inner.ready = Some(ready.clone());
        inner.ready_at = Some(Instant::now());
        inner.lifecycle.phase = HostLifecycleState::Ready;
        inner.lifecycle.pid = inner.tree.as_ref().map(ProcessTree::id);
        inner.lifecycle.port = Some(ready.port);
        inner.lifecycle.last_error = None;
        // A backoff delay is only meaningful while backing off; a ready host
        // must not advertise a pending retry (see HostSnapshot::next_retry_ms).
        inner.lifecycle.next_retry_ms = None;
        Ok(ready)
    }

    fn still_current(&self, generation: u64) -> bool {
        let inner = self.inner.lock().expect("host");
        !inner.stopping && inner.generation == generation
    }
}

fn stop_rpc_timeout(deadline: Instant) -> Duration {
    STOP_RPC_TIMEOUT.min(deadline.saturating_duration_since(Instant::now()))
}

/// Snapshot change feed consumed by the shell surfaces (tray projection and
/// the `host-lifecycle` event). Implementations must be cheap and idempotent:
/// the supervisor calls this on every observable transition, and the consumer
/// is responsible for caching so identical snapshots do not cause work.
pub type SnapshotObserver<'a> = &'a mut dyn FnMut(&HostSnapshot);

pub fn supervise_loop(
    state: &HostState,
    app: Option<&AppHandle>,
    mut on_ready: impl FnMut(HostReady),
    on_snapshot: SnapshotObserver<'_>,
) {
    let Some(rx) = state.take_command_rx() else {
        eprintln!("[shell] supervisor already bound to this HostState");
        return;
    };
    // Initial intent follows the snapshot default (Running): a fresh
    // HostState starts the host automatically, preserving legacy behavior.
    loop {
        on_snapshot(&state.lifecycle_snapshot());
        if state.desired() == HostDesiredState::AppExit {
            return;
        }
        // Non-blocking drain so a Start arriving while we were deciding does
        // not wait for the next spawn/watch cycle boundary.
        while let Ok(command) = rx.try_recv() {
            if supervise_command(state, command) {
                return;
            }
        }
        if state.wants_running() && !state.streak_capped() {
            run_running_segment(state, app, &mut on_ready, on_snapshot, &rx);
        } else {
            // Stopped, AppExit, or a capped storm (persistent Failed): park
            // until an explicit Start/Restart command resets the streak.
            wait_for_start(state, &rx);
        }
    }
}

/// Block until a Start/Restart arrives (or the app exits). The only commands
/// valid while the host is not running are Start and Restart; the reducer
/// rejects the rest, and Reload only targets a Ready host.
fn wait_for_start(state: &HostState, rx: &Receiver<HostCommand>) {
    loop {
        if state.desired() == HostDesiredState::AppExit {
            return;
        }
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(HostCommand::Start | HostCommand::Restart) => return,
            Ok(_) => {
                // Reducer rejected it; ignore stragglers from a racing caller.
            }
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

/// Execute a single command from the supervisor thread. Returns `true` when
/// the supervisor must exit (app exit latched while executing a command).
fn supervise_command(state: &HostState, command: HostCommand) -> bool {
    match command {
        HostCommand::Start => {
            // Already fenced in dispatch; just (re)enter the running segment.
            state.reset_storm_state();
        }
        HostCommand::GracefulStop => {
            state.request_stop_with_timeout(STOP_TIMEOUT);
        }
        HostCommand::ForceKill => {
            // The reducer latched Stopped; kill and reap immediately. This is
            // "end the host", not a simulated crash: no automatic relaunch.
            let _ = state.force_kill_stopped();
        }
        HostCommand::Restart => {
            state.reset_storm_state();
            // Stop the current generation first (RPC stop with deadline, then
            // kill tree on timeout), then let the loop respawn: this is the
            // shell-guaranteed restart even if the host wedges.
            if state.has_child() {
                state.request_stop_with_timeout(STOP_TIMEOUT);
            }
            // The stop helper latched Stopped over the reducer's Running
            // intent; restore it so the loop re-enters the running segment.
            state.resume_running();
        }
        HostCommand::Reload => {
            // Host-cooperative full reload: the host tears down and exits 51;
            // the running segment observes RestartRequested and relaunches.
            state.host_reload();
        }
    }
    state.desired() == HostDesiredState::AppExit
}

fn run_running_segment(
    state: &HostState,
    app: Option<&AppHandle>,
    on_ready: &mut impl FnMut(HostReady),
    on_snapshot: SnapshotObserver<'_>,
    rx: &Receiver<HostCommand>,
) {
    run_running_segment_inner(state, app, on_ready, on_snapshot, rx);
    // Every exit from the segment is a lifecycle transition (Stopped/Failed/
    // Backoff); publish it once the segment settles.
    on_snapshot(&state.lifecycle_snapshot());
}

fn run_running_segment_inner(
    state: &HostState,
    app: Option<&AppHandle>,
    on_ready: &mut impl FnMut(HostReady),
    on_snapshot: SnapshotObserver<'_>,
    rx: &Receiver<HostCommand>,
) {
    // Spawn/watch until a stop intent or storm cap ends this running segment.
    // Crash streak and backoff live on HostInner so dispatch-side commands and
    // the running segment observe one source of truth.
    loop {
        // Keep servicing commands even between spawn attempts so e.g. a
        // ForceKill during backoff is honored without waiting out the sleep.
        if let Ok(command) = rx.try_recv() {
            match command {
                HostCommand::GracefulStop => {
                    state.request_stop_with_timeout(STOP_TIMEOUT);
                    return;
                }
                HostCommand::ForceKill => {
                    let _ = state.force_kill_stopped();
                    return;
                }
                HostCommand::Start | HostCommand::Restart => {
                    state.reset_storm_state();
                }
                HostCommand::Reload => state.host_reload(),
            }
        }
        if !state.wants_running() {
            return;
        }
        if state.streak_capped() {
            state.mark_failed();
            return;
        }
        match spawn_host_into(state, app) {
            Ok(ready) => {
                eprintln!(
                    "[shell] host ready port={} token_len={}",
                    ready.port,
                    ready.token.len()
                );
                on_ready(ready);
                // Ready is the most user-visible transition (it enables
                // host.reload and disables host.start): publish immediately.
                on_snapshot(&state.lifecycle_snapshot());
                match watch_until_exit(state, rx) {
                    WatchOutcome::Stopped => return,
                    WatchOutcome::Crashed(status) => {
                        // A crash inside the stable window keeps accumulating;
                        // after the window the streak is forgiven first.
                        let needs_backoff = state.note_exit(false);
                        eprintln!(
                            "[shell] host crashed {status:?} ({}/{}, window={:?}), backing off {:?}",
                            state.fail_streak(),
                            state.storm.max_failures,
                            state.storm.stable_window,
                            state.backoff()
                        );
                        if state.streak_capped() {
                            eprintln!("[shell] host restart storm cap reached, giving up");
                            state.mark_failed();
                            return;
                        }
                        if needs_backoff {
                            // Publish the Backoff phase before waiting it out.
                            on_snapshot(&state.lifecycle_snapshot());
                            match sleep_or_stop(state, rx) {
                                BackoffWake::Stopped => return,
                                BackoffWake::Command => {}
                                BackoffWake::Elapsed => state.double_backoff(),
                            }
                        }
                    }
                    WatchOutcome::RestartRequested => {
                        // Exit 51 is the host asking for a cooperative restart.
                        // Inside the stable window it is a restart storm and
                        // counts/backs off like a crash; after the window it is
                        // a legitimate request and relaunches immediately.
                        let needs_backoff = state.note_exit(true);
                        eprintln!(
                            "[shell] host requested restart ({HOST_RESTART_EXIT}) streak={}, backoff={:?}",
                            state.fail_streak(),
                            state.backoff()
                        );
                        if state.streak_capped() {
                            eprintln!("[shell] host restart storm cap reached, giving up");
                            state.mark_failed();
                            return;
                        }
                        if needs_backoff {
                            // Publish the Backoff phase before waiting it out.
                            on_snapshot(&state.lifecycle_snapshot());
                            match sleep_or_stop(state, rx) {
                                BackoffWake::Stopped => return,
                                BackoffWake::Command => {}
                                BackoffWake::Elapsed => state.double_backoff(),
                            }
                        }
                    }
                    WatchOutcome::StdioLost => {
                        // The host reached Ready and later lost the shell, so it
                        // exited with the dedicated code instead of crashing.
                        // Same rule as the pre-ready case: not the host's fault,
                        // so no storm charge and no backoff — relaunch at once.
                        // (In practice the shell has gone away too, so the
                        // supervisor is usually already unwinding; handling this
                        // explicitly keeps the arm from silently degrading into a
                        // crash should a future caller exit 52 in other
                        // circumstances.)
                        eprintln!(
                            "[shell] host exited {HOST_STDIO_LOST_EXIT} (shell became unreachable); \
                             relaunching without a storm charge"
                        );
                        on_snapshot(&state.lifecycle_snapshot());
                    }
                }
            }
            Err(failure) => {
                if !state.wants_running() {
                    return;
                }
                // The host lost the shell mid-handshake. It stopped itself
                // cleanly for a reason that is NOT its fault (the shell went
                // away), so this must not be billed to the storm budget — eight
                // of those inside the stable window would park a healthy host in
                // `Failed`. Relaunch immediately; the shell that owns us will
                // have gone away too, so the next attempt is a fresh session.
                if matches!(failure, SpawnFailure::StdioLost) {
                    eprintln!(
                        "[shell] host exited {HOST_STDIO_LOST_EXIT} (shell lost mid-handshake); \
                         relaunching without a storm charge"
                    );
                    // Publish so the tray shows the transient state rather than
                    // staying on `Starting`.
                    on_snapshot(&state.lifecycle_snapshot());
                    continue;
                }
                // Spawn failures never reached Ready, so there is no stable
                // window to forgive them: they always accumulate.
                state.bump_streak();
                // Put the reason in the SNAPSHOT, not just stderr: the tray and
                // the UI read `lastError`, and a reason that never leaves the log
                // is how a rejected handshake used to present as the misleading
                // "host did not call ready() within 10s".
                state.record_spawn_error(&failure.to_string());
                eprintln!(
                    "[shell] host spawn failed: {failure} ({}/{})",
                    state.fail_streak(),
                    state.storm.max_failures
                );
                if state.streak_capped() {
                    eprintln!("[shell] host restart storm cap reached, giving up");
                    state.mark_failed();
                    return;
                }
                // Publish the Backoff phase before waiting it out.
                on_snapshot(&state.lifecycle_snapshot());
                match sleep_or_stop(state, rx) {
                    BackoffWake::Stopped => return,
                    BackoffWake::Command => {}
                    BackoffWake::Elapsed => state.double_backoff(),
                }
            }
        }
    }
}

enum WatchOutcome {
    Stopped,
    RestartRequested,
    /// The host lost its shell mid-handshake and exited `HOST_STDIO_LOST_EXIT`.
    StdioLost,
    Crashed(Option<ExitStatus>),
}

/// Watch the current child until it exits, servicing lifecycle commands as
/// they arrive. Runs on the supervisor thread.
fn watch_until_exit(state: &HostState, rx: &Receiver<HostCommand>) -> WatchOutcome {
    loop {
        // GracefulStop/ForceKill/Reload/Restart may arrive while running.
        match rx.try_recv() {
            Ok(HostCommand::GracefulStop) => {
                state.request_stop_with_timeout(STOP_TIMEOUT);
                return WatchOutcome::Stopped;
            }
            Ok(HostCommand::ForceKill) => {
                let _ = state.force_kill_stopped();
                return WatchOutcome::Stopped;
            }
            Ok(HostCommand::Restart) => {
                state.reset_storm_state();
                if state.has_child() {
                    state.request_stop_with_timeout(STOP_TIMEOUT);
                }
                // Fall through and return Stopped so the running segment loops
                // and spawns the new generation.
                state.resume_running();
                return WatchOutcome::Stopped;
            }
            Ok(HostCommand::Reload) => {
                // Ask the host to tear down and exit 51; watch continues.
                state.host_reload();
            }
            Ok(HostCommand::Start) => {}
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => return WatchOutcome::Stopped,
        }
        if state.desired() == HostDesiredState::AppExit {
            return WatchOutcome::Stopped;
        }
        if state.is_stopping() {
            return WatchOutcome::Stopped;
        }
        {
            let mut inner = state.inner.lock().expect("host");
            let Some(tree) = inner.tree.as_mut() else {
                return WatchOutcome::Stopped;
            };
            match tree.try_wait() {
                Ok(Some(status)) => {
                    inner.clear();
                    drop(inner);
                    return classify_watch(Some(status));
                }
                Ok(None) => {}
                Err(_) => {
                    inner.clear();
                    return WatchOutcome::Stopped;
                }
            }
            // ⚠ THE PROCESS BEING ALIVE IS NOT THE SAME AS THE BRIDGE BEING ALIVE,
            // and this loop used to conflate them.
            //
            // `try_wait` above only sees the child. But the child's stdout is drained
            // by `kkrpc_peer`'s reader thread, and if THAT thread stops — a
            // persistent read error, or a flood of unparseable lines — the bridge is
            // dead while the process is still running and still holding its ws port.
            // Every check above then reports a healthy host: `try_wait` says running,
            // the phase stays `Ready`, and the UI shows a host that answers nothing.
            //
            // The peer cannot fix this itself (it does not own the lifecycle), so it
            // publishes the reason and the supervisor — which owns BOTH the state and
            // the peer — polls for it here, on a loop that already wakes every 30 ms.
            // Polling rather than the push callback `link_failure_notify` offers is
            // deliberate: `HostState` is held as Tauri state, not behind an `Arc`, so
            // it cannot be captured by that callback's `'static` bound, and inventing
            // a channel to work around it would add a second source of truth for
            // liveness.
            //
            // ⚠ IT ONLY RECORDS. IT DOES NOT DECIDE THE OUTCOME, and that restraint is
            // the fix for a real hang rather than a style choice. This block used to
            // return `WatchOutcome::StdioLost` whenever the reader reported a clean
            // EOF, on the reasoning that a dead transport means a dying child. That
            // reasoning was wrong in a way that cost 28 minutes of CI:
            //
            //   * `StdioLost` is defined by an EXIT CODE (`HOST_STDIO_LOST_EXIT`), and
            //     its whole purpose is to be exempt from the restart-storm budget
            //     ("not the host's fault"). Choosing it from a transport EOF — an
            //     observation that carries NO exit code — claims that exemption
            //     without the evidence for it.
            //   * Every host exit closes stdout, so exit 51 (a deliberate restart
            //     request) also surfaced here as `Closed`. Returning `StdioLost`
            //     therefore skipped `note_exit`, the storm cap was never reached, and
            //     the supervisor relaunched forever. The test that asserts the cap
            //     (`exit_51_loop_inside_stable_window_...`) blocked in `thread::scope`'s
            //     join until the job's 30-minute wall killed it.
            //   * Note the short-circuit bought nothing even in the good case: stdout
            //     EOF means the child has closed it, so `try_wait` above observes the
            //     exit on its own. It saved no latency and created a race — one that
            //     passed on the previous run and hung on this one.
            //
            // So the exit code stays the authority: `try_wait` classifies this
            // generation, exactly as it did before this block existed. Keep it that
            // way — do not reintroduce a return here.
            let bridge = inner
                .peer
                .as_ref()
                .and_then(|peer| peer.link_failure())
                .map(|failure| (failure, inner.bridge_failure_recorded));
            if let Some((failure, already_recorded)) = bridge {
                if !already_recorded {
                    inner.bridge_failure_recorded = true;
                }
                drop(inner);
                note_bridge_failure(state, failure, already_recorded);
                inner = state.inner.lock().expect("host");
            }
        }
        std::thread::sleep(Duration::from_millis(30));
    }
}

/// Record a bridge-reader failure into the snapshot, and nothing else.
///
/// ⚠ This function deliberately returns NOTHING. It records the reason so the
/// SNAPSHOT carries it; it does not decide the generation's outcome, because the
/// exit code is the authority for that and this observation carries none. A
/// previous version returned a verdict — `TransportClosed` on a clean EOF — and
/// the caller turned that into `WatchOutcome::StdioLost`. That skipped the
/// restart-storm accounting (see `watch_until_exit`), so a deliberate exit 51 was
/// never billed, the cap was never reached, and a test blocked until CI killed the
/// job 28 minutes later. Keep this a report.
///
/// ⚠ It also does NOT declare the host `Failed`: a stopped reader is not proof the
/// process died — `LinkFailure::Read` explicitly means the child may be alive with a
/// broken stdout — and forcing `Failed` here would race the supervisor's own restart
/// logic. `record_spawn_error` is the existing mechanism for "the cause must reach
/// the snapshot", so the condition becomes visible without this code claiming more
/// than it can see.
///
/// `already_recorded` is the per-generation latch: `link_failure()` is monotonic
/// (the first failure wins), so without it a 30 ms poll would rewrite `last_error`
/// forever.
fn note_bridge_failure(
    state: &HostState,
    failure: crate::kkrpc_peer::LinkFailure,
    already_recorded: bool,
) {
    if !already_recorded {
        state.record_spawn_error(&format!("host bridge reader stopped: {failure:?}"));
    }
}

fn classify_watch(status: Option<ExitStatus>) -> WatchOutcome {
    match status {
        // Delegates the CODE judgement to `classify_exit_code` so the watch loop
        // and the pre-ready handshake cannot drift apart, while still carrying
        // the full status for the crash log.
        Some(status) => match classify_exit_code(status.code()) {
            WatchOutcome::RestartRequested => WatchOutcome::RestartRequested,
            WatchOutcome::StdioLost => WatchOutcome::StdioLost,
            _ => WatchOutcome::Crashed(Some(status)),
        },
        None => WatchOutcome::Stopped,
    }
}

/// Classify a child exit by its CODE alone.
///
/// Split out from `classify_watch` for two reasons:
///
///   1. `ExitStatus` cannot be constructed in safe Rust (it is only obtained
///      from a real process), so a code-level function is the only way to
///      unit-test the classification without spawning children.
///   2. Both the watch loop AND the pre-ready handshake need the same judgement,
///      and the handshake cannot reuse `WatchOutcome`. Keeping the decision in
///      one place stops the two from drifting — which is exactly what made the
///      dedicated exit code dead code on the handshake path when it existed only
///      inside `classify_watch`.
fn classify_exit_code(code: Option<i32>) -> WatchOutcome {
    match code {
        Some(HOST_RESTART_EXIT) => WatchOutcome::RestartRequested,
        // The host lost the shell mid-handshake and stopped itself. That is NOT a
        // crash: the host did nothing wrong, and charging it to the storm budget
        // would park a perfectly healthy host in `Failed` after eight of these.
        // Distinct from `Stopped` too, so the tray can say "lost the shell"
        // instead of "stopped", and distinct from 51 because nothing was
        // restarted at the host's request.
        Some(HOST_STDIO_LOST_EXIT) => WatchOutcome::StdioLost,
        // No code means the child was terminated (a signal, or TerminateProcess
        // on Windows) rather than exiting on its own. `classify_watch` has always
        // read that as a deliberate stop, and this arm must agree with it or the
        // two paths would disagree about the same process.
        None => WatchOutcome::Stopped,
        Some(_) => WatchOutcome::Crashed(None),
    }
}

/// Why a backoff wait ended.
///
/// The caller must not double the backoff when a user command woke the loop
/// early: `Start`/`Restart` already reset the storm bookkeeping, so doubling
/// would punish a deliberate user action.
enum BackoffWake {
    /// The supervisor must return (stop/force/disconnect/intent change).
    Stopped,
    /// A Start/Restart command was honored; storm state was already reset.
    Command,
    /// The backoff elapsed normally; the next failure doubles it.
    Elapsed,
}

fn sleep_or_stop(state: &HostState, rx: &Receiver<HostCommand>) -> BackoffWake {
    let total = state.backoff();
    let deadline = Instant::now() + total;
    while Instant::now() < deadline {
        if !state.wants_running() {
            return BackoffWake::Stopped;
        }
        // Keep the snapshot's nextRetryMs honest while backing off.
        {
            let mut inner = state.inner.lock().expect("host");
            let remaining = deadline.saturating_duration_since(Instant::now());
            inner.lifecycle.phase = HostLifecycleState::Backoff;
            inner.lifecycle.next_retry_ms = Some(remaining.as_millis() as u64);
        }
        // A Start/Restart during backoff is honored immediately.
        match rx.try_recv() {
            Ok(HostCommand::Start | HostCommand::Restart) => {
                state.reset_storm_state();
                return BackoffWake::Command;
            }
            Ok(HostCommand::GracefulStop) => {
                state.request_stop_with_timeout(STOP_TIMEOUT);
                return BackoffWake::Stopped;
            }
            Ok(HostCommand::ForceKill) => {
                let _ = state.force_kill_stopped();
                return BackoffWake::Stopped;
            }
            Ok(_) => {}
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => return BackoffWake::Stopped,
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    if state.wants_running() {
        BackoffWake::Elapsed
    } else {
        BackoffWake::Stopped
    }
}

#[cfg(test)]
pub fn spawn_host() -> Result<HostSession, String> {
    let mut starting = start_host_process(None)?;
    let ready = wait_until_ready(&mut starting, || false)?;
    let pong = starting
        .peer
        .call("ping", vec![])
        .map_err(|err| format!("host ping: {err}"))?;
    if pong != serde_json::json!("pong") {
        starting.tree.kill_tree();
        return Err(format!("host ping returned {pong}"));
    }
    Ok(HostSession {
        tree: starting.tree,
        peer: starting.peer,
        ready,
    })
}

fn spawn_host_into(state: &HostState, app: Option<&AppHandle>) -> Result<HostReady, SpawnFailure> {
    {
        let mut inner = state.inner.lock().expect("host");
        if inner.stopping {
            return Err("stopping".into());
        }
        inner.lifecycle.phase = HostLifecycleState::Starting;
        inner.lifecycle.desired = crate::host_lifecycle::HostDesiredState::Running;
    }
    // Allocate the public generation only after the process has spawned and is
    // ready to be adopted; failed Command::spawn must not consume a generation.
    let starting = start_host_process(app)?;
    let generation = {
        let mut inner = state.inner.lock().expect("host");
        match inner.lifecycle.allocate_generation() {
            Ok(generation) => {
                inner.generation = generation;
                generation
            }
            Err(reason) => {
                drop(inner);
                let mut tree = starting.tree;
                tree.kill_tree();
                return Err(reason.into());
            }
        }
    };
    let peer = starting.peer.clone();
    // Destructure before `starting.tree` is moved into `adopt_inflight`, so the
    // wait can still see the ready slot and the refusal reason afterwards.
    let StartingHost {
        tree,
        ready_slot,
        ready_error,
        ..
    } = starting;
    if let Err(mut tree) = state.adopt_inflight(generation, tree, peer) {
        tree.kill_tree();
        return Err("stopped during spawn".into());
    }
    let wait = wait_until_ready_in_state(state, generation, &ready_slot, &ready_error);
    let ready = match wait {
        Ok(ready) => ready,
        Err(err) => {
            state.reap_tree();
            return Err(err);
        }
    };
    let Some(peer) = state.peer() else {
        state.reap_tree();
        return Err("host peer lost".into());
    };
    let pong = match peer.call("ping", vec![]) {
        Ok(pong) => pong,
        Err(err) => {
            // The child was already adopted and is still alive: reap it before
            // unwinding, otherwise the supervisor retries (or parks in Failed)
            // while a live host keeps the port bound.
            state.reap_tree();
            return Err(format!("host ping: {err}").into());
        }
    };
    if pong != serde_json::json!("pong") {
        state.reap_tree();
        return Err(format!("host ping returned {pong}").into());
    }
    match state.promote_ready(generation, ready) {
        Ok(ready) => Ok(ready),
        Err(()) => {
            state.reap_tree();
            Err("stopped during ready".into())
        }
    }
}

struct StartingHost {
    tree: ProcessTree,
    peer: Arc<Peer>,
    ready_slot: Arc<Mutex<Option<HostReady>>>,
    /// Why the `ready` handler REFUSED a handshake, if it did. Reported by the
    /// wait instead of its generic timeout, so a refused handshake is not
    /// indistinguishable from one that never arrived.
    ready_error: Arc<Mutex<Option<String>>>,
}

fn start_host_process(app: Option<&AppHandle>) -> Result<StartingHost, String> {
    let launch = resolve_host_launch(app)?;

    // Log the resolved launch once per spawn. From the UI, "the host is dead"
    // and "the shell launched the wrong thing" look identical, and this line is
    // what turns the 2026-09 dev-launch bug (a target-dir sidecar copy with cwd
    // = target dir, so the host died on a missing cordis.yml) into a one-look
    // diagnosis instead of a multi-step inference.
    eprintln!(
        "[shell] host launch: {} {}(cwd {})",
        launch.program.display(),
        if launch.args.is_empty() {
            String::new()
        } else {
            format!("{} ", launch.args.join(" "))
        },
        launch.cwd.display()
    );

    let mut cmd = Command::new(&launch.program);
    cmd.args(&launch.args)
        .current_dir(&launch.cwd)
        .env("VRCXK_SHELL", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    // ⚠ Tell the host WHERE to write its log file, because on a release build it
    // has nowhere else to put it. The shell is `windows_subsystem = "windows"`
    // (`main.rs`), so there is no console and the host's stderr — where every
    // `[cap]` audit line and every `#24` overreach warning goes — is discarded.
    // Without this the whole declare-and-warn feature was invisible on a user's
    // machine, which is exactly what `#24` promises it is not.
    //
    // The shell owns the location because it is the component that knows the
    // app's data directory; the host is a sidecar and must not guess it.
    if let Some(dir) = host_log_dir(app) {
        cmd.env("VRCXK_LOG_DIR", dir);
    }
    let mut tree = ProcessTree::spawn(&mut cmd).map_err(|err| {
        format!(
            "spawn {} in {}: {err}",
            launch.program.display(),
            launch.cwd.display()
        )
    })?;

    let stdout = tree.child_stdout().ok_or("host stdout")?;
    let stdin = tree.child_stdin().ok_or("host stdin")?;
    let peer = Peer::new(stdin);

    // Register the mandatory startup handshake before reading stdout. If the
    // host is already ready, its frame remains safely buffered in the pipe.
    //
    // The payload is parsed into the versioned contract type and validated
    // before it is stored, so a malformed or version-skewed handshake is refused
    // HERE.
    //
    // A refusal ALSO records its reason in `ready_error`, which
    // `wait_until_ready_in_state` reports instead of its generic timeout. Without
    // that, refusing a handshake looked identical to the host never sending one:
    // the wait ran out its full 10s and reported "host did not call ready()
    // within 10s", blaming the host for the shell's own refusal — while the real
    // cause sat in stderr where the tray and UI cannot see it.
    let ready_slot: Arc<Mutex<Option<HostReady>>> = Arc::new(Mutex::new(None));
    let ready_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let ready_handler = Arc::clone(&ready_slot);
    let ready_error_handler = Arc::clone(&ready_error);
    peer.on(
        "ready",
        Arc::new(move |args| {
            if let Some(info) = args.first() {
                match serde_json::from_value::<HostReady>(info.clone()) {
                    Ok(ready) if ready.is_supported() => {
                        *ready_handler.lock().expect("ready slot") = Some(ready);
                    }
                    Ok(ready) => {
                        let reason = format!(
                            "host sent an unsupported ready handshake \
                             (schemaVersion={}, expected={}, port={}, token_len={}, hostVersion={:?})",
                            ready.schema_version,
                            crate::host_ready::HOST_READY_SCHEMA_VERSION,
                            ready.port,
                            ready.token.len(),
                            ready.host_version,
                        );
                        eprintln!("[shell] {reason}");
                        *ready_error_handler.lock().expect("ready error") = Some(reason);
                    }
                    Err(err) => {
                        let reason = format!("host sent a malformed ready handshake: {err}");
                        eprintln!("[shell] {reason}");
                        *ready_error_handler.lock().expect("ready error") = Some(reason);
                    }
                }
            }
            serde_json::Value::Null
        }),
    );
    if let Some(app) = app {
        register_shell_handlers(&peer, app.clone());
    }
    // The file capabilities are registered unconditionally: unlike the tray
    // surface they have no Tauri dependency, and a `hands.*` method that is
    // simply absent would be indistinguishable from a typo'd name at the host.
    crate::hands::register_hands_handlers(&peer);
    peer.start_reader(stdout);
    // Announce who this node is, and from where.
    //
    // Sent AFTER the reader starts so the write cannot interleave with the
    // reader's own setup, and so the brain sees it as an ordinary method call on
    // an established channel. It is a notification, not a request: nothing waits
    // for an answer, and a brain that does not know `hands.hello` yet simply logs
    // an unknown method — which is why this needs no negotiation to be safe to
    // deploy on one side first.
    crate::hands_hello::send_hello(&peer);
    Ok(StartingHost {
        tree,
        peer,
        ready_slot,
        ready_error,
    })
}

#[cfg(test)]
fn wait_until_ready(
    starting: &mut StartingHost,
    mut abort: impl FnMut() -> bool,
) -> Result<HostReady, String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(ready) = starting.ready_slot.lock().expect("ready slot").clone() {
            return Ok(ready);
        }
        if abort() {
            starting.tree.kill_tree();
            return Err("stopped during ready".into());
        }
        if Instant::now() >= deadline {
            starting.tree.kill_tree();
            return Err("host did not call ready() within 10s".into());
        }
        if let Ok(Some(status)) = starting.tree.try_wait() {
            return Err(format!("host exited before ready: {status}"));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn wait_until_ready_in_state(
    state: &HostState,
    generation: u64,
    ready_slot: &Mutex<Option<HostReady>>,
    ready_error: &Mutex<Option<String>>,
) -> Result<HostReady, SpawnFailure> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if !state.still_current(generation) {
            return Err(SpawnFailure::Retry("stopped during ready".into()));
        }
        if let Some(ready) = ready_slot.lock().expect("ready slot").clone() {
            return Ok(ready);
        }
        // The host DID send a handshake and the shell refused it. Report that
        // immediately and specifically: waiting out the full timeout would
        // report "did not call ready()", which is false, and would send a reader
        // looking at the host instead of at the refusal reason.
        if let Some(reason) = ready_error.lock().expect("ready error").clone() {
            return Err(SpawnFailure::Retry(reason));
        }
        {
            let mut inner = state.inner.lock().expect("host");
            if let Some(tree) = inner.tree.as_mut() {
                if let Ok(Some(status)) = tree.try_wait() {
                    inner.clear();
                    // The handshake never completes, so this is the ONLY place a
                    // mid-handshake exit is classified: `classify_watch` runs
                    // later, on the watch loop, which a host that dies before
                    // `ready` never reaches. Without this arm the dedicated exit
                    // code would be dead code and the host would still be billed
                    // as a crash.
                    return Err(classify_spawn_exit(status));
                }
            }
        }
        if Instant::now() >= deadline {
            return Err(SpawnFailure::Retry(format!(
                "host did not call ready() within {READY_TIMEOUT_SECS}s"
            )));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// How long the shell waits for the host's `ready` frame before giving up.
const READY_TIMEOUT_SECS: u64 = 10;

/// Classify a child exit observed DURING the ready handshake.
///
/// The handshake cannot reuse `WatchOutcome` (it needs "should this count
/// against the storm budget?", not "what does the watch loop do next"), but the
/// CODE judgement must be identical — hence both delegate to
/// `classify_exit_code`. Keeping them in step is what stops the dedicated code
/// from being recognised in one path and billed as a crash in the other.
fn classify_spawn_exit(status: ExitStatus) -> SpawnFailure {
    classify_spawn_exit_code(status.code())
}

fn classify_spawn_exit_code(code: Option<i32>) -> SpawnFailure {
    match classify_exit_code(code) {
        WatchOutcome::StdioLost => SpawnFailure::StdioLost,
        _ => SpawnFailure::Retry(match code {
            Some(code) => format!("host exited before ready with code {code}"),
            None => "host exited before ready without a code".to_string(),
        }),
    }
}

fn bun_exe() -> &'static str {
    if cfg!(windows) {
        "bun.exe"
    } else {
        "bun"
    }
}

fn find_bun() -> PathBuf {
    if let Ok(explicit) = std::env::var("VRCXK_BUN") {
        return PathBuf::from(explicit);
    }
    // 1. Standalone install (bun.sh default): ~/.bun/bin/bun[.exe]
    let name = bun_exe();
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let candidate = PathBuf::from(home).join(".bun/bin").join(name);
        if candidate.is_file() {
            return candidate;
        }
    }
    // 2. npm global install: PATH has `bun`/`bun.cmd` shims in the npm prefix
    //    dir, but the real binary lives at <prefix>/node_modules/bun/bin/bun.exe.
    //    Spawning the shim directly fails on Windows (not an executable), so
    //    resolve through the shim directory.
    for shim in ["bun.cmd", "bun.exe", "bun"] {
        if let Some(dir) = shim_dir_on_path(shim) {
            let candidate = dir.join("node_modules/bun/bin").join(name);
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    // 3. Plain `bun.exe` on PATH.
    if let Some(found) = find_on_path(name) {
        return found;
    }
    // 4. Fallback: bare name (hope it is on PATH after all).
    PathBuf::from(name)
}

/// Return the directory containing the first PATH entry named `name`
/// (skipping `.ps1` shims which cannot be spawned directly).
fn shim_dir_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|dir| {
        let candidate = dir.join(name);
        if !candidate.is_file() {
            return None;
        }
        if candidate.extension().and_then(|ext| ext.to_str()) == Some("ps1") {
            return None;
        }
        Some(dir)
    })
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|dir| {
        let candidate = dir.join(name);
        if !candidate.is_file() {
            return None;
        }
        if candidate.extension().and_then(|ext| ext.to_str()) == Some("ps1") {
            return None;
        }
        Some(candidate)
    })
}

fn host_dir() -> PathBuf {
    if let Ok(explicit) = std::env::var("VRCXK_HOST_DIR") {
        return PathBuf::from(explicit);
    }
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../host")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from("../host"))
}

/// A resolved host launch specification (compiled sidecar or dev source).
#[derive(Debug)]
struct HostLaunch {
    program: PathBuf,
    args: Vec<String>,
    cwd: PathBuf,
}

impl HostLaunch {
    fn source() -> Result<Self, String> {
        let bun = find_bun();
        let host_dir = host_dir();
        if !host_dir.join("src/index.ts").is_file() {
            return Err(format!("host entry missing at {}", host_dir.display()));
        }
        Ok(Self {
            program: bun,
            args: vec!["src/index.ts".into()],
            cwd: host_dir,
        })
    }

    fn compiled(program: PathBuf, cwd: PathBuf) -> Self {
        Self {
            program,
            args: vec![],
            cwd,
        }
    }
}

/// Tauri strips the target-triple suffix from external binaries inside the
/// bundle: `host-x86_64-pc-windows-msvc.exe` ships as `host.exe` next to the
/// main executable on Windows (no suffix on Unix).
fn packaged_host_name() -> &'static str {
    if cfg!(windows) {
        "host.exe"
    } else {
        "host"
    }
}

/// Current host Rust target triple with the sidecar file suffix, e.g.
/// `host-x86_64-pc-windows-msvc.exe`. tauri-build injects the exact triple
/// (`TAURI_ENV_TARGET_TRIPLE`) at compile time.
fn host_triple_suffixed_name() -> String {
    let triple = env!("TAURI_ENV_TARGET_TRIPLE");
    let exe = if cfg!(windows) { ".exe" } else { "" };
    format!("host-{triple}{exe}")
}

/// Probe a directory for a usable compiled host binary: first the bundled
/// name (`host[.exe]`, triple suffix stripped), then a dev-placed sidecar
/// named with the host triple. Exposed for tests with fake directories.
fn find_packaged_host(resource_dir: &Path) -> Option<PathBuf> {
    let bundled = resource_dir.join(packaged_host_name());
    if bundled.is_file() {
        return Some(bundled);
    }
    let dev_sidecar = resource_dir.join(host_triple_suffixed_name());
    if dev_sidecar.is_file() {
        return Some(dev_sidecar);
    }
    None
}

/// The runtime file the host needs in its working directory.
///
/// The compiled sidecar resolves its include tree from `./cordis.yml` relative
/// to cwd, so a sidecar without this file beside it starts and dies within
/// milliseconds.
const HOST_RUNTIME_ENTRY: &str = "cordis.yml";

/// Resolve how to launch the host.
///
/// Priority (highest first):
/// 1. `VRCXK_HOST_BIN`: explicit compiled binary override; fails fast when
///    the file does not exist (no silent fallback — debugging/tests).
/// 2. Bundled sidecar: `resource_dir()` holds both the packaged sidecar
///    (`host[.exe]`, triple suffix stripped by Tauri) and
///    [`HOST_RUNTIME_ENTRY`], and it is run with the resource dir as cwd so the
///    host finds `cordis.yml` / `plugins/` beside itself. **Packaged builds
///    only** — see `dev_build` on the pure core.
/// 3. Dev source: default for `cargo tauri dev`/tests — `bun` + `src/index.ts`
///    in the checked-out `host/` dir (VRCXK_BUN / VRCXK_HOST_DIR kept).
fn resolve_host_launch(app: Option<&AppHandle>) -> Result<HostLaunch, String> {
    let explicit = std::env::var("VRCXK_HOST_BIN").ok().map(PathBuf::from);
    let cwd_override = std::env::var_os("VRCXK_HOST_DIR").map(PathBuf::from);
    let resource_dir = app.and_then(|app| app.path().resource_dir().ok());
    resolve_host_launch_with(resource_dir, explicit, cwd_override, tauri::is_dev())
}

/// Where the host should write its log file, if we can determine it.
///
/// ⚠ This exists because the host's stderr goes NOWHERE in a release build. The
/// shell is `windows_subsystem = "windows"` (`main.rs`), so there is no console
/// attached; on desktop the host is spawned with `stderr(Stdio::inherit())`, which
/// inherits a handle that leads to no window. Every `[cap]` audit line and every
/// `#24` overreach warning was therefore written and thrown away, while `#24`
/// states its whole honest scope as "undeclared access becomes VISIBLE".
///
/// The SHELL resolves this because it owns the app's data directory; the host is a
/// sidecar and cannot know the user's profile layout. `None` means "no log file",
/// which the host must treat as "stay on stderr" rather than as an error — that is
/// the correct behaviour in dev and in tests, where stderr IS readable.
fn host_log_dir(app: Option<&AppHandle>) -> Option<String> {
    let dir = app?.path().app_log_dir().ok()?;
    Some(dir.to_string_lossy().into_owned())
}

/// Pure core of `resolve_host_launch` (inputs passed in for testability).
///
/// `dev_build` is `tauri::is_dev()`. In a dev build `resource_dir()` is the
/// cargo target directory, where `tauri dev` drops a copy of the external
/// binary (triple suffix stripped) but **not** the host's runtime files:
/// launching that copy runs the brain with cwd = target dir, so it dies on the
/// missing `cordis.yml`, the supervisor retries it forever, and every shell →
/// host notification (tray actions, shortcut presses) reports "not delivered" —
/// the UI then blames the host while the real fault is the launch source. A dev
/// build must therefore run from source. (2026-09 regression: a `tauri dev`
/// acceptance run hit exactly this.)
fn resolve_host_launch_with(
    resource_dir: Option<PathBuf>,
    explicit: Option<PathBuf>,
    cwd_override: Option<PathBuf>,
    dev_build: bool,
) -> Result<HostLaunch, String> {
    // 1. Explicit compiled override (fail fast).
    if let Some(program) = explicit {
        if !program.is_file() {
            return Err(format!(
                "VRCXK_HOST_BIN set but not a file: {}",
                program.display()
            ));
        }
        // Runtime files (cordis.yml/plugins) resolve via cwd. Default to the
        // binary's directory (packaged layout); the dir override (from
        // VRCXK_HOST_DIR) redirects debug runs to a tree holding the runtime
        // files, but only when that directory actually exists.
        let cwd = cwd_override.filter(|p| p.is_dir()).unwrap_or_else(|| {
            program
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| PathBuf::from("."))
        });
        return Ok(HostLaunch::compiled(program, cwd));
    }

    // 2. Bundled sidecar next to the app resources (packaged builds only).
    if !dev_build {
        if let Some(resource_dir) = resource_dir {
            if let Some(program) = find_packaged_host(&resource_dir) {
                if !resource_dir.join(HOST_RUNTIME_ENTRY).is_file() {
                    // Fail loudly instead of spawning a host that cannot load
                    // its include tree: a silent restart loop is
                    // indistinguishable from a shell/host bug.
                    return Err(format!(
                        "bundled host sidecar at {} has no {HOST_RUNTIME_ENTRY} beside it; \
                         the bundle is missing the host runtime files",
                        resource_dir.display()
                    ));
                }
                return Ok(HostLaunch::compiled(program, resource_dir));
            }
        }
    }

    // 3. Dev source (default).
    HostLaunch::source()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process_tree::pid_alive;

    #[test]
    fn restart_exit_matches_named_const() {
        assert_eq!(HOST_RESTART_EXIT, 51);
    }

    /// The dedicated exit codes are a CROSS-LANGUAGE contract: the host's
    /// `host/src/api.ts` writes them and this module reads them. Pinning the
    /// values here is what turns a silent divergence (host exits 53, shell only
    /// knows 52, and 53 gets billed as a crash) into a failing test.
    #[test]
    fn exit_codes_match_the_hosts_constants() {
        assert_eq!(HOST_RESTART_EXIT, 51, "HOST_RESTART_EXIT must match api.ts");
        assert_eq!(
            HOST_STDIO_LOST_EXIT, 52,
            "HOST_STDIO_LOST_EXIT must match api.ts"
        );
        // The two must stay distinct, or the classifier would conflate a
        // deliberate restart with a lost shell.
        assert_ne!(HOST_STDIO_LOST_EXIT, HOST_RESTART_EXIT);
    }

    /// The whole point of the dedicated code: it must NOT be classified as a
    /// crash, because `Crashed` is what feeds the restart-storm budget.
    #[test]
    fn the_stdio_lost_code_is_not_a_crash() {
        assert!(
            matches!(
                classify_exit_code(Some(HOST_STDIO_LOST_EXIT)),
                WatchOutcome::StdioLost
            ),
            "exit {HOST_STDIO_LOST_EXIT} must classify as StdioLost, not Crashed"
        );
    }

    /// ...and the handshake path, which never reaches `classify_watch`, must
    /// reach the same conclusion. Before `classify_spawn_exit` existed the
    /// dedicated code was dead: a host that dies before `ready` is observed by
    /// `wait_until_ready_in_state`, so it was still billed as a startup failure.
    #[test]
    fn the_stdio_lost_code_is_not_a_spawn_failure() {
        assert!(
            matches!(
                classify_spawn_exit_code(Some(HOST_STDIO_LOST_EXIT)),
                SpawnFailure::StdioLost
            ),
            "a pre-ready exit {HOST_STDIO_LOST_EXIT} must not be a Retry failure"
        );
    }

    /// Every other code keeps its existing meaning on BOTH paths — the new code
    /// must not have widened what counts as "not our fault".
    #[test]
    fn other_exit_codes_still_count_as_failures() {
        for code in [0, 1, 2, HOST_RESTART_EXIT, 53, 255] {
            assert!(
                !matches!(classify_exit_code(Some(code)), WatchOutcome::StdioLost),
                "exit {code} must not classify as StdioLost"
            );
            assert!(
                matches!(classify_spawn_exit_code(Some(code)), SpawnFailure::Retry(_)),
                "exit {code} must still be a Retry spawn failure"
            );
        }
    }

    /// `None` means "terminated without a code" (a signal / TerminateProcess) —
    /// that is a stop, not a stdio loss.
    #[test]
    fn a_codeless_exit_is_stopped_not_stdio_lost() {
        assert!(matches!(classify_exit_code(None), WatchOutcome::Stopped));
        assert!(matches!(
            classify_spawn_exit_code(None),
            SpawnFailure::Retry(_)
        ));
    }

    #[test]
    fn spawn_host_ready_ping_stop() {
        let mut session = spawn_host().expect("spawn host");
        assert!(session.ready.port > 0);
        assert_eq!(session.ready.token.len(), 64);
        let pong = session.peer.call("ping", vec![]).expect("ping");
        assert_eq!(pong, serde_json::json!("pong"));
        let stopped = session.peer.call("stop", vec![]).expect("stop");
        assert_eq!(stopped, serde_json::json!(true));
        let status = session.tree.wait().expect("wait host");
        assert!(status.success(), "{status}");
    }

    #[test]
    fn call_times_out_after_host_dies() {
        let mut session = spawn_host().expect("spawn host");
        let pid = session.tree.id();
        session.tree.kill_tree();
        assert!(!pid_alive(pid));
        let started = Instant::now();
        let err = session
            .peer
            .call_timeout("ping", vec![], Duration::from_secs(2));
        assert!(err.is_err(), "{err:?}");
        assert!(started.elapsed() < Duration::from_secs(4));
    }

    #[test]
    fn stop_rpc_timeout_uses_only_the_watchdog_budget_remaining() {
        let deadline = Instant::now() + Duration::from_millis(30);
        std::thread::sleep(Duration::from_millis(10));
        let timeout = stop_rpc_timeout(deadline);
        assert!(timeout < Duration::from_millis(30));
        assert!(timeout <= STOP_RPC_TIMEOUT);
    }

    #[test]
    fn stop_rpc_timeout_is_zero_after_watchdog_expires() {
        let deadline = Instant::now() - Duration::from_millis(1);
        assert_eq!(stop_rpc_timeout(deadline), Duration::ZERO);
    }

    #[test]
    fn find_bun_uses_platform_exe_name() {
        let name = bun_exe();
        assert_eq!(name.ends_with(".exe"), cfg!(windows));
        assert_ne!(name, "bun.ps1");
        let bun = find_bun();
        assert_ne!(bun.extension().and_then(|ext| ext.to_str()), Some("ps1"));
    }

    #[test]
    fn spawn_into_stopping_state_fails() {
        let state = HostState::default();
        state.request_stop();
        assert!(spawn_host_into(&state, None).is_err());
        assert!(state.child_id().is_none());
    }

    #[test]
    fn kill_host_relaunches_with_new_token() {
        let state = HostState::default();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                supervise_loop(
                    &state,
                    None,
                    |ready| {
                        let _ = tx.send(ready);
                    },
                    &mut |_: &HostSnapshot| {},
                );
            });
            let first = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("first ready");
            let first_pid = state.child_id().expect("first pid");
            state.force_kill_running();
            let second = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("second ready");
            assert_ne!(first.token, second.token);
            assert_ne!(first.port, second.port);
            let second_pid = state.child_id().expect("second pid");
            state.request_stop();
            assert!(!pid_alive(first_pid));
            assert!(!pid_alive(second_pid));
            // The supervisor only exits on an app-exit latch; end it so the
            // scoped thread can join.
            state.latch_app_exit();
        });
    }

    #[test]
    fn exit_51_relaunches_with_new_token() {
        let state = HostState::default();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                supervise_loop(
                    &state,
                    None,
                    |ready| {
                        let _ = tx.send(ready);
                    },
                    &mut |_: &HostSnapshot| {},
                );
            });
            let first = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("first ready");
            state
                .peer()
                .expect("peer")
                .call("restart", vec![])
                .expect("restart");
            let second = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("second ready");
            assert_ne!(first.token, second.token);
            let second_pid = state.child_id().expect("second pid");
            state.request_stop();
            assert!(!pid_alive(second_pid));
            state.latch_app_exit();
        });
    }

    // --- dispatch-driven orchestration ------------------------------------

    #[test]
    fn dispatch_graceful_stop_actually_stops_host_and_does_not_relaunch() {
        let state = HostState::default();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                supervise_loop(
                    &state,
                    None,
                    |ready| {
                        let _ = tx.send(ready);
                    },
                    &mut |_: &HostSnapshot| {},
                );
            });
            let _first = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("first ready");
            let first_pid = state.child_id().expect("first pid");
            // Reducer accepts GracefulStop from Ready.
            assert!(matches!(
                state.dispatch(HostCommand::GracefulStop),
                HostCommandResult::Accepted { .. }
            ));
            // The supervisor performs the real stop: child gone, no relaunch.
            let deadline = Instant::now() + Duration::from_secs(15);
            while Instant::now() < deadline {
                let snapshot = state.lifecycle_snapshot();
                if snapshot.phase == HostLifecycleState::Stopped {
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            assert!(!pid_alive(first_pid));
            assert_eq!(
                state.lifecycle_snapshot().phase,
                HostLifecycleState::Stopped,
                "graceful stop must settle the snapshot at Stopped"
            );
            // No second ready must arrive while stopped.
            std::thread::sleep(Duration::from_millis(400));
            assert!(rx.try_recv().is_err(), "host must not relaunch after stop");
            state.latch_app_exit();
        });
    }

    #[test]
    fn dispatch_start_after_stop_relaunches_host() {
        let state = HostState::default();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                supervise_loop(
                    &state,
                    None,
                    |ready| {
                        let _ = tx.send(ready);
                    },
                    &mut |_: &HostSnapshot| {},
                );
            });
            let first = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("first ready");
            let first_pid = state.child_id().expect("first pid");
            // GracefulStop must be accepted from Ready.
            assert!(matches!(
                state.dispatch(HostCommand::GracefulStop),
                HostCommandResult::Accepted { .. }
            ));
            // Wait until the supervisor reports Stopped (child reaped), not
            // merely until the pid is gone: dispatch(Start) is only accepted
            // from Stopped/Failed/Backoff, so racing the snapshot would flake.
            let deadline = Instant::now() + Duration::from_secs(15);
            while Instant::now() < deadline {
                let snapshot = state.lifecycle_snapshot();
                if snapshot.phase == HostLifecycleState::Stopped {
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            assert_eq!(
                state.lifecycle_snapshot().phase,
                HostLifecycleState::Stopped,
                "graceful stop must settle the snapshot at Stopped"
            );
            assert!(!pid_alive(first_pid));
            // Start again: a new generation must come up.
            assert!(matches!(
                state.dispatch(HostCommand::Start),
                HostCommandResult::Accepted { .. }
            ));
            let second = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("second ready after start");
            assert_ne!(first.token, second.token);
            let second_pid = state.child_id().expect("second pid");
            state.dispatch(HostCommand::ForceKill);
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline && pid_alive(second_pid) {
                std::thread::sleep(Duration::from_millis(50));
            }
            assert!(!pid_alive(second_pid));
            state.latch_app_exit();
        });
    }

    #[test]
    fn dispatch_force_kill_stops_without_relaunch() {
        let state = HostState::default();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                supervise_loop(
                    &state,
                    None,
                    |ready| {
                        let _ = tx.send(ready);
                    },
                    &mut |_: &HostSnapshot| {},
                );
            });
            let _first = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("first ready");
            let first_pid = state.child_id().expect("first pid");
            assert!(matches!(
                state.dispatch(HostCommand::ForceKill),
                HostCommandResult::Accepted { .. }
            ));
            let deadline = Instant::now() + Duration::from_secs(15);
            while Instant::now() < deadline {
                let snapshot = state.lifecycle_snapshot();
                if snapshot.phase == HostLifecycleState::Stopped {
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            assert!(!pid_alive(first_pid));
            assert_eq!(
                state.lifecycle_snapshot().phase,
                HostLifecycleState::Stopped,
                "force kill must settle the snapshot at Stopped"
            );
            std::thread::sleep(Duration::from_millis(400));
            assert!(rx.try_recv().is_err(), "force kill must not relaunch");
            state.latch_app_exit();
        });
    }

    #[test]
    fn dispatch_restart_while_ready_restarts_host() {
        let state = HostState::default();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                supervise_loop(
                    &state,
                    None,
                    |ready| {
                        let _ = tx.send(ready);
                    },
                    &mut |_: &HostSnapshot| {},
                );
            });
            let first = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("first ready");
            let first_pid = state.child_id().expect("first pid");
            assert!(matches!(
                state.dispatch(HostCommand::Restart),
                HostCommandResult::Accepted { .. }
            ));
            let second = rx
                .recv_timeout(Duration::from_secs(15))
                .expect("second ready after restart");
            assert_ne!(first.token, second.token);
            let second_pid = state.child_id().expect("second pid");
            assert!(!pid_alive(first_pid));
            state.dispatch(HostCommand::GracefulStop);
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline && pid_alive(second_pid) {
                std::thread::sleep(Duration::from_millis(50));
            }
            assert!(!pid_alive(second_pid));
            state.latch_app_exit();
        });
    }

    #[test]
    fn dispatch_reload_while_ready_relaunches_via_exit_51() {
        let state = HostState::default();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                supervise_loop(
                    &state,
                    None,
                    |ready| {
                        let _ = tx.send(ready);
                    },
                    &mut |_: &HostSnapshot| {},
                );
            });
            let first = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("first ready");
            let first_pid = state.child_id().expect("first pid");
            assert!(matches!(
                state.dispatch(HostCommand::Reload),
                HostCommandResult::Accepted { .. }
            ));
            let second = rx
                .recv_timeout(Duration::from_secs(15))
                .expect("second ready after reload");
            assert_ne!(first.token, second.token);
            let second_pid = state.child_id().expect("second pid");
            assert!(!pid_alive(first_pid));
            state.dispatch(HostCommand::ForceKill);
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline && pid_alive(second_pid) {
                std::thread::sleep(Duration::from_millis(50));
            }
            assert!(!pid_alive(second_pid));
            state.latch_app_exit();
        });
    }

    // --- stable-window storm accounting ------------------------------------

    fn storm_state(window: Duration, cap: u32) -> HostState {
        HostState::with_storm_policy(StormPolicy {
            stable_window: window,
            initial_backoff: Duration::from_millis(10),
            max_backoff: Duration::from_millis(40),
            max_failures: cap,
        })
    }

    #[test]
    fn a_bridge_failure_is_recorded_in_the_snapshot_without_claiming_the_host_died() {
        // ⚠ THE REGRESSION for the zombie-\`Ready\` state. The peer's reader thread is
        // the only thing draining the child's stdout; when it stops, the process can
        // still be alive and still hold its ws port, so \`try_wait\` says "running",
        // the phase stays \`Ready\`, and the UI shows a healthy host that answers
        // nothing. Nothing else in the supervisor could see that, so the reason has
        // to reach the SNAPSHOT — which is what the UI and tray actually read.
        //
        // ⚠ And it must NOT be reported as \`Failed\`: a stopped reader is not proof of
        // death (\`LinkFailure::Read\` means the child may be alive with a broken
        // stdout), and declaring it dead here would race the restart logic.
        let state = storm_state(Duration::from_secs(30), 3);
        note_bridge_failure(
            &state,
            crate::kkrpc_peer::LinkFailure::Read {
                kind: std::io::ErrorKind::BrokenPipe,
                message: "the pipe is gone".into(),
                consecutive: 3,
            },
            false,
        );
        // No verdict to assert any more: the function reports and returns nothing, so
        // that the exit code keeps sole authority over the outcome. What matters here
        // is that the reason reached the snapshot and that nothing was declared dead.
        let snapshot = state.lifecycle_snapshot();
        let reason = snapshot
            .last_error
            .as_deref()
            .expect("the cause must reach the snapshot, not just stderr");
        assert!(
            reason.contains("bridge") && reason.contains("the pipe is gone"),
            "the reason must name the bridge and carry the peer's message, got: {reason}"
        );
        assert_ne!(
            snapshot.phase,
            HostLifecycleState::Failed,
            "a dead reader must not be reported as a dead host"
        );
    }

    #[test]
    fn a_closed_transport_is_recorded_and_the_exit_code_still_decides_the_outcome() {
        // ⚠ THE REGRESSION FOR A 28-MINUTE CI HANG, and it was MY bug.
        //
        // A clean EOF used to make the supervisor return `WatchOutcome::StdioLost`
        // straight away. That is wrong on two counts, and both are pinned here:
        //
        //   1. `StdioLost` is defined by an EXIT CODE (`HOST_STDIO_LOST_EXIT`) whose
        //      entire purpose is exemption from the restart-storm budget. Choosing it
        //      from a transport EOF — which carries no exit code — claims an exemption
        //      without the evidence for it.
        //   2. Every host exit closes stdout, so a deliberate exit 51 was ALSO seen
        //      here as `Closed`. Returning `StdioLost` skipped `note_exit`, the storm
        //      cap was never reached, and the supervisor relaunched forever.
        //
        // The hang itself was the join in `thread::scope`: the test that asserts the
        // cap panicked on the phase while the scope still had to join a supervisor
        // that never stopped, so the job's 30-minute wall killed it. This test is
        // deterministic ON PURPOSE — the bug was a RACE (it passed on the previous run
        // and hung on the next), so "I ran it six times and it passed" is not evidence.
        let state = storm_state(Duration::from_secs(30), 3);

        // The report is still recorded: that is the whole point of polling.
        note_bridge_failure(&state, crate::kkrpc_peer::LinkFailure::Closed, false);
        let recorded = state
            .lifecycle_snapshot()
            .last_error
            .expect("the cause must still reach the snapshot");
        assert!(
            recorded.contains("Closed"),
            "the recorded reason should name the failure kind: {recorded}"
        );

        // ⚠ And the OUTCOME is still the exit code's to decide. Reaching the storm cap
        // is what broke, so assert the classification directly: exit 51 must be a
        // billable restart request, never the exempt path.
        assert!(
            matches!(
                classify_exit_code(Some(HOST_RESTART_EXIT)),
                WatchOutcome::RestartRequested
            ),
            "a deliberate restart request must stay billable, whatever the reader saw"
        );
        assert!(
            !matches!(
                classify_exit_code(Some(HOST_RESTART_EXIT)),
                WatchOutcome::StdioLost
            ),
            "⚠ exit {HOST_RESTART_EXIT} must never take the exempt path: that is the \
             exemption a transport EOF has no evidence to award"
        );
    }

    #[test]
    fn a_bridge_failure_is_recorded_once_even_though_it_is_polled_forever() {
        // \`link_failure()\` is monotonic (the first failure wins), and the supervisor
        // polls it every 30 ms. Without the latch the same reason would be rewritten
        // into \`last_error\` for the life of the process — harmless-looking, but it
        // would also overwrite a LATER, more specific cause with a stale one.
        let state = storm_state(Duration::from_secs(30), 3);
        let first = crate::kkrpc_peer::LinkFailure::Read {
            kind: std::io::ErrorKind::BrokenPipe,
            message: "first cause".into(),
            consecutive: 1,
        };
        note_bridge_failure(&state, first, false);
        let recorded = state.lifecycle_snapshot().last_error;
        assert!(recorded.as_deref().unwrap_or("").contains("first cause"));

        // A later poll must not rewrite it.
        state.record_spawn_error("a different, later reason");
        note_bridge_failure(&state, crate::kkrpc_peer::LinkFailure::Closed, true);
        let after = state.lifecycle_snapshot().last_error;
        assert_eq!(
            after.as_deref(),
            Some("a different, later reason"),
            "an already-recorded failure must not overwrite a newer cause"
        );
    }

    #[test]
    fn the_bridge_failure_latch_does_not_outlive_its_generation() {
        // Per-generation state: the next generation's reader must be able to record
        // its OWN failure. \`clear()\` runs when the child goes away.
        let state = storm_state(Duration::from_secs(30), 3);
        {
            let mut inner = state.inner.lock().expect("host");
            inner.bridge_failure_recorded = true;
        }
        {
            let mut inner = state.inner.lock().expect("host");
            inner.clear();
        }
        let inner = state.inner.lock().expect("host");
        assert!(
            !inner.bridge_failure_recorded,
            "the latch must reset with the generation it describes"
        );
    }

    fn force_ready_at(state: &HostState, when: Instant) {
        let mut inner = state.inner.lock().expect("host");
        inner.ready_at = Some(when);
    }

    #[test]
    fn note_exit_forgives_streak_only_after_stable_window() {
        let state = HostState::default();
        let window = state.storm.stable_window;
        let long_ago = Instant::now() - window - Duration::from_secs(1);

        // Inside the window: crash bumps, exit 51 bumps.
        force_ready_at(&state, Instant::now());
        assert!(state.note_exit(false), "crash inside window backs off");
        assert_eq!(state.fail_streak(), 1);
        assert!(state.note_exit(true), "51 inside window backs off");
        assert_eq!(state.fail_streak(), 2);

        // After the window: crash forgives then bumps to one.
        force_ready_at(&state, long_ago);
        assert!(state.note_exit(false), "crash after window backs off");
        assert_eq!(
            state.fail_streak(),
            1,
            "window crash restarts the count at 1"
        );

        // After the window: exit 51 is legitimate, forgiven, no backoff.
        force_ready_at(&state, long_ago);
        assert!(!state.note_exit(true), "51 after window must not back off");
        assert_eq!(state.fail_streak(), 0, "legitimate 51 stays forgiven");
    }

    #[test]
    fn crash_inside_stable_window_accumulates_streak() {
        // Two rapid kills must reach attempt=2: ready no longer forgives the
        // streak, so the supervisor notices the crash loop.
        let state = HostState::default();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                supervise_loop(
                    &state,
                    None,
                    |ready| {
                        let _ = tx.send(ready);
                    },
                    &mut |_: &HostSnapshot| {},
                );
            });
            let _first = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("first ready");
            state.force_kill_running();
            let _second = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("second ready");
            state.force_kill_running();
            // Second kill lands inside the stable window (default 30s), so
            // the streak must have accumulated rather than reset at ready.
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                let snapshot = state.lifecycle_snapshot();
                if snapshot.attempt >= 2 {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            assert!(
                state.lifecycle_snapshot().attempt >= 2,
                "rapid crashes inside the stable window must accumulate; attempt={}",
                state.lifecycle_snapshot().attempt
            );
            state.latch_app_exit();
        });
    }

    #[test]
    fn exit_51_loop_inside_stable_window_reaches_failed_cap_and_start_recovers() {
        // A host that asks to restart (51) faster than the stable window is a
        // restart storm: it must hit the cap and park in Failed instead of
        // looping forever, and an explicit Start must recover it.
        let state = storm_state(Duration::from_secs(5), 3);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                supervise_loop(
                    &state,
                    None,
                    |ready| {
                        let _ = tx.send(ready);
                    },
                    &mut |_: &HostSnapshot| {},
                );
            });
            // Fire reload three times; the third 51 must cap the storm.
            for i in 0..3 {
                let ready = rx
                    .recv_timeout(Duration::from_secs(15))
                    .unwrap_or_else(|_| panic!("ready #{i} before cap"));
                assert!(matches!(
                    state.dispatch(HostCommand::Reload),
                    HostCommandResult::Accepted { .. }
                ));
                let _ = ready;
            }
            // After the capped reload, the supervisor must NOT produce a new
            // ready: it parks in Failed waiting for an explicit command.
            std::thread::sleep(Duration::from_millis(400));
            assert!(
                rx.try_recv().is_err(),
                "restart storm must cap into Failed, not keep relaunching"
            );
            assert_eq!(
                state.lifecycle_snapshot().phase,
                HostLifecycleState::Failed,
                "restart storm must end in Failed"
            );
            // A manual Start is the user intent that resets the streak.
            assert!(matches!(
                state.dispatch(HostCommand::Start),
                HostCommandResult::Accepted { .. }
            ));
            let recovered = rx
                .recv_timeout(Duration::from_secs(15))
                .expect("ready after manual start from Failed");
            assert!(recovered.port > 0);
            state.latch_app_exit();
        });
    }

    #[test]
    fn exit_51_after_stable_window_relaunches_without_penalty() {
        // A reload after stable runtime is a legitimate host restart request:
        // no streak accumulation, no backoff, immediate relaunch.
        let state = storm_state(Duration::from_millis(400), 3);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                supervise_loop(
                    &state,
                    None,
                    |ready| {
                        let _ = tx.send(ready);
                    },
                    &mut |_: &HostSnapshot| {},
                );
            });
            let first = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("first ready");
            // Wait out the stable window before asking for a restart.
            std::thread::sleep(Duration::from_millis(700));
            assert!(matches!(
                state.dispatch(HostCommand::Reload),
                HostCommandResult::Accepted { .. }
            ));
            let second = rx
                .recv_timeout(Duration::from_secs(15))
                .expect("second ready after stable reload");
            assert_ne!(first.token, second.token);
            assert_eq!(
                state.lifecycle_snapshot().attempt,
                0,
                "a legitimate 51 after the stable window must not count"
            );
            let pid = state.child_id().expect("pid");
            state.dispatch(HostCommand::ForceKill);
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline && pid_alive(pid) {
                std::thread::sleep(Duration::from_millis(50));
            }
            assert!(!pid_alive(pid));
            state.latch_app_exit();
        });
    }

    #[test]
    fn crash_after_stable_window_restarts_counting_from_one() {
        // A crash after stable runtime forgives the old streak, then counts
        // the fresh incident as attempt 1 (and still relaunches).
        let state = storm_state(Duration::from_millis(400), 3);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                supervise_loop(
                    &state,
                    None,
                    |ready| {
                        let _ = tx.send(ready);
                    },
                    &mut |_: &HostSnapshot| {},
                );
            });
            let first = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("first ready");
            std::thread::sleep(Duration::from_millis(700));
            state.force_kill_running();
            let second = rx
                .recv_timeout(Duration::from_secs(15))
                .expect("second ready after stable crash");
            assert_ne!(first.token, second.token);
            assert_eq!(
                state.lifecycle_snapshot().attempt,
                1,
                "crash after the stable window restarts the count at 1"
            );
            let pid = state.child_id().expect("pid");
            state.dispatch(HostCommand::ForceKill);
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline && pid_alive(pid) {
                std::thread::sleep(Duration::from_millis(50));
            }
            assert!(!pid_alive(pid));
            state.latch_app_exit();
        });
    }

    // --- host launch resolver ---------------------------------------------

    /// A throwaway directory with the given file names created inside.
    fn fake_resource_dir(names: &[&str]) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "vrcxk-resolver-test-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        for name in names {
            std::fs::write(dir.join(name), b"fake host binary").unwrap();
        }
        dir
    }

    #[test]
    fn find_packaged_host_prefers_bundled_name_then_dev_sidecar() {
        let triple_name = host_triple_suffixed_name();
        // Only the dev-placed sidecar (host-<triple>.exe) exists.
        let dir = fake_resource_dir(&[triple_name.as_str()]);
        let found = find_packaged_host(&dir).expect("dev sidecar found");
        assert_eq!(found.file_name().unwrap(), triple_name.as_str());
        // Both exist: the bundled name wins (Tauri-stripped host.exe).
        let dir2 = fake_resource_dir(&[triple_name.as_str(), packaged_host_name()]);
        let found2 = find_packaged_host(&dir2).expect("bundled found");
        assert_eq!(found2.file_name().unwrap(), packaged_host_name());
        // Nothing present: None.
        let dir3 = fake_resource_dir(&[]);
        assert!(find_packaged_host(&dir3).is_none());
        let _ = (dir, dir2, dir3);
    }

    #[test]
    fn resolve_host_launch_uses_explicit_bin_with_fail_fast() {
        // Present override -> compiled launch rooted at its parent dir.
        let dir = fake_resource_dir(&["custom-host.exe"]);
        let launch = resolve_host_launch_with(None, Some(dir.join("custom-host.exe")), None, false)
            .expect("explicit bin resolves");
        assert_eq!(launch.program, dir.join("custom-host.exe"));
        assert_eq!(launch.cwd, dir);
        assert!(launch.args.is_empty());

        // Missing override -> fast error, no silent fallback.
        let err = resolve_host_launch_with(None, Some(dir.join("nope.exe")), None, false)
            .expect_err("missing bin must fail");
        assert!(err.contains("VRCXK_HOST_BIN"), "{err}");
        let _ = dir;
    }

    #[test]
    fn resolve_host_launch_honors_cwd_override_only_when_it_exists() {
        let bin_dir = fake_resource_dir(&["custom-host.exe"]);
        let runtime_dir = fake_resource_dir(&["cordis.yml"]);
        let program = bin_dir.join("custom-host.exe");

        // Existing runtime dir override wins over the binary's directory.
        let launch = resolve_host_launch_with(
            None,
            Some(program.clone()),
            Some(runtime_dir.clone()),
            false,
        )
        .expect("resolves");
        assert_eq!(launch.cwd, runtime_dir);

        // A non-existent override is ignored (falls back to bin dir).
        let missing = runtime_dir.join("does-not-exist");
        let launch = resolve_host_launch_with(None, Some(program.clone()), Some(missing), false)
            .expect("resolves");
        assert_eq!(launch.cwd, bin_dir);
        let _ = (bin_dir, runtime_dir);
    }

    #[test]
    fn resolve_host_launch_defaults_to_dev_source_without_app() {
        // No override and no resource dir -> dev source launch (bun).
        // Requires the checked-out host/ tree (same precondition as the
        // existing spawn tests).
        let launch =
            resolve_host_launch_with(None, None, None, false).expect("dev source resolves");
        assert!(!launch.args.is_empty(), "source launch runs src/index.ts");
        assert_eq!(launch.args[0], "src/index.ts");
        assert!(launch.cwd.join("src/index.ts").is_file());
    }

    /// Regression: a `tauri dev` acceptance run had NO host at all because the
    /// dev build picked up the copy of the sidecar that `tauri dev` drops into
    /// the cargo target directory. That copy has no `cordis.yml` beside it, so
    /// the host died instantly and every shell → host notification reported
    /// "not delivered".
    #[test]
    fn dev_build_never_launches_the_target_dir_sidecar_copy() {
        let target_dir = fake_resource_dir(&[packaged_host_name()]);
        // A dev build must ignore it even though the binary is right there.
        let launch = resolve_host_launch_with(Some(target_dir.clone()), None, None, true)
            .expect("dev source resolves");
        assert_eq!(
            launch.args[0],
            "src/index.ts",
            "dev must run the source tree, not {}",
            target_dir.display()
        );
        assert_ne!(launch.cwd, target_dir);
        assert!(launch.cwd.join("src/index.ts").is_file());
        let _ = target_dir;
    }

    #[test]
    fn bundled_sidecar_is_used_only_with_its_runtime_entry() {
        // Both the sidecar and cordis.yml -> run the bundled sidecar in place.
        let bundle = fake_resource_dir(&[packaged_host_name(), HOST_RUNTIME_ENTRY]);
        let launch = resolve_host_launch_with(Some(bundle.clone()), None, None, false)
            .expect("bundle resolves");
        assert_eq!(launch.program, bundle.join(packaged_host_name()));
        assert_eq!(launch.cwd, bundle);
        assert!(launch.args.is_empty());

        // Sidecar without the runtime entry -> loud error, never a doomed spawn
        // loop that the UI would report as a host bug.
        let broken = fake_resource_dir(&[packaged_host_name()]);
        let err = resolve_host_launch_with(Some(broken.clone()), None, None, false)
            .expect_err("incomplete bundle must fail loudly");
        assert!(err.contains(HOST_RUNTIME_ENTRY), "{err}");
        assert!(err.contains("runtime files"), "{err}");
        let _ = (bundle, broken);
    }

    #[test]
    fn packaged_build_without_a_sidecar_falls_back_to_dev_source() {
        // Nothing bundled (e.g. `cargo run` of a release profile from the repo):
        // resolution still has to produce a launchable spec.
        let empty = fake_resource_dir(&[]);
        let launch = resolve_host_launch_with(Some(empty.clone()), None, None, false)
            .expect("falls back to source");
        assert_eq!(launch.args[0], "src/index.ts");
        let _ = empty;
    }

    // --- remaining supervisor branch coverage ------------------------------

    #[test]
    fn note_exit_window_boundary_is_inclusive() {
        // Just inside the window (elapsed < window) -> counts; just outside
        // (elapsed >= window) -> forgiven. Exercises the >= boundary exactly.
        let state = storm_state(Duration::from_millis(100), 8);
        // 99ms elapsed of a 100ms window: inside -> 51 counts.
        force_ready_at(&state, Instant::now() - Duration::from_millis(99));
        assert!(state.note_exit(true), "inside window counts and backs off");
        assert_eq!(state.fail_streak(), 1);
        // 100ms elapsed == window: outside -> forgiven, no count.
        force_ready_at(&state, Instant::now() - Duration::from_millis(100));
        assert!(!state.note_exit(true), "at window edge 51 is legitimate");
        assert_eq!(state.fail_streak(), 0);
    }

    #[test]
    fn host_reload_without_peer_records_last_error() {
        // Reload executed when no Ready host/peer exists must not panic and
        // must surface the failure on the snapshot.
        let state = HostState::default();
        state.host_reload();
        let snapshot = state.lifecycle_snapshot();
        assert!(
            snapshot
                .last_error
                .as_deref()
                .unwrap_or("")
                .contains("reload requested without a ready host"),
            "unexpected last_error: {:?}",
            snapshot.last_error
        );
    }

    /// A refused `ready` handshake must reach the SNAPSHOT, not only stderr.
    ///
    /// This is the substance of the review's fourth point: the tray and the UI
    /// read `lastError`, so a refusal whose reason never leaves `eprintln!` is
    /// invisible to the user — and the wait then reports the generic "host did
    /// not call ready() within 10s", which blames the host for the shell's own
    /// refusal.
    #[test]
    fn a_spawn_error_reaches_the_snapshot() {
        let state = HostState::default();
        state.record_spawn_error("host sent an unsupported ready handshake (schemaVersion=2)");
        let snapshot = state.lifecycle_snapshot();
        assert!(
            snapshot
                .last_error
                .as_deref()
                .unwrap_or("")
                .contains("unsupported ready handshake"),
            "unexpected last_error: {:?}",
            snapshot.last_error
        );
    }

    /// The recorded reason must stay inside the contract's `lastError` bound, or
    /// the snapshot would carry a value the schema's own guard rejects.
    #[test]
    fn a_spawn_error_is_clamped_to_the_contract_bound() {
        let state = HostState::default();
        state.record_spawn_error(&"x".repeat(10_000));
        let snapshot = state.lifecycle_snapshot();
        let len = snapshot.last_error.as_deref().unwrap_or("").chars().count();
        assert!(len <= 4096, "lastError must respect maxLength: got {len}");

        // Read the bound out of the SCHEMA rather than trusting the literal
        // above: if the contract tightens, this test is what notices.
        let schema: serde_json::Value = serde_json::from_str(include_str!(
            "../../contracts/host-lifecycle/v1/host-lifecycle.schema.json"
        ))
        .unwrap();
        let max = schema["properties"]["lastError"]["maxLength"]
            .as_u64()
            .expect("lastError.maxLength must be a number");
        assert!(
            (len as u64) <= max,
            "lastError length {len} exceeds the schema bound {max}"
        );
    }
}
