//! What Armada tells every agent about the place it is running in: that its replies can show
//! pictures, and the house style for how to report its work. Without the first an agent has no
//! way to know its replies can show pictures, and says it can't.

use crate::model::ResponseStyle;

/// Bump when any text in this file changes, so resumed sessions are briefed again, once.
const GUIDANCE_VERSION: u32 = 1;

/// Added to the agent's own instructions (Claude: `systemPrompt` append; Codex:
/// `developerInstructions`). Keep it short and factual: every session pays for it.
const PICTURES: &str = "\
You are running inside Armada, a desktop app that renders your replies as markdown, and you CAN show pictures to the user.
To show a picture, put ![short description](path) in your reply. The path can be:
- an image file (png, jpg, gif, webp, svg, avif; at most 10 MB) in your working folder or project, relative or absolute, or
- an image file you saved in the system temp folder, as long as you write its full path in your reply, or
- a small png/jpeg/gif/webp as a data URI: ![description](data:image/png;base64,...) (under about 3 MB).
Armada loads the file and shows it inline in the conversation, on the phone app too. Pictures from web addresses (http/https) are never loaded: download them into your working folder first, then reference the file. Don't tell the user you can't show images; screenshots, charts and generated images you save as files can be shown this way.";

const CONCISE: &str = "\
How to write replies (Armada response style: concise).
Do the work thoroughly and verify it; report it briefly.
- Open with the outcome in one or two plain sentences: what happened, or what you need from the user.
- Then only what the reader must decide, verify or act on, as a short list. Blockers, risks and decisions first.
- Don't narrate process or restate the request. No pasted logs, diffs, listings or long tables: name the file or command, and put large detail in a file.
- Numbers only when they matter. Short paragraphs, no emoji.
- Say what is uncertain or not verified. Never hide a failure for brevity.
- Between tool calls, one short line. Keep code and commands that are the deliverable.
- Offer detail: \"say the word and I'll detail X\".";

const BALANCED: &str = "\
How to write your replies (Armada response style: balanced).
Do the work thoroughly and verify it; report it clearly, without padding.
- Open with the outcome in one to three plain sentences: what happened, or what you need from the user.
- Then the parts the reader needs to decide, verify or act on, as short lists or short paragraphs: what changed and where, how you checked it, what is left. Put blockers, risks and decisions first.
- Explain the reasoning behind non-obvious choices in a sentence or two. Don't narrate your process or restate the request.
- Don't paste logs, diffs, file listings or long tables: name the file or command and where to look, and put large detail in a file. Short snippets are fine when they are the point.
- Numbers only when they matter. Minimal headings, no emoji.
- Say plainly what is uncertain or not verified. Never hide a failure to be brief.
- Between tool calls, one short line at most.
- Offer to go deeper: \"say the word and I'll detail X\".";

const DETAILED: &str = "\
How to write your replies (Armada response style: detailed).
Do the work thoroughly and verify it; report it in a structured way that is easy to skim.
- Open with the outcome in two or three plain sentences: what happened, or what you need from the user. Put blockers, risks and decisions right after it.
- Then explain what you did and why, what you changed and where, exactly how you verified it and what the results were, what is still open, and suggested next steps. Short headings, lists or a small table are welcome when they help.
- Give the reasoning behind choices and the alternatives you rejected, briefly. Don't narrate your process step by step or restate the request.
- Include the key file names, commands and short snippets. Don't paste raw logs, whole diffs or long listings: quote the lines that matter and put the rest in a file.
- No emoji. Say plainly what is uncertain or not verified. Never hide a failure.
- Between tool calls, one short line at most.";

/// How agents are told to write their replies, for the user's chosen style. Every session pays
/// for this text, so keep each variant compact: short, concrete rules are followed best.
pub fn response_style_note(style: ResponseStyle) -> &'static str {
    match style {
        ResponseStyle::Concise => CONCISE,
        ResponseStyle::Balanced => BALANCED,
        ResponseStyle::Detailed => DETAILED,
    }
}

/// Everything Armada tells an agent about its surroundings, for the chosen response style. Added
/// to the agent's own instructions (Claude and other ACP agents: `systemPrompt` append; Codex
/// and local models: `developerInstructions`).
pub fn guidance(style: ResponseStyle) -> String {
    format!("{PICTURES}\n\n{}", response_style_note(style))
}

/// Identifies the text an agent was given (the text version and the style). An agent briefed
/// under another tag is briefed again, once, when its session is next resumed.
pub fn tag(style: ResponseStyle) -> String {
    let style = match style {
        ResponseStyle::Concise => "concise",
        ResponseStyle::Balanced => "balanced",
        ResponseStyle::Detailed => "detailed",
    };
    format!("{GUIDANCE_VERSION}:{style}")
}

/// The same text as a note ahead of a message, for sessions that can't take it as instructions.
/// `update`: the session was briefed before, so this replaces the earlier response style.
pub fn note(style: ResponseStyle, update: bool) -> String {
    let replaces = if update {
        "\nThis replaces any earlier Armada note about how to write your replies.\n"
    } else {
        "\n"
    };
    format!(
        "[Note from Armada, the app you are running in]{replaces}{}",
        guidance(style)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [ResponseStyle; 3] = [
        ResponseStyle::Concise,
        ResponseStyle::Balanced,
        ResponseStyle::Detailed,
    ];

    fn words(s: &str) -> usize {
        s.split_whitespace().count()
    }

    #[test]
    fn names_the_ways_to_show_a_picture() {
        for style in ALL {
            let g = guidance(style);
            assert!(g.contains("![short description](path)"));
            assert!(g.contains("data:image/png;base64"));
        }
        assert!(PICTURES.len() < 2000, "every session pays for this text");
    }

    #[test]
    fn every_style_has_its_own_compact_text() {
        let texts = ALL.map(response_style_note);
        for t in texts {
            assert!(!t.trim().is_empty());
            assert!(t.len() < 1800, "every session pays for this text");
            assert!(words(t) < 260);
        }
        assert_ne!(texts[0], texts[1]);
        assert_ne!(texts[1], texts[2]);
        assert_ne!(texts[0], texts[2]);
        assert!(texts[0].len() < texts[1].len() && texts[0].len() < texts[2].len());
        assert!(words(texts[0]) <= 140, "{} words", words(texts[0]));
    }

    #[test]
    fn every_style_asks_for_the_outcome_first_and_honesty() {
        for style in ALL {
            let t = response_style_note(style);
            assert!(t.contains("Open with the outcome"), "{t}");
            assert!(t.contains("verify it"));
            assert!(t.contains("not verified"));
            assert!(t.contains("Never hide a failure"));
        }
    }

    #[test]
    fn guidance_holds_the_style_note_exactly_once() {
        for style in ALL {
            let g = guidance(style);
            assert_eq!(g.matches(response_style_note(style)).count(), 1);
            for other in ALL.into_iter().filter(|o| *o != style) {
                assert!(!g.contains(response_style_note(other)));
            }
            let n = note(style, false);
            assert!(n.starts_with("[Note from Armada"));
            assert_eq!(n.matches(response_style_note(style)).count(), 1);
            assert_eq!(n.matches("You are running inside Armada").count(), 1);
            assert!(!n.contains("replaces any earlier"));
            assert!(note(style, true).contains("replaces any earlier"));
        }
    }

    #[test]
    fn the_tag_changes_with_the_style() {
        let tags = ALL.map(tag);
        assert_ne!(tags[0], tags[1]);
        assert_ne!(tags[1], tags[2]);
        assert!(tags[0].starts_with(&format!("{GUIDANCE_VERSION}:")));
    }
}
