//! Preferences for local models, kept in `local_prefs.json` next to the database.

use std::path::{Path, PathBuf};

use anyhow::bail;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPrefs {
    /// Context window for local agents; `None` lets Kvistcode choose from memory.
    #[serde(default)]
    pub context_tokens: Option<i64>,
}

fn path(data_dir: &Path) -> PathBuf {
    data_dir.join("local_prefs.json")
}

pub fn load(data_dir: &Path) -> LocalPrefs {
    std::fs::read_to_string(path(data_dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(data_dir: &Path, prefs: &LocalPrefs) -> anyhow::Result<()> {
    if let Some(c) = prefs.context_tokens {
        if !(4_096..=1_048_576).contains(&c) {
            bail!("The context size must be between 4k and 1M tokens");
        }
    }
    let tmp = path(data_dir).with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(prefs)?)?;
    std::fs::rename(tmp, path(data_dir))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_validates() {
        let dir = std::env::temp_dir().join(format!("kvistcode-prefs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(load(&dir), LocalPrefs::default());
        let p = LocalPrefs {
            context_tokens: Some(65_536),
        };
        save(&dir, &p).unwrap();
        assert_eq!(load(&dir), p);
        assert!(save(
            &dir,
            &LocalPrefs {
                context_tokens: Some(10)
            }
        )
        .is_err());
        std::fs::write(dir.join("local_prefs.json"), "garbage").unwrap();
        assert_eq!(load(&dir), LocalPrefs::default());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
