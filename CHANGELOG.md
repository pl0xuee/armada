# Changelog

What's new in each Armada release. The section for a version becomes its GitHub release notes
and the notes shown by the in-app updater, so write for people using the app.
`scripts/release_notes.py` refuses to cut a release whose section is missing or empty (see
docs/RELEASING.md).

## v0.1.4 — 2026-10-28

### New

- **Preview is now a pane beside the chat.** Web previews open on the right of the conversation (resizable, with a maximize button and device sizes) instead of squeezed under it. A Preview button appears in the agent header once a dev server is up, and Preview is also in the command palette and on Ctrl/⌘+Shift+P. It now picks the server the agent mentioned last, and loads servers that listen only on IPv6.
- **Localhost links open in Preview.** Clicking a `localhost` / `127.0.0.1` link in an agent's message, tool output or terminal now opens it in that agent's in-app Preview instead of your browser. Ctrl/⌘-click, Shift-click or middle-click still opens the browser.
- **Voice is one click from the composer.** A mic button starts on-device dictation and a
  waveform button talks to Armada (GPT voice); if either isn't set up yet, it points you to the
  right Settings page.
- **Commit & merge says the merge is local** and offers a "Push to origin" button, with a
  copyable command.

### Fixed

- **Voice dictation starts.** Pressing the mic in 0.1.3 failed with "Couldn't start dictation:
  state not managed for field `core`". A new check keeps this kind of mistake from reaching a
  release again. Dictation also no longer leaves the microphone open when stopped mid-start, and
  ends itself at the recording limit.
- **"Waiting on N sub-agents" stays put** instead of jittering or disappearing while background
  sub-agents run, and their activity no longer reshuffles the conversation.
- **A tidier composer.** The status row says "Working…" or "Waiting for approval" without a
  double Esc hint crowding it out (press Esc twice still stops), dictation and voice are one
  compact control, and Send/Queue stay greyed out until there's something to send.
- **Agent view keeps room for the conversation.** The header is one fixed-height row, the queue
  folds to a one-line summary, the usage-limit card is a single card, and toasts, the voice panel
  and "Jump to latest" no longer cover the composer or text.
- **Voice assistant asks before acting.** Starting an agent or sending a message needs your
  on-screen Confirm (Enter) or Cancel (Esc), and assistant-started agents always ask before
  acting. The mic is muted while it talks unless you turn on the headphones setting, usage is
  saved as you go, and a temporary error no longer hides a session that is still running.
- **Safer by default.** The Run button on code blocks asks first for anything beyond plain build,
  test and read-only commands; GitHub CLI calls get the same git hardening as Armada's own git
  commands; more credentials are redacted (URL passwords, auth headers, JWTs, GitLab, npm, Stripe,
  Google and Hugging Face tokens); desktop Approve buttons only appear for short commands with no
  hidden characters; local model servers no longer follow redirects.
- **Secrets survive a locked keychain.** A locked or failing OS keychain no longer wipes saved MCP
  and agent secrets, and unresolved secrets are no longer passed to agents as `keychain:` text.
- **Checkpoints are more reliable.** No stale snapshot after a branch switch, reset or pull; more
  credential files are kept out of snapshots; deleting an agent with unsaved work keeps its
  checkpoints; Restore is disabled while the agent works.
- **Cancel means cancel.** Cancelling while the pre-message checkpoint runs now stops the turn
  instead of sending the message anyway.
- **Undo after deleting an agent** keeps its terminals and composer draft.
- **Accurate turn summaries.** The "files changed" card counts files changed by shell commands,
  and fast-exiting terminals show as exited.
- **Linux fixes.** Agents, tools and terminals no longer inherit the AppImage's library paths
  (fixes curl/git symbol errors); Armada starts without a tray library; on Wayland, Settings
  explains how to bind `armada --new-agent`, which now also works on a cold start.
- **The remote server recovers by itself** after a network drop. Launching at login no longer
  flashes the window, and quitting via log-off still shuts agents down cleanly.
- **Less battery use.** Preview detection pauses while the window is hidden or unfocused.
- **Phone.** Local-model agents can be started, pairing messages are accurate, "Try again" reuses
  the same code, expired share links say so, shared agents load full history, and a "Can't reach
  Armada" page shows if the app can't load.
- Makefile variable assignments no longer show up as run targets, and usage meters drop windows
  that already reset.

## v0.1.3 — 2026-10-28

### New

- **Talk to Armada with the voice assistant.** Press Ctrl/Cmd+Shift+A (or the new title bar button) and
  speak: ask what your agents are doing, start an agent in one of your projects, message or stop one,
  or jump to Mission Control, the inbox or an agent's diff. A small panel shows live captions, what it
  did (with an Open link for each action), the elapsed time and an estimated cost, and you can mute or
  end it any time. It can never approve or deny permissions, delete or archive agents, commit, push or
  change settings. It's off by default and needs an OpenAI API key account (add one in Accounts, then
  choose it in Settings > Voice assistant). Your voice and the agent information it reads are sent to
  OpenAI's Realtime API and billed to that account per minute; sessions end on their own after a
  maximum length or silence you choose.
- **Run models on your own computer.** A new "Local" provider runs agents on Ollama, LM Studio, or any
  OpenAI-compatible server (llama.cpp, vLLM, a GPU box on your network) instead of a cloud account. Add
  a server in Accounts and Armada detects Ollama and LM Studio for you, shows what's running and which
  models it has, and lets you pick one (and switch later) when you start an agent. With Ollama you can
  download a recommended coding model from inside the app. Local agents are free, need no sign-in, and
  nothing leaves your computer unless you point at another machine, which Armada warns about. Small
  models can struggle with tool use and long tasks. Needs the Codex CLI installed, and a server that
  supports the OpenAI Responses API.
- **Run commands from the chat.** Shell code blocks in an agent's replies now have a Run button
  (Ctrl/Cmd+Enter when the block is focused) that opens a new terminal in the agent's workspace
  panel and runs the commands there. Anything beyond plain common commands asks first, and "Paste
  without running" puts the commands in the terminal and leaves pressing Enter to you.
- **You can tell when an agent is done.** The thinking indicator now turns into a "Done" line with
  the turn's time (or "Stopped" / "Stopped with an error"), the status pill shows a green "Done"
  until your next message, the window title shows what the selected agent is doing, the taskbar
  highlights when an agent finishes or needs approval while you're away, and the message box
  invites a reply. A soft chime plays when the agent you're watching finishes a task longer than 30
  seconds (Settings, Notifications).
- **Checkpoints.** Every message you send saves a snapshot of the agent's files first. "Restore
  to here" on any of your messages puts the files back the way they were (with a preview of what
  changes), and "Restore and edit prompt" lets you try again differently. Restores can be undone.
  Works in any git project; your branch, commits and staged changes are never touched.
- **Workspace panel.** Real terminals in each agent's folder, one-click project scripts (npm,
  pnpm, yarn, bun, cargo, make, just, pytest, go), and "Send to agent" to paste output into the
  message box. Toggle with Ctrl/Cmd+`.
- **Live preview.** When an agent (or one of your terminals) starts a dev server, it appears in the
  workspace panel's Preview tab, next to the conversation. Switch device widths, reload, or open it
  in your browser. Only servers on your own computer are shown.
- **See every running sub-agent.** The title bar shows how many sub-agents are running across all
  agents, agent list rows show their own count, and the agent header lists each one with its task,
  current step and running time; click one to jump to it. Background sub-agents (started in
  parallel) now count as running until they finish, instead of disappearing right away.
- **You can see when the agent is thinking.** From the moment you send a message until the agent
  replies, an animated indicator with elapsed time shows it's working, including pauses between
  steps.
- **Pull request and CI status.** Each agent shows its PR, check results and review state. "Fix
  CI" sends the failing logs to the agent; "Address comments" sends reviewers' feedback. You see
  and can edit the message first.
- **Voice dictation.** Speak instead of typing: press the mic in the message box (or
  Ctrl/Cmd+Shift+D). Speech is transcribed on your computer with Whisper; audio never leaves it.
  The speech model downloads once, when you choose to (~142 MB by default).
- **Syntax highlighting** in code blocks, diffs and commands, matching each theme.
- **Plan and usage limits while you work.** The agent header shows your plan (e.g. "Claude Max 20x")
  and your 5-hour and weekly usage, colored as you near a limit. Click it for both meters and
  when each resets. Claude limits update as the agent works; Codex limits as before.
- **Quieter timeline.** A run of tool calls, thoughts and in-between messages folds into one line
  that shows the current step while the agent works, then a summary ("Read 4 files, edited 2
  files, ran 3 commands"). Press the arrow to see every step. Answers, approvals, plans and
  errors stay in view.
- **Interface scale.** Make the whole app bigger or smaller in Settings → Appearance (75–150%),
  or with Ctrl/Cmd `=` / `-` / `0`.

### Fixed

- **Faster while agents work.** Streaming replies no longer re-render the whole agent view, sending a
  message waits much less for its checkpoint on large projects (and never more than a few seconds), and
  very long code blocks stay smooth while they stream in.
- **UI polish.** The workspace panel never pushes the message box off screen, background sub-agents show
  as running, dictation types into the message box you're using, the pull request chip says "2 failing",
  shortcut hints match your platform, and lists line up their status icons and actions. Buttons that only
  had an icon now have labels for screen readers.
- **Safer git and pull-request prompts.** Armada's own git commands (commit, merge, push, delete) no longer
  run programs or hooks that a project's `.git/config` configures, such as filters, pagers, editors, SSH
  commands or a repository-local hooks folder (such as husky's; run those hooks from your terminal), and refuse to push when the project's config rewrites push
  addresses; your own global git settings (like Git LFS) keep working. Deleting an agent's worktree can no
  longer remove folders outside Armada's own worktrees folder. "Fix CI" and "Address comments" now label
  CI logs and review comments as text written by other people, show who wrote each one, leave out comments
  from people outside the project unless you choose to include them, and the preview says to review it
  before sending. Restored conversation history is quoted as history, not instructions. Committing from the
  review sheet asks first when new files look like secrets (`.env`, `*.pem`, `id_rsa`, ...) and can leave
  them out. New schedules start in Ask mode in their own worktree, and choosing Auto explains the risk.
  Codex agents that reattach to an earlier thread keep the same sandbox and approval settings.
- **Safer phone pairing and share links.** The pairing QR code no longer contains a permanent key: it holds a
  one-time code that works once and expires after 5 minutes, and each phone gets its own key. Settings, Remote
  lists your paired devices (name and last seen) with a Revoke button for each, plus "Unpair all". Phones that
  were already paired keep working as one "Previously paired phone" until you revoke it. Keys and share links are
  stored only as hashes. Share links now expire (1 hour, 24 hours or 7 days; 24 hours by default) and stop when
  the agent is archived or deleted. People with a share link see the conversation with secrets hidden and a short
  outline of the tools the agent ran, but no command output, file contents, diffs, approval requests or local
  paths. Remote access over the network now refuses public addresses (use Tailscale), limits connections per
  device, rejects requests from other websites, and says plainly that traffic on the local network is not
  encrypted. The phone app only follows pasted pairing links to private addresses without asking, and no longer
  re-displays its own credentials.
- **Safer Run button and links.**
  - Code blocks containing hidden or control characters (the kind that can make a command look different
    from what runs) show a warning with those characters made visible, and can't be run or pasted.
  - Run now asks first for anything except plain common commands (`ls`, `git status`, `npm test`,
    `cargo build`, ...); pipes, redirects, `$(...)`, `sudo`/`doas` and the like always show the full
    command for confirmation.
  - Long permission requests no longer offer Approve/Deny in a desktop notification (the text may be
    clipped); open them in Armada to review the whole command.
  - Links in terminal output only open http(s) and mail links in your browser, and a message link whose
    text names one site but goes to another asks before opening.
  - Local model servers: addresses with a username or password, and link-local or cloud-metadata
    addresses, are refused, downloads are limited to your own machine or network, and `127.evil.com` is
    no longer treated as this computer.
- **Agent CLIs install pinned, verified versions.** Armada now installs exact, tested versions of Claude Code, Codex and Grok (not "latest"), downloads a pinned Node.js whose checksum is built into the app, and only runs the install scripts those CLIs need.
- **Pasting images on Linux.** Screenshots and image files copied in a file manager now paste
  into the message box on Wayland (Hyprland, sway, GNOME, KDE), where they were silently dropped.
- **Privacy hardening.**
  - Phone pushes now say only which agent needs you and why. Showing the agent's own message text is opt-in
    (Settings → Phone push → Push detail), and secrets are scrubbed from it.
  - Secrets in MCP server and custom agent settings (environment values and headers) are kept in your OS
    keychain instead of Armada's database; existing ones move over automatically.
  - Checkpoints no longer snapshot untracked credential files (`.env`, `*.pem`, `*.key`, `id_rsa*`,
    `.npmrc` and similar), and restoring a checkpoint never touches them.
  - Agent output is no longer written to Armada's log files by default, log files are private to you, and
    each day's log is capped at 20 MB.
  - Pasting an image path as text only attaches files inside the agent's project, and linked or
    non-image files are refused.

## v0.1.2 — 2026-10-28

### Remote control from your phone

- Start Claude, Codex, Grok and custom ACP agents from the phone, with photos, per-provider
  mode/model/effort and account switching.
- Stop, resume and archive agents; edit the queue, send now or clear it; review the diff and
  Commit or Commit & merge.
- See screenshots, sub-agent cards and turn summaries.
- Faster, smaller phone app (80 KB), smoother on iOS, safer swipe approvals, better accessibility.
- Hardened server: authentication before anything is read, per-token stream limits, read-only
  share links with a field allowlist.

### Desktop

- Message queue, sub-agent cards, a "Done" review card and a Needs-you triage view (Ctrl/Cmd+J).
- Approve from the keyboard, including deny-with-reason.
- Prompt-first home screen with remembered defaults, and Auto/Ask per agent.
- Comment on diff lines, revert a file or a hunk.
- Paste and test MCP servers, find projects automatically, compact long conversations,
  shortcut cheat sheet.
- Faster with long conversations: batched events, paged and virtualized timeline, lazy diffs,
  smaller download.

### Fixes

- Stopping, sending and starting agents no longer race. The queue survives restarts, and hung or
  orphaned agent processes are always cleaned up; no agent outlives the app.
- A start cancelled by "send now" is no longer reported as a crash.
- Each account's environment is isolated, so API keys from your shell don't leak into the wrong
  account.
- Safer worktree deletion, recovery from a damaged database, and data files readable only by you.
- Sign-in cleanup works on macOS, and projects show their real folder names on case-insensitive
  disks.
- More robust notifications, sounds, terminal, signal handling, logs and update checks.

## v0.1.1 — 2026-10-28

- **Works in any window size.** Built for tiling window managers (Hyprland, i3, sway) that
  ignore minimum sizes: every screen adapts from 560 to 2560 px wide and down to 600 px tall.
- The agent list docks beside the conversation on wide windows and becomes a drawer on narrow
  ones (Ctrl/Cmd+B).
- Headers, the composer toolbar and the title bar fold into icons and menus instead of clipping.
  Settings uses a pill strip on narrow windows, and dialogs become sheets.

## v0.1.0 — 2026-10-28

First release: one desktop app to run Claude Code, OpenAI Codex, xAI Grok and any ACP agent side
by side, across several accounts.

- Agents in isolated git worktrees, with review, commit, merge and pull requests built in.
- Multiple accounts per provider, API keys in the OS keychain, and switching accounts when one
  hits its usage limit.
- MCP servers for every provider, schedules, templates, slash commands, image attachments and
  `@file` search.
- One-click setup that installs Node.js and the agent CLIs without admin rights.
- Tray, sounds, notifications you can approve from, quiet hours, ntfy push, a global hotkey and
  autostart.
- Mission Control, Inbox, Compare, Usage, Schedules and a command palette, in three themes.
- A phone companion for pairing, approvals and prompts.
- Signed automatic updates.
