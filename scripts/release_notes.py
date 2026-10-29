#!/usr/bin/env python3
"""Release notes for a version, taken from its CHANGELOG.md section.

    release_notes.py v1.2.3     print the GitHub release body for that tag
    release_notes.py --check    check the version in Cargo.toml has notes (CI)

Exits non-zero, with a GitHub Actions error annotation, when the section is missing or empty,
so a release can't ship without notes.
"""

import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHANGELOG = ROOT / "CHANGELOG.md"
HEADING = re.compile(r"^## +(v?\d+\.\d+\.\d+\S*|Unreleased)\b.*$", re.MULTILINE)

INSTALL = """### Install

- **macOS**: `.dmg` (universal: Apple Silicon + Intel)
- **Windows**: `-setup.exe`
- **Linux**: `.AppImage`, `.deb` or `.rpm`

Already installed? Armada updates itself (Settings → About → Check for updates)."""


def fail(msg: str) -> None:
    print(f"::error file=CHANGELOG.md::{msg}", file=sys.stderr)
    sys.exit(1)


def sections(text: str) -> list[tuple[str, str]]:
    """(version, body) per `## ` heading, in file order. Versions are normalized to `v1.2.3`."""
    found = list(HEADING.finditer(text))
    out = []
    for i, m in enumerate(found):
        end = found[i + 1].start() if i + 1 < len(found) else len(text)
        name = m.group(1)
        if name != "Unreleased" and not name.startswith("v"):
            name = "v" + name
        out.append((name, text[m.end() : end].strip()))
    return out


def notes_for(tag: str) -> tuple[str, str | None]:
    """The section body for `tag` and the previous released version (if any)."""
    if not CHANGELOG.exists():
        fail("CHANGELOG.md is missing")
    all_sections = sections(CHANGELOG.read_text(encoding="utf-8"))
    for i, (name, body) in enumerate(all_sections):
        if name == tag:
            if not body:
                fail(f"The {tag} section of CHANGELOG.md is empty: write the release notes first")
            prev = next((n for n, _ in all_sections[i + 1 :] if n != "Unreleased"), None)
            return body, prev
    fail(
        f"CHANGELOG.md has no '## {tag}' section. Rename '## Unreleased' to '## {tag}' "
        "(or add the section) before releasing."
    )
    raise AssertionError("unreachable")


BLOCK_START = re.compile(r"^(\s*([-*+]|\d+[.)])\s|#|>|\||```)")


def unwrap(md: str) -> str:
    """Joins hard-wrapped lines: GitHub release pages render each newline as a line break."""
    out: list[str] = []
    fenced = False
    for line in md.splitlines():
        if line.lstrip().startswith("```"):
            fenced = not fenced
            out.append(line)
            continue
        prev = out[-1] if out else ""
        if (
            not fenced
            and line.strip()
            and prev.strip()
            and not prev.lstrip().startswith(("#", "```", "|"))
            and not BLOCK_START.match(line)
        ):
            out[-1] = f"{prev.rstrip()} {line.strip()}"
        else:
            out.append(line)
    return "\n".join(out)


def cargo_version() -> str:
    text = (ROOT / "Cargo.toml").read_text(encoding="utf-8")
    m = re.search(r'^version = "([^"]+)"', text, re.MULTILINE)
    if not m:
        fail("No version found in Cargo.toml")
    return m.group(1)


def main(argv: list[str]) -> None:
    # Windows runners default stdout to a legacy code page that can't encode notes like "⌘".
    sys.stdout.reconfigure(encoding="utf-8")
    if argv == ["--check"]:
        tag = "v" + cargo_version()
        notes_for(tag)
        print(f"CHANGELOG.md has release notes for {tag}")
        return
    if len(argv) != 1 or not argv[0].startswith("v"):
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    tag = argv[0]
    body, prev = notes_for(tag)
    parts = [unwrap(body), INSTALL]
    repo = os.environ.get("GITHUB_REPOSITORY")
    if repo and prev:
        parts.append(f"**Full changelog**: https://github.com/{repo}/compare/{prev}...{tag}")
    print("\n\n".join(parts))


if __name__ == "__main__":
    main(sys.argv[1:])
