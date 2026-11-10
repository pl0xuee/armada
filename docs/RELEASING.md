# Releasing Kvistcode

Installed copies of Kvistcode check GitHub Releases for updates (15 seconds after launch, then every 6 hours, plus Settings → General → "Check for updates").

- **Windows, macOS, Linux AppImage** install updates in place. The updater reads `latest.json` from the latest published release and verifies each download against the public key in `apps/desktop/src-tauri/tauri.conf.json` before installing.
- **deb / rpm** installs are owned by the system package manager. Kvistcode asks the GitHub Releases API whether a newer version exists and links to the release page.

## Release notes

Every release has notes, written in [`CHANGELOG.md`](../CHANGELOG.md). Add user-facing entries under `## Unreleased` as you go (what changed for people using the app, not commit subjects). The section for a version becomes:

- the GitHub release body (followed by install instructions and a "Full changelog" compare link), and
- the notes shown by the in-app updater ("Release notes" on the update pill), via `latest.json`.

`scripts/release_notes.py` enforces this. CI runs `release_notes.py --check`, which fails when the version in `Cargo.toml` has no non-empty section. A release fails before building anything when its version has none. Preview a release body with `python3 scripts/release_notes.py v0.2.0`.

## How CI works

There is one workflow, `.github/workflows/ci.yml`, and it does the same thing on every run:

1. **linux**: release notes check, command contract, the unix-test gate check, formatting, phone and desktop UI tests and builds, clippy, Rust tests.
2. **macOS** and **Windows**: clippy and Rust tests, once linux passes.
3. **e2e**: builds the real app and drives it headless with WebDriver (`apps/desktop/e2e`), once linux passes. It walks every rail view (Projects, Mission Control, Compare, Schedules, Usage, Accounts), both Mission Control tabs, the command palette and its conversation search (`?`), every Settings page including Tools & instructions, and the welcome tour (opened from Settings → About, because the app never opens it by itself under WebDriver). It fails on any uncaught JS error, error toast or "state not managed" message.
4. **draft**, then **release**: on a push to `main`, once 1–3 pass, if the version in `Cargo.toml` hasn't been tagged yet. `draft` creates a draft release for it; `release` builds and signs the installers into that draft (it uses the `release` repository environment, so required reviewers added there approve every release).

Changes are pushed straight to `main`; every push runs 1–3. Dependabot's pull requests run 1–3 too (with no secrets). A weekly `audit.yml` checks `Cargo.lock` against the RustSec advisory database.

### Concurrency: what happens when pushes overlap

The workflow's concurrency group is per ref. On pull requests a newer push cancels the running check. On `main` nothing running is ever cancelled, so a release is never cut off half-way. GitHub keeps **one running and one queued** run per group, and a third push **cancels the queued run** (the log says "Canceling since a higher priority waiting request … exists"). That is safe: whichever run reaches the `draft` job decides on the release by looking at `Cargo.toml` and the tags, and the newest run contains every earlier commit. A bump that was queued and then replaced still releases, from the newer commit.

Two consequences to know about:

- While a run waits for release approval (the `release` environment), later pushes to `main` queue behind it. Approve or reject it, or the queue stalls.
- Pushing to `main` while a draft exists rebuilds the whole draft (about as long as a release build) even if the push was a docs change. Hold unrelated pushes until you have published.

Run the e2e test locally with `apps/desktop/e2e/run.sh` after `npm run tauri build -- --debug --no-bundle` (needs `tauri-driver`, `WebKitWebDriver`, `xvfb`). Without those, `KVISTCODE_E2E_URL=http://localhost:<port> node smoke.mjs` in `apps/desktop/e2e` drives the mock-backed UI (`npm run dev --port <port>` in `apps/desktop`) through chromedriver on port 9515. That covers the UI walk-through but not the real backend.

## Cutting a release

There's no tag to push: bumping the version on `main` is the release.

### Pre-release checklist

- [ ] Everything you want in the release is merged, and CI on `main` is green on **all three OSes**. The Windows job is the one that catches Unix-only test code (see below).
- [ ] Open Dependabot pull requests are merged or consciously left for later (a merge after the bump restarts the draft).
- [ ] `CHANGELOG.md` has a section for the new version, written for users, with the date. `python3 scripts/release_notes.py --check` passes.
- [ ] All three versions agree (`Cargo.toml`, `apps/desktop/package.json`, `apps/remote/package.json`) and `Cargo.lock` / the npm lock files were refreshed.
- [ ] `python3 scripts/check_contract.py` and `python3 scripts/check_unix_tests.py` pass.
- [ ] You did not rename any identifier from the "names that still say armada" table below.
- [ ] If anything touching the updater changed (`tauri.conf.json` endpoints or pubkey, signing secrets), test an update from the previous release before publishing.

### Steps

1. Bump the version everywhere (the release fails if they differ):
   - `Cargo.toml` → `[workspace.package] version` (then `cargo check` to update `Cargo.lock`)
   - `apps/desktop/package.json` and `apps/remote/package.json` → `version` (then `npm install` in each to update the lock files)
   - `tauri.conf.json` has no version on purpose: Tauri takes it from `Cargo.toml`.
2. In `CHANGELOG.md`, rename `## Unreleased` to `## v0.2.0 — <date>` and review the notes.
3. Commit and push to `main`. Once every check passes, CI creates a **draft** release `v0.2.0` with the notes as its body, builds macOS (universal), Windows and Linux installers, signs the update bundles and uploads everything plus `latest.json` to it.
4. [Verify the draft](#verifying-a-draft) below.
5. Press **Publish**. Publishing creates the `v0.2.0` tag on the commit the draft was built from. Edits to the draft's notes change the GitHub page only: the in-app updater reads the copy already baked into `latest.json`, so fix notes in `CHANGELOG.md` and push. Only published releases are visible to the updater, so this is the moment the update rolls out.
6. Run `python3 scripts/verify_release.py v0.2.0 --live` once more (see below) and check Settings → General → "Check for updates" from an older install if you can.

Pushing more commits to `main` before publishing replaces the draft with a fresh one built from the newest commit. Once the version is tagged (published), later pushes don't release until the version is bumped again. If a release build fails for a flaky reason, re-run the failed jobs (the `draft` job's output is kept, so the retried build uploads into the same draft, replacing assets of the same name); for a real bug, push the fix and the draft is rebuilt. "Re-run all jobs" deletes the draft and builds it again.

## Verifying a draft

Drafts are invisible to the updater and to anonymous visitors, so look at them as a repo writer. With the GitHub CLI logged in:

```bash
python3 scripts/verify_release.py v0.2.0
```

It checks that:

- the release has the installers: `…_x64-setup.exe`, `…_amd64.AppImage`, `…_amd64.deb`, `….x86_64.rpm`, `…_universal.dmg` and `…_universal.app.tar.gz`, named `Kvistcode…` (an `Armada…` name means a stale build);
- every updater bundle (everything except the `.dmg`) has a matching `.sig`;
- `latest.json` is for this version, has `darwin-*`, `linux-*` and `windows-*` entries (a missing platform means two upload jobs overwrote each other's `latest.json`: re-run the failed `release` job), every entry has a non-empty signature, and each URL is one of this release's assets;
- the notes in `latest.json` are the version's `CHANGELOG.md` section.

By hand: `gh release view v0.2.0 --json isDraft,assets --jq '{draft: .isDraft, assets: [.assets[].name]}'`, then `gh release download v0.2.0 -p latest.json -D "$TMPDIR/draft"` and open the file. Also skim the release body, and download one installer for your OS and start it if you can.

After publishing, `--live` also fetches what installed copies fetch:

```bash
python3 scripts/verify_release.py v0.2.0 --live
# https://github.com/pl0xuee/kvistcode/releases/latest/download/latest.json  (the address in tauri.conf.json)
# https://github.com/pl0xuee/armada/releases/latest/download/latest.json     (the pre-rename address)
```

Both must serve the new version. Copies of Armada from before the rename (up to 0.2.0) still ask the old `pl0xuee/armada` address; GitHub redirects it to this repository because the repository was renamed, not recreated. If that redirect ever stops working (for example if someone creates a new `pl0xuee/armada` repository), those copies can no longer update. Never create a repository by that name.

## Why things are the way they are

### The rename was done in place

When Armada became Kvistcode (0.3.0), the existing repository was **renamed** instead of starting a new one. The reasons, so nobody "cleans it up" later:

- GitHub redirects the old repository address, including `releases/latest/download/latest.json`. That is how Armada 0.2.0 and older found 0.3.0 and updated themselves into Kvistcode.
- The updater signing key exists only as repository secrets (next section). A new repository would have meant a new key, and a new key means every installed copy rejects the update.
- Issues, history, stars and links keep working.

The same reasoning is why app identifiers were **not** renamed: the data folder, keychain entries, window storage and the single-instance lock all hang off `dev.armada.app`. The table at the end lists what stays.

### The signing key lives only in repository secrets

| What | Where |
|---|---|
| Public key | `plugins.updater.pubkey` in `tauri.conf.json` (committed) |
| Private key | the `TAURI_SIGNING_PRIVATE_KEY` repository secret, and nowhere else |
| Key password | the `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repository secret |

It is a minisign key made with `tauri signer generate`. No copy of the private key is kept outside GitHub (the old `~/.tauri/armada-updater.*` files no longer exist on the maintainer's machine), and CI uses it only in the `tauri-action` step of the `release` job; pull requests (Dependabot and forks included) never receive it. The cost is that **secrets can't be read back**: if the repository is deleted, or a secret overwritten, the key is gone. Existing installs could then never verify another update, and every user would have to reinstall by hand once. So:

- Don't delete or recreate the repository (this is also why the rename was done in place). Don't transfer it without checking that the secrets move with it.
- Only change the two secrets on purpose (rotation).
- There is no way to extract the current key. If you want an offline backup, the only way is to rotate to a new key and store it at the moment you generate it.

To rotate (this strands every existing install, so it is a last resort): run `npx tauri signer generate -w <file>`, set the new public key in `tauri.conf.json`, and set both secrets with `gh secret set NAME < file`. Ship the key change in a release signed with the **old** key first if you can, so installs pick up the new public key.

### Where the signing secrets are exposed, and the `release` environment

`TAURI_SIGNING_PRIVATE_KEY` and its password are set as `env` of one step only: the `tauri-action` step of the `release` job. No other job or step receives them, and that job runs only on pushes to `main` (never for pull requests, forks or Dependabot). Inside that step, though, everything `tauri build` runs sees them: the frontend build and every Cargo build script. That is why dependency updates are reviewed and builds use `--locked` and `npm ci`.

The `release` job uses `environment: release`. **Give that environment required reviewers** (repository Settings → Environments → release → Required reviewers → yourself) and, ideally, restrict it to the `main` branch. Without reviewers the environment is only a label and every push that bumps the version builds and signs immediately; with them, a person approves each signing run (and pushes to `main` queue behind a run that waits, see above). The two signing secrets are repository secrets, and since the key can't be read back they can't be moved into the environment without rotating the key; so the environment's reviewers gate the job, not the secrets themselves.

### Draft, then publish

CI never publishes. The `draft` job creates a draft release (`target_commitish` = the commit CI ran on), and only after that do the three build jobs upload into it by release id. A half-built release therefore never reaches users: the updater only sees published releases, and publishing is a person pressing a button after [verifying the draft](#verifying-a-draft). The tag does not exist until then, which is also how CI knows the version is still unreleased (`git/ref/tags/v<version>` returns 404). An already tagged version is skipped: bump the version to release again.

### Lint, dead code and Windows

Linux CI cannot see Windows-only lint failures. Real example: a test module's helpers (`Rig`, `Recorder`, constants and imports) were only used by tests marked `#[cfg(unix)]` because they start `python3` mock agents. On Linux everything was used; on Windows the helpers were dead code and `cargo clippy -- -D warnings` failed there. The fix is to gate the helpers with the same `#[cfg(unix)]`. Rules:

- Tests that start python3 mocks or use `libc` are `#![cfg(unix)]` (or `#[cfg(unix)]` per test), **and so is everything only they use**.
- `scripts/check_unix_tests.py` (a CI step) catches the ungated test files and functions. Ungated helpers it can't see, so keep an eye on the Windows job and don't release with it red.
- You can't reproduce Windows clippy on Linux; push to `main` early in the day and let the Windows job run before you bump the version.

## Signing: OS code signing (optional)

The release job in `ci.yml` has a placeholder comment for Apple notarization and Windows Authenticode secrets. Without them, macOS Gatekeeper and Windows SmartScreen show a warning on first install. Updates still verify through the updater key above.

## Building locally

The phone companion is embedded into the desktop binary, and release builds refuse to compile without it:

```bash
(cd apps/remote && npm ci && npm run build)
cd apps/desktop && npm ci && npm run tauri build -- --no-bundle   # or add --config '{"bundle":{"createUpdaterArtifacts":false}}' for installers
```

`tauri.conf.json` sets `createUpdaterArtifacts`, so a bundling build without `TAURI_SIGNING_PRIVATE_KEY` compiles everything and then fails with "A public key has been found, but no private key". That is expected locally; only CI has the key.

(`beforeBuildCommand` rebuilds it too; set `KVISTCODE_ALLOW_MISSING_REMOTE=1` only for throwaway builds.)

## Names that still say "armada"

The app was renamed from Armada to Kvistcode. A few identifiers keep the old spelling on purpose, because installed copies key their data on them. Do not rename these without a migration:

| Where | What | Why |
|---|---|---|
| `tauri.conf.json` `identifier`, `KEYRING_SERVICE` | `dev.armada.app` | The data directory, stored sign-ins, window storage and the single-instance lock are all keyed on it |
| `armada.db` | database file name | Lives in the data directory |
| `localStorage` keys `armada.*` (app and phone) | UI preferences, drafts, the phone's pairing token | Renaming would reset them |
| `.armada-merge-*` | leftover-folder marker | Lets cleanup find folders from older versions |
| `~/.tauri/armada-updater.*` | updater signing key file names | Only history now: the key itself lives in repository secrets (see above) |
| `armada/…` branches | agent branches made before the rename | New ones are `kvistcode/…`; the PR base picker hides both |
| `github.com/pl0xuee/armada` | the pre-rename repository address | GitHub redirects it; old installs still ask it for updates. Never create a repository with that name |
