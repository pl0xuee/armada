//! The agent supervisor. `Core` is cheap to clone and safe to share across threads.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};

use anyhow::{anyhow, bail, Context};
use chrono::{Datelike, Local, TimeZone};
use parking_lot::Mutex;

use crate::acp::{self, AcpDriver};
use crate::codex::{self, CodexDriver};
use crate::db::Db;
use crate::model::*;
use crate::session::{AgentCtx, ExitIntent, Prompt, StartCancelled, TurnOutcome};
use crate::{accounts, git, providers, EventSink, Result};

const VERSION: &str = env!("CARGO_PKG_VERSION");

const CONTINUE_PROMPT: &str =
    "Armada was closed while you were working on this. Please continue where you left off.";

/// Refusal text while `Core::shutdown` runs (UI and remote may show it).
pub const SHUTTING_DOWN: &str = "Armada is shutting down";

/// How long a cancelled turn may take to end before its process is restarted.
const CANCEL_WATCHDOG_MS: u64 = 20_000;
/// Interrupted agents resumed at the same time on startup.
const AUTO_RESUME_CONCURRENCY: usize = 3;

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
    fn generation(&self) -> u64 {
        match self {
            Driver::Acp(d) => d.generation(),
            Driver::Codex(d) => d.generation(),
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
    /// Schedules starting an agent right now (scheduler tick or "Run now").
    running_schedules: Mutex<HashSet<String>>,
    /// Set first thing in `shutdown`: no new agent processes or turns start.
    shutting_down: AtomicBool,
    /// See `CANCEL_WATCHDOG_MS` (adjustable for tests).
    cancel_watchdog_ms: AtomicU64,
}

/// Marks a schedule as starting; released on drop.
struct ScheduleClaim {
    core: Core,
    id: String,
}

impl Drop for ScheduleClaim {
    fn drop(&mut self) {
        self.core.inner.running_schedules.lock().remove(&self.id);
    }
}

/// What `Core::open` reads from the database.
struct LoadedState {
    accounts: HashMap<String, Account>,
    agents: HashMap<String, AgentRow>,
    settings: Settings,
}

/// Owner-only access to Armada's data folder (conversations, settings, profiles).
#[cfg(unix)]
fn restrict_dir(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(dir) {
        if meta.permissions().mode() & 0o077 != 0 {
            if let Err(e) = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)) {
                tracing::warn!("couldn't restrict {}: {e}", dir.display());
            }
        }
    }
}

#[cfg(not(unix))]
fn restrict_dir(_dir: &Path) {}

fn plural(n: usize, one: &str, many: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {many}")
    }
}

#[derive(Clone)]
pub(crate) struct WeakCore(Weak<Inner>);

impl WeakCore {
    pub(crate) fn upgrade(&self) -> Option<Core> {
        self.0.upgrade().map(|inner| Core { inner })
    }

    /// A handle to no core at all (unit tests of the session state machine).
    #[cfg(test)]
    pub(crate) fn dangling() -> WeakCore {
        WeakCore(Weak::new())
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

/// Placeholder title for an agent started without a prompt.
fn untitled(project: &Path) -> String {
    match project.file_name() {
        Some(name) => format!("New agent · {}", name.to_string_lossy()),
        None => "New agent".to_string(),
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
        restrict_dir(&data_dir);
        // Agent process trees a crashed previous run left behind.
        let reaped = crate::jsonrpc::reap_orphans(&data_dir.join("children.json"));
        if reaped > 0 {
            tracing::warn!("stopped {reaped} agent process group(s) left over from a previous run");
        }
        let db_path = data_dir.join("armada.db");
        let db = Db::open(&db_path)?;
        // Damage can also first show when the tables are read: start fresh then too
        // (the damaged file is kept next to the new one).
        let (db, loaded) = match Core::load_state(&db) {
            Ok(loaded) => (db, loaded),
            Err(e) if crate::db::is_corruption(&e) => {
                drop(db);
                let moved = crate::db::quarantine(&db_path)?;
                tracing::error!(
                    "the database is damaged ({e:#}); it was moved to {} and Armada started with an empty one",
                    moved.display()
                );
                let db = Db::open(&db_path)?;
                let loaded = Core::load_state(&db)?;
                (db, loaded)
            }
            Err(e) => return Err(e),
        };
        let LoadedState {
            accounts,
            agents,
            settings,
        } = loaded;

        let core = Core {
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
                running_schedules: Mutex::default(),
                shutting_down: AtomicBool::new(false),
                cancel_watchdog_ms: AtomicU64::new(CANCEL_WATCHDOG_MS),
            }),
        };
        core.restore_queues();
        Ok(core)
    }

    /// Queued messages survive a restart or crash: they come back paused, with a
    /// notice, so nothing runs until the user says so.
    fn restore_queues(&self) {
        let saved = match self.inner.db.queues() {
            Ok(q) => q,
            Err(e) => {
                tracing::warn!("reading saved queues: {e:#}");
                return;
            }
        };
        for (agent_id, prompts) in saved {
            if self.agent(&agent_id).is_err() {
                let _ = self.inner.db.put_queue(&agent_id, &[]);
                continue;
            }
            self.ctx(&agent_id).restore_queue(prompts);
        }
    }

    /// True once `shutdown` has begun; the scheduler should not start anything.
    pub fn is_shutting_down(&self) -> bool {
        self.inner.shutting_down.load(Ordering::SeqCst)
    }

    /// How long a cancelled turn may run on before Armada restarts the agent
    /// process (default 20 s). For tests.
    #[doc(hidden)]
    pub fn set_cancel_timeout(&self, timeout: std::time::Duration) {
        self.inner
            .cancel_watchdog_ms
            .store(timeout.as_millis() as u64, Ordering::SeqCst);
    }

    /// Reads accounts (creating missing system accounts), agents (settling what a
    /// restart interrupted) and settings.
    fn load_state(db: &Db) -> Result<LoadedState> {
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
                let id = format!("system-{}", provider.as_str());
                if db.account_row_exists(&id)? {
                    // Written by a newer Armada (or damaged): never overwrite it.
                    tracing::warn!(
                        "the {} system account can't be read by this version; leaving it untouched",
                        provider.as_str()
                    );
                    continue;
                }
                let account = Account {
                    id,
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
                // Only real work was interrupted; an agent that was still warming
                // up without a conversation simply goes back to idle.
                agent.status = if agent.status == AgentStatus::Starting
                    && !db.has_user_message(&agent.id).unwrap_or(true)
                {
                    AgentStatus::Idle
                } else {
                    AgentStatus::Interrupted
                };
                dirty = true;
            }
            // Runtime-only state doesn't survive a restart.
            if agent.running
                || agent.pending_permissions != 0
                || agent.queued_prompts != 0
                || !agent.queue.is_empty()
            {
                agent.running = false;
                agent.pending_permissions = 0;
                agent.queued_prompts = 0;
                agent.queue.clear();
                agent.queue_paused = false;
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
        Ok(LoadedState {
            accounts,
            agents,
            settings,
        })
    }

    /// Resumes interrupted agents when `settings.auto_resume` is on.
    pub async fn startup(&self) {
        self.spawn_scheduler();
        let attachments = self.attachments_dir();
        tokio::task::spawn_blocking(move || codex::prune_old_attachments(&attachments));
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
        // A few at a time: starting every agent at once overwhelms the machine
        // (and the providers).
        let permits = Arc::new(tokio::sync::Semaphore::new(AUTO_RESUME_CONCURRENCY));
        for id in interrupted {
            let core = self.clone();
            let permits = permits.clone();
            tokio::spawn(async move {
                let Ok(_permit) = permits.acquire_owned().await else {
                    return;
                };
                if core.is_shutting_down() {
                    return;
                }
                // Start the process while holding the permit; the turn itself
                // doesn't need one.
                if let Err(e) = core.ensure_running(&id).await {
                    if !e.is::<StartCancelled>() && !core.is_shutting_down() {
                        tracing::warn!("auto-resume {id}: {e:#}");
                        core.fail_start(&id, e);
                    }
                    return;
                }
                drop(_permit);
                if let Err(e) = core.resume_agent(&id, true).await {
                    tracing::warn!("auto-resume {id}: {e:#}");
                }
            });
        }
    }

    /// Private folder for image attachments handed to agents as files.
    fn attachments_dir(&self) -> PathBuf {
        self.inner.data_dir.join("attachments")
    }

    /// Stops all agent processes; agents that were busy are marked `interrupted`.
    pub async fn shutdown(&self) {
        self.inner.shutting_down.store(true, Ordering::SeqCst);
        // Handshakes in progress are killed at once (their starts then give up).
        let ctxs: Vec<Arc<AgentCtx>> = self.inner.ctxs.lock().values().cloned().collect();
        let mut kills = tokio::task::JoinSet::new();
        for ctx in ctxs {
            if ctx.request_cancel_start() {
                kills.spawn(async move { ctx.kill_starting_peer().await });
            }
        }
        while kills.join_next().await.is_some() {}
        let live: Vec<(String, Driver)> = self.inner.live.lock().drain().collect();
        // Stop every agent at once so one slow agent can't hold up the others.
        let mut stops = tokio::task::JoinSet::new();
        for (id, driver) in live {
            let core = self.clone();
            stops.spawn(async move {
                let ctx = core.ctx(&id);
                ctx.set_exit_intent(ExitIntent::Shutdown);
                ctx.flush();
                let busy = ctx.is_turn_active();
                let _ = core.update_agent(&id, |a| {
                    if busy || a.status.is_busy() {
                        a.status = AgentStatus::Interrupted;
                    }
                    a.running = false;
                    a.pending_permissions = 0;
                });
                driver.shutdown().await;
                ctx.end_turn_early(ExitIntent::Shutdown);
                ctx.retire_generation(driver.generation());
            });
        }
        while stops.join_next().await.is_some() {}
        // Agents still warming up (no conversation yet) aren't interrupted work.
        let warming: Vec<String> = self
            .inner
            .agents
            .lock()
            .values()
            .filter(|r| r.agent.status == AgentStatus::Starting)
            .map(|r| r.agent.id.clone())
            .collect();
        for id in warming {
            let ctx = self.ctx(&id);
            ctx.request_cancel_start();
            if ctx.is_turn_active() {
                // A prompt was waiting for this start: interrupted work.
                ctx.end_turn_early(ExitIntent::Shutdown);
            }
            let _ = self.update_agent(&id, |a| {
                if a.status == AgentStatus::Starting {
                    a.status = AgentStatus::Idle;
                }
                a.running = false;
            });
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
                let seq = self.next_seq_base(agent_id);
                Arc::new(AgentCtx::new(self.weak(), agent_id.to_string(), seq))
            })
            .clone()
    }

    /// Where an agent's timeline continues. Never silently 0 (that would sort new
    /// items before old ones): on a database error it retries once, then falls
    /// back to the clock, which is always past any sequence number in use.
    fn next_seq_base(&self, agent_id: &str) -> i64 {
        match self.inner.db.max_seq(agent_id) {
            Ok(seq) => seq,
            Err(first) => {
                tracing::warn!("reading the timeline position of {agent_id}: {first:#}; retrying");
                match self.inner.db.max_seq(agent_id) {
                    Ok(seq) => seq,
                    Err(e) => {
                        tracing::error!(
                            "reading the timeline position of {agent_id} failed again ({e:#}); continuing after every existing item"
                        );
                        now_ms()
                    }
                }
            }
        }
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

    /// Writes the agent's buffered timeline changes. The ctx is cloned out first so
    /// the global ctxs lock isn't held during database I/O.
    fn flush_ctx(&self, agent_id: &str) {
        let ctx = self.inner.ctxs.lock().get(agent_id).cloned();
        if let Some(ctx) = ctx {
            ctx.flush();
        }
    }

    pub fn items(&self, agent_id: &str) -> Result<Vec<TimelineItem>> {
        self.flush_ctx(agent_id);
        self.inner.db.items(agent_id)
    }

    /// The last `limit` timeline items with `seq < before_seq` (the newest ones when
    /// None), oldest first. Page backwards by passing the first item's seq.
    pub fn items_page(
        &self,
        agent_id: &str,
        before_seq: Option<i64>,
        limit: usize,
    ) -> Result<Vec<TimelineItem>> {
        self.flush_ctx(agent_id);
        self.inner.db.items_page(agent_id, before_seq, limit)
    }

    /// Tallies over non-archived agents, computed under the lock without cloning.
    pub fn agent_counts(&self) -> AgentCounts {
        let agents = self.inner.agents.lock();
        let mut counts = AgentCounts::default();
        for row in agents.values().filter(|r| !r.agent.archived) {
            let a = &row.agent;
            counts.total += 1;
            match a.status {
                AgentStatus::Starting | AgentStatus::Working => counts.working += 1,
                AgentStatus::NeedsPermission => counts.needs_permission += 1,
                _ => {}
            }
            counts.pending_permissions += if a.status == AgentStatus::NeedsPermission {
                a.pending_permissions.max(1)
            } else {
                a.pending_permissions
            };
        }
        counts
    }

    pub fn search(&self, query: &str) -> Result<Vec<SearchHit>> {
        self.inner.db.search(query)
    }

    pub fn settings(&self) -> Result<Settings> {
        Ok(self.inner.settings.lock().clone())
    }

    /// Replaces the settings (validated first). Prefer `update_settings` for changing
    /// a few fields: it can't lose a concurrent change.
    pub fn save_settings(&self, settings: Settings) -> Result<Settings> {
        settings.validate().map_err(|e| anyhow!(e))?;
        let mut current = self.inner.settings.lock();
        self.inner.db.put_settings(&settings)?;
        *current = settings.clone();
        Ok(settings)
    }

    /// Read-modify-write of the settings under one lock, so concurrent updates
    /// (recent projects, the settings screen, the remote API) can't overwrite each
    /// other. `f` must not call back into `Core`'s settings methods.
    pub fn update_settings(&self, f: impl FnOnce(&mut Settings)) -> Result<Settings> {
        let mut current = self.inner.settings.lock();
        let mut next = current.clone();
        f(&mut next);
        next.validate().map_err(|e| anyhow!(e))?;
        self.inner.db.put_settings(&next)?;
        *current = next.clone();
        Ok(next)
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
        let account = Account {
            id: id.clone(),
            provider: req.provider,
            name: name.to_string(),
            color: req.color.clone(),
            auth_kind,
            is_system: false,
            config_dir: Some(dir.to_string_lossy().into_owned()),
            created_at: now_ms(),
            status: None,
            usage: None,
        };
        let created = async {
            let mut account = account;
            if auth_kind == AuthKind::ApiKey {
                let key = req
                    .api_key
                    .as_deref()
                    .map(str::trim)
                    .filter(|k| !k.is_empty())
                    .ok_or_else(|| anyhow!("Enter an API key"))?;
                if req.provider == Provider::Codex {
                    accounts::codex_store_api_key(&account, key)
                        .await
                        .context("Codex couldn't store the API key")?;
                }
                accounts::set_api_key(&id, key)?;
                account.status = Some(accounts::check_status(&account).await);
            }
            self.put_account(account)
        }
        .await;
        if created.is_err() {
            // Leave nothing behind: no keychain entry, no profile (with Codex's copy
            // of the key) for an account that doesn't exist.
            accounts::delete_api_key(&id);
            let _ = std::fs::remove_dir_all(&dir);
        }
        created
    }

    /// Replaces an API-key account's key. Running agents keep the old key until
    /// they restart.
    pub async fn update_account_key(&self, account_id: &str, key: &str) -> Result<Account> {
        let mut account = self.account(account_id)?;
        if account.auth_kind != AuthKind::ApiKey {
            bail!("This account signs in with a browser login, not an API key");
        }
        let key = key.trim();
        if key.is_empty() {
            bail!("Enter an API key");
        }
        // Codex first: if it rejects the key, the keychain still matches what Codex
        // has. If the keychain then fails, Codex gets the previous key back.
        let previous = accounts::get_api_key(&account.id);
        if account.provider == Provider::Codex {
            accounts::codex_store_api_key(&account, key)
                .await
                .context("Codex couldn't store the API key")?;
        }
        if let Err(e) = accounts::set_api_key(&account.id, key) {
            if account.provider == Provider::Codex {
                if let Some(old) = previous {
                    if let Err(e2) = accounts::codex_store_api_key(&account, &old).await {
                        tracing::warn!("restoring the previous Codex API key: {e2:#}");
                    }
                }
            }
            return Err(e);
        }
        account.status = Some(accounts::check_status(&account).await);
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

    /// Fails if the account is a system account or still used by agents (archived
    /// ones included: deleting the account deletes their sessions) or schedules.
    pub fn delete_account(&self, account_id: &str) -> Result<()> {
        let account = self.account(account_id)?;
        if account.is_system {
            bail!("The system account can't be removed");
        }
        {
            // Held across the checks and the removal, so an agent being added right
            // now is either counted or finds the account gone.
            let agents = self.inner.agents.lock();
            let (active, archived) = agents
                .values()
                .filter(|r| r.agent.account_id == account_id)
                .fold((0, 0), |(active, archived), r| {
                    if r.agent.archived {
                        (active, archived + 1)
                    } else {
                        (active + 1, archived)
                    }
                });
            if active > 0 {
                bail!(
                    "{} still use this account. Delete them or switch them to another account first.",
                    plural(active, "agent", "agents")
                );
            }
            if archived > 0 {
                bail!(
                    "{} still use this account; delete them first.",
                    plural(archived, "archived agent", "archived agents")
                );
            }
            let schedules: Vec<String> = self
                .inner
                .db
                .schedules()?
                .into_iter()
                .filter(|s| s.account_id == account_id)
                .map(|s| format!("\u{201c}{}\u{201d}", s.name))
                .collect();
            if !schedules.is_empty() {
                bail!(
                    "The {} {} this account. Change {} to another account or delete {} first.",
                    if schedules.len() == 1 {
                        "schedule"
                    } else {
                        "schedules"
                    },
                    if schedules.len() == 1 {
                        format!("{} uses", schedules[0])
                    } else {
                        format!("{} use", schedules.join(", "))
                    },
                    if schedules.len() == 1 { "it" } else { "them" },
                    if schedules.len() == 1 { "it" } else { "them" },
                );
            }
            self.inner.db.delete_account(account_id)?;
            self.inner.accounts.lock().remove(account_id);
        }
        accounts::delete_api_key(account_id);
        let profile = accounts::profile_dir(&self.inner.data_dir, account_id);
        if profile.starts_with(self.inner.data_dir.join("profiles")) {
            let _ = std::fs::remove_dir_all(&profile);
        }
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
        if self.is_shutting_down() {
            bail!(SHUTTING_DOWN);
        }
        let lock = self.start_lock(agent_id);
        let _guard = lock.lock().await;
        if let Some(d) = self.live_driver(agent_id) {
            return Ok(d);
        }
        if self.is_shutting_down() {
            bail!(SHUTTING_DOWN);
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
        let (program, args, env, env_remove) = if agent.provider == Provider::Custom {
            let def = self.custom_agent_def(agent.custom_agent_id.as_deref())?;
            let (program, args) = custom_launch(&def)?;
            let env = def
                .env
                .iter()
                .map(|e| (e.name.clone(), e.value.clone()))
                .collect();
            (program, args, env, Vec::new())
        } else {
            let (program, args) = providers::launch_spec(agent.provider, &self.inner.data_dir)?;
            (
                program,
                args,
                accounts::account_env(&account),
                accounts::env_to_remove(&account),
            )
        };
        let children_file = self.inner.data_dir.join("children.json");
        let attachments_dir = self.attachments_dir();
        let mcp_servers = self.inner.settings.lock().mcp_servers.clone();
        let ctx = self.ctx(agent_id);
        let label = format!(
            "{}:{}",
            agent.provider.as_str(),
            &agent.id[..8.min(agent.id.len())]
        );
        let resume = agent.session_id.as_deref();
        let auto_mode = match agent.permission_mode.as_deref() {
            Some(mode) => mode == "auto",
            None => self.inner.settings.lock().default_permission_mode == "auto",
        };

        let started = match agent.provider {
            Provider::Codex => CodexDriver::start(
                ctx.clone(),
                codex::StartOptions {
                    program: &program,
                    args: &args,
                    cwd: &cwd,
                    env: &env,
                    env_remove: &env_remove,
                    label: &label,
                    children_file: Some(&children_file),
                    resume,
                    // Codex's "Auto" is on-request (works in its sandbox, asks to go
                    // beyond); "ask first" is untrusted (asks before anything not
                    // known to be safe). A resumed thread keeps its own policy.
                    approval_policy: if auto_mode { "on-request" } else { "untrusted" },
                    attachments_dir: &attachments_dir,
                    version: VERSION,
                    mcp_servers: &mcp_servers,
                },
            )
            .await
            .map(Driver::Codex),
            Provider::Claude | Provider::Grok | Provider::Custom => AcpDriver::start(
                ctx.clone(),
                acp::StartOptions {
                    program: &program,
                    args: &args,
                    cwd: &cwd,
                    env: &env,
                    env_remove: &env_remove,
                    label: &label,
                    children_file: Some(&children_file),
                    resume,
                    version: VERSION,
                    mcp_servers: &mcp_servers,
                },
            )
            .await
            .map(Driver::Acp),
        };
        let driver = match started {
            Ok(d) => d,
            // Killed by Stop/cancel/"send now"/quit/delete mid-handshake: not a
            // failure; whoever cancelled it settles the turn.
            Err(_)
                if ctx.latest_start_cancelled()
                    || self.is_shutting_down()
                    || self.agent(agent_id).is_err() =>
            {
                return Err(StartCancelled.into())
            }
            Err(e) => return Err(e),
        };
        let session_id = driver.session_id();
        let fresh_session = resume != Some(session_id.as_str());
        // New sessions start in the agent's Auto mode when that's the default
        // (resumed sessions keep theirs) — before anyone can send a prompt.
        if fresh_session && auto_mode {
            self.apply_auto_mode(agent_id, &driver).await;
        }
        // Stopped, cancelled or deleted while we were starting, or Armada is
        // quitting: don't keep it.
        if ctx.start_cancelled(driver.generation())
            || self.agent(agent_id).is_err()
            || self.is_shutting_down()
        {
            ctx.set_exit_intent(ExitIntent::Stop);
            driver.shutdown().await;
            ctx.retire_generation(driver.generation());
            return Err(StartCancelled.into());
        }
        // A fresh session for an existing conversation (resume failed, an earlier
        // start never got a session, or the agent moved accounts — persisted, so
        // it survives a restart) is briefed first. The prompt about to run is
        // already in the timeline; it isn't repeated in the briefing.
        if fresh_session || agent.needs_briefing {
            let brief = ctx
                .take_preamble()
                .or_else(|| self.briefing(agent_id, ctx.is_turn_active()));
            if let Some(brief) = brief {
                ctx.set_preamble(brief);
            }
        }
        self.inner
            .live
            .lock()
            .insert(agent_id.to_string(), driver.clone());
        self.update_agent(agent_id, |a| {
            a.session_id = Some(session_id);
            a.running = true;
            a.needs_briefing = false;
        })?;
        Ok(driver)
    }

    /// Switches the agent's permission mode to its "Auto" choice, if it has one.
    async fn apply_auto_mode(&self, agent_id: &str, driver: &Driver) {
        let Ok(agent) = self.agent(agent_id) else {
            return;
        };
        let Some((option_id, value)) = agent.config_options.iter().find_map(|o| {
            let is_mode = o.id == "mode" || o.category.as_deref() == Some("mode");
            let auto = o.options.iter().find(|c| {
                c.value.eq_ignore_ascii_case("auto") || c.name.eq_ignore_ascii_case("auto")
            })?;
            (is_mode && o.current_value != auto.value).then(|| (o.id.clone(), auto.value.clone()))
        }) else {
            return;
        };
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            driver.set_config(&option_id, &value),
        )
        .await;
        match result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => tracing::warn!("couldn't switch {agent_id} to Auto mode: {e:#}"),
            Err(_) => tracing::warn!("{agent_id}: switching to Auto mode timed out"),
        }
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
        if err.is::<StartCancelled>() || self.is_shutting_down() {
            // Stop/cancel/quit already settled the agent.
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
    /// Only the prompt whose turn is still current is sent: one that was stopped,
    /// cancelled or replaced while waiting for its process is dropped.
    fn run_prompt(&self, agent_id: &str, prompt: Prompt, model: Option<String>) {
        let core = self.clone();
        let id = agent_id.to_string();
        tokio::spawn(async move {
            let ctx = core.ctx(&id);
            if core.is_shutting_down() {
                // Kept as interrupted work; it comes back paused next start.
                ctx.end_turn_early(ExitIntent::Shutdown);
                return;
            }
            match core.ensure_running(&id).await {
                Ok(driver) => {
                    if !ctx.prompt_is_current(prompt.token) {
                        return;
                    }
                    if let Some(m) = model.filter(|m| !m.trim().is_empty()) {
                        let r = tokio::time::timeout(
                            std::time::Duration::from_secs(30),
                            driver.set_config("model", m.trim()),
                        )
                        .await
                        .unwrap_or_else(|_| Err(anyhow!("the agent didn't answer")));
                        if let Err(e) = r {
                            ctx.notice(
                                NoticeLevel::Warn,
                                format!("Couldn't switch to model {m}: {e:#}"),
                            );
                        }
                    }
                    // Checked again by the driver, atomically with starting the turn.
                    if ctx.prompt_is_current(prompt.token) {
                        driver.prompt(prompt);
                    }
                }
                // This prompt was abandoned meanwhile; whoever did that settled it.
                Err(e) if !ctx.prompt_is_current(prompt.token) => {
                    tracing::debug!("start for an abandoned prompt of {id} ended: {e:#}");
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
        // A prompt is optional: without one the agent starts up and waits for you.
        let prompt = req.prompt.trim().to_string();
        let has_prompt = !prompt.is_empty() || !req.attachments.is_empty();
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
        let permission_mode = match req.permission_mode.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(m @ ("auto" | "ask")) => Some(m.to_string()),
            Some(other) => bail!("Unknown permission mode \u{201c}{other}\u{201d}"),
        };
        let mut req = req;
        req.project_path = providers::expand_home(&req.project_path)
            .to_string_lossy()
            .into_owned();
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
        let title = custom_title.clone().unwrap_or_else(|| {
            if prompt.is_empty() {
                untitled(&project)
            } else {
                title_from_prompt(&prompt)
            }
        });

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
            queued_prompts: 0,
            queue: Vec::new(),
            queue_paused: false,
            permission_mode,
            acknowledged_at: None,
            needs_briefing: false,
        };
        {
            // Under the agents lock, which `delete_account` holds across its checks:
            // either it sees this agent, or this sees the account gone.
            let mut agents = self.inner.agents.lock();
            if self.account(&req.account_id).is_err() {
                drop(agents);
                if worktree {
                    let _ = git::remove_worktree(
                        &project,
                        Path::new(&agent.cwd),
                        agent.branch.as_deref(),
                        true,
                    )
                    .await;
                }
                bail!("That account was just removed. Pick another account.");
            }
            self.inner.db.put_agent(&agent)?;
            if custom_title.is_some() {
                self.inner.db.set_title_custom(&id)?;
            }
            agents.insert(
                id.clone(),
                AgentRow {
                    agent: agent.clone(),
                    title_custom: custom_title.is_some(),
                },
            );
        }
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
        if !has_prompt {
            self.warm_up(&id, req.model.clone());
        } else if let Some(p) = ctx.submit_prompt(&prompt, req.attachments) {
            self.run_prompt(&id, p, req.model.clone());
        }
        Ok(agent)
    }

    /// Starts an agent's process and session without a prompt, so its models,
    /// modes and commands are ready when the user starts typing.
    fn warm_up(&self, agent_id: &str, model: Option<String>) {
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
                    // A prompt sent meanwhile owns the status from here.
                    if !core.ctx(&id).is_turn_active() {
                        let _ = core.update_agent(&id, |a| {
                            if a.status == AgentStatus::Starting {
                                a.status = AgentStatus::Idle;
                            }
                        });
                    }
                }
                // A prompt sent meanwhile retries the start and reports its own errors.
                Err(_) if core.ctx(&id).is_turn_active() => {}
                Err(e) => core.fail_start(&id, e),
            }
        });
    }

    /// Starts the adapter + resumes the provider session first if it isn't running.
    pub async fn send_prompt(
        &self,
        agent_id: &str,
        text: &str,
        attachments: Vec<Attachment>,
    ) -> Result<()> {
        self.send_prompt_inner(agent_id, text, attachments, false)
            .await
    }

    /// `internal` prompts (resume/failover nudges) never rename the agent.
    async fn send_prompt_inner(
        &self,
        agent_id: &str,
        text: &str,
        attachments: Vec<Attachment>,
        internal: bool,
    ) -> Result<()> {
        let text = text.trim();
        if text.is_empty() && attachments.is_empty() {
            bail!("Nothing to send");
        }
        if self.is_shutting_down() {
            bail!(SHUTTING_DOWN);
        }
        validate_attachments(&attachments)?;
        let agent = self.agent(agent_id)?;
        let ctx = self.ctx(agent_id);
        let running = self.live_driver(agent_id).is_some();
        // Agents started without a prompt are named after their first message.
        let first_message = !internal && !self.inner.db.has_user_message(agent_id)?;
        if first_message && !text.is_empty() {
            self.suggest_title(agent_id, &title_from_prompt(text));
        }
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

    /// Cancels the running turn. A turn whose prompt hasn't reached the agent
    /// yet ends here and then; otherwise the agent is asked to stop, and if it
    /// hasn't ended the turn after a while (or the request fails) its process is
    /// restarted and the turn marked cancelled.
    pub async fn cancel_turn(&self, agent_id: &str) -> Result<()> {
        self.agent(agent_id)?;
        let ctx = self.ctx(agent_id);
        ctx.note_cancel();
        let driver = self.live_driver(agent_id);
        if driver.is_none() || ctx.turn_pending() {
            // Nothing was sent yet (still starting, switching mode or model…).
            let was_starting = driver.is_none() && self.abort_start(agent_id).await;
            if ctx.is_turn_active() {
                if let Some(next) = ctx.turn_finished(TurnOutcome::Cancelled) {
                    // "Send now" interrupted it: the chosen message runs next.
                    self.run_prompt(agent_id, next, None);
                }
            } else if was_starting {
                // Cancelling a warm-up: back to idle instead of "starting" forever.
                self.update_agent(agent_id, |a| {
                    if a.status == AgentStatus::Starting {
                        a.status = AgentStatus::Idle;
                    }
                })?;
            }
            return Ok(());
        }
        let Some(driver) = driver else {
            return Ok(());
        };
        let Some(turn) = ctx.active_turn() else {
            return driver.cancel().await;
        };
        match driver.cancel().await {
            Ok(()) => {
                let core = self.clone();
                let id = agent_id.to_string();
                let wait = self.inner.cancel_watchdog_ms.load(Ordering::SeqCst);
                tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
                    core.force_end_turn(
                        &id,
                        turn,
                        format!(
                            "The agent didn't stop within {} seconds, so Armada restarted it.",
                            wait.div_ceil(1000)
                        ),
                    )
                    .await;
                });
                Ok(())
            }
            Err(e) => {
                self.force_end_turn(
                    agent_id,
                    turn,
                    format!("The agent didn't confirm the cancel ({e:#}), so Armada restarted it."),
                )
                .await;
                Ok(())
            }
        }
    }

    /// Ends turn `turn` (if it's still running) by killing the agent's process;
    /// the turn counts as cancelled and the next run starts a fresh process.
    async fn force_end_turn(&self, agent_id: &str, turn: u64, note: String) {
        let ctx = self.ctx(agent_id);
        if ctx.active_turn() != Some(turn) {
            return;
        }
        let lock = self.start_lock(agent_id);
        let guard = lock.lock().await;
        if ctx.active_turn() != Some(turn) {
            return;
        }
        let driver = self.inner.live.lock().remove(agent_id);
        if let Some(d) = &driver {
            // Whatever the old process still reports is ignored from here on.
            ctx.retire_generation(d.generation());
        }
        ctx.notice(NoticeLevel::Warn, note);
        let next = ctx.turn_finished(TurnOutcome::Cancelled);
        let _ = self.update_agent(agent_id, |a| a.running = false);
        drop(guard);
        if let Some(d) = driver {
            d.shutdown().await;
        }
        if let Some(next) = next {
            self.run_prompt(agent_id, next, None);
        }
    }

    /// Abandons a start in progress and kills its process at once (so a hung
    /// handshake doesn't linger). Returns whether a start was in progress.
    pub(crate) async fn abort_start(&self, agent_id: &str) -> bool {
        let ctx = self.ctx(agent_id);
        let starting = ctx.request_cancel_start();
        if starting {
            ctx.kill_starting_peer().await;
        }
        starting
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
                .send_prompt_inner(agent_id, CONTINUE_PROMPT, Vec::new(), true)
                .await;
        }
        if self.live_driver(agent_id).is_some() {
            // Already attached (and maybe mid-turn): nothing to do.
            return Ok(());
        }
        if self.is_shutting_down() {
            bail!(SHUTTING_DOWN);
        }
        self.update_agent(agent_id, |a| a.status = AgentStatus::Starting)?;
        match self.ensure_running(agent_id).await {
            Ok(_) => {
                self.update_agent(agent_id, |a| {
                    if a.status == AgentStatus::Starting {
                        a.status = AgentStatus::Idle;
                    }
                })?;
                Ok(())
            }
            // Stopped while resuming: the stop already settled the status.
            Err(e) if e.is::<StartCancelled>() => Ok(()),
            Err(e) => {
                let msg = format!("{e:#}");
                self.ctx(agent_id).notice(NoticeLevel::Error, msg.clone());
                self.update_agent(agent_id, |a| a.status = AgentStatus::Error)?;
                Err(anyhow!(msg))
            }
        }
    }

    pub async fn stop_agent(&self, agent_id: &str) -> Result<()> {
        let ctx = self.ctx(agent_id);
        // A start in progress is abandoned and its process killed right away (a
        // hung handshake would otherwise linger until its timeout).
        if ctx.request_cancel_start() {
            ctx.end_turn_early(ExitIntent::Stop);
            ctx.kill_starting_peer().await;
            self.update_agent(agent_id, |a| {
                a.running = false;
                // A prompt sent since owns the status.
                if a.status.is_busy() && !ctx.is_turn_active() {
                    a.status = AgentStatus::Stopped;
                }
            })?;
            return Ok(());
        }
        // Hold the start lock so a prompt sent meanwhile starts a fresh process only
        // after this one is fully gone (and isn't mistaken for it).
        let lock = self.start_lock(agent_id);
        let _guard = lock.lock().await;
        let driver = self.inner.live.lock().remove(agent_id);
        if let Some(d) = driver {
            ctx.set_exit_intent(ExitIntent::Stop);
            d.shutdown().await;
            // Settle now, then ignore whatever the old process still reports.
            ctx.end_turn_early(ExitIntent::Stop);
            ctx.retire_generation(d.generation());
        } else {
            ctx.end_turn_early(ExitIntent::Stop);
        }
        // Settled regardless of which path (this one or the exit handler) ended it.
        self.update_agent(agent_id, |a| {
            a.running = false;
            a.pending_permissions = 0;
            if a.status.is_busy() && !ctx.is_turn_active() {
                a.status = AgentStatus::Stopped;
            }
        })?;
        Ok(())
    }

    fn start_lock(&self, agent_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.inner
            .start_locks
            .lock()
            .entry(agent_id.to_string())
            .or_default()
            .clone()
    }

    /// Removes a queued message; returns its text so the UI can put it back in the
    /// composer for editing.
    pub fn remove_queued(&self, agent_id: &str, queued_id: &str) -> Result<Option<RemovedPrompt>> {
        self.agent(agent_id)?;
        Ok(self
            .ctx(agent_id)
            .remove_queued(queued_id)
            .map(|p| RemovedPrompt {
                text: p.text,
                attachments: p.attachments,
            }))
    }

    /// Runs a queued message now, interrupting the current turn if there is one.
    pub async fn send_queued_now(&self, agent_id: &str, queued_id: &str) -> Result<()> {
        self.agent(agent_id)?;
        let ctx = self.ctx(agent_id);
        match ctx.send_queued_now(queued_id) {
            None => bail!("That message is no longer queued"),
            Some((Some(prompt), _)) => {
                self.run_prompt(agent_id, prompt, None);
                Ok(())
            }
            Some((None, interrupt)) => {
                if interrupt {
                    self.cancel_turn(agent_id).await?;
                }
                Ok(())
            }
        }
    }

    /// Unpauses the agent's queue; if the agent is idle, its first message runs now.
    pub async fn resume_queue(&self, agent_id: &str) -> Result<()> {
        self.agent(agent_id)?;
        if self.is_shutting_down() {
            bail!(SHUTTING_DOWN);
        }
        if let Some(prompt) = self.ctx(agent_id).resume_queue() {
            let running = self.live_driver(agent_id).is_some();
            self.update_agent(agent_id, |a| {
                a.last_activity_at = now_ms();
                if !running {
                    a.status = AgentStatus::Starting;
                }
            })?;
            self.run_prompt(agent_id, prompt, None);
        }
        Ok(())
    }

    /// Drops every queued message of the agent. Returns how many there were.
    pub fn clear_queue(&self, agent_id: &str) -> Result<usize> {
        self.agent(agent_id)?;
        Ok(self.ctx(agent_id).clear_queue())
    }

    /// Deletes the agent and its timeline. With `remove_worktree`, its git worktree
    /// and branch go too — unless that would lose uncommitted changes or unmerged
    /// commits: then nothing is deleted and the error starts with
    /// `UNSAVED_WORK_ERROR`, until called again with `force`.
    pub async fn delete_agent(
        &self,
        agent_id: &str,
        remove_worktree: bool,
        force: bool,
    ) -> Result<()> {
        let agent = self.agent(agent_id)?;
        let remove = remove_worktree
            && agent.worktree
            && !self
                .inner
                .agents
                .lock()
                .values()
                .any(|r| r.agent.id != agent.id && r.agent.cwd == agent.cwd);
        let project = PathBuf::from(&agent.project_path);
        let cwd = PathBuf::from(&agent.cwd);
        // Checked before stopping anything, so a refused delete leaves the agent be.
        if remove && !force {
            if let Some(problem) = git::unsaved_work(&project, &cwd, agent.branch.as_deref()).await
            {
                bail!("{problem}");
            }
        }
        let ctx = self.ctx(agent_id);
        // A start in progress is abandoned and its (maybe hung) process killed now.
        self.abort_start(agent_id).await;
        let lock = self.start_lock(agent_id);
        let _guard = lock.lock().await;
        let driver = self.inner.live.lock().remove(agent_id);
        if let Some(d) = driver {
            ctx.set_exit_intent(ExitIntent::Shutdown);
            d.shutdown().await;
            ctx.retire_generation(d.generation());
        }
        if remove {
            // Checked again inside: the agent may have written more before it stopped.
            if let Err(e) =
                git::remove_worktree(&project, &cwd, agent.branch.as_deref(), force).await
            {
                ctx.end_turn_early(ExitIntent::Stop);
                let _ = self.update_agent(agent_id, |a| {
                    a.running = false;
                    a.pending_permissions = 0;
                    if a.status.is_busy() {
                        a.status = AgentStatus::Stopped;
                    }
                });
                return Err(e);
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

    /// Triage "Done": dismisses the agent's current attention (it comes back on new
    /// activity) and marks it read.
    pub fn acknowledge_agent(&self, agent_id: &str) -> Result<()> {
        self.update_agent(agent_id, |a| {
            a.acknowledged_at = Some(now_ms());
            a.unread = false;
        })?;
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
        let driver = match self.ensure_running(agent_id).await {
            Ok(d) => d,
            Err(e) if e.is::<StartCancelled>() => return Ok(()),
            Err(e) => return Err(e),
        };
        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            driver.set_config(option_id, value),
        )
        .await
        .map_err(|_| anyhow!("The agent didn't respond to the setting change"))?
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
            permission_mode: None,
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
                status: ToolStatus::Completed,
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
        self.transcript_of(&self.items(agent_id).unwrap_or_default(), budget)
    }

    /// `transcript` of the given items.
    fn transcript_of(&self, items: &[TimelineItem], budget: usize) -> String {
        let clip = |s: &str, n: usize| -> String {
            if s.chars().count() > n {
                format!("{}…", s.chars().take(n).collect::<String>())
            } else {
                s.to_string()
            }
        };
        let mut lines: Vec<String> = Vec::new();
        for item in items {
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

    /// The briefing for a fresh session, if there is any earlier conversation.
    /// With `skip_latest_prompt`, the newest user message (the prompt about to be
    /// sent with the briefing) is left out so it isn't sent twice.
    fn briefing(&self, agent_id: &str, skip_latest_prompt: bool) -> Option<String> {
        let items = self.items(agent_id).unwrap_or_default();
        let mut users = items
            .iter()
            .filter(|i| matches!(i.body, ItemBody::UserMessage { .. }))
            .count();
        let cut = if skip_latest_prompt {
            users = users.saturating_sub(1);
            items
                .iter()
                .rposition(|i| matches!(i.body, ItemBody::UserMessage { .. }))
                .unwrap_or(items.len())
        } else {
            items.len()
        };
        if users == 0 {
            return None;
        }
        let full = self.transcript_of(&items[..cut], 12_000);
        Some(full)
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
        // Held until the new account is recorded, so a prompt racing this switch
        // starts its process on the new account, after the old one is gone.
        let lock = self.start_lock(agent_id);
        let _guard = lock.lock().await;
        let driver = self.inner.live.lock().remove(agent_id);
        if let Some(d) = driver {
            ctx.set_exit_intent(ExitIntent::Stop);
            d.shutdown().await;
            ctx.retire_generation(d.generation());
        }
        ctx.set_preamble(self.transcript(agent_id, 12_000));
        let agent = self.update_agent(agent_id, |a| {
            a.account_id = account_id.to_string();
            a.session_id = None;
            // Persisted: the brief is still owed after a restart.
            a.needs_briefing = true;
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
        let candidates: Vec<Account> = {
            let limited = self.inner.limited_accounts.lock();
            let mut list: Vec<Account> = self
                .inner
                .accounts
                .lock()
                .values()
                .filter(|a| a.provider == agent.provider && a.id != agent.account_id)
                // Never checked counts too; it's checked below before it's used.
                .filter(|a| a.status.as_ref().is_none_or(|s| s.logged_in))
                .filter(|a| {
                    limited
                        .get(&a.id)
                        .is_none_or(|t| now - t > LIMIT_COOLDOWN_MS)
                })
                .cloned()
                .collect();
            list.sort_by_key(|a| a.created_at);
            list
        };
        let mut candidate = None;
        for account in candidates {
            if account.status.is_some() {
                candidate = Some(account);
                break;
            }
            match self.check_account(&account.id).await {
                Ok(fresh) if fresh.status.as_ref().is_some_and(|s| s.logged_in) => {
                    candidate = Some(fresh);
                    break;
                }
                Ok(_) => {}
                Err(e) => tracing::warn!("checking failover account {}: {e:#}", account.id),
            }
        }
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
                    .send_prompt_inner(
                        agent_id,
                        "You hit a usage limit on the previous account. Please continue where you left off.",
                        Vec::new(),
                        true,
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
        schedule.permission_mode = match schedule.permission_mode.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(m @ ("auto" | "ask")) => Some(m.to_string()),
            Some(other) => bail!("Unknown permission mode \u{201c}{other}\u{201d}"),
        };
        if parse_hhmm(&schedule.time).is_none() {
            bail!("Time must look like 09:30");
        }
        if schedule.days.iter().any(|d| *d > 6) {
            bail!("Days must be 0 (Sunday) to 6 (Saturday)");
        }
        schedule.project_path = providers::expand_home(&schedule.project_path)
            .to_string_lossy()
            .into_owned();
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
        // Edited: an earlier failure no longer describes this schedule.
        schedule.last_error = None;
        schedule.days.sort_unstable();
        schedule.days.dedup();
        schedule.updated_at = now_ms();
        self.inner.db.put_schedule(&schedule)?;
        self.emit(ArmadaEvent::ScheduleUpdated {
            schedule: schedule.clone(),
        });
        Ok(schedule)
    }

    pub fn delete_schedule(&self, schedule_id: &str) -> Result<()> {
        self.inner.db.delete_schedule(schedule_id)?;
        self.emit(ArmadaEvent::ScheduleRemoved {
            schedule_id: schedule_id.to_string(),
        });
        Ok(())
    }

    fn find_schedule(&self, schedule_id: &str) -> Result<Option<Schedule>> {
        Ok(self
            .inner
            .db
            .schedules()?
            .into_iter()
            .find(|s| s.id == schedule_id))
    }

    /// Marks the schedule as starting; None if a run is already in flight.
    fn claim_schedule(&self, schedule_id: &str) -> Option<ScheduleClaim> {
        self.inner
            .running_schedules
            .lock()
            .insert(schedule_id.to_string())
            .then(|| ScheduleClaim {
                core: self.clone(),
                id: schedule_id.to_string(),
            })
    }

    /// Starts the scheduled agent now ("Run now").
    pub async fn run_schedule(&self, schedule_id: &str) -> Result<Agent> {
        let _claim = self
            .claim_schedule(schedule_id)
            .ok_or_else(|| anyhow!("This schedule is already starting an agent"))?;
        let schedule = self
            .find_schedule(schedule_id)?
            .ok_or_else(|| anyhow!("Schedule not found"))?;
        self.start_scheduled(schedule).await
    }

    /// The scheduler's run: re-reads the schedule and only starts it if it is still
    /// enabled and due (it may have been edited, disabled or run meanwhile).
    async fn run_due_schedule(&self, schedule_id: &str) {
        let Some(_claim) = self.claim_schedule(schedule_id) else {
            return;
        };
        let schedule = match self.find_schedule(schedule_id) {
            Ok(Some(s)) => s,
            Ok(None) => return,
            Err(e) => {
                tracing::warn!("schedule {schedule_id}: {e:#}");
                return;
            }
        };
        if !schedule_due(&schedule, Local::now()) {
            return;
        }
        match self.start_scheduled(schedule).await {
            Ok(agent) => tracing::info!("schedule {schedule_id} started agent {}", agent.id),
            Err(e) => tracing::warn!("schedule {schedule_id} failed: {e:#}"),
        }
    }

    /// Records the run, creates the agent, and records the outcome on the schedule
    /// (`last_agent_id`, or `last_error`, which the UI shows) via `schedule_updated`.
    async fn start_scheduled(&self, mut schedule: Schedule) -> Result<Agent> {
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
            permission_mode: schedule.permission_mode.clone(),
            attachments: Vec::new(),
        };
        // Record the run first so a failing schedule can't fire again every tick.
        schedule.last_run_at = Some(now_ms());
        self.inner.db.put_schedule(&schedule)?;
        self.emit(ArmadaEvent::ScheduleUpdated {
            schedule: schedule.clone(),
        });
        let result = self
            .create_agent_inner(req, None, Some(schedule.id.clone()))
            .await;
        // Re-read: the schedule may have been edited or deleted meanwhile.
        match self.find_schedule(&schedule.id) {
            Ok(Some(mut current)) => {
                current.last_run_at = schedule.last_run_at;
                match &result {
                    Ok(agent) => {
                        current.last_agent_id = Some(agent.id.clone());
                        current.last_error = None;
                    }
                    Err(e) => current.last_error = Some(format!("{e:#}")),
                }
                if let Err(e) = self.inner.db.put_schedule(&current) {
                    tracing::warn!("saving schedule {}: {e:#}", current.id);
                }
                self.emit(ArmadaEvent::ScheduleUpdated { schedule: current });
            }
            Ok(None) => {}
            Err(e) => tracing::warn!("re-reading schedule {}: {e:#}", schedule.id),
        }
        result
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
                if core.is_shutting_down() {
                    break;
                }
                let now = Local::now();
                let schedules = match core.inner.db.schedules() {
                    Ok(list) => list,
                    Err(e) => {
                        tracing::warn!("scheduler: reading schedules: {e:#}");
                        continue;
                    }
                };
                // Each run on its own task: one slow start (worktree, adapter
                // handshake) mustn't delay the others.
                for s in schedules.into_iter().filter(|s| schedule_due(s, now)) {
                    let core = core.clone();
                    tokio::spawn(async move { core.run_due_schedule(&s.id).await });
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
            ItemBody::TurnSummary {
                duration_ms,
                files,
                tool_calls,
                commands,
                cost_usd,
                ..
            } => {
                md.push_str(&format!(
                    "> **Done** in {}s · {} step(s), {} command(s) · ${cost_usd:.2}\n",
                    duration_ms / 1000,
                    tool_calls,
                    commands
                ));
                for f in files {
                    md.push_str(&format!(">  - `{f}`\n"));
                }
                md.push('\n');
            }
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

    /// Connects to an MCP server and lists its tools ("Test connection").
    pub async fn test_mcp_server(&self, server: McpServer) -> Result<String> {
        let cwd = providers::home_dir().unwrap_or_else(std::env::temp_dir);
        crate::mcp::test_server(&server, &cwd).await
    }

    /// Git repositories found in the usual folders under the home directory.
    pub async fn discover_projects(&self) -> Result<Vec<String>> {
        let home = providers::home_dir().ok_or_else(|| anyhow!("No home folder"))?;
        Ok(tokio::task::spawn_blocking(move || crate::files::discover_projects(&home, 40)).await?)
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

    /// Loads an image an agent referenced (e.g. a screenshot it saved) so the UI can
    /// show the picture. Readable: image files inside the agent's folders, and images
    /// in the system temp dir that the agent's own timeline mentions (by path or file
    /// name), not anything else that happens to be in temp. Paths are canonicalized
    /// so `..`/symlinks can't escape. Accepts plain paths and `file://` URIs.
    pub fn read_image(&self, agent_id: &str, path: &str) -> Result<Attachment> {
        let agent = self.agent(agent_id)?;
        let input = path.trim();
        let requested =
            crate::files::file_uri_to_path(input).unwrap_or_else(|| PathBuf::from(input));
        let full = if requested.is_absolute() {
            requested
        } else {
            PathBuf::from(&agent.cwd).join(requested)
        };
        let real = full
            .canonicalize()
            .map_err(|_| anyhow!("Image not found: {input}"))?;
        let in_project = [&agent.cwd, &agent.project_path]
            .iter()
            .filter_map(|r| Path::new(r).canonicalize().ok())
            .any(|r| real.starts_with(r));
        if !in_project {
            let in_temp = std::env::temp_dir()
                .canonicalize()
                .is_ok_and(|t| real.starts_with(t));
            if !in_temp || !self.timeline_mentions(agent_id, input, &real) {
                bail!("Armada only shows images from the agent's project, or temporary images the agent referred to");
            }
        }
        crate::files::read_image_file(&real)
    }

    /// Whether the agent's stored timeline mentions `input` or the file's name.
    fn timeline_mentions(&self, agent_id: &str, input: &str, real: &Path) -> bool {
        self.flush_ctx(agent_id);
        // Items are stored as JSON, so look for the JSON-escaped spelling.
        let escaped = |s: &str| {
            let quoted = serde_json::to_string(s).unwrap_or_default();
            quoted[1..quoted.len().saturating_sub(1).max(1)].to_string()
        };
        let mut needles = vec![escaped(input)];
        if let Some(name) = real.file_name().map(|n| n.to_string_lossy().into_owned()) {
            needles.push(escaped(&name));
            needles.push(escaped(&crate::files::percent_encode(&name)));
        }
        needles.iter().any(|needle| {
            self.inner
                .db
                .items_contain(agent_id, needle)
                .unwrap_or(false)
        })
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
            last_error: None,
            permission_mode: None,
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
