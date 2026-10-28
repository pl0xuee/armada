//! Drives whole sessions against a fake Realtime server on 127.0.0.1 with a null audio
//! device: no network, no sound hardware, no OpenAI.

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
    let mut devices = NullAudio::new();
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
            &mut devices,
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
            &mut NullAudio::new(),
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
            &mut NullAudio::new(),
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
        &mut NullAudio::new(),
        ctl_rx,
    )
    .await;
    assert!(matches!(end.reason, EndReason::Error(m) if m.contains("Couldn't reach OpenAI")));
}
