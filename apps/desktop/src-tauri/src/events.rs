//! Bridges core events to the webview (`armada://event`) and to the attention
//! engine / tray. `emit` only pushes onto a channel, so it never blocks the core.

use std::sync::Arc;
use std::time::Duration;

use armada_core::{ArmadaEvent, DeltaField, EventSink};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tracing::warn;

use crate::attention::Attention;
use crate::tray;

pub const EVENT_CHANNEL: &str = "armada://event";

pub struct TauriSink {
    tx: UnboundedSender<ArmadaEvent>,
}

impl EventSink for TauriSink {
    fn emit(&self, event: ArmadaEvent) {
        // Only fails once the dispatcher is gone (app shutting down).
        let _ = self.tx.send(event);
    }
}

pub fn channel() -> (Arc<dyn EventSink>, UnboundedReceiver<ArmadaEvent>) {
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
fn coalesce(batch: Vec<ArmadaEvent>) -> Vec<ArmadaEvent> {
    use std::collections::HashMap;

    let mut out: Vec<Option<ArmadaEvent>> = Vec::with_capacity(batch.len());
    // (agent, item, field) → slot of the last delta for it.
    let mut deltas: HashMap<(String, String, DeltaField), usize> = HashMap::new();
    let mut terminals: HashMap<String, usize> = HashMap::new();
    let mut agents: HashMap<String, usize> = HashMap::new();
    for event in batch {
        match event {
            ArmadaEvent::TextDelta {
                agent_id,
                item_id,
                field,
                delta,
                offset,
            } => {
                let key = (agent_id, item_id, field);
                if let Some(&slot) = deltas.get(&key) {
                    if let Some(ArmadaEvent::TextDelta {
                        delta: d1,
                        offset: o1,
                        ..
                    }) = &mut out[slot]
                    {
                        if *o1 + d1.encode_utf16().count() == offset {
                            d1.push_str(&delta);
                            continue;
                        }
                    }
                }
                deltas.insert(key.clone(), out.len());
                out.push(Some(ArmadaEvent::TextDelta {
                    agent_id: key.0,
                    item_id: key.1,
                    field: key.2,
                    delta,
                    offset,
                }));
            }
            ArmadaEvent::TerminalOutput { terminal_id, data } => {
                if let Some(&slot) = terminals.get(&terminal_id) {
                    if let Some(ArmadaEvent::TerminalOutput { data: d1, .. }) = &mut out[slot] {
                        d1.push_str(&data);
                        continue;
                    }
                }
                terminals.insert(terminal_id.clone(), out.len());
                out.push(Some(ArmadaEvent::TerminalOutput { terminal_id, data }));
            }
            ArmadaEvent::AgentUpdated { agent } => {
                if let Some(slot) = agents.insert(agent.id.clone(), out.len()) {
                    out[slot] = None;
                }
                out.push(Some(ArmadaEvent::AgentUpdated { agent }));
            }
            other => {
                // Later deltas must not merge across a full replacement or removal.
                match &other {
                    ArmadaEvent::ItemUpserted { item } => {
                        deltas.retain(|(_, i, _), _| i != &item.id);
                    }
                    ArmadaEvent::AgentRemoved { agent_id } => {
                        deltas.retain(|(a, _, _), _| a != agent_id);
                        agents.remove(agent_id);
                    }
                    ArmadaEvent::TerminalExit { terminal_id, .. } => {
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

pub fn spawn_dispatcher(app: AppHandle, mut rx: UnboundedReceiver<ArmadaEvent>) {
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
                    ArmadaEvent::TextDelta { .. } | ArmadaEvent::TerminalOutput { .. }
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

fn dispatch(app: &AppHandle, event: ArmadaEvent) {
    {
        {
            if let Some(remote) = app.try_state::<Arc<crate::remote::Remote>>() {
                remote.publish(&event);
            }
            match event {
                ArmadaEvent::AgentUpdated { .. } | ArmadaEvent::AgentRemoved { .. } => {
                    tray::mark_dirty(app);
                }
                // Answered (here, on the phone or elsewhere): drop its notification.
                ArmadaEvent::ItemUpserted { item } => {
                    if let armada_core::ItemBody::Permission {
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
                ArmadaEvent::Attention {
                    agent_id,
                    reason,
                    title,
                    body,
                    request_id,
                } => {
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
    use armada_core::DeltaField;

    fn delta(item: &str, text: &str, offset: usize) -> ArmadaEvent {
        ArmadaEvent::TextDelta {
            agent_id: "a".into(),
            item_id: item.into(),
            field: DeltaField::Text,
            delta: text.into(),
            offset,
        }
    }

    fn texts(out: &[ArmadaEvent]) -> Vec<(String, String, usize)> {
        out.iter()
            .filter_map(|e| match e {
                ArmadaEvent::TextDelta {
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
        let item: armada_core::TimelineItem = serde_json::from_value(serde_json::json!({
            "id": "m", "agentId": "a", "seq": 1, "ts": 0,
            "kind": "agent_message", "text": "hé"
        }))
        .unwrap();
        let out = coalesce(vec![
            delta("m", "hé", 0),
            ArmadaEvent::ItemUpserted { item },
            delta("m", "!", 2),
        ]);
        assert_eq!(
            out.len(),
            3,
            "the delta after the upsert isn't merged before it"
        );
    }
}
