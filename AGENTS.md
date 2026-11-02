# Kvistcode: guide for coding agents

Kvistcode (formerly Armada, renamed 2026-11-01) is a Tauri 2 desktop app that runs Claude Code, Codex, Grok and local-model agents side by side, with a phone companion. Read this first; it saves you re-exploring the repo.

## Layout
- `crates/kvistcode-core/`: Rust core. Agents, sessions, queue, budgets, storage (SQLite + FTS), ACP/Codex drivers, accounts, secrets, git, skills, MCP. Key files: `session.rs` (a turn's state machine), `manager.rs` (all agents, settings, helpers), `acp.rs` / `codex.rs` (provider drivers), `db.rs`, `budget.rs`, `model.rs` (all serde types and `Settings`). Integration tests in `tests/` use python mock agents (`tests/mock_*.py`).
- `apps/desktop/src-tauri/`: Tauri shell. `commands.rs` (every command), `lib.rs` (handler list), `remote.rs` + `remote/` (phone server), `github.rs`, `git_review.rs`, `preview_proxy.rs`, tray/notify/sound.
- `apps/desktop/src/`: React 19 + Zustand + Tailwind. `store/`, `components/{agent,timeline,mission,settings,...}`, `views/`, `lib/` (`api.ts` wraps commands, `mock.ts` + `mock-data.ts` are a full browser backend used by tests and screenshots).
- `apps/remote/`: phone app (Preact, single-file build embedded into the desktop binary).
- `docs/`: `RELEASING.md` (read before any release), `PLAN.md` (historical design), `TOKEN-SAVING.md`, `LOCAL-MODELS.md`.

## Checks (CI runs all of these; run them before you say you are done)
- `cargo fmt --all --check`
- `cargo clippy --workspace --all-targets --locked -- -D warnings`
- `cargo test --workspace --locked`
- `python3 scripts/check_contract.py`: every Tauri command must exist in Rust, `api.ts` and the mock.
- `apps/desktop` and `apps/remote`: `npx tsc --noEmit`, `npm test`, `npm run build`.
- `python3 scripts/release_notes.py --check`, `python3 scripts/check_unix_tests.py`.
Building needs `cmake` on PATH. Use a private `TMPDIR` for tests; the system `/tmp` fills up.

## Rules that have bitten us
- **Windows CI lints dead code.** A helper used only by `#[cfg(unix)]` tests must itself be `#[cfg(unix)]`. Core integration tests are `#![cfg(unix)]` (they spawn python mocks).
- **Legacy names stay.** The app id `dev.armada.app`, `KEYRING_SERVICE`, `armada.db` and every `armada.*` localStorage key are kept on purpose (installed copies key their data on them); see the table in `docs/RELEASING.md`. Never rename them without a migration.
- **Never overwrite an existing test file** (`cat >`). Add a new file or append.
- Tests must clean their temp dirs and never touch real user data (`~/.local/share/dev.armada.app`) or real GitHub/Slack.
- Time-sensitive tests: run them 100x under CPU load before trusting them (two busy loops per core). Races here are real.
- Do not `pkill -f <pattern>` from a shell whose own command line contains the pattern; kill by pid. Port 1420 is the developer's own dev server: use another port.
- Performance: whole-pixel line-heights, compositor-only animations, no polling while the window is blurred. Re-measure the 8-agent grid after UI changes.
- Never put secrets in logs, notices, exports or alert payloads; use `redact.rs`.

## Conventions
- Match the surrounding code's style and comment density. Small diffs, no refactors for taste.
- New Tauri command: Rust command + `lib.rs` handler + `api.ts` + mock + contract check.
- Persisted data must stay backward compatible (`#[serde(default)]` on new fields; old rows must load).
- User-facing wording: plain, short, no jargon; "Kvistcode", never "Armada" except in the legacy table and history.
- Commits: author is the noreply identity; do not push or tag unless asked. Releases follow `docs/RELEASING.md` (bump versions, CHANGELOG section, push `main`, CI builds a draft, verify, publish).
