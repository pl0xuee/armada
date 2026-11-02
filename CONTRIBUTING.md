# Contributing to Kvistcode

Kvistcode (formerly Armada) is open source under the MIT license, and fixes and ideas are welcome.

- **Found a bug or have an idea?** Open an [issue](https://github.com/pl0xuee/kvistcode/issues/new/choose). For a security problem, follow [SECURITY.md](SECURITY.md) instead and don't file it publicly.
- **Want to change code?** For anything bigger than a small fix, open an issue first so we can agree on the approach before you spend the time.

## Setting up

[`README.md`](README.md#build-from-source) has the prerequisites and the build and run commands. `npm run dev` in `apps/desktop` runs the UI in a browser against a mock backend, which is the quickest way to work on the interface. Tests need no network or tokens: a mock ACP agent stands in for the real ones.

## Before you open a pull request

CI runs all of this, so run it first:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
(cd apps/desktop && npx tsc --noEmit && npm test)
(cd apps/remote && npm test)
python3 scripts/check_contract.py       # UI calls, Rust commands and the mock backend agree
python3 scripts/check_unix_tests.py     # tests that need python3 or libc are #![cfg(unix)]
python3 scripts/release_notes.py --check
```

Things that have bitten us:

- **Windows and macOS run the Rust tests too.** Anything Unix-only (python3 mock agents, `libc`, shell scripts) needs `#[cfg(unix)]`, including the helpers only those tests use, or Windows clippy fails with dead-code errors that Linux can't show you.
- **Commands cross a boundary.** A new or changed `#[tauri::command]` must be registered in `handler!()`, wrapped in `apps/desktop/src/lib/api.ts` and implemented in `mock.ts`; `check_contract.py` tells you what is missing.
- **Legacy `armada` names stay.** The app id `dev.armada.app`, `armada.db`, the `armada.*` storage keys and a few others are kept on purpose so installed copies keep their data. See the table in [`docs/RELEASING.md`](docs/RELEASING.md#names-that-still-say-armada) before renaming anything.
- **Don't bump the version or tag a release in a pull request.** The maintainer does that ([how releases work](docs/RELEASING.md)).

## Changelog

Add a plain-language entry under `## Unreleased` in [`CHANGELOG.md`](CHANGELOG.md) for anything people using the app will notice: write for them, not as a commit subject. Skip it for refactors, tests and CI.

## Style

Match the code around you. Rust is formatted by `cargo fmt` and must be clippy-clean; the UI is TypeScript with React. Keep pull requests focused: one change, explained in the description.
