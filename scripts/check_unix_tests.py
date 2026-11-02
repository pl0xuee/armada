#!/usr/bin/env python3
"""Fails when a Rust test that needs a Unix-only mock is not gated to Unix.

Tests that start `python3` mock agents or call `libc::` cannot run on Windows. Linux CI
cannot notice a missing gate; the Windows job only notices once a build or test fails
there (or, for helpers left ungated, as a `dead_code` error under `clippy -D warnings`).
This catches the first two cases at the cheapest point:

  * every `crates/*/tests/*.rs` and `apps/*/src-tauri/tests/*.rs` file that mentions
    `python3`, a `mock_*.py` script or `libc::` must start with `#![cfg(unix)]`;
  * inside `src/**/*.rs`, a `#[test]` / `#[tokio::test]` function whose body mentions
    `python3` or `libc::` must carry `#[cfg(unix)]` among its attributes.

(Helpers used only by gated tests need the gate too, or Windows clippy reports them as
dead code. That part cannot be checked here: the Windows CI job covers it.)

Usage: python3 scripts/check_unix_tests.py
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NEEDS_UNIX = re.compile(r"python3|\bmock_\w+\.py|\blibc::")
TEST_ATTR = re.compile(r"#\[(?:tokio::)?test\b")


def balanced_end(text: str, open_i: int) -> int:
    depth = 0
    for i in range(open_i, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return i
    return len(text)


errors: list[str] = []
roots = [ROOT / "crates", ROOT / "apps"]
rust = [p for r in roots for p in r.rglob("*.rs") if "target" not in p.parts and "node_modules" not in p.parts]

for path in sorted(rust):
    text = path.read_text()
    rel = path.relative_to(ROOT)
    if "tests" in path.parent.parts and path.parent.name == "tests":
        if NEEDS_UNIX.search(text) and not re.search(r"(?m)^#!\[cfg\(unix\)\]", text):
            errors.append(f"{rel}: uses python3/libc but has no `#![cfg(unix)]`")
        continue
    if not NEEDS_UNIX.search(text):
        continue
    for m in TEST_ATTR.finditer(text):
        fn = re.compile(r"fn\s+\w+[^{]*\{").search(text, m.end())
        if not fn:
            continue
        body = text[fn.end() - 1 : balanced_end(text, fn.end() - 1)]
        if not NEEDS_UNIX.search(body):
            continue
        # The attribute lines around this test: scan up to the previous item boundary.
        start = text.rfind("\n\n", 0, m.start()) + 1
        attrs = text[start : fn.start()]
        if "cfg(unix)" not in attrs:
            line = text.count("\n", 0, m.start()) + 1
            errors.append(f"{rel}:{line}: test uses python3/libc but is not `#[cfg(unix)]`")

if errors:
    print("Unix-only tests without a Unix gate (they would break the Windows job):", file=sys.stderr)
    for e in errors:
        print(f"  - {e}", file=sys.stderr)
    sys.exit(1)
print(f"unix test gates ok: {len(rust)} Rust files checked")
