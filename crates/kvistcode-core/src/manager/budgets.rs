//! Spending limits, applied: `crate::budget` decides what crossed a threshold; this
//! tells the user (a timeline notice, and the "Needs you" alert) and, with the Pause
//! action, holds an agent when its turn ends.
//!
//! * Reaching 80% is a notice and nothing else.
//! * Reaching 100% never interrupts a running turn (and so never a tool call): the
//!   agent finishes it, and at that turn boundary it is *held*: queued messages stay
//!   queued, `Agent::budget_hold` says why, and a "Needs you" item offers to raise the
//!   limit, continue once, or stop.
//! * Continuing starts the next turn; at its boundary the limit is checked again.

use super::*;
use crate::budget::{
    self, Alert, BudgetAction, BudgetCap, BudgetChoice, BudgetHold, BudgetLevel, BudgetMetric,
    BudgetScope, BudgetStatus, Caps, Reading, Spend,
};

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

/// The limits that apply to `agent`: the day's, its project's, and its own (an override
/// from "Raise limit" wins over the default for every agent).
fn caps_of(s: &Settings, agent: &Agent) -> Caps {
    let own = agent.budget.unwrap_or_default();
    Caps {
        daily: BudgetCap {
            usd: s.daily_budget_usd,
            tokens: s.daily_budget_tokens,
        },
        project: s
            .project_budgets
            .get(&agent.project_path)
            .copied()
            .unwrap_or_default(),
        agent: BudgetCap {
            usd: own.usd.or(s.agent_budget_usd),
            tokens: own.tokens.or(s.agent_budget_tokens),
        },
    }
}

fn spend_of(agents: &[&Agent]) -> Spend {
    Spend {
        usd: agents.iter().map(|a| a.cost_usd).sum(),
        tokens: agents.iter().map(|a| a.tokens_used as f64).sum(),
    }
}

impl Core {
    /// Where `agent_id` stands against each limit (None if it no longer exists).
    fn budget_readings(&self, agent_id: &str) -> Option<(Agent, BudgetAction, Vec<Reading>)> {
        let agent = self.agent(agent_id).ok()?;
        let (caps, action) = {
            let s = self.inner.settings.lock();
            (caps_of(&s, &agent), s.budget_action)
        };
        let project = {
            let agents = self.inner.agents.lock();
            let same: Vec<&Agent> = agents
                .values()
                .map(|r| &r.agent)
                .filter(|a| a.project_path == agent.project_path)
                .collect();
            spend_of(&same)
        };
        let daily = self
            .inner
            .budget
            .lock()
            .tracker
            .today(Local::now().date_naive());
        let readings = budget::readings(&caps, spend_of(&[&agent]), project, daily);
        Some((agent, action, readings))
    }

    /// Cost shown for this agent is an API-equivalent figure, not a bill.
    fn budget_equivalent(&self, agent: &Agent) -> bool {
        self.inner
            .accounts
            .lock()
            .get(&agent.account_id)
            .is_none_or(|a| a.auth_kind != AuthKind::ApiKey)
    }

    /// An agent's spend went up by `usd` and `tokens` (already stored on the agent):
    /// counts it toward the day, and raises the notices for limits that crossed.
    pub(crate) fn budget_observe(&self, agent_id: &str, usd: f64, tokens: f64) {
        let today = Local::now().date_naive();
        self.inner
            .budget
            .lock()
            .tracker
            .add_spend(today, usd, tokens);
        let Some((agent, action, readings)) = self.budget_readings(agent_id) else {
            return;
        };
        let alerts = {
            let mut state = self.inner.budget.lock();
            let alerts = state
                .tracker
                .alerts(today, agent_id, &agent.project_path, &readings);
            state.save(&self.inner.data_dir, !alerts.is_empty());
            alerts
        };
        let equivalent = self.budget_equivalent(&agent);
        let mut hit = false;
        for alert in alerts {
            hit |= alert.level == BudgetLevel::Hit;
            self.raise_budget_alert(&agent, alert, action, equivalent);
        }
        // A limit crossed while nothing is running (a late usage report) holds the
        // agent now; while a turn runs, the hold waits for the turn to end.
        if hit && action == BudgetAction::Pause && !agent.status.is_busy() {
            if let Some(hold) = BudgetHold::worst(&readings, now_ms()) {
                self.budget_hold_agent(agent_id, hold);
            }
        }
    }

    fn raise_budget_alert(
        &self,
        agent: &Agent,
        alert: Alert,
        action: BudgetAction,
        equivalent: bool,
    ) {
        let project = basename(&agent.project_path);
        let (head, body) = alert.text(action, &agent.title, &project, equivalent);
        let hit = alert.level == BudgetLevel::Hit;
        let pause = hit && action == BudgetAction::Pause;
        let level = if hit && !pause {
            NoticeLevel::Error
        } else {
            NoticeLevel::Warn
        };
        self.ctx(&agent.id).notice(level, format!("{head}. {body}"));
        // The 80% warning is a notice; hitting a limit under the Pause action alerts
        // when the agent is held, and with Alert-only it alerts now.
        if hit && !pause {
            self.emit(KvistcodeEvent::Attention {
                agent_id: agent.id.clone(),
                reason: AttentionReason::Error,
                title: head,
                body,
                request_id: None,
            });
        }
    }

    /// Whether `agent_id` must be held now (Pause action, some limit hit). Checked when
    /// a turn ends, before the queue would carry on.
    pub(crate) fn budget_gate(&self, agent_id: &str) -> Option<BudgetHold> {
        let (_, action, readings) = self.budget_readings(agent_id)?;
        if action != BudgetAction::Pause {
            return None;
        }
        BudgetHold::worst(&readings, now_ms())
    }

    /// Holds the agent at a limit and asks the user what to do.
    pub(crate) fn budget_hold_agent(&self, agent_id: &str, hold: BudgetHold) {
        let Ok(agent) = self.update_agent(agent_id, |a| a.budget_hold = Some(hold)) else {
            return;
        };
        let equivalent = self.budget_equivalent(&agent);
        let (head, body) = hold.text(&agent.title, &basename(&agent.project_path), equivalent);
        self.ctx(agent_id)
            .notice(NoticeLevel::Warn, format!("{head}. {body}"));
        // "Needs you" sound and notification; no request id, so no Approve/Deny buttons.
        self.emit(KvistcodeEvent::Attention {
            agent_id: agent_id.to_string(),
            reason: AttentionReason::Permission,
            title: head,
            body,
            request_id: None,
        });
    }

    /// Today's spend against the daily limits (for the Usage view).
    pub fn budget_status(&self) -> BudgetStatus {
        let daily = {
            let s = self.inner.settings.lock();
            BudgetCap {
                usd: s.daily_budget_usd,
                tokens: s.daily_budget_tokens,
            }
        };
        self.inner
            .budget
            .lock()
            .tracker
            .status(Local::now().date_naive(), &daily)
    }

    /// Startup: an interrupted agent over a limit (with the Pause action) stays
    /// stopped instead of auto-resuming into more spend.
    pub(super) fn budget_blocks_resume(&self, agent_id: &str) -> bool {
        self.budget_readings(agent_id)
            .is_some_and(|(_, action, readings)| budget::blocks_resume(action, &readings))
    }

    /// Answers a "Needs you" budget item. Returns the settings (a raised project or
    /// daily limit lives there).
    pub async fn budget_resolve(&self, agent_id: &str, choice: BudgetChoice) -> Result<Settings> {
        let agent = self.agent(agent_id)?;
        let Some(hold) = agent.budget_hold else {
            // Already handled (from the phone, another window).
            return self.settings();
        };
        match choice {
            BudgetChoice::Raise { by } => {
                if !by.is_finite() || by <= 0.0 {
                    bail!("Enter an amount above zero");
                }
                let new_cap = hold.cap + by;
                if new_cap <= hold.spent {
                    bail!("That is still under what was spent. Raise it by more.");
                }
                self.budget_raise(&agent, hold, new_cap)?;
                self.budget_release_holds().await;
            }
            BudgetChoice::ContinueOnce => {
                self.update_agent(agent_id, |a| a.budget_hold = None)?;
                self.resume_queue(agent_id).await?;
            }
            BudgetChoice::Stop => {
                self.clear_queue(agent_id)?;
                self.update_agent(agent_id, |a| {
                    a.budget_hold = None;
                    a.acknowledged_at = Some(now_ms());
                })?;
            }
        }
        self.settings()
    }

    /// Makes the hit limit `new_cap`: this agent's own, its project's, or the day's.
    fn budget_raise(&self, agent: &Agent, hold: BudgetHold, new_cap: f64) -> Result<()> {
        let tokens = new_cap.ceil() as i64;
        let set = |cap: &mut BudgetCap| match hold.metric {
            BudgetMetric::Cost => cap.usd = Some((new_cap * 100.0).ceil() / 100.0),
            BudgetMetric::Tokens => cap.tokens = Some(tokens),
        };
        match hold.scope {
            BudgetScope::Agent => {
                self.update_agent(&agent.id, |a| {
                    let mut own = a.budget.unwrap_or_default();
                    set(&mut own);
                    a.budget = Some(own);
                })?;
            }
            BudgetScope::Project => {
                self.update_settings(|s| {
                    set(s
                        .project_budgets
                        .entry(agent.project_path.clone())
                        .or_default())
                })?;
            }
            BudgetScope::Daily => {
                self.update_settings(|s| {
                    let mut cap = BudgetCap {
                        usd: s.daily_budget_usd,
                        tokens: s.daily_budget_tokens,
                    };
                    set(&mut cap);
                    s.daily_budget_usd = cap.usd;
                    s.daily_budget_tokens = cap.tokens;
                })?;
            }
        }
        Ok(())
    }

    /// After a limit was raised: every held agent that is now under its limits carries on.
    async fn budget_release_holds(&self) {
        let held: Vec<String> = self
            .inner
            .agents
            .lock()
            .values()
            .filter(|r| r.agent.budget_hold.is_some())
            .map(|r| r.agent.id.clone())
            .collect();
        for id in held {
            if self.budget_gate(&id).is_some() {
                continue;
            }
            if self.update_agent(&id, |a| a.budget_hold = None).is_err() {
                continue;
            }
            if let Err(e) = self.resume_queue(&id).await {
                tracing::warn!("resuming {id} after a raised limit: {e:#}");
            }
        }
    }
}

fn basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}
