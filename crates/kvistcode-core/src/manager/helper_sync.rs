//! Helper agents: starting them, and keeping their files in step with the main
//! agent's. The git work is in `crate::helpers`; this is the policy.
//!
//! Directions:
//! * helper -> main: when a helper's turn ends (and again when the main agent's
//!   turn ends, if the main was busy), the helper's changes since its helper base
//!   are merged into the main agent's working tree.
//! * main -> helper: before the helper starts its next turn, the main agent's
//!   changes since the main base are merged into the helper's working tree.
//!
//! Both only happen while the agent being written to is not mid-turn (and, for
//! main -> helper, the main agent isn't either). Conflicts write nothing.

use super::*;
use crate::checkpoints::lock_agent;
use crate::helpers::{self, Merge, Side};

/// How long the main -> helper sync may delay a helper's next prompt.
const PRE_PROMPT_BUDGET: std::time::Duration = std::time::Duration::from_secs(60);
const MAX_LISTED_FILES: usize = 6;

fn sync_key(helper_id: &str) -> String {
    format!("helper-sync:{helper_id}")
}

fn list_files(files: &[String]) -> String {
    let shown: Vec<&str> = files
        .iter()
        .take(MAX_LISTED_FILES)
        .map(String::as_str)
        .collect();
    let mut out = shown.join(", ");
    if files.len() > MAX_LISTED_FILES {
        out.push_str(&format!(" and {} more", files.len() - MAX_LISTED_FILES));
    }
    out
}

/// Which agent a helper runs as: the settings' helper defaults where they are
/// usable, otherwise the main agent's own.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct HelperTarget {
    pub provider: Provider,
    pub account_id: String,
    pub custom_agent_id: Option<String>,
    pub model: Option<String>,
}

pub(super) fn resolve_target(
    settings: &Settings,
    parent: &Agent,
    accounts: &[Account],
) -> Result<HelperTarget> {
    let hd = &settings.helper_defaults;
    let exists = |id: &str, provider: Provider| {
        accounts
            .iter()
            .any(|a| a.id == id && a.provider == provider)
    };
    let own = |model_from_defaults: bool| HelperTarget {
        provider: parent.provider,
        account_id: parent.account_id.clone(),
        custom_agent_id: parent.custom_agent_id.clone(),
        model: if model_from_defaults {
            nonblank(&hd.model).map(str::to_string)
        } else {
            None
        }
        .or_else(|| parent.model.clone())
        .or_else(|| parent.config_choices.get("model").cloned()),
    };
    let provider = hd.provider.unwrap_or(parent.provider);
    let mut target = if provider == parent.provider {
        own(true)
    } else {
        // A different provider: its account (the default one, else any), its
        // custom agent, its model. Nothing usable means the main agent's own setup.
        let account = nonblank(&hd.account_id)
            .filter(|id| exists(id, provider))
            .map(str::to_string)
            .or_else(|| {
                accounts
                    .iter()
                    .find(|a| a.provider == provider)
                    .map(|a| a.id.clone())
            });
        match account {
            Some(account_id) => HelperTarget {
                provider,
                account_id,
                custom_agent_id: None,
                model: nonblank(&hd.model).map(str::to_string),
            },
            None => own(false),
        }
    };
    if target.provider == parent.provider {
        // The default account, when it still exists for this provider.
        if let Some(id) = nonblank(&hd.account_id).filter(|id| exists(id, target.provider)) {
            target.account_id = id.to_string();
        }
    }
    if target.provider == Provider::Custom {
        let usable = |id: &str| {
            settings
                .custom_agents
                .iter()
                .any(|c| c.id == id && c.enabled)
        };
        let wanted = nonblank(&hd.custom_agent_id)
            .filter(|id| usable(id))
            .map(str::to_string);
        if target.provider != parent.provider || wanted.is_some() {
            target.custom_agent_id = wanted.or(target.custom_agent_id);
        }
    } else {
        target.custom_agent_id = None;
    }
    if !exists(&target.account_id, target.provider) {
        bail!("The main agent's account was removed. Pick another account first.");
    }
    Ok(target)
}

fn nonblank(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

fn preamble_for(parent_title: &str) -> String {
    format!(
        "You are a helper agent working in parallel with the agent \u{201c}{parent_title}\u{201d} \
         on a separate copy of the same project (a git worktree started from that agent's current \
         files, including its uncommitted changes). Your changes are merged into the main agent's \
         workspace automatically when you finish a turn, and its later changes are merged into \
         yours before you start the next one. Keep your changes focused, and avoid broad refactors \
         or reformatting of files the main agent is likely editing."
    )
}

impl Core {
    // ---- starting ------------------------------------------------------------

    /// Starts a helper for `parent_id` right away, working on a copy of the main
    /// agent's current files.
    pub async fn spawn_helper(
        &self,
        parent_id: &str,
        prompt: &str,
        attachments: Vec<Attachment>,
    ) -> Result<Agent> {
        let parent = self.agent(parent_id)?;
        if self.is_shutting_down() {
            bail!(SHUTTING_DOWN);
        }
        let prompt = prompt.trim();
        if prompt.is_empty() && attachments.is_empty() {
            bail!("Nothing to send");
        }
        if parent.parent_id.is_some() {
            bail!("A helper can't have helpers of its own");
        }
        let project = PathBuf::from(&parent.project_path);
        let repo = git::repo_info(&project)
            .await
            .ok_or_else(|| anyhow!(helpers::NOT_GIT))?;
        let target = resolve_target(&self.settings()?, &parent, &self.accounts()?)?;
        let id = uuid::Uuid::new_v4().to_string();
        let commit = helpers::seed(&parent, &id).await?;
        let req = CreateAgentRequest {
            provider: target.provider,
            account_id: target.account_id,
            project_path: parent.project_path.clone(),
            prompt: prompt.to_string(),
            title: None,
            worktree: true,
            model: target.model,
            group_id: parent.group_id.clone(),
            custom_agent_id: target.custom_agent_id,
            // Never more permissive than the main agent's own choice.
            permission_mode: parent.permission_mode.clone(),
            attachments,
        };
        let seed = HelperSeed {
            id: id.clone(),
            parent_id: parent.id.clone(),
            commit,
            base_branch: parent.base_branch.clone().or(repo.branch),
            preamble: preamble_for(&parent.title),
        };
        let helper = match self.create_agent_inner(req, None, None, Some(seed)).await {
            Ok(a) => a,
            Err(e) => {
                helpers::forget(Path::new(&parent.cwd), &id).await;
                return Err(e);
            }
        };
        self.ctx(&helper.id).notice(
            NoticeLevel::Info,
            format!(
                "Helper for \u{201c}{}\u{201d}: working on a copy of its files. Changes are merged \
                 into the main agent's workspace when a turn finishes.",
                parent.title
            ),
        );
        self.ctx(&parent.id).notice(
            NoticeLevel::Info,
            format!("Started helper \u{201c}{}\u{201d}", helper.title),
        );
        Ok(helper)
    }

    // ---- state ---------------------------------------------------------------

    fn set_sync(
        &self,
        helper_id: &str,
        state: HelperSyncState,
        detail: Option<String>,
        synced: Option<i64>,
    ) {
        let _ = self.update_agent(helper_id, |a| {
            if let Some(h) = a.helper_sync.as_mut() {
                h.state = state;
                h.detail = detail;
                if let Some(files) = synced {
                    h.files = files;
                    h.last_sync_at = Some(now_ms());
                }
            }
        });
    }

    fn sync_state(&self, helper_id: &str) -> Option<HelperSyncState> {
        self.agent(helper_id).ok()?.helper_sync.map(|h| h.state)
    }

    fn same_conflict(&self, helper_id: &str, detail: &str) -> bool {
        self.agent(helper_id)
            .ok()
            .and_then(|a| a.helper_sync)
            .is_some_and(|h| {
                h.state == HelperSyncState::Conflict && h.detail.as_deref() == Some(detail)
            })
    }

    fn notice_both(
        &self,
        helper: &Agent,
        parent: &Agent,
        level: NoticeLevel,
        to_main: bool,
        files: usize,
        extra: &str,
    ) {
        let (h, m) = (&helper.title, &parent.title);
        let n = plural(files, "file", "files");
        let (for_main, for_helper) = if to_main {
            (
                format!("Merged {n} from helper \u{201c}{h}\u{201d}{extra}"),
                format!("Merged {n} into \u{201c}{m}\u{201d}{extra}"),
            )
        } else {
            (
                format!(
                    "Brought {n} from \u{201c}{m}\u{201d} into helper \u{201c}{h}\u{201d}{extra}"
                ),
                format!("Brought {n} from \u{201c}{m}\u{201d}{extra}"),
            )
        };
        self.ctx(&parent.id).notice(level, for_main);
        self.ctx(&helper.id).notice(level, for_helper);
    }

    // ---- triggers ------------------------------------------------------------

    /// An agent just became idle (its turn ended and nothing is queued).
    pub(crate) async fn on_turn_idle(&self, agent_id: &str) {
        let Ok(agent) = self.agent(agent_id) else {
            return;
        };
        if self.is_shutting_down() {
            return;
        }
        if agent.parent_id.is_some() {
            self.helper_to_main(agent_id).await;
            return;
        }
        // A main agent: helpers that were waiting for it merge now.
        let waiting: Vec<String> = self
            .inner
            .agents
            .lock()
            .values()
            .filter(|r| {
                r.agent.parent_id.as_deref() == Some(agent_id)
                    && r.agent
                        .helper_sync
                        .as_ref()
                        .is_some_and(|h| h.state == HelperSyncState::PendingToMain)
            })
            .map(|r| r.agent.id.clone())
            .collect();
        for id in waiting {
            self.helper_to_main(&id).await;
        }
    }

    /// Before a helper's next prompt: bring in what the main agent changed.
    pub(crate) async fn sync_before_prompt(&self, helper_id: &str) {
        let work = self.main_to_helper(helper_id);
        if tokio::time::timeout(PRE_PROMPT_BUDGET, work).await.is_err() {
            tracing::warn!("syncing helper {helper_id} from its main agent took too long");
            // The cancelled merge may have left the state on "Merging".
            if self.sync_state(helper_id) == Some(HelperSyncState::Merging) {
                self.set_sync(
                    helper_id,
                    HelperSyncState::PendingFromMain,
                    Some("Bringing in the main agent's changes took too long".into()),
                    None,
                );
            }
        }
    }

    // ---- helper -> main ------------------------------------------------------

    pub(crate) async fn helper_to_main(&self, helper_id: &str) {
        let _lock = lock_agent(&sync_key(helper_id)).await;
        if let Err(e) = self.helper_to_main_locked(helper_id).await {
            tracing::warn!("merging helper {helper_id}: {e:#}");
            if let Ok(helper) = self.agent(helper_id) {
                if helper.helper_sync.is_some() {
                    self.set_sync(
                        helper_id,
                        HelperSyncState::PendingToMain,
                        Some(format!("Couldn't merge yet: {e:#}")),
                        None,
                    );
                }
            }
        }
    }

    async fn helper_to_main_locked(&self, helper_id: &str) -> Result<()> {
        let helper = self.agent(helper_id)?;
        let (Some(parent_id), Some(_)) = (helper.parent_id.clone(), helper.helper_sync.as_ref())
        else {
            return Ok(());
        };
        let parent = self.agent(&parent_id)?;
        if self.ctx(helper_id).is_turn_active() {
            // Runs when its turn ends.
            return Ok(());
        }
        let h0 = helpers::base_tree(&helper, helper_id, Side::Helper)
            .await?
            .ok_or_else(|| anyhow!("the helper's sync data is gone"))?;
        let m0 = helpers::base_tree(&helper, helper_id, Side::Main)
            .await?
            .ok_or_else(|| anyhow!("the helper's sync data is gone"))?;
        let h1 = helpers::snapshot_tree(&helper, Some(&h0)).await?;
        if h1 == h0 {
            if matches!(
                self.sync_state(helper_id),
                Some(HelperSyncState::PendingToMain | HelperSyncState::Conflict)
            ) {
                self.set_sync(helper_id, HelperSyncState::InSync, None, None);
            }
            return Ok(());
        }
        if self.ctx(&parent_id).is_turn_active() {
            self.set_sync(
                helper_id,
                HelperSyncState::PendingToMain,
                Some(format!(
                    "Waiting for \u{201c}{}\u{201d} to finish its turn",
                    parent.title
                )),
                None,
            );
            return Ok(());
        }
        self.set_sync(helper_id, HelperSyncState::Merging, None, None);
        match helpers::merge_into(&parent, &h0, &h1, &m0).await? {
            Merge::Done {
                files, base_after, ..
            } => {
                helpers::set_base(&helper, helper_id, Side::Helper, &h1).await?;
                helpers::set_base(&helper, helper_id, Side::Main, &base_after).await?;
                self.set_sync(helper_id, HelperSyncState::InSync, None, Some(files as i64));
                if files > 0 {
                    self.notice_both(&helper, &parent, NoticeLevel::Info, true, files, "");
                }
            }
            Merge::Conflict(files) => {
                let detail = format!("Conflicts in {}", list_files(&files));
                // The same conflict again (the next turn changed nothing about it)
                // doesn't need the same two notices again.
                let repeat = self.same_conflict(helper_id, &detail);
                self.set_sync(
                    helper_id,
                    HelperSyncState::Conflict,
                    Some(detail.clone()),
                    None,
                );
                if repeat {
                    return Ok(());
                }
                let hint = "Use \u{201c}Ask main to merge\u{201d} on the helper to have the main agent integrate them.";
                self.ctx(&parent.id).notice(
                    NoticeLevel::Warn,
                    format!(
                        "Couldn't merge helper \u{201c}{}\u{201d} automatically. {detail}. Nothing was changed here. {hint}",
                        helper.title
                    ),
                );
                self.ctx(&helper.id).notice(
                    NoticeLevel::Warn,
                    format!(
                        "Couldn't merge into \u{201c}{}\u{201d} automatically. {detail}. Nothing was changed there. {hint}",
                        parent.title
                    ),
                );
            }
        }
        Ok(())
    }

    // ---- main -> helper ------------------------------------------------------

    pub(crate) async fn main_to_helper(&self, helper_id: &str) {
        let _lock = lock_agent(&sync_key(helper_id)).await;
        if let Err(e) = self.main_to_helper_locked(helper_id).await {
            tracing::warn!("syncing helper {helper_id} from main: {e:#}");
            if self.agent(helper_id).is_ok_and(|a| a.helper_sync.is_some()) {
                self.set_sync(
                    helper_id,
                    HelperSyncState::PendingFromMain,
                    Some(format!(
                        "Couldn't bring in the main agent's changes yet: {e:#}"
                    )),
                    None,
                );
            }
        }
    }

    async fn main_to_helper_locked(&self, helper_id: &str) -> Result<()> {
        let helper = self.agent(helper_id)?;
        let (Some(parent_id), Some(_)) = (helper.parent_id.clone(), helper.helper_sync.as_ref())
        else {
            return Ok(());
        };
        let parent = self.agent(&parent_id)?;
        if self.ctx(helper_id).is_turn_active() {
            return Ok(());
        }
        let m0 = helpers::base_tree(&helper, helper_id, Side::Main)
            .await?
            .ok_or_else(|| anyhow!("the helper's sync data is gone"))?;
        let h0 = helpers::base_tree(&helper, helper_id, Side::Helper)
            .await?
            .ok_or_else(|| anyhow!("the helper's sync data is gone"))?;
        let m1 = helpers::snapshot_tree(&parent, Some(&m0)).await?;
        if m1 == m0 {
            if self.sync_state(helper_id) == Some(HelperSyncState::PendingFromMain) {
                self.set_sync(helper_id, HelperSyncState::InSync, None, None);
            }
            return Ok(());
        }
        if self.ctx(&parent_id).is_turn_active() {
            self.set_sync(
                helper_id,
                HelperSyncState::PendingFromMain,
                Some(format!(
                    "Waiting for \u{201c}{}\u{201d} to finish its turn",
                    parent.title
                )),
                None,
            );
            return Ok(());
        }
        self.set_sync(helper_id, HelperSyncState::Merging, None, None);
        match helpers::merge_into(&helper, &m0, &m1, &h0).await? {
            Merge::Done {
                files,
                target_after,
                base_after,
            } => {
                helpers::set_base(&helper, helper_id, Side::Main, &m1).await?;
                helpers::set_base(&helper, helper_id, Side::Helper, &base_after).await?;
                // The helper may still have changes the main agent hasn't received.
                let state = if target_after == base_after {
                    HelperSyncState::InSync
                } else {
                    HelperSyncState::PendingToMain
                };
                self.set_sync(helper_id, state, None, Some(files as i64));
                if files > 0 {
                    self.notice_both(&helper, &parent, NoticeLevel::Info, false, files, "");
                }
            }
            Merge::Conflict(files) => {
                let detail = format!("Main's changes conflict in {}", list_files(&files));
                let repeat = self.same_conflict(helper_id, &detail);
                self.set_sync(
                    helper_id,
                    HelperSyncState::Conflict,
                    Some(detail.clone()),
                    None,
                );
                if repeat {
                    return Ok(());
                }
                self.ctx(&helper.id).notice(
                    NoticeLevel::Warn,
                    format!(
                        "Couldn't bring in \u{201c}{}\u{201d}'s latest changes. {detail}. Nothing was changed here; continuing without them.",
                        parent.title
                    ),
                );
            }
        }
        Ok(())
    }

    // ---- commands ------------------------------------------------------------

    /// Runs a sync now, both ways where the agents are idle. Returns the helper.
    pub async fn sync_helper(&self, helper_id: &str) -> Result<Agent> {
        let helper = self.agent(helper_id)?;
        if helper.parent_id.is_none() || helper.helper_sync.is_none() {
            bail!("This agent isn't a helper");
        }
        self.agent(helper.parent_id.as_deref().unwrap_or_default())
            .map_err(|_| anyhow!("The main agent no longer exists"))?;
        self.helper_to_main(helper_id).await;
        self.main_to_helper(helper_id).await;
        self.agent(helper_id)
    }

    /// Conflict fallback: asks the main agent (by a normal message, queued if it's
    /// busy) to integrate the helper's changes from a patch file.
    pub async fn ask_main_to_merge(&self, helper_id: &str) -> Result<()> {
        let helper = self.agent(helper_id)?;
        let Some(parent_id) = helper
            .parent_id
            .clone()
            .filter(|_| helper.helper_sync.is_some())
        else {
            bail!("This agent isn't a helper");
        };
        let parent = self
            .agent(&parent_id)
            .map_err(|_| anyhow!("The main agent no longer exists"))?;
        let _lock = lock_agent(&sync_key(helper_id)).await;
        let h0 = helpers::base_tree(&helper, helper_id, Side::Helper)
            .await?
            .ok_or_else(|| anyhow!("the helper's sync data is gone"))?;
        let h1 = helpers::snapshot_tree(&helper, Some(&h0)).await?;
        let files = helpers::changed_paths(&helper, &h0, &h1).await?;
        if files.is_empty() {
            bail!("The helper has no changes to hand over");
        }
        let patch = helpers::patch_between(&helper, &h0, &h1).await?;
        let dir = self.inner.data_dir.join("helper-patches");
        std::fs::create_dir_all(&dir)?;
        restrict_dir(&dir);
        let file = dir.join(format!(
            "{}-{}.patch",
            &helper.id[..8.min(helper.id.len())],
            now_ms()
        ));
        std::fs::write(&file, &patch).context("saving the helper's patch")?;
        let listing = files
            .iter()
            .take(40)
            .map(|f| format!("- {f}"))
            .collect::<Vec<_>>()
            .join("\n");
        let more = if files.len() > 40 {
            format!("\n- ... and {} more", files.len() - 40)
        } else {
            String::new()
        };
        let text = format!(
            "Please integrate the changes from helper agent \u{201c}{}\u{201d} into this workspace. \
             They could not be merged automatically because they overlap with changes here.\n\n\
             The helper's changes are saved as a git patch (binary-safe, full object ids) at:\n{}\n\n\
             Files changed by the helper ({}):\n{listing}{more}\n\n\
             Read the patch, apply it with `git apply --3way` or by hand, resolve any conflicts \
             sensibly while keeping the work you have done here, and tell me what you decided.",
            helper.title,
            file.display(),
            files.len(),
        );
        // A normal, visible message; it queues behind a running turn.
        self.send_prompt(&parent.id, &text, Vec::new()).await?;
        // The patch now belongs to the main agent: the helper's base moves on.
        helpers::set_base(&helper, helper_id, Side::Helper, &h1).await?;
        self.set_sync(
            helper_id,
            HelperSyncState::InSync,
            Some(format!(
                "Handed to \u{201c}{}\u{201d} to merge",
                parent.title
            )),
            Some(files.len() as i64),
        );
        self.ctx(&helper.id).notice(
            NoticeLevel::Info,
            format!(
                "Asked \u{201c}{}\u{201d} to merge {}",
                parent.title,
                plural(files.len(), "file", "files")
            ),
        );
        Ok(())
    }

    // ---- deletion ------------------------------------------------------------

    /// An agent was just removed: a helper's sync data goes; a main agent's
    /// helpers keep running on their own.
    pub(crate) async fn helper_deleted(&self, gone: &Agent) {
        if gone.parent_id.is_some() {
            // Waits for a merge that is still running, so it can't re-create the refs.
            let _lock = lock_agent(&sync_key(&gone.id)).await;
            let folder = if Path::new(&gone.project_path).is_dir() {
                gone.project_path.clone()
            } else {
                gone.cwd.clone()
            };
            helpers::forget(Path::new(&folder), &gone.id).await;
            // Its "ask main to merge" patches go with it.
            let prefix = format!("{}-", &gone.id[..8.min(gone.id.len())]);
            if let Ok(rd) = std::fs::read_dir(self.inner.data_dir.join("helper-patches")) {
                for e in rd.flatten() {
                    if e.file_name().to_string_lossy().starts_with(&prefix) {
                        let _ = std::fs::remove_file(e.path());
                    }
                }
            }
            return;
        }
        let orphans: Vec<String> = self
            .inner
            .agents
            .lock()
            .values()
            .filter(|r| r.agent.parent_id.as_deref() == Some(gone.id.as_str()))
            .map(|r| r.agent.id.clone())
            .collect();
        for id in orphans {
            let _lock = lock_agent(&sync_key(&id)).await;
            let _ = self.update_agent(&id, |a| {
                a.parent_id = None;
                a.helper_sync = None;
            });
            self.ctx(&id).notice(
                NoticeLevel::Info,
                format!(
                    "The main agent \u{201c}{}\u{201d} was deleted. This agent now works on its own; nothing is merged automatically anymore.",
                    gone.title
                ),
            );
            let folder = if Path::new(&gone.project_path).is_dir() {
                gone.project_path.clone()
            } else {
                gone.cwd.clone()
            };
            helpers::forget(Path::new(&folder), &id).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parent() -> Agent {
        let mut a = crate::helpers::tests::agent_at("p", Path::new("/p"));
        a.provider = Provider::Claude;
        a.account_id = "acc-claude".into();
        a
    }

    fn account(id: &str, provider: Provider) -> Account {
        serde_json::from_value(serde_json::json!({
            "id": id, "provider": provider, "name": id, "color": "#fff",
            "authKind": "default", "isSystem": false, "configDir": null, "status": null, "createdAt": 0
        }))
        .unwrap_or_else(|e| panic!("account: {e}"))
    }

    #[test]
    fn helper_defaults_fall_back_to_the_main_agent() {
        let p = parent();
        let accounts = vec![
            account("acc-claude", Provider::Claude),
            account("acc-codex", Provider::Codex),
        ];
        let mut s = Settings::default();
        // Nothing set: same as the main agent.
        let t = resolve_target(&s, &p, &accounts).unwrap();
        assert_eq!(t.provider, Provider::Claude);
        assert_eq!(t.account_id, "acc-claude");
        assert_eq!(t.model, None);
        // A model only.
        s.helper_defaults.model = Some("haiku".into());
        assert_eq!(
            resolve_target(&s, &p, &accounts).unwrap().model.as_deref(),
            Some("haiku")
        );
        // Another provider with its account.
        s.helper_defaults.provider = Some(Provider::Codex);
        s.helper_defaults.account_id = Some("acc-codex".into());
        let t = resolve_target(&s, &p, &accounts).unwrap();
        assert_eq!(
            (t.provider, t.account_id.as_str()),
            (Provider::Codex, "acc-codex")
        );
        // The default account was removed: another account of that provider.
        s.helper_defaults.account_id = Some("gone".into());
        let t = resolve_target(&s, &p, &accounts).unwrap();
        assert_eq!(t.account_id, "acc-codex");
        // No account for that provider at all: the main agent's setup.
        let only_claude = vec![account("acc-claude", Provider::Claude)];
        let t = resolve_target(&s, &p, &only_claude).unwrap();
        assert_eq!(
            (t.provider, t.account_id.as_str()),
            (Provider::Claude, "acc-claude")
        );
        assert_eq!(
            t.model, None,
            "a model for another provider isn't carried over"
        );
        // The main agent's own account is gone and nothing else works.
        assert!(resolve_target(&Settings::default(), &p, &[]).is_err());
        // A removed default account falls back to the main agent's.
        let mut s = Settings::default();
        s.helper_defaults.account_id = Some("gone".into());
        assert_eq!(
            resolve_target(&s, &p, &accounts).unwrap().account_id,
            "acc-claude"
        );
    }
}
