//! Bridges core events to the webview (`armada://event`) and to the attention
//! engine / tray. `emit` only pushes onto a channel, so it never blocks the core.

use std::sync::Arc;

use armada_core::{ArmadaEvent, EventSink};
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

pub fn spawn_dispatcher(app: AppHandle, mut rx: UnboundedReceiver<ArmadaEvent>) {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            if let Some(remote) = app.try_state::<Arc<crate::remote::Remote>>() {
                remote.publish(&event);
            }
            if let Err(e) = app.emit(EVENT_CHANNEL, &event) {
                warn!("failed to emit event to the window: {e}");
            }
            match event {
                ArmadaEvent::AgentUpdated { .. } | ArmadaEvent::AgentRemoved { .. } => {
                    tray::mark_dirty(&app);
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
    });
}
