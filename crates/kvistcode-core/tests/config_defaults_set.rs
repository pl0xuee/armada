//! The model setup sets what new Claude agents start with, and can put it back the way it was.

#![cfg(unix)]

use std::collections::BTreeMap;
use std::sync::Arc;

use kvistcode_core::*;
use tokio::sync::mpsc;

struct Sink(mpsc::UnboundedSender<KvistcodeEvent>);

impl EventSink for Sink {
    fn emit(&self, event: KvistcodeEvent) {
        let _ = self.0.send(event);
    }
}

mod common;

fn values(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

#[test]
fn sets_and_forgets_the_model_and_effort_only() {
    let (tx, rx) = mpsc::unbounded_channel();
    std::mem::forget(rx);
    let base = common::scratch("test-config-defaults-set");
    let core = Core::open(base.join("data"), Arc::new(Sink(tx))).unwrap();

    let d = core
        .set_config_defaults(
            "claude",
            values(&[
                ("model", "fable"),
                ("effort", " high "),
                ("mode", "bypassPermissions"),
            ]),
        )
        .unwrap();
    assert_eq!(
        d["claude"],
        values(&[("effort", "high"), ("model", "fable")])
    );
    assert_eq!(core.config_defaults(), d, "saved");

    // An empty value forgets that option; forgetting the last drops the provider entirely.
    let d = core
        .set_config_defaults("claude", values(&[("effort", "")]))
        .unwrap();
    assert_eq!(d["claude"], values(&[("model", "fable")]));
    let d = core
        .set_config_defaults("claude", values(&[("model", "")]))
        .unwrap();
    assert!(!d.contains_key("claude"));

    drop(core);
    let _ = std::fs::remove_dir_all(&base);
}
