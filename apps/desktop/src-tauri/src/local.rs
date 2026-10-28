//! Local model servers: detection, model lists and Ollama downloads.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use armada_core::{accounts, local, Core, LocalKind, LocalProbe, LocalServer, PullProgress};
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
