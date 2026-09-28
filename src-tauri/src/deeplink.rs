//! Bounded replay queue for deep links that arrive **before the host can accept them**.
//!
//! # Why this exists (issue #41 gap ④)
//!
//! `forward_deep_link` can only hand a URL to the host through `HostState::peer()`, which
//! is `None` until the sidecar's stdio channel is attached. The two windows where that is
//! *normal* are also the two that matter most:
//!
//!   - **Cold start** — the OS delivers `vrcxk://…` within milliseconds, because that URL
//!     is what launched us; the host (bun + Cordis + include tree) needs seconds.
//!   - **Host restart** — the shell stays up while the sidecar is reaped and replaced
//!     (crash, upgrade, `host_reload`), so the peer is briefly absent again.
//!
//! Before this queue, both windows **dropped the URL with no user-visible signal**: the
//! window appeared and nothing happened. Measured shape: the URL event precedes readiness
//! by ~1 s on a warm machine (see `docs/deep-link-decisions.md` §5.1).
//!
//! # ⚠ In memory only, deliberately
//!
//! A shell restart means the whole app was restarted, so replaying a URL from a *previous*
//! process would be a bigger surprise than dropping it. The queue therefore does not
//! survive the process, and there is no persistence to reason about.
//!
//! Owner decision (issue #41 §7.1 item 4, option A): bounded queue, replay on ready,
//! overflow drops the OLDEST batch and is logged, and the replay focuses the main window.

use std::collections::VecDeque;

/// Most URL batches held while no host is attached.
///
/// One *activation* can carry several URLs (`DeepLinkEvent.urls`), so the unit here is the
/// batch, not the URL. Eight is deliberately small: this is a startup-delay buffer, not a
/// mailbox — anything older than the last few user actions is stale by definition.
pub const PENDING_CAP: usize = 8;

/// A bounded FIFO of not-yet-delivered deep-link activations.
#[derive(Debug, Default)]
pub struct PendingDeepLinks {
    queue: VecDeque<Vec<String>>,
    dropped: u64,
}

impl PendingDeepLinks {
    /// Remember one activation's URLs.
    ///
    /// Returns how many **older** batches were dropped to make room (usually 0), so the
    /// caller can log the loss instead of hiding it. Dropping the oldest — rather than
    /// refusing the newest — is the owner's decision: the newest activation is the one the
    /// user just performed.
    pub fn push(&mut self, urls: Vec<String>) -> u64 {
        let mut dropped_now = 0;
        while self.queue.len() >= PENDING_CAP {
            self.queue.pop_front();
            self.dropped += 1;
            dropped_now += 1;
        }
        self.queue.push_back(urls);
        dropped_now
    }

    /// Take everything, **oldest first** — which is the replay order.
    pub fn drain(&mut self) -> Vec<Vec<String>> {
        self.queue.drain(..).collect()
    }

    pub fn len(&self) -> usize {
        self.queue.len()
    }

    /// Batches dropped by the cap since process start. Not reset by [`Self::drain`] — a
    /// replay should still be able to report that something was lost earlier.
    pub fn dropped(&self) -> u64 {
        self.dropped
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn batch(name: &str) -> Vec<String> {
        vec![format!("vrcxk://{name}")]
    }

    #[test]
    fn batches_replay_oldest_first() {
        let mut pending = PendingDeepLinks::default();
        assert_eq!(pending.push(batch("a")), 0);
        assert_eq!(pending.push(batch("b")), 0);
        assert_eq!(pending.len(), 2);
        assert_eq!(pending.drain(), vec![batch("a"), batch("b")]);
    }

    #[test]
    fn drain_leaves_nothing_behind() {
        let mut pending = PendingDeepLinks::default();
        pending.push(batch("a"));
        assert_eq!(pending.drain().len(), 1);
        assert_eq!(pending.len(), 0);
        assert!(pending.drain().is_empty());
    }

    /// The cap must drop the OLDEST batch, and must report it — a silent drop would put
    /// us back where we started (no signal that a link was ignored).
    #[test]
    fn overflowing_the_cap_drops_the_oldest_and_reports_it() {
        let mut pending = PendingDeepLinks::default();
        for i in 0..PENDING_CAP {
            assert_eq!(
                pending.push(batch(&format!("old{i}"))),
                0,
                "no drop before the cap"
            );
        }
        assert_eq!(pending.len(), PENDING_CAP);

        // One past the cap: exactly one (the oldest) goes.
        assert_eq!(pending.push(batch("newest")), 1);
        assert_eq!(
            pending.len(),
            PENDING_CAP,
            "the cap bounds the queue, it does not grow"
        );

        let replayed = pending.drain();
        assert_eq!(replayed.len(), PENDING_CAP);
        assert_eq!(replayed[0], batch("old1"), "old0 was the one dropped");
        assert_eq!(replayed[PENDING_CAP - 1], batch("newest"));
    }

    #[test]
    fn the_dropped_counter_survives_a_replay() {
        let mut pending = PendingDeepLinks::default();
        for i in 0..(PENDING_CAP + 3) {
            pending.push(batch(&format!("u{i}")));
        }
        assert_eq!(pending.dropped(), 3);
        let _ = pending.drain();
        assert_eq!(
            pending.dropped(),
            3,
            "a replay must still be able to report the loss"
        );
    }

    /// A batch is kept whole: dropping happens per activation, never per URL.
    #[test]
    fn a_multi_url_activation_stays_one_batch() {
        let mut pending = PendingDeepLinks::default();
        let urls = vec!["vrcxk://one".to_string(), "vrcxk://two".to_string()];
        pending.push(urls.clone());
        assert_eq!(pending.drain(), vec![urls]);
    }
}
