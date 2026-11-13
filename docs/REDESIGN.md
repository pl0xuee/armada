# Redesign: the Minimal look

Goal: a calmer Kvistcode whose agent view reads like Claude Code, Codex and T3 Code, with every
current feature kept. Dark first. Approved 2026-11-12 (fourth mockup: T3-inspired, dark gunmetal).

## Two looks
The redesign ships beside today's UI, not instead of it. Settings > General > Layout switches:
- **Classic**: the icon rail, project tree, header bar and side inspector. Unchanged, pixel for pixel.
- **Minimal**: one sidebar by activity, the screen on one raised sheet, details as a floating card.

How it is built:
- `lib/look.ts` holds the choice (localStorage `kvistcode.look`), `store/ui.ts` exposes `look`, and
  `<html data-look>` carries it for CSS (`public/theme-init.js` paints it before the app loads).
- Styling differences use the `minimal:` Tailwind variant and the `m-*` surfaces at the foot of
  `styles/globals.css` (`m-sheet`, `m-raised`, `m-float`, `m-composer`, `m-glow`); area styles live in
  `styles/minimal-*.css`, every rule scoped to `[data-look="minimal"]`.
- Structural differences read `useMinimal()` (`hooks/useLook.ts`). Nothing in Classic's code path changes.
- Themes are shared. Only the default theme is a shade deeper and grayer in Minimal.
- A Classic screenshot must match the released app exactly; compare before merging UI work.

The sections below describe Minimal. Where the "Direction" section differs from sections 2 to 5, it wins.

## Principles
- The transcript is the app. Everything around it supports it.
- Gunmetal gray, not black: lifted cool-gray surfaces with a brushed, slightly raised feel
  (soft top highlight, gentle gradient on the sidebar, header, buttons and message box).
- A little flair, in few places: the cyan accent glows on "working", the selected agent and the
  primary action; a thin accent line under the header.
- Rows for the list and for quiet steps; cards with a header bar for diffs and running commands.
- Nothing is removed. A control that leaves the screen moves to a menu, a panel or the palette (see the map below).
- Keyboard shortcuts, saved settings and every `armada.*` storage key stay as they are.

## Direction after the third mockup (T3 Code as the reference)
Taken from T3 Code (github.com/pingdotgg/t3code), in Kvistcode's gunmetal look:
- Sidebar is a list of agents by activity, not a tree: project badge and state on the first line
  ("Approval", "Working", "Ready to review"), the title, then the branch and provider glyph.
  Finished and idle agents fold into "Settled" at the bottom. "By project" stays as a filter, so
  today's grouped view and project drag order are kept. Helpers show as a line on their main agent's row.
- The other screens (Settings, Mission Control, Compare, Schedules, Usage, Accounts) are icons in the sidebar footer.
- The main area is one raised sheet with a breadcrumb ("project / title") and three layout toggles
  (transcript, bottom panel, details), instead of a header bar full of buttons.
- Details is a small floating card over the transcript: review, branch, commit/push/PR, plan,
  context and cost, files touched, terminal, open in editor. It replaces the always-open inspector column.
- A finished turn folds its steps into "Worked for 4m 02s", which opens to show them. The answer
  follows as prose, then one "changed files" card with Open diff. A running turn shows its steps live.
- Message box: one large rounded box with attach and permission mode on the left, model and effort,
  dictate and a round send/stop button on the right.

## What changes

### 1. Foundations (`styles/globals.css`, `components/ui/*`)
- Gunmetal stays the default theme, re-tuned lighter and grayer: four surface steps, two border
  steps, three text steps, plus an "edge" highlight for the raised look.
- All nine themes stay, re-tuned onto the same token set. A saved theme choice is kept.
- Type: 13px UI, 14.5px transcript, 12px mono. Whole-pixel line heights (existing rule).
- Buttons: an accent-filled primary with a soft glow, a raised gunmetal secondary, and a ghost.
- Motion: opacity and transform only, 120 to 160ms (existing rule). Glows are static shadows, not animated.

### 2. Shell (`Rail.tsx`, `TitleBar.tsx`, `agent/AgentList.tsx`, `App.tsx`)
- Icon rail and project list merge into one sidebar: New agent, Search, Needs you, Compare,
  Schedules, Usage, then projects with their agents. Accounts and Settings sit in the footer.
- Agent rows are one line: provider glyph, title, then a status dot or the time. A second line appears
  only when the agent needs you or has an error. Helpers stay indented under their main agent.
- Title bar keeps window controls, back/forward and the update pill. Search, Talk, sub-agents and
  Support move into the sidebar and the palette.
- The sidebar still collapses (to nothing, with a peek on hover) and still resizes.

### 3. Agent view (`agent/AgentHeader.tsx`, `Inspector.tsx`, `workspace/*`)
- Header is one 46px line: title, project and branch, then Review (with +/- counts), terminal, details, more.
- Details panel (today's Inspector) is closed by default and opens on demand. Context and cost show
  as a small meter in the composer, so the common numbers are visible without it.
- Workspace panel (terminal, scripts, preview) is closed by default and remembers when you open it.

### 4. Transcript (`timeline/*`, `Markdown.tsx`, `DiffView.tsx`)
- Each agent turn opens with a small glyph, name and model line.
- Your messages: a raised gunmetal bubble on the right. Agent text: plain prose on the page.
- Steps are one quiet line each ("Read 3 files", "Edited session.ts +18 -4", "Ran npm test")
  with an icon and a tick. Opening one turns it into a card with a header bar and the diff or output.
- A running command is a card showing its last few lines, not a full terminal box.
- Thinking is one line ("Thought for 12s") that opens.
- One live status line at the bottom of the transcript.
- End of turn: "Done in 6m 42s, 3 files changed" with Review as the one button; commit, merge and
  open PR sit in a menu beside it.
- Approvals and questions appear once, in the dock above the message box. The transcript keeps a
  one-line record of what was asked and what you answered.
- Scrolling keeps today's behaviour (virtual rows, sticks to the bottom, loads older on scroll up).
  The row height estimates in `Timeline.tsx` are re-tuned for the new row sizes.

### 5. Composer and docks (`agent/Composer.tsx`, `PinnedDock.tsx`, `QueueStack.tsx`, `ApprovalDock.tsx`)
- One row of controls: add (pictures, files, templates, instructions), model, permission mode;
  on the right the context meter, dictate, and send or stop.
- Fast mode, agent choice, helper model and effort move into the model menu.
- Plan and queue become one slim strip attached to the top of the message box; it opens to the full list.

### 6. Home (`views/Agents.tsx`, `home/*`)
- No tagline or backdrop: the message box, the project and account pickers under it, and
  "pick up where you left off" below.

### 7. Other screens
Mission Control, Compare, Schedules, Usage, Accounts, Settings, review sheet, dialogs, palette,
onboarding and the welcome tour take the new tokens and row-based layout. Their structure stays.
Mission Control is reached from "Needs you" in the sidebar.

### 8. Phone app (`apps/remote`)
Same tokens and the same transcript treatment. Also: usage per account, and the desktop's project
sections and order in the phone's agent list.

## Where things move
| Today | After |
| --- | --- |
| Icon rail (Projects, Mission, Compare, Schedules, Usage, Accounts, Settings) | Rows at the top and foot of the sidebar |
| Title bar search | "Search" row in the sidebar, still Ctrl+K |
| Title bar Talk, sub-agents, Support, account avatars | Sidebar footer and palette |
| Inspector always open | "Details" button in the header, closed by default |
| Usage ring, cost | Meter in the composer; full numbers in Details |
| Composer: fast mode, agent, helpers | Model menu |
| Composer: templates, instructions, attach | "Add" menu |
| Turn summary: commit, merge, open PR | Menu beside Review |
| Approval card in the transcript and in the dock | Dock only, one-line record in the transcript |

## Order of work
1. Tokens and base controls. Every screen changes colour at once; nothing moves yet.
2. Sidebar and title bar.
3. Agent header, transcript, composer and docks.
4. Home, then the remaining screens, dialogs, onboarding and tour.
5. Phone app.
6. Full app review and fixes (the review asked for alongside this), then release as v0.5.0.

Each step ends with the CI checks, screenshots of every screen in a dark and a light theme at
1280 and 700 wide, and the 8-agent grid measurement.

## Risks
- Transcript row heights feed the virtual list. Wrong estimates show as scroll jumps while an agent
  streams; this needs testing under load, not just screenshots.
- The welcome tour and the end-to-end smoke test point at specific elements that will move.
- Nine themes times every state is a lot of surface; light themes are the likely place for contrast misses.
- Hiding Details and the workspace panel by default changes what current users see on first launch
  after the update. Saved open/closed choices are kept; only the default changes.
- README and docs screenshots all need retaking.
