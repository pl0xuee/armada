// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `kvistcode filter-output`: the hook Claude Code runs to tidy shell output (token saving).
    // Handled before anything else starts: no window, no database.
    if std::env::args().nth(1).as_deref() == Some("filter-output") {
        std::process::exit(kvistcode_core::output_filter::run_hook());
    }
    // `kvistcode helper-model <model>`: the hook that holds Claude's helpers to the helper model.
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() == Some(kvistcode_core::token_saver::HELPER_MODEL_HOOK) {
        let model = args.next().unwrap_or_default();
        std::process::exit(kvistcode_core::token_saver::run_helper_model_hook(&model));
    }
    kvistcode_desktop_lib::run();
}
