# Changelog

What's new in each Armada release. The section for a version becomes its GitHub release notes
and the notes shown by the in-app updater, so write for people using the app.
`scripts/release_notes.py` refuses to cut a release whose section is missing or empty (see
docs/RELEASING.md).

## Unreleased

### New

- **GitHub, built in.** A new **GitHub** button in the Review panel does what used to need a terminal. **Sign in** runs `gh auth login` in a window and then connects git to that sign-in, which is what pushes from Armada were missing (git can't ask for a password here). **Push** sends the agent's current branch to GitHub, never forced. **Create repository & push** turns the project into a new GitHub repository (setting up git and making a first commit if the folder has none, leaving out files that look like secrets such as `.env`), private by default. Pushes that fail for lack of credentials now say so and point to the button, instead of a bare git error.

- **Start up to 8 agents at once on the same task.** The home composer and the New agent dialog have an **Agents** stepper (1 to 8). With more than one, each agent runs in its own worktree and branch, so they can't overwrite each other, and Start becomes “Start 4”. They open together inside their project, in a grid that fits the window (4 as 2×2, 8 as 4×2; fewer columns in a narrow window, then tabs), numbered Claude #1, #2… If some fail to start, the prompt is kept and a retry starts only the ones that failed, in the same grid. It needs a git repository, and Armada tells you when the folder isn't one.

- **Projects tab.** The first tab is now **Projects**, and the sidebar is organised by project: each folder is a row with its agents under it, a count, a “N need you” badge and a **+**. Click a project to see all its agents together in the same grid, with a box underneath to start more of them (1 to 8 at a time) in that project; **+** takes you straight to that box. Click an agent's card (or **Tell it something**) to select it, and the box becomes that agent's own message box, so you can tell it something without leaving the grid; **New agents** switches back. **Open** goes to the agent's conversation, and the **project button at the top left** of it brings you back to the grid with that agent still selected. Projects that need you come first, and ⌘1–9 follow the new order.

### Fixed

- **Agents that were already running still said they can't show pictures.** Claude ignores new instructions when an existing conversation is resumed, so only brand-new agents knew. Existing agents now get a short note about it ahead of their next message, once.

## v0.1.10 — 2026-10-29

### New

- **Armada brings its own Claude Code, Codex and Grok.** It installs its own pinned copies in the background, uses them instead of whatever is on this computer, and keeps them up to date by itself (new releases come from the official npm registry, checked every few hours, and never wait for an Armada release). Signing in, checking an account and running agents no longer depend on your PATH, launcher scripts or installed versions. A new **Settings → Agent tools** page shows each tool's version, whether it is bundled or a system install, and has **Update**, **Check for updates**, **Roll back** to the version Armada was tested with, and an **Update automatically** switch. Every update is verified and rolled back if the tool no longer starts, and updates wait while an agent of that provider is mid-turn.

- **Agents know they can show pictures.** Armada now tells Claude and Codex that their replies can embed images (`![description](path)` for a file in the project or a temp file they mention, or a small inline `data:` picture), so they stop saying they can't. Inline `data:` pictures (png, jpeg, gif, webp) now display on the desktop and the phone.
- **Plan approval.** When Claude finishes planning and asks to start coding, the plan appears as a card you can read (rendered as markdown) with clear choices: approve and auto-accept edits, approve and review each edit, or keep planning, optionally with feedback. On the desktop and the phone. Keyboard shortcuts never pick an "always allow" choice for a plan.
- **Project settings.** Settings → Projects (or an agent's menu → Project settings) lets you edit a project's `CLAUDE.md` and `AGENTS.md`, manage its permission rules (always allow / ask / deny, shared or local), and see its hooks, custom commands and skills.
- **Budgets.** Set a daily cap and a per-agent cap (Settings → Budgets). Armada warns at 80% and again when a cap is hit, and can pause the agents that went over (their queued messages stay queued). The Usage view shows today's spend against the daily cap, and agents near their cap show a badge.

### Changed

- **A live line shows what the agent is doing.** Under the last message, one quiet line says what it is working on right now ("Running `npm test`", "Reading src/app.ts", "Editing 2 files", "Thinking…", "Writing…") with the elapsed time, like Claude on the web. While sub-agents run it reads "Waiting on N sub-agents"; open it to see each one's kind, description, model and effort (or what it inherits), time running and tool calls so far. The same chips show on sub-agent cards. On the phone and the desktop.
- **The conversation no longer jumps around.** What the agent says now always stays in view: before, a message you were reading could fold into a "used 1 tool" line when the next step started, and fold back out again later, and a lone tool call popped in and out while "Waiting on N sub-agents" was showing. Only runs of two or more tool calls and thoughts fold into one line now, and what is folded depends only on the conversation itself (not on what is on screen or what the agent is waiting for), so a row never changes under you. On the phone and the desktop.
- **Phone: tool calls are small.** Commands and edits start collapsed, even while running or after failing: a running command shows its newest output line in its row, a failed one an "exit N" badge, and tapping opens it. The opened command and its output have a height limit and scroll.
- Command output no longer shows the markdown fence (` ```console `) the Bash tool wraps it in, on the phone and the desktop.

### Fixed

- **Codex sign-in showed a blank window.** Armada ran a launcher script that re-checks for updates over the network before every start (a minute or more, then nothing). Programs are now looked up so such launcher scripts are skipped, which also speeds up GitHub (`gh`) features.

## v0.1.9 — 2026-10-29

### New

- **Agents can ask you questions.** When Claude asks you to choose (its multiple-choice questions, like in Claude Code), Codex asks for input, or an MCP server needs details, the question now appears as a card in the conversation: pick options (one or several), type your own answer under "Other", fill in text, yes/no or number fields, then Submit or Skip. On the desktop, number keys pick, arrows move and Enter submits. The agent waits for you like it does for an approval: it shows **Needs you**, lands in the Inbox, Triage and Mission Control, and notifies you. It works from the phone too. Before, Claude's question tool was switched off in Armada and Codex's questions were answered with nothing.

- **Pictures the agent sends now show.** When a model puts an image in its reply, Armada used to drop it silently. It now appears in the conversation, in order, and you can click it to enlarge (desktop and phone).

### Changed

- An agent waiting on you now shows **Needs you** (it may be an approval or a question).
- **Phone: closer to the desktop.**
  - Agent text renders like the desktop: nested and loose lists, task lists, tables, headings, hard line breaks, escapes, local images, diffs coloured, and basic syntax highlighting in code blocks.
  - Finished work folds into one line ("Read 5 files, edited 2, ran 4 commands") with the answer kept visible; tap to expand.
  - Sub-agent cards show their final report and keep showing background sub-agents as running.
  - Command output is cleaned of terminal codes, and calls that never finished show as paused instead of spinning.
  - The working indicator shows elapsed time and "Waiting on N sub-agents".
  - Tap a file in the Done card to open its diff.
  - Deny an approval with a reason, insert prompt templates in the composer, and see what happened after Commit & merge, with "Ask agent to resolve" on a conflict.
  - Rate-limited agents show a usage-limit indicator.

## v0.1.8 — 2026-10-29

### Changed

- **"Send now" no longer stops the agent.** For Claude and Codex agents, sending a queued message now adds it to the turn that's running, like typing into Claude Code while it works: the agent reads it at its next step and keeps going, and its sub-agents and background tools keep running. The message appears in the conversation where you sent it. To stop the turn and run the message instead, use the ⚡ **Stop & send** button next to it. Agents that can't take messages mid-turn show **Interrupt & send**.
- **`/rc` works.** Slash commands can be found by their initials, as in Claude Code: `/rc` finds and runs `/remote-control` (continue a Claude session from claude.ai/code or the Claude app). A queued slash command's **Run next** puts it first in line, since commands only work at the start of a turn.

### Fixed

- **Secrets stay out of commits and conversations.** The "looks like a secret" check for commits now works for agents running directly in your own folder (before, it silently never matched), including leaving files out. A secret you type into an agent's question (an API key or password) is no longer saved in the conversation.
- **Questions behave.** A question no longer stays "needs you" after the agent stops, exits, or withdraws it, and the phone no longer keeps showing one that is already answered. Arrow keys only move the cursor on a question (they used to answer it), Enter on a multi-question card moves to the next question instead of sending it half-answered, and keyboard shortcuts only act on the focused agent when two are shown side by side.
- **Pictures are capped** at 24 per turn (repeats skipped), and image paths that point at another computer (`\\server\share`) are refused.
- **Phone polish from a full review.** Opening an agent no longer lands mid-conversation, the live work group no longer opens and closes by itself, the queue is one tidy "2 queued" row with labelled actions, prompt templates can't insert unfilled `{{placeholders}}`, approvals always read Deny / Approve, a rate-limited agent shows "Usage limit" instead of an error, the sub-agent pulse no longer looks broken, and a few text-clipping and contrast problems are fixed. Markdown links can no longer slow the page on adversarial text.
- **Phone: committing can't sneak in secret files.** If a commit would add files that look like secrets (`.env`, keys), the phone asks first, like the desktop: leave them out, or include them anyway. The server enforces it too.
- **Sign-in and account status.** Claude sign-in, account status and the version check now use the Claude Code that ships inside Armada instead of whatever `claude` is on your PATH, and error messages say what actually went wrong ("didn't answer in 20 seconds") instead of always "not installed". If a sign-in window shows nothing for 6 seconds, it now prints the command it is running.
- **Phone: attaching photos works again.** The phone app's security policy blocked the step that reads a picked photo, so every attachment failed with "Couldn't read…".
- **Phone: Stop & send.** The phone's queue gets the same ⚡ Stop & send (with a confirmation) and "Run next" for commands as the desktop.
- **Phone: Commit and Commit & merge** no longer report a failure when commit hooks take more than 15 seconds.
- **Phone: approvals you swipe just before locking the phone** are still delivered.
- **Phone: a paired phone** that scanned a fresh code while the computer was asleep no longer ends up back on the pairing screen; and that screen no longer flickers while it retries.
- **Phone: the agent list refreshes** reliably after reconnecting, and Back works in one tap after opening Review from a sheet.
- **Phone: typing** no longer leaves an empty band above the iPhone keyboard, and sheets (like the commit message) stay above the keyboard.
- **Phone: large diffs** say when they're cut short, and are cut between files instead of mid-line.
- Retried requests from the phone (start an agent, send a message) are never cut off halfway when the phone gives up waiting.

## v0.1.7 — 2026-10-28

### New

- **Remote access over Tailscale.** Settings → Remote & mobile → Reachable from → **Tailscale**. Armada stays on this computer only, and Tailscale Serve shares it with your own devices at an HTTPS address, so your phone can reach it from anywhere with no ports opened on your network or firewall. If something's missing (Tailscale not installed or signed in, Serve permission, HTTPS certificates), Armada shows the one step to fix it.

### Fixed

- **Pairing your phone with a VPN on.** With a VPN connected (Proton VPN, WireGuard, …), the pairing QR code pointed at the VPN's address, so the phone sat on a blank page. Armada now listens on your Wi-Fi or Ethernet address, and Settings → Remote & mobile has a **Network** picker to choose another one.
- **Firewall hint.** On Linux, when ufw blocks Armada's port, Remote & mobile shows the one command that lets devices on your network in.

## v0.1.6 — 2026-10-28

### New

- **Helper agents.** Send a message while an agent is working and start a helper instead of queueing it (Ctrl/⌘+Enter, or choose when asked; Settings → Behavior sets the default). The helper works in parallel on a copy of the agent's current files, merges its changes back into the main agent, and receives the main agent's. Helpers tile beside the main agent with their own conversation and composer, show their sync state, and can ask the main agent to resolve a conflict.
- **Preview becomes a front-end loop.** The Preview pane can send a screenshot of the page (at the current device width) to the agent, collect the page's console errors, warnings and uncaught exceptions behind a badge with a "Send to agent" summary, and pick an element on the page to send its selector, text, size and an optional cropped image. It works through a small local proxy that only forwards to the dev server you chose (hot reload keeps working); turn it off under the pane's ⋯ menu if a page misbehaves behind it.
- **A calmer, easier-to-read conversation.** Replies sit in a centered reading column with clearer headings, lists, tables and quotes; each turn starts with the agent's name, and narration between tool calls is softer than the final answer. Tool activity is a quiet one-line trace, command output shows a compact tail with "Show all N lines", and the end of a turn is a slim "Done in 6m 42s · 3 files changed" footer with the metrics in a tooltip.
- **Composer choices are remembered.** The model, effort and other options you pick are kept per agent across restarts and used for new agents of the same provider. Permission mode stays a per-agent choice. Reset what's remembered in Settings.
- **Copy diagnostics for bug reports.** Settings → About (and the command palette) copies a report with versions, system info, a settings summary, detected tools and the recent log, or saves it to a file. Keys, tokens, emails, prompts and file paths under your home folder are removed.

### Fixed

- **Review opens fast and stays smooth on huge diffs, including Git LFS repos.** Reviewing thousands of changed files (or a diff near the 8 MB cap) no longer freezes the sheet: files load and highlight as you scroll, giant files start collapsed with a "Show diff" button, and binary/LFS assets are compact rows you can hide. If a repository uses Git LFS but Git LFS isn't installed, Review now says so, with the install command, and pauses Commit and Merge until it is.
- **The chat stays put.** A finished command no longer folds away while you can see it (it folds once it has scrolled out of view), command output boxes keep a fixed height while they stream, and the view stays pinned to the bottom when a sub-agent card grows.
- **"Jump to latest" goes away at the bottom.** Scrolling back down with the mouse wheel hides it again, it no longer appears when a conversation is too short to scroll, and scrolling inside command output or a code block no longer triggers it.
- **No more jumping "Used 1 other tool" row** while sub-agents run: a sub-agent's tool call no longer flashes in the chat for a couple of seconds before moving into its card.
- **Safer agent folders.** Creating an agent's or helper's worktree no longer runs the repository's git hooks; helper merges keep file permissions and clean up after an interrupted merge.
- **Smaller things.** Tile widths are remembered; Review's narrow-window file picker is searchable and handles thousands of files; Reset in Settings can also clear each agent's saved choices; code comments are easier to read in the light theme.

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
