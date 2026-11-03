# Changelog

What's new in each Kvistcode release. The section for a version becomes its GitHub release notes
and the notes shown by the in-app updater, so write for people using the app.
`scripts/release_notes.py` refuses to cut a release whose section is missing or empty (see
docs/RELEASING.md).

## Unreleased

### New
- **A calmer agent list.** Projects are now plain sections instead of boxes, agent rows are lighter, and the account name only shows where a provider has more than one account.
- **Six more themes.** Midnight, Forest, Dusk and Ember (dark) and Paper and Lilac (light) join Gunmetal, Carbon and Titanium in Settings → Appearance and the command palette.
- **Talk to Kvistcode is front and centre.** The voice assistant is now a labelled “Talk to Kvistcode” button in the title bar and a big card on the home screen, and the mic button in every composer is in the accent colour. If it isn't set up yet, pressing it takes you straight to the setting.
- **Change an agent's account from the agent itself.** The account the agent runs on now sits in its header: click it to pick another account of the same provider (for example Personal or Work) and the agent carries on there with its history. It waits for the current turn to finish first.

### Improved
- **Settings has 9 pages instead of 15.** Sounds and Notifications are one Alerts page, rarely used options sit under “Advanced”, and a new “Match system” theme follows your computer's light or dark mode.
- **Simpler rate-limit banner.** One plain headline with the time it resumes, one main button (Switch account or Resume), and the rest under More.
- **A calmer agent header.** “Review 3 files” is labelled, rarely used actions moved into the … menu, every icon has a tooltip, and the title no longer shrinks to one letter in narrow windows.
- **Usage page is tidier.** Provider, account and project breakdowns share one panel.
- **Phone setup is clearer.** “This computer” explains what to do next, and a plain-network connection warns that it is not encrypted.
- **One set of status words** (Needs you, Ready to review, Rate limited, Error) across Mission Control, the sidebar and the header; the agent composer uses “Ask before changes” / “Run without asking”.
- **The sidebar scrolls to the agent you open**, and shows “agent N” numbers while the voice assistant is on.
- **Review is simpler.** One main button (Commit & merge, or Merge) with the rest under More; actions that can't do anything are disabled, and merging asks first.
- **Mission Control: Allow / Deny always visible**, long diffs are collapsed, and rate-limited or failed agents have Switch account / Retry / Resume right on their card.
- **Plainer wording.** “Ask before changes” and “Run without asking” everywhere, simpler first-run and tour text, a hint that Ctrl+Enter starts an agent, and “Keep this & archive others” in Compare.
- **A tidier command palette** opens on what needs you, recent agents and top actions.
- **Accounts:** clear “Not signed in” state with a Sign in button, a fail-over setting at the top, and Undo after switching an agent's account.
- **Voice assistant:** the home card no longer shifts the screen, the panel has labelled Mute and End buttons, and billing is one line.
- **Quieter when hidden:** clocks and status polling pause while the window is in the background.

### Fixed
- Sub-agents that have already handed back their result no longer show as “working” while the main agent is still busy.
- The voice assistant now sees which agent is open as soon as you press Talk, instead of only after you click away and back.
- The “Turn finished · 4 agents may be running” pill is shorter and no longer runs under the header buttons.
- Test-connection errors for MCP servers no longer echo passwords or keys.
- A scheduled run no longer overwrites a schedule you edited while it ran, or brings back one you deleted.
- Codex turns without an id no longer lose track of the running turn; an oversized message from an agent now fails the waiting request with a clear error instead of hanging.
- The phone link limits connections per device even behind Tailscale, and closing the preview ends its live connections.
- “Everything finished” alerts say what the agent last reported instead of a bare “done”.
- The “3 sub-agents” label is no longer cut off.
- Long chats load earlier history when the screen isn't full, and a failed load shows a Retry.
- A message that fails to send comes back into the box without losing newer text.
- Safer saving of budgets, no half-written files, and the phone link refuses oversized or read-only requests.
- Switching an agent's account no longer interrupts a turn that started a moment earlier.

## v0.4.0 — 2026-11-02

The assistant now follows you around the app, understands “agent 2” and “project 3”, and lives in a panel you can move.

### New
- **Say a number.** The assistant numbers your agents (the same numbers as the ⌘1–9 shortcuts) and your projects, so “open agent 2”, “stop #3” or “start an agent in project 1” works without saying names.
- **It notices when you switch.** Move to another screen, agent, settings section, Mission Control tab, diff review or project and the assistant is quietly told, so you never have to explain where you are.
- **Go anywhere by voice.** It can open a project (its most urgent agent) and a comparison group, on top of every screen, settings section and Mission Control tab.
- **Move the assistant.** Drag the panel by its handle to put it anywhere; Kvistcode remembers the spot. Double-click the header to put it back, or use the arrow keys on the handle.
- **A better-looking assistant.** Conversation bubbles, clearer actions, and a Confirm card you can't miss.

### Fixed
- **Billing no longer shows a misleading number.** The assistant panel used to show the total the whole fleet counts toward the daily budget (subscription agents included, at API prices) as if it were spent on your key. API accounts now show what was used on that key, the daily budget is labelled as such, and the assistant panel shows its own OpenAI cost this month.

## v0.3.3 — 2026-11-01

Sub-agents show up reliably, long messages stop jumping around, and the voice assistant can do much more.

### New
- **The assistant knows where you are.** It can see which screen and agent are open and any text you have highlighted, so “stop this one” or “what does this say?” just works. Commands that name no agent act on the open one.
- **Say “commit and push” and the agent does it.** The assistant sends your request to the agent as a message. You see the exact wording on the confirmation card and press Confirm first.
- **More to ask for.** List your projects, check usage, search what was said earlier, rename an agent (with a confirmation), mark one done, and open Usage, Schedules, Accounts, Settings (any section), Compare or either Mission Control tab.
- **Mute.** Say “mute”, “pause listening” or “go to sleep”, or press the Mute button. Kvistcode stops listening completely until you press Unmute.
- **Billing at a glance.** Each account now says whether it runs on a subscription (with how much of each usage window is left and when it resets), API billing (with what is left of today's budget) or a local model. It shows in the inspector and in the assistant. Providers don't let an API key read a prepaid balance, so for API billing the figure is your daily budget.
- **A clearer Confirm.** When the assistant waits for your OK, the panel says so and shows large Cancel and Confirm buttons right under the header.

### Fixed
- Sub-agents started in the background were sometimes missing from the list and from the sub-agents count, including in older conversations.
- A long message no longer flips between a short and a long layout while an agent is working; once you open it with “Show more” it stays open.
- A long status label in the agent list no longer runs past the edge of its card.

## v0.3.2 — 2026-11-01

Agents resume on their own after a limit resets, Kvistcode helps your subscription last longer, local models work properly, and a full review of the app fixed a long list of bugs.

### New
- **Agents resume by themselves.** When a provider's rate limit stops an agent, Kvistcode continues it automatically once the limit resets, staggered so many agents don't start at once, with one summary notification. The banner, lists and Mission Control show “Resumes 6:00 PM” with a countdown and a Cancel link. Turn it off under Settings → Behavior → Rate limits. The phone shows when an agent will resume.
- **Save tokens.** Claude agents now summarize their conversation at 250k tokens by default (a long conversation is re-read at every step, which is where most usage goes; choose “Claude's default” in Settings → Behavior to turn it off). A new Save tokens panel on Usage shows what is using your tokens, with one-click fixes, and a Save tokens preset applies cheaper defaults. You can also choose the model for Claude's helper agents, cap how much command output an agent reads, tidy noisy build and test output, and turn off the hidden next-prompt prediction that cost a request per turn. Usage warns when many agents work at once on an account with little left, or when a big conversation has sat idle past the prompt cache.
- **Much better local models.** Local agents get a real context window instead of Ollama's 4k default (which silently cut prompts off), models without tool support are refused with alternatives named, and “Get a model” ranks downloads by what your computer can run, with a disk check. A new server panel shows version, loaded models, problems with fixes and a speed test. Local usage no longer counts against your cloud budgets. An optional setting uses a local model to condense handoff summaries.
- **Updating from Armada is clean.** On Windows the update replaces the old Armada install instead of leaving a second app, and old startup entries are removed on every system. The Linux .deb and .rpm replace the old package.
- **The phone app keeps up.** It shows “Workflow 3 of 5 running” instead of Idle or Done, search results open at the matching message, subscription costs are labelled as API-equivalent, and the confusing Resume queue button no longer appears beside a limit hold.

### Changed
- New tagline: “Every coding agent, one calm place.”
- The provider's limit is now called a “rate limit”, and yours stays a “budget limit”. Settings → Agents is now “Custom agents”.
- The “everything finished” alert for a Workflow now says which agent and which workflow finished and how it ended, instead of a generic line. It comes once per run, after the run has stayed finished for a minute, so a long quiet spell in the middle no longer triggers repeats.
- Hold panels name the limit that was hit (spending, token or turn), budget fields say which limit is empty, and Markdown marks no longer show in search snippets.
- Light theme: error, warning and success colors are easier to read on tinted backgrounds.
- Small copy fixes in Accounts, Onboarding, Usage, About and the Schedule dialog.

### Faster
- Jumping to a search result deep in a very long conversation does up to 6x less work.
- A hidden or tray-minimized window uses much less CPU while agents stream.

### Fixed
- A message sent just as an agent crashed could vanish; it now goes back into a paused queue with a note. This also holds under heavy load.
- A long pasted draft was cut at 20,000 characters when you switched agents, and the last keystrokes were lost on quit.
- “Send now” during a turn no longer resets the turn: running sub-agents and the timer stay.
- One rendering error could blank the whole window; now only the broken row says it couldn't be displayed.
- The agent header keeps its title at 200% zoom, and the title bar's update pill no longer wraps in narrow windows.
- Markdown reference links and footnotes work, Arabic and Hebrew read right to left, and Compare shows the full answer.
- Keyboard and screen-reader fixes: focus returns after closing the Review sheet and image viewer, Space opens an agent row, IME typing is respected, and fewer announcements.
- The window now fits small screens and high display scaling, and a login launch no longer counts as “looking at it”, which had muted phone pushes and sounds.
- Pasting file paths with a “%” before non-English characters no longer crashes (Linux), update checks time out instead of hanging, and old log files are pruned.
- Security: the Preview pane's page tools only respond to Kvistcode itself, `git push` refuses a repository remote name that looks like a command option, pairing a phone times out stalled requests, and secret scrubbing in shared text, exports and error notices covers more key formats and the Slack and Discord webhook links.

## v0.3.1 — 2026-11-01

The phone app catches up with the desktop, merging a pull request is safer, and Claude Code's Workflow runs finally show up.

### New
- **Workflow runs are visible.** When Claude Code launches a multi-agent Workflow, a card appears in the conversation and a live “Workflow · 5 agents working” row sits above the message box. Expand it to see each agent's latest action, step count and time. It settles to “Workflow finished” when they are done.
- **Turn limits.** Set a maximum number of turns per agent, per project or per day, which suits subscription accounts where dollar cost isn't known. It pauses at the end of a turn like the other limits, shows a “7 / 20 turns” meter, and the count survives restarts.
- **Switch skills off.** For Claude agents, turn individual skills on or off, in every project or just one. Your skill files are never changed. Other providers show “Managed by …”.
- **The phone app does more.** It shows agents held at a spending limit and lets you raise the limit, continue once or stop; shows pull request and CI status on the agent screen; searches conversations; and can change how agents report.
- **A short tour** on first launch of this version covers the agent grid, the pinned dock, search and spending limits. Skip it any time; Settings → About → Show the tour brings it back.
- **Issues and Open pull request** are now in the command palette.
- **Support links.** Settings → About has a Sponsor button and a link to kvistcode.com/support. Both are entirely optional.

### Changed
- **No more early “Done”.** When an agent's turn ends while its Workflow or background agents are still running, it now reads “Turn finished · Workflow 3 of 5 running”, counts as working, and shows “Everything finished” when the last one ends. The turn-end notification says work is still running, and a quiet second alert follows when it finishes if you are looking elsewhere. Background sub-agents are described as “may be running” because their end can't always be known. The phone app still says “Done”.
- Merging a pull request is pinned to the exact commit you reviewed. If the branch changes after you looked, nothing is merged and you are asked to review again.
- The merge dialog says “not known” when GitHub hasn't answered, instead of implying a pass, and GitHub errors read as sentences with a Copy details button.
- The Preview address bar and Back/Forward buttons now follow the page as you click links.
- Project instructions are edited in one place, Settings → Tools & instructions. The older editor under Projects now links there.
- The MCP and Skills tabs say when a change applies only to new agents.
- Small dependency updates.

### Fixed
- A message sent right after an agent's process died could vanish: it stayed in the conversation but was never sent or queued, and the agent could show an error while still looking busy. It now goes back into a paused queue with a note so nothing you typed is lost.
- The pull request chip no longer overflows in narrow panels.

## v0.3.0 — 2026-11-01

Armada is now **Kvistcode**. Your agents, settings and sign-ins carry over, and updates keep working. This release also adds pull-request merging and GitHub issues, search across every conversation, spending limits, alerts to Slack and Discord, and one place to manage your MCP servers, skills and project instructions.

### New
- **New name: Kvistcode.** Same app, new name and address (kvistcode.com). The command is now `kvistcode`, and new agent branches start with `kvistcode/`. Existing agents and their branches are untouched.
- **Merge a pull request from the PR panel.** Squash, merge or rebase, with a heads-up if checks are failing or review comments are still open. The panel also shows the base branch and whether GitHub considers it ready to merge, and can take a draft out of draft.
- **Open a PR your way.** Choose the base branch, open it as a draft, and start from a description that already has the size of the change and “Closes #N”.
- **Work from GitHub issues.** Browse a project's open issues and start an agent on one, in its own worktree with a branch named after the issue.
- **Search every conversation.** Press Ctrl/Cmd+Shift+F, or type `?` in the command palette. It finds messages, commands, file paths and summaries, including archived agents, and jumps to the exact spot.
- **Tools & instructions.** A new Settings page to edit `CLAUDE.md` and `AGENTS.md` (with a warning if the file changed on disk), manage MCP servers per project, and browse your skills and plugins.
- **Spending limits.** Set a limit per agent, per project or per day, in dollars or tokens. When one is reached the agent finishes its turn, then waits for you in Needs you: raise the limit, continue once, or stop. A meter shows in the agent header whenever a limit applies.
- **Alerts to Slack, Discord or any webhook**, next to ntfy, with a switch for each kind of event and a Send test button. The addresses are stored in your keychain.
- **Preview remembers its address** for each project, and gets Back and Forward buttons.

### Changed
- Reaching a spending limit no longer interrupts an agent mid-task. It stops at the end of its turn instead.

### Fixed
- A very long command in the sub-agent bar could stretch it wider than the message box.

## v0.2.0 — 2026-10-31

Run many agents on one project and watch them side by side, with a clearer view of what each one is doing and what needs you.

### New

- **Many agents, one project.** Start up to 8 on the same task: they open together as full conversations in a grid that fits the window, each in its own worktree so they can't overwrite each other. **Add agents** in an agent's header starts more in the same project, and the sidebar is now organised by project, with a grid button to show a project's agents together.
- **One Mission Control.** Needs you, Inbox and Mission Control are a single view with a **Needs you / All agents** switch, and one count everywhere: the rail, the tabs, the window title and the menu-bar tray.
- **Typing while an agent works behaves like Claude Code.** Press Enter and your message goes into the turn that's running: nothing is cancelled. Queue it for after the turn, start a helper, or deliberately **Stop & send** from the menu next to Send. If a message can't be delivered it goes back to your queue, never dropped. ↑ in an empty box takes your newest queued message back.
- **What needs you stays pinned** above the message box, wherever you've scrolled: approvals, questions with one-tap answers, blockers (usage limit, error, budget cap, merge conflict), live plan progress, and sub-agents with a timer.
- **Replies that read like a report.** Working notes between steps are quiet and the answer stands out; long replies and code fold behind “Show more”; tables line up; a sentence split across two messages joins back together. A new setting, **Settings → Behavior → How agents report** (Concise by default, Balanced, Detailed), asks agents to lead with the outcome and skip log dumps. It shapes how they write, not the work they do.
- **New notification sounds** in three packs: Soft (the new default), Glass, and Classic (the sounds you had).
- **The phone app catches up:** a project-grouped agent list, a Needs-you queue with big Approve and Deny buttons, the pinned dock, adding agents, and the same reply layout and typing behaviour.
- **A calmer interface.** A slimmer agent header, two-line sidebar rows (with a Compact option), a live “working / need you / spend” line on the home screen, soft edges on scrolling content, a title-bar search box that stays put, stronger light-theme contrast, and tidier setup, review, accounts and comparison screens.

### Faster

- With eight agents streaming, the frame rate on a deliberately slowed computer rose from about 49 to 58 fps: animations pause while the window is hidden, long replies are redrawn less often, and extra screens load one at a time after start-up.
- The first time you open the command palette or New agent is instant (it used to take about 0.8 s).

### Changed

- The separate project page from 0.1.11 is gone: clicking a project folds it, and agents open on the agent page.
- “Send now” on a queued message adds it to the running turn instead of stopping the agent. For an agent that can't take messages mid-turn it says **Run next** and the message goes first in line.
- The “Ask” choice for what Enter does while an agent works is now “Deliver to the running turn”; nobody is asked each time anymore. If you chose Queue or Helper before, that choice is kept.

### Fixed

- Stopping an agent and sending a message right away could let a stray line from the stopped reply appear in the new one.
- Answering a question or an approval a split second before the agent finished could be recorded as cancelled.
- A failed first start could make your next try fail too (“The agent process exited unexpectedly”), and a message sent while an approval was pending could reach the agent after your approval instead of before it.
- A sentence could break in two in the middle of a reply, with the second half brighter.
- Tooltips piling up when you Tab quickly, clipped focus rings, the Copy button printing over a message's last line, review buttons being live while the diff loaded, and the menu-bar “Needs you” count disagreeing with the app.

## v0.1.11 — 2026-10-30

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
