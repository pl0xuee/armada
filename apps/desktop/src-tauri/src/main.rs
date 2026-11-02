// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `kvistcode filter-output`: the hook Claude Code runs to tidy shell output (token saving).
    // Handled before anything else starts: no window, no database.
    if std::env::args().nth(1).as_deref() == Some("filter-output") {
        std::process::exit(kvistcode_core::output_filter::run_hook());
    }
    kvistcode_desktop_lib::run();
}
