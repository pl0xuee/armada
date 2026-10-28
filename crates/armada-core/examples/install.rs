//! Runs the one-click installer from the command line:
//!   cargo run -p armada-core --example install -- <data_dir> [claude|codex|grok|all]

use std::sync::Arc;

use armada_core::{toolchain, Provider};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let data = std::path::PathBuf::from(&args[1]);
    toolchain::add_managed_paths(&data);
    let log: toolchain::Log = Arc::new(|line: &str| println!("{line}"));
    match args.get(2).map(String::as_str).unwrap_or("all") {
        "all" => toolchain::install_missing(&data, log).await,
        p => toolchain::install(Provider::parse(p).expect("provider"), &data, log).await,
    }
}
