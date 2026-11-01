//! What `gh` says when it fails, turned into sentences for the UI.
//!
//! `gh` reports problems as free text on stderr ("gh: Pull Request is not mergeable (HTTP 405)",
//! a JSON body, a Go network error). Each failure is mapped to one readable sentence; the raw text
//! rides along after [`DETAILS_MARK`] so the UI can offer "Copy details" for a bug report without
//! showing a wall of text. Pure functions, tested against captured messages.

use anyhow::anyhow;

/// Said when a merge is refused because the pull request's head moved after the user looked.
/// The UI matches this text to re-read the pull request and ask again (`BRANCH_CHANGED_MESSAGE`
/// in `src/lib/prFlow.ts` must stay identical).
pub const BRANCH_CHANGED: &str = "The branch changed since you looked. Review the new commits.";

/// Separates the readable message from the raw `gh` text (`splitDetails` in `src/lib/prFlow.ts`).
pub const DETAILS_MARK: &str = "\n\n--- details ---\n";

/// Most characters of raw `gh` output kept as details.
const MAX_DETAILS_CHARS: usize = 2000;

/// The last line of `gh`'s stderr without its "gh:" prefix and "(HTTP 405)" suffix:
/// "gh: Pull Request is not mergeable (HTTP 405)" -> "Pull Request is not mergeable".
fn headline(raw: &str) -> &str {
    let text = raw.trim();
    let line = text
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or(text)
        .trim()
        .trim_start_matches("gh:")
        .trim();
    match line.rfind(" (HTTP ") {
        Some(i) => &line[..i],
        None => line,
    }
}

/// Appends the raw text as details, unless it adds nothing over the sentence.
pub fn with_details(readable: &str, raw: &str) -> String {
    let raw = raw.trim();
    if raw.is_empty() || raw == readable.trim() {
        return readable.to_string();
    }
    let cut: String = raw.chars().take(MAX_DETAILS_CHARS).collect();
    let more = if cut.len() < raw.len() { "\n[…]" } else { "" };
    format!("{readable}{DETAILS_MARK}{cut}{more}")
}

/// A sentence for failures that are the same whatever `gh` was doing. `None` = not recognised.
fn common(raw: &str) -> Option<String> {
    let lower = raw.to_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| lower.contains(n));
    let said = if raw.trim() == "gh_missing" {
        "The GitHub CLI (gh) is not installed. Get it from https://cli.github.com"
    } else if raw.trim() == "timed out" {
        "GitHub didn't answer in time. Check your connection and try again."
    } else if has(&[
        "gh auth login",
        "not logged in",
        "http 401",
        "bad credentials",
    ]) {
        "Sign in to GitHub first (the GitHub button in an agent's Review panel)."
    } else if has(&["saml"]) {
        "This organization requires single sign-on. Authorize the GitHub CLI for it on GitHub, then try again."
    } else if has(&["rate limit", "http 429", "abuse detection"]) {
        "GitHub is limiting requests right now. Wait a minute and try again."
    } else if has(&[
        "could not resolve host",
        "no such host",
        "dial tcp",
        "error connecting to",
        "connection refused",
        "network is unreachable",
        "i/o timeout",
        "tls handshake",
        "http 502",
        "http 503",
        "http 504",
    ]) {
        "Couldn't reach GitHub. Check your connection and try again."
    } else if has(&[
        "none of the git remotes",
        "no git remotes",
        "could not resolve to a repository",
        "unable to determine base repository",
    ]) {
        "This project has no GitHub repository."
    } else if has(&["has disabled issues"]) {
        "Issues are turned off for this repository."
    } else if has(&["resource not accessible"]) {
        "The GitHub sign-in doesn't have permission to do that here. Sign in again and allow repository access."
    } else {
        return None;
    };
    Some(said.to_string())
}

/// Any `gh` failure as an error whose text is a sentence plus, when there is more to say, details.
pub fn explain_gh_error(raw: String) -> anyhow::Error {
    match common(&raw) {
        Some(said) => anyhow!("{}", with_details(&said, &raw)),
        None => {
            let said = headline(&raw);
            anyhow!("{}", with_details(said, &raw))
        }
    }
}

/// Turns what `gh api` said about a refused merge into a sentence for the UI (no details).
pub fn explain_merge_error(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    let message = headline(stderr);
    if lower.contains("base branch was modified") {
        "The base branch changed while you were merging. Try again.".into()
    } else if lower.contains("http 409") || lower.contains("head branch was modified") {
        BRANCH_CHANGED.into()
    } else if let Some(said) = common(stderr) {
        said
    } else if lower.contains("http 403") || lower.contains("http 404") {
        "GitHub didn't let Kvistcode merge this pull request. You may not have permission to merge here, or branch protection requires the merge to happen on GitHub.".into()
    } else if lower.contains("http 405") || lower.contains("http 422") {
        format!(
            "GitHub can't merge this pull request right now: {}.",
            message.trim_end_matches('.')
        )
    } else {
        message.to_string()
    }
}

/// A refused merge as an error: the sentence, and `gh`'s own words as details. The
/// branch-changed answer carries none, because the UI matches it as-is.
pub fn merge_failure(stderr: &str) -> anyhow::Error {
    let said = explain_merge_error(stderr);
    if said == BRANCH_CHANGED {
        return anyhow!("{said}");
    }
    anyhow!("{}", with_details(&said, stderr))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refused_merges_read_as_sentences() {
        let blocked = "{\"message\":\"Pull Request is not mergeable\"}\ngh: Pull Request is not mergeable (HTTP 405)\n";
        assert_eq!(
            explain_merge_error(blocked),
            "GitHub can't merge this pull request right now: Pull Request is not mergeable."
        );
        assert!(
            explain_merge_error("gh: Resource not accessible (HTTP 403)").contains("permission")
        );
        assert!(
            explain_merge_error("To get started with GitHub CLI, please run:  gh auth login")
                .starts_with("Sign in to GitHub")
        );
        assert_eq!(explain_merge_error("boom"), "boom");
    }

    #[test]
    fn a_moved_head_is_the_branch_changed_message() {
        // What GitHub answers when the `sha` sent with a merge is no longer the head.
        let moved = "{\"message\":\"Head branch was modified. Review and try the merge again.\",\"documentation_url\":\"https://docs.github.com/rest/pulls/pulls#merge-a-pull-request\",\"status\":\"409\"}\ngh: Head branch was modified. Review and try the merge again. (HTTP 409)\n";
        assert_eq!(explain_merge_error(moved), BRANCH_CHANGED);
        assert_eq!(
            BRANCH_CHANGED,
            "The branch changed since you looked. Review the new commits."
        );
        // Any other 409 is read the same way: something moved, look again.
        assert_eq!(
            explain_merge_error("gh: Conflict (HTTP 409)"),
            BRANCH_CHANGED
        );
        // The error handed to the UI is exactly that sentence, with no details after it.
        assert_eq!(merge_failure(moved).to_string(), BRANCH_CHANGED);
    }

    #[test]
    fn a_moved_base_is_not_a_reviewed_commit_problem() {
        let said = explain_merge_error(
            "gh: Base branch was modified. Review and try the merge again. (HTTP 409)",
        );
        assert!(said.contains("base branch"));
        assert_ne!(said, BRANCH_CHANGED);
    }

    #[test]
    fn merge_failures_keep_gh_words_as_details() {
        let raw = "{\"message\":\"Required status check \\\"build\\\" is expected.\"}\ngh: Required status check \"build\" is expected. (HTTP 405)\n";
        let text = merge_failure(raw).to_string();
        let (said, details) = text.split_once(DETAILS_MARK).expect("details");
        assert_eq!(
            said,
            "GitHub can't merge this pull request right now: Required status check \"build\" is expected."
        );
        assert!(details.contains("(HTTP 405)"));
        assert!(details.contains("\"message\""));
    }

    #[test]
    fn common_failures_get_a_sentence() {
        let cases = [
            ("gh_missing", "not installed"),
            ("timed out", "didn't answer in time"),
            ("gh auth login required", "Sign in"),
            ("HTTP 401: Bad credentials", "Sign in"),
            ("gh: Resource protected by organization SAML enforcement. (HTTP 403)", "single sign-on"),
            ("gh: API rate limit exceeded for user ID 1. (HTTP 403)", "limiting requests"),
            ("Post \"https://api.github.com/graphql\": dial tcp: lookup api.github.com: no such host", "Couldn't reach GitHub"),
            ("error connecting to api.github.com", "Couldn't reach GitHub"),
            ("none of the git remotes point to a known GitHub host", "no GitHub repository"),
            ("the 'o/r' repository has disabled issues", "Issues are turned off"),
            ("gh: Resource not accessible by personal access token (HTTP 403)", "permission"),
        ];
        for (raw, expect) in cases {
            let text = explain_gh_error(raw.to_string()).to_string();
            assert!(text.contains(expect), "{raw} -> {text}");
        }
    }

    #[test]
    fn unrecognised_failures_show_the_last_line_and_keep_the_rest() {
        let raw = "some preamble\nGraphQL: Something odd happened (updatePullRequest)\n";
        let text = explain_gh_error(raw.to_string()).to_string();
        let (said, details) = text.split_once(DETAILS_MARK).expect("details");
        assert_eq!(said, "GraphQL: Something odd happened (updatePullRequest)");
        assert!(details.starts_with("some preamble"));
        // One clean line says everything already: no details section.
        assert_eq!(explain_gh_error("boom\n".into()).to_string(), "boom");
    }

    #[test]
    fn details_are_capped() {
        let raw = format!("start\n{}", "x".repeat(MAX_DETAILS_CHARS * 2));
        let text = with_details("Readable.", &raw);
        assert!(text.len() < MAX_DETAILS_CHARS + 100);
        assert!(text.ends_with("[…]"));
        assert_eq!(with_details("Same.", " Same. "), "Same.");
        assert_eq!(with_details("Only.", ""), "Only.");
    }
}
