//! Spending caps: the Usage view reads today's spend from here. The caps themselves
//! are settings; the alerts and pausing live in `armada_core::budget`.

use armada_core::budget::BudgetStatus;
use armada_core::Core;
use tauri::State;

/// Today's spend (since local midnight) against the daily cap.
#[tauri::command]
pub fn budget_status(core: State<'_, Core>) -> BudgetStatus {
    core.budget_status()
}
