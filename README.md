<div align="center">

<img src="apps/desktop/src-tauri/icons/icon.svg" width="96" alt="Armada icon" />

# Armada

**Command your fleet of AI agents.**

One sleek, gunmetal command deck for running **Claude**, **ChatGPT (Codex)** and **Grok** agents side by side, across all your accounts, on Windows, macOS and Linux.

`v0.1 · early preview` · MIT licensed · local-first

</div>

---

## What it does

- 🚀 **Run agents from every provider**: Claude Code, OpenAI Codex and xAI Grok Build, side by side in any project
- ⚙️ **One-click setup on any machine**: Armada installs the agent CLIs for you. No Node.js? It downloads a private, checksum-verified copy. No admin rights needed.
- 👥 **Multiple accounts per provider**: each account gets its own isolated login, so you can run two Claude Max accounts and three ChatGPT accounts at once
- ♻️ **Resume anything**: agents survive closing the window (Armada lives in the tray), crashes and reboots
- 🔔 **Sounds and notifications** the moment an agent needs you, with Approve/Deny right in the notification (Linux), a phone push via ntfy, and re-pings when an approval goes stale
- 🛰️ **Mission Control** to watch the whole fleet live, plus an **Inbox** of every pending approval
- 🌳 **Git worktree isolation**: every agent gets its own branch, with diff review, commit, merge and PR built in
- ⚖️ **Compare mode** (one prompt, several providers) and **handoff** ("have Codex review Claude's work")
- 🔁 **Rate-limit failover**: when an account hits its usage limit, continue on another signed-in account (ask first, or switch automatically)
- 🧰 **MCP servers, configured once** and given to every agent on every provider
- ⏰ **Scheduled agents** ("every weekday at 9:00, check for dependency updates")
- 🧩 **Prompt templates** with fill-in placeholders, plus **slash-command autocomplete** for each agent's own commands
- 📤 **Export** any conversation as Markdown or JSON, and search across your whole history
- ⬆️ **Updates from GitHub Releases**: signed in-place updates on Windows, macOS and AppImage
- 🧩 **Any ACP agent**: add Gemini CLI, Goose, OpenCode or your own agent as a first-class provider (with a connection test)
- 🖼️ **Image attachments** (paste screenshots) and **@file mentions** with fuzzy search
- 📱 **Mobile companion**: pair your phone with a QR code to watch the fleet, approve requests and send prompts. **Read-only share links** let teammates follow one agent live.
- 📊 **Usage meters** per account (where the provider reports them) and **custom sound packs**
- 🎨 A dark, gunmetal design built for long sessions

## How it works

Armada doesn't reimplement any agent or scrape logins. It drives each vendor's **official agent runtime** over a structured protocol, so your subscriptions are used exactly the way each vendor intends:

| Provider | Runtime | Protocol |
|---|---|---|
| Claude | Claude Code + [`claude-agent-acp`](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp) | [Agent Client Protocol](https://agentclientprotocol.com) |
| ChatGPT | Codex CLI | `codex app-server` (JSON-RPC) |
| Grok | Grok Build | ACP (`grok agent stdio`) |
| Anything else | Gemini CLI (`gemini --acp`), Goose (`goose acp`), OpenCode (`opencode acp`), … | ACP |

Accounts are isolated by giving each one its own config directory (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`). API keys live in your OS keychain.

See [`docs/PLAN.md`](docs/PLAN.md) for the full architecture and roadmap.

## Development

Requirements: Rust (stable), Node.js 20+, and on Linux the Tauri system libraries (`webkit2gtk-4.1`, `libayatana-appindicator`, `librsvg`, `alsa-lib`).

```bash
cd apps/desktop
npm install
npm run tauri dev      # run the app with hot reload
npm run dev            # UI only, in a browser, with a realistic mock backend
npm run tauri build    # produce installers for your OS
```

Tests (no network or tokens needed; a mock ACP agent stands in for the real ones):

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Handy tools for working on the core:

```bash
# One-click installer from the command line
cargo run -p armada-core --example install -- /tmp/armada-data all

# Drive a real agent end to end (prints every event, auto-approves)
cargo run -p armada-core --example smoke -- /tmp/armada-data ~/some/repo grok "Say hi"

# Point a provider at a development build of an agent
ARMADA_GROK_COMMAND="python3 my_agent.py" npm run tauri dev
```

### Layout

```
crates/armada-core/        agent supervisor, ACP + Codex clients, storage, accounts, installer
apps/desktop/src-tauri/    Tauri shell: commands, tray, sounds, notifications, terminals, git review
apps/desktop/src/          React UI
apps/remote/               mobile companion (single-file web app served by the desktop app)
scripts/gen_sounds.py      synthesizes Armada's original notification sounds
```

## License

[MIT](LICENSE)
