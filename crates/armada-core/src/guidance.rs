//! What Armada tells every agent about the place it is running in. Without this an
//! agent has no way to know its replies can show pictures, and says it can't.

/// Added to the agent's own instructions (Claude: `systemPrompt` append; Codex:
/// `developerInstructions`). Keep it short and factual: every session pays for it.
pub const AGENT_GUIDANCE: &str = "\
You are running inside Armada, a desktop app that renders your replies as markdown, and you CAN show pictures to the user.
To show a picture, put ![short description](path) in your reply. The path can be:
- an image file (png, jpg, gif, webp, svg, avif; at most 10 MB) in your working folder or project, relative or absolute, or
- an image file you saved in the system temp folder, as long as you write its full path in your reply, or
- a small png/jpeg/gif/webp as a data URI: ![description](data:image/png;base64,...) (under about 3 MB).
Armada loads the file and shows it inline in the conversation, on the phone app too. Pictures from web addresses (http/https) are never loaded: download them into your working folder first, then reference the file. Don't tell the user you can't show images; screenshots, charts and generated images you save as files can be shown this way.";

#[cfg(test)]
mod tests {
    use super::AGENT_GUIDANCE;

    #[test]
    fn names_the_ways_to_show_a_picture() {
        assert!(AGENT_GUIDANCE.contains("![short description](path)"));
        assert!(AGENT_GUIDANCE.contains("data:image/png;base64"));
        assert!(
            AGENT_GUIDANCE.len() < 2000,
            "every session pays for this text"
        );
    }
}
