//! Spending caps: a daily cap across all agents and a cap per agent. This is the
//! pure part (what crossed which threshold, exactly once); `manager/budgets.rs`
//! applies it (notices, desktop alerts, pausing).
//!
//! * 80% of a cap warns, 100% hits it. Each fires once per agent, and the daily
//!   ones once per local day.
//! * "Today" is counted from the cost increases seen since local midnight, so a
//!   cost that goes down (a restarted process, a reset) never subtracts spend.
//! * A cost that falls back under a threshold (or a raised cap) re-arms it.

use std::collections::HashMap;

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

/// Share of a cap at which the warning fires.
pub const WARN_AT: f64 = 0.8;

/// What happens when a cap is hit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BudgetAction {
    /// Alert only; the agents keep working.
    #[default]
    Notify,
    /// Interrupt the running turn (all running agents for the daily cap); queued
    /// messages stay queued, and nothing auto-resumes until you continue.
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetScope {
    Daily,
    Agent,
}

/// The configured caps (None = no cap).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Caps {
    pub daily: Option<f64>,
    pub agent: Option<f64>,
}

/// A usable cap: finite and above zero.
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
    /// `Warn` or `Hit`.
    pub level: BudgetLevel,
    pub spent: f64,
    pub cap: f64,
}

impl Alert {
    /// (title, body) for the notice and the desktop notification.
    pub fn text(&self, action: BudgetAction, agent_title: &str) -> (String, String) {
        let (subject, whose) = match self.scope {
            BudgetScope::Daily => ("daily budget", "Today's spend".to_string()),
            BudgetScope::Agent => ("agent budget", format!("\u{201c}{agent_title}\u{201d}")),
        };
        let amounts = format!("${:.2} of ${:.2}", self.spent, self.cap);
        match self.level {
            BudgetLevel::Warn => (
                format!("Close to the {subject}"),
                format!("{whose} is at {amounts} (80% of the cap)."),
            ),
            _ => {
                let tail = match (action, self.scope) {
                    (BudgetAction::Notify, _) => "",
                    (BudgetAction::Pause, BudgetScope::Daily) => {
                        " Running agents were paused; continue them when you are ready."
                    }
                    (BudgetAction::Pause, BudgetScope::Agent) => {
                        " It was paused; continue it when you are ready."
                    }
                };
                (
                    format!("{} reached", capitalize(subject)),
                    format!("{whose} reached {amounts}.{tail}"),
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

/// Today's spend against the daily cap, for the UI.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetStatus {
    /// Local date, `YYYY-MM-DD`.
    pub day: String,
    pub today_usd: f64,
    pub daily_budget_usd: Option<f64>,
    pub level: BudgetLevel,
}

/// Spend seen today and which alerts already fired. Persisted by the caller so a
/// restart doesn't forget the day or repeat an alert.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Tracker {
    day: String,
    today_usd: f64,
    daily: Fired,
    agents: HashMap<String, Fired>,
}

impl Tracker {
    fn roll(&mut self, today: NaiveDate) {
        let day = today.to_string();
        if self.day != day {
            self.day = day;
            self.today_usd = 0.0;
            self.daily = Fired::default();
        }
    }

    /// An agent's cost went from `old` to `new` (its running total). Returns the
    /// thresholds this crossed: the daily one first.
    pub fn observe(
        &mut self,
        today: NaiveDate,
        agent_id: &str,
        old: f64,
        new: f64,
        caps: Caps,
    ) -> Vec<Alert> {
        self.roll(today);
        if new.is_finite() && old.is_finite() && new > old {
            self.today_usd += new - old;
        }
        let mut alerts = Vec::new();
        if let Some(l) = self.daily.advance(level(self.today_usd, caps.daily)) {
            alerts.push(Alert {
                scope: BudgetScope::Daily,
                level: l,
                spent: self.today_usd,
                cap: caps.daily.unwrap_or_default(),
            });
        }
        let now = if new.is_finite() {
            level(new, caps.agent)
        } else {
            BudgetLevel::Under
        };
        let fired = self.agents.entry(agent_id.to_string()).or_default();
        if let Some(l) = fired.advance(now) {
            alerts.push(Alert {
                scope: BudgetScope::Agent,
                level: l,
                spent: new,
                cap: caps.agent.unwrap_or_default(),
            });
        }
        if *fired == Fired::default() {
            self.agents.remove(agent_id);
        }
        alerts
    }

    /// Today's spend (zero when the last observation was another day).
    pub fn today_usd(&self, today: NaiveDate) -> f64 {
        if self.day == today.to_string() {
            self.today_usd
        } else {
            0.0
        }
    }

    pub fn status(&self, today: NaiveDate, caps: Caps) -> BudgetStatus {
        let today_usd = self.today_usd(today);
        BudgetStatus {
            day: today.to_string(),
            today_usd,
            daily_budget_usd: valid_cap(caps.daily),
            level: level(today_usd, caps.daily),
        }
    }
}

/// Whether an interrupted agent must stay stopped at startup instead of
/// auto-resuming into more spend: a cap with the Pause action is already hit.
pub fn blocks_resume(caps: Caps, action: BudgetAction, agent_cost: f64, today_usd: f64) -> bool {
    action == BudgetAction::Pause
        && (level(agent_cost, caps.agent) == BudgetLevel::Hit
            || level(today_usd, caps.daily) == BudgetLevel::Hit)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 3, d).unwrap()
    }

    fn caps(daily: Option<f64>, agent: Option<f64>) -> Caps {
        Caps { daily, agent }
    }

    fn levels(alerts: &[Alert]) -> Vec<(BudgetScope, BudgetLevel)> {
        alerts.iter().map(|a| (a.scope, a.level)).collect()
    }

    #[test]
    fn levels_at_80_and_100_percent() {
        assert_eq!(level(7.99, Some(10.0)), BudgetLevel::Under);
        assert_eq!(level(8.0, Some(10.0)), BudgetLevel::Warn);
        assert_eq!(level(9.99, Some(10.0)), BudgetLevel::Warn);
        assert_eq!(level(10.0, Some(10.0)), BudgetLevel::Hit);
        assert_eq!(level(50.0, Some(10.0)), BudgetLevel::Hit);
    }

    #[test]
    fn no_cap_means_disabled() {
        assert_eq!(level(1e9, None), BudgetLevel::Under);
        assert_eq!(level(5.0, Some(0.0)), BudgetLevel::Under);
        assert_eq!(level(5.0, Some(-1.0)), BudgetLevel::Under);
        assert_eq!(level(5.0, Some(f64::NAN)), BudgetLevel::Under);
        let mut t = Tracker::default();
        assert!(t
            .observe(day(1), "a", 0.0, 100.0, Caps::default())
            .is_empty());
    }

    #[test]
    fn agent_alerts_fire_once() {
        let mut t = Tracker::default();
        let c = caps(None, Some(10.0));
        assert!(t.observe(day(1), "a", 0.0, 5.0, c).is_empty());
        let a = t.observe(day(1), "a", 5.0, 8.5, c);
        assert_eq!(levels(&a), [(BudgetScope::Agent, BudgetLevel::Warn)]);
        assert!(t.observe(day(1), "a", 8.5, 9.0, c).is_empty());
        let a = t.observe(day(1), "a", 9.0, 10.2, c);
        assert_eq!(levels(&a), [(BudgetScope::Agent, BudgetLevel::Hit)]);
        assert_eq!(a[0].cap, 10.0);
        assert!(t.observe(day(1), "a", 10.2, 30.0, c).is_empty());
    }

    #[test]
    fn jumping_past_both_thresholds_fires_hit_only() {
        let mut t = Tracker::default();
        let a = t.observe(day(1), "a", 0.0, 12.0, caps(None, Some(10.0)));
        assert_eq!(levels(&a), [(BudgetScope::Agent, BudgetLevel::Hit)]);
    }

    #[test]
    fn agents_are_independent() {
        let mut t = Tracker::default();
        let c = caps(None, Some(10.0));
        assert_eq!(t.observe(day(1), "a", 0.0, 11.0, c).len(), 1);
        assert_eq!(t.observe(day(1), "b", 0.0, 11.0, c).len(), 1);
    }

    #[test]
    fn daily_total_sums_increases_across_agents() {
        let mut t = Tracker::default();
        let c = caps(Some(10.0), None);
        assert!(t.observe(day(1), "a", 100.0, 104.0, c).is_empty());
        let a = t.observe(day(1), "b", 0.0, 4.5, c);
        assert_eq!(levels(&a), [(BudgetScope::Daily, BudgetLevel::Warn)]);
        let a = t.observe(day(1), "a", 104.0, 106.0, c);
        assert_eq!(levels(&a), [(BudgetScope::Daily, BudgetLevel::Hit)]);
        assert!((a[0].spent - 10.5).abs() < 1e-9);
    }

    #[test]
    fn daily_alerts_reset_at_midnight() {
        let mut t = Tracker::default();
        let c = caps(Some(10.0), None);
        assert_eq!(t.observe(day(1), "a", 0.0, 11.0, c).len(), 1);
        assert!(t.observe(day(1), "a", 11.0, 12.0, c).is_empty());
        // The next day starts from zero and can alert again.
        assert!(t.observe(day(2), "a", 12.0, 13.0, c).is_empty());
        assert!((t.today_usd(day(2)) - 1.0).abs() < 1e-9);
        let a = t.observe(day(2), "a", 13.0, 22.0, c);
        assert_eq!(levels(&a), [(BudgetScope::Daily, BudgetLevel::Hit)]);
    }

    #[test]
    fn agent_alerts_do_not_repeat_at_midnight() {
        let mut t = Tracker::default();
        let c = caps(None, Some(10.0));
        assert_eq!(t.observe(day(1), "a", 0.0, 11.0, c).len(), 1);
        assert!(t.observe(day(2), "a", 11.0, 11.5, c).is_empty());
    }

    #[test]
    fn today_reads_zero_on_another_day() {
        let mut t = Tracker::default();
        t.observe(day(1), "a", 0.0, 3.0, Caps::default());
        assert!((t.today_usd(day(1)) - 3.0).abs() < 1e-9);
        assert_eq!(t.today_usd(day(2)), 0.0);
        let s = t.status(day(2), caps(Some(5.0), None));
        assert_eq!((s.today_usd, s.daily_budget_usd), (0.0, Some(5.0)));
    }

    #[test]
    fn a_cost_that_drops_never_subtracts_and_rearms() {
        let mut t = Tracker::default();
        let c = caps(Some(100.0), Some(10.0));
        assert_eq!(t.observe(day(1), "a", 0.0, 9.0, c).len(), 1);
        // Reset to zero: spend today stays, the agent's thresholds re-arm.
        assert!(t.observe(day(1), "a", 9.0, 0.0, c).is_empty());
        assert!((t.today_usd(day(1)) - 9.0).abs() < 1e-9);
        let a = t.observe(day(1), "a", 0.0, 9.0, c);
        assert_eq!(levels(&a), [(BudgetScope::Agent, BudgetLevel::Warn)]);
        // NaN is ignored.
        assert!(t.observe(day(1), "a", 9.0, f64::NAN, c).is_empty());
        assert!((t.today_usd(day(1)) - 18.0).abs() < 1e-9);
    }

    #[test]
    fn raising_a_cap_rearms_it() {
        let mut t = Tracker::default();
        assert_eq!(
            t.observe(day(1), "a", 0.0, 11.0, caps(None, Some(10.0)))
                .len(),
            1
        );
        assert!(t
            .observe(day(1), "a", 11.0, 12.0, caps(None, Some(50.0)))
            .is_empty());
        let a = t.observe(day(1), "a", 12.0, 41.0, caps(None, Some(50.0)));
        assert_eq!(levels(&a), [(BudgetScope::Agent, BudgetLevel::Warn)]);
    }

    #[test]
    fn survives_a_round_trip() {
        let mut t = Tracker::default();
        let c = caps(Some(10.0), Some(10.0));
        t.observe(day(1), "a", 0.0, 11.0, c);
        let mut back: Tracker = serde_json::from_str(&serde_json::to_string(&t).unwrap()).unwrap();
        assert!(back.observe(day(1), "a", 11.0, 12.0, c).is_empty());
        assert!(serde_json::from_str::<Tracker>("{}").is_ok());
    }

    #[test]
    fn alert_text_names_the_outcome() {
        let hit = Alert {
            scope: BudgetScope::Agent,
            level: BudgetLevel::Hit,
            spent: 10.5,
            cap: 10.0,
        };
        let (title, body) = hit.text(BudgetAction::Pause, "Fix tests");
        assert_eq!(title, "Agent budget reached");
        assert!(body.contains("$10.50 of $10.00") && body.contains("paused"));
        let (_, body) = hit.text(BudgetAction::Notify, "Fix tests");
        assert!(!body.contains("paused"));
        let warn = Alert {
            scope: BudgetScope::Daily,
            level: BudgetLevel::Warn,
            spent: 8.0,
            cap: 10.0,
        };
        assert_eq!(
            warn.text(BudgetAction::Pause, "x").0,
            "Close to the daily budget"
        );
    }

    #[test]
    fn resume_is_blocked_only_by_a_hit_cap_with_pause() {
        let c = caps(Some(10.0), Some(5.0));
        assert!(blocks_resume(c, BudgetAction::Pause, 6.0, 1.0));
        assert!(blocks_resume(c, BudgetAction::Pause, 1.0, 10.0));
        assert!(!blocks_resume(c, BudgetAction::Pause, 4.5, 8.5));
        assert!(!blocks_resume(c, BudgetAction::Notify, 60.0, 100.0));
        assert!(!blocks_resume(
            Caps::default(),
            BudgetAction::Pause,
            60.0,
            100.0
        ));
    }
}
