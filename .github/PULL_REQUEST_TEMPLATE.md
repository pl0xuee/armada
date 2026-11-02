## What and why

<!-- What changes for people using Kvistcode, and why. Link the issue: "Closes #N". -->

## Checklist

- [ ] `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings` and `cargo test --workspace` pass
- [ ] `npx tsc --noEmit && npm test` pass in `apps/desktop` (and `npm test` in `apps/remote` if you touched the phone app)
- [ ] User-facing change: added a plain-language entry under `## Unreleased` in `CHANGELOG.md`
- [ ] New or changed `#[tauri::command]`: `python3 scripts/check_contract.py` passes (UI call, Rust command and mock agree)
- [ ] Tests that start python3 mock agents or use `libc` are `#![cfg(unix)]` (CI's Windows job runs the rest)
- [ ] Did not rename the legacy `armada` identifiers listed in `docs/RELEASING.md` (installed copies depend on them)
