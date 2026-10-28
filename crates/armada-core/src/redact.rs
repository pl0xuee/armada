//! Best-effort removal of credentials from text that is about to leave the machine
//! (phone share links, push notifications). It is a safety net, not a guarantee:
//! callers should still avoid sending content that doesn't need to be sent.
//!
//! Covered: provider API keys (`sk-…`, `sk-ant-…`), `Bearer` tokens, GitHub tokens
//! (`ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_`, `github_pat_`), AWS access key ids
//! (`AKIA…`/`ASIA…`), Slack tokens (`xoxa-`, `xoxb-`, `xoxp-`, `xoxr-`), PEM private
//! key blocks, and `password=…` / `token: "…"` style assignments (including
//! `*_API_KEY`, `*_SECRET` and similar names), URL credentials (`scheme://user:pass@host`),
//! `curl -u`, `Authorization:`/`Cookie:` header values, `--password x` flags, Google API
//! keys, GitLab/npm/Stripe/Hugging Face tokens, JWTs and PGP private key blocks. Invisible
//! formatting characters are removed first so they can't split a token.

use std::borrow::Cow;

/// What a removed secret is replaced with.
pub const REDACTED: &str = "[REDACTED]";
const REDACTED_KEY: &str = "[REDACTED PRIVATE KEY]";

/// Returns `input` with recognizable secrets replaced by `[REDACTED]`. Borrows when
/// nothing needed to change.
pub fn redact_secrets(input: &str) -> Cow<'_, str> {
    let mut text: Cow<str> = Cow::Borrowed(input);
    if input.chars().any(is_invisible) {
        text = Cow::Owned(input.chars().filter(|c| !is_invisible(*c)).collect());
    }
    for pass in [
        private_keys,
        headers,
        url_credentials,
        curl_user,
        secret_flags,
        assignments,
        tokens,
    ] {
        if let Some(changed) = pass(&text) {
            text = Cow::Owned(changed);
        }
    }
    text
}

/// Zero-width, bidi and other invisible format (Cf) characters that could split a token.
fn is_invisible(c: char) -> bool {
    matches!(c,
        '\u{AD}' | '\u{61C}' | '\u{180E}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}'
        | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{206F}' | '\u{FEFF}' | '\u{FFF9}'..='\u{FFFB}'
        | '\u{E0000}'..='\u{E007F}')
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
        let is_private = (header.ends_with("PRIVATE KEY") || header.ends_with("PRIVATE KEY BLOCK"))
            && !header.contains('\n');
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
    // Google API key: AIza + 35.
    if starts("AIza")
        && run(b, i + 4, |c| {
            c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-')
        }) >= 35
    {
        return Some((i, i + 39));
    }
    if starts("glpat-") {
        let n = key_chars(i + 6);
        if n >= 20 {
            return Some((i, i + 6 + n));
        }
    }
    if starts("npm_") {
        let n = run(b, i + 4, |c| c.is_ascii_alphanumeric());
        if n >= 36 {
            return Some((i, i + 4 + n));
        }
    }
    for prefix in ["sk_live_", "rk_live_"] {
        if starts(prefix) {
            let n = run(b, i + 8, |c| c.is_ascii_alphanumeric());
            if n >= 16 {
                return Some((i, i + 8 + n));
            }
        }
    }
    if starts("hf_") {
        let n = run(b, i + 3, |c| c.is_ascii_alphanumeric());
        if n >= 30 {
            return Some((i, i + 3 + n));
        }
    }
    // JWT: eyJ<header>.eyJ<payload>.<signature>
    if starts("eyJ") {
        let seg = |c: u8| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-');
        let a = run(b, i, seg);
        if a >= 8 && b.get(i + a) == Some(&b'.') && b[i + a + 1..].starts_with(b"eyJ") {
            let p = run(b, i + a + 1, seg);
            if p >= 8 && b.get(i + a + 1 + p) == Some(&b'.') {
                let sig = run(b, i + a + p + 2, seg);
                return Some((i, i + a + p + 2 + sig));
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
        // `KEY_ghp_…` still counts: only a preceding letter or digit glues it to a word.
        let boundary = i == 0 || !b[i - 1].is_ascii_alphanumeric();
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

// ---- Headers, URLs, flags ---------------------------------------------------------------

/// Pushes `[a, b)` of `s` replaced by the marker into the rewrite state.
struct Rewrite<'a> {
    s: &'a str,
    out: String,
    copied: usize,
}

impl<'a> Rewrite<'a> {
    fn new(s: &'a str) -> Self {
        Rewrite {
            s,
            out: String::new(),
            copied: 0,
        }
    }
    fn replace(&mut self, from: usize, to: usize) {
        if from < self.copied || !self.s.is_char_boundary(from) || !self.s.is_char_boundary(to) {
            return;
        }
        self.out.push_str(&self.s[self.copied..from]);
        self.out.push_str(REDACTED);
        self.copied = to;
    }
    fn finish(mut self) -> Option<String> {
        if self.copied == 0 {
            return None;
        }
        self.out.push_str(&self.s[self.copied..]);
        Some(self.out)
    }
}

/// Is the value an environment reference, template or already-redacted marker?
fn is_reference(v: &[u8]) -> bool {
    matches!(v.first(), None | Some(b'$' | b'{' | b'<' | b'%')) || v.starts_with(b"[REDACTED")
}

/// `Authorization:`, `Proxy-Authorization:`, `Cookie:` and `Set-Cookie:` header values
/// (also as quoted JSON keys). The auth scheme word is kept.
fn headers(s: &str) -> Option<String> {
    let lower = s.to_ascii_lowercase();
    let b = s.as_bytes();
    let mut rw = Rewrite::new(s);
    for (name, is_auth) in [("authorization", true), ("cookie", false)] {
        let mut from = 0;
        while let Some(p) = lower[from..].find(name) {
            let at = from + p;
            from = at + name.len();
            // `Set-Cookie`, `Proxy-Authorization`: any word-ish prefix is fine; a letter
            // directly before ("xcookie") is not a header.
            if at > 0 && b[at - 1].is_ascii_alphanumeric() {
                continue;
            }
            let mut j = from;
            if matches!(b.get(j), Some(b'"' | b'\'')) {
                j += 1;
            }
            j += run(b, j, |c| c == b' ' || c == b'\t');
            if b.get(j) != Some(&b':') {
                continue;
            }
            j += 1;
            j += run(b, j, |c| c == b' ' || c == b'\t');
            if matches!(b.get(j), Some(b'"' | b'\'')) {
                j += 1;
            }
            let end = j + run(b, j, |c| !matches!(c, b'\n' | b'\r' | b'"' | b'\''));
            let mut start = j;
            if is_auth {
                // Keep the scheme (Basic, Bearer, …) when a credential follows it.
                let word = run(b, start, |c| c.is_ascii_alphabetic());
                let after = start + word + run(b, start + word, |c| c == b' ' || c == b'\t');
                if word > 0 && after > start + word && after < end {
                    start = after;
                }
                if end - start < 8 {
                    continue;
                }
            } else if end - start < 8 || !s[start..end].contains('=') {
                continue;
            }
            if is_reference(&b[start..end]) {
                continue;
            }
            rw.replace(start, end);
            from = end;
        }
    }
    rw.finish()
}

/// `scheme://user:password@host` -> keeps the user, drops the password.
fn url_credentials(s: &str) -> Option<String> {
    if !s.contains("://") {
        return None;
    }
    let b = s.as_bytes();
    let mut rw = Rewrite::new(s);
    let mut from = 0;
    while let Some(p) = s[from..].find("://") {
        let auth = from + p + 3;
        from = auth;
        let len = run(b, auth, |c| {
            !c.is_ascii_whitespace()
                && !matches!(c, b'/' | b'?' | b'#' | b'"' | b'\'' | b'<' | b'>')
        });
        let authority = &s[auth..auth + len];
        let Some(at) = authority.rfind('@') else {
            continue;
        };
        let Some(colon) = authority[..at].find(':') else {
            continue;
        };
        let (pw_from, pw_to) = (auth + colon + 1, auth + at);
        if pw_to > pw_from && !is_reference(&b[pw_from..pw_to]) {
            rw.replace(pw_from, pw_to);
        }
    }
    rw.finish()
}

/// `curl -u user:password` / `curl --user user:password`.
fn curl_user(s: &str) -> Option<String> {
    if !s.contains("curl") {
        return None;
    }
    let b = s.as_bytes();
    let mut rw = Rewrite::new(s);
    let mut line_start = 0;
    for line in s.split_inclusive('\n') {
        if line.contains("curl") {
            for flag in [" -u ", " --user ", " -u=", " --user="] {
                let mut from = 0;
                while let Some(p) = line[from..].find(flag) {
                    let mut v = line_start + from + p + flag.len();
                    from += p + flag.len();
                    v += run(b, v, |c| c == b' ');
                    if matches!(b.get(v), Some(b'"' | b'\'')) {
                        v += 1;
                    }
                    let len = run(b, v, |c| {
                        !c.is_ascii_whitespace() && !matches!(c, b'"' | b'\'')
                    });
                    let Some(colon) = s[v..v + len].find(':') else {
                        continue;
                    };
                    let (f, t) = (v + colon + 1, v + len);
                    if t > f && !is_reference(&b[f..t]) {
                        rw.replace(f, t);
                    }
                }
            }
        }
        line_start += line.len();
    }
    rw.finish()
}

/// `--password hunter2` (the `--password=x` form is handled as an assignment).
fn secret_flags(s: &str) -> Option<String> {
    if !s.contains("--") {
        return None;
    }
    const FLAGS: &[&str] = &[
        "--password",
        "--passwd",
        "--token",
        "--api-key",
        "--apikey",
        "--secret",
        "--client-secret",
        "--access-token",
        "--auth-token",
    ];
    let b = s.as_bytes();
    let mut rw = Rewrite::new(s);
    let mut i = 0;
    while let Some(p) = s[i..].find("--") {
        let at = i + p;
        i = at + 2;
        if at > 0 && !b[at - 1].is_ascii_whitespace() {
            continue;
        }
        let Some(flag) = FLAGS.iter().find(|f| {
            s[at..].starts_with(**f) && matches!(b.get(at + f.len()), Some(b' ' | b'\t'))
        }) else {
            continue;
        };
        let mut v = at + flag.len();
        v += run(b, v, |c| c == b' ' || c == b'\t');
        let quoted = matches!(b.get(v), Some(b'"' | b'\''));
        let (f, t) = if quoted {
            let q = b[v];
            (v + 1, v + 1 + run(b, v + 1, |c| c != q && c != b'\n'))
        } else {
            (
                v,
                v + run(b, v, |c| {
                    !c.is_ascii_whitespace() && !matches!(c, b'"' | b'\'' | b';' | b'&' | b')')
                }),
            )
        };
        let val = &s[f..t];
        let plausible = quoted || val.len() >= 8 || val.bytes().any(|c| !c.is_ascii_alphabetic());
        if t > f && !val.starts_with('-') && plausible && !is_reference(val.as_bytes()) {
            rw.replace(f, t);
        }
    }
    rw.finish()
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
    fn url_userinfo_and_curl_user() {
        assert_eq!(
            r("git clone https://bob:hunter22@example.com/r.git"),
            "git clone https://bob:[REDACTED]@example.com/r.git"
        );
        assert_eq!(
            r("postgres://app:p@ss@db:5432/x"),
            "postgres://app:[REDACTED]@db:5432/x"
        );
        assert_eq!(
            r("https://example.com:8080/a@b"),
            "https://example.com:8080/a@b"
        );
        assert_eq!(r("ssh://git@github.com/x/y"), "ssh://git@github.com/x/y");
        assert_eq!(
            r("curl -u alice:s3cretpw https://x.test"),
            "curl -u alice:[REDACTED] https://x.test"
        );
        assert_eq!(r("git push -u origin:main"), "git push -u origin:main");
    }

    #[test]
    fn auth_and_cookie_headers() {
        assert_eq!(
            r("Authorization: Basic dXNlcjpwYXNzd29yZA=="),
            "Authorization: Basic [REDACTED]"
        );
        assert_eq!(
            r(r#"-H "authorization: token abcdef123456""#),
            r#"-H "authorization: token [REDACTED]""#
        );
        assert_eq!(
            r("Cookie: sid=abc123def456; theme=dark\nHost: x"),
            "Cookie: [REDACTED]\nHost: x"
        );
        assert_eq!(
            r("Set-Cookie: session=abcdef123456; HttpOnly"),
            "Set-Cookie: [REDACTED]"
        );
        assert_eq!(r("cookie: yes please"), "cookie: yes please");
        assert_eq!(r("Authorization: n/a"), "Authorization: n/a");
    }

    #[test]
    fn password_flags() {
        assert_eq!(
            r("mytool --password hunter2 --verbose"),
            "mytool --password [REDACTED] --verbose"
        );
        assert_eq!(
            r("mytool --password=hunter2"),
            "mytool --password=[REDACTED]"
        );
        assert_eq!(
            r("the --password option is required"),
            "the --password option is required"
        );
    }

    #[test]
    fn more_provider_tokens() {
        let cases = [
            k(&["AI", "zaSyA-abcdefghijklmnopqrstuvwxyz01234"]),
            k(&["gl", "pat-abcdefghijklmnopqrst"]),
            k(&["np", "m_abcdefghijklmnopqrstuvwxyz0123456789"]),
            k(&["sk", "_live_abcdefghijklmnop1234"]),
            k(&["rk", "_live_abcdefghijklmnop1234"]),
            k(&["h", "f_abcdefghijklmnopqrstuvwxyz01234567"]),
            k(&["ey", "Jhbgcio.ey", "Jzdwiioxx.sigsigsig_-"]),
        ];
        for c in cases {
            assert_eq!(r(&format!("tok {c} end")), "tok [REDACTED] end", "{c}");
        }
        let ghp = k(&["gh", "p_abcdefghijklmnopqrstuvwxyz0123456789"]);
        assert_eq!(r(&format!("MY_KEY_{ghp}")), "MY_KEY_[REDACTED]");
        assert_eq!(
            r("npm_config_cache and hf_short and eyJabc.def"),
            "npm_config_cache and hf_short and eyJabc.def"
        );
    }

    #[test]
    fn pgp_blocks_and_invisible_chars() {
        let pgp = k(&[
            "-----BEGIN PGP PRIV",
            "ATE KEY BLOCK-----\nlQdGBF\n-----END PGP PRIV",
            "ATE KEY BLOCK-----\nok",
        ]);
        assert_eq!(r(&pgp), "[REDACTED PRIVATE KEY]\nok");
        let split = k(&["gh", "p_abcdefghij\u{200b}klmnopqrstuvwxyz01"]);
        assert_eq!(r(&split), "[REDACTED]");
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
