#!/usr/bin/env python3
"""Checks a Kvistcode GitHub release (a draft before you press Publish, or a published one).

  python3 scripts/verify_release.py v0.3.2           # a draft or a published release
  python3 scripts/verify_release.py v0.3.2 --live    # also what installed copies see right now

It looks at the release's assets and its latest.json, the file the in-app updater reads:

  * every installer is there, and every updater bundle has its .sig;
  * latest.json is for this version, covers macOS, Linux and Windows, and each entry has a
    signature and points at an asset of this release (a missing platform means two matrix jobs
    overwrote each other's upload: re-run the failed release job);
  * its notes match the version's section in CHANGELOG.md;
  * with --live (published releases only): the updater address in tauri.conf.json, and the old
    pl0xuee/armada address that GitHub redirects, both serve this version.

Drafts need the GitHub CLI (`gh auth login`), because only repo writers can see them.
Exit code 1 on any problem.
"""
import json
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO = "pl0xuee/kvistcode"
OLD_REPO = "pl0xuee/armada"


def gh_json(*args: str):
    out = subprocess.run(["gh", "api", *args], capture_output=True, text=True, timeout=60, check=True)
    return json.loads(out.stdout)


def http(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "kvistcode-verify-release"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def release_for(tag: str) -> dict:
    try:
        releases = gh_json(f"repos/{REPO}/releases?per_page=100")
    except (OSError, subprocess.SubprocessError):
        releases = json.loads(http(f"https://api.github.com/repos/{REPO}/releases?per_page=100"))
    for r in releases:
        if r["tag_name"] == tag:
            return r
    sys.exit(f"no release for {tag} (a draft is only visible to `gh` when you are logged in)")


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 1:
        print(__doc__)
        return 2
    tag, live = args[0], "--live" in sys.argv
    version = tag.removeprefix("v")
    problems: list[str] = []
    rel = release_for(tag)
    names = {a["name"]: a for a in rel["assets"]}
    print(f"{tag}: {'DRAFT' if rel['draft'] else 'published'}, {len(names)} assets")

    # ---- assets -------------------------------------------------------------------
    bundles = {
        "setup": rf"Kvistcode_{re.escape(version)}_x64-setup\.exe",
        "AppImage": rf"Kvistcode_{re.escape(version)}_amd64\.AppImage",
        "deb": rf"Kvistcode_{re.escape(version)}_amd64\.deb",
        "rpm": rf"Kvistcode-{re.escape(version)}-1\.x86_64\.rpm",
        "mac app": rf"Kvistcode_{re.escape(version)}_universal\.app\.tar\.gz",
    }
    for label, pat in bundles.items():
        found = [n for n in names if re.fullmatch(pat, n)]
        if not found:
            problems.append(f"missing {label} bundle (expected {pat})")
        elif found[0] + ".sig" not in names:
            problems.append(f"{found[0]} has no .sig")
    if f"Kvistcode_{version}_universal.dmg" not in names:
        problems.append("missing the macOS .dmg")
    if "latest.json" not in names:
        problems.append("missing latest.json")
    for n in names:
        if not n.startswith(("Kvistcode", "latest")):
            problems.append(f"unexpected asset name {n} (pre-rename build?)")

    # ---- latest.json --------------------------------------------------------------
    if "latest.json" in names:
        asset = names["latest.json"]
        try:
            raw = subprocess.run(
                ["gh", "api", "-H", "Accept: application/octet-stream", f"repos/{REPO}/releases/assets/{asset['id']}"],
                capture_output=True, timeout=60, check=True,
            ).stdout
        except (OSError, subprocess.SubprocessError):
            raw = http(asset["browser_download_url"])
        data = json.loads(raw)
        if data.get("version") != version:
            problems.append(f"latest.json is for {data.get('version')}, not {version}")
        plat = data.get("platforms", {})
        for prefix in ("darwin-", "linux-", "windows-"):
            if not any(k.startswith(prefix) for k in plat):
                problems.append(f"latest.json has no {prefix}* platform")
        for k, v in plat.items():
            if not v.get("signature"):
                problems.append(f"latest.json {k}: empty signature")
            # tauri-action writes the asset's API address (.../releases/assets/<id>), which the
            # updater fetches as application/octet-stream; a plain download URL is fine too.
            url = v.get("url", "")
            tail = url.rsplit("/", 1)[-1]
            if tail not in names and tail not in {str(a["id"]) for a in rel["assets"]}:
                problems.append(f"latest.json {k}: {url or 'no url'} is not an asset of this release")
        changelog = (ROOT / "CHANGELOG.md").read_text()
        m = re.search(rf"(?ms)^## {re.escape(tag)}\b.*?\n(.*?)(?=^## |\Z)", changelog)
        want = (m.group(1).strip() if m else "")
        # The Windows upload job may write the notes with CRLF line endings: the text is the same.
        if want and want not in data.get("notes", "").replace("\r\n", "\n"):
            problems.append("latest.json notes differ from the CHANGELOG.md section (fix the changelog and push)")
        print(f"latest.json: version {data.get('version')}, {len(plat)} platform entries")

    # ---- what installed copies see ------------------------------------------------
    if live:
        if rel["draft"]:
            problems.append("--live only makes sense once the release is published")
        else:
            for repo in (REPO, OLD_REPO):
                url = f"https://github.com/{repo}/releases/latest/download/latest.json"
                try:
                    seen = json.loads(http(url)).get("version")
                except Exception as e:  # noqa: BLE001
                    seen = f"error: {e}"
                print(f"{url} -> {seen}")
                if seen != version:
                    problems.append(f"{url} serves {seen}, not {version}")

    for p in problems:
        print(f"PROBLEM: {p}", file=sys.stderr)
    print("release ok" if not problems else f"{len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
