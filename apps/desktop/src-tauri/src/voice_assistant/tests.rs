//! Drives whole sessions against a fake Realtime server on 127.0.0.1 with a null audio
//! device: no network, no sound hardware, no OpenAI.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::mpsc::unbounded_channel;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::Message;

use super::audio::{self, NullAudio};
use super::session::*;
use super::tools;

#[derive(Default)]
struct Events(Mutex<Vec<VaEvent>>);

impl VaSink for Events {
    fn emit(&self, e: VaEvent) {
        self.0.lock().push(e);
    }
}

struct FakeHost;

impl ToolHost for FakeHost {
    fn call(&self, name: String, _arguments: String) -> ToolFuture {
        Box::pin(async move {
            ToolOutcome {
                output: tools::wrap_data(json!({ "tool": name, "agents": [] })),
                action: Some(ActionLog {
                    id: "a1".into(),
                    kind: name,
                    summary: "Listed agents".into(),
                    agent_id: None,
                    ok: true,
                }),
                pending: None,
            }
        })
    }
}

fn config(url: String) -> SessionConfig {
    SessionConfig {
        url,
        api_key: ApiKey("test-key".into()),
        model: "gpt-realtime".into(),
        voice: "marin".into(),
        instructions: "be brief".into(),
        tools: tools::tool_schemas(),
        max_secs: 30,
        silence_secs: 30,
        reconnect_delay: Duration::from_millis(10),
        headphones: false,
        confirm_ttl: Duration::from_secs(30),
    }
}

type Server = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

/// Next JSON message that isn't mic audio.
async fn next_json(ws: &mut Server) -> Value {
    loop {
        match ws.next().await.expect("client closed").expect("ws error") {
            Message::Text(t) => {
                let v: Value = serde_json::from_str(t.as_str()).unwrap();
                if v["type"] != "input_audio_buffer.append" {
                    return v;
                }
            }
            Message::Close(_) => panic!("closed early"),
            _ => {}
        }
    }
}

async fn send(ws: &mut Server, v: Value) {
    ws.send(Message::text(v.to_string())).await.unwrap();
}

#[test]
fn api_key_never_prints() {
    let cfg = config("ws://x".into());
    assert!(!format!("{cfg:?}").contains("test-key"));
}

#[tokio::test(flavor = "multi_thread")]
#[allow(clippy::result_large_err)]
async fn full_tool_call_roundtrip_and_barge_in() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "ws://{}/v1/realtime?model=gpt-realtime",
        listener.local_addr().unwrap()
    );
    let (seen_tx, seen_rx) = tokio::sync::oneshot::channel::<Vec<Value>>();

    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut auth = String::new();
        let mut ws =
            tokio_tungstenite::accept_hdr_async(stream, |req: &Request, resp: Response| {
                auth = req.headers()["authorization"].to_str().unwrap().to_string();
                Ok(resp)
            })
            .await
            .unwrap();
        assert_eq!(auth, "Bearer test-key");
        let mut seen = Vec::new();

        let update = next_json(&mut ws).await;
        assert_eq!(update["type"], "session.update");
        assert_eq!(update["session"]["tools"].as_array().unwrap().len(), 7);
        seen.push(update);
        send(&mut ws, json!({"type":"session.created"})).await;

        // The model asks for list_agents.
        send(&mut ws, json!({"type":"response.created"})).await;
        send(
            &mut ws,
            json!({"type":"response.function_call_arguments.done",
            "call_id":"call_1","name":"list_agents","arguments":"{}"}),
        )
        .await;
        send(
            &mut ws,
            json!({"type":"response.done","response":{"status":"completed"}}),
        )
        .await;

        let out = next_json(&mut ws).await;
        assert_eq!(out["type"], "conversation.item.create");
        assert_eq!(out["item"]["type"], "function_call_output");
        assert_eq!(out["item"]["call_id"], "call_1");
        assert!(out["item"]["output"]
            .as_str()
            .unwrap()
            .contains("list_agents"));
        seen.push(out);
        let create = next_json(&mut ws).await;
        assert_eq!(create["type"], "response.create");
        seen.push(create);

        // It speaks half a second of audio, then the user barges in.
        send(&mut ws, json!({"type":"response.created"})).await;
        let pcm = audio::pcm16_to_base64(&vec![500i16; 12_000]);
        send(
            &mut ws,
            json!({"type":"response.output_audio.delta","item_id":"item_9","delta":pcm}),
        )
        .await;
        send(&mut ws, json!({"type":"response.output_audio_transcript.delta","item_id":"item_9","delta":"Hello"})).await;
        // Let the client take the audio in before interrupting.
        tokio::time::sleep(Duration::from_millis(150)).await;
        send(
            &mut ws,
            json!({"type":"input_audio_buffer.speech_started","audio_start_ms":10,"item_id":"u1"}),
        )
        .await;
        let cancel = next_json(&mut ws).await;
        assert_eq!(cancel["type"], "response.cancel");
        let trunc = next_json(&mut ws).await;
        assert_eq!(trunc["type"], "conversation.item.truncate");
        assert_eq!(trunc["item_id"], "item_9");
        // Nothing was actually played on the null device.
        assert_eq!(trunc["audio_end_ms"], 0);
        seen.push(trunc);
        send(
            &mut ws,
            json!({"type":"response.done","response":{"status":"cancelled",
            "usage":{"input_token_details":{"audio_tokens":100,"text_tokens":10},
                     "output_token_details":{"audio_tokens":50,"text_tokens":5}}}}),
        )
        .await;
        // Late audio for the cancelled item is ignored.
        send(
            &mut ws,
            json!({"type":"response.output_audio.delta","item_id":"item_9","delta":"AAAA"}),
        )
        .await;
        send(
            &mut ws,
            json!({"type":"conversation.item.input_audio_transcription.completed",
            "item_id":"u1","transcript":"never mind"}),
        )
        .await;
        // Wait for the client to hang up.
        while let Some(Ok(m)) = ws.next().await {
            if matches!(m, Message::Close(_)) {
                break;
            }
        }
        let _ = seen_tx.send(seen);
    });

    let sink = Arc::new(Events::default());
    let (ctl_tx, ctl_rx) = unbounded_channel();
    let devices = NullAudio::new();
    let speaker = devices.speaker.clone();
    let events = sink.clone();
    let stopper = tokio::spawn(async move {
        // Stop once the transcript of the user's last words has been captioned.
        for _ in 0..200 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            if events.0.lock().iter().any(|e| {
                matches!(
                    e,
                    VaEvent::Caption {
                        role: "user",
                        done: true,
                        ..
                    }
                )
            }) {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        let _ = ctl_tx.send(Control::Stop);
    });
    let end = tokio::time::timeout(
        Duration::from_secs(20),
        run(
            config(url),
            sink.clone(),
            Arc::new(FakeHost),
            Box::new(devices),
            ctl_rx,
        ),
    )
    .await
    .expect("session hung");
    stopper.await.unwrap();
    assert_eq!(end.reason, EndReason::UserStopped);
    // 100 audio-in + 50 audio-out + text were counted.
    assert!(end.usage.cost_usd() > 0.0);
    server.await.unwrap();
    assert_eq!(seen_rx.await.unwrap().len(), 4);

    let events = sink.0.lock();
    assert!(events
        .iter()
        .any(|e| matches!(e, VaEvent::Action(a) if a.summary == "Listed agents")));
    assert!(events.iter().any(|e| matches!(
        e,
        VaEvent::State {
            state: VaState::Speaking,
            ..
        }
    )));
    assert!(events
        .iter()
        .any(|e| matches!(e, VaEvent::Caption { role: "assistant", text, .. } if text == "Hello")));
    assert!(events
        .iter()
        .any(|e| matches!(e, VaEvent::Caption { role: "user", text, .. } if text == "never mind")));
    // Barge-in dropped the queued audio.
    assert_eq!(speaker.queued(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn reconnects_once_after_a_drop() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        // First connection: accept, then hang up.
        let (s, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
        assert_eq!(next_json(&mut ws).await["type"], "session.update");
        drop(ws);
        // Second: configured again.
        let (s, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
        assert_eq!(next_json(&mut ws).await["type"], "session.update");
        send(&mut ws, json!({"type":"session.updated"})).await;
        while let Some(Ok(m)) = ws.next().await {
            if matches!(m, Message::Close(_)) {
                break;
            }
        }
    });
    let sink = Arc::new(Events::default());
    let (ctl_tx, ctl_rx) = unbounded_channel();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(800)).await;
        let _ = ctl_tx.send(Control::Stop);
    });
    let end = tokio::time::timeout(
        Duration::from_secs(20),
        run(
            config(url),
            sink.clone(),
            Arc::new(FakeHost),
            Box::new(NullAudio::new()),
            ctl_rx,
        ),
    )
    .await
    .unwrap();
    assert_eq!(end.reason, EndReason::UserStopped);
    server.await.unwrap();
    assert!(sink
        .0
        .lock()
        .iter()
        .any(|e| matches!(e, VaEvent::State { message: Some(m), .. } if m == "Reconnecting")));
    assert!(sink.0.lock().iter().any(
        |e| matches!(e, VaEvent::Notice { message: Some(m) } if m.starts_with("Reconnected"))
    ));
}

#[test]
fn a_stable_connection_earns_a_fresh_reconnect_attempt() {
    assert_eq!(attempts_after_drop(1, Duration::from_secs(5)), 1);
    assert_eq!(attempts_after_drop(1, Duration::from_secs(30)), 0);
    assert_eq!(attempts_after_drop(0, Duration::from_secs(1)), 0);
}

/// start_agent comes back as a pending action; everything else runs directly.
struct GateHost {
    ran: Arc<AtomicUsize>,
}

impl ToolHost for GateHost {
    fn call(&self, name: String, _arguments: String) -> ToolFuture {
        let ran = self.ran.clone();
        Box::pin(async move {
            ToolOutcome {
                output: String::new(),
                action: None,
                pending: Some(PendingAction {
                    kind: name,
                    summary: "Start Claude agent in storefront: fix it".into(),
                    run: Box::pin(async move {
                        ran.fetch_add(1, Ordering::SeqCst);
                        ToolOutcome {
                            output: tools::wrap_data(json!({ "started": true })),
                            action: None,
                            pending: None,
                        }
                    }),
                }),
            }
        })
    }
}

fn confirm_ids(events: &Events) -> Vec<String> {
    events
        .0
        .lock()
        .iter()
        .filter_map(|e| match e {
            VaEvent::ConfirmAction { id, .. } => Some(id.clone()),
            _ => None,
        })
        .collect()
}

async fn wait_for(mut cond: impl FnMut() -> bool) {
    for _ in 0..200 {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("condition never became true");
}

/// Runs one session with `host`, a scripted server and `driver`, which gets the events
/// and the control channel and returns when the session should stop.
async fn gated_session<S, SF, D, DF>(
    ttl: Duration,
    ran: Arc<AtomicUsize>,
    script: S,
    driver: D,
) -> Arc<Events>
where
    S: FnOnce(Server) -> SF + Send + 'static,
    SF: std::future::Future<Output = ()> + Send + 'static,
    D: FnOnce(Arc<Events>, tokio::sync::mpsc::UnboundedSender<Control>) -> DF + Send + 'static,
    DF: std::future::Future<Output = ()> + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut cfg = config(format!("ws://{}/", listener.local_addr().unwrap()));
    cfg.confirm_ttl = ttl;
    let server = tokio::spawn(async move {
        let (s, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
        assert_eq!(next_json(&mut ws).await["type"], "session.update");
        send(&mut ws, json!({"type":"session.created"})).await;
        script(ws).await;
    });
    let sink = Arc::new(Events::default());
    let (ctl_tx, ctl_rx) = unbounded_channel();
    let (events, tx) = (sink.clone(), ctl_tx.clone());
    let drv = tokio::spawn(async move {
        driver(events, tx).await;
        let _ = ctl_tx.send(Control::Stop);
    });
    let end = tokio::time::timeout(
        Duration::from_secs(20),
        run(
            cfg,
            sink.clone(),
            Arc::new(GateHost { ran }),
            Box::new(NullAudio::new()),
            ctl_rx,
        ),
    )
    .await
    .expect("session hung");
    assert_eq!(end.reason, EndReason::UserStopped);
    drv.await.unwrap();
    server.await.unwrap();
    sink
}

async fn call_start_agent(ws: &mut Server, call_id: &str) {
    send(
        ws,
        json!({"type":"response.function_call_arguments.done",
        "call_id":call_id,"name":"start_agent","arguments":"{}"}),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn side_effects_run_only_after_the_user_confirms() {
    let ran = Arc::new(AtomicUsize::new(0));
    let ran2 = ran.clone();
    let ran3 = ran.clone();
    let sink = gated_session(
        Duration::from_secs(30),
        ran.clone(),
        move |mut ws| async move {
            send(&mut ws, json!({"type":"response.created"})).await;
            call_start_agent(&mut ws, "call_1").await;
            send(
                &mut ws,
                json!({"type":"response.done","response":{"status":"completed"}}),
            )
            .await;
            let out = next_json(&mut ws).await;
            assert_eq!(out["item"]["call_id"], "call_1");
            assert!(out["item"]["output"]
                .as_str()
                .unwrap()
                .contains("Waiting for the user to confirm on screen"));
            assert_eq!(next_json(&mut ws).await["type"], "response.create");
            // Nothing ran yet; the model's answer finishes, then the user confirms.
            assert_eq!(ran2.load(Ordering::SeqCst), 0);
            send(&mut ws, json!({"type":"response.created"})).await;
            send(
                &mut ws,
                json!({"type":"response.done","response":{"status":"completed"}}),
            )
            .await;
            let note = next_json(&mut ws).await;
            assert_eq!(note["item"]["role"], "system");
            assert!(note["item"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("confirmed"));
            assert!(note["item"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("started"));
            assert_eq!(next_json(&mut ws).await["type"], "response.create");
            while let Some(Ok(m)) = ws.next().await {
                if matches!(m, Message::Close(_)) {
                    break;
                }
            }
        },
        move |events, ctl| async move {
            wait_for(|| !confirm_ids(&events).is_empty()).await;
            tokio::time::sleep(Duration::from_millis(200)).await;
            assert_eq!(ran3.load(Ordering::SeqCst), 0);
            let id = confirm_ids(&events).remove(0);
            ctl.send(Control::Confirm {
                id: id.clone(),
                accept: true,
            })
            .unwrap();
            // A second answer for the same card does nothing.
            ctl.send(Control::Confirm { id, accept: true }).unwrap();
            wait_for(|| ran3.load(Ordering::SeqCst) == 1).await;
            tokio::time::sleep(Duration::from_millis(300)).await;
        },
    )
    .await;
    assert_eq!(ran.load(Ordering::SeqCst), 1);
    assert!(sink.0.lock().iter().any(|e| matches!(
        e,
        VaEvent::ConfirmDone {
            status: "confirmed",
            ..
        }
    )));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_declined_action_never_runs() {
    let ran = Arc::new(AtomicUsize::new(0));
    gated_session(
        Duration::from_secs(30),
        ran.clone(),
        move |mut ws| async move {
            send(&mut ws, json!({"type":"response.created"})).await;
            call_start_agent(&mut ws, "call_1").await;
            send(
                &mut ws,
                json!({"type":"response.done","response":{"status":"completed"}}),
            )
            .await;
            let _ = next_json(&mut ws).await;
            let _ = next_json(&mut ws).await;
            send(&mut ws, json!({"type":"response.created"})).await;
            send(
                &mut ws,
                json!({"type":"response.done","response":{"status":"completed"}}),
            )
            .await;
            let note = next_json(&mut ws).await;
            assert!(note["item"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("declined"));
            while let Some(Ok(m)) = ws.next().await {
                if matches!(m, Message::Close(_)) {
                    break;
                }
            }
        },
        move |events, ctl| async move {
            wait_for(|| !confirm_ids(&events).is_empty()).await;
            tokio::time::sleep(Duration::from_millis(100)).await;
            let id = confirm_ids(&events).remove(0);
            ctl.send(Control::Confirm { id, accept: false }).unwrap();
            tokio::time::sleep(Duration::from_millis(400)).await;
        },
    )
    .await;
    assert_eq!(ran.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn unanswered_confirmations_expire() {
    let ran = Arc::new(AtomicUsize::new(0));
    let sink = gated_session(
        Duration::from_millis(250),
        ran.clone(),
        move |mut ws| async move {
            send(&mut ws, json!({"type":"response.created"})).await;
            call_start_agent(&mut ws, "call_1").await;
            send(
                &mut ws,
                json!({"type":"response.done","response":{"status":"completed"}}),
            )
            .await;
            let _ = next_json(&mut ws).await;
            let _ = next_json(&mut ws).await;
            send(&mut ws, json!({"type":"response.created"})).await;
            send(
                &mut ws,
                json!({"type":"response.done","response":{"status":"completed"}}),
            )
            .await;
            let note = next_json(&mut ws).await;
            assert!(note["item"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("did not confirm in time"));
            while let Some(Ok(m)) = ws.next().await {
                if matches!(m, Message::Close(_)) {
                    break;
                }
            }
        },
        move |events, _ctl| async move {
            wait_for(|| {
                events.0.lock().iter().any(|e| {
                    matches!(
                        e,
                        VaEvent::ConfirmDone {
                            status: "expired",
                            ..
                        }
                    )
                })
            })
            .await;
            tokio::time::sleep(Duration::from_millis(300)).await;
        },
    )
    .await;
    assert_eq!(ran.load(Ordering::SeqCst), 0);
    drop(sink);
}

#[tokio::test(flavor = "multi_thread")]
async fn at_most_three_proposals_per_user_turn() {
    let ran = Arc::new(AtomicUsize::new(0));
    let sink = gated_session(
        Duration::from_secs(30),
        ran,
        move |mut ws| async move {
            send(&mut ws, json!({"type":"response.created"})).await;
            for i in 1..=4 {
                call_start_agent(&mut ws, &format!("call_{i}")).await;
            }
            send(
                &mut ws,
                json!({"type":"response.done","response":{"status":"completed"}}),
            )
            .await;
            let mut waiting = 0;
            let mut refused = 0;
            for _ in 0..4 {
                let out = next_json(&mut ws).await;
                let text = out["item"]["output"].as_str().unwrap().to_string();
                if text.contains("waiting_for_user") {
                    waiting += 1;
                } else if text.contains("Too many actions") {
                    refused += 1;
                }
            }
            assert_eq!((waiting, refused), (3, 1));
            while let Some(Ok(m)) = ws.next().await {
                if matches!(m, Message::Close(_)) {
                    break;
                }
            }
        },
        move |events, _ctl| async move {
            wait_for(|| confirm_ids(&events).len() == 3).await;
            tokio::time::sleep(Duration::from_millis(400)).await;
        },
    )
    .await;
    assert_eq!(confirm_ids(&sink).len(), 3);
}

/// How many mic chunks reach the server while the assistant's audio is playing.
async fn appends_while_assistant_speaks(headphones: bool) -> usize {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut cfg = config(format!("ws://{}/", listener.local_addr().unwrap()));
    cfg.headphones = headphones;
    let server = tokio::spawn(async move {
        let (s, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
        let mut appends = 0;
        let mut sent_audio = false;
        while let Some(Ok(m)) = ws.next().await {
            match m {
                Message::Text(t) => {
                    let v: Value = serde_json::from_str(t.as_str()).unwrap();
                    if v["type"] == "session.update" && !sent_audio {
                        sent_audio = true;
                        send(&mut ws, json!({"type":"session.created"})).await;
                        let pcm = audio::pcm16_to_base64(&vec![500i16; 12_000]);
                        send(&mut ws, json!({"type":"response.output_audio.delta","item_id":"i1","delta":pcm})).await;
                    }
                    if v["type"] == "input_audio_buffer.append" {
                        appends += 1;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        appends
    });
    let devices = NullAudio::new();
    let mic = devices.mic_tx.clone();
    let (ctl_tx, ctl_rx) = unbounded_channel();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        for _ in 0..3 {
            let _ = mic.send(vec![100i16; audio::CHUNK_SAMPLES]);
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        let _ = ctl_tx.send(Control::Stop);
    });
    let end = tokio::time::timeout(
        Duration::from_secs(20),
        run(
            cfg,
            Arc::new(Events::default()),
            Arc::new(FakeHost),
            Box::new(devices),
            ctl_rx,
        ),
    )
    .await
    .unwrap();
    assert_eq!(end.reason, EndReason::UserStopped);
    server.await.unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_mic_is_closed_while_the_assistant_speaks_unless_headphones() {
    // At most the one chunk sent at open, before any audio arrived.
    assert!(appends_while_assistant_speaks(false).await <= 1);
    assert!(appends_while_assistant_speaks(true).await >= 4);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_transient_error_keeps_the_session_live() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/", listener.local_addr().unwrap());
    tokio::spawn(async move {
        let (s, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
        let _ = next_json(&mut ws).await;
        send(&mut ws, json!({"type":"session.created"})).await;
        send(&mut ws, json!({"type":"error","error":{"type":"server_error","code":"server_error","message":"hiccup"}})).await;
        while let Some(Ok(m)) = ws.next().await {
            if matches!(m, Message::Close(_)) {
                break;
            }
        }
    });
    let sink = Arc::new(Events::default());
    let (ctl_tx, ctl_rx) = unbounded_channel();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        let _ = ctl_tx.send(Control::Stop);
    });
    run(
        config(url),
        sink.clone(),
        Arc::new(FakeHost),
        Box::new(NullAudio::new()),
        ctl_rx,
    )
    .await;
    let ev = sink.0.lock();
    assert!(ev
        .iter()
        .any(|e| matches!(e, VaEvent::Notice { message: Some(m) } if m == "hiccup")));
    assert!(!ev.iter().any(|e| matches!(
        e,
        VaEvent::State {
            state: VaState::Error,
            ..
        }
    )));
}

#[tokio::test(flavor = "multi_thread")]
async fn fatal_api_error_ends_the_session_with_a_clear_message() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/", listener.local_addr().unwrap());
    tokio::spawn(async move {
        let (s, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
        let _ = next_json(&mut ws).await;
        send(&mut ws, json!({"type":"error","error":{"type":"invalid_request_error","code":"invalid_api_key","message":"Incorrect API key sk-xyz"}})).await;
        tokio::time::sleep(Duration::from_secs(2)).await;
    });
    let (_ctl_tx, ctl_rx) = unbounded_channel();
    let end = tokio::time::timeout(
        Duration::from_secs(20),
        run(
            config(url),
            Arc::new(Events::default()),
            Arc::new(FakeHost),
            Box::new(NullAudio::new()),
            ctl_rx,
        ),
    )
    .await
    .unwrap();
    match end.reason {
        EndReason::Error(m) => {
            assert!(m.contains("rejected the API key"));
            assert!(!m.contains("sk-xyz"));
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn unreachable_server_reports_a_network_error() {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/", l.local_addr().unwrap());
    drop(l);
    let (_t, ctl_rx) = unbounded_channel();
    let end = run(
        config(url),
        Arc::new(Events::default()),
        Arc::new(FakeHost),
        Box::new(NullAudio::new()),
        ctl_rx,
    )
    .await;
    assert!(matches!(end.reason, EndReason::Error(m) if m.contains("Couldn't reach OpenAI")));
}
