//! Resuming agents after a rate limit lifts: the data an agent carries and the decisions, as pure
//! functions with the clock passed in so they can be tested without waiting.
//!
//! The manager (`manager/limit_wait.rs`) gathers the facts, asks these functions, and acts.
//!
//! One *episode* starts when an agent's turn fails on a rate limit and ends when a turn of that
//! agent completes, the user takes over, or the attempts run out. Within it:
//!
//! 1. The reset time is read from the provider's message and the account's usage windows.
//! 2. At that time plus a small jitter (limits are not always lifted on the minute) the agent is
//!    sent a short "continue" prompt, flagged as automatic.
//! 3. If that turn hits the limit again, the next attempt waits for the newly reported reset (at
//!    least 15 minutes), then at least an hour. After [`MAX_ATTEMPTS`] attempts the agent is left
//!    for the user.
//! 4. With no reset time at all, the account's usage is re-read every tick (cheap, local); when it
//!    says nothing is used up the agent resumes, and [`UNKNOWN_PROBE_MS`] after the hit it tries once
//!    regardless.

use crate::model::{Agent, AgentStatus};
use serde::{Deserialize, Serialize};

/// What the automatic follow-up says. Short and plain: the agent has the whole conversation.
pub const RESUME_PROMPT: &str = "Your rate limit has reset. Please continue where you left off.";

/// Automatic attempts per episode before the agent is left for the user.
pub const MAX_ATTEMPTS: u8 = 3;
/// Limits are not always lifted exactly on the minute: wait a little past the reset time.
pub const MIN_JITTER_MS: i64 = 5_000;
pub const MAX_JITTER_MS: i64 = 45_000;
/// Gap between two resumes on one wave, so many agents do not all start at once.
pub const MIN_STAGGER_MS: i64 = 3_000;
pub const MAX_STAGGER_MS: i64 = 5_000;
/// Agents whose processes start at the same time, at most.
pub const MAX_STARTING: usize = 3;
/// With no reset time known, try once after this long.
pub const UNKNOWN_PROBE_MS: i64 = 15 * 60_000;
/// After a resume hit the limit again: the least wait before attempt 2 and attempt 3.
pub const RETRY_FLOOR_2_MS: i64 = 15 * 60_000;
pub const RETRY_FLOOR_3_MS: i64 = 60 * 60_000;
/// A "new" reset time closer than this to the failed attempt is the old one not yet lifted.
const STALE_RESET_MS: i64 = 60_000;
/// A wall clock that moved this much more than the timer did means sleep or a clock change.
pub const CLOCK_JUMP_MS: i64 = 30_000;
/// After waking, wait this long for the network before resuming anything.
pub const WAKE_GRACE_MS: i64 = 20_000;

/// What an agent waiting out a limit is doing about it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LimitResumeState {
    /// Kvistcode will resume it.
    #[default]
    Waiting,
    /// The user said "Don't auto-resume this one".
    Cancelled,
    /// The attempts ran out; it waits for the user.
    GaveUp,
}

/// Persisted with the agent, so a wait survives a restart.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LimitResume {
    pub state: LimitResumeState,
    /// Automatic resumes sent in this episode.
    pub attempts: u8,
    /// When the limit hit (unix ms).
    pub hit_at: i64,
    pub last_attempt_at: Option<i64>,
    /// With no reset time known: when to try anyway.
    pub probe_at: Option<i64>,
}

/// When the next attempt is due.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NextWait {
    /// Known time (unix ms, before jitter).
    pub resets_at: Option<i64>,
    /// Unknown time: try anyway at this moment.
    pub probe_at: Option<i64>,
}

/// The wait after `attempts` automatic resumes have been sent (0 = the limit just hit) and the
/// limit is on. `reported` is the reset time the latest message/usage gave.
///
/// `div` shortens every wait (1 normally; the tests use 1000 to see a whole episode in seconds).
pub fn next_wait(attempts: u8, reported: Option<i64>, now: i64, div: i64) -> NextWait {
    let (probe, floor2, floor3) = (
        UNKNOWN_PROBE_MS / div,
        RETRY_FLOOR_2_MS / div,
        RETRY_FLOOR_3_MS / div,
    );
    let future = reported.filter(|r| *r > now + STALE_RESET_MS / div);
    match attempts {
        0 => match reported {
            Some(r) => NextWait {
                resets_at: Some(r),
                probe_at: None,
            },
            None => NextWait {
                resets_at: None,
                probe_at: Some(now + probe),
            },
        },
        1 => NextWait {
            resets_at: Some(future.unwrap_or(now + floor2)),
            probe_at: None,
        },
        _ => NextWait {
            resets_at: Some(future.unwrap_or(0).max(now + floor3)),
            probe_at: None,
        },
    }
}

/// What the account's usage windows say, as far as this decision cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageView {
    /// Nothing known (no snapshot, or one from before the limit hit).
    Unknown,
    /// A fresh snapshot with nothing used up.
    Clear,
    /// Used up, until this time (if it says).
    Full(Option<i64>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Wait,
    /// The usage windows name the reset time the agent did not know.
    Learn(i64),
    Resume,
}

/// Whether a waiting agent is due. `jitter` is added to a known reset time.
pub fn decide(
    now: i64,
    resume: &LimitResume,
    resets_at: Option<i64>,
    jitter: i64,
    usage: UsageView,
) -> Decision {
    if resume.state != LimitResumeState::Waiting {
        return Decision::Wait;
    }
    if let Some(at) = resets_at {
        return if now >= at.saturating_add(jitter) {
            Decision::Resume
        } else {
            Decision::Wait
        };
    }
    match usage {
        UsageView::Clear => Decision::Resume,
        UsageView::Full(Some(r)) if r > now => Decision::Learn(r),
        _ => {
            if resume.probe_at.is_some_and(|p| now >= p) {
                Decision::Resume
            } else {
                Decision::Wait
            }
        }
    }
}

/// The facts about an agent that decide whether it may be resumed automatically.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Facts {
    pub status: AgentStatus,
    pub rate_limited: bool,
    pub archived: bool,
    pub budget_hold: bool,
    pub pending_permissions: i64,
}

impl Facts {
    pub fn of(a: &Agent) -> Facts {
        Facts {
            status: a.status,
            rate_limited: a.rate_limited,
            archived: a.archived,
            budget_hold: a.budget_hold.is_some(),
            pending_permissions: a.pending_permissions,
        }
    }
}

/// Only an agent stopped by the limit mid-work and not touched since: its last turn failed on the
/// limit (`rate_limited`, status error, which any new turn, stop or switch of account clears), it
/// has no turn in flight (its status is still the error) and isn't archived, held at a spending
/// limit or waiting on an approval. Messages the user queued before the limit are not in the way:
/// the resume is a new message, so the queue runs after it.
pub fn eligible(f: &Facts) -> bool {
    f.rate_limited
        && f.status == AgentStatus::Error
        && !f.archived
        && !f.budget_hold
        && f.pending_permissions == 0
}

fn fnv(parts: &[&[u8]]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for part in parts {
        for b in *part {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
        h ^= 0xff;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// How long past the reset time to wait for an account (the same for all its agents, so one wave
/// is one notification). Spread over [`MIN_JITTER_MS`, `MAX_JITTER_MS`] by account and reset time.
pub fn jitter_ms(account_id: &str, resets_at: i64) -> i64 {
    let span = (MAX_JITTER_MS - MIN_JITTER_MS + 1) as u64;
    MIN_JITTER_MS + (fnv(&[account_id.as_bytes(), &resets_at.to_le_bytes()]) % span) as i64
}

/// Start offsets (ms from the wave's start) for the agents of one wave: the first at once, then a
/// gap of 3-5 s each.
pub fn stagger_offsets(ids: &[String], seed: i64) -> Vec<i64> {
    let span = (MAX_STAGGER_MS - MIN_STAGGER_MS + 1) as u64;
    let mut at = 0;
    ids.iter()
        .enumerate()
        .map(|(i, id)| {
            if i > 0 {
                at += MIN_STAGGER_MS + (fnv(&[id.as_bytes(), &seed.to_le_bytes()]) % span) as i64;
            }
            at
        })
        .collect()
}

/// Tracks the wall clock against a timer, to notice sleep and clock changes.
#[derive(Debug, Default)]
pub struct ClockWatch {
    last_wall: Option<i64>,
    last_tick: Option<std::time::Instant>,
    quiet_until: i64,
}

impl ClockWatch {
    /// Nothing is resumed before `t` (unix ms): just after the app starts the network may not be
    /// up yet (a login launch), and the rest of startup should settle first.
    pub fn hold_until(&mut self, t: i64) {
        self.quiet_until = self.quiet_until.max(t);
    }

    /// Call once per tick (every `period_ms`) with the wall clock. Returns false while nothing
    /// should be resumed: just after waking (the network may not be back) or after the clock
    /// moved. Some systems' monotonic clocks keep counting through sleep, so a tick that comes
    /// far later than its period is a wake-up too.
    pub fn ready(&mut self, now_wall: i64, tick: std::time::Instant, period_ms: i64) -> bool {
        if let (Some(w), Some(t)) = (self.last_wall, self.last_tick) {
            let wall = now_wall - w;
            let timer = tick.saturating_duration_since(t).as_millis() as i64;
            if (wall - timer).abs() > CLOCK_JUMP_MS || wall < 0 || wall - period_ms > CLOCK_JUMP_MS
            {
                self.quiet_until = now_wall + WAKE_GRACE_MS;
            }
        }
        self.last_wall = Some(now_wall);
        self.last_tick = Some(tick);
        now_wall >= self.quiet_until
    }
}

/// "Resumed 3 agents after your rate limit reset" (or the agent's title when it is one).
pub fn resumed_body(count: usize, title: &str) -> String {
    if count == 1 {
        format!("Resumed {title} after your rate limit reset")
    } else {
        format!("Resumed {count} agents after your rate limit reset")
    }
}

/// Whether an attention body is the one above (the desktop plays it quietly).
pub fn is_resumed_body(body: &str) -> bool {
    body.starts_with("Resumed ") && body.ends_with(" after your rate limit reset")
}

/// "6:00 PM", or "Thu 6:00 PM" when not today, for a notice in the timeline.
pub fn describe_time<Tz: chrono::TimeZone>(at_ms: i64, now_ms: i64, tz: &Tz) -> String
where
    Tz::Offset: std::fmt::Display,
{
    use chrono::Datelike;
    let (Some(at), Some(now)) = (
        tz.timestamp_millis_opt(at_ms).single(),
        tz.timestamp_millis_opt(now_ms).single(),
    ) else {
        return "later".into();
    };
    let clock = at.format("%-I:%M %p").to_string();
    if at.date_naive() == now.date_naive() {
        clock
    } else if at
        .date_naive()
        .signed_duration_since(now.date_naive())
        .num_days()
        < 7
    {
        format!("{} {clock}", at.format("%a"))
    } else {
        format!("{} {} {clock}", at.format("%b"), at.day())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    const MIN: i64 = 60_000;

    fn waiting() -> LimitResume {
        LimitResume {
            hit_at: 1_000,
            ..LimitResume::default()
        }
    }

    fn facts() -> Facts {
        Facts {
            status: AgentStatus::Error,
            rate_limited: true,
            archived: false,
            budget_hold: false,
            pending_permissions: 0,
        }
    }

    #[test]
    fn only_an_agent_stopped_by_the_limit_is_eligible() {
        assert!(eligible(&facts()));
        for f in [
            Facts {
                rate_limited: false,
                ..facts()
            },
            Facts {
                status: AgentStatus::Stopped,
                ..facts()
            },
            Facts {
                status: AgentStatus::Idle,
                ..facts()
            },
            Facts {
                status: AgentStatus::Working,
                ..facts()
            },
            Facts {
                status: AgentStatus::Interrupted,
                ..facts()
            },
            Facts {
                archived: true,
                ..facts()
            },
            Facts {
                budget_hold: true,
                ..facts()
            },
            Facts {
                pending_permissions: 1,
                ..facts()
            },
        ] {
            assert!(!eligible(&f), "{f:?}");
        }
    }

    #[test]
    fn a_known_reset_waits_for_the_jitter_too() {
        let r = 10 * MIN;
        let j = 20_000;
        let w = waiting();
        assert_eq!(
            decide(r - 1, &w, Some(r), j, UsageView::Unknown),
            Decision::Wait
        );
        assert_eq!(
            decide(r, &w, Some(r), j, UsageView::Unknown),
            Decision::Wait
        );
        assert_eq!(
            decide(r + j - 1, &w, Some(r), j, UsageView::Unknown),
            Decision::Wait
        );
        assert_eq!(
            decide(r + j, &w, Some(r), j, UsageView::Unknown),
            Decision::Resume
        );
        assert_eq!(
            decide(r + 99 * MIN, &w, Some(r), j, UsageView::Unknown),
            Decision::Resume
        );
        // Usage that still says "full" does not hold back a passed reset time: the provider's
        // own time wins, and a re-failure is handled by the backoff.
        assert_eq!(
            decide(r + j, &w, Some(r), j, UsageView::Full(Some(r + MIN))),
            Decision::Resume
        );
    }

    #[test]
    fn cancelled_or_given_up_never_resumes() {
        for state in [LimitResumeState::Cancelled, LimitResumeState::GaveUp] {
            let w = LimitResume { state, ..waiting() };
            assert_eq!(
                decide(i64::MAX / 2, &w, Some(1), 0, UsageView::Clear),
                Decision::Wait
            );
            assert_eq!(
                decide(i64::MAX / 2, &w, None, 0, UsageView::Clear),
                Decision::Wait
            );
        }
    }

    #[test]
    fn unknown_reset_follows_usage_then_probes() {
        let now = 100 * MIN;
        let mut w = waiting();
        assert_eq!(decide(now, &w, None, 0, UsageView::Unknown), Decision::Wait);
        assert_eq!(
            decide(now, &w, None, 0, UsageView::Full(None)),
            Decision::Wait
        );
        assert_eq!(
            decide(now, &w, None, 0, UsageView::Full(Some(now + 5 * MIN))),
            Decision::Learn(now + 5 * MIN)
        );
        // A "reset" already in the past is no information.
        assert_eq!(
            decide(now, &w, None, 0, UsageView::Full(Some(now - 1))),
            Decision::Wait
        );
        assert_eq!(decide(now, &w, None, 0, UsageView::Clear), Decision::Resume);
        w.probe_at = Some(now + 30 * MIN);
        assert_eq!(
            decide(now + 29 * MIN, &w, None, 0, UsageView::Unknown),
            Decision::Wait
        );
        assert_eq!(
            decide(now + 30 * MIN, &w, None, 0, UsageView::Unknown),
            Decision::Resume
        );
    }

    #[test]
    fn waits_after_each_attempt() {
        let now = 1_000 * MIN;
        // First hit: the reported time, or probe later when none.
        assert_eq!(
            next_wait(0, Some(now + 90 * MIN), now, 1).resets_at,
            Some(now + 90 * MIN)
        );
        let unknown = next_wait(0, None, now, 1);
        assert_eq!(
            (unknown.resets_at, unknown.probe_at),
            (None, Some(now + UNKNOWN_PROBE_MS))
        );
        // The first resume failed: the new reset if it is really later, else 15 minutes.
        assert_eq!(
            next_wait(1, Some(now + 90 * MIN), now, 1).resets_at,
            Some(now + 90 * MIN)
        );
        assert_eq!(
            next_wait(1, Some(now + 10_000), now, 1).resets_at,
            Some(now + 15 * MIN),
            "the old time, not lifted yet"
        );
        assert_eq!(
            next_wait(1, Some(now - 5), now, 1).resets_at,
            Some(now + 15 * MIN)
        );
        assert_eq!(next_wait(1, None, now, 1).resets_at, Some(now + 15 * MIN));
        // The second failed: at least an hour.
        assert_eq!(
            next_wait(2, Some(now + 10 * MIN), now, 1).resets_at,
            Some(now + 60 * MIN)
        );
        assert_eq!(
            next_wait(2, Some(now + 300 * MIN), now, 1).resets_at,
            Some(now + 300 * MIN)
        );
        assert_eq!(next_wait(2, None, now, 1).resets_at, Some(now + 60 * MIN));
    }

    #[test]
    fn jitter_stays_in_range_and_is_stable_per_account_and_reset() {
        let mut seen = std::collections::HashSet::new();
        for i in 0..2000 {
            let j = jitter_ms(&format!("acct-{i}"), 1_790_000_000_000 + i);
            assert!((MIN_JITTER_MS..=MAX_JITTER_MS).contains(&j), "{j}");
            seen.insert(j / 1000);
        }
        assert!(seen.len() > 30, "should spread out: {}", seen.len());
        assert_eq!(jitter_ms("a", 5), jitter_ms("a", 5));
    }

    #[test]
    fn stagger_gaps_are_three_to_five_seconds() {
        let ids: Vec<String> = (0..40).map(|i| format!("agent-{i}")).collect();
        let offs = stagger_offsets(&ids, 123);
        assert_eq!(offs[0], 0);
        for pair in offs.windows(2) {
            let gap = pair[1] - pair[0];
            assert!((MIN_STAGGER_MS..=MAX_STAGGER_MS).contains(&gap), "{gap}");
        }
        assert!(stagger_offsets(&[], 1).is_empty());
    }

    #[test]
    fn clock_watch_holds_off_after_sleep_and_clock_changes() {
        let t0 = std::time::Instant::now();
        let mut w = ClockWatch::default();
        let s = std::time::Duration::from_secs;
        assert!(w.ready(1_000_000, t0, 5_000), "first tick");
        assert!(w.ready(1_005_000, t0 + s(5), 5_000), "a normal tick");
        // Slept for an hour: the wall clock jumped, the timer did not.
        assert!(
            !w.ready(1_005_000 + 3_600_000, t0 + s(10), 5_000),
            "just woke"
        );
        assert!(
            !w.ready(1_005_000 + 3_600_000 + 5_000, t0 + s(15), 5_000),
            "still in the grace"
        );
        assert!(
            w.ready(1_005_000 + 3_600_000 + 25_000, t0 + s(35), 5_000),
            "grace over"
        );
        // A hold from the start.
        let mut w = ClockWatch::default();
        w.hold_until(1_000_000 + 20_000);
        assert!(!w.ready(1_000_000, t0, 5_000));
        assert!(!w.ready(1_015_000, t0 + s(15), 5_000));
        assert!(w.ready(1_020_000, t0 + s(20), 5_000));
        let mut w = ClockWatch::default();
        assert!(w.ready(1_000_000, t0, 5_000));
        // The clock was set back.
        assert!(!w.ready(1_000_000, t0 + s(40), 5_000));
        // Set forward by a minute.
        let mut w = ClockWatch::default();
        assert!(w.ready(1_000_000, t0, 5_000));
        assert!(!w.ready(1_000_000 + 5_000 + 60_000, t0 + s(5), 5_000));
    }

    #[test]
    fn notification_wording() {
        assert_eq!(
            resumed_body(3, "x"),
            "Resumed 3 agents after your rate limit reset"
        );
        assert_eq!(
            resumed_body(1, "Fix login"),
            "Resumed Fix login after your rate limit reset"
        );
        assert!(is_resumed_body(&resumed_body(3, "x")));
        assert!(is_resumed_body(&resumed_body(1, "Fix login")));
        assert!(!is_resumed_body("Resumed work on the parser"));
        assert!(!is_resumed_body(
            "All 6 tests pass after your rate limit reset"
        ));
    }

    #[test]
    fn times_read_for_people() {
        let tz = FixedOffset::west_opt(5 * 3600).unwrap();
        // 2026-10-14 10:00 -05:00
        let now = 1_792_000_000_000_i64 - (1_792_000_000_000 % 86_400_000) + 15 * 3_600_000;
        assert_eq!(describe_time(now + 8 * 3_600_000, now, &tz), "6:00 PM");
        assert!(
            describe_time(now + 30 * 3_600_000, now, &tz).starts_with(|c: char| c.is_alphabetic())
        );
        assert!(
            describe_time(now + 30 * 3_600_000, now, &tz).ends_with("PM")
                || describe_time(now + 30 * 3_600_000, now, &tz).ends_with("AM")
        );
    }

    #[test]
    fn episode_round_trips_and_old_data_has_none() {
        let r = LimitResume {
            state: LimitResumeState::GaveUp,
            attempts: 3,
            hit_at: 7,
            last_attempt_at: Some(9),
            probe_at: None,
        };
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json["state"], "gave_up");
        assert_eq!(json["lastAttemptAt"], 9);
        assert_eq!(serde_json::from_value::<LimitResume>(json).unwrap(), r);
        // A partial object (a future or older shape) still reads.
        let p: LimitResume = serde_json::from_str(r#"{"attempts":2}"#).unwrap();
        assert_eq!(p.state, LimitResumeState::Waiting);
        assert_eq!(p.attempts, 2);
    }
}
