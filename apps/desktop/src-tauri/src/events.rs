//! Bridges core events to the webview (`kvistcode://event`) and to the attention
//! engine / tray. `emit` only pushes onto a channel, so it never blocks the core.

use std::sync::Arc;
use std::time::Duration;

use crate::AppHandle;
use kvistcode_core::{DeltaField, EventSink, KvistcodeEvent};
use tauri::{Emitter, Manager};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tracing::warn;

use crate::attention::Attention;

pub const EVENT_CHANNEL: &str = "kvistcode://event";

pub struct TauriSink {
    tx: UnboundedSender<KvistcodeEvent>,
}

impl EventSink for TauriSink {
    fn emit(&self, event: KvistcodeEvent) {
        // Only fails once the dispatcher is gone (app shutting down).
        let _ = self.tx.send(event);
    }
}

pub fn channel() -> (Arc<dyn EventSink>, UnboundedReceiver<KvistcodeEvent>) {
    let (tx, rx) = unbounded_channel();
    (Arc::new(TauriSink { tx }), rx)
}

/// Most events taken per batch, so one busy agent can't starve the rest.
const MAX_BATCH: usize = 512;
/// Pause after forwarding streamed text so the next chunks arrive together: a
/// fast stream becomes ~60 window messages a second instead of hundreds.
const STREAM_PACING: Duration = Duration::from_millis(16);

/// Shrinks a batch without changing what clients end up with:
/// - text deltas for the same field merge when contiguous, even with other agents'
///   events in between (until that item is replaced by a full upsert);
/// - terminal output for the same terminal merges (until it exits);
/// - only the latest `AgentUpdated` per agent is kept (each carries the whole agent).
fn coalesce(batch: Vec<KvistcodeEvent>) -> Vec<KvistcodeEvent> {
    use std::collections::HashMap;

    let mut out: Vec<Option<KvistcodeEvent>> = Vec::with_capacity(batch.len());
    // (agent, item, field) → slot of the last delta for it, and where that delta ends
    // (in UTF-16 units, as offsets are), so a merge doesn't recount the whole delta.
    let mut deltas: HashMap<(String, String, DeltaField), (usize, usize)> = HashMap::new();
    let mut terminals: HashMap<String, usize> = HashMap::new();
    let mut agents: HashMap<String, usize> = HashMap::new();
    for event in batch {
        match event {
            KvistcodeEvent::TextDelta {
                agent_id,
                item_id,
                field,
                delta,
                offset,
            } => {
                let key = (agent_id, item_id, field);
                let end = offset + delta.encode_utf16().count();
                if let Some(&(slot, slot_end)) = deltas.get(&key) {
                    if let Some(KvistcodeEvent::TextDelta { delta: d1, .. }) = &mut out[slot] {
                        if slot_end == offset {
                            d1.push_str(&delta);
                            deltas.insert(key, (slot, end));
                            continue;
                        }
                    }
                }
                deltas.insert(key.clone(), (out.len(), end));
                out.push(Some(KvistcodeEvent::TextDelta {
                    agent_id: key.0,
                    item_id: key.1,
                    field: key.2,
                    delta,
                    offset,
                }));
            }
            KvistcodeEvent::TerminalOutput { terminal_id, data } => {
                if let Some(&slot) = terminals.get(&terminal_id) {
                    if let Some(KvistcodeEvent::TerminalOutput { data: d1, .. }) = &mut out[slot] {
                        d1.push_str(&data);
                        continue;
                    }
                }
                terminals.insert(terminal_id.clone(), out.len());
                out.push(Some(KvistcodeEvent::TerminalOutput { terminal_id, data }));
            }
            KvistcodeEvent::AgentUpdated { agent } => {
                if let Some(slot) = agents.insert(agent.id.clone(), out.len()) {
                    out[slot] = None;
                }
                out.push(Some(KvistcodeEvent::AgentUpdated { agent }));
            }
            other => {
                // Later deltas must not merge across a full replacement or removal.
                match &other {
                    KvistcodeEvent::ItemUpserted { item } => {
                        deltas.retain(|(_, i, _), _| i != &item.id);
                    }
                    KvistcodeEvent::AgentRemoved { agent_id } => {
                        deltas.retain(|(a, _, _), _| a != agent_id);
                        agents.remove(agent_id);
                    }
                    KvistcodeEvent::TerminalExit { terminal_id, .. } => {
                        terminals.remove(terminal_id);
                    }
                    _ => {}
                }
                out.push(Some(other));
            }
        }
    }
    out.into_iter().flatten().collect()
}

pub fn spawn_dispatcher(app: AppHandle, mut rx: UnboundedReceiver<KvistcodeEvent>) {
    tauri::async_runtime::spawn(async move {
        while let Some(first) = rx.recv().await {
            let mut batch = vec![first];
            while batch.len() < MAX_BATCH {
                match rx.try_recv() {
                    Ok(event) => batch.push(event),
                    Err(_) => break,
                }
            }
            let streaming = batch.iter().any(|e| {
                matches!(
                    e,
                    KvistcodeEvent::TextDelta { .. } | KvistcodeEvent::TerminalOutput { .. }
                )
            });
            let batch = coalesce(batch);
            // One window message per cycle (an array), instead of one per event.
            if let Err(e) = app.emit(EVENT_CHANNEL, &batch) {
                warn!("failed to emit events to the window: {e}");
            }
            for event in batch {
                dispatch(&app, event);
            }
            if streaming {
                tokio::time::sleep(STREAM_PACING).await;
            }
        }
    });
}

fn dispatch(app: &AppHandle, event: KvistcodeEvent) {
    {
        {
            if let Some(remote) = app.try_state::<Arc<crate::remote::Remote>>() {
                remote.publish(&event);
            }
            match event {
                // Answered (here, on the phone or elsewhere): drop its notification.
                KvistcodeEvent::ItemUpserted { item } => {
                    if let kvistcode_core::ItemBody::Permission {
                        request_id,
                        resolution: Some(_),
                        ..
                    }
                    | kvistcode_core::ItemBody::Question {
                        request_id,
                        resolution: Some(_),
                        ..
                    } = &item.body
                    {
                        if let Some(att) = app.try_state::<Arc<Attention>>() {
                            att.on_permission_resolved(&item.agent_id, request_id);
                        }
                    }
                }
                KvistcodeEvent::Attention {
                    agent_id,
                    reason,
                    title,
                    body,
                    request_id,
                } => {
                    if let Some(va) = app.try_state::<crate::voice_assistant::VoiceAssistant>() {
                        va.on_attention(&agent_id, reason);
                    }
                    if let Some(att) = app.try_state::<Arc<Attention>>() {
                        let att = att.inner().clone();
                        // Settings reads, notification + HTTP calls: keep them off the dispatcher.
                        tauri::async_runtime::spawn_blocking(move || {
                            att.on_attention(
                                &agent_id,
                                reason,
                                &title,
                                &body,
                                request_id.as_deref(),
                            )
                        });
                    }
                }
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kvistcode_core::DeltaField;

    fn delta(item: &str, text: &str, offset: usize) -> KvistcodeEvent {
        KvistcodeEvent::TextDelta {
            agent_id: "a".into(),
            item_id: item.into(),
            field: DeltaField::Text,
            delta: text.into(),
            offset,
        }
    }

    fn texts(out: &[KvistcodeEvent]) -> Vec<(String, String, usize)> {
        out.iter()
            .filter_map(|e| match e {
                KvistcodeEvent::TextDelta {
                    item_id,
                    delta,
                    offset,
                    ..
                } => Some((item_id.clone(), delta.clone(), *offset)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn merges_contiguous_deltas_across_interleaving() {
        let out = coalesce(vec![
            delta("m", "hé", 0),
            delta("t", "x", 0),
            delta("m", "🎉", 2),
            delta("t", "y", 1),
            delta("m", "!", 4),
            // A gap stays separate so the client notices it and refetches.
            delta("m", "z", 9),
        ]);
        assert_eq!(
            texts(&out),
            vec![
                ("m".into(), "hé🎉!".into(), 0),
                ("t".into(), "xy".into(), 0),
                ("m".into(), "z".into(), 9),
            ]
        );
    }

    #[test]
    fn full_upsert_stops_merging() {
        let item: kvistcode_core::TimelineItem = serde_json::from_value(serde_json::json!({
            "id": "m", "agentId": "a", "seq": 1, "ts": 0,
            "kind": "agent_message", "text": "hé"
        }))
        .unwrap();
        let out = coalesce(vec![
            delta("m", "hé", 0),
            KvistcodeEvent::ItemUpserted { item },
            delta("m", "!", 2),
        ]);
        assert_eq!(
            out.len(),
            3,
            "the delta after the upsert isn't merged before it"
        );
    }
}
