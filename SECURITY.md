# Security policy

Kvistcode (formerly Armada) runs coding agents on your computer with access to your projects, so we take security reports seriously.

## Reporting a vulnerability

**Please report it privately, not in a public issue.**

1. Open the repository's **Security** tab and choose **Report a vulnerability**, or go straight to
   [github.com/pl0xuee/kvistcode/security/advisories/new](https://github.com/pl0xuee/kvistcode/security/advisories/new).
   Only the maintainer can see the report.
2. If that page isn't available to you, open a public issue that says only that you have a security report and asks for a private way to send it. **Don't put details, proof-of-concept code, tokens or keys in the issue.**
Useful in a report: the Kvistcode version (Settings, About), your OS, what you did, what happened, and what you expected. Settings, About, **Copy diagnostics** is safe to include, but look it over first.

Kvistcode is a small open-source project, so there is no guaranteed response time, but reports are read and acted on as soon as possible. Say if you'd like to be credited in the release notes.

## What is in scope

- The desktop app and its updater (signature verification, downloads, the release pipeline).
- The phone companion and its pairing, tokens and read-only share links.
- How credentials are stored (OS keychain, per-account config folders), and anything that leaks them into logs, notifications, checkpoints, webhooks or phone pushes.
- Approval handling: an agent doing something that should have asked you first.
- The command channel between the UI and the app (Tauri commands, the local preview proxy, the remote-control server).

Out of scope: vulnerabilities in the agents themselves (Claude Code, Codex, Grok Build, Ollama and so on; report those to their vendors), attacks that need an already compromised computer or account, exposing the phone companion's port to the internet against the documentation's advice, and missing hardening on a network you chose to trust (the local-network mode is plain HTTP by design; Tailscale mode uses HTTPS).

## Supported versions

Only the latest release gets security fixes. Installed copies update themselves with signed updates, so staying current is usually automatic; `.deb` and `.rpm` installs are told when a new version exists.

## Verifying a download

Releases are built by CI from this repository. Update bundles are signed with a minisign key whose public half is in `apps/desktop/src-tauri/tauri.conf.json` (`plugins.updater.pubkey`); the app refuses an update that doesn't verify. The installers themselves are not yet OS code-signed, so macOS Gatekeeper and Windows SmartScreen may warn on first install.
