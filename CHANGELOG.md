# Changelog

What's new in each Armada release. The section for a version becomes its GitHub release notes
and the notes shown by the in-app updater, so write for people using the app.
`scripts/release_notes.py` refuses to cut a release whose section is missing or empty (see
docs/RELEASING.md).

## Unreleased

### New

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

- **Pasting images on Linux.** Screenshots and image files copied in a file manager now paste
  into the message box on Wayland (Hyprland, sway, GNOME, KDE), where they were silently dropped.

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
