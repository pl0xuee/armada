//! Shell-side shared state (things the core doesn't own).

use std::path::PathBuf;

use armada_core::{providers, ProviderInfo};
use parking_lot::Mutex;

pub struct Shell {
    pub data_dir: PathBuf,
    /// Last `providers::detect()` result; `None` until the first detection finishes.
    providers: tokio::sync::Mutex<Option<Vec<ProviderInfo>>>,
    /// The global hotkey currently registered with the OS.
    pub hotkey: Mutex<Option<String>>,
}

impl Shell {
    pub fn new(data_dir: PathBuf) -> Self {
        Shell {
            data_dir,
            providers: tokio::sync::Mutex::new(None),
            hotkey: Mutex::new(None),
        }
    }

    /// Cached detection result, detecting on first use. Concurrent callers wait for
    /// the same detection instead of racing.
    pub async fn providers(&self) -> Vec<ProviderInfo> {
        let mut cache = self.providers.lock().await;
        if let Some(p) = cache.as_ref() {
            return p.clone();
        }
        let detected = providers::detect(&self.data_dir).await;
        *cache = Some(detected.clone());
        detected
    }

    /// Re-runs detection (after installs, or when the user asks).
    pub async fn refresh_providers(&self) -> Vec<ProviderInfo> {
        let mut cache = self.providers.lock().await;
        let detected = providers::detect(&self.data_dir).await;
        *cache = Some(detected.clone());
        detected
    }
}
