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
        auto_confirm: false,
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
        assert_eq!(update["session"]["tools"].as_array().unwrap().len(), 14);
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
    gated_session_with(false, ttl, ran, script, driver).await
}

async fn gated_session_with<S, SF, D, DF>(
    auto_confirm: bool,
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
    cfg.auto_confirm = auto_confirm;
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
async fn with_confirmations_off_the_action_runs_at_once_with_no_card() {
    let ran = Arc::new(AtomicUsize::new(0));
    let sink = gated_session_with(
        true,
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
            let text = out["item"]["output"].as_str().unwrap();
            assert!(
                text.contains("running") && !text.contains("waiting_for_user"),
                "{text}"
            );
            let _ = next_json(&mut ws).await; // response.create
            send(&mut ws, json!({"type":"response.created"})).await;
            send(
                &mut ws,
                json!({"type":"response.done","response":{"status":"completed"}}),
            )
            .await;
            let note = next_json(&mut ws).await;
            let t = note["item"]["content"][0]["text"].as_str().unwrap();
            assert!(t.contains("without asking") && t.contains("started"), "{t}");
            while let Some(Ok(m)) = ws.next().await {
                if matches!(m, Message::Close(_)) {
                    break;
                }
            }
        },
        move |_events, _ctl| async move {
            tokio::time::sleep(Duration::from_millis(600)).await;
        },
    )
    .await;
    assert_eq!(ran.load(Ordering::SeqCst), 1);
    assert!(
        confirm_ids(&sink).is_empty(),
        "no confirmation card is shown"
    );
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

/// What a pause-and-resume run observed.
struct PauseRun {
    events: Arc<Events>,
    /// Mic chunks that reached the server after the pause was requested.
    appends_after_pause: usize,
    saw_response_create: bool,
    /// The mic channel refused chunks while paused (nobody was reading it).
    mic_closed_while_paused: bool,
    opens: usize,
    confirms: usize,
    host_ran: usize,
}

/// One session that is paused (by the model's tool or by the UI), stays quiet for a
/// while, is resumed, and streams again on a fresh connection.
async fn pause_and_resume(by_tool: bool) -> PauseRun {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/", listener.local_addr().unwrap());
    let devices = NullAudio::new();
    let (live, opens, releases) = (
        devices.live_mic.clone(),
        devices.opens.clone(),
        devices.releases.clone(),
    );
    // Set once a pause was requested; mic chunks that arrive after it are a leak.
    let gate = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel::<()>();
    let (audio_tx, audio_rx) = tokio::sync::oneshot::channel::<()>();

    let server_gate = gate.clone();
    let server = tokio::spawn(async move {
        let (s, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
        let update = next_json(&mut ws).await;
        assert_eq!(update["type"], "session.update");
        send(&mut ws, json!({"type":"session.created"})).await;
        if by_tool {
            send(&mut ws, json!({"type":"response.created"})).await;
            send(
                &mut ws,
                json!({"type":"response.function_call_arguments.done",
                "call_id":"call_p","name":tools::PAUSE_TOOL,"arguments":"{}"}),
            )
            .await;
            send(
                &mut ws,
                json!({"type":"response.done","response":{"status":"completed"}}),
            )
            .await;
        }
        let (mut late, mut response_create) = (0usize, false);
        while let Some(Ok(m)) = ws.next().await {
            match m {
                Message::Text(t) => {
                    let v: Value = serde_json::from_str(t.as_str()).unwrap();
                    match v["type"].as_str().unwrap_or_default() {
                        "conversation.item.create" => {
                            assert_eq!(v["item"]["call_id"], "call_p");
                            server_gate.store(true, Ordering::SeqCst);
                        }
                        "input_audio_buffer.append" if server_gate.load(Ordering::SeqCst) => {
                            late += 1
                        }
                        "response.create" => response_create = true,
                        _ => {}
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        let _ = closed_tx.send(());
        // Paused means no connection at all, not an idle one.
        let waited = tokio::time::timeout(Duration::from_millis(400), listener.accept()).await;
        assert!(waited.is_err(), "reconnected while paused");
        let (s, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
        assert_eq!(next_json(&mut ws).await["type"], "session.update");
        send(&mut ws, json!({"type":"session.updated"})).await;
        let mut audio_tx = Some(audio_tx);
        while let Some(Ok(m)) = ws.next().await {
            match m {
                Message::Text(t) if t.as_str().contains("input_audio_buffer.append") => {
                    if let Some(tx) = audio_tx.take() {
                        let _ = tx.send(());
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        (late, response_create)
    });

    let sink = Arc::new(Events::default());
    let ran = Arc::new(AtomicUsize::new(0));
    let (ctl_tx, ctl_rx) = unbounded_channel();
    let (events, driver_gate) = (sink.clone(), gate.clone());
    let driver = tokio::spawn(async move {
        let has_state = |s: VaState| {
            let events = events.clone();
            move || {
                events
                    .0
                    .lock()
                    .iter()
                    .any(|e| matches!(e, VaEvent::State { state, .. } if *state == s))
            }
        };
        wait_for(has_state(VaState::Listening)).await;
        if !by_tool {
            ctl_tx.send(Control::Pause).unwrap();
            driver_gate.store(true, Ordering::SeqCst);
        }
        wait_for(|| driver_gate.load(Ordering::SeqCst)).await;
        for _ in 0..5 {
            let _ = live.lock().send(vec![100i16; audio::CHUNK_SAMPLES]);
        }
        wait_for(has_state(VaState::Paused)).await;
        closed_rx.await.unwrap();
        wait_for(|| releases.load(Ordering::SeqCst) == 1).await;
        let mic_closed = live
            .lock()
            .send(vec![100i16; audio::CHUNK_SAMPLES])
            .is_err();
        tokio::time::sleep(Duration::from_millis(700)).await;
        ctl_tx.send(Control::Resume).unwrap();
        audio_rx.await.unwrap();
        // Audio can reach the server before the session handles `session.updated`; stop only
        // once the "Listening again" notice is out, or the assertions below race it.
        wait_for(|| {
            events.0.lock().iter().any(
                |e| matches!(e, VaEvent::Notice { message: Some(m) } if m.starts_with("Listening again")),
            )
        })
        .await;
        let _ = ctl_tx.send(Control::Stop);
        mic_closed
    });

    let end = tokio::time::timeout(
        Duration::from_secs(20),
        run(
            config(url),
            sink.clone(),
            Arc::new(GateHost { ran: ran.clone() }),
            Box::new(devices),
            ctl_rx,
        ),
    )
    .await
    .expect("session hung");
    assert_eq!(end.reason, EndReason::UserStopped);
    let mic_closed_while_paused = driver.await.unwrap();
    let (appends_after_pause, saw_response_create) = server.await.unwrap();
    PauseRun {
        appends_after_pause,
        saw_response_create,
        mic_closed_while_paused,
        opens: opens.load(Ordering::SeqCst),
        confirms: confirm_ids(&sink).len(),
        host_ran: ran.load(Ordering::SeqCst),
        events: sink,
    }
}

fn assert_paused_then_resumed(r: &PauseRun) {
    // No mic audio left the machine after the pause, and the microphone was released.
    assert_eq!(r.appends_after_pause, 0);
    assert!(r.mic_closed_while_paused);
    // Devices were opened once at the start and once on resume.
    assert_eq!(r.opens, 2);
    let ev = r.events.0.lock();
    let paused = ev
        .iter()
        .position(|e| {
            matches!(
                e,
                VaEvent::State {
                    state: VaState::Paused,
                    ..
                }
            )
        })
        .expect("paused state");
    // Resuming reconnects and says that the earlier conversation is gone.
    assert!(ev[paused..].iter().any(
        |e| matches!(e, VaEvent::Notice { message: Some(m) } if m.starts_with("Listening again"))
    ));
    // A pause is not the end of the session.
    assert!(!ev.iter().any(|e| matches!(e, VaEvent::Ended { .. })));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_pause_tool_needs_no_confirmation_and_stops_all_mic_audio() {
    let r = pause_and_resume(true).await;
    assert_paused_then_resumed(&r);
    // Not routed through the host, so never a confirmation card, and no extra reply.
    assert_eq!(r.confirms, 0);
    assert_eq!(r.host_ran, 0);
    assert!(!r.saw_response_create);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_mute_button_pauses_the_same_way() {
    let r = pause_and_resume(false).await;
    assert_paused_then_resumed(&r);
}

#[test]
fn the_pause_tool_is_described_for_every_phrase() {
    let schemas = tools::tool_schemas();
    let t = schemas
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == tools::PAUSE_TOOL)
        .expect("pause tool");
    let d = t["description"].as_str().unwrap();
    let instructions = tools::instructions();
    for phrase in ["mute", "pause listening", "stop listening", "go to sleep"] {
        assert!(d.contains(phrase), "{phrase}");
        assert!(instructions.contains(phrase), "{phrase}");
    }
    assert!(d.contains("No confirmation"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_screen_change_reaches_the_model_silently() {
    let ran = Arc::new(AtomicUsize::new(0));
    gated_session(
        Duration::from_secs(30),
        ran,
        move |mut ws| async move {
            let note = next_json(&mut ws).await;
            assert_eq!(note["type"], "conversation.item.create");
            assert_eq!(note["item"]["role"], "system");
            let text = note["item"]["content"][0]["text"].as_str().unwrap();
            assert!(text.contains("switched to Usage"), "{text}");
            // Context only: no reply is requested, so nothing is said aloud.
            let more = tokio::time::timeout(Duration::from_millis(500), ws.next()).await;
            assert!(more.is_err(), "the model was asked to answer");
            // Stay connected until the session is stopped.
            while let Some(Ok(m)) = ws.next().await {
                if matches!(m, Message::Close(_)) {
                    break;
                }
            }
        },
        |events, ctl| async move {
            wait_for(|| {
                events.0.lock().iter().any(|e| {
                    matches!(
                        e,
                        VaEvent::State {
                            state: VaState::Listening,
                            ..
                        }
                    )
                })
            })
            .await;
            ctl.send(Control::Screen(
                "Kvistcode: the user just switched to Usage.".into(),
            ))
            .unwrap();
            tokio::time::sleep(Duration::from_millis(900)).await;
        },
    )
    .await;
}

/// Every tool argument that names an agent or a project says it takes a number, so the
/// model passes "2" for "agent 2" instead of guessing a title.
#[test]
fn every_agent_and_project_argument_takes_a_number() {
    let schemas = tools::tool_schemas();
    let mut seen = 0;
    for t in schemas.as_array().unwrap() {
        let name = t["name"].as_str().unwrap();
        for (arg, spec) in t["parameters"]["properties"]
            .as_object()
            .into_iter()
            .flatten()
        {
            let d = spec["description"]
                .as_str()
                .unwrap_or_default()
                .to_lowercase();
            if arg == "agent" || arg == "project" {
                seen += 1;
                assert!(d.contains("number"), "{name}.{arg}: {d}");
            }
        }
    }
    // get_agent, start_agent, send_message, stop_agent, rename_agent, mark_done,
    // request_approval_review, and open's agent and project.
    assert_eq!(seen, 9);
    // The lists carry the numbers the arguments take.
    let d = |name: &str| {
        schemas
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == name)
            .unwrap()["description"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert!(d("list_agents").contains("number") && d("list_projects").contains("number"));
    assert!(d("get_screen").contains("number"));
}

#[test]
fn the_default_language_is_added_to_the_assistants_instructions_only_when_set() {
    let base = tools::instructions();
    assert_eq!(super::with_language(base.clone(), ""), base);
    let note = kvistcode_core::guidance::language_note("Spanish");
    let with = super::with_language(base.clone(), &note);
    assert!(with.starts_with(&base) && with.contains("in Spanish"));
}
