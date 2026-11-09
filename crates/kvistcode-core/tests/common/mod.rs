//! Scratch folders for the integration tests. They are deleted when the test's thread
//! ends, whether the test passed, failed or panicked, so a test run leaves nothing
//! behind in the temp folder.

#![allow(dead_code)]

use std::cell::RefCell;
use std::path::PathBuf;

struct Cleanup(Vec<PathBuf>);

impl Drop for Cleanup {
    fn drop(&mut self) {
        for dir in self.0.drain(..) {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

thread_local! {
    static DIRS: RefCell<Cleanup> = const { RefCell::new(Cleanup(Vec::new())) };
}

/// A new, empty, uniquely named folder in the temp folder, removed when the calling
/// test's thread ends. Call it from the test's own thread (not a spawned task).
pub fn scratch(prefix: &str) -> PathBuf {
    keep_off_the_real_keychain();
    let dir = std::env::temp_dir().join(format!(
        "kvistcode-{prefix}-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&dir).expect("creating a scratch folder");
    DIRS.with(|d| d.borrow_mut().0.push(dir.clone()));
    dir
}

/// Settings secrets go to memory, never the developer's OS keychain (a desktop prompt
/// "create a new keyring" is what the real one does on a fresh machine).
pub fn keep_off_the_real_keychain() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| std::env::set_var("KVISTCODE_SECRETS", "memory"));
}
