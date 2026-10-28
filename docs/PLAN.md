# Armada — Master Plan

> **Command your fleet.** One sleek, gunmetal command deck for running Claude, ChatGPT (Codex) and Grok agents side by side, across as many accounts as you own, on Windows, macOS and Linux.

> **Status (v0.1.2): this is the original design document.** What shipped differs in places:
> - **One process, no daemon.** Agents run inside the app's own core (`crates/armada-core`). The tray keeps the app (and the agents) alive when the window closes, and agents resume after restarts and crashes. There is no separate `armadad` or local socket.
> - **Crates.** `armada-core` (supervisor, ACP and Codex clients, storage, accounts, installer) plus the Tauri shell (`apps/desktop/src-tauri`). Storage is `rusqlite`.
> - **UI stack.** React, zustand, Radix, cmdk, motion, xterm, react-markdown and @tanstack/react-virtual; npm, not pnpm. Sounds live in `apps/desktop/src-tauri/sounds`.
> - **Shipped beyond the plan:**
>   - the phone companion (`apps/remote`, remote control for every provider);
>   - the "Needs you" triage view;
>   - per-agent Auto/Ask mode;
>   - queued messages;
>   - sub-agent cards and turn summaries;
>   - MCP paste and test;
>   - file and hunk revert.
> - **Answered open questions:** permissions default to Auto (Ask per agent or in Settings); failover is off, ask or auto; phone push goes through ntfy.
> - **Not yet built:** custom themes, auto-compact controls beyond the agent's own `/compact`, push targets other than ntfy, the plugin API, team mode, package-manager distribution (winget/Homebrew/AUR/Flatpak), and Playwright end-to-end tests.

---

## 1. Vision

Armada is a desktop **agent command center**. You launch agents from any provider into any project folder, watch them work live, approve what they want to do, review their diffs, and switch accounts in one click. When an agent needs you, Armada makes a sound and sends a notification. If the app closes, crashes or the machine reboots, every agent comes back exactly where it was.

Design pillars:

1. **Zero friction**: install, sign in, type a prompt. No config files required.
2. **Provider neutral**: Claude, ChatGPT and Grok are first-class citizens, and any other ACP agent works too.
3. **Never lose work**: agents outlive the window, and every session is resumable.
4. **Attention, not babysitting**: Armada tells you when you're needed and stays quiet otherwise.
5. **Beautiful by default**: dark, gunmetal, fast, fluid.
6. **Open source and local-first**: MIT licensed, no telemetry by default, your keys stay in your OS keychain.

---

## 2. The key architectural decision: drive the official agents

Armada does **not** reimplement Claude/GPT/Grok agents or scrape login tokens. It orchestrates each vendor's **official agent runtime** over a structured protocol:

| Provider | Runtime | How Armada talks to it | Sign-in options |
|---|---|---|---|
| **Claude** | Claude Code (`claude`) | ACP via `@agentclientprotocol/claude-agent-acp` (fallback: `claude -p --input-format stream-json --output-format stream-json`) | Claude Pro/Max subscription, Console API key, Bedrock/Vertex |
| **ChatGPT / OpenAI** | Codex CLI (`codex`) | `codex app-server` JSON-RPC (native, ships TS bindings via `generate-ts`); `codex-acp` as fallback | ChatGPT Plus/Pro/Team account, OpenAI API key |
| **Grok** | Grok Build (`grok`) | `grok agent stdio` (native ACP) | SuperGrok / X Premium+ subscription, xAI API key |
| **Anything else** | Gemini CLI, OpenHands, Goose, … | Generic ACP client | Per agent |

Why this is the right call:

- **It stays within each vendor's terms.** Subscriptions are used through the vendor's own client, the way they intend. Armada never extracts OAuth tokens to call APIs directly.
- **You get every vendor's newest features for free**: tools, sandboxing, subagents, MCP, skills, model updates. When Anthropic ships something, Armada gets it on the next CLI update.
- **ACP (Agent Client Protocol)** is the emerging standard for agent ↔ client communication (Zed, JetBrains, Neovim, Windows Terminal, 25+ agents). Building on it makes Armada future-proof. Every new ACP agent works with no extra code.
- **Resume is native.** Each runtime persists its own sessions (`claude --resume <id>`, `codex resume`, `grok sessions` / ACP `session/load`). Armada stores the session IDs and rehydrates.

Armada manages the CLIs too: it detects installs, offers one-click install/update, and pins known-good versions.

---

## 3. Tech stack

| Layer | Choice | Why |
|---|---|---|
| App shell | **Tauri 2** (Rust) | Native on Win/Mac/Linux, ~10 MB installers vs ~150 MB Electron, low RAM, first-class tray, notifications, updater, global shortcuts, deep links |
| Core / daemon | **Rust** (tokio, serde) | Process supervision, ACP/JSON-RPC streams, crash safety |
| Frontend | **React 19 + TypeScript + Vite** | Biggest ecosystem, best component libraries |
| Styling | **Tailwind CSS v4** + CSS variables design tokens | Fast theming, gunmetal palette in one place |
| Components | **shadcn/ui** (Radix primitives) | Accessible, fully ownable, restyled to Armada's look |
| Motion | **Motion** (Framer Motion) | Fluid micro-interactions, layout animations |
| Command palette | **cmdk** | Ctrl/⌘+K for everything |
| Terminal | **xterm.js** (WebGL renderer) | Live view of agent shells |
| Code/diffs | **CodeMirror 6** + merge view, **Shiki** highlighting | Fast, lightweight diff review |
| State | **Zustand** (UI) + **TanStack Query** (daemon data) + **TanStack Router** | Simple, typed |
| Storage | **SQLite** (`sqlx`, WAL mode) | Agents, events, accounts metadata, settings |
| Secrets | OS keychain via **`keyring`** crate | Keychain / Credential Manager / Secret Service |
| Audio | **rodio** (Rust side) | Low-latency sounds even when the window is hidden |
| Rust ↔ TS types | **specta / tauri-specta** | Single source of truth for IPC types |
| Tests | cargo test, **Vitest**, **Playwright**, a fake ACP agent for E2E | Deterministic agent tests without burning tokens |
| CI/CD | GitHub Actions matrix + `tauri-action` | Signed builds for all 3 OSes on each tag |

**Caveat to track:** on Linux, Tauri uses WebKitGTK, which can lag Chromium on heavy animation. We'll keep animations GPU-friendly (transform/opacity only) and test on Linux early. If it's a real problem, the frontend is portable to Electron with minimal changes.

---

## 4. Architecture

```
┌──────────────────────── Armada Desktop (Tauri window) ────────────────────────┐
│  React UI  ── typed IPC (tauri-specta) ──►  thin Tauri commands               │
└──────────────────────────────────┬────────────────────────────────────────────┘
                                   │ local socket (Unix socket / Windows named pipe)
┌──────────────────────────────────▼────────────────────────────────────────────┐
│  armadad — background daemon (Rust)                                            │
│   • Supervisor: spawns / watches / restarts agent processes                    │
│   • Adapters: ACP client · Codex app-server client · stream-json fallback      │
│   • Event log: every message, tool call, permission request → SQLite           │
│   • Attention engine: decides when to ping you (sound + notification + tray)   │
│   • Account vault: profiles → isolated config dirs + keychain secrets          │
│   • Worktree manager: git worktree per agent                                   │
└───────┬──────────────────────┬──────────────────────┬─────────────────────────┘
        │ ACP                  │ JSON-RPC             │ ACP
   claude-agent-acp       codex app-server       grok agent stdio
   (Claude Code)          (Codex CLI)            (Grok Build)
```

**Why a separate daemon?** Closing the window does not kill your agents. Armada lives in the tray, agents keep working, and notifications still fire. Reopening the UI reattaches instantly. If the daemon itself dies, it's restarted and rehydrates from SQLite.

### Repo layout (monorepo: pnpm workspaces + Cargo workspace)

```
armada/
├─ apps/desktop/            # Tauri app (src-tauri + React frontend)
├─ crates/
│  ├─ armada-core/          # domain model, SQLite, event log, settings
│  ├─ armada-daemon/        # armadad binary, supervisor, IPC server
│  ├─ armada-acp/           # ACP client
│  ├─ armada-codex/         # Codex app-server client
│  ├─ armada-accounts/      # profiles, keychain, config-dir isolation
│  └─ armada-attention/     # sounds, notifications, rules
├─ packages/
│  ├─ ui/                   # design system (tokens, components)
│  └─ protocol/             # generated TS types
├─ assets/sounds/           # original CC0 sound pack
└─ docs/
```

---

## 5. Multi-account switching

Each **Account Profile** = provider + display name + avatar color + auth method + an **isolated config directory**:

- Claude → `CLAUDE_CONFIG_DIR=<armada>/profiles/<id>/claude`
- Codex → `CODEX_HOME=<armada>/profiles/<id>/codex`
- Grok → isolated grok home per profile (verify the supported env var / home override during Phase 2)
- API keys → stored in the OS keychain, injected as env vars only into that agent's process

Because each profile has its own config dir, you can be logged into **two Claude Max accounts and three ChatGPT accounts at once**, running agents on all of them simultaneously.

UX:
- Account switcher in the top bar (avatar stack), and per agent at launch.
- "Sign in" button runs the vendor's own login flow (browser OAuth) inside that profile's directory.
- **Usage meters** per account (tokens, cost, rate-limit window where the runtime reports it).
- **Rate-limit failover** (opt-in): when an agent hits a limit, Armada offers to continue on another account of the same provider, carrying the conversation via fork/resume where supported, or a generated handoff summary where not.

---

## 6. Resume anything

- Every agent is a row in SQLite: id, provider, account, cwd, worktree, provider session id, status, model, timestamps.
- Every event is appended to an event log as it arrives, so the UI can re-render full history without asking the provider.
- On startup, agents that were running are marked **Interrupted** and shown in a "Pick up where you left off" panel. One click (or auto-resume, if enabled) relaunches with the provider's native resume and the same session id.
- If a provider session can't be resumed (deleted, expired), Armada offers **Rebuild from transcript**: a fresh session seeded with a compact summary of the logged history.
- Crash safety: SQLite WAL, fsync on status transitions, daemon watchdog.

---

## 7. Attention system: sounds and notifications

Agent states: `Working · Needs approval · Needs input · Done · Error · Rate-limited · Interrupted`

| Event | Default sound | Notification | Tray |
|---|---|---|---|
| Needs approval (tool/permission) | "ping-alert" (two-tone, rising) | Yes, with **Approve / Deny / Open** buttons | Badge + pulse |
| Needs input (question) | "chime-question" | Yes, with **Reply** inline (where the OS supports it) | Badge |
| Done | "chord-complete" (soft) | Yes | Check |
| Error / rate-limited | "low-thud" | Yes | Red dot |

- **Smart muting**: no sound if you're already looking at that agent. Quiet hours. Do-not-disturb sync.
- **Escalation**: if an approval waits more than N minutes, re-ping once (configurable).
- **Sound packs**: original CC0 sounds designed for Armada (synth + metallic, matching the gunmetal theme). Users can drop in custom `.wav/.ogg` per event. Per-provider sound variants optional.
- Taskbar flash (Windows), dock bounce (macOS), urgency hint (Linux).
- **Phone push** (optional): ntfy.sh / Pushover / Discord / Slack webhooks, so you can step away from the desk.

---

## 8. UI and visual design

### Theme: "Gunmetal"

| Token | Value | Use |
|---|---|---|
| `--bg-0` | `#0B0D10` | App background (near-black, cool) |
| `--bg-1` | `#12151A` | Sidebars |
| `--bg-2` | `#191D23` | Cards, panels |
| `--bg-3` | `#21262D` | Hover, elevated |
| `--gunmetal` | `#2C3539` | Signature surfaces, active states |
| `--border` | `#2A3038` | Hairlines (1px) |
| `--text-1` | `#E6EAEF` | Primary text |
| `--text-2` | `#9AA4B2` | Secondary |
| `--steel` | `#7D8B99` | Icons, muted accents |
| `--accent` | `#4FC3F7` | Ice-blue focus/primary action |
| `--warn` / `--ok` / `--err` | `#F5B544` / `#3DDC97` / `#FF5C6C` | Status |
| Claude / OpenAI / Grok | `#D97757` / `#10A37F` / `#E5E7EB` | Provider identity chips |

- Subtle brushed-metal noise texture on the chrome, 1px inner highlights for a machined edge, soft glows on live agents.
- Fonts: **Geist** / **Inter** for UI, **JetBrains Mono** for code.
- Custom frameless title bar with native window controls per OS.
- Every animation ≤ 200 ms, transform/opacity only; respects "reduce motion".

### Layout

```
┌──────┬────────────────────┬───────────────────────────────────────┬──────────────┐
│ Rail │ Agents             │  Agent: "Fix auth bug" · Claude · Max#2│  Inspector   │
│      │ ● Fix auth bug   ⚠ │  ────────────────────────────────────  │  Files (4)   │
│ 🏠   │ ● Refactor API   ⟳ │  You: fix the token refresh race…      │  Plan / Todo │
│ 📁   │ ✓ Write tests      │  ▸ Read src/auth.ts                    │  Context 41% │
│ 📥 3 │ ● Grok: research ⟳ │  ▸ Edit src/auth.ts   [view diff]      │  Cost $0.42  │
│ ⚙    │                    │  ⚠ Wants to run: npm test  [Allow][Deny]│  Worktree    │
│      │ + New agent  ⌘N    │  ┌ Prompt… (@file, /cmd)        ⏎ ┐    │              │
└──────┴────────────────────┴───────────────────────────────────────┴──────────────┘
```

Views:
- **Agent view**: chat timeline with collapsible tool-call cards, inline diffs, live terminal tab.
- **Mission Control**: a grid of live agent tiles (status, last action, progress), like a security-camera wall for your fleet.
- **Inbox**: every pending approval/question across all agents in one queue, keyboard-driven (`A` approve, `D` deny, `J/K` move).
- **Compare**: send one prompt to Claude, GPT and Grok at once, view results side by side, keep the best.
- **Review**: per-agent diff review with hunk-level accept/reject, then commit / open PR.

---

## 9. Feature list ("all the bells and whistles")

**Core**
- Launch agents per project folder; pick provider, account, model, permission mode
- Live streaming output, tool calls, plans/todos
- Approvals with "allow once / always for this session / always for project"
- Full resume after close/crash/reboot
- Multi-account profiles with isolated logins
- Sounds, OS notifications with actions, tray badge, phone push

**Power**
- **Git worktree isolation**: each agent works in its own worktree/branch, so agents never trample each other
- Diff review, commit, PR creation (via `gh`)
- **Handoff**: "send this to Grok for a second opinion" / "have Codex review Claude's diff"
- Compare mode across providers
- Shared **MCP server manager**: configure once, available to all providers
- Prompt/template library with variables; slash commands
- Scheduled and recurring agents (cron-style)
- Global hotkey quick-launch (`Ctrl/⌘+Shift+Space`) from anywhere in the OS
- Usage and cost dashboard per provider/account/project
- Context-window meter and auto-compact controls
- Full-text search across all agent history
- Export transcripts (Markdown/JSON)

**Polish**
- Command palette for every action
- Fully keyboard navigable
- Onboarding wizard: detects installed CLIs, installs missing ones, walks through sign-in
- Auto-updater (signed), release notes in-app
- Themes: Gunmetal (default), Carbon, Titanium (light), plus custom themes

**Later**
- Plugin API (custom adapters, panels, sound packs)
- Mobile companion / remote control over a secure tunnel
- Team mode: share agent sessions read-only

---

## 10. Security and privacy

- Secrets only in the OS keychain; never written to SQLite or logs.
- Each agent process gets only its own profile's env/config.
- Vendor permission modes are surfaced clearly; "YOLO" modes require explicit, per-project opt-in with a visible warning badge.
- No telemetry by default. Opt-in anonymous crash reports only.
- Daemon socket restricted to the current user (file perms / named-pipe ACL).
- Signed releases, signed updates.

---

## 11. Distribution

| OS | Formats |
|---|---|
| Windows 10/11 | NSIS `.exe` installer (per-user, no admin), winget |
| macOS 12+ | Universal `.dmg` (Apple Silicon + Intel), notarized, Homebrew cask |
| Linux | AppImage, `.deb`, `.rpm`, Flatpak, AUR |

GitHub Actions builds all of them on every tag via `tauri-action`; the Tauri updater serves signed delta updates from GitHub Releases.

---

## 12. Roadmap

| Phase | Goal | Deliverables |
|---|---|---|
| **0: Foundation** | Skeleton that runs everywhere | Monorepo, Tauri app, design tokens, CI building on 3 OSes, SQLite schema, daemon + IPC |
| **1: First agent** | Claude end to end | ACP client, Claude adapter, chat timeline, approvals, event log, **resume**, notifications + sounds |
| **2: Fleet** | All 3 providers + accounts | Codex app-server adapter, Grok ACP adapter, account profiles, account switcher, onboarding wizard |
| **3: Command deck** | Multi-agent power | Mission Control, Inbox, worktrees, diff review, commit/PR, tray mode |
| **4: Shine** | Bells and whistles | Compare mode, handoff, MCP manager, usage dashboard, templates, global hotkey, phone push, sound packs |
| **5: 1.0** | Ship it | Signing/notarization, auto-update, docs site, store/package listings |
| **Beyond** | Ecosystem | Plugins, mobile companion, team mode |

---

## 13. Open questions

1. **Licensing**: MIT (current) vs Apache-2.0 (adds an explicit patent grant).
2. **Default permission posture**: ask for everything (safest) vs auto-allow read-only tools (smoother)?
3. **Rate-limit failover**: off, prompt, or automatic by default?
4. **Phone push** in v1, or later?
