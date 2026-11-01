//! Spending limits: the Usage view reads today's spend from here, and a "Needs you"
//! item for a held agent is answered here. The limits themselves are settings; the
//! alerts and holding live in `kvistcode_core::budget`.

use kvistcode_core::budget::{BudgetChoice, BudgetStatus};
use kvistcode_core::{Core, Settings};
use tauri::State;

/// Today's spend (since local midnight) against the daily limits.
#[tauri::command]
pub fn budget_status(core: State<'_, Core>) -> BudgetStatus {
    core.budget_status()
}

/// Answers an agent held at a spending limit: raise the limit that was hit, continue
/// for one more turn, or stop. Returns the settings (a raised project or daily limit
/// is stored there).
#[tauri::command]
pub async fn budget_resolve(
    core: State<'_, Core>,
    agent_id: String,
    choice: BudgetChoice,
) -> Result<Settings, String> {
    core.budget_resolve(&agent_id, choice)
        .await
        .map_err(|e| format!("{e:#}"))
}
