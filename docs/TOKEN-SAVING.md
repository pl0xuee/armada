# Saving tokens

Goal: make subscriptions last longer when many agents run in parallel. Evidence first, then a ranked
list. Numbers come from a read-only copy of one real install (7 agents, 174 turns, aggregates only;
no conversation content was read). Treat them as one person's workload, not a benchmark.

## What the data says

- **Tokens are context x steps.** A turn takes a median 1.03M tokens (p90 5.5M, p99 11.3M) and about 11
  tool calls; that is 90-250k tokens per tool call, which is the size of the agent's context. Every step
  re-sends the whole conversation (mostly served from the prompt cache, but still counted).
- **Two agents are 87% of all tokens** (118M and 127M of 284M). Both sit at 456-493k tokens of context
  in a 1M-token window: Claude Code on 1M models summarizes very late, so contexts just keep growing.
- **The top 10% of turns hold 42% of tokens.** The biggest single turn was 20M tokens (50 tool calls).
- **Model price dominates cost, not volume.** 11 turns priced at $4+/Mtok are 9% of tokens but 80% of the
  API-equivalent cost ($396 of $494); one agent averages $4.22/Mtok against 0.3-1.0 for the rest. That is
  an Opus/Fable-class price, though the per-turn model is not recorded.
- **Helpers are negligible** (one helper agent, 0.2% of tokens). Claude's own sub-agents cannot be told
  apart in the data. **Kvistcode itself adds little**: about 500 tokens of guidance (identical every turn, so
  it never breaks prompt caching; its tag only decides whether a resumed session needs it again) and a
  briefing capped at 12,000 characters, sent once on a fresh session. No Kvistcode MCP servers are on.
- Repeat reads: 20% of one agent's file reads were of a file it had already read. 67 command outputs were
  over 20k characters. Instruction files: 9.4 KB and 2 KB in two projects, none in the main repo.

**Cannot be told from the data:** cache reads vs fresh input vs output (only `totalTokens` per turn is
stored); the model used per turn; effort effects (all agents are on high); sub-agent share; whether the
first turns of a project cost more (A4: 3-4x, A3: the opposite; inconclusive).

## Which model (from Anthropic's guide, 2026-11-09)

Source: "Which Claude model should you build with", claude.dev/blog, 2026-11-09. Kvistcode builds the advice in
as the defaults (`apps/desktop/src/lib/modelGuide.ts`, mirrored on the phone); the figures live only here, because
prices and benchmark numbers go stale and the UI never states them. Re-check the article before changing the guide.

| Model | Start here for | Input / output per MTok | Cache read per MTok |
| --- | --- | --- | --- |
| Opus 5.5 | everyday engineering and debugging, multi-PR features, or when unsure | $4 / $20 | $0.20 |
| Sonnet 5.5 | well-scoped, routine work (bug fixes, spec-driven features, repeated agent tasks) | $2 / $10 | $0.10 |
| Haiku 5.5 | classification, routing, bulk extraction, cheap helper agents | $0.10 / $0.50 up to 100K prompt tokens, $0.50 / $2.50 above | $0.01 / $0.05 |
| Fable 5.2 | big refactors and migrations, architecture, deep research, leading many helpers, when Opus at high falls short | $8 / $40 | $0.20 |

All four have a 1M-token context window and 128K max output. Fable costs twice Opus per token.

- **Start on Opus at medium effort**, then high. Opus at medium on SWE-bench Pro is about 2.5 points below high at about
  70% of the cost; low is about 8 points below at about a third of the cost; xhigh is about 1.4 points above at 2.5x the
  cost of high. Opus at high matched Fable 5.1 at max on Terminal-Bench 3.0 (58.9% vs 58.0%) with half the tokens.
- **Raise effort before moving to a bigger model.** Order when a model is not good enough: make sure it can check its own
  work (tests, a build, a script); raise effort one level; then try the next model up at a lower effort. Past high, one more
  effort level can cost as much as a bigger model. Effort adds thinking time, not knowledge.
- **Switch models at a break.** The prompt cache belongs to the model that wrote it, so the first turn on a new model pays
  the cache-write price on the whole conversation. Use `/compact` or a fresh agent with a short summary. Thinking carries
  over only upward (Haiku to Sonnet to Opus to Fable); moving to a smaller model, or off Fable, drops earlier reasoning.
- **Helpers on a smaller model.** File search, log reading and summaries are cheap to check, so Sonnet or Haiku suit them
  (`CLAUDE_CODE_SUBAGENT_MODEL`, the "Helper agents use" setting). Keep code edits and judgment on the main model.
- **Not built in:** the advisor pairing (a bigger model advising a smaller one: +1.7 points for about 2.1x the cost) and
  switching models mid-conversation automatically. `opusplan` is not a default.

What Kvistcode does with it:

- New Claude agents start on the "kind of work" you pick next to the prompt: Everyday coding (Opus, medium), Routine
  tasks (Sonnet, medium), Quick or bulk (Haiku, medium), Big refactor or research (Fable, medium), or "My usual model"
  (no change). A fresh install starts on Everyday; anyone who already chose a Claude model or effort starts on "My usual
  model", so nothing changes behind their back. Types whose model the installed Claude Code does not offer are hidden.
- Onboarding sets helper agents to Sonnet. Existing installs get a one-click offer on the Usage page instead.
- The model and effort menus add a "good for" line where Claude Code gives none, and a note about when to use each.
- Changing a Claude agent's model with 100k or more tokens of conversation asks first (the cost above), and offers to compact.

## Ranked ideas (reduction x confidence / effort and risk)

| # | Idea | Est. reduction | Confidence | Status |
|---|------|---------------|-----------|--------|
| 1 | Summarize at ~250k instead of letting contexts reach 450k+ (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`) | 25-40% on the heavy agents | medium | **Built** (setting + preset) |
| 2 | Start a fresh agent from a handoff summary above ~200k context; `/clear` between tasks | 20-35% per long agent | medium | **Built** (insight; user decides) |
| 3 | Keep Opus/Fable for hard problems, Sonnet for routine work | up to ~40% of cost (80% of cost is 9% of tokens); tokens unchanged | medium | **Built** (insight; preset never changes the model) |
| 4 | Medium effort by default for new agents | 5-15% (thinking is output tokens; Claude Code's own default on the 5.5 models is medium) | low-medium (no Claude numbers published; community Codex figures of 40-60% are unverified) | **Built** (preset + one-click per agent) |
| 5 | Warn when many agents work at once on one account | prevents hitting the wall, no direct saving | high | **Built** (insight, tied to the account's window) |
| 6 | Don't switch model or let a cache idle over an hour on a big context (rebuild reads it all uncached) | situational | high | In insight text |
| 7 | Cap huge tool output (hooks that filter test/log output) | 3-5% | low | **Built in round 2** (tidy hook + inline limit; see below) |
| 8 | Per-project brief so agents don't re-explore | 5-10% | low | Not built (below) |
| 9 | Trim Kvistcode guidance / briefing | <0.1% | high | Not worth it |
| 10 | Disable unused skills (each agent lists ~4.7k tokens of commands/skills) | ~1% on big agents, ~20% on small ones | medium | Exists (Skills settings) |
| 11 | Record the model per turn in Usage | enables better advice | high | Follow-up (touches session.rs) |

### Project brief (D)
Claude Code already reads `CLAUDE.md` once per session into the cached prefix, and `/init` writes one.
A separate Kvistcode-managed brief would duplicate it, can go stale, and could leak secrets. Better:
keep it in the repo, under 200 lines (Anthropic's guidance), regenerate with `/init` when the
architecture changes. The main Kvistcode repo has no CLAUDE.md or AGENTS.md; running `/init` there is the
cheapest first step. Not built: the data does not show a clear saving and it would add a second source of truth.

## Mechanics worth knowing (sources)

- Prompt cache: prefix match over tools, system, then messages; read price is 0.05-0.1x of input, writes
  1.25x (5 min) or 2x (1 hour). On a subscription Claude Code asks for a 1-hour cache for the main
  conversation; sub-agents, workflows and compaction get 5 minutes. Source: platform.claude.com prompt-caching and
  code.claude.com/docs/en/prompt-caching.
- Switching model invalidates the cache; changing effort keeps it on the 5.5 models only. Connecting/removing MCP
  servers invalidates it unless tool search defers the definitions (the default). Editing CLAUDE.md mid-session
  neither invalidates nor applies. Same source.
- Auto-compact: `autoCompactWindow` / `/autocompact` / `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, 100k-1M; compaction
  itself reads the whole context once (cheap while the cache is warm, uncached after an idle hour).
  code.claude.com/docs/en/model-config and prompt-caching.
- Kvistcode's own "compact when the context is X% full" (`autoCompactPercent`, 50-95, off by default): after a
  completed turn, if the agent offers `/compact` and its context use is at or above X%, Kvistcode sends `/compact`
  before the next queued message and adds a timeline note. It fires once per crossing and re-arms only after usage is
  seen below X%, so a compaction that doesn't help is not repeated. Works for any provider, unlike the window above.
- Sub-agents and teams each carry their own context; Anthropic cites about 7x tokens for plan-mode teams. Use a
  smaller model for them (`CLAUDE_CODE_SUBAGENT_MODEL`, `model: haiku`). code.claude.com/docs/en/costs.
- Keep CLAUDE.md under 200 lines; move rarely needed instructions to skills. Same page.
- Codex: `model_reasoning_effort` and `model_auto_compact_token_limit` exist per community guides; I could not
  confirm key names, defaults or clamping against OpenAI's reference. Grok: nothing verified. Neither is wired.
- Not verified at runtime: that the ACP Claude adapter passes the environment variable through to Claude Code
  (it inherits the process environment; the setting is off by default, so nothing changes until chosen).

## What others do (round 2: community research)

Confidence: **primary** = stated in Anthropic or OpenAI documentation and, where noted, found in the installed
Claude Code 2.1.x binary (names grepped, nothing run against a model); **reported** = a blog or repo author's
own measurement, not independent; **anecdote** = one person's claim. Search covered blogs, GitHub, Dev.to, docs.
Reddit and Hacker News threads were not reachable through search (the engine returned summaries of
blog posts instead), so no Reddit number below is first-hand.

| Technique | Reported effect | Confidence | Source |
|-----------|-----------------|-----------|--------|
| Compress shell output with a hook (RTK "Rust Token Killer": rewrites/filters `cargo test`, `git`, `npm`, logs) | 60-90% on build/test/log output (README estimates); one user: 108k tokens over 19 `dotnet test` runs | reported; author warns it hides passing output and only covers Bash, not Read/Grep | github.com/rtk-ai/rtk, madplay.github.io/en/post/rtk-reduce-ai-coding-agent-token-usage |
| Claude Code's own cost guide: a `PreToolUse` hook that filters test output; subagents for verbose work; Sonnet default, Opus for hard problems; `model: haiku` for simple helpers; `/clear` between tasks; CLAUDE.md under 200 lines; skills instead of long instructions | no numbers; average API cost $13/dev/day | primary | code.claude.com/docs/en/costs |
| `PostToolUse` hook may replace a tool's output with `updatedToolOutput` (any tool; must keep the tool's output shape); command hooks can run an executable directly with `args` (no shell) | n/a (mechanism) | primary; both names found in the installed binary | code.claude.com/docs/en/hooks |
| `bashOutputMaxChars` setting (default 30,000, clamps 4,000-128,000): longer output is saved to a file and the model gets a preview | n/a (mechanism) | primary: found in the installed binary only (its text matches the docs' description) | installed `claude` 0.3.312 |
| Route models: Opus plans, Sonnet/Haiku executes (`opusplan` alias, `CLAUDE_CODE_SUBAGENT_MODEL`) | "up to 75% cost" with deliberate routing (Firecrawl); agent teams cost ~7x tokens in plan mode (Anthropic) | reported / primary; both names are in the installed binary | firecrawl.dev/blog/claude-code-token-efficiency, code.claude.com/docs/en/costs |
| `.claudeignore` / `permissions.deny` for `node_modules`, build output | ".claudeignore alone: 85.5% context reduction" (one benchmark, unexplained method) | anecdote; `permissions.deny` is primary but does not stop Bash `cat` | firecrawl.dev blog above |
| Trim CLAUDE.md, path-scoped rules, skills (30-100 tokens each until used) | 92% on one CLAUDE.md (3.8k to 0.3k tokens), 41% fewer always-loaded lines | reported | firecrawl.dev blog |
| MCP overhead: each server 10-20k tokens per session; prefer CLI tools; Codex `enabled_tools` allowlists took a 93-tool server from ~55k to ~3k tokens | large, mostly for many-tool servers | reported; Claude Code now defers MCP tool definitions by default (primary) | firecrawl blog, codex.danielvaughan.com (2026-06-10), code.claude.com/docs/en/costs |
| Code-index / repo-map MCPs (jCodeMunch, codebase-memory, code-nav) to avoid whole-file reads | vendor claims 10-28x fewer tokens on structural queries; a practitioner measured 48k to 23k; tool-layer-only savings 15-25% | reported; helps only for lookups, adds a fixed tool cost | pypi.org/project/jcodemunch-mcp, medium.com/@aitrends24/i-gave-claude-code-a-map-of-my-repo-it-used-half-the-tokens-882e090cd0ca |
| Language-server "code intelligence" plugins instead of grep + read | no number | primary | code.claude.com/docs/en/costs |
| Compact early (`/compact` at 250-300k, custom compact instructions), `/clear`, `/rewind` | no standalone number; Codex compaction events 3-5 to 0-1 per session with a lower threshold | reported | firecrawl blog, codex.danielvaughan.com |
| Cache TTL: main conversation 1 h on a subscription, but sub-agents and workflows 5 min; `subagentPromptCacheTtl: "1h"` (env `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`) keeps them warm; batching sub-agent work closer than 5 min helps | one Reddit-sourced report: a 5-hour window use of 100% fell to 22% (unverified); 1 h writes cost more | anecdote; setting names primary and present in the installed binary | dev.to/akaranjkar08/prompt-cache-orchestration-beat-the-5-min-ttl-miss-2026-2e31, note.com/hacklog_stealth/n/n8d10073d9834 |
| Background token use: prompt suggestions (a request after every turn), session recap, idle compaction can each be turned off (`promptSuggestionEnabled`, `awaySummaryEnabled`, `idleCompaction`) | small per call, but each re-reads the cache | primary | code.claude.com/docs/en/costs ("Background token usage") |
| Thinking: lower effort, or `MAX_THINKING_TOKENS=8000` on fixed-budget models (adaptive 5.5 models ignore it) | thinking is billed as output | primary | code.claude.com/docs/en/costs |
| Codex: `model_reasoning_effort` low/medium for routine work (profiles), `tool_output_token_limit`, `model_auto_compact_token_limit`, `model_reasoning_summary = "none"`, MCP `enabled_tools` | "40-60% on scaffolding" (unmeasured); `tool_output_token_limit` e.g. 12000 | reported; the three config key names exist in the installed Codex binary, units and defaults not confirmed | codex.danielvaughan.com (2026-06-10, 2026-05-02), tech.autoscout24.com blog |
| Peak hours burn the 5-hour window faster (weekdays 5-11am PT); some users saw a Max 20x window gone in 19 minutes in March 2026 | n/a; a counter bug was suspected (GitHub issues 38335, 39507) | reported by press and users | techradar.com, dev.to/portkey/everything-we-know-about-claude-code-limits-3984 |
| `/usage` in Claude Code (2.1.2xx+) breaks plan use down by skill, sub-agent, plugin and MCP server, with recommendations | n/a | primary | code.claude.com/docs/en/costs |

### Checked against this owner's data (7 Claude agents, 6,815 tool calls; aggregates only)

- **Sub-agents do most of the work.** 79% of tool calls (5,366 of 6,815) ran inside 44 sub-agent runs. This
  corrects the first round's "cannot be told apart": the call records carry a parent id. Helper-model routing
  therefore has the most lever (up to 3 in 4 tool calls), and cannot be measured in tokens from the data.
- **Shell output is mostly file reading, not test logs.** `sed`, `cat` and `grep` are 76% of all shell
  output characters; `cargo test` is 0.4%. A RTK-style filter that only touches build/test tools applies to
  40 of 5,068 commands (0.8%) and saved nothing on replay. It is built because it is safe and cheap, and
  because other workloads (npm/pytest/cargo-heavy projects) are what the published 60-90% figures describe,
  but this owner should not expect it to matter.
- **Long outputs are where the characters are.** 384 outputs over 8k characters (7.6% of commands) hold 42%
  of shell-output characters. Capping the inline size at 12k would have cut 8% of the volume re-read by later
  steps (estimated as output size times the following 100 calls); 8k would cut 17%; 20k only 1.5%.
- **Repeat reads are real but modest.** 17% of Read-tool calls and 18% of shell file reads repeated a file the
  same agent had already read. Nothing blocks that safely; it is a prompting matter (AGENTS.md) rather than a setting.
- **A deny-list would not help.** 0 of 817 reads were in `node_modules`, `target`, `dist`, lockfiles or `.git`;
  `permissions.deny` also does not stop shell `cat`. Not built.
- **All seven agents are Claude**, so the Codex/Grok settings would change nothing here. Not built.

### Ranked for this owner (evidence x fit / risk and effort)

1. Compact window (built in round 1). 2. Helper agents on a smaller model (79% of calls). 3. Turn off
next-prompt prediction (a full-context request after every turn that Kvistcode never shows; zero risk). 4. Inline
output limit of 12k. 5. Warn before resuming a big, cold-cache conversation. 6. Output tidy-up (built, little
effect here). Not built: deny-lists (no evidence), repeat-read blocking (no safe signal), `opusplan` as a preset (the
alias may not be in an agent's model list; changing the main model stays the owner's choice), 1-hour sub-agent
cache (anecdote only, 1 h writes cost more), Codex limits (no Codex usage here), MCP code indexes (adds a tool
cost; unproven for this repo).

## What was built, round 2

- `output_filter.rs` and `kvistcode filter-output`: a `PostToolUse` hook for Claude's Bash tool, run through the
  Kvistcode binary itself (exec form, so it needs no shell or script and behaves the same on Windows). It
  tidies only build/test/install/git-status output (allowlist) and never `cat`, `sed`, `grep`, `git diff`, `ls`
  or anything piped through them. It removes colors, redrawn progress lines, runs of identical lines, runs of
  `Compiling`/`Downloaded` lines, runs of passing-test lines and git's `(use "git ...")` hints; errors, warnings and
  failures stay. Any problem means no change. Savings are logged to `output-filter-stats.jsonl` in the data folder
  and shown in Settings.
- `Settings.tokenSaver` (`outputFilter`, `bashOutputMaxChars`, `subagentModel`), all off by default and all set by
  the "Save tokens" preset (filter on, 12k limit, helpers on Sonnet). Passed to Claude as `--settings` through the
  session `_meta` (same route as skill overrides) and `CLAUDE_CODE_SUBAGENT_MODEL`.
- Always on for Claude agents: prompt suggestions off (`promptSuggestions: false`, `promptSuggestionEnabled: false`).
- Two new Usage insights: a big conversation idle past the one-hour cache, and helpers running on the agent's model.
- Not verified without a model call: that Claude Code applies the hook's `updatedToolOutput` for a live Bash call,
  and the size of the saving from prompt suggestions and the helper model.

## What was built, round 1


`Settings.autoCompactWindow` (new file `token_saver.rs`; one-line hook where the agent's environment is built),
the "Save tokens" preset (`apply_token_saver`: 250k window, concise replies, medium effort for new Claude agents;
never touches model or budgets), Settings > Behavior > Save tokens, and a Save tokens panel on the Usage page
(`lib/tokenInsights.ts`) covering long contexts, missing compact size, high effort, pricey agents, parallel
agents against the account window, and many MCP servers.
