//! Local model servers: detection, model lists and Ollama downloads.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use kvistcode_core::hardware::{self, Hardware};
use kvistcode_core::local_health::{self, LocalHealth, SpeedResult};
use kvistcode_core::local_prefs::{self, LocalPrefs};
use kvistcode_core::{accounts, local, Core, LocalKind, LocalProbe, LocalServer, PullProgress};
use tauri::ipc::Channel;
use tauri::State;

use crate::commands::CmdResult;

/// Downloads in flight, by the id the UI gave them.
static PULLS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Probes the default Ollama and LM Studio addresses.
#[tauri::command]
pub async fn detect_local_servers() -> CmdResult<Vec<LocalProbe>> {
    tauri::async_runtime::spawn_blocking(local::detect)
        .await
        .map_err(|e| e.to_string())
}

/// Probes one server (an address typed in the Add dialog; `api_key` is its optional token).
#[tauri::command]
pub async fn probe_local_server(
    kind: LocalKind,
    base_url: String,
    api_key: Option<String>,
) -> CmdResult<LocalProbe> {
    let server = local::validate(&LocalServer { kind, base_url }).map_err(|e| format!("{e:#}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        local::probe(&server, api_key.as_deref().filter(|k| !k.trim().is_empty()))
    })
    .await
    .map_err(|e| e.to_string())
}

/// Probes the server of an existing local account (live model list).
#[tauri::command]
pub async fn probe_local_account(
    core: State<'_, Core>,
    account_id: String,
) -> CmdResult<LocalProbe> {
    let account = core.account(&account_id).map_err(|e| format!("{e:#}"))?;
    let server = account
        .local
        .ok_or_else(|| "This isn't a local model account".to_string())?;
    let key = accounts::get_api_key(&account_id);
    tauri::async_runtime::spawn_blocking(move || local::probe(&server, key.as_deref()))
        .await
        .map_err(|e| e.to_string())
}

/// Downloads a model into Ollama, streaming progress. Resolves when it finishes,
/// fails or is cancelled via `cancel_local_pull`.
#[tauri::command]
pub async fn pull_local_model(
    base_url: String,
    model: String,
    pull_id: String,
    on_progress: Channel<PullProgress>,
) -> CmdResult<()> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut pulls = PULLS.lock().unwrap_or_else(|e| e.into_inner());
        if pulls.contains_key(&pull_id) {
            return Err("That download is already running".into());
        }
        pulls.insert(pull_id.clone(), cancel.clone());
    }
    let flag = cancel.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        local::pull_ollama(&base_url, &model, &flag, |p| {
            let _ = on_progress.send(p);
        })
    })
    .await;
    PULLS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&pull_id);
    match result {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(format!("{e:#}")),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn cancel_local_pull(pull_id: String) {
    if let Some(flag) = PULLS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&pull_id)
    {
        flag.store(true, Ordering::SeqCst);
    }
}

/// The server and API key of a local account.
fn account_server(core: &Core, account_id: &str) -> CmdResult<(LocalServer, Option<String>)> {
    let account = core.account(account_id).map_err(|e| format!("{e:#}"))?;
    let server = account
        .local
        .ok_or_else(|| "This isn't a local model account".to_string())?;
    Ok((server, accounts::get_api_key(account_id)))
}

/// RAM, GPU and free disk space on this computer.
#[tauri::command]
pub async fn local_hardware() -> CmdResult<Hardware> {
    tauri::async_runtime::spawn_blocking(hardware::detect)
        .await
        .map_err(|e| e.to_string())
}

/// Health, loaded models and fix instructions for a local account's server.
#[tauri::command]
pub async fn local_health_account(
    core: State<'_, Core>,
    account_id: String,
) -> CmdResult<LocalHealth> {
    let (server, key) = account_server(&core, &account_id)?;
    tauri::async_runtime::spawn_blocking(move || local_health::health(&server, key.as_deref()))
        .await
        .map_err(|e| e.to_string())
}

/// Generates a few tokens to measure how fast a model runs.
#[tauri::command]
pub async fn local_speed_test(
    core: State<'_, Core>,
    account_id: String,
    model: String,
) -> CmdResult<SpeedResult> {
    let (server, key) = account_server(&core, &account_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        local_health::speed_test(&server, key.as_deref(), &model)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("{e:#}"))
}

/// Frees the memory of a loaded model.
#[tauri::command]
pub async fn local_unload_model(
    core: State<'_, Core>,
    account_id: String,
    model: String,
) -> CmdResult<()> {
    let (server, key) = account_server(&core, &account_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        local_health::unload(&server, key.as_deref(), &model)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("{e:#}"))
}

/// Deletes an Ollama model (and the larger-window copies Kvistcode made of it).
#[tauri::command]
pub async fn local_delete_model(
    core: State<'_, Core>,
    account_id: String,
    model: String,
) -> CmdResult<()> {
    let (server, _) = account_server(&core, &account_id)?;
    tauri::async_runtime::spawn_blocking(move || local_health::delete_model(&server, &model))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn get_local_prefs(core: State<'_, Core>) -> LocalPrefs {
    local_prefs::load(core.data_dir())
}

#[tauri::command]
pub fn set_local_prefs(core: State<'_, Core>, prefs: LocalPrefs) -> CmdResult<()> {
    local_prefs::save(core.data_dir(), &prefs).map_err(|e| format!("{e:#}"))
}
