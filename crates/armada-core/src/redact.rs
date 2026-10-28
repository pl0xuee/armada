//! Best-effort removal of credentials from text that is about to leave the machine
//! (phone share links, push notifications). It is a safety net, not a guarantee:
//! callers should still avoid sending content that doesn't need to be sent.
//!
//! Covered: provider API keys (`sk-…`, `sk-ant-…`), `Bearer` tokens, GitHub tokens
//! (`ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_`, `github_pat_`), AWS access key ids
//! (`AKIA…`/`ASIA…`), Slack tokens (`xoxa-`, `xoxb-`, `xoxp-`, `xoxr-`), PEM private
//! key blocks, and `password=…` / `token: "…"` style assignments (including
//! `*_API_KEY`, `*_SECRET` and similar names).

use std::borrow::Cow;

/// What a removed secret is replaced with.
pub const REDACTED: &str = "[REDACTED]";
const REDACTED_KEY: &str = "[REDACTED PRIVATE KEY]";

/// Returns `input` with recognizable secrets replaced by `[REDACTED]`. Borrows when
/// nothing needed to change.
pub fn redact_secrets(input: &str) -> Cow<'_, str> {
    let mut text: Cow<str> = Cow::Borrowed(input);
    for pass in [private_keys, assignments, tokens] {
        if let Some(changed) = pass(&text) {
            text = Cow::Owned(changed);
        }
    }
    text
}

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn is_token_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b'=' | b'+' | b'/' | b'~')
}

/// Number of consecutive bytes from `from` matching `pred`.
fn run(bytes: &[u8], from: usize, pred: impl Fn(u8) -> bool) -> usize {
    bytes[from..].iter().take_while(|b| pred(**b)).count()
}

// ---- PEM private keys ----------------------------------------------------------------

fn private_keys(s: &str) -> Option<String> {
    const BEGIN: &str = "-----BEGIN ";
    if !s.contains(BEGIN) {
        return None;
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    let mut changed = false;
    while let Some(start) = rest.find(BEGIN) {
        let after = &rest[start + BEGIN.len()..];
        // The header line: "-----BEGIN RSA PRIVATE KEY-----".
        let Some(header_len) = after.find("-----") else {
            break;
        };
        let header = &after[..header_len];
        let is_private = header.ends_with("PRIVATE KEY") && !header.contains('\n');
        if !is_private {
            out.push_str(&rest[..start + BEGIN.len()]);
            rest = after;
            continue;
        }
        out.push_str(&rest[..start]);
        out.push_str(REDACTED_KEY);
        changed = true;
        let body = &after[header_len + 5..];
        let end_marker = "-----END ";
        rest = match body.find(end_marker) {
            Some(e) => {
                let tail = &body[e + end_marker.len()..];
                match tail.find("-----") {
                    Some(t) => &tail[t + 5..],
                    None => "",
                }
            }
            // A truncated block: everything after the header is key material.
            None => "",
        };
    }
    if !changed {
        return None;
    }
    out.push_str(rest);
    Some(out)
}

// ---- Prefixed tokens -----------------------------------------------------------------

/// If a secret token starts at `i` (preceded by a non-word byte), the byte range to
/// remove.
fn match_token(b: &[u8], i: usize) -> Option<(usize, usize)> {
    let rest = &b[i..];
    let starts = |p: &str| rest.starts_with(p.as_bytes());
    let key_chars = |from: usize| {
        run(b, from, |c| {
            c.is_ascii_alphanumeric() || c == b'_' || c == b'-'
        })
    };

    // sk-…, sk-ant-…, sk-proj-…
    if starts("sk-") {
        let n = key_chars(i + 3);
        if n >= 16 {
            return Some((i, i + 3 + n));
        }
    }
    for prefix in ["ghp_", "gho_", "ghs_", "ghu_", "ghr_"] {
        if starts(prefix) {
            let n = run(b, i + 4, |c| c.is_ascii_alphanumeric());
            if n >= 20 {
                return Some((i, i + 4 + n));
            }
        }
    }
    if starts("github_pat_") {
        let n = key_chars(i + 11);
        if n >= 20 {
            return Some((i, i + 11 + n));
        }
    }
    if starts("AKIA") || starts("ASIA") {
        let n = run(b, i + 4, |c| c.is_ascii_uppercase() || c.is_ascii_digit());
        if n >= 16 {
            return Some((i, i + 4 + 16));
        }
    }
    if rest.len() > 5
        && starts("xox")
        && matches!(rest[3], b'a' | b'b' | b'p' | b'r')
        && rest[4] == b'-'
    {
        let n = run(b, i + 5, |c| c.is_ascii_alphanumeric() || c == b'-');
        if n >= 10 {
            return Some((i, i + 5 + n));
        }
    }
    // "Bearer <token>": keep the word, drop the credential.
    if rest.len() > 7
        && rest[..6].eq_ignore_ascii_case(b"bearer")
        && matches!(rest[6], b' ' | b'\t')
    {
        let spaces = run(b, i + 6, |c| c == b' ' || c == b'\t');
        let from = i + 6 + spaces;
        let n = run(b, from, is_token_char);
        if n >= 16 {
            return Some((from, from + n));
        }
    }
    None
}

fn tokens(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = String::new();
    let mut copied = 0;
    let mut i = 0;
    while i < b.len() {
        let boundary = i == 0 || !is_word(b[i - 1]);
        if boundary && s.is_char_boundary(i) {
            if let Some((from, to)) = match_token(b, i) {
                out.push_str(&s[copied..from]);
                out.push_str(REDACTED);
                copied = to;
                i = to;
                continue;
            }
        }
        i += 1;
    }
    if copied == 0 {
        return None;
    }
    out.push_str(&s[copied..]);
    Some(out)
}

// ---- Assignments ---------------------------------------------------------------------

/// Names (lowercased, without `_ - .`) whose values are secrets.
const SECRET_NAMES: &[&str] = &[
    "password",
    "passwd",
    "passphrase",
    "secret",
    "secretkey",
    "token",
    "apikey",
    "accesskey",
    "privatekey",
    "credentials",
    "clientsecret",
];

fn is_secret_name(name: &str) -> bool {
    let normalized: String = name
        .chars()
        .filter(|c| !matches!(c, '_' | '-' | '.'))
        .map(|c| c.to_ascii_lowercase())
        .collect();
    SECRET_NAMES.iter().any(|n| normalized.ends_with(n))
}

fn assignments(s: &str) -> Option<String> {
    if !s.contains('=') && !s.contains(':') {
        return None;
    }
    let b = s.as_bytes();
    let mut out = String::new();
    let mut copied = 0;
    let mut i = 0;
    while i < b.len() {
        let sep = b[i];
        if sep != b'=' && sep != b':' {
            i += 1;
            continue;
        }
        // The name before the separator (allowing a closing quote: "token": "x").
        let mut end = i;
        while end > 0 && b[end - 1] == b' ' {
            end -= 1;
        }
        if end > 0 && matches!(b[end - 1], b'"' | b'\'') {
            end -= 1;
        }
        let mut start = end;
        while start > 0 && (is_word(b[start - 1]) || matches!(b[start - 1], b'-' | b'.')) {
            start -= 1;
        }
        if start == end || !is_secret_name(&s[start..end]) {
            i += 1;
            continue;
        }
        // `==`, `=>` and `:=` are comparisons/assignments in code, still secret-ish; but
        // `::` is a path separator.
        if sep == b':' && b.get(i + 1) == Some(&b':') {
            i += 2;
            continue;
        }
        let mut v = i + 1;
        if sep == b'=' && b.get(v) == Some(&b'=') {
            v += 1;
        }
        v += run(b, v, |c| c == b' ' || c == b'\t');
        let Some(&first) = b.get(v) else {
            break;
        };
        let (from, to) = if first == b'"' || first == b'\'' {
            let inner = v + 1;
            let len = run(b, inner, |c| c != first && c != b'\n');
            (inner, inner + len)
        } else {
            let len = run(b, v, |c| {
                !c.is_ascii_whitespace()
                    && !matches!(c, b',' | b';' | b'"' | b'\'' | b'&' | b')' | b'}' | b']')
            });
            // Environment references and templates aren't secrets; a bare `token: word` in
            // prose isn't either, so ':' needs a credential-length value.
            let reference =
                matches!(first, b'$' | b'{' | b'<' | b'%') || b[v..].starts_with(b"[REDACTED");
            let too_short = len == 0 || (sep == b':' && len < 16);
            if reference || too_short {
                i = v.max(i + 1);
                continue;
            }
            (v, v + len)
        };
        if to == from
            || s[from..to] == *REDACTED
            || !s.is_char_boundary(from)
            || !s.is_char_boundary(to)
        {
            i = to.max(i + 1);
            continue;
        }
        out.push_str(&s[copied..from]);
        out.push_str(REDACTED);
        copied = to;
        i = to;
    }
    if copied == 0 {
        return None;
    }
    out.push_str(&s[copied..]);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(s: &str) -> String {
        redact_secrets(s).into_owned()
    }

    /// Fake credentials are assembled at run time so no whole token-shaped string sits in
    /// the source (secret scanners would flag these obviously fake test values).
    fn k(parts: &[&str]) -> String {
        parts.concat()
    }

    #[test]
    fn leaves_ordinary_text_alone() {
        for s in [
            "",
            "Ran the tests; all 42 passed.",
            "risk-assessment-for-the-new-design is done",
            "the task-runner-configuration-file changed",
            "max_tokens=4096 and tokens_used: 123",
            "token: the thing we pass around",
            "use `std::env::var(\"TOKEN\")` here",
            "export TOKEN=$GITHUB_TOKEN",
            "password = <your password>",
            "ghp_short and sk-short",
        ] {
            assert!(matches!(redact_secrets(s), Cow::Borrowed(_)), "{s}");
            assert_eq!(r(s), s);
        }
    }

    #[test]
    fn provider_api_keys() {
        assert_eq!(
            r(&k(&["key s", "k-abcdefghijklmnopqrstuv end"])),
            "key [REDACTED] end"
        );
        assert_eq!(
            r(&k(&[
                "ANTHROPIC s",
                "k-ant-api03-AbCdEf_ghIJKL-mnopqrstuvwx1234."
            ])),
            "ANTHROPIC [REDACTED]."
        );
        assert_eq!(
            r(&k(&["(s", "k-proj-abcdefghijklmnop1234)"])),
            "([REDACTED])"
        );
    }

    #[test]
    fn github_aws_and_slack_tokens() {
        assert_eq!(
            r(&k(&[
                "gh",
                "p_abcdefghijklmnopqrstuvwxyz0123456789 and gh",
                "o_abcdefghijklmnopqrstuv and gh",
                "s_abcdefghijklmnopqrstuv",
            ])),
            "[REDACTED] and [REDACTED] and [REDACTED]"
        );
        assert_eq!(
            r(&k(&[
                "github_",
                "pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789"
            ])),
            "[REDACTED]"
        );
        assert_eq!(r(&k(&["id AK", "IAIOSFODNN7EXAMPLE."])), "id [REDACTED].");
        assert_eq!(r(&k(&["AS", "IAIOSFODNN7EXAMPLE"])), "[REDACTED]");
        assert_eq!(r(&k(&["xo", "xb-123456789012-abcdefghij"])), "[REDACTED]");
        assert_eq!(r(&k(&["xo", "xp-123456789012-abcdefghij"])), "[REDACTED]");
        assert_eq!(
            r("xoxz-123456789012-abcdefghij"),
            "xoxz-123456789012-abcdefghij"
        );
    }

    #[test]
    fn bearer_tokens() {
        assert_eq!(
            r("curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def'"),
            "curl -H 'Authorization: Bearer [REDACTED]'"
        );
        assert_eq!(r("bearer   abcdefghijklmnop1234"), "bearer   [REDACTED]");
        assert_eq!(r("Bearer short"), "Bearer short");
    }

    #[test]
    fn private_key_blocks() {
        let pem = k(&[
            "before\n-----BEGIN OPENSSH PRIV",
            "ATE KEY-----\nb3BlbnNzaC1rZXk\nAAAA\n-----END OPENSSH PRIV",
            "ATE KEY-----\nafter",
        ]);
        assert_eq!(r(&pem), "before\n[REDACTED PRIVATE KEY]\nafter");
        assert_eq!(
            r(&k(&["-----BEGIN RSA PRIV", "ATE KEY-----\nMIIEow"])),
            "[REDACTED PRIVATE KEY]"
        );
        assert_eq!(
            r("-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----"),
            "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----"
        );
    }

    #[test]
    fn secret_assignments() {
        assert_eq!(r("PASSWORD=hunter2"), "PASSWORD=[REDACTED]");
        assert_eq!(
            r("DB_PASSWORD=hunter2 DEBUG=1"),
            "DB_PASSWORD=[REDACTED] DEBUG=1"
        );
        assert_eq!(r("secret = 'abc def'"), "secret = '[REDACTED]'");
        assert_eq!(
            r(r#"{"api_key": "abcd1234", "name": "x"}"#),
            r#"{"api_key": "[REDACTED]", "name": "x"}"#
        );
        assert_eq!(
            r("GITHUB_TOKEN=abc123\nOTHER=fine"),
            "GITHUB_TOKEN=[REDACTED]\nOTHER=fine"
        );
        assert_eq!(r("token: abcdefghijklmnopqrst"), "token: [REDACTED]");
        assert_eq!(
            r("https://x.test/cb?access_token=abcdef&x=1"),
            "https://x.test/cb?access_token=[REDACTED]&x=1"
        );
        // Idempotent.
        assert_eq!(r(&r("PASSWORD=hunter2")), "PASSWORD=[REDACTED]");
    }

    #[test]
    fn non_ascii_text_is_safe() {
        assert_eq!(
            r("héllo wörld ✓ token=ünï"),
            "héllo wörld ✓ token=[REDACTED]"
        );
        assert_eq!(
            r(&k(&["日本語 s", "k-abcdefghijklmnopqrstuv 日本語"])),
            "日本語 [REDACTED] 日本語"
        );
    }
}
