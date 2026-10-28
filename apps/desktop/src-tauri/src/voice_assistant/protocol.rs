//! The OpenAI Realtime API wire format (GA interface). Every event name and JSON
//! shape the voice assistant depends on lives in this one file.
//!
//! VERIFICATION STATUS (checked against developers.openai.com on 2026-10-28):
//!   confirmed from the docs: `error` (`error.{type,code,message,param,event_id}`),
//!   `session.created/updated`, `input_audio_buffer.speech_started`
//!   (`audio_start_ms`, `item_id`), `conversation.item.input_audio_transcription.delta`
//!   (`item_id`, `delta`) and `.completed` (`item_id`, `transcript`), and the
//!   `response.done` usage fields (`input_tokens`, `output_tokens`,
//!   `input_token_details.{audio_tokens,text_tokens,cached_tokens}`,
//!   `output_token_details.{audio_tokens,text_tokens}`).
//!   NOT re-verified here (written from the GA reference as best known; confirm
//!   against a real session before release): the `session.update` payload shape
//!   (`session.type = "realtime"`, `audio.input.format = {type:"audio/pcm",rate:24000}`,
//!   `audio.input.turn_detection`, `audio.input.transcription.model`,
//!   `audio.output.voice`, `output_modalities`, `tools`, `tool_choice`),
//!   `input_audio_buffer.append`, `response.output_audio.delta`
//!   (`item_id`, `delta` = base64 PCM16), `response.output_audio_transcript.delta`,
//!   `response.function_call_arguments.done` (`call_id`, `name`, `arguments`),
//!   `conversation.item.create` with a `function_call_output` item, `response.create`,
//!   `response.cancel`, `conversation.item.truncate` (`item_id`, `content_index`,
//!   `audio_end_ms`) and `rate_limits.updated`.
//!   Unknown server events are ignored, so additions on OpenAI's side can't break a
//!   session; renamed ones would silently stop working, which the unit tests (sample
//!   JSON below) are meant to make obvious when the samples are updated.

use serde::Deserialize;
use serde_json::{json, Value};

/// PCM16 mono at this rate in both directions.
pub const SAMPLE_RATE: u32 = 24_000;

pub fn realtime_url(base: &str, model: &str) -> String {
    format!("{base}?model={model}")
}

pub const REALTIME_BASE_URL: &str = "wss://api.openai.com/v1/realtime";

/// Voices the GA realtime models accept.
pub const VOICES: &[&str] = &[
    "marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse",
];

// ---- client events (we send) ---------------------------------------------------------

pub fn session_update(model: &str, voice: &str, instructions: &str, tools: &Value) -> Value {
    json!({
        "type": "session.update",
        "session": {
            "type": "realtime",
            "model": model,
            "instructions": instructions,
            "output_modalities": ["audio"],
            "audio": {
                "input": {
                    "format": { "type": "audio/pcm", "rate": SAMPLE_RATE },
                    "transcription": { "model": "gpt-4o-mini-transcribe" },
                    "turn_detection": {
                        "type": "semantic_vad",
                        "eagerness": "auto",
                        "create_response": true,
                        "interrupt_response": true
                    }
                },
                "output": {
                    "format": { "type": "audio/pcm", "rate": SAMPLE_RATE },
                    "voice": voice
                }
            },
            "tools": tools,
            "tool_choice": "auto"
        }
    })
}

pub fn audio_append(base64_pcm: &str) -> Value {
    json!({ "type": "input_audio_buffer.append", "audio": base64_pcm })
}

pub fn function_call_output(call_id: &str, output: &str) -> Value {
    json!({
        "type": "conversation.item.create",
        "item": { "type": "function_call_output", "call_id": call_id, "output": output }
    })
}

pub fn response_create() -> Value {
    json!({ "type": "response.create" })
}

pub fn response_cancel() -> Value {
    json!({ "type": "response.cancel" })
}

pub fn item_truncate(item_id: &str, audio_end_ms: u64) -> Value {
    json!({
        "type": "conversation.item.truncate",
        "item_id": item_id,
        "content_index": 0,
        "audio_end_ms": audio_end_ms
    })
}

// ---- server events (we receive) ------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum ServerEvent {
    #[serde(rename = "session.created")]
    SessionCreated,
    #[serde(rename = "session.updated")]
    SessionUpdated,
    #[serde(rename = "error")]
    Error { error: ApiError },
    #[serde(rename = "input_audio_buffer.speech_started")]
    SpeechStarted,
    #[serde(rename = "input_audio_buffer.speech_stopped")]
    SpeechStopped,
    #[serde(rename = "conversation.item.input_audio_transcription.delta")]
    InputTranscriptDelta {
        item_id: String,
        #[serde(default)]
        delta: String,
    },
    #[serde(rename = "conversation.item.input_audio_transcription.completed")]
    InputTranscriptDone { item_id: String, transcript: String },
    #[serde(rename = "response.created")]
    ResponseCreated,
    #[serde(rename = "response.output_audio.delta")]
    AudioDelta { item_id: String, delta: String },
    #[serde(rename = "response.output_audio.done")]
    AudioDone,
    #[serde(rename = "response.output_audio_transcript.delta")]
    OutputTranscriptDelta {
        item_id: String,
        #[serde(default)]
        delta: String,
    },
    #[serde(rename = "response.output_audio_transcript.done")]
    OutputTranscriptDone {
        item_id: String,
        #[serde(default)]
        transcript: String,
    },
    #[serde(rename = "response.function_call_arguments.done")]
    FunctionCallDone {
        call_id: String,
        name: String,
        arguments: String,
    },
    #[serde(rename = "response.done")]
    ResponseDone { response: ResponseBody },
    #[serde(rename = "rate_limits.updated")]
    RateLimits,
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
pub struct ApiError {
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub message: String,
}

#[derive(Debug, Deserialize, Default)]
pub struct ResponseBody {
    #[serde(default)]
    pub usage: Option<TokenUsage>,
}

#[derive(Debug, Deserialize, Default, Clone)]
pub struct TokenUsage {
    #[serde(default)]
    pub input_token_details: InputDetails,
    #[serde(default)]
    pub output_token_details: OutputDetails,
}

#[derive(Debug, Deserialize, Default, Clone)]
pub struct InputDetails {
    #[serde(default)]
    pub audio_tokens: u64,
    #[serde(default)]
    pub text_tokens: u64,
    #[serde(default)]
    pub cached_tokens: u64,
    #[serde(default)]
    pub cached_tokens_details: CachedDetails,
}

#[derive(Debug, Deserialize, Default, Clone)]
pub struct CachedDetails {
    #[serde(default)]
    pub audio_tokens: u64,
    #[serde(default)]
    pub text_tokens: u64,
}

#[derive(Debug, Deserialize, Default, Clone)]
pub struct OutputDetails {
    #[serde(default)]
    pub audio_tokens: u64,
    #[serde(default)]
    pub text_tokens: u64,
}

pub fn parse_server_event(text: &str) -> Option<ServerEvent> {
    serde_json::from_str(text).ok()
}

/// Barge-in: how much of an item's audio the listener actually heard, in ms.
/// `item_start` / `played` / `item_samples` are sample counts at [`SAMPLE_RATE`].
pub fn heard_ms(item_start: u64, played: u64, item_samples: u64) -> u64 {
    let heard = played.saturating_sub(item_start).min(item_samples);
    heard * 1000 / SAMPLE_RATE as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sample_events() {
        let cases = [
            r#"{"type":"session.created","event_id":"e1","session":{"id":"s"}}"#,
            r#"{"type":"input_audio_buffer.speech_started","audio_start_ms":120,"item_id":"item_1","event_id":"e"}"#,
            r#"{"type":"conversation.item.input_audio_transcription.delta","item_id":"i","delta":"hel","obfuscation":"x"}"#,
            r#"{"type":"conversation.item.input_audio_transcription.completed","item_id":"i","transcript":"hello","usage":{}}"#,
            r#"{"type":"response.output_audio.delta","response_id":"r","item_id":"i","output_index":0,"content_index":0,"delta":"AAAA"}"#,
            r#"{"type":"response.output_audio_transcript.delta","item_id":"i","delta":"Hi"}"#,
            r#"{"type":"response.function_call_arguments.done","call_id":"c1","name":"list_agents","arguments":"{}","item_id":"i","response_id":"r"}"#,
            r#"{"type":"error","error":{"type":"invalid_request_error","code":"bad","message":"boom"}}"#,
            r#"{"type":"rate_limits.updated","rate_limits":[]}"#,
            r#"{"type":"something.new","x":1}"#,
        ];
        let parsed: Vec<_> = cases
            .iter()
            .map(|c| parse_server_event(c).unwrap())
            .collect();
        assert!(matches!(parsed[0], ServerEvent::SessionCreated));
        assert!(matches!(parsed[1], ServerEvent::SpeechStarted));
        assert!(
            matches!(&parsed[2], ServerEvent::InputTranscriptDelta { delta, .. } if delta == "hel")
        );
        assert!(
            matches!(&parsed[3], ServerEvent::InputTranscriptDone { transcript, .. } if transcript == "hello")
        );
        assert!(matches!(&parsed[4], ServerEvent::AudioDelta { delta, .. } if delta == "AAAA"));
        assert!(
            matches!(&parsed[5], ServerEvent::OutputTranscriptDelta { delta, .. } if delta == "Hi")
        );
        assert!(
            matches!(&parsed[6], ServerEvent::FunctionCallDone { call_id, name, .. } if call_id == "c1" && name == "list_agents")
        );
        assert!(matches!(&parsed[7], ServerEvent::Error { error } if error.message == "boom"));
        assert!(matches!(parsed[8], ServerEvent::RateLimits));
        assert!(matches!(parsed[9], ServerEvent::Other));
    }

    #[test]
    fn parses_response_done_usage() {
        let raw = r#"{"type":"response.done","response":{"id":"r","status":"completed","usage":{
            "total_tokens":300,"input_tokens":200,"output_tokens":100,
            "input_token_details":{"text_tokens":80,"audio_tokens":120,"cached_tokens":64,
                "cached_tokens_details":{"text_tokens":64,"audio_tokens":0}},
            "output_token_details":{"text_tokens":10,"audio_tokens":90}}}}"#;
        let Some(ServerEvent::ResponseDone { response }) = parse_server_event(raw) else {
            panic!("not response.done");
        };
        let u = response.usage.unwrap();
        assert_eq!(u.input_token_details.audio_tokens, 120);
        assert_eq!(u.input_token_details.cached_tokens_details.text_tokens, 64);
        assert_eq!(u.output_token_details.audio_tokens, 90);
    }

    #[test]
    fn malformed_json_is_ignored() {
        assert!(parse_server_event("not json").is_none());
    }

    #[test]
    fn session_update_shape() {
        let v = session_update("gpt-realtime", "marin", "be brief", &json!([]));
        assert_eq!(v["type"], "session.update");
        assert_eq!(v["session"]["type"], "realtime");
        assert_eq!(v["session"]["audio"]["input"]["format"]["rate"], 24000);
        assert_eq!(v["session"]["audio"]["output"]["voice"], "marin");
        assert_eq!(
            v["session"]["audio"]["input"]["turn_detection"]["type"],
            "semantic_vad"
        );
    }

    #[test]
    fn client_event_shapes() {
        assert_eq!(audio_append("QQ==")["type"], "input_audio_buffer.append");
        let o = function_call_output("c", "{}");
        assert_eq!(o["item"]["type"], "function_call_output");
        assert_eq!(o["item"]["call_id"], "c");
        let t = item_truncate("i", 1500);
        assert_eq!(t["audio_end_ms"], 1500);
        assert_eq!(t["content_index"], 0);
        assert_eq!(response_cancel()["type"], "response.cancel");
        assert_eq!(response_create()["type"], "response.create");
    }

    #[test]
    fn truncate_math() {
        // 1 s of audio queued for the item, 0.5 s already played since it started.
        assert_eq!(heard_ms(1000, 1000 + 12_000, 24_000), 500);
        // Never more than the item's length, never negative.
        assert_eq!(heard_ms(0, 100_000, 24_000), 1000);
        assert_eq!(heard_ms(5000, 100, 24_000), 0);
    }
}
