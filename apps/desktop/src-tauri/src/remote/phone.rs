//! Phone-only endpoints that wrap what the desktop app already does: answering a
//! spending-limit hold, the PR/CI chip, searching conversations and the "How agents
//! report" setting. All of them are owner-only (a share link is a read-only view of
//! one conversation and gets none of this), and each calls the same core function as
//! the desktop command it mirrors.

use std::sync::OnceLock;

use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use kvistcode_core::budget::BudgetChoice;
use kvistcode_core::{KvistcodeEvent, ResponseStyle, SearchResults};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{owner, ApiError, Ctx, Peer};
use crate::pr_status::{PrCache, PrStatus};

/// Conversations returned for one search (the phone shows a short list).
const MAX_SEARCH_GROUPS: usize = 30;
/// Longest search text looked at.
const MAX_QUERY_CHARS: usize = 200;
/// Longest PR title sent to the phone.
const MAX_TITLE_CHARS: usize = 200;

/// "Raise limit / Continue once / Stop" for an agent held at a spending limit. The body
/// is the same `BudgetChoice` the desktop sends. Answering one already handled (from the
/// desktop) is a quiet success, as in the core.
pub(super) async fn budget_resolve(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(choice): Json<BudgetChoice>,
) -> Result<StatusCode, ApiError> {
    owner(&c.auth(&peer, &headers)?)?;
    let core = c.remote.core();
    let settings = core.budget_resolve(&id, choice).await?;
    if matches!(choice, BudgetChoice::Raise { .. }) {
        // A raised project or daily limit lives in the settings; the desktop window
        // would otherwise keep (and later save) the old one.
        core.emit(KvistcodeEvent::SettingsChanged {
            settings: Box::new(settings),
        });
    }
    Ok(StatusCode::NO_CONTENT)
}

/// The PR/CI numbers the phone's chip shows. Kept apart from the agent list because
/// asking GitHub (through `gh`) can take seconds.
pub(super) async fn pr(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    owner(&c.auth(&peer, &headers)?)?;
    let agent = c.remote.core().agent(&id)?;
    Ok(Json(pr_view(&pr_cache().status(&agent, false).await)))
}

/// One cache for the phone. (The desktop window has its own; both honour the same
/// per-agent TTLs, so a phone and a window looking at one agent cost two `gh` calls
/// per TTL at most.)
fn pr_cache() -> &'static PrCache {
    static CACHE: OnceLock<PrCache> = OnceLock::new();
    CACHE.get_or_init(PrCache::default)
}

/// What the phone needs of a PR status: no check names or log links, and only a web
/// link it can open.
fn pr_view(status: &PrStatus) -> Value {
    let pr = status.pr.as_ref().map(|pr| {
        json!({
            "number": pr.number,
            "url": Some(&pr.url).filter(|u| u.starts_with("https://") || u.starts_with("http://")),
            "title": pr.title.chars().take(MAX_TITLE_CHARS).collect::<String>(),
            "state": pr.state,
            "review": pr.review,
            "mergeState": pr.merge_state,
            "summary": {
                "passing": pr.summary.passing,
                "failing": pr.summary.failing,
                "pending": pr.summary.pending,
                "overall": pr.summary.overall,
            },
        })
    });
    json!({
        "state": status.state,
        "reason": status.reason,
        "pr": pr,
        "fetchedAt": status.fetched_at,
    })
}

#[derive(Deserialize)]
pub(super) struct SearchQuery {
    #[serde(default)]
    q: String,
}

/// Full-text search over every conversation, grouped by agent (best match first). Hits
/// carry `\u{1}` / `\u{2}` around each matched word, as on the desktop.
pub(super) async fn search(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
    Query(q): Query<SearchQuery>,
) -> Result<Json<SearchResults>, ApiError> {
    owner(&c.auth(&peer, &headers)?)?;
    let core = c.remote.core();
    let text: String = q.q.trim().chars().take(MAX_QUERY_CHARS).collect();
    let mut results = tokio::task::spawn_blocking(move || {
        let known: std::collections::HashSet<String> =
            core.agents()?.into_iter().map(|a| a.id).collect();
        let mut results = core.search_conversations(&text)?;
        // Hits of agents the phone can't open (just deleted) are noise.
        results.groups.retain(|g| known.contains(&g.agent_id));
        anyhow::Ok(results)
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))??;
    if results.groups.len() > MAX_SEARCH_GROUPS {
        results.groups.truncate(MAX_SEARCH_GROUPS);
        results.truncated = true;
    }
    Ok(Json(results))
}

#[derive(Deserialize)]
pub(super) struct StyleBody {
    style: ResponseStyle,
}

/// "How agents report": concise, balanced or detailed. Applies to new agents and to
/// existing ones the next time their session resumes, like the desktop setting.
pub(super) async fn set_response_style(
    State(c): State<Ctx>,
    ConnectInfo(peer): Peer,
    headers: HeaderMap,
    Json(body): Json<StyleBody>,
) -> Result<StatusCode, ApiError> {
    owner(&c.auth(&peer, &headers)?)?;
    let core = c.remote.core();
    let settings = core.update_settings(|s| s.response_style = body.style)?;
    core.emit(KvistcodeEvent::SettingsChanged {
        settings: Box::new(settings),
    });
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pr_status::{ChecksSummary, PrInfo};

    fn info(url: &str) -> PrInfo {
        PrInfo {
            number: 42,
            url: url.into(),
            title: "t".repeat(500),
            state: "open",
            review: Some("approved"),
            mergeable: Some("MERGEABLE"),
            merge_state: Some("clean"),
            base: Some("main".into()),
            head_sha: None,
            unresolved_threads: Some(3),
            checks: vec![crate::pr_status::Check {
                name: "build".into(),
                workflow: Some("CI".into()),
                status: "failing",
                url: Some("https://example.com/run/1".into()),
                run_id: Some("1".into()),
                duration_secs: Some(9),
            }],
            summary: ChecksSummary {
                passing: 4,
                failing: 1,
                pending: 2,
                overall: "failing",
            },
        }
    }

    fn status(pr: Option<PrInfo>) -> PrStatus {
        PrStatus {
            state: if pr.is_some() { "ok" } else { "none" },
            reason: None,
            pr,
            fetched_at: 7,
        }
    }

    #[test]
    fn the_phone_gets_counts_not_check_details() {
        let v = pr_view(&status(Some(info("https://github.com/o/r/pull/42"))));
        assert_eq!(v["state"], "ok");
        assert_eq!(v["pr"]["number"], 42);
        assert_eq!(v["pr"]["url"], "https://github.com/o/r/pull/42");
        assert_eq!(v["pr"]["state"], "open");
        assert_eq!(v["pr"]["review"], "approved");
        assert_eq!(v["pr"]["mergeState"], "clean");
        assert_eq!(v["pr"]["summary"]["passing"], 4);
        assert_eq!(v["pr"]["summary"]["failing"], 1);
        assert_eq!(v["pr"]["summary"]["pending"], 2);
        assert_eq!(v["pr"]["summary"]["overall"], "failing");
        assert_eq!(v["pr"]["title"].as_str().unwrap().len(), MAX_TITLE_CHARS);
        let text = v.to_string();
        assert!(!text.contains("example.com/run"), "no log links: {text}");
        assert!(!text.contains("build"), "no check names: {text}");
    }

    #[test]
    fn only_web_links_reach_the_phone() {
        for bad in ["javascript:alert(1)", "file:///etc/passwd", ""] {
            let v = pr_view(&status(Some(info(bad))));
            assert!(v["pr"]["url"].is_null(), "{bad}");
        }
        let none = pr_view(&status(None));
        assert_eq!(none["state"], "none");
        assert!(none["pr"].is_null());
    }

    // ---- the endpoints, over a real server --------------------------------------

    #[cfg(unix)]
    use std::sync::Arc;
    #[cfg(unix)]
    use std::time::Duration;

    #[cfg(unix)]
    use kvistcode_core::budget::BudgetAction;
    #[cfg(unix)]
    use kvistcode_core::{
        AgentStatus, Core, CreateAgentRequest, CustomAgent, EventSink, Provider, RemoteSettings,
    };
    #[cfg(unix)]
    use parking_lot::Mutex;

    #[cfg(unix)]
    use crate::remote::Remote;

    #[cfg(unix)]
    const TESTS: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../crates/kvistcode-core/tests"
    );
    #[cfg(unix)]
    #[derive(Default)]
    struct Recorder(Mutex<Vec<KvistcodeEvent>>);
    #[cfg(unix)]
    impl EventSink for Recorder {
        fn emit(&self, event: KvistcodeEvent) {
            self.0.lock().push(event);
        }
    }

    #[cfg(unix)]
    struct Rig {
        core: Core,
        remote: Arc<Remote>,
        events: Arc<Recorder>,
        base: String,
        owner: String,
        dir: std::path::PathBuf,
    }

    /// A core with a mock agent (each "COST" turn reports $0.50) that pauses at a limit,
    /// behind a real remote server, with one paired phone.
    #[cfg(unix)]
    async fn rig() -> Rig {
        let dir = std::env::temp_dir().join(format!("kvistcode-phone-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("data")).unwrap();
        let events = Arc::new(Recorder::default());
        let core = Core::open(dir.join("data"), events.clone()).unwrap();
        let mut settings = core.settings().unwrap();
        settings.custom_agents = vec![CustomAgent {
            id: "mock".into(),
            name: "Mock".into(),
            command: "python3".into(),
            args: vec![format!("{TESTS}/mock_modes.py"), "normal".into()],
            env: vec![],
            color: "#B39DDB".into(),
            enabled: true,
        }];
        settings.budget_action = BudgetAction::Pause;
        settings.agent_budget_usd = Some(0.4);
        core.save_settings(settings).unwrap();
        let remote = Remote::new(core.clone(), "0.0.0".into(), dir.join("data"));
        let mut port = 0;
        for _ in 0..5 {
            port = std::net::TcpListener::bind("127.0.0.1:0")
                .unwrap()
                .local_addr()
                .unwrap()
                .port();
            remote
                .apply(&RemoteSettings {
                    enabled: true,
                    lan: false,
                    port,
                    ..Default::default()
                })
                .await;
            if remote.status().running {
                break;
            }
        }
        assert!(remote.status().running, "{:?}", remote.status().error);
        let owner = remote.add_device("Pixel").unwrap();
        Rig {
            core,
            remote,
            events,
            base: format!("http://127.0.0.1:{port}"),
            owner,
            dir,
        }
    }

    #[cfg(unix)]
    impl Rig {
        async fn call(
            &self,
            method: &'static str,
            path: &str,
            token: Option<&str>,
            body: Option<Value>,
        ) -> (u16, String) {
            let url = format!("{}{path}", self.base);
            let auth = token.map(|t| format!("Bearer {t}"));
            tokio::task::spawn_blocking(move || {
                let agent = ureq::Agent::new_with_config(
                    ureq::Agent::config_builder()
                        .http_status_as_error(false)
                        .timeout_global(Some(Duration::from_secs(20)))
                        .build(),
                );
                let mut res = if method == "GET" {
                    let mut req = agent.get(&url);
                    if let Some(a) = &auth {
                        req = req.header("Authorization", a);
                    }
                    req.call().unwrap()
                } else {
                    let mut req = agent.post(&url);
                    if let Some(a) = &auth {
                        req = req.header("Authorization", a);
                    }
                    let body = serde_json::to_vec(&body.unwrap_or(json!({}))).unwrap();
                    req.header("Content-Type", "application/json")
                        .send(&body[..])
                        .unwrap()
                };
                (
                    res.status().as_u16(),
                    res.body_mut().read_to_string().unwrap_or_default(),
                )
            })
            .await
            .unwrap()
        }

        /// The token of a read-only link to `agent_id`.
        fn viewer(&self, agent_id: &str) -> String {
            let share = self.remote.create_share(agent_id, Some(1)).unwrap();
            share
                .url
                .unwrap()
                .rsplit("#token=")
                .next()
                .unwrap()
                .to_string()
        }

        /// Starts a mock agent whose first turn goes over the limit, and waits for the hold.
        async fn held_agent(&self, prompt: &str) -> kvistcode_core::Agent {
            let account = self
                .core
                .accounts()
                .unwrap()
                .into_iter()
                .find(|a| a.provider == Provider::Custom)
                .unwrap();
            let project = self.dir.join("project");
            std::fs::create_dir_all(&project).unwrap();
            let agent = self
                .core
                .create_agent(CreateAgentRequest {
                    provider: Provider::Custom,
                    account_id: account.id,
                    project_path: project.to_string_lossy().into_owned(),
                    prompt: prompt.into(),
                    title: None,
                    worktree: false,
                    model: None,
                    group_id: None,
                    custom_agent_id: Some("mock".into()),
                    permission_mode: None,
                    attachments: vec![],
                })
                .await
                .unwrap();
            for _ in 0..200 {
                let a = self.core.agent(&agent.id).unwrap();
                if a.budget_hold.is_some() && a.status == AgentStatus::Idle {
                    return a;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            panic!("the agent was never held");
        }

        async fn finish(self) {
            self.core.shutdown().await;
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_hold_is_answered_from_the_phone() {
        let rig = rig().await;
        let held = rig.held_agent("COST one").await;
        let other = rig.held_agent("COST two").await;
        let path = format!("/api/agents/{}/budget", held.id);
        let owner = rig.owner.clone();

        // The phone sees the hold in the agent list, with the fields to render it.
        let (code, body) = rig.call("GET", "/api/state", Some(&owner), None).await;
        assert_eq!(code, 200);
        let state: Value = serde_json::from_str(&body).unwrap();
        let listed = state["agents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["id"] == held.id.as_str())
            .unwrap();
        assert_eq!(listed["budgetHold"]["scope"], "agent");
        assert_eq!(listed["budgetHold"]["metric"], "cost");
        assert_eq!(listed["budgetHold"]["cap"], 0.4);

        // No token, and a read-only link, are refused before anything changes.
        let raise = json!({ "action": "raise", "by": 1.0 });
        assert_eq!(
            rig.call("POST", &path, None, Some(raise.clone())).await.0,
            401
        );
        let viewer = rig.viewer(&held.id);
        let (code, _) = rig
            .call("POST", &path, Some(&viewer), Some(raise.clone()))
            .await;
        assert_eq!(code, 403);
        assert!(rig.core.agent(&held.id).unwrap().budget_hold.is_some());
        // ...and a viewer is not shown the hold at all.
        let (_, body) = rig.call("GET", "/api/state", Some(&viewer), None).await;
        assert!(!body.contains("budgetHold"), "{body}");

        // Nonsense is refused: an unknown action, a raise that stays under the spend.
        let (code, _) = rig
            .call(
                "POST",
                &path,
                Some(&owner),
                Some(json!({ "action": "nope" })),
            )
            .await;
        assert!((400..500).contains(&code), "{code}");
        let (code, body) = rig
            .call(
                "POST",
                &path,
                Some(&owner),
                Some(json!({ "action": "raise", "by": 0.05 })),
            )
            .await;
        assert_eq!(code, 400, "{body}");
        assert!(body.contains("still under"), "{body}");
        let (code, _) = rig
            .call(
                "POST",
                "/api/agents/nope/budget",
                Some(&owner),
                Some(raise.clone()),
            )
            .await;
        assert_eq!(code, 404);
        assert!(rig.core.agent(&held.id).unwrap().budget_hold.is_some());

        // Raise it: the hold is gone, the agent has its own higher limit.
        let (code, body) = rig.call("POST", &path, Some(&owner), Some(raise)).await;
        assert_eq!(code, 204, "{body}");
        let a = rig.core.agent(&held.id).unwrap();
        assert!(a.budget_hold.is_none());
        assert_eq!(a.budget.and_then(|b| b.usd), Some(1.4));
        // The desktop window is told, so it doesn't keep an older copy of the settings.
        assert!(rig
            .events
            .0
            .lock()
            .iter()
            .any(|e| matches!(e, KvistcodeEvent::SettingsChanged { .. })));
        // The other agent is untouched. Answering twice is harmless.
        assert!(rig.core.agent(&other.id).unwrap().budget_hold.is_some());
        let (code, _) = rig
            .call(
                "POST",
                &path,
                Some(&owner),
                Some(json!({ "action": "continue_once" })),
            )
            .await;
        assert_eq!(code, 204);

        // Stop dismisses the other one without raising anything.
        let (code, _) = rig
            .call(
                "POST",
                &format!("/api/agents/{}/budget", other.id),
                Some(&owner),
                Some(json!({ "action": "stop" })),
            )
            .await;
        assert_eq!(code, 204);
        let b = rig.core.agent(&other.id).unwrap();
        assert!(b.budget_hold.is_none());
        assert!(b.acknowledged_at.is_some());
        rig.finish().await;
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn continuing_once_clears_the_hold() {
        let rig = rig().await;
        let held = rig.held_agent("COST one").await;
        let owner = rig.owner.clone();
        let (code, _) = rig
            .call(
                "POST",
                &format!("/api/agents/{}/budget", held.id),
                Some(&owner),
                Some(json!({ "action": "continue_once" })),
            )
            .await;
        assert_eq!(code, 204);
        assert!(rig.core.agent(&held.id).unwrap().budget_hold.is_none());
        rig.finish().await;
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_pr_chip_is_owner_only_and_quiet_without_a_branch() {
        let rig = rig().await;
        let held = rig.held_agent("COST one").await;
        let path = format!("/api/agents/{}/pr", held.id);
        let owner = rig.owner.clone();
        assert_eq!(rig.call("GET", &path, None, None).await.0, 401);
        let viewer = rig.viewer(&held.id);
        assert_eq!(rig.call("GET", &path, Some(&viewer), None).await.0, 403);
        // A folder that isn't a branch has no PR (and `gh` is never asked).
        let (code, body) = rig.call("GET", &path, Some(&owner), None).await;
        assert_eq!(code, 200, "{body}");
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["state"], "none");
        assert!(v["pr"].is_null());
        assert_eq!(
            rig.call("GET", "/api/agents/nope/pr", Some(&owner), None)
                .await
                .0,
            404
        );
        rig.finish().await;
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn search_finds_conversations_for_the_owner_only() {
        let rig = rig().await;
        let held = rig.held_agent("COST one").await;
        let owner = rig.owner.clone();
        assert_eq!(
            rig.call("GET", "/api/search?q=reply", None, None).await.0,
            401
        );
        let viewer = rig.viewer(&held.id);
        assert_eq!(
            rig.call("GET", "/api/search?q=reply", Some(&viewer), None)
                .await
                .0,
            403,
            "a share link can't search other conversations"
        );

        let (code, body) = rig
            .call("GET", "/api/search?q=reply", Some(&owner), None)
            .await;
        assert_eq!(code, 200, "{body}");
        let found: Value = serde_json::from_str(&body).unwrap();
        let groups = found["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 1, "{body}");
        assert_eq!(groups[0]["agentId"], held.id.as_str());
        let hit = &groups[0]["hits"][0];
        assert!(
            hit["snippet"].as_str().unwrap().contains('\u{1}'),
            "matched words are marked"
        );
        assert!(hit["itemId"].is_string());

        // Nothing typed, or nothing matching, is an empty list rather than an error.
        for path in ["/api/search", "/api/search?q=", "/api/search?q=zzzzqqqq"] {
            let (code, body) = rig.call("GET", path, Some(&owner), None).await;
            assert_eq!(code, 200, "{path}");
            let v: Value = serde_json::from_str(&body).unwrap();
            assert!(v["groups"].as_array().unwrap().is_empty(), "{path}: {body}");
        }
        // A huge query is cut, not refused or slow.
        let long = "reply%20".repeat(2_000);
        let (code, _) = rig
            .call("GET", &format!("/api/search?q={long}"), Some(&owner), None)
            .await;
        assert_eq!(code, 200);
        rig.finish().await;
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_response_style_can_be_set_from_the_phone() {
        let rig = rig().await;
        let owner = rig.owner.clone();
        let (_, body) = rig.call("GET", "/api/state", Some(&owner), None).await;
        let state: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(state["responseStyle"], "concise");

        let set = json!({ "style": "detailed" });
        assert_eq!(
            rig.call("POST", "/api/response-style", None, Some(set.clone()))
                .await
                .0,
            401
        );
        let held = rig.held_agent("COST one").await;
        let viewer = rig.viewer(&held.id);
        assert_eq!(
            rig.call(
                "POST",
                "/api/response-style",
                Some(&viewer),
                Some(set.clone())
            )
            .await
            .0,
            403
        );
        assert_eq!(
            rig.core.settings().unwrap().response_style,
            ResponseStyle::Concise
        );
        let (_, body) = rig.call("GET", "/api/state", Some(&viewer), None).await;
        let seen: Value = serde_json::from_str(&body).unwrap();
        assert!(seen["responseStyle"].is_null(), "{body}");

        let (code, _) = rig
            .call(
                "POST",
                "/api/response-style",
                Some(&owner),
                Some(json!({ "style": "loud" })),
            )
            .await;
        assert!(
            (400..500).contains(&code),
            "an unknown style is refused: {code}"
        );
        assert_eq!(
            rig.core.settings().unwrap().response_style,
            ResponseStyle::Concise
        );

        let (code, body) = rig
            .call("POST", "/api/response-style", Some(&owner), Some(set))
            .await;
        assert_eq!(code, 204, "{body}");
        let settings = rig.core.settings().unwrap();
        assert_eq!(settings.response_style, ResponseStyle::Detailed);
        // Nothing else in the settings moved.
        assert_eq!(settings.agent_budget_usd, Some(0.4));
        assert!(rig.events.0.lock().iter().any(|e| matches!(
            e,
            KvistcodeEvent::SettingsChanged { settings } if settings.response_style == ResponseStyle::Detailed
        )));
        let (_, body) = rig.call("GET", "/api/state", Some(&owner), None).await;
        let state: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(state["responseStyle"], "detailed");
        rig.finish().await;
    }
}
