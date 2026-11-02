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

## Ranked ideas (reduction x confidence / effort and risk)

| # | Idea | Est. reduction | Confidence | Status |
|---|------|---------------|-----------|--------|
| 1 | Summarize at ~250k instead of letting contexts reach 450k+ (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`) | 25-40% on the heavy agents | medium | **Built** (setting + preset) |
| 2 | Start a fresh agent from a handoff summary above ~200k context; `/clear` between tasks | 20-35% per long agent | medium | **Built** (insight; user decides) |
| 3 | Keep Opus/Fable for hard problems, Sonnet for routine work | up to ~40% of cost (80% of cost is 9% of tokens); tokens unchanged | medium | **Built** (insight; preset never changes the model) |
| 4 | Medium effort by default for new agents | 5-15% (thinking is output tokens; Claude Code's own default on the 5.5 models is medium) | low-medium (no Claude numbers published; community Codex figures of 40-60% are unverified) | **Built** (preset + one-click per agent) |
| 5 | Warn when many agents work at once on one account | prevents hitting the wall, no direct saving | high | **Built** (insight, tied to the account's window) |
| 6 | Don't switch model or let a cache idle over an hour on a big context (rebuild reads it all uncached) | situational | high | In insight text |
| 7 | Cap huge tool output (hooks that filter test/log output) | 3-5% | low | Not built (needs per-project hooks) |
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
- Sub-agents and teams each carry their own context; Anthropic cites about 7x tokens for plan-mode teams. Use a
  smaller model for them (`CLAUDE_CODE_SUBAGENT_MODEL`, `model: haiku`). code.claude.com/docs/en/costs.
- Keep CLAUDE.md under 200 lines; move rarely needed instructions to skills. Same page.
- Codex: `model_reasoning_effort` and `model_auto_compact_token_limit` exist per community guides; I could not
  confirm key names, defaults or clamping against OpenAI's reference. Grok: nothing verified. Neither is wired.
- Not verified at runtime: that the ACP Claude adapter passes the environment variable through to Claude Code
  (it inherits the process environment; the setting is off by default, so nothing changes until chosen).

## What was built

`Settings.autoCompactWindow` (new file `token_saver.rs`; one-line hook where the agent's environment is built),
the "Save tokens" preset (`apply_token_saver`: 250k window, concise replies, medium effort for new Claude agents;
never touches model or budgets), Settings > Behavior > Save tokens, and a Save tokens panel on the Usage page
(`lib/tokenInsights.ts`) covering long contexts, missing compact size, high effort, pricey agents, parallel
agents against the account window, and many MCP servers.
