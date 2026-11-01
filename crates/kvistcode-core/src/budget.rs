//! Spending limits: for one agent, for all the agents of a project, and for everything
//! per day; each in cost (USD), tokens and/or turns. This is the pure part (what is over what,
//! which threshold was crossed exactly once, what a hold says); `manager/budgets.rs`
//! applies it (notices, desktop alerts, holding agents at a turn boundary).
//!
//! * 80% of a limit warns (calmly, a notice), 100% hits it. Each fires once per
//!   subject, and the daily ones once per local day.
//! * "Today" is counted from the increases seen since local midnight, so a count that
//!   goes down (a restarted process, a reset) never subtracts spend.
//! * A count that falls back under a threshold (or a raised limit) re-arms it.
//! * A turn is one completed prompt-and-reply (a failed or cancelled one doesn't count).
//!   It is the limit for subscription accounts, where no per-token cost is known.
//! * Cost is what each runtime reports. It is a bill for API-key accounts and an
//!   API-equivalent figure for subscriptions; runtimes that report none (local models)
//!   never move a cost limit, which is what a token limit is for.

use std::collections::HashMap;

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

/// Share of a limit at which the warning fires.
pub const WARN_AT: f64 = 0.8;

/// What happens when a limit is hit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BudgetAction {
    /// Alert only; the agents keep working.
    #[default]
    Notify,
    /// Hold the agent when its current turn ends (never in the middle of a tool call):
    /// queued messages stay queued, and nothing continues until you choose.
    Pause,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetLevel {
    #[default]
    Under,
    Warn,
    Hit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetScope {
    Daily,
    Project,
    Agent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetMetric {
    Cost,
    Tokens,
    /// Completed turns.
    Turns,
}

/// A limit in cost, tokens and/or turns (None = unlimited in that unit).
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BudgetCap {
    pub usd: Option<f64>,
    pub tokens: Option<i64>,
    pub turns: Option<i64>,
}

impl BudgetCap {
    pub fn is_empty(&self) -> bool {
        valid_cap(self.usd).is_none()
            && self.tokens.is_none_or(|t| t <= 0)
            && self.turns.is_none_or(|t| t <= 0)
    }

    /// This cap for one unit, if usable.
    pub fn get(&self, metric: BudgetMetric) -> Option<f64> {
        match metric {
            BudgetMetric::Cost => valid_cap(self.usd),
            BudgetMetric::Tokens => valid_cap(self.tokens.map(|t| t as f64)),
            BudgetMetric::Turns => valid_cap(self.turns.map(|t| t as f64)),
        }
    }

    /// A message for an unusable value, if any.
    pub fn problem(&self) -> Option<&'static str> {
        if self.usd.is_some_and(|c| !c.is_finite() || c <= 0.0) {
            return Some("a cost limit must be more than $0 (or empty for none)");
        }
        if self.tokens.is_some_and(|t| t <= 0) {
            return Some("a token limit must be more than 0 (or empty for none)");
        }
        if self.turns.is_some_and(|t| t <= 0) {
            return Some("a turn limit must be more than 0 (or empty for none)");
        }
        None
    }

    /// Drops unusable values; true if any were dropped.
    pub fn sanitize(&mut self) -> bool {
        let mut changed = false;
        if self.usd.is_some_and(|c| !c.is_finite() || c <= 0.0) {
            self.usd = None;
            changed = true;
        }
        if self.tokens.is_some_and(|t| t <= 0) {
            self.tokens = None;
            changed = true;
        }
        if self.turns.is_some_and(|t| t <= 0) {
            self.turns = None;
            changed = true;
        }
        changed
    }
}

/// The limits that apply to one agent right now.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Caps {
    pub daily: BudgetCap,
    pub project: BudgetCap,
    pub agent: BudgetCap,
}

impl Caps {
    pub fn cap(&self, scope: BudgetScope) -> &BudgetCap {
        match scope {
            BudgetScope::Daily => &self.daily,
            BudgetScope::Project => &self.project,
            BudgetScope::Agent => &self.agent,
        }
    }
}

/// A usable limit: finite and above zero.
pub fn valid_cap(cap: Option<f64>) -> Option<f64> {
    cap.filter(|c| c.is_finite() && *c > 0.0)
}

/// How far `spent` is into `cap`.
pub fn level(spent: f64, cap: Option<f64>) -> BudgetLevel {
    let Some(cap) = valid_cap(cap) else {
        return BudgetLevel::Under;
    };
    if spent >= cap {
        BudgetLevel::Hit
    } else if spent >= cap * WARN_AT {
        BudgetLevel::Warn
    } else {
        BudgetLevel::Under
    }
}

/// What has been spent in one scope.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Spend {
    pub usd: f64,
    pub tokens: f64,
    pub turns: f64,
}

impl Spend {
    fn get(&self, metric: BudgetMetric) -> f64 {
        match metric {
            BudgetMetric::Cost => self.usd,
            BudgetMetric::Tokens => self.tokens,
            BudgetMetric::Turns => self.turns,
        }
    }
}

/// One scope's spend against its limit, in one unit.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Reading {
    pub scope: BudgetScope,
    pub metric: BudgetMetric,
    pub spent: f64,
    /// None = no limit in this unit.
    pub cap: Option<f64>,
}

impl Reading {
    pub fn level(&self) -> BudgetLevel {
        if self.spent.is_finite() {
            level(self.spent, self.cap)
        } else {
            BudgetLevel::Under
        }
    }
}

const METRICS: [BudgetMetric; 3] = [
    BudgetMetric::Cost,
    BudgetMetric::Tokens,
    BudgetMetric::Turns,
];

/// Every scope and unit for one agent: the agent's own spend, its project's and the day's.
pub fn readings(caps: &Caps, agent: Spend, project: Spend, daily: Spend) -> Vec<Reading> {
    let mut out = Vec::with_capacity(9);
    for (scope, spend) in [
        (BudgetScope::Daily, daily),
        (BudgetScope::Project, project),
        (BudgetScope::Agent, agent),
    ] {
        for metric in METRICS {
            out.push(Reading {
                scope,
                metric,
                spent: spend.get(metric),
                cap: caps.cap(scope).get(metric),
            });
        }
    }
    out
}

/// Which thresholds already fired for one subject.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
struct Fired {
    warned: bool,
    hit: bool,
}

impl Fired {
    /// Records `now`; returns the level that was newly crossed, if any.
    fn advance(&mut self, now: BudgetLevel) -> Option<BudgetLevel> {
        match now {
            BudgetLevel::Under => {
                *self = Fired::default();
                None
            }
            BudgetLevel::Warn => {
                self.hit = false;
                (!std::mem::replace(&mut self.warned, true)).then_some(BudgetLevel::Warn)
            }
            BudgetLevel::Hit => {
                self.warned = true;
                (!std::mem::replace(&mut self.hit, true)).then_some(BudgetLevel::Hit)
            }
        }
    }
}

/// A threshold that was just crossed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Alert {
    pub scope: BudgetScope,
    pub metric: BudgetMetric,
    /// `Warn` or `Hit`.
    pub level: BudgetLevel,
    pub spent: f64,
    pub cap: f64,
}

fn subject(scope: BudgetScope) -> &'static str {
    match scope {
        BudgetScope::Daily => "daily limit",
        BudgetScope::Project => "project limit",
        BudgetScope::Agent => "agent limit",
    }
}

fn whose(scope: BudgetScope, agent_title: &str, project: &str) -> String {
    match scope {
        BudgetScope::Daily => "Today\u{2019}s spend".into(),
        BudgetScope::Project => format!("Project \u{201c}{project}\u{201d}"),
        BudgetScope::Agent => format!("\u{201c}{agent_title}\u{201d}"),
    }
}

/// "12.3k", "1.2M".
pub fn fmt_tokens(n: f64) -> String {
    if n >= 1_000_000.0 {
        format!("{:.1}M", n / 1_000_000.0)
    } else if n >= 1_000.0 {
        format!("{:.1}k", n / 1_000.0)
    } else {
        format!("{n:.0}")
    }
}

/// "$1.20 of $5.00", "12.3k of 50.0k tokens" or "7 of 20 turns".
pub fn amounts(metric: BudgetMetric, spent: f64, cap: f64) -> String {
    match metric {
        BudgetMetric::Cost => format!("${spent:.2} of ${cap:.2}"),
        BudgetMetric::Tokens => format!("{} of {} tokens", fmt_tokens(spent), fmt_tokens(cap)),
        BudgetMetric::Turns => format!("{spent:.0} of {cap:.0} turns"),
    }
}

/// Subscription accounts report an API-equivalent figure, not a bill; say so.
fn equivalent_note(metric: BudgetMetric, equivalent: bool) -> &'static str {
    if metric == BudgetMetric::Cost && equivalent {
        " (API-equivalent cost, not a bill)"
    } else {
        ""
    }
}

impl Alert {
    /// (title, body) for the notice. `equivalent`: the cost shown is an API-equivalent
    /// figure (a subscription account) rather than a bill.
    pub fn text(
        &self,
        action: BudgetAction,
        agent_title: &str,
        project: &str,
        equivalent: bool,
    ) -> (String, String) {
        let who = whose(self.scope, agent_title, project);
        let amounts = format!(
            "{}{}",
            amounts(self.metric, self.spent, self.cap),
            equivalent_note(self.metric, equivalent)
        );
        match self.level {
            BudgetLevel::Warn => (
                format!("Close to the {}", subject(self.scope)),
                format!("{who} is at {amounts} (80% of the limit)."),
            ),
            _ => {
                let tail = match action {
                    BudgetAction::Notify => "",
                    BudgetAction::Pause => {
                        " The agent finishes its current step, then waits for you."
                    }
                };
                (
                    format!("{} reached", capitalize(subject(self.scope))),
                    format!("{who} reached {amounts}.{tail}"),
                )
            }
        }
    }
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    c.next()
        .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
        .unwrap_or_default()
}

/// Why an agent is on hold: the limit it ran into. Shown as a "Needs you" item.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetHold {
    pub scope: BudgetScope,
    pub metric: BudgetMetric,
    pub spent: f64,
    pub cap: f64,
    /// When the hold began (ms since the epoch).
    pub since: i64,
}

impl BudgetHold {
    /// The most-exceeded limit among the readings that are hit.
    pub fn worst(readings: &[Reading], since: i64) -> Option<BudgetHold> {
        readings
            .iter()
            .filter(|r| r.level() == BudgetLevel::Hit)
            .filter_map(|r| r.cap.map(|cap| (r, cap)))
            .max_by(|(a, ac), (b, bc)| (a.spent / ac).total_cmp(&(b.spent / bc)))
            .map(|(r, cap)| BudgetHold {
                scope: r.scope,
                metric: r.metric,
                spent: r.spent,
                cap,
                since,
            })
    }

    /// (title, body) for the "Needs you" alert.
    pub fn text(&self, agent_title: &str, project: &str, equivalent: bool) -> (String, String) {
        let who = whose(self.scope, agent_title, project);
        let reached = match self.scope {
            BudgetScope::Agent => format!("\u{201c}{agent_title}\u{201d} reached its limit"),
            _ => format!("{who} reached the {}", subject(self.scope)),
        };
        (
            "Paused at a spending limit".into(),
            format!(
                "{reached}: {}{}. Raise the limit, continue once, or stop.",
                amounts(self.metric, self.spent, self.cap),
                equivalent_note(self.metric, equivalent)
            ),
        )
    }
}

/// What a user can do about an agent held at a spending limit.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum BudgetChoice {
    /// Raise the limit that was hit by `by` (dollars for a cost limit, tokens for a
    /// token limit, turns for a turn limit), then continue.
    Raise { by: f64 },
    /// Allow one more turn, even over the limit. It is checked again when that turn ends.
    ContinueOnce,
    /// Don't continue: drop the queued messages and dismiss the item.
    Stop,
}

/// Today's spend against the daily limits, for the UI.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetStatus {
    /// Local date, `YYYY-MM-DD`.
    pub day: String,
    pub today_usd: f64,
    pub daily_budget_usd: Option<f64>,
    pub today_tokens: i64,
    pub daily_budget_tokens: Option<i64>,
    pub today_turns: i64,
    pub daily_budget_turns: Option<i64>,
    /// The worse of the cost and token levels.
    pub level: BudgetLevel,
}

/// Spend seen today and which alerts already fired. Persisted by the caller so a
/// restart doesn't forget the day or repeat an alert.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Tracker {
    day: String,
    today_usd: f64,
    today_tokens: f64,
    today_turns: f64,
    /// Keyed by `scope:subject:metric`.
    fired: HashMap<String, Fired>,
}

impl Tracker {
    fn roll(&mut self, today: NaiveDate) {
        let day = today.to_string();
        if self.day != day {
            self.day = day;
            self.today_usd = 0.0;
            self.today_tokens = 0.0;
            self.today_turns = 0.0;
            self.fired.retain(|k, _| !k.starts_with("daily:"));
        }
    }

    /// Adds an increase in what the agents spent. Decreases and junk are ignored.
    pub fn add_spend(&mut self, today: NaiveDate, usd: f64, tokens: f64) {
        self.roll(today);
        if usd.is_finite() && usd > 0.0 {
            self.today_usd += usd;
        }
        if tokens.is_finite() && tokens > 0.0 {
            self.today_tokens += tokens;
        }
    }

    /// Adds `n` completed turns to the day.
    pub fn add_turns(&mut self, today: NaiveDate, n: u32) {
        self.roll(today);
        self.today_turns += f64::from(n);
    }

    /// Today's spend (zero when the last observation was another day).
    pub fn today(&self, today: NaiveDate) -> Spend {
        if self.day == today.to_string() {
            Spend {
                usd: self.today_usd,
                tokens: self.today_tokens,
                turns: self.today_turns,
            }
        } else {
            Spend::default()
        }
    }

    /// The thresholds `readings` (for `agent_id` in `project`) newly crossed, daily
    /// first. Hits are reported once until the count falls back under the limit.
    pub fn alerts(
        &mut self,
        today: NaiveDate,
        agent_id: &str,
        project: &str,
        readings: &[Reading],
    ) -> Vec<Alert> {
        self.roll(today);
        let mut out = Vec::new();
        for r in readings {
            let metric = match r.metric {
                BudgetMetric::Cost => "cost",
                BudgetMetric::Tokens => "tokens",
                BudgetMetric::Turns => "turns",
            };
            let key = match r.scope {
                BudgetScope::Daily => format!("daily::{metric}"),
                BudgetScope::Project => format!("project:{project}:{metric}"),
                BudgetScope::Agent => format!("agent:{agent_id}:{metric}"),
            };
            let fired = self.fired.entry(key.clone()).or_default();
            if let Some(l) = fired.advance(r.level()) {
                out.push(Alert {
                    scope: r.scope,
                    metric: r.metric,
                    level: l,
                    spent: r.spent,
                    cap: r.cap.unwrap_or_default(),
                });
            }
            if *fired == Fired::default() {
                self.fired.remove(&key);
            }
        }
        out
    }

    pub fn status(&self, today: NaiveDate, daily: &BudgetCap) -> BudgetStatus {
        let spend = self.today(today);
        let worst = METRICS
            .into_iter()
            .map(|m| level(spend.get(m), daily.get(m)))
            .max_by_key(|l| match l {
                BudgetLevel::Under => 0,
                BudgetLevel::Warn => 1,
                BudgetLevel::Hit => 2,
            })
            .unwrap_or_default();
        BudgetStatus {
            day: today.to_string(),
            today_usd: spend.usd,
            daily_budget_usd: daily.get(BudgetMetric::Cost),
            today_tokens: spend.tokens.round() as i64,
            daily_budget_tokens: daily.tokens.filter(|t| *t > 0),
            today_turns: spend.turns.round() as i64,
            daily_budget_turns: daily.turns.filter(|t| *t > 0),
            level: worst,
        }
    }
}

/// Whether an interrupted agent must stay stopped at startup instead of auto-resuming
/// into more spend: a limit with the Pause action is already hit.
pub fn blocks_resume(action: BudgetAction, readings: &[Reading]) -> bool {
    action == BudgetAction::Pause && readings.iter().any(|r| r.level() == BudgetLevel::Hit)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 3, d).unwrap()
    }

    fn usd(c: f64) -> BudgetCap {
        BudgetCap {
            usd: Some(c),
            ..Default::default()
        }
    }

    fn tokens(t: i64) -> BudgetCap {
        BudgetCap {
            tokens: Some(t),
            ..Default::default()
        }
    }

    fn turns(t: i64) -> BudgetCap {
        BudgetCap {
            turns: Some(t),
            ..Default::default()
        }
    }

    fn caps(daily: BudgetCap, project: BudgetCap, agent: BudgetCap) -> Caps {
        Caps {
            daily,
            project,
            agent,
        }
    }

    fn spend(usd: f64, tokens: f64) -> Spend {
        Spend {
            usd,
            tokens,
            turns: 0.0,
        }
    }

    fn levels(alerts: &[Alert]) -> Vec<(BudgetScope, BudgetMetric, BudgetLevel)> {
        alerts
            .iter()
            .map(|a| (a.scope, a.metric, a.level))
            .collect()
    }

    /// One observation of agent `a` in project `p`: the way `manager/budgets.rs` uses it.
    fn observe(
        t: &mut Tracker,
        d: u32,
        agent: &str,
        old: f64,
        new: f64,
        c: Caps,
        project: Spend,
    ) -> Vec<Alert> {
        t.add_spend(day(d), new - old, 0.0);
        let r = readings(&c, spend(new, 0.0), project, t.today(day(d)));
        t.alerts(day(d), agent, "p", &r)
    }

    const NONE: BudgetCap = BudgetCap {
        usd: None,
        tokens: None,
        turns: None,
    };

    #[test]
    fn levels_at_80_and_100_percent() {
        assert_eq!(level(7.99, Some(10.0)), BudgetLevel::Under);
        assert_eq!(level(8.0, Some(10.0)), BudgetLevel::Warn);
        assert_eq!(level(9.99, Some(10.0)), BudgetLevel::Warn);
        assert_eq!(level(10.0, Some(10.0)), BudgetLevel::Hit);
        assert_eq!(level(50.0, Some(10.0)), BudgetLevel::Hit);
    }

    #[test]
    fn no_limit_means_disabled() {
        assert_eq!(level(1e9, None), BudgetLevel::Under);
        assert_eq!(level(5.0, Some(0.0)), BudgetLevel::Under);
        assert_eq!(level(5.0, Some(-1.0)), BudgetLevel::Under);
        assert_eq!(level(5.0, Some(f64::NAN)), BudgetLevel::Under);
        let mut t = Tracker::default();
        let c = Caps::default();
        assert!(observe(&mut t, 1, "a", 0.0, 100.0, c, spend(100.0, 0.0)).is_empty());
        assert!(BudgetCap::default().is_empty());
        assert!(tokens(0).is_empty() && usd(-1.0).is_empty());
    }

    #[test]
    fn agent_alerts_fire_once() {
        let mut t = Tracker::default();
        let c = caps(NONE, NONE, usd(10.0));
        let p = Spend::default();
        assert!(observe(&mut t, 1, "a", 0.0, 5.0, c, p).is_empty());
        let a = observe(&mut t, 1, "a", 5.0, 8.5, c, p);
        assert_eq!(
            levels(&a),
            [(BudgetScope::Agent, BudgetMetric::Cost, BudgetLevel::Warn)]
        );
        assert!(observe(&mut t, 1, "a", 8.5, 9.0, c, p).is_empty());
        let a = observe(&mut t, 1, "a", 9.0, 10.2, c, p);
        assert_eq!(
            levels(&a),
            [(BudgetScope::Agent, BudgetMetric::Cost, BudgetLevel::Hit)]
        );
        assert_eq!(a[0].cap, 10.0);
        assert!(observe(&mut t, 1, "a", 10.2, 30.0, c, p).is_empty());
    }

    #[test]
    fn jumping_past_both_thresholds_fires_hit_only() {
        let mut t = Tracker::default();
        let a = observe(
            &mut t,
            1,
            "a",
            0.0,
            12.0,
            caps(NONE, NONE, usd(10.0)),
            Spend::default(),
        );
        assert_eq!(
            levels(&a),
            [(BudgetScope::Agent, BudgetMetric::Cost, BudgetLevel::Hit)]
        );
    }

    #[test]
    fn agents_are_independent() {
        let mut t = Tracker::default();
        let c = caps(NONE, NONE, usd(10.0));
        let p = Spend::default();
        assert_eq!(observe(&mut t, 1, "a", 0.0, 11.0, c, p).len(), 1);
        assert_eq!(observe(&mut t, 1, "b", 0.0, 11.0, c, p).len(), 1);
    }

    #[test]
    fn daily_total_sums_increases_across_agents() {
        let mut t = Tracker::default();
        let c = caps(usd(10.0), NONE, NONE);
        let p = Spend::default();
        assert!(observe(&mut t, 1, "a", 100.0, 104.0, c, p).is_empty());
        let a = observe(&mut t, 1, "b", 0.0, 4.5, c, p);
        assert_eq!(
            levels(&a),
            [(BudgetScope::Daily, BudgetMetric::Cost, BudgetLevel::Warn)]
        );
        let a = observe(&mut t, 1, "a", 104.0, 106.0, c, p);
        assert_eq!(
            levels(&a),
            [(BudgetScope::Daily, BudgetMetric::Cost, BudgetLevel::Hit)]
        );
        assert!((a[0].spent - 10.5).abs() < 1e-9);
    }

    #[test]
    fn daily_alerts_reset_at_midnight() {
        let mut t = Tracker::default();
        let c = caps(usd(10.0), NONE, NONE);
        let p = Spend::default();
        assert_eq!(observe(&mut t, 1, "a", 0.0, 11.0, c, p).len(), 1);
        assert!(observe(&mut t, 1, "a", 11.0, 12.0, c, p).is_empty());
        // The next day starts from zero and can alert again.
        assert!(observe(&mut t, 2, "a", 12.0, 13.0, c, p).is_empty());
        assert!((t.today(day(2)).usd - 1.0).abs() < 1e-9);
        let a = observe(&mut t, 2, "a", 13.0, 22.0, c, p);
        assert_eq!(
            levels(&a),
            [(BudgetScope::Daily, BudgetMetric::Cost, BudgetLevel::Hit)]
        );
    }

    #[test]
    fn agent_alerts_do_not_repeat_at_midnight() {
        let mut t = Tracker::default();
        let c = caps(NONE, NONE, usd(10.0));
        let p = Spend::default();
        assert_eq!(observe(&mut t, 1, "a", 0.0, 11.0, c, p).len(), 1);
        assert!(observe(&mut t, 2, "a", 11.0, 11.5, c, p).is_empty());
    }

    #[test]
    fn today_reads_zero_on_another_day() {
        let mut t = Tracker::default();
        t.add_spend(day(1), 3.0, 100.0);
        assert!((t.today(day(1)).usd - 3.0).abs() < 1e-9);
        assert_eq!(t.today(day(2)), Spend::default());
        let s = t.status(
            day(2),
            &BudgetCap {
                usd: Some(5.0),
                tokens: Some(1000),
                turns: None,
            },
        );
        assert_eq!(
            (
                s.today_usd,
                s.daily_budget_usd,
                s.today_tokens,
                s.daily_budget_tokens
            ),
            (0.0, Some(5.0), 0, Some(1000))
        );
    }

    #[test]
    fn a_count_that_drops_never_subtracts_and_rearms() {
        let mut t = Tracker::default();
        let c = caps(usd(100.0), NONE, usd(10.0));
        let p = Spend::default();
        assert_eq!(observe(&mut t, 1, "a", 0.0, 9.0, c, p).len(), 1);
        // Reset to zero: spend today stays, the agent's thresholds re-arm.
        assert!(observe(&mut t, 1, "a", 9.0, 0.0, c, p).is_empty());
        assert!((t.today(day(1)).usd - 9.0).abs() < 1e-9);
        let a = observe(&mut t, 1, "a", 0.0, 9.0, c, p);
        assert_eq!(
            levels(&a),
            [(BudgetScope::Agent, BudgetMetric::Cost, BudgetLevel::Warn)]
        );
        // NaN is ignored.
        assert!(observe(&mut t, 1, "a", 9.0, f64::NAN, c, p).is_empty());
        assert!((t.today(day(1)).usd - 18.0).abs() < 1e-9);
    }

    #[test]
    fn raising_a_limit_rearms_it() {
        let mut t = Tracker::default();
        let p = Spend::default();
        assert_eq!(
            observe(&mut t, 1, "a", 0.0, 11.0, caps(NONE, NONE, usd(10.0)), p).len(),
            1
        );
        assert!(observe(&mut t, 1, "a", 11.0, 12.0, caps(NONE, NONE, usd(50.0)), p).is_empty());
        let a = observe(&mut t, 1, "a", 12.0, 41.0, caps(NONE, NONE, usd(50.0)), p);
        assert_eq!(
            levels(&a),
            [(BudgetScope::Agent, BudgetMetric::Cost, BudgetLevel::Warn)]
        );
    }

    #[test]
    fn project_and_token_limits_alert_on_their_own() {
        let mut t = Tracker::default();
        let c = caps(NONE, usd(20.0), tokens(1_000));
        t.add_spend(day(1), 1.0, 900.0);
        let r = readings(&c, spend(1.0, 900.0), spend(18.0, 900.0), t.today(day(1)));
        let a = t.alerts(day(1), "a", "/work/app", &r);
        assert_eq!(
            levels(&a),
            [
                (BudgetScope::Project, BudgetMetric::Cost, BudgetLevel::Warn),
                (BudgetScope::Agent, BudgetMetric::Tokens, BudgetLevel::Warn),
            ]
        );
        // Another project's agents have their own project state.
        let other = readings(&c, spend(0.0, 0.0), spend(18.0, 0.0), t.today(day(1)));
        let a = t.alerts(day(1), "b", "/work/other", &other);
        assert_eq!(
            levels(&a),
            [(BudgetScope::Project, BudgetMetric::Cost, BudgetLevel::Warn)]
        );
        // The same state again says nothing.
        assert!(t.alerts(day(1), "a", "/work/app", &r).is_empty());
    }

    #[test]
    fn a_removed_limit_forgets_what_fired() {
        let mut t = Tracker::default();
        let p = Spend::default();
        assert_eq!(
            observe(&mut t, 1, "a", 0.0, 11.0, caps(NONE, NONE, usd(10.0)), p).len(),
            1
        );
        assert!(observe(&mut t, 1, "a", 11.0, 12.0, Caps::default(), p).is_empty());
        // Set again later: it is a fresh limit and alerts again.
        assert_eq!(
            observe(&mut t, 1, "a", 12.0, 13.0, caps(NONE, NONE, usd(10.0)), p).len(),
            1
        );
    }

    #[test]
    fn survives_a_round_trip() {
        let mut t = Tracker::default();
        let c = caps(usd(10.0), NONE, usd(10.0));
        let p = Spend::default();
        observe(&mut t, 1, "a", 0.0, 11.0, c, p);
        let mut back: Tracker = serde_json::from_str(&serde_json::to_string(&t).unwrap()).unwrap();
        assert!(observe(&mut back, 1, "a", 11.0, 12.0, c, p).is_empty());
        assert!(serde_json::from_str::<Tracker>("{}").is_ok());
        // A file from before project and token limits still loads.
        assert!(serde_json::from_str::<Tracker>(
            r#"{"day":"2026-03-01","today_usd":2.0,"daily":{"warned":true,"hit":false},"agents":{}}"#
        )
        .is_ok());
    }

    #[test]
    fn alert_text_names_the_outcome() {
        let hit = Alert {
            scope: BudgetScope::Agent,
            metric: BudgetMetric::Cost,
            level: BudgetLevel::Hit,
            spent: 10.5,
            cap: 10.0,
        };
        let (title, body) = hit.text(BudgetAction::Pause, "Fix tests", "app", false);
        assert_eq!(title, "Agent limit reached");
        assert!(body.contains("$10.50 of $10.00") && body.contains("then waits for you"));
        assert!(!body.contains("API-equivalent"));
        let (_, body) = hit.text(BudgetAction::Notify, "Fix tests", "app", true);
        assert!(!body.contains("waits"));
        assert!(body.contains("API-equivalent cost, not a bill"), "{body}");
        let warn = Alert {
            scope: BudgetScope::Daily,
            metric: BudgetMetric::Tokens,
            level: BudgetLevel::Warn,
            spent: 800_000.0,
            cap: 1_000_000.0,
        };
        let (title, body) = warn.text(BudgetAction::Pause, "x", "app", true);
        assert_eq!(title, "Close to the daily limit");
        // Tokens are exact counts, never labelled as money.
        assert!(
            body.contains("800.0k of 1.0M tokens") && !body.contains('$'),
            "{body}"
        );
    }

    #[test]
    fn hold_picks_the_most_exceeded_limit_and_explains_it() {
        let c = caps(usd(10.0), usd(100.0), tokens(1_000));
        let r = readings(&c, spend(2.0, 1_500.0), spend(120.0, 0.0), spend(11.0, 0.0));
        let hold = BudgetHold::worst(&r, 42).unwrap();
        // Project 120/100 = 1.2x, daily 1.1x, agent tokens 1.5x.
        assert_eq!(
            (hold.scope, hold.metric),
            (BudgetScope::Agent, BudgetMetric::Tokens)
        );
        assert_eq!((hold.spent, hold.cap, hold.since), (1_500.0, 1_000.0, 42));
        let (title, body) = hold.text("Fix tests", "app", true);
        assert_eq!(title, "Paused at a spending limit");
        assert!(
            body.contains("1.5k of 1.0k tokens") && body.contains("continue once"),
            "{body}"
        );
        assert!(BudgetHold::worst(
            &readings(&c, spend(1.0, 1.0), spend(1.0, 0.0), spend(1.0, 0.0)),
            0
        )
        .is_none());
        // A cost limit hit on a subscription is flagged as an equivalent.
        let cost = BudgetHold {
            scope: BudgetScope::Project,
            metric: BudgetMetric::Cost,
            spent: 25.0,
            cap: 20.0,
            since: 0,
        };
        assert!(cost.text("a", "app", true).1.contains("API-equivalent"));
        assert!(!cost.text("a", "app", false).1.contains("API-equivalent"));
    }

    #[test]
    fn resume_is_blocked_only_by_a_hit_limit_with_pause() {
        let c = caps(usd(10.0), NONE, usd(5.0));
        let hit_agent = readings(&c, spend(6.0, 0.0), Spend::default(), spend(1.0, 0.0));
        let hit_day = readings(&c, spend(1.0, 0.0), Spend::default(), spend(10.0, 0.0));
        let near = readings(&c, spend(4.5, 0.0), Spend::default(), spend(8.5, 0.0));
        assert!(blocks_resume(BudgetAction::Pause, &hit_agent));
        assert!(blocks_resume(BudgetAction::Pause, &hit_day));
        assert!(!blocks_resume(BudgetAction::Pause, &near));
        assert!(!blocks_resume(BudgetAction::Notify, &hit_agent));
        let none = readings(
            &Caps::default(),
            spend(60.0, 0.0),
            spend(60.0, 0.0),
            spend(100.0, 0.0),
        );
        assert!(!blocks_resume(BudgetAction::Pause, &none));
    }

    #[test]
    fn caps_report_problems_and_clean_up() {
        let mut bad = BudgetCap {
            usd: Some(-1.0),
            tokens: Some(0),
            turns: Some(-3),
        };
        assert!(bad.problem().is_some());
        assert!(bad.sanitize());
        assert!(bad.is_empty() && bad.problem().is_none() && !bad.sanitize());
        assert_eq!(tokens(500).get(BudgetMetric::Tokens), Some(500.0));
        assert_eq!(tokens(500).get(BudgetMetric::Cost), None);
    }

    #[test]
    fn status_shows_the_worse_unit() {
        let mut t = Tracker::default();
        t.add_spend(day(1), 1.0, 950.0);
        let s = t.status(
            day(1),
            &BudgetCap {
                usd: Some(100.0),
                tokens: Some(1000),
                turns: None,
            },
        );
        assert_eq!(s.level, BudgetLevel::Warn);
        assert_eq!(s.today_tokens, 950);
    }

    /// An agent at `n` turns, in a project at `project_turns`, on a day at `daily_turns`.
    fn turn_readings(c: &Caps, n: f64, project_turns: f64, daily_turns: f64) -> Vec<Reading> {
        let at = |turns| Spend {
            turns,
            ..Spend::default()
        };
        readings(c, at(n), at(project_turns), at(daily_turns))
    }

    #[test]
    fn turn_limits_warn_at_80_and_hit_at_100_percent() {
        let c = caps(NONE, NONE, turns(20));
        let r = |n| turn_readings(&c, n, n, n);
        let level_of = |n| {
            r(n).into_iter()
                .find(|x| x.metric == BudgetMetric::Turns && x.scope == BudgetScope::Agent)
                .unwrap()
                .level()
        };
        assert_eq!(level_of(15.0), BudgetLevel::Under);
        assert_eq!(level_of(16.0), BudgetLevel::Warn);
        assert_eq!(level_of(19.0), BudgetLevel::Warn);
        assert_eq!(level_of(20.0), BudgetLevel::Hit);
        // A turn limit is its own unit: it never reads cost or tokens.
        assert_eq!(turns(20).get(BudgetMetric::Cost), None);
        assert_eq!(turns(20).get(BudgetMetric::Tokens), None);
        assert_eq!(turns(20).get(BudgetMetric::Turns), Some(20.0));
        assert!(!turns(20).is_empty() && turns(0).is_empty());
    }

    #[test]
    fn turn_alerts_fire_once_per_threshold_and_are_worded_in_turns() {
        let mut t = Tracker::default();
        let c = caps(NONE, NONE, turns(10));
        let mut fire = |n: f64| {
            let r = turn_readings(&c, n, n, n);
            t.alerts(day(1), "a", "p", &r)
        };
        assert!(fire(7.0).is_empty());
        let warn = fire(8.0);
        assert_eq!(
            levels(&warn),
            [(BudgetScope::Agent, BudgetMetric::Turns, BudgetLevel::Warn)]
        );
        assert!(fire(9.0).is_empty());
        let hit = fire(10.0);
        assert_eq!(
            levels(&hit),
            [(BudgetScope::Agent, BudgetMetric::Turns, BudgetLevel::Hit)]
        );
        let (title, body) = warn[0].text(BudgetAction::Pause, "Fix tests", "app", true);
        assert_eq!(title, "Close to the agent limit");
        // Turns are counts: no dollar sign, and never the "API-equivalent" note.
        assert!(
            body.contains("8 of 10 turns") && !body.contains('$') && !body.contains("equivalent"),
            "{body}"
        );
        assert!(fire(10.0).is_empty());
    }

    #[test]
    fn the_day_counts_turns_and_starts_over_at_midnight() {
        let mut t = Tracker::default();
        let c = caps(turns(3), NONE, NONE);
        t.add_turns(day(1), 2);
        t.add_turns(day(1), 1);
        assert_eq!(t.today(day(1)).turns, 3.0);
        let r = readings(&c, Spend::default(), Spend::default(), t.today(day(1)));
        let a = t.alerts(day(1), "a", "p", &r);
        assert_eq!(
            levels(&a),
            [(BudgetScope::Daily, BudgetMetric::Turns, BudgetLevel::Hit)]
        );
        assert_eq!(t.today(day(2)).turns, 0.0);
        t.add_turns(day(2), 1);
        assert_eq!(t.today(day(2)).turns, 1.0);
        let s = t.status(day(2), &turns(5));
        assert_eq!((s.today_turns, s.daily_budget_turns), (1, Some(5)));
        assert_eq!(s.level, BudgetLevel::Under);
        t.add_turns(day(2), 3);
        assert_eq!(t.status(day(2), &turns(5)).level, BudgetLevel::Warn);
    }

    #[test]
    fn a_turn_hold_says_how_many_turns_and_ranks_by_how_far_over() {
        let c = caps(NONE, turns(10), turns(5));
        // Agent 6/5 = 1.2x, project 11/10 = 1.1x.
        let r = turn_readings(&c, 6.0, 11.0, 0.0);
        let hold = BudgetHold::worst(&r, 7).unwrap();
        assert_eq!(
            (hold.scope, hold.metric, hold.spent, hold.cap),
            (BudgetScope::Agent, BudgetMetric::Turns, 6.0, 5.0)
        );
        let (title, body) = hold.text("Fix tests", "app", true);
        assert_eq!(title, "Paused at a spending limit");
        assert!(
            body.contains("6 of 5 turns") && !body.contains("equivalent"),
            "{body}"
        );
        // The wire shape the UI and the phone read: metric is the unit.
        let json = serde_json::to_value(hold).unwrap();
        assert_eq!(json["metric"], "turns");
        assert_eq!(json["scope"], "agent");
        assert_eq!(
            (json["spent"].as_f64(), json["cap"].as_f64()),
            (Some(6.0), Some(5.0))
        );
        assert!(blocks_resume(BudgetAction::Pause, &r));
    }

    #[test]
    fn turn_limits_load_from_old_data_and_round_trip() {
        // Settings and agents saved before turn limits have no `turns`.
        let old: BudgetCap = serde_json::from_str(r#"{"usd":2.5,"tokens":900}"#).unwrap();
        assert_eq!(
            (old.usd, old.tokens, old.turns),
            (Some(2.5), Some(900), None)
        );
        let new = BudgetCap {
            turns: Some(12),
            ..old
        };
        let back: BudgetCap = serde_json::from_str(&serde_json::to_string(&new).unwrap()).unwrap();
        assert_eq!(back, new);
        // A tracker file from before turn limits still loads, with a zero turn count.
        let t: Tracker =
            serde_json::from_str(r#"{"day":"2026-03-01","today_usd":2.0,"today_tokens":5.0}"#)
                .unwrap();
        assert_eq!(t.today(day(1)).turns, 0.0);
        let mut bad = turns(-2);
        assert!(bad.problem().is_some() && bad.sanitize() && bad.is_empty());
    }
}
