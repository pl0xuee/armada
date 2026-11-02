//! Cheap side jobs for a local model, so they cost no subscription usage.
//!
//! Today that is one job: condensing the transcript that briefs the next agent in a
//! handoff, so a hosted agent reads a short summary instead of ten thousand
//! characters of conversation. It is opt-in (`LocalPrefs::assist_*`), runs against
//! the chosen local server, and falls back to the plain transcript if the server
//! is down, slow or answers nonsense. Blocking: call from `spawn_blocking`.

use std::time::Duration;

use anyhow::{anyhow, bail};
use serde_json::{json, Value};

use crate::local::{agent, check_target, openai_base};
use crate::model::LocalServer;

/// Below this the transcript is already short; summarizing would only lose detail.
pub const MIN_TRANSCRIPT_CHARS: usize = 2_500;
const MAX_SUMMARY_CHARS: usize = 3_000;
const TIMEOUT: Duration = Duration::from_secs(120);

const INSTRUCTIONS: &str = "You condense a conversation between a user and an AI coding agent so a different agent can continue the work. Write plain text, under 350 words: the goal, what was done (files, commands), what is unfinished or failing, and any decisions or constraints the user stated. Keep file names, function names, error messages and numbers exact. Do not add advice. Do not invent anything.";

/// Pulls the reply out of a chat-completions response.
pub fn parse_reply(v: &Value) -> Option<String> {
    let text = v["choices"][0]["message"]["content"].as_str()?.trim();
    // Reasoning models may wrap their thinking in <think> tags.
    let text = match text.rfind("</think>") {
        Some(i) => text[i + "</think>".len()..].trim(),
        None => text,
    };
    (!text.is_empty()).then(|| text.chars().take(MAX_SUMMARY_CHARS).collect())
}

/// Asks the local model for a short version of `transcript`.
pub fn condense(
    server: &LocalServer,
    key: Option<&str>,
    model: &str,
    transcript: &str,
) -> anyhow::Result<String> {
    if transcript.chars().count() < MIN_TRANSCRIPT_CHARS {
        bail!("already short");
    }
    let url = format!("{}/chat/completions", openai_base(server));
    check_target(&url, false)?;
    let body = json!({
        "model": model,
        "stream": false,
        "temperature": 0.2,
        "max_tokens": 900,
        "messages": [
            { "role": "system", "content": INSTRUCTIONS },
            { "role": "user", "content": transcript },
        ],
    });
    let mut req = agent(TIMEOUT)
        .post(&url)
        .header("Content-Type", "application/json");
    if let Some(k) = key {
        req = req.header("Authorization", &format!("Bearer {k}"));
    }
    let mut resp = req.send(body.to_string()).map_err(|e| anyhow!("{e}"))?;
    let text = resp
        .body_mut()
        .with_config()
        .limit(4 * 1024 * 1024)
        .read_to_string()
        .map_err(|e| anyhow!("{e}"))?;
    let v: Value = serde_json::from_str(&text)?;
    parse_reply(&v).ok_or_else(|| anyhow!("the model gave no summary"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_ctx::fake;
    use crate::model::LocalKind;

    fn server(url: &str) -> LocalServer {
        LocalServer {
            kind: LocalKind::Ollama,
            base_url: url.into(),
        }
    }

    #[test]
    fn reads_replies_and_strips_thinking() {
        let v =
            json!({"choices":[{"message":{"content":"<think>hmm</think>\n The goal was X. "}}]});
        assert_eq!(parse_reply(&v).as_deref(), Some("The goal was X."));
        assert_eq!(
            parse_reply(&json!({"choices":[{"message":{"content":"  "}}]})),
            None
        );
        assert_eq!(parse_reply(&json!({})), None);
    }

    #[test]
    fn condenses_through_the_chat_endpoint() {
        let f = fake::serve(vec![(
            "/v1/chat/completions",
            r#"{"choices":[{"message":{"content":"Goal: fix login. Edited auth.rs."}}]}"#.into(),
        )]);
        let long = "user: fix the login bug\n".repeat(200);
        let s = condense(&server(&f.url), None, "m:1", &long).unwrap();
        assert_eq!(s, "Goal: fix login. Edited auth.rs.");
        let seen = f.seen.lock().unwrap().clone();
        assert!(seen[0].contains("\"model\":\"m:1\"") && seen[0].contains("fix the login bug"));
    }

    #[test]
    fn short_transcripts_and_failures_are_errors_for_the_caller_to_fall_back_on() {
        let f = fake::serve(vec![]);
        assert!(condense(&server(&f.url), None, "m", "short").is_err());
        let long = "x".repeat(MIN_TRANSCRIPT_CHARS + 1);
        // The fake answers 404 to everything.
        assert!(condense(&server(&f.url), None, "m", &long).is_err());
        assert!(condense(&server("http://127.0.0.1:9"), None, "m", &long).is_err());
    }
}
