//! Keeps MCP server / custom agent environment and header values out of the SQLite
//! file: the database stores `keychain:<key>` references, and ONE OS keychain item
//! (`settings-secrets`, same service as the API keys) holds a JSON map of key to
//! value. One item means one keychain prompt on macOS, not one per value. The map is
//! read once per process and cached; it is written back only when a value changes.
//! Everything above the database sees plain values: `Db::settings` resolves and
//! `Db::put_settings` externalizes.
//!
//! If the keychain is unavailable a value stays in the database as plaintext (with a
//! warning) so nothing is lost.

use crate::model::{KeyValue, Settings};
use parking_lot::Mutex;
use std::collections::BTreeMap;

const REF_PREFIX: &str = "keychain:";

/// A `keychain:` reference the vault couldn't resolve. Such values are dropped rather than
/// handed to an MCP server or agent as if they were the secret.
pub(crate) fn is_unresolved(value: &str) -> bool {
    value.starts_with(REF_PREFIX)
}
const ACCOUNT_PREFIX: &str = "secret/";
const VAULT_ACCOUNT: &str = "settings-secrets";

pub trait SecretStore: Send + Sync {
    fn set(&self, account: &str, value: &str) -> anyhow::Result<()>;
    /// `Ok(None)` = no such entry; `Err` = the keychain couldn't be read.
    fn get(&self, account: &str) -> anyhow::Result<Option<String>>;
    fn delete(&self, account: &str);
}

#[cfg_attr(test, allow(dead_code))]
pub struct Keyring;

impl SecretStore for Keyring {
    fn set(&self, account: &str, value: &str) -> anyhow::Result<()> {
        use anyhow::Context;
        keyring::Entry::new(crate::accounts::KEYRING_SERVICE, account)?
            .set_password(value)
            .context("saving to the OS keychain")
    }
    fn get(&self, account: &str) -> anyhow::Result<Option<String>> {
        let entry = keyring::Entry::new(crate::accounts::KEYRING_SERVICE, account)?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }
    fn delete(&self, account: &str) {
        if let Ok(e) = keyring::Entry::new(crate::accounts::KEYRING_SERVICE, account) {
            let _ = e.delete_credential();
        }
    }
}

/// The vault the database uses (backed by memory under `cargo test`).
pub(crate) fn vault() -> &'static Vault {
    static V: std::sync::OnceLock<Vault> = std::sync::OnceLock::new();
    V.get_or_init(|| {
        #[cfg(test)]
        {
            Vault::new(Box::new(Memory::default()))
        }
        #[cfg(not(test))]
        {
            Vault::new(Box::new(Keyring))
        }
    })
}

/// The single keychain item, cached in memory.
pub struct Vault {
    store: Box<dyn SecretStore>,
    cache: Mutex<Option<BTreeMap<String, String>>>,
}

impl Vault {
    pub fn new(store: Box<dyn SecretStore>) -> Self {
        Vault {
            store,
            cache: Mutex::new(None),
        }
    }

    /// The cached map; a failed keychain read is an error and is never cached.
    fn load(&self) -> anyhow::Result<parking_lot::MappedMutexGuard<'_, BTreeMap<String, String>>> {
        let mut g = self.cache.lock();
        if g.is_none() {
            let map = match self.store.get(VAULT_ACCOUNT)? {
                None => BTreeMap::new(),
                Some(j) => serde_json::from_str(&j)
                    .map_err(|e| anyhow::anyhow!("the keychain item isn't readable: {e}"))?,
            };
            *g = Some(map);
        }
        Ok(parking_lot::MutexGuard::map(g, |o| {
            o.as_mut().expect("loaded")
        }))
    }

    fn get(&self, key: &str) -> anyhow::Result<Option<String>> {
        Ok(self.load()?.get(key).cloned())
    }

    /// Makes the stored map exactly `next`; writes only if it differs.
    fn replace(&self, next: BTreeMap<String, String>) -> anyhow::Result<()> {
        if *self.load()? == next {
            return Ok(());
        }
        if next.is_empty() {
            self.store.delete(VAULT_ACCOUNT);
        } else {
            self.store
                .set(VAULT_ACCOUNT, &serde_json::to_string(&next)?)?;
        }
        *self.cache.lock() = Some(next);
        Ok(())
    }
}

#[cfg(test)]
#[derive(Default)]
pub struct Memory(pub parking_lot::Mutex<std::collections::HashMap<String, String>>);

#[cfg(test)]
impl SecretStore for Memory {
    fn set(&self, account: &str, value: &str) -> anyhow::Result<()> {
        self.0.lock().insert(account.into(), value.into());
        Ok(())
    }
    fn get(&self, account: &str) -> anyhow::Result<Option<String>> {
        Ok(self.0.lock().get(account).cloned())
    }
    fn delete(&self, account: &str) {
        self.0.lock().remove(account);
    }
}

/// Every secret-bearing slot with its stable keychain account name.
fn slots(settings: &mut Settings) -> Vec<(String, &mut KeyValue)> {
    let mut out = Vec::new();
    for (i, s) in settings.mcp_servers.iter_mut().enumerate() {
        let id = if s.id.is_empty() {
            i.to_string()
        } else {
            s.id.clone()
        };
        for kv in s.env.iter_mut() {
            out.push((format!("{ACCOUNT_PREFIX}mcp/{id}/env/{}", kv.name), kv));
        }
        for kv in s.headers.iter_mut() {
            out.push((format!("{ACCOUNT_PREFIX}mcp/{id}/header/{}", kv.name), kv));
        }
    }
    for (i, a) in settings.custom_agents.iter_mut().enumerate() {
        let id = if a.id.is_empty() {
            i.to_string()
        } else {
            a.id.clone()
        };
        for kv in a.env.iter_mut() {
            out.push((format!("{ACCOUNT_PREFIX}agent/{id}/env/{}", kv.name), kv));
        }
    }
    out
}

/// Replaces references with the stored values. Returns true if any plaintext value
/// was found (it should be migrated).
pub(crate) fn resolve(settings: &mut Settings, vault: &Vault) -> bool {
    let mut plaintext = false;
    let mut slots = slots(settings);
    if slots.iter().all(|(_, kv)| kv.value.is_empty()) {
        return false; // nothing stored: don't touch the keychain
    }
    for (slot_key, kv) in slots.iter_mut() {
        // Only a reference to the field's own key is one (a value typed as
        // `keychain:other` must not read another field's secret; it is plain text).
        if kv.value.strip_prefix(REF_PREFIX) == Some(slot_key.as_str()) {
            match vault.get(slot_key.as_str()) {
                Ok(Some(v)) => kv.value = v,
                Ok(None) => {
                    tracing::warn!("a stored secret ({}) is missing from the keychain", kv.name)
                }
                Err(e) => tracing::warn!(
                    "couldn't read the keychain for a stored secret ({}): {e:#}",
                    kv.name
                ),
            }
        } else if !kv.value.is_empty() {
            plaintext = true;
        }
    }
    plaintext
}

/// A copy of `settings` safe to write to the database: values moved to the keychain
/// item and replaced by references. Keys no longer used are dropped from the item.
pub(crate) fn externalize(settings: &Settings, vault: &Vault) -> Settings {
    let mut out = settings.clone();
    let mut slots = slots(&mut out);
    if slots.iter().all(|(_, kv)| kv.value.is_empty()) && vault.cache.lock().is_none() {
        return out; // no secrets, keychain never needed
    }
    let mut next = BTreeMap::new();
    // Set when a reference couldn't be resolved because the keychain failed: the
    // item is then left exactly as it is (rewriting it would lose those entries).
    let mut unreadable = false;
    for (key, kv) in slots.iter() {
        if kv.value.is_empty() {
            continue;
        }
        // Unresolved reference to this very slot (keychain was unavailable at load):
        // keep the stored value, never store the reference text as the secret.
        if kv.value.strip_prefix(REF_PREFIX) == Some(key.as_str()) {
            match vault.get(key) {
                Ok(Some(v)) => {
                    next.insert(key.clone(), v);
                }
                Ok(None) => {}
                Err(e) => {
                    tracing::warn!("keychain unreadable, leaving stored secrets untouched: {e:#}");
                    unreadable = true;
                }
            }
            continue;
        }
        next.insert(key.clone(), kv.value.clone());
    }
    if unreadable {
        return out;
    }
    match vault.replace(next) {
        Ok(()) => {
            for (key, kv) in slots.iter_mut() {
                if !kv.value.is_empty() && kv.value.strip_prefix(REF_PREFIX) != Some(key.as_str()) {
                    kv.value = format!("{REF_PREFIX}{key}");
                }
            }
        }
        Err(e) => {
            tracing::warn!(
                "keychain unavailable, keeping MCP/agent secrets in the database: {e:#}"
            );
            // Plaintext fallback; unresolved refs stay refs.
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::McpServer;

    fn settings() -> Settings {
        let mut s = Settings::default();
        s.mcp_servers.push(McpServer {
            id: "m1".into(),
            headers: vec![KeyValue {
                name: "Authorization".into(),
                value: "Bearer xyz".into(),
            }],
            env: vec![
                KeyValue {
                    name: "TOKEN".into(),
                    value: "abc".into(),
                },
                KeyValue {
                    name: "E".into(),
                    value: String::new(),
                },
            ],
            ..serde_json::from_str("{}").unwrap()
        });
        s
    }

    #[derive(Default)]
    struct Counting {
        inner: Memory,
        gets: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        sets: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }

    impl SecretStore for Counting {
        fn set(&self, a: &str, v: &str) -> anyhow::Result<()> {
            self.sets.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.inner.set(a, v)
        }
        fn get(&self, a: &str) -> anyhow::Result<Option<String>> {
            self.gets.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.inner.get(a)
        }
        fn delete(&self, a: &str) {
            self.inner.delete(a)
        }
    }

    #[test]
    fn round_trip_and_cleanup() {
        let vault = Vault::new(Box::new(Memory::default()));
        let stored = externalize(&settings(), &vault);
        let json = serde_json::to_string(&stored).unwrap();
        assert!(!json.contains("abc") && !json.contains("xyz"), "{json}");
        let mut back = stored.clone();
        assert!(!resolve(&mut back, &vault));
        assert_eq!(back.mcp_servers[0].env[0].value, "abc");
        assert_eq!(back.mcp_servers[0].headers[0].value, "Bearer xyz");
        assert_eq!(vault.load().unwrap().len(), 2);
        // Removing the server drops its secrets from the item.
        externalize(&Settings::default(), &vault);
        assert!(vault.load().unwrap().is_empty());
    }

    #[test]
    fn plaintext_is_detected_for_migration() {
        let mut s = settings();
        assert!(resolve(&mut s, &Vault::new(Box::new(Memory::default()))));
    }

    #[test]
    fn keychain_is_read_once_and_written_only_on_change() {
        use std::sync::atomic::Ordering::SeqCst;
        let c = Counting::default();
        let (gets, sets) = (c.gets.clone(), c.sets.clone());
        let vault = Vault::new(Box::new(c));
        let stored = externalize(&settings(), &vault);
        assert_eq!(sets.load(SeqCst), 1);
        for _ in 0..3 {
            let mut s = stored.clone();
            resolve(&mut s, &vault);
            externalize(&s, &vault);
        }
        assert_eq!(gets.load(SeqCst), 1, "one read per process");
        assert_eq!(sets.load(SeqCst), 1, "unchanged secrets are not rewritten");
        let mut changed = stored.clone();
        resolve(&mut changed, &vault);
        changed.mcp_servers[0].env[0].value = "new".into();
        externalize(&changed, &vault);
        assert_eq!(sets.load(SeqCst), 2);
    }

    /// Fails reads while `fail` is set; counts writes.
    struct Flaky {
        inner: Memory,
        fail: std::sync::Arc<std::sync::atomic::AtomicBool>,
        writes: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }

    impl SecretStore for Flaky {
        fn set(&self, a: &str, v: &str) -> anyhow::Result<()> {
            self.writes
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.inner.set(a, v)
        }
        fn get(&self, a: &str) -> anyhow::Result<Option<String>> {
            if self.fail.load(std::sync::atomic::Ordering::SeqCst) {
                anyhow::bail!("locked");
            }
            self.inner.get(a)
        }
        fn delete(&self, a: &str) {
            self.writes
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.inner.delete(a)
        }
    }

    #[test]
    fn failed_read_is_not_cached_and_never_rewrites_the_vault() {
        use std::sync::atomic::Ordering::SeqCst;
        let fail = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let writes = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mem = Memory::default();
        let seed = Vault::new(Box::new(Memory::default()));
        let stored = externalize(&settings(), &seed);
        mem.set(
            VAULT_ACCOUNT,
            &serde_json::to_string(&*seed.load().unwrap()).unwrap(),
        )
        .unwrap();
        let vault = Vault::new(Box::new(Flaky {
            inner: mem,
            fail: fail.clone(),
            writes: writes.clone(),
        }));
        fail.store(true, SeqCst);
        let mut s = stored.clone();
        resolve(&mut s, &vault);
        assert!(s.mcp_servers[0].env[0].value.starts_with(REF_PREFIX));
        // Saving while the keychain is unreadable leaves it alone.
        externalize(&s, &vault);
        assert_eq!(writes.load(SeqCst), 0);
        // The failure wasn't cached: once readable, references resolve.
        fail.store(false, SeqCst);
        let mut s = stored.clone();
        resolve(&mut s, &vault);
        assert_eq!(s.mcp_servers[0].env[0].value, "abc");
    }

    #[test]
    fn a_reference_to_another_field_is_not_resolved() {
        let vault = Vault::new(Box::new(Memory::default()));
        let mut stored = externalize(&settings(), &vault);
        let mut other = settings();
        other.mcp_servers[0].id = "m2".into();
        other.mcp_servers[0].env[0].value = "keychain:secret/mcp/m1/env/TOKEN".into();
        let _ = &mut stored;
        resolve(&mut other, &vault);
        assert_eq!(
            other.mcp_servers[0].env[0].value,
            "keychain:secret/mcp/m1/env/TOKEN"
        );
    }
}
