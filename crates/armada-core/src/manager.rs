//! The agent supervisor. `Core` is cheap to clone and safe to share across threads.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};

use anyhow::{anyhow, bail, Context};
use chrono::{Datelike, Local, TimeZone};
use parking_lot::Mutex;

use crate::acp::{self, AcpDriver};
use crate::codex::{self, CodexDriver};
use crate::db::Db;
use crate::model::*;
use crate::session::{AgentCtx, ExitIntent, Prompt, TurnOutcome};
use crate::{accounts, git, providers, EventSink, Result};

const VERSION: &str = env!("CARGO_PKG_VERSION");

const CONTINUE_PROMPT: &str =
    "Armada was closed while you were working on this. Please continue where you left off.";

/// The start was abandoned because the agent was stopped, cancelled or deleted.
#[derive(Debug)]
struct StartCancelled;

impl std::fmt::Display for StartCancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the agent was stopped before it finished starting")
    }
}

impl std::error::Error for StartCancelled {}

#[derive(Clone)]
enum Driver {
    Acp(Arc<AcpDriver>),
    Codex(Arc<CodexDriver>),
}

impl Driver {
    fn session_id(&self) -> String {
        match self {
            Driver::Acp(d) => d.session_id(),
            Driver::Codex(d) => d.session_id(),
        }
    }
    fn prompt(&self, prompt: Prompt) {
        match self {
            Driver::Acp(d) => d.prompt(prompt),
            Driver::Codex(d) => d.prompt(prompt),
        }
    }
    async fn cancel(&self) -> Result<()> {
        match self {
            Driver::Acp(d) => d.cancel().await,
            Driver::Codex(d) => d.cancel().await,
        }
    }
    async fn respond_permission(&self, request_id: &str, option_id: &str) -> Result<()> {
        match self {
            Driver::Acp(d) => d.respond_permission(request_id, option_id).await,
            Driver::Codex(d) => d.respond_permission(request_id, option_id).await,
        }
    }
    async fn set_config(&self, option_id: &str, value: &str) -> Result<()> {
        match self {
            Driver::Acp(d) => d.set_config(option_id, value).await,
            Driver::Codex(d) => d.set_config(option_id, value).await,
        }
    }
    async fn shutdown(&self) {
        match self {
            Driver::Acp(d) => d.shutdown().await,
            Driver::Codex(d) => d.shutdown().await,
        }
    }
    fn is_closed(&self) -> bool {
        match self {
            Driver::Acp(d) => d.is_closed(),
            Driver::Codex(d) => d.is_closed(),
        }
    }
}

/// When a project's file list was read, and the list.
type CachedFiles = (std::time::Instant, Arc<Vec<String>>);

struct AgentRow {
    agent: Agent,
    title_custom: bool,
}

#[derive(Clone)]
pub struct Core {
    inner: Arc<Inner>,
}

struct Inner {
    data_dir: PathBuf,
    sink: Arc<dyn EventSink>,
    db: Db,
    agents: Mutex<HashMap<String, AgentRow>>,
    accounts: Mutex<HashMap<String, Account>>,
    settings: Mutex<Settings>,
    ctxs: Mutex<HashMap<String, Arc<AgentCtx>>>,
    live: Mutex<HashMap<String, Driver>>,
    /// Project file listings for @-mentions, keyed by folder.
    file_cache: Mutex<HashMap<PathBuf, CachedFiles>>,
    /// account id → when it last hit a usage limit (for failover decisions).
    limited_accounts: Mutex<HashMap<String, i64>>,
    start_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

#[derive(Clone)]
pub(crate) struct WeakCore(Weak<Inner>);

impl WeakCore {
    pub(crate) fn upgrade(&self) -> Option<Core> {
        self.0.upgrade().map(|inner| Core { inner })
    }
}

fn provider_color(p: Provider) -> &'static str {
    match p {
        Provider::Claude => "#D97757",
        Provider::Codex => "#10A37F",
        Provider::Grok => "#E5E7EB",
        Provider::Custom => "#B39DDB",
    }
}

fn title_from_prompt(prompt: &str) -> String {
    let line = prompt
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("New agent");
    if line.chars().count() > 60 {
        format!("{}…", line.chars().take(59).collect::<String>().trim_end())
    } else {
        line.to_string()
    }
}

impl Core {
    /// Opens (or creates) the database under `data_dir`, ensures a "System" account
    /// exists for each provider, and marks agents that were mid-turn as `interrupted`.
    /// Must be called inside a tokio runtime.
    pub fn open(data_dir: PathBuf, sink: Arc<dyn EventSink>) -> Result<Core> {
        std::fs::create_dir_all(&data_dir)
            .with_context(|| format!("creating {}", data_dir.display()))?;
        let db = Db::open(&data_dir.join("armada.db"))?;

        let mut accounts: HashMap<String, Account> = db
            .accounts()?
            .into_iter()
            .map(|a| (a.id.clone(), a))
            .collect();
        for provider in Provider::ALL.into_iter().chain([Provider::Custom]) {
            if !accounts
                .values()
                .any(|a| a.provider == provider && a.is_system)
            {
                let account = Account {
                    id: format!("system-{}", provider.as_str()),
                    provider,
                    name: if provider == Provider::Custom {
                        "Default".into()
                    } else {
                        "System".into()
                    },
                    color: provider_color(provider).into(),
                    auth_kind: AuthKind::Default,
                    is_system: true,
                    config_dir: None,
                    created_at: now_ms(),
                    status: None,
                    usage: None,
                };
                db.put_account(&account)?;
                accounts.insert(account.id.clone(), account);
            }
        }

        let mut agents = HashMap::new();
        for (mut agent, title_custom) in db.agents()? {
            let mut dirty = false;
            if agent.status.is_busy() {
                agent.status = AgentStatus::Interrupted;
                dirty = true;
            }
            if agent.running || agent.pending_permissions != 0 {
                agent.running = false;
                agent.pending_permissions = 0;
                dirty = true;
            }
            if dirty {
                db.put_agent(&agent)?;
            }
            agents.insert(
                agent.id.clone(),
                AgentRow {
                    agent,
                    title_custom,
                },
            );
        }
        // Approvals that were pending when the app closed can't be answered anymore.
        for mut item in db.unresolved_permissions()? {
            if let ItemBody::Permission { resolution, .. } = &mut item.body {
                *resolution = Some("cancelled".into());
            }
            db.put_item(&item)?;
        }
        let settings = db.settings()?;

        Ok(Core {
            inner: Arc::new(Inner {
                data_dir,
                sink,
                db,
                agents: Mutex::new(agents),
                accounts: Mutex::new(accounts),
                settings: Mutex::new(settings),
                ctxs: Mutex::default(),
                live: Mutex::default(),
                limited_accounts: Mutex::default(),
                file_cache: Mutex::default(),
                start_locks: Mutex::default(),
            }),
        })
    }

    /// Resumes interrupted agents when `settings.auto_resume` is on.
    pub async fn startup(&self) {
        self.spawn_scheduler();
        if !self.inner.settings.lock().auto_resume {
            return;
        }
        let interrupted: Vec<String> = self
            .inner
            .agents
            .lock()
            .values()
            .filter(|r| r.agent.status == AgentStatus::Interrupted && !r.agent.archived)
            .map(|r| r.agent.id.clone())
            .collect();
        for id in interrupted {
            let core = self.clone();
            tokio::spawn(async move {
                if let Err(e) = core.resume_agent(&id, true).await {
                    tracing::warn!("auto-resume {id}: {e:#}");
                }
            });
        }
    }

    /// Stops all agent processes; agents that were busy are marked `interrupted`.
    pub async fn shutdown(&self) {
        let live: Vec<(String, Driver)> = self.inner.live.lock().drain().collect();
        for (id, driver) in live {
            let ctx = self.ctx(&id);
            ctx.set_exit_intent(ExitIntent::Shutdown);
            ctx.flush();
            let _ = self.update_agent(&id, |a| {
                if a.status.is_busy() {
                    a.status = AgentStatus::Interrupted;
                }
                a.running = false;
                a.pending_permissions = 0;
            });
            driver.shutdown().await;
        }
        for ctx in self.inner.ctxs.lock().values() {
            ctx.flush();
        }
    }

    pub fn data_dir(&self) -> &Path {
        &self.inner.data_dir
    }

    pub fn emit(&self, event: ArmadaEvent) {
        self.inner.sink.emit(event)
    }

    pub(crate) fn db(&self) -> &Db {
        &self.inner.db
    }

    fn weak(&self) -> WeakCore {
        WeakCore(Arc::downgrade(&self.inner))
    }

    fn ctx(&self, agent_id: &str) -> Arc<AgentCtx> {
        let mut ctxs = self.inner.ctxs.lock();
        ctxs.entry(agent_id.to_string())
            .or_insert_with(|| {
                let seq = self.inner.db.max_seq(agent_id).unwrap_or(0);
                Arc::new(AgentCtx::new(self.weak(), agent_id.to_string(), seq))
            })
            .clone()
    }

    pub(crate) fn update_agent(&self, agent_id: &str, f: impl FnOnce(&mut Agent)) -> Result<Agent> {
        let mut agents = self.inner.agents.lock();
        let row = agents
            .get_mut(agent_id)
            .ok_or_else(|| anyhow!("Agent not found"))?;
        f(&mut row.agent);
        row.agent.updated_at = now_ms();
        self.inner.db.put_agent(&row.agent)?;
        let agent = row.agent.clone();
        // Emitted under the lock so concurrent updates reach the UI in order
        // (the sink only queues the event).
        self.emit(ArmadaEvent::AgentUpdated {
            agent: agent.clone(),
        });
        Ok(agent)
    }

    /// Updates the in-memory preview without persisting or emitting (streaming is
    /// already visible through text deltas; the next status change persists it).
    pub(crate) fn set_preview_quiet(&self, agent_id: &str, preview: String) {
        if let Some(row) = self.inner.agents.lock().get_mut(agent_id) {
            row.agent.last_message = Some(preview);
        }
    }

    pub(crate) fn suggest_title(&self, agent_id: &str, title: &str) {
        let custom = self
            .inner
            .agents
            .lock()
            .get(agent_id)
            .map(|r| r.title_custom)
            .unwrap_or(true);
        let title = title.trim();
        if !custom && !title.is_empty() {
            let title: String = title.chars().take(80).collect();
            let _ = self.update_agent(agent_id, |a| a.title = title);
        }
    }

    pub(crate) fn driver_exited(&self, agent_id: &str) {
        let mut live = self.inner.live.lock();
        if live.get(agent_id).is_some_and(Driver::is_closed) {
            live.remove(agent_id);
        }
    }

    // ---- state -------------------------------------------------------------

    pub fn agents(&self) -> Result<Vec<Agent>> {
        let mut list: Vec<Agent> = self
            .inner
            .agents
            .lock()
            .values()
            .map(|r| r.agent.clone())
            .collect();
        list.sort_by_key(|a| std::cmp::Reverse(a.last_activity_at));
        Ok(list)
    }

    pub fn agent(&self, agent_id: &str) -> Result<Agent> {
        self.inner
            .agents
            .lock()
            .get(agent_id)
            .map(|r| r.agent.clone())
            .ok_or_else(|| anyhow!("Agent not found"))
    }

    pub fn items(&self, agent_id: &str) -> Result<Vec<TimelineItem>> {
        if let Some(ctx) = self.inner.ctxs.lock().get(agent_id) {
            ctx.flush();
        }
        self.inner.db.items(agent_id)
    }

    pub fn search(&self, query: &str) -> Result<Vec<SearchHit>> {
        self.inner.db.search(query)
    }

    pub fn settings(&self) -> Result<Settings> {
        Ok(self.inner.settings.lock().clone())
    }

    pub fn save_settings(&self, settings: Settings) -> Result<Settings> {
        self.inner.db.put_settings(&settings)?;
        *self.inner.settings.lock() = settings.clone();
        Ok(settings)
    }

    // ---- accounts ------------------------------------------------------------

    pub fn accounts(&self) -> Result<Vec<Account>> {
        let mut list: Vec<Account> = self.inner.accounts.lock().values().cloned().collect();
        list.sort_by(|a, b| {
            (a.provider.as_str(), !a.is_system, a.created_at).cmp(&(
                b.provider.as_str(),
                !b.is_system,
                b.created_at,
            ))
        });
        Ok(list)
    }

    pub fn account(&self, account_id: &str) -> Result<Account> {
        self.inner
            .accounts
            .lock()
            .get(account_id)
            .cloned()
            .ok_or_else(|| anyhow!("Account not found"))
    }

    fn put_account(&self, account: Account) -> Result<Account> {
        self.inner.db.put_account(&account)?;
        self.inner
            .accounts
            .lock()
            .insert(account.id.clone(), account.clone());
        self.emit(ArmadaEvent::AccountUpdated {
            account: account.clone(),
        });
        Ok(account)
    }

    /// Creates the profile dir, stores the API key in the keychain (and runs
    /// `codex login --with-api-key` for Codex). Emits `account_updated`.
    pub async fn create_account(&self, req: CreateAccountRequest) -> Result<Account> {
        let name = req.name.trim();
        if name.is_empty() {
            bail!("Give the account a name");
        }
        let id = uuid::Uuid::new_v4().to_string();
        let dir = accounts::profile_dir(&self.inner.data_dir, &id);
        std::fs::create_dir_all(&dir)?;
        let auth_kind = match req.auth_kind {
            AuthKind::Default => AuthKind::Oauth,
            k => k,
        };
        let mut account = Account {
            id: id.clone(),
            provider: req.provider,
            name: name.to_string(),
            color: req.color,
            auth_kind,
            is_system: false,
            config_dir: Some(dir.to_string_lossy().into_owned()),
            created_at: now_ms(),
            status: None,
            usage: None,
        };
        if auth_kind == AuthKind::ApiKey {
            let key = req
                .api_key
                .as_deref()
                .map(str::trim)
                .filter(|k| !k.is_empty())
                .ok_or_else(|| anyhow!("Enter an API key"))?;
            accounts::set_api_key(&id, key)?;
            if req.provider == Provider::Codex {
                if let Err(e) = accounts::codex_store_api_key(&account, key).await {
                    tracing::warn!("codex api key login: {e:#}");
                }
            }
            account.status = Some(accounts::check_status(&account).await);
        }
        self.put_account(account)
    }

    pub fn update_account(&self, account_id: &str, name: &str, color: &str) -> Result<Account> {
        let mut account = self.account(account_id)?;
        if !name.trim().is_empty() {
            account.name = name.trim().to_string();
        }
        account.color = color.to_string();
        self.put_account(account)
    }

    /// Persists a fresh status for the account and emits `account_updated`.
    pub fn set_account_status(&self, account_id: &str, status: AccountStatus) -> Result<Account> {
        let mut account = self.account(account_id)?;
        account.status = Some(status);
        self.put_account(account)
    }

    /// Runs `accounts::check_status` and persists the result.
    pub async fn check_account(&self, account_id: &str) -> Result<Account> {
        let account = self.account(account_id)?;
        let status = accounts::check_status(&account).await;
        self.set_account_status(account_id, status)
    }

    /// Fails if the account is a system account or still used by agents.
    pub fn delete_account(&self, account_id: &str) -> Result<()> {
        let account = self.account(account_id)?;
        if account.is_system {
            bail!("The system account can't be removed");
        }
        let users = self
            .inner
            .agents
            .lock()
            .values()
            .filter(|r| r.agent.account_id == account_id)
            .count();
        if users > 0 {
            bail!("{users} agent(s) still use this account. Delete them first.");
        }
        accounts::delete_api_key(account_id);
        let profile = accounts::profile_dir(&self.inner.data_dir, account_id);
        if profile.starts_with(self.inner.data_dir.join("profiles")) {
            let _ = std::fs::remove_dir_all(&profile);
        }
        self.inner.db.delete_account(account_id)?;
        self.inner.accounts.lock().remove(account_id);
        self.emit(ArmadaEvent::AccountRemoved {
            account_id: account_id.to_string(),
        });
        Ok(())
    }

    // ---- agent processes -----------------------------------------------------

    async fn ensure_running(&self, agent_id: &str) -> Result<Driver> {
        if let Some(d) = self.live_driver(agent_id) {
            return Ok(d);
        }
        let lock = self
            .inner
            .start_locks
            .lock()
            .entry(agent_id.to_string())
            .or_default()
            .clone();
        let _guard = lock.lock().await;
        if let Some(d) = self.live_driver(agent_id) {
            return Ok(d);
        }

        let agent = self.agent(agent_id)?;
        let account = self.account(&agent.account_id)?;
        if account.provider != agent.provider {
            bail!("Account provider doesn't match the agent");
        }
        if let Some(dir) = account.config_dir.as_deref().filter(|_| !account.is_system) {
            std::fs::create_dir_all(dir)?;
        }
        let cwd = PathBuf::from(&agent.cwd);
        if !cwd.is_dir() {
            bail!("The agent's folder no longer exists: {}", agent.cwd);
        }
        let (program, args, env) = if agent.provider == Provider::Custom {
            let def = self.custom_agent_def(agent.custom_agent_id.as_deref())?;
            let (program, args) = custom_launch(&def)?;
            let env = def
                .env
                .iter()
                .map(|e| (e.name.clone(), e.value.clone()))
                .collect();
            (program, args, env)
        } else {
            let (program, args) = providers::launch_spec(agent.provider, &self.inner.data_dir)?;
            (program, args, accounts::account_env(&account))
        };
        let mcp_servers = self.inner.settings.lock().mcp_servers.clone();
        let ctx = self.ctx(agent_id);
        let label = format!(
            "{}:{}",
            agent.provider.as_str(),
            &agent.id[..8.min(agent.id.len())]
        );
        let resume = agent.session_id.as_deref();

        let driver = match agent.provider {
            Provider::Codex => Driver::Codex(
                CodexDriver::start(
                    ctx.clone(),
                    codex::StartOptions {
                        program: &program,
                        args: &args,
                        cwd: &cwd,
                        env: &env,
                        label: &label,
                        resume,
                        version: VERSION,
                        mcp_servers: &mcp_servers,
                    },
                )
                .await?,
            ),
            Provider::Claude | Provider::Grok | Provider::Custom => Driver::Acp(
                AcpDriver::start(
                    ctx.clone(),
                    acp::StartOptions {
                        program: &program,
                        args: &args,
                        cwd: &cwd,
                        env: &env,
                        label: &label,
                        resume,
                        version: VERSION,
                        mcp_servers: &mcp_servers,
                    },
                )
                .await?,
            ),
        };
        // Stopped, cancelled or deleted while we were starting: don't keep it.
        if ctx.start_cancelled() || self.agent(agent_id).is_err() {
            ctx.set_exit_intent(ExitIntent::Stop);
            driver.shutdown().await;
            return Err(StartCancelled.into());
        }
        let session_id = driver.session_id();
        if resume.is_some_and(|prev| prev != session_id) {
            ctx.set_preamble(self.transcript(agent_id, 12_000));
        }
        self.inner
            .live
            .lock()
            .insert(agent_id.to_string(), driver.clone());
        self.update_agent(agent_id, |a| {
            a.session_id = Some(session_id);
            a.running = true;
        })?;
        Ok(driver)
    }

    fn live_driver(&self, agent_id: &str) -> Option<Driver> {
        self.inner
            .live
            .lock()
            .get(agent_id)
            .filter(|d| !d.is_closed())
            .cloned()
    }

    fn fail_start(&self, agent_id: &str, err: anyhow::Error) {
        if err.is::<StartCancelled>() {
            // Stop/cancel already updated the agent.
            return;
        }
        tracing::warn!("agent {agent_id} failed to start: {err:#}");
        let ctx = self.ctx(agent_id);
        if ctx.is_turn_active() {
            ctx.turn_finished(TurnOutcome::Failed(format!("{err:#}")));
        } else {
            ctx.notice(NoticeLevel::Error, format!("{err:#}"));
            let _ = self.update_agent(agent_id, |a| {
                a.status = AgentStatus::Error;
                a.running = false;
            });
        }
    }

    /// Ensures the adapter is running, then starts `prompt` as a turn.
    fn run_prompt(&self, agent_id: &str, prompt: Prompt, model: Option<String>) {
        let core = self.clone();
        let id = agent_id.to_string();
        tokio::spawn(async move {
            match core.ensure_running(&id).await {
                Ok(driver) => {
                    if let Some(m) = model.filter(|m| !m.trim().is_empty()) {
                        if let Err(e) = driver.set_config("model", m.trim()).await {
                            core.ctx(&id).notice(
                                NoticeLevel::Warn,
                                format!("Couldn't switch to model {m}: {e:#}"),
                            );
                        }
                    }
                    driver.prompt(prompt);
                }
                Err(e) => core.fail_start(&id, e),
            }
        });
    }

    // ---- agents ------------------------------------------------------------

    /// Creates the worktree (if requested), spawns the adapter, opens a session and
    /// sends the first prompt. Returns once the agent row exists (status `starting`).
    pub async fn create_agent(&self, req: CreateAgentRequest) -> Result<Agent> {
        self.create_agent_inner(req, None, None).await
    }

    async fn create_agent_inner(
        &self,
        req: CreateAgentRequest,
        shared_checkout: Option<&Agent>,
        schedule_id: Option<String>,
    ) -> Result<Agent> {
        let prompt = req.prompt.trim().to_string();
        if prompt.is_empty() {
            bail!("Write a prompt for the agent");
        }
        let account = self.account(&req.account_id)?;
        if account.provider != req.provider {
            bail!("That account belongs to a different provider");
        }
        let custom_agent_id = if req.provider == Provider::Custom {
            let def = self.custom_agent_def(req.custom_agent_id.as_deref())?;
            if !def.enabled {
                bail!("The custom agent \u{201c}{}\u{201d} is disabled", def.name);
            }
            Some(def.id)
        } else {
            None
        };
        validate_attachments(&req.attachments)?;
        let project = PathBuf::from(&req.project_path);
        if !project.is_dir() {
            bail!("Folder not found: {}", req.project_path);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let custom_title = req
            .title
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_string);
        let title = custom_title
            .clone()
            .unwrap_or_else(|| title_from_prompt(&prompt));

        let mut worktree_error = None;
        let (cwd, worktree, branch, base_branch, base_commit) = match shared_checkout {
            Some(src) => (
                src.cwd.clone(),
                false,
                src.branch.clone(),
                src.base_branch.clone(),
                src.base_commit.clone(),
            ),
            None => match git::repo_info(&project).await {
                Some(repo) if req.worktree => {
                    match git::create_worktree(&project, &repo, &self.inner.data_dir, &id, &title)
                        .await
                    {
                        Ok(wt) => (
                            wt.cwd.to_string_lossy().into_owned(),
                            true,
                            Some(wt.branch),
                            repo.branch,
                            Some(repo.head_commit),
                        ),
                        Err(e) => {
                            worktree_error = Some(format!("{e:#}"));
                            (
                                req.project_path.clone(),
                                false,
                                None,
                                repo.branch,
                                Some(repo.head_commit),
                            )
                        }
                    }
                }
                Some(repo) => (
                    req.project_path.clone(),
                    false,
                    None,
                    repo.branch,
                    Some(repo.head_commit),
                ),
                None => (req.project_path.clone(), false, None, None, None),
            },
        };

        let now = now_ms();
        let agent = Agent {
            id: id.clone(),
            title,
            provider: req.provider,
            account_id: req.account_id.clone(),
            project_path: req.project_path.clone(),
            cwd,
            worktree,
            branch,
            base_branch,
            base_commit,
            session_id: None,
            status: AgentStatus::Starting,
            running: false,
            group_id: req.group_id.clone(),
            created_at: now,
            updated_at: now,
            last_activity_at: now,
            cost_usd: 0.0,
            tokens_used: 0,
            context_used: None,
            context_size: None,
            unread: false,
            archived: false,
            last_message: None,
            pending_permissions: 0,
            config_options: Vec::new(),
            available_commands: Vec::new(),
            rate_limited: false,
            schedule_id,
            custom_agent_id,
        };
        self.inner.db.put_agent(&agent)?;
        if custom_title.is_some() {
            self.inner.db.set_title_custom(&id)?;
        }
        self.inner.agents.lock().insert(
            id.clone(),
            AgentRow {
                agent: agent.clone(),
                title_custom: custom_title.is_some(),
            },
        );
        self.emit(ArmadaEvent::AgentUpdated {
            agent: agent.clone(),
        });

        let ctx = self.ctx(&id);
        if let Some(err) = worktree_error {
            ctx.notice(
                NoticeLevel::Warn,
                format!("Couldn't create a git worktree, so the agent works directly in the project folder.\n{err}"),
            );
        }
        if let Some(p) = ctx.submit_prompt(&prompt, req.attachments) {
            self.run_prompt(&id, p, req.model.clone());
        }
        Ok(agent)
    }

    /// Starts the adapter + resumes the provider session first if it isn't running.
    pub async fn send_prompt(
        &self,
        agent_id: &str,
        text: &str,
        attachments: Vec<Attachment>,
    ) -> Result<()> {
        let text = text.trim();
        if text.is_empty() && attachments.is_empty() {
            bail!("Nothing to send");
        }
        validate_attachments(&attachments)?;
        let agent = self.agent(agent_id)?;
        let ctx = self.ctx(agent_id);
        let running = self.live_driver(agent_id).is_some();
        if let Some(text) = ctx.submit_prompt(text, attachments) {
            self.update_agent(agent_id, |a| {
                a.unread = false;
                a.last_activity_at = now_ms();
                if !running {
                    a.status = AgentStatus::Starting;
                }
            })?;
            self.run_prompt(&agent.id, text, None);
        }
        Ok(())
    }

    pub async fn cancel_turn(&self, agent_id: &str) -> Result<()> {
        match self.live_driver(agent_id) {
            Some(d) => d.cancel().await,
            None => {
                let ctx = self.ctx(agent_id);
                if ctx.is_starting() {
                    ctx.request_cancel_start();
                }
                if ctx.is_turn_active() {
                    ctx.turn_finished(TurnOutcome::Cancelled);
                }
                Ok(())
            }
        }
    }

    pub async fn respond_permission(
        &self,
        agent_id: &str,
        request_id: &str,
        option_id: &str,
    ) -> Result<()> {
        let driver = self
            .live_driver(agent_id)
            .ok_or_else(|| anyhow!("The agent isn't running anymore"))?;
        driver.respond_permission(request_id, option_id).await
    }

    /// Re-attaches to the provider session; with `auto_continue` it also sends
    /// "continue where you left off".
    pub async fn resume_agent(&self, agent_id: &str, auto_continue: bool) -> Result<()> {
        self.agent(agent_id)?;
        if auto_continue {
            return self
                .send_prompt(agent_id, CONTINUE_PROMPT, Vec::new())
                .await;
        }
        self.update_agent(agent_id, |a| a.status = AgentStatus::Starting)?;
        match self.ensure_running(agent_id).await {
            Ok(_) => {
                self.update_agent(agent_id, |a| a.status = AgentStatus::Idle)?;
                Ok(())
            }
            Err(e) => {
                let msg = format!("{e:#}");
                self.ctx(agent_id).notice(NoticeLevel::Error, msg.clone());
                self.update_agent(agent_id, |a| a.status = AgentStatus::Error)?;
                Err(anyhow!(msg))
            }
        }
    }

    pub async fn stop_agent(&self, agent_id: &str) -> Result<()> {
        let driver = self.inner.live.lock().remove(agent_id);
        match driver {
            Some(d) => {
                let ctx = self.ctx(agent_id);
                ctx.set_exit_intent(ExitIntent::Stop);
                d.shutdown().await;
                // Settle now rather than when the exit is noticed (idempotent).
                ctx.end_turn_early(ExitIntent::Stop);
                self.update_agent(agent_id, |a| a.running = false)?;
            }
            None => {
                let ctx = self.ctx(agent_id);
                ctx.request_cancel_start();
                ctx.end_turn_early(ExitIntent::Stop);
                self.update_agent(agent_id, |a| {
                    a.running = false;
                    if a.status.is_busy() {
                        a.status = AgentStatus::Stopped;
                    }
                })?;
            }
        }
        Ok(())
    }

    pub async fn delete_agent(&self, agent_id: &str, remove_worktree: bool) -> Result<()> {
        let agent = self.agent(agent_id)?;
        self.ctx(agent_id).request_cancel_start();
        let driver = self.inner.live.lock().remove(agent_id);
        if let Some(d) = driver {
            self.ctx(agent_id).set_exit_intent(ExitIntent::Shutdown);
            d.shutdown().await;
        }
        if remove_worktree && agent.worktree {
            let shared = self
                .inner
                .agents
                .lock()
                .values()
                .any(|r| r.agent.id != agent.id && r.agent.cwd == agent.cwd);
            if !shared {
                git::remove_worktree(
                    Path::new(&agent.project_path),
                    Path::new(&agent.cwd),
                    agent.branch.as_deref(),
                )
                .await;
            }
        }
        self.inner.db.delete_agent(agent_id)?;
        self.inner.agents.lock().remove(agent_id);
        self.inner.ctxs.lock().remove(agent_id);
        self.inner.start_locks.lock().remove(agent_id);
        self.emit(ArmadaEvent::AgentRemoved {
            agent_id: agent_id.to_string(),
        });
        Ok(())
    }

    pub fn rename_agent(&self, agent_id: &str, title: &str) -> Result<()> {
        let title = title.trim();
        if title.is_empty() {
            bail!("Title can't be empty");
        }
        self.update_agent(agent_id, |a| a.title = title.to_string())?;
        self.inner.db.set_title_custom(agent_id)?;
        if let Some(row) = self.inner.agents.lock().get_mut(agent_id) {
            row.title_custom = true;
        }
        Ok(())
    }

    pub fn archive_agent(&self, agent_id: &str, archived: bool) -> Result<()> {
        self.update_agent(agent_id, |a| a.archived = archived)?;
        Ok(())
    }

    pub fn mark_read(&self, agent_id: &str) -> Result<()> {
        if self.agent(agent_id)?.unread {
            self.update_agent(agent_id, |a| a.unread = false)?;
        }
        Ok(())
    }

    pub async fn set_agent_config(
        &self,
        agent_id: &str,
        option_id: &str,
        value: &str,
    ) -> Result<()> {
        let driver = self.ensure_running(agent_id).await?;
        driver.set_config(option_id, value).await
    }

    /// New agent on another provider/account, seeded with this agent's context.
    pub async fn handoff_agent(
        &self,
        agent_id: &str,
        provider: Provider,
        account_id: &str,
        instruction: &str,
        custom_agent_id: Option<&str>,
    ) -> Result<Agent> {
        let src = self.agent(agent_id)?;
        let instruction = instruction.trim();
        if instruction.is_empty() {
            bail!("Say what the next agent should do");
        }
        let mut brief = format!(
            "You are picking up work that another AI coding agent ({}) started in this folder, in a session titled \"{}\".\n",
            src.provider.display_name(),
            src.title
        );
        if let Some(branch) = &src.branch {
            brief.push_str(&format!(
                "Its changes are on the git branch `{branch}` in the current working directory.\n"
            ));
        }
        let files = self.touched_files(agent_id);
        if !files.is_empty() {
            brief.push_str("\nFiles it touched:\n");
            for f in files.iter().take(40) {
                brief.push_str(&format!("- {f}\n"));
            }
        }
        brief.push_str("\nTheir conversation so far (oldest first, may be abridged):\n\n");
        brief.push_str(&self.transcript(agent_id, 10_000));
        brief.push_str(&format!("\n\n---\n\nYour task: {instruction}"));

        let req = CreateAgentRequest {
            provider,
            account_id: account_id.to_string(),
            project_path: src.project_path.clone(),
            prompt: brief,
            title: Some(format!("{} ↗ {}", src.title, provider.display_name())),
            worktree: false,
            model: None,
            group_id: src.group_id.clone(),
            custom_agent_id: custom_agent_id.map(str::to_string),
            attachments: Vec::new(),
        };
        self.create_agent_inner(req, Some(&src), None).await
    }

    /// Files the agent edited, deleted or moved (absolute or cwd-relative paths).
    pub fn touched_files(&self, agent_id: &str) -> Vec<String> {
        let mut files: Vec<String> = Vec::new();
        for item in self.items(agent_id).unwrap_or_default() {
            if let ItemBody::ToolCall {
                tool_kind: ToolKind::Edit | ToolKind::Delete | ToolKind::Move,
                locations,
                diffs,
                ..
            } = &item.body
            {
                for p in locations.iter().chain(diffs.iter().map(|d| &d.path)) {
                    if !files.contains(p) {
                        files.push(p.clone());
                    }
                }
            }
        }
        files
    }

    /// Compact plain-text history used to brief a fresh session.
    fn transcript(&self, agent_id: &str, budget: usize) -> String {
        let clip = |s: &str, n: usize| -> String {
            if s.chars().count() > n {
                format!("{}…", s.chars().take(n).collect::<String>())
            } else {
                s.to_string()
            }
        };
        let mut lines: Vec<String> = Vec::new();
        for item in self.items(agent_id).unwrap_or_default() {
            match &item.body {
                ItemBody::UserMessage { text, .. } => {
                    lines.push(format!("USER: {}", clip(text, 1500)))
                }
                ItemBody::AgentMessage { text } if !text.trim().is_empty() => {
                    lines.push(format!("AGENT: {}", clip(text, 1500)))
                }
                ItemBody::ToolCall { title, .. } => {
                    lines.push(format!("(tool) {}", clip(title, 160)))
                }
                _ => {}
            }
        }
        let mut out: Vec<&str> = Vec::new();
        let mut used = 0;
        for line in lines.iter().rev() {
            if used + line.len() > budget {
                out.push("[earlier history omitted]");
                break;
            }
            used += line.len() + 1;
            out.push(line);
        }
        out.reverse();
        let mut text = String::from("[Context: this conversation was restored by Armada]\n");
        text.push_str(&out.join("\n"));
        text
    }
}

// ---- accounts failover, export, schedules ---------------------------------------

/// Don't auto-switch back to an account that hit its limit within this window.
const LIMIT_COOLDOWN_MS: i64 = 60 * 60 * 1000;
/// A missed scheduled run still fires if Armada starts within this window.
const SCHEDULE_GRACE_MS: i64 = 6 * 60 * 60 * 1000;

impl Core {
    /// Moves the agent to another account of the same provider. Provider sessions
    /// live in the old account's profile, so the next turn starts a fresh session
    /// that is briefed with the conversation so far.
    pub async fn switch_account(&self, agent_id: &str, account_id: &str) -> Result<Agent> {
        let agent = self.agent(agent_id)?;
        let account = self.account(account_id)?;
        if account.provider != agent.provider {
            bail!("That account belongs to a different provider");
        }
        if agent.account_id == account_id {
            return Ok(agent);
        }
        let ctx = self.ctx(agent_id);
        if ctx.is_turn_active() {
            bail!("Wait for the current turn to finish (or cancel it) before switching accounts");
        }
        let driver = self.inner.live.lock().remove(agent_id);
        if let Some(d) = driver {
            ctx.set_exit_intent(ExitIntent::Stop);
            d.shutdown().await;
        }
        ctx.set_preamble(self.transcript(agent_id, 12_000));
        let agent = self.update_agent(agent_id, |a| {
            a.account_id = account_id.to_string();
            a.session_id = None;
            a.running = false;
            a.rate_limited = false;
            if matches!(a.status, AgentStatus::Error | AgentStatus::Interrupted) {
                a.status = AgentStatus::Idle;
            }
        })?;
        ctx.notice(
            NoticeLevel::Info,
            format!(
                "Switched to the account \u{201c}{}\u{201d}. The agent will be briefed with the conversation so far.",
                account.name
            ),
        );
        Ok(agent)
    }

    /// Called when a turn fails on a usage/rate limit; applies `settings.failover`.
    pub(crate) async fn on_rate_limited(&self, agent_id: &str) {
        let Ok(agent) = self.agent(agent_id) else {
            return;
        };
        let now = now_ms();
        self.inner
            .limited_accounts
            .lock()
            .insert(agent.account_id.clone(), now);
        let mode = self.inner.settings.lock().failover.clone();
        if mode == "off" {
            return;
        }
        let candidate = {
            let limited = self.inner.limited_accounts.lock();
            let mut list: Vec<Account> = self
                .inner
                .accounts
                .lock()
                .values()
                .filter(|a| a.provider == agent.provider && a.id != agent.account_id)
                .filter(|a| a.status.as_ref().is_some_and(|s| s.logged_in))
                .filter(|a| {
                    limited
                        .get(&a.id)
                        .is_none_or(|t| now - t > LIMIT_COOLDOWN_MS)
                })
                .cloned()
                .collect();
            list.sort_by_key(|a| a.created_at);
            list.into_iter().next()
        };
        let ctx = self.ctx(agent_id);
        let Some(next) = candidate else {
            ctx.notice(
                NoticeLevel::Warn,
                "This account hit its usage limit and no other signed-in account for this provider is available. Add one in Accounts, or try again later.",
            );
            return;
        };
        if mode != "auto" {
            ctx.notice(
                NoticeLevel::Warn,
                format!(
                    "This account hit its usage limit. You can switch this agent to \u{201c}{}\u{201d} and keep going.",
                    next.name
                ),
            );
            return;
        }
        match self.switch_account(agent_id, &next.id).await {
            Ok(_) => {
                if let Err(e) = self
                    .send_prompt(
                        agent_id,
                        "You hit a usage limit on the previous account. Please continue where you left off.",
                        Vec::new(),
                    )
                    .await
                {
                    tracing::warn!("failover continue: {e:#}");
                }
            }
            Err(e) => ctx.notice(NoticeLevel::Error, format!("Automatic account switch failed: {e:#}")),
        }
    }

    /// Writes the conversation to `path`: JSON if it ends in `.json`, else Markdown.
    pub fn export_agent(&self, agent_id: &str, path: &str) -> Result<()> {
        let agent = self.agent(agent_id)?;
        let items = self.items(agent_id)?;
        let path = Path::new(path);
        let is_json = path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("json"));
        let content = if is_json {
            serde_json::to_string_pretty(&serde_json::json!({
                "exportedBy": format!("Armada {VERSION}"),
                "exportedAt": now_ms(),
                "agent": agent,
                "items": items,
            }))?
        } else {
            transcript_markdown(&agent, &items)
        };
        std::fs::write(path, content).with_context(|| format!("writing {}", path.display()))?;
        Ok(())
    }

    pub fn schedules(&self) -> Result<Vec<Schedule>> {
        let mut list = self.inner.db.schedules()?;
        list.sort_by_key(|a| a.name.to_lowercase());
        Ok(list)
    }

    pub fn save_schedule(&self, mut schedule: Schedule) -> Result<Schedule> {
        schedule.name = schedule.name.trim().to_string();
        if schedule.name.is_empty() {
            bail!("Give the schedule a name");
        }
        if schedule.prompt.trim().is_empty() {
            bail!("Write a prompt for the scheduled agent");
        }
        if parse_hhmm(&schedule.time).is_none() {
            bail!("Time must look like 09:30");
        }
        if schedule.days.iter().any(|d| *d > 6) {
            bail!("Days must be 0 (Sunday) to 6 (Saturday)");
        }
        let account = self.account(&schedule.account_id)?;
        if account.provider != schedule.provider {
            bail!("That account belongs to a different provider");
        }
        if !Path::new(&schedule.project_path).is_dir() {
            bail!("Folder not found: {}", schedule.project_path);
        }
        let existing = self
            .inner
            .db
            .schedules()?
            .into_iter()
            .find(|s| s.id == schedule.id && !s.id.is_empty());
        if schedule.id.is_empty() {
            schedule.id = uuid::Uuid::new_v4().to_string();
        }
        if let Some(prev) = existing {
            schedule.last_run_at = prev.last_run_at;
            schedule.last_agent_id = prev.last_agent_id;
        }
        schedule.days.sort_unstable();
        schedule.days.dedup();
        schedule.updated_at = now_ms();
        self.inner.db.put_schedule(&schedule)?;
        Ok(schedule)
    }

    pub fn delete_schedule(&self, schedule_id: &str) -> Result<()> {
        self.inner.db.delete_schedule(schedule_id)
    }

    /// Starts the scheduled agent now (also used by the scheduler).
    pub async fn run_schedule(&self, schedule_id: &str) -> Result<Agent> {
        let mut schedule = self
            .inner
            .db
            .schedules()?
            .into_iter()
            .find(|s| s.id == schedule_id)
            .ok_or_else(|| anyhow!("Schedule not found"))?;
        let stamp = Local::now().format("%b %-d, %H:%M");
        let req = CreateAgentRequest {
            provider: schedule.provider,
            account_id: schedule.account_id.clone(),
            project_path: schedule.project_path.clone(),
            prompt: schedule.prompt.clone(),
            title: Some(format!("{} \u{00b7} {stamp}", schedule.name)),
            worktree: schedule.worktree,
            model: None,
            group_id: None,
            custom_agent_id: schedule.custom_agent_id.clone(),
            attachments: Vec::new(),
        };
        // Record the run first so a failing schedule can't fire again every tick.
        schedule.last_run_at = Some(now_ms());
        self.inner.db.put_schedule(&schedule)?;
        let agent = self
            .create_agent_inner(req, None, Some(schedule.id.clone()))
            .await?;
        // Re-read: the schedule may have been edited or deleted meanwhile.
        if let Some(mut current) = self
            .inner
            .db
            .schedules()?
            .into_iter()
            .find(|s| s.id == schedule.id)
        {
            current.last_agent_id = Some(agent.id.clone());
            current.last_run_at = schedule.last_run_at;
            self.inner.db.put_schedule(&current)?;
        }
        Ok(agent)
    }

    fn spawn_scheduler(&self) {
        let weak = self.weak();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(30));
            loop {
                tick.tick().await;
                let Some(core) = weak.upgrade() else {
                    break;
                };
                let now = Local::now();
                let due: Vec<String> = core
                    .inner
                    .db
                    .schedules()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|s| schedule_due(s, now))
                    .map(|s| s.id)
                    .collect();
                for id in due {
                    match core.run_schedule(&id).await {
                        Ok(agent) => tracing::info!("schedule {id} started agent {}", agent.id),
                        Err(e) => tracing::warn!("schedule {id} failed: {e:#}"),
                    }
                }
            }
        });
    }
}

fn parse_hhmm(s: &str) -> Option<(u32, u32)> {
    let (h, m) = s.trim().split_once(':')?;
    let (h, m) = (h.trim().parse().ok()?, m.trim().parse().ok()?);
    (h < 24 && m < 60).then_some((h, m))
}

/// Whether `s` should run at `now`: today's occurrence has passed (within the grace
/// window), it hasn't run since, and it wasn't created/edited after that occurrence.
fn schedule_due(s: &Schedule, now: chrono::DateTime<Local>) -> bool {
    if !s.enabled {
        return false;
    }
    let Some((h, m)) = parse_hhmm(&s.time) else {
        return false;
    };
    // Today's occurrence, or yesterday's if it's still inside the grace window
    // (e.g. 23:30 schedule, Armada opened at 00:15).
    let today = now.date_naive();
    [Some(today), today.pred_opt()]
        .into_iter()
        .flatten()
        .any(|day| {
            let weekday = day.weekday().num_days_from_sunday() as u8;
            if !s.days.is_empty() && !s.days.contains(&weekday) {
                return false;
            }
            let Some(naive) = day.and_hms_opt(h, m, 0) else {
                return false;
            };
            // In a DST spring-forward gap the time doesn't exist; run an hour later.
            let occurrence = match Local.from_local_datetime(&naive) {
                chrono::LocalResult::Single(t) => t,
                chrono::LocalResult::Ambiguous(t, _) => t,
                chrono::LocalResult::None => {
                    match Local
                        .from_local_datetime(&(naive + chrono::Duration::hours(1)))
                        .earliest()
                    {
                        Some(t) => t,
                        None => return false,
                    }
                }
            };
            let at = occurrence.timestamp_millis();
            let now_ms = now.timestamp_millis();
            now_ms >= at
                && now_ms - at <= SCHEDULE_GRACE_MS
                && s.last_run_at.is_none_or(|last| last < at)
                && s.updated_at <= at
        })
}

fn transcript_markdown(agent: &Agent, items: &[TimelineItem]) -> String {
    let mut md = format!(
        "# {}\n\n- Provider: {}\n- Project: `{}`\n",
        agent.title,
        agent.provider.display_name(),
        agent.project_path
    );
    if let Some(branch) = &agent.branch {
        md.push_str(&format!("- Branch: `{branch}`\n"));
    }
    md.push_str(&format!("- Exported by Armada {VERSION}\n\n---\n\n"));
    for item in items {
        match &item.body {
            ItemBody::UserMessage { text, .. } => md.push_str(&format!("### You\n\n{text}\n\n")),
            ItemBody::AgentMessage { text } => md.push_str(&format!("### Agent\n\n{text}\n\n")),
            ItemBody::Thought { text } if !text.trim().is_empty() => md.push_str(&format!(
                "<details><summary>Thinking</summary>\n\n{text}\n\n</details>\n\n"
            )),
            ItemBody::ToolCall {
                title,
                status,
                command,
                output,
                ..
            } => {
                md.push_str(&format!("- **{title}** ({status:?})\n"));
                if let Some(cmd) = command {
                    md.push_str(&format!("\n  ```sh\n  {cmd}\n  ```\n"));
                }
                if !output.trim().is_empty() {
                    let clipped: String = output.chars().take(4000).collect();
                    md.push_str(&format!("\n  ```\n{clipped}\n  ```\n"));
                }
                md.push('\n');
            }
            ItemBody::Permission {
                title, resolution, ..
            } => md.push_str(&format!(
                "> **Approval requested:** {title} \u{2192} {}\n\n",
                resolution.as_deref().unwrap_or("pending")
            )),
            ItemBody::Plan { entries } => {
                md.push_str("**Plan**\n\n");
                for e in entries {
                    let mark = if e.status == PlanStatus::Completed {
                        "x"
                    } else {
                        " "
                    };
                    md.push_str(&format!("- [{mark}] {}\n", e.content));
                }
                md.push('\n');
            }
            ItemBody::Notice { text, .. } => md.push_str(&format!("> {text}\n\n")),
            ItemBody::Thought { .. } => {}
        }
    }
    md
}

// ---- custom agents, attachments, files, usage ---------------------------------------

const MAX_ATTACHMENTS: usize = 8;
const FILE_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(15);
const MAX_ATTACHMENT_BYTES: usize = 5 * 1024 * 1024;

fn validate_attachments(list: &[Attachment]) -> Result<()> {
    if list.len() > MAX_ATTACHMENTS {
        bail!("Attach at most {MAX_ATTACHMENTS} images per message");
    }
    for a in list {
        if !a.mime_type.starts_with("image/") {
            bail!("{} isn't an image", a.name);
        }
        if a.data.len() / 4 * 3 > MAX_ATTACHMENT_BYTES {
            bail!("{} is larger than 5 MB", a.name);
        }
    }
    Ok(())
}

/// Resolves a custom agent's command (PATH lookup unless it's a path).
fn custom_launch(def: &CustomAgent) -> Result<(PathBuf, Vec<String>)> {
    let cmd = def.command.trim();
    if cmd.is_empty() {
        bail!(
            "The custom agent \u{201c}{}\u{201d} has no command",
            def.name
        );
    }
    let program = which::which(cmd).map_err(|_| {
        anyhow!(
            "Couldn't find `{cmd}` for the custom agent \u{201c}{}\u{201d}. Install it or use a full path.",
            def.name
        )
    })?;
    Ok((program, def.args.clone()))
}

impl Core {
    fn custom_agent_def(&self, id: Option<&str>) -> Result<CustomAgent> {
        let id = id.ok_or_else(|| anyhow!("Pick which custom agent to run"))?;
        self.inner
            .settings
            .lock()
            .custom_agents
            .iter()
            .find(|c| c.id == id)
            .cloned()
            .ok_or_else(|| {
                anyhow!("That custom agent no longer exists. Re-add it in Settings → Agents.")
            })
    }

    /// Starts the agent, completes the ACP handshake and reports who answered.
    pub async fn test_custom_agent(&self, def: CustomAgent) -> Result<String> {
        let (program, args) = custom_launch(&def)?;
        let env: Vec<(String, String)> = def
            .env
            .iter()
            .map(|e| (e.name.clone(), e.value.clone()))
            .collect();
        let cwd = providers::home_dir().unwrap_or_else(std::env::temp_dir);
        crate::acp::probe(&program, &args, &env, &cwd).await
    }

    /// Project files matching `query` (fuzzy), for @-mentions in the composer.
    pub async fn list_files(&self, agent_id: &str, query: &str) -> Result<Vec<String>> {
        let agent = self.agent(agent_id)?;
        let cwd = PathBuf::from(&agent.cwd);
        let cached = self
            .inner
            .file_cache
            .lock()
            .get(&cwd)
            .filter(|(at, _)| at.elapsed() < FILE_CACHE_TTL)
            .map(|(_, files)| files.clone());
        let files = match cached {
            Some(files) => files,
            None => {
                let dir = cwd.clone();
                let files = Arc::new(
                    tokio::task::spawn_blocking(move || crate::files::project_files(&dir))
                        .await
                        .map_err(|e| anyhow!("{e}"))??,
                );
                let mut cache = self.inner.file_cache.lock();
                cache.retain(|_, (at, _)| at.elapsed() < FILE_CACHE_TTL);
                cache.insert(cwd, (std::time::Instant::now(), files.clone()));
                files
            }
        };
        Ok(crate::files::fuzzy_filter(&files, query, 50))
    }

    /// Records a provider-reported usage snapshot on the agent's account.
    pub(crate) fn set_agent_account_usage(&self, agent_id: &str, usage: AccountUsage) {
        let Ok(agent) = self.agent(agent_id) else {
            return;
        };
        if let Ok(mut account) = self.account(&agent.account_id) {
            account.usage = Some(usage);
            let _ = self.put_account(account);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sched(time: &str, days: Vec<u8>) -> Schedule {
        Schedule {
            id: "s".into(),
            name: "n".into(),
            enabled: true,
            provider: Provider::Claude,
            account_id: "a".into(),
            project_path: "/".into(),
            prompt: "p".into(),
            worktree: false,
            time: time.into(),
            days,
            last_run_at: None,
            last_agent_id: None,
            custom_agent_id: None,
            updated_at: 0,
        }
    }

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> chrono::DateTime<Local> {
        Local
            .with_ymd_and_hms(y, mo, d, h, mi, 0)
            .earliest()
            .unwrap()
    }

    #[test]
    fn schedule_timing() {
        // 2026-10-26 is a Monday.
        let s = sched("09:00", vec![]);
        assert!(!schedule_due(&s, at(2026, 10, 26, 8, 59)));
        assert!(schedule_due(&s, at(2026, 10, 26, 9, 0)));
        assert!(schedule_due(&s, at(2026, 10, 26, 14, 0)));
        assert!(
            !schedule_due(&s, at(2026, 10, 26, 15, 30)),
            "outside grace window"
        );

        let mut ran = s.clone();
        ran.last_run_at = Some(at(2026, 10, 26, 9, 0).timestamp_millis());
        assert!(
            !schedule_due(&ran, at(2026, 10, 26, 9, 30)),
            "already ran today"
        );
        assert!(
            schedule_due(&ran, at(2026, 10, 27, 9, 0)),
            "runs again tomorrow"
        );

        let mut edited = s.clone();
        edited.updated_at = at(2026, 10, 26, 10, 0).timestamp_millis();
        assert!(
            !schedule_due(&edited, at(2026, 10, 26, 10, 30)),
            "no retroactive run"
        );

        let weekdays = sched("09:00", vec![1, 2, 3, 4, 5]);
        assert!(schedule_due(&weekdays, at(2026, 10, 26, 9, 5)));
        assert!(
            !schedule_due(&weekdays, at(2026, 10, 25, 9, 5)),
            "Sunday excluded"
        );

        let mut off = s.clone();
        off.enabled = false;
        assert!(!schedule_due(&off, at(2026, 10, 26, 9, 5)));
        assert!(parse_hhmm("24:00").is_none());
        assert!(parse_hhmm("9:5").is_some());
    }

    #[test]
    fn rate_limit_detection() {
        use crate::session::is_rate_limit;
        assert!(is_rate_limit("You've hit your usage limit. Resets at 5pm"));
        assert!(is_rate_limit("unexpected status 429 Too Many Requests"));
        assert!(is_rate_limit("Error: rate_limit_error"));
        assert!(!is_rate_limit("error on line 429 of main.rs"));
        assert!(!is_rate_limit("Sign-in required: 401 Unauthorized"));
    }
}
