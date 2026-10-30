//! Spending caps, applied: `crate::budget` decides what crossed a threshold; this
//! tells the user (a timeline notice and the desktop alert "Needs you" uses) and,
//! with the Pause action, interrupts the agents through the normal cancel path
//! (which keeps their queued messages, paused).

use super::*;
use crate::budget::{self, Alert, BudgetAction, BudgetLevel, BudgetScope, BudgetStatus, Caps};

/// How often the tracker is written to disk while spend keeps changing.
const SAVE_EVERY: std::time::Duration = std::time::Duration::from_secs(5);
const FILE: &str = "budget.json";

pub(super) struct BudgetState {
    tracker: budget::Tracker,
    saved: Option<std::time::Instant>,
}

impl BudgetState {
    pub(super) fn load(data_dir: &Path) -> Self {
        let tracker = std::fs::read_to_string(data_dir.join(FILE))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        BudgetState {
            tracker,
            saved: None,
        }
    }

    fn save(&mut self, data_dir: &Path, force: bool) {
        if !force && self.saved.is_some_and(|t| t.elapsed() < SAVE_EVERY) {
            return;
        }
        self.saved = Some(std::time::Instant::now());
        if let Ok(json) = serde_json::to_string(&self.tracker) {
            if let Err(e) = std::fs::write(data_dir.join(FILE), json) {
                tracing::warn!("couldn't save the budget tracker: {e}");
            }
        }
    }
}

fn caps_of(s: &Settings) -> Caps {
    Caps {
        daily: s.daily_budget_usd,
        agent: s.agent_budget_usd,
    }
}

impl Core {
    /// An agent's total cost went from `old` to `new`: raises the budget alerts that
    /// crossed and, when set to pause, stops the agents that must stop.
    pub(crate) fn budget_cost(&self, agent_id: &str, old: f64, new: f64) {
        let (caps, action) = {
            let s = self.inner.settings.lock();
            (caps_of(&s), s.budget_action)
        };
        let today = Local::now().date_naive();
        let alerts = {
            let mut state = self.inner.budget.lock();
            let alerts = state.tracker.observe(today, agent_id, old, new, caps);
            state.save(&self.inner.data_dir, !alerts.is_empty());
            alerts
        };
        for alert in alerts {
            self.raise_budget_alert(agent_id, alert, action);
        }
    }

    fn raise_budget_alert(&self, agent_id: &str, alert: Alert, action: BudgetAction) {
        let title = self.agent(agent_id).map(|a| a.title).unwrap_or_default();
        let (head, body) = alert.text(action, &title);
        let hit = alert.level == BudgetLevel::Hit;
        let pause = hit && action == BudgetAction::Pause;
        let level = if hit {
            NoticeLevel::Error
        } else {
            NoticeLevel::Warn
        };
        let paused: Vec<String> = match (pause, alert.scope) {
            (false, _) => Vec::new(),
            (true, BudgetScope::Agent) => vec![agent_id.to_string()],
            (true, BudgetScope::Daily) => self
                .inner
                .agents
                .lock()
                .values()
                .filter(|r| r.agent.status.is_busy() && !r.agent.archived)
                .map(|r| r.agent.id.clone())
                .collect(),
        };
        // The agent that crossed it always gets the notice; so does each agent paused.
        let mut notify: Vec<&str> = vec![agent_id];
        notify.extend(
            paused
                .iter()
                .map(String::as_str)
                .filter(|id| *id != agent_id),
        );
        for id in notify {
            self.ctx(id).notice(level, format!("{head}. {body}"));
        }
        // Only hitting a cap interrupts you (toast, sound, notification); the 80% warning is just the notice.
        if hit {
            self.emit(ArmadaEvent::Attention {
                agent_id: agent_id.to_string(),
                reason: AttentionReason::Error,
                title: head,
                body,
                request_id: None,
            });
        }
        for id in paused {
            let core = self.clone();
            // `budget_cost` runs on the agent's reader; the cancel can take a while.
            if let Ok(rt) = tokio::runtime::Handle::try_current() {
                rt.spawn(async move {
                    if let Err(e) = core.cancel_turn(&id).await {
                        tracing::warn!("budget pause {id}: {e:#}");
                    }
                });
            }
        }
    }

    /// Today's spend against the daily cap (for the Usage view).
    pub fn budget_status(&self) -> BudgetStatus {
        let caps = caps_of(&self.inner.settings.lock());
        self.inner
            .budget
            .lock()
            .tracker
            .status(Local::now().date_naive(), caps)
    }

    /// Startup: an interrupted agent over a cap (with the Pause action) stays
    /// stopped instead of auto-resuming into more spend.
    pub(super) fn budget_blocks_resume(&self, agent_cost: f64) -> bool {
        let (caps, action) = {
            let s = self.inner.settings.lock();
            (caps_of(&s), s.budget_action)
        };
        let today = self
            .inner
            .budget
            .lock()
            .tracker
            .today_usd(Local::now().date_naive());
        budget::blocks_resume(caps, action, agent_cost, today)
    }
}
