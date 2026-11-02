//! Agents waiting out a rate limit, and the clock that resumes them. The decisions are pure
//! functions in `crate::limit_resume` (reset-time parsing is `crate::limit_reset`); this is the part
//! that reads the agents, sends the prompts and tells the user.
//!
//! * `limit_hit` runs when a turn fails on a rate limit: it records when the limit lifts.
//! * A ticker (every 5 s, only doing work while someone waits) asks `limit_resume::decide` and starts
//!   a *wave*: the due agents resume one every 3-5 s, at most 3 starting at once, then one
//!   notification says how many.
//! * Anything the user does to the agent (a message, stop, switching account) ends the wait, because
//!   every such path clears `rate_limited` or the status, which `limit_resume::eligible` requires.

use super::*;
use crate::limit_reset;
use crate::limit_resume::{
    self, ClockWatch, Decision, Facts, LimitResume, LimitResumeState, UsageView, MAX_ATTEMPTS,
    MAX_STARTING, RESUME_PROMPT,
};

/// How often the ticker looks (waits are minutes to hours; this only bounds the lateness).
const TICK_MS: u64 = 5_000;
/// A fast pace for tests: ticks every 100 ms and every wait is 1000 times shorter.
const FAST_TICK_MS: u64 = 100;
const FAST_DIV: i64 = 1_000;
/// Two automatic resumes of one agent are never closer than this (a start that failed quietly
/// must not loop).
const MIN_BETWEEN_ATTEMPTS_MS: i64 = 2 * 60_000;
/// Nothing is resumed in the first moments after the app starts.
const STARTUP_HOLD_MS: i64 = 20_000;
/// How long a started agent may hold its "starting" slot.
const START_SLOT_MAX: std::time::Duration = std::time::Duration::from_secs(90);

#[derive(Default)]
pub(super) struct State {
    /// Agents in a wave right now.
    inflight: HashSet<String>,
    clock: ClockWatch,
    /// Tests: tick fast, shorten every wait.
    fast: bool,
}

impl Core {
    fn limit_div(&self) -> i64 {
        if self.inner.limit_wait.lock().fast {
            FAST_DIV
        } else {
            1
        }
    }

    /// Tests only: tick every 100 ms and shorten every wait (jitter, stagger, backoff) 1000-fold.
    #[doc(hidden)]
    pub fn set_limit_resume_fast(&self) {
        self.inner.limit_wait.lock().fast = true;
    }

    /// Starts the ticker. Cheap while nothing waits: one pass over the agent list.
    pub(super) fn spawn_limit_watch(&self) {
        let weak = self.weak();
        // Agents whose reset passed while the app was closed wait a moment: at a login launch the
        // network is often not up yet, and a resume that cannot connect would end the wait.
        let hold = now_ms() + STARTUP_HOLD_MS / self.limit_div();
        self.inner.limit_wait.lock().clock.hold_until(hold);
        tokio::spawn(async move {
            loop {
                let Some(core) = weak.upgrade() else {
                    break;
                };
                if core.is_shutting_down() {
                    break;
                }
                let fast = core.inner.limit_wait.lock().fast;
                core.limit_tick(now_ms(), std::time::Instant::now());
                drop(core);
                let ms = if fast { FAST_TICK_MS } else { TICK_MS };
                tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
            }
        });
    }

    /// One look at the waiting agents. `now` is the wall clock (a sleeping or re-set clock is
    /// noticed against `mono`).
    pub(crate) fn limit_tick(&self, now: i64, mono: std::time::Instant) {
        let (fast, div) = {
            let st = self.inner.limit_wait.lock();
            (st.fast, if st.fast { FAST_DIV } else { 1 })
        };
        let period = if fast { FAST_TICK_MS } else { TICK_MS } as i64;
        if !self.inner.settings.lock().resume_after_limit {
            // Switched off: nobody promises a resume anymore (the phone and the lists stop
            // saying so), and switching it on later does not revive old waits.
            let stale: Vec<String> = self
                .inner
                .agents
                .lock()
                .values()
                .filter(|r| r.agent.limit_resume.is_some() || r.agent.limit_resets_at.is_some())
                .map(|r| r.agent.id.clone())
                .collect();
            for id in stale {
                self.limit_wait_ended(&id);
            }
            return;
        }
        let waiting: Vec<(String, String, i64, LimitResume, Option<i64>)> = self
            .inner
            .agents
            .lock()
            .values()
            .filter(|r| {
                r.agent.limit_resume.is_some() && limit_resume::eligible(&Facts::of(&r.agent))
            })
            .map(|r| {
                (
                    r.agent.id.clone(),
                    r.agent.account_id.clone(),
                    r.agent.created_at,
                    r.agent.limit_resume.clone().unwrap_or_default(),
                    r.agent.limit_resets_at,
                )
            })
            .collect();
        if waiting.is_empty() {
            return;
        }
        let inflight = {
            let mut st = self.inner.limit_wait.lock();
            // After sleep or a clock change, wait for the network; nothing is decided now.
            if !st.clock.ready(now, mono, period) {
                return;
            }
            st.inflight.clone()
        };
        let mut due: Vec<(i64, String)> = Vec::new();
        for (id, account_id, created_at, resume, resets_at) in waiting {
            if inflight.contains(&id)
                || resume
                    .last_attempt_at
                    .is_some_and(|t| now - t < MIN_BETWEEN_ATTEMPTS_MS / div)
            {
                continue;
            }
            let jitter = resets_at.map_or(0, |r| limit_resume::jitter_ms(&account_id, r) / div);
            let usage = self.limit_usage_view(&account_id, &resume, now);
            match limit_resume::decide(now, &resume, resets_at, jitter, usage) {
                Decision::Wait => {}
                Decision::Learn(r) => {
                    let _ = self.update_agent(&id, |a| {
                        if a.limit_resume.is_some() {
                            a.limit_resets_at = Some(r);
                        }
                    });
                }
                Decision::Resume => due.push((created_at, id)),
            }
        }
        // The spending limits are read outside the agents lock (they look at every agent).
        due.retain(|(_, id)| !self.budget_blocks_resume(id));
        if due.is_empty() {
            return;
        }
        due.sort();
        let ids: Vec<String> = due.into_iter().map(|(_, id)| id).collect();
        self.inner
            .limit_wait
            .lock()
            .inflight
            .extend(ids.iter().cloned());
        let core = self.clone();
        tokio::spawn(async move { core.limit_wave(ids, now).await });
    }

    /// What the account's last usage snapshot says about this agent's limit.
    fn limit_usage_view(&self, account_id: &str, resume: &LimitResume, now: i64) -> UsageView {
        let Some(usage) = self.account(account_id).ok().and_then(|a| a.usage) else {
            return UsageView::Unknown;
        };
        if let Some(r) = limit_reset::exhausted_reset(&usage, now) {
            UsageView::Full(Some(r))
        } else if limit_reset::usage_is_clear(&usage, now, resume.hit_at) {
            UsageView::Clear
        } else {
            UsageView::Unknown
        }
    }

    /// Resumes the due agents of one wave, staggered, then says so once.
    async fn limit_wave(&self, ids: Vec<String>, seed: i64) {
        let div = self.limit_div();
        let offsets = limit_resume::stagger_offsets(&ids, seed);
        let permits = Arc::new(tokio::sync::Semaphore::new(MAX_STARTING));
        let started = tokio::time::Instant::now();
        let mut tasks = tokio::task::JoinSet::new();
        for (id, offset) in ids.iter().cloned().zip(offsets) {
            let core = self.clone();
            let permits = permits.clone();
            tasks.spawn(async move {
                tokio::time::sleep_until(
                    started + std::time::Duration::from_millis((offset / div) as u64),
                )
                .await;
                if core.is_shutting_down() {
                    return None;
                }
                core.limit_resume_one(&id, &permits).await
            });
        }
        let mut resumed: Vec<(String, String)> = Vec::new();
        while let Some(done) = tasks.join_next().await {
            if let Ok(Some(who)) = done {
                resumed.push(who);
            }
        }
        {
            let mut st = self.inner.limit_wait.lock();
            for id in &ids {
                st.inflight.remove(id);
            }
        }
        if let Some((agent_id, title)) = resumed.first().cloned() {
            self.emit(KvistcodeEvent::Attention {
                agent_id,
                reason: AttentionReason::Done,
                title: if resumed.len() == 1 {
                    title.clone()
                } else {
                    "Rate limit reset".into()
                },
                body: limit_resume::resumed_body(resumed.len(), &title),
                request_id: None,
            });
        }
    }

    /// Sends one agent its automatic "continue". Returns its id and title when it was sent.
    async fn limit_resume_one(
        &self,
        agent_id: &str,
        permits: &Arc<tokio::sync::Semaphore>,
    ) -> Option<(String, String)> {
        let permit = permits.clone().acquire_owned().await.ok()?;
        // Looked at again: the user may have taken over while this one waited its turn.
        let agent = self.agent(agent_id).ok()?;
        if !self.inner.settings.lock().resume_after_limit
            || !limit_resume::eligible(&Facts::of(&agent))
            || agent
                .limit_resume
                .as_ref()
                .is_none_or(|r| r.state != LimitResumeState::Waiting)
            || self.budget_blocks_resume(agent_id)
        {
            return None;
        }
        let now = now_ms();
        let _ = self.update_agent(agent_id, |a| {
            if let Some(r) = a.limit_resume.as_mut() {
                r.attempts = r.attempts.saturating_add(1);
                r.last_attempt_at = Some(now);
                r.probe_at = None;
            }
        });
        match self.send_automatic_prompt(agent_id).await {
            Ok(true) => {}
            Ok(false) => {
                // A turn began meanwhile (the user's): not ours to continue.
                return None;
            }
            Err(e) => {
                tracing::warn!("resuming {agent_id} after the rate limit: {e:#}");
                return None;
            }
        }
        // Hold the slot while the process starts, so a big wave does not start everything at once.
        let deadline = tokio::time::Instant::now() + START_SLOT_MAX;
        loop {
            let starting = self
                .agent(agent_id)
                .map(|a| a.status == AgentStatus::Starting)
                .unwrap_or(false);
            if !starting || tokio::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(
                250 / self.limit_div().min(5) as u64,
            ))
            .await;
        }
        drop(permit);
        Some((agent.id.clone(), agent.title.clone()))
    }

    /// The normal send path (`run_prompt`), with the prompt flagged automatic in the timeline.
    /// Ok(false) when a turn was already running.
    async fn send_automatic_prompt(&self, agent_id: &str) -> Result<bool> {
        if self.is_shutting_down() {
            bail!(SHUTTING_DOWN);
        }
        let agent = self.agent(agent_id)?;
        let ctx = self.ctx(agent_id);
        let running = self.live_driver(agent_id).is_some();
        let Some(prompt) = ctx.submit_automatic_prompt(RESUME_PROMPT) else {
            return Ok(false);
        };
        self.update_agent(agent_id, |a| {
            a.unread = false;
            a.last_activity_at = now_ms();
            if !running {
                a.status = AgentStatus::Starting;
            }
        })?;
        self.run_prompt(&agent.id, prompt, None);
        Ok(true)
    }

    /// A turn failed on a rate limit: records when it lifts (see the module comment).
    /// `was_automatic`: the turn was one of our own resumes, so this continues its episode.
    pub(crate) fn limit_hit(&self, agent_id: &str, message: &str, was_automatic: bool) {
        let Ok(agent) = self.agent(agent_id) else {
            return;
        };
        // A newer turn began meanwhile, or the agent was stopped: not waiting on anything.
        if !agent.rate_limited || agent.status != AgentStatus::Error {
            return;
        }
        if !self.inner.settings.lock().resume_after_limit {
            self.limit_wait_ended(agent_id);
            return;
        }
        let now = now_ms();
        let div = self.limit_div();
        let ctx = self.ctx(agent_id);
        let prev = if was_automatic {
            agent.limit_resume.clone()
        } else {
            None
        };
        if prev
            .as_ref()
            .is_some_and(|p| p.state == LimitResumeState::Cancelled)
        {
            return;
        }
        let attempts = prev.as_ref().map_or(0, |p| p.attempts);
        if attempts >= MAX_ATTEMPTS {
            let _ = self.update_agent(agent_id, |a| {
                a.limit_resets_at = None;
                if let Some(r) = a.limit_resume.as_mut() {
                    r.state = LimitResumeState::GaveUp;
                }
            });
            ctx.notice(
                NoticeLevel::Warn,
                format!(
                    "The rate limit was still on after {MAX_ATTEMPTS} automatic tries, so Kvistcode stopped trying. Continue this agent yourself when the limit is lifted, or switch accounts."
                ),
            );
            self.emit(KvistcodeEvent::Attention {
                agent_id: agent.id.clone(),
                reason: AttentionReason::Error,
                title: agent.title.clone(),
                body: format!("Still at its rate limit after {MAX_ATTEMPTS} automatic tries"),
                request_id: None,
            });
            return;
        }
        let usage = self.account(&agent.account_id).ok().and_then(|a| a.usage);
        let reported =
            limit_reset::best_reset(message, usage.as_ref(), now, &jiff::tz::TimeZone::system());
        let wait = limit_resume::next_wait(attempts, reported, now, div);
        let _ = self.update_agent(agent_id, |a| {
            a.limit_resets_at = wait.resets_at;
            a.limit_resume = Some(LimitResume {
                state: LimitResumeState::Waiting,
                attempts,
                hit_at: now,
                last_attempt_at: prev.as_ref().and_then(|p| p.last_attempt_at),
                probe_at: wait.probe_at,
            });
        });
        // With automatic account switching on and another account to switch to, the agent
        // moves on within moments (which clears this); no promise to make.
        if self.failover_will_switch(&agent) {
            return;
        }
        let when = wait
            .resets_at
            .map(|r| limit_resume::describe_time(r, now, &Local));
        let text = match (attempts, when) {
            (0, Some(t)) => format!(
                "Kvistcode will resume this agent automatically after the rate limit resets ({t})."
            ),
            (0, None) => "Kvistcode will resume this agent automatically once the rate limit lifts. The provider did not say when.".into(),
            (n, Some(t)) => format!(
                "The rate limit is still on. Kvistcode will try again at {t} (automatic try {} of {MAX_ATTEMPTS}).",
                n + 1
            ),
            (n, None) => format!("The rate limit is still on. Kvistcode will try again (automatic try {} of {MAX_ATTEMPTS}).", n + 1),
        };
        ctx.notice(NoticeLevel::Info, text);
    }

    /// `failover == "auto"` and another signed-in account of the provider exists.
    fn failover_will_switch(&self, agent: &Agent) -> bool {
        if self.inner.settings.lock().failover != "auto" {
            return false;
        }
        let now = now_ms();
        let limited = self.inner.limited_accounts.lock();
        self.inner.accounts.lock().values().any(|a| {
            a.provider == agent.provider
                && a.id != agent.account_id
                && a.status.as_ref().is_none_or(|s| s.logged_in)
                && limited
                    .get(&a.id)
                    .is_none_or(|t| now - t > LIMIT_COOLDOWN_MS)
        })
    }

    /// The wait is over (a turn ended some other way, or the user took over): forget it.
    pub(crate) fn limit_wait_ended(&self, agent_id: &str) {
        let has =
            self.inner.agents.lock().get(agent_id).is_some_and(|r| {
                r.agent.limit_resume.is_some() || r.agent.limit_resets_at.is_some()
            });
        if has {
            let _ = self.update_agent(agent_id, |a| {
                a.limit_resume = None;
                a.limit_resets_at = None;
            });
        }
    }

    /// "Don't auto-resume this one": the agent stays as it is (stopped by the limit) for the user.
    pub fn cancel_limit_resume(&self, agent_id: &str) -> Result<Agent> {
        let agent = self.agent(agent_id)?;
        if agent
            .limit_resume
            .as_ref()
            .is_none_or(|r| r.state != LimitResumeState::Waiting)
        {
            return Ok(agent);
        }
        let agent = self.update_agent(agent_id, |a| {
            a.limit_resets_at = None;
            if let Some(r) = a.limit_resume.as_mut() {
                r.state = LimitResumeState::Cancelled;
            }
        })?;
        self.ctx(agent_id).notice(
            NoticeLevel::Info,
            "Automatic resume cancelled for this agent. Continue it yourself when the limit is lifted.",
        );
        Ok(agent)
    }
}
