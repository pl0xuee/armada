//! Executes the assistant's tools against the running app, through the same `Core`
//! calls the UI uses, so they behave exactly like clicking.

use std::sync::Arc;
use std::time::Duration;

use armada_core::{
    Agent, AgentStatus, Core, CreateAgentRequest, ItemBody, Provider, TimelineItem, ToolStatus,
};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::session::{ActionLog, ToolFuture, ToolHost, ToolOutcome, VaEvent, VaSink};
use super::tools::{self, basename, clean, AgentRef, OpenView, Resolved, ToolCall};

pub struct ArmadaTools {
    pub app: AppHandle,
    pub core: Core,
    pub sink: Arc<dyn VaSink>,
}

impl ToolHost for ArmadaTools {
    fn call(&self, name: String, arguments: String) -> ToolFuture {
        let (app, core, sink) = (self.app.clone(), self.core.clone(), self.sink.clone());
        Box::pin(async move {
            let host = ArmadaTools { app, core, sink };
            match tools::parse_call(&name, &arguments) {
                Err(e) => ToolOutcome {
                    output: tools::wrap_error(&e),
                    action: None,
                },
                Ok(call) => host.run(&name, call).await,
            }
        })
    }
}

fn ok(data: Value) -> ToolOutcome {
    ToolOutcome {
        output: tools::wrap_data(data),
        action: None,
    }
}

fn fail(msg: &str) -> ToolOutcome {
    ToolOutcome {
        output: tools::wrap_error(msg),
        action: None,
    }
}

fn done(data: Value, kind: &str, summary: String, agent_id: Option<String>) -> ToolOutcome {
    ToolOutcome {
        output: tools::wrap_data(data),
        action: Some(ActionLog {
            id: uuid::Uuid::new_v4().to_string(),
            kind: kind.into(),
            summary: clean(&summary, 160),
            agent_id,
            ok: true,
        }),
    }
}

fn provider_label(p: Provider) -> &'static str {
    match p {
        Provider::Claude => "Claude",
        Provider::Codex => "Codex",
        Provider::Grok => "Grok",
        Provider::Local => "Local",
        Provider::Custom => "Custom",
    }
}

/// Why an agent wants the user, if it does.
pub fn needs_you(a: &Agent) -> Option<String> {
    if a.status == AgentStatus::NeedsPermission || a.pending_permissions > 0 {
        return Some(format!(
            "waiting for approval ({})",
            a.pending_permissions.max(1)
        ));
    }
    if a.status == AgentStatus::Error {
        return Some("error".into());
    }
    if a.rate_limited {
        return Some("hit its usage limit".into());
    }
    if a.queue_paused && a.queued_prompts > 0 {
        return Some("queued messages paused".into());
    }
    if a.unread && a.status == AgentStatus::Idle {
        return Some("finished, not yet read".into());
    }
    None
}

/// Sub-agents still working: in-flight calls, plus background ones while the turn runs.
pub fn running_subagents(items: &[TimelineItem], agent_running: bool) -> usize {
    items
        .iter()
        .filter(|i| match &i.body {
            ItemBody::ToolCall {
                subagent: Some(s),
                status,
                ..
            } if !s.control => {
                matches!(status, ToolStatus::Pending | ToolStatus::InProgress)
                    || (s.background && agent_running)
            }
            _ => false,
        })
        .count()
}

fn ago(now: i64, then: i64) -> String {
    let s = ((now - then) / 1000).max(0);
    match s {
        0..=59 => "just now".into(),
        60..=3599 => format!("{} min ago", s / 60),
        3600..=86_399 => format!("{} h ago", s / 3600),
        _ => format!("{} days ago", s / 86_400),
    }
}

impl ArmadaTools {
    async fn run(&self, name: &str, call: ToolCall) -> ToolOutcome {
        match call {
            ToolCall::ListAgents => self.list_agents(),
            ToolCall::GetAgent { agent } => self.get_agent(&agent).await,
            ToolCall::StartAgent {
                provider,
                project,
                prompt,
                account,
            } => {
                self.start_agent(&provider, &project, &prompt, account.as_deref())
                    .await
            }
            ToolCall::SendMessage { agent, text } => self.send_message(&agent, &text).await,
            ToolCall::StopAgent { agent } => self.stop_agent(&agent).await,
            ToolCall::Open { view, agent } => self.open(view, agent.as_deref()),
            ToolCall::RequestApprovalReview { agent } => self.request_approval(&agent),
        }
        .with_kind(name)
    }

    fn resolve(&self, query: &str) -> Result<Agent, Box<ToolOutcome>> {
        let agents = self
            .core
            .agents()
            .map_err(|e| Box::new(fail(&format!("{e:#}"))))?;
        let live: Vec<&Agent> = agents.iter().filter(|a| !a.archived).collect();
        let projects: Vec<String> = live.iter().map(|a| basename(&a.project_path)).collect();
        let refs: Vec<AgentRef> = live
            .iter()
            .zip(&projects)
            .map(|(a, p)| AgentRef {
                id: &a.id,
                title: &a.title,
                project: p,
            })
            .collect();
        match tools::resolve_agent(&refs, query) {
            Resolved::One(id) => Ok(live
                .iter()
                .find(|a| a.id == id)
                .map(|a| (*a).clone())
                .expect("resolved")),
            Resolved::Ambiguous(c) => Err(Box::new(ToolOutcome {
                output: tools::wrap_ambiguous("agents", &c),
                action: None,
            })),
            Resolved::None => Err(Box::new(fail(
                "No agent matches that. Use list_agents to see them.",
            ))),
        }
    }

    fn list_agents(&self) -> ToolOutcome {
        let mut agents = match self.core.agents() {
            Ok(a) => a,
            Err(e) => return fail(&format!("{e:#}")),
        };
        agents.retain(|a| !a.archived);
        agents.sort_by_key(|a| std::cmp::Reverse(a.last_activity_at));
        let now = armada_core::now_ms();
        let rows: Vec<Value> = agents
            .iter()
            .take(25)
            .map(|a| {
                let subs = if a.running {
                    self.core
                        .items(&a.id)
                        .map(|i| running_subagents(&i, true))
                        .unwrap_or(0)
                } else {
                    0
                };
                json!({
                    "id": a.id,
                    "title": a.title,
                    "provider": a.provider.as_str(),
                    "project": basename(&a.project_path),
                    "status": a.status.as_str(),
                    "needsYou": needs_you(a),
                    "runningSubagents": subs,
                    "lastActivity": ago(now, a.last_activity_at),
                })
            })
            .collect();
        ok(json!({ "count": agents.len(), "agents": rows }))
    }

    async fn get_agent(&self, query: &str) -> ToolOutcome {
        let agent = match self.resolve(query) {
            Ok(a) => a,
            Err(o) => return *o,
        };
        let items = self.core.items(&agent.id).unwrap_or_default();
        let last_message = items
            .iter()
            .rev()
            .find_map(|i| match &i.body {
                ItemBody::AgentMessage { text } => Some(text.clone()),
                _ => None,
            })
            .or_else(|| agent.last_message.clone())
            .map(|t| t.chars().take(600).collect::<String>());
        let files: Vec<String> = items
            .iter()
            .rev()
            .find_map(|i| match &i.body {
                ItemBody::TurnSummary { files, .. } => Some(files.clone()),
                _ => None,
            })
            .unwrap_or_else(|| self.core.touched_files(&agent.id))
            .into_iter()
            .take(10)
            .collect();
        let commands: Vec<String> = items
            .iter()
            .rev()
            .filter_map(|i| match &i.body {
                ItemBody::ToolCall {
                    command: Some(c), ..
                } => Some(c.chars().take(120).collect()),
                _ => None,
            })
            .take(3)
            .collect();
        let pending: Vec<String> = items
            .iter()
            .filter_map(|i| match &i.body {
                ItemBody::Permission {
                    title,
                    resolution: None,
                    ..
                } => Some(title.clone()),
                _ => None,
            })
            .take(3)
            .collect();
        let pr = match self.app.try_state::<crate::pr_status::PrCache>() {
            Some(cache) if agent.branch.is_some() => {
                match tokio::time::timeout(Duration::from_secs(3), cache.status(&agent, false))
                    .await
                {
                    Ok(s) => s.pr.map(|p| {
                        json!({ "number": p.number, "state": p.state, "review": p.review,
                                "mergeable": p.mergeable, "checks": p.summary })
                    }),
                    Err(_) => None,
                }
            }
            _ => None,
        };
        ok(json!({
            "id": agent.id,
            "title": agent.title,
            "provider": agent.provider.as_str(),
            "project": basename(&agent.project_path),
            "status": agent.status.as_str(),
            "needsYou": needs_you(&agent),
            "runningSubagents": running_subagents(&items, agent.running),
            "queuedMessages": agent.queued_prompts,
            "lastAssistantMessage": last_message,
            "filesChanged": files,
            "recentCommands": commands,
            "pendingApprovals": pending,
            "pullRequest": pr,
            "lastActivity": ago(armada_core::now_ms(), agent.last_activity_at),
        }))
    }

    async fn known_projects(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        if let Ok(s) = self.core.settings() {
            out.extend(s.recent_projects);
        }
        if let Ok(a) = self.core.agents() {
            out.extend(a.into_iter().map(|a| a.project_path));
        }
        if let Ok(found) = self.core.discover_projects().await {
            out.extend(found);
        }
        let mut seen = std::collections::HashSet::new();
        out.retain(|p| seen.insert(p.clone()));
        out.retain(|p| std::path::Path::new(p).is_dir());
        out
    }

    async fn start_agent(
        &self,
        provider: &str,
        project: &str,
        prompt: &str,
        account: Option<&str>,
    ) -> ToolOutcome {
        let provider = match provider {
            "codex" => Provider::Codex,
            "grok" => Provider::Grok,
            _ => Provider::Claude,
        };
        let known = self.known_projects().await;
        let path = match tools::resolve_project(&known, project) {
            Resolved::One(p) => p,
            Resolved::Ambiguous(c) => {
                return ToolOutcome {
                    output: tools::wrap_ambiguous("projects", &c),
                    action: None,
                }
            }
            Resolved::None => return fail(
                "That isn't a project Armada knows. Open it once in the New Agent dialog first.",
            ),
        };
        let accounts = match self.core.accounts() {
            Ok(a) => a,
            Err(e) => return fail(&format!("{e:#}")),
        };
        let mine: Vec<_> = accounts.iter().filter(|a| a.provider == provider).collect();
        let chosen = match account {
            Some(q) => {
                let q = q.to_lowercase();
                mine.iter()
                    .find(|a| a.name.to_lowercase().contains(&q))
                    .copied()
            }
            None => mine.iter().find(|a| a.is_system).or(mine.first()).copied(),
        };
        let Some(chosen) = chosen else {
            return fail(&format!(
                "No {} account is set up.",
                provider_label(provider)
            ));
        };
        let worktree = self
            .core
            .settings()
            .map(|s| s.default_worktree)
            .unwrap_or(true);
        let req = CreateAgentRequest {
            provider,
            account_id: chosen.id.clone(),
            project_path: path.clone(),
            prompt: prompt.to_string(),
            title: None,
            worktree,
            model: None,
            group_id: None,
            custom_agent_id: None,
            permission_mode: None,
            attachments: Vec::new(),
        };
        match self.core.create_agent(req).await {
            Ok(agent) => {
                if let Err(e) = crate::commands::remember_project(&self.core, &agent.project_path) {
                    tracing::warn!("could not update recent projects: {e:#}");
                }
                let project = basename(&agent.project_path);
                done(
                    json!({ "started": true, "id": agent.id, "title": agent.title,
                            "provider": agent.provider.as_str(), "project": project,
                            "worktree": agent.worktree }),
                    "start_agent",
                    format!(
                        "Started {} agent '{}' in {}",
                        provider_label(agent.provider),
                        agent.title,
                        project
                    ),
                    Some(agent.id.clone()),
                )
            }
            Err(e) => fail(&format!("Couldn't start the agent: {e:#}")),
        }
    }

    async fn send_message(&self, query: &str, text: &str) -> ToolOutcome {
        let agent = match self.resolve(query) {
            Ok(a) => a,
            Err(o) => return *o,
        };
        match self.core.send_prompt(&agent.id, text, Vec::new()).await {
            Ok(()) => done(
                json!({ "sent": true, "agent": agent.title, "queued": agent.running }),
                "send_message",
                format!(
                    "Sent to '{}': \u{201c}{}\u{201d}",
                    agent.title,
                    text.chars().take(80).collect::<String>()
                ),
                Some(agent.id),
            ),
            Err(e) => fail(&format!("Couldn't send the message: {e:#}")),
        }
    }

    async fn stop_agent(&self, query: &str) -> ToolOutcome {
        let agent = match self.resolve(query) {
            Ok(a) => a,
            Err(o) => return *o,
        };
        if !agent.running {
            return ok(json!({ "stopped": false, "reason": "The agent isn't running a turn." }));
        }
        match self.core.cancel_turn(&agent.id).await {
            Ok(()) => done(
                json!({ "stopped": true, "agent": agent.title }),
                "stop_agent",
                format!("Stopped the current turn of '{}'", agent.title),
                Some(agent.id),
            ),
            Err(e) => fail(&format!("Couldn't stop the agent: {e:#}")),
        }
    }

    fn open(&self, view: OpenView, agent: Option<&str>) -> ToolOutcome {
        let agent = match agent {
            Some(q) => match self.resolve(q) {
                Ok(a) => Some(a),
                Err(o) => return *o,
            },
            None => None,
        };
        let label = match view {
            OpenView::Agents => "agents",
            OpenView::MissionControl => "Mission Control",
            OpenView::Inbox => "the inbox",
            OpenView::Review => "the diff review",
        };
        self.sink.emit(VaEvent::Navigate {
            view: view.as_str().into(),
            agent_id: agent.as_ref().map(|a| a.id.clone()),
        });
        let summary = match &agent {
            Some(a) => format!("Opened {label} for '{}'", a.title),
            None => format!("Opened {label}"),
        };
        done(
            json!({ "opened": view.as_str() }),
            "open",
            summary,
            agent.map(|a| a.id),
        )
    }

    fn request_approval(&self, query: &str) -> ToolOutcome {
        let agent = match self.resolve(query) {
            Ok(a) => a,
            Err(o) => return *o,
        };
        let items = self.core.items(&agent.id).unwrap_or_default();
        let pending: Vec<Value> = items
            .iter()
            .filter_map(|i| match &i.body {
                ItemBody::Permission {
                    title,
                    command,
                    resolution: None,
                    ..
                } => Some(json!({ "request": title, "command": command })),
                _ => None,
            })
            .take(3)
            .collect();
        if pending.is_empty() {
            return ok(json!({ "pending": false, "note": "That agent has no pending approval." }));
        }
        self.sink.emit(VaEvent::Navigate {
            view: "agents".into(),
            agent_id: Some(agent.id.clone()),
        });
        done(
            json!({ "pending": true, "requests": pending,
                    "instruction": "Tell the user to review and confirm on screen. You cannot approve or deny." }),
            "request_approval_review",
            format!("Opened the pending approval for '{}'", agent.title),
            Some(agent.id),
        )
    }
}

trait WithKind {
    fn with_kind(self, kind: &str) -> Self;
}

impl WithKind for ToolOutcome {
    fn with_kind(mut self, kind: &str) -> Self {
        if let Some(a) = &mut self.action {
            a.kind = kind.into();
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use armada_core::SubAgent;

    fn call(status: ToolStatus, sub: Option<SubAgent>) -> TimelineItem {
        TimelineItem {
            id: "i".into(),
            agent_id: "a".into(),
            seq: 1,
            ts: 0,
            body: ItemBody::ToolCall {
                tool_call_id: "t".into(),
                title: "Task".into(),
                tool_kind: armada_core::ToolKind::Other,
                status,
                locations: vec![],
                diffs: vec![],
                output: String::new(),
                command: None,
                images: vec![],
                subagent: sub,
                parent_tool_call_id: None,
            },
        }
    }

    #[test]
    fn counts_running_subagents() {
        let plain = SubAgent::default();
        let bg = SubAgent {
            background: true,
            ..Default::default()
        };
        let ctl = SubAgent {
            control: true,
            ..Default::default()
        };
        let items = vec![
            call(ToolStatus::InProgress, Some(plain.clone())),
            call(ToolStatus::Completed, Some(plain)),
            call(ToolStatus::Completed, Some(bg)),
            call(ToolStatus::InProgress, Some(ctl)),
            call(ToolStatus::InProgress, None),
        ];
        assert_eq!(running_subagents(&items, true), 2);
        assert_eq!(running_subagents(&items, false), 1);
    }

    #[test]
    fn relative_times() {
        assert_eq!(ago(100_000, 90_000), "just now");
        assert_eq!(ago(10 * 60_000, 0), "10 min ago");
        assert_eq!(ago(3 * 3_600_000, 0), "3 h ago");
    }
}
