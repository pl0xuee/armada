#!/usr/bin/env python3
"""UI <-> Rust command contract check (no build needed).

Parses every `invoke("name", {keys})` in apps/desktop/src/lib/api.ts and every
`#[tauri::command]` in apps/desktop/src-tauri/src, and fails on:
  * a UI call to a command that does not exist,
  * a command that is not in `handler!()` (unregistered; the UI call would reject),
  * a registered command nobody wires up in api.ts (warning only),
  * argument key mismatches (camelCase of the Rust parameter, honoring
    `rename_all`; Option<_> parameters may be omitted; State/AppHandle/Window
    parameters are not arguments, a Channel is),
  * an `ArmadaApi` method in api.ts that mock.ts does not implement.

Usage: python3 scripts/check_contract.py
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUST = ROOT / "apps/desktop/src-tauri/src"
API = ROOT / "apps/desktop/src/lib/api.ts"
MOCK = ROOT / "apps/desktop/src/lib/mock.ts"

errors: list[str] = []
warnings: list[str] = []


def camel(s: str) -> str:
    head, *rest = s.split("_")
    return head + "".join(p[:1].upper() + p[1:] for p in rest)


def split_top(text: str, sep: str = ",", quotes: str = "\"'`") -> list[str]:
    parts, depth, cur, quote = [], 0, "", None
    for c in text:
        if quote:
            cur += c
            if c == quote:
                quote = None
            continue
        if c in quotes:
            quote = c
        elif c in "<([{":
            depth += 1
        elif c in ">)]}":
            depth -= 1
        elif c == sep and depth == 0:
            parts.append(cur)
            cur = ""
            continue
        cur += c
    if cur.strip():
        parts.append(cur)
    return parts


def balanced(text: str, start: int, open_c: str, close_c: str) -> int:
    """Index of the bracket closing the one at `start`."""
    depth = 0
    for i in range(start, len(text)):
        if text[i] == open_c:
            depth += 1
        elif text[i] == close_c:
            depth -= 1
            if depth == 0:
                return i
    raise ValueError("unbalanced")


# ---- Rust side -------------------------------------------------------------

NON_ARG = re.compile(
    r"^(?:tauri::)?(?:State<|AppHandle\b|Window\b|WebviewWindow\b|Webview\b|Runtime|ipc::Request)"
)

commands: dict[str, dict] = {}
for path in sorted(RUST.rglob("*.rs")):
    text = path.read_text()
    for m in re.finditer(r"#\[tauri::command(\([^\]]*\))?\]", text):
        attr = m.group(1) or ""
        snake = "rename_all" in attr and "snake_case" in attr
        fm = re.compile(r"(?:pub(?:\([a-z]+\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(").search(text, m.end())
        if not fm:
            continue
        open_i = fm.end() - 1
        params = text[open_i + 1 : balanced(text, open_i, "(", ")")]
        required, optional = set(), set()
        for p in split_top(params, quotes="\""):
            p = p.strip()
            if ":" not in p:
                continue
            name, ty = p.split(":", 1)
            name = name.strip().removeprefix("mut ").strip()
            ty = re.sub(r"\s+", "", ty)
            if NON_ARG.match(ty):
                continue
            key = name if snake else camel(name)
            (optional if ty.startswith("Option<") else required).add(key)
        commands[fm.group(1)] = {
            "file": path.relative_to(ROOT),
            "required": required,
            "optional": optional,
        }

lib = (RUST / "lib.rs").read_text()
start = lib.index("tauri::generate_handler![")
registered = {
    l.strip().rstrip(",").split("::")[-1]
    for l in lib[start : lib.index("]", start)].splitlines()[1:]
    if l.strip().endswith(",")
}

# ---- UI side ---------------------------------------------------------------

api = API.read_text()
used: dict[str, set[str] | None] = {}
for m in re.finditer(r"\binvoke(?:<)?", api):
    i = m.end()
    if api[m.start() + 6 : m.start() + 7] == "<":
        i = balanced(api, m.start() + 6, "<", ">") + 1
    if not api.startswith("(", i):
        continue
    close = balanced(api, i, "(", ")")
    args = split_top(api[i + 1 : close])
    nm = re.fullmatch(r'\s*"(\w+)"\s*', args[0]) if args else None
    if not nm:
        continue
    keys = None
    if len(args) > 1:
        obj = args[1].strip()
        if obj.startswith("{"):
            keys = set()
            for prop in split_top(obj[1:-1]):
                prop = prop.strip()
                km = re.match(r"(\w+)", prop)
                if km:
                    keys.add(km.group(1))
    used[nm.group(1)] = keys if keys is not None else set()

for name, keys in sorted(used.items()):
    spec = commands.get(name)
    if spec is None:
        errors.append(f"api.ts invokes unknown command `{name}`")
        continue
    missing = spec["required"] - keys
    extra = keys - spec["required"] - spec["optional"]
    if missing:
        errors.append(f"`{name}`: api.ts does not pass required key(s) {sorted(missing)}")
    if extra:
        errors.append(f"`{name}`: api.ts passes key(s) {sorted(extra)} the Rust command does not take")

for name in sorted(registered - set(used)):
    if name not in commands:
        errors.append(f"handler!() lists `{name}` but no #[tauri::command] fn has that name")
    else:
        warnings.append(f"command `{name}` is registered but never invoked from api.ts")

for name in sorted(set(commands) - registered):
    errors.append(f"`{name}` ({commands[name]['file']}) is a #[tauri::command] but not in handler!()")

# ---- mock implements every api method --------------------------------------

def object_keys(text: str, anchor: str) -> set[str]:
    """Top-level (2-space indented) members of `<anchor> ... = {` up to the closing `};`."""
    at = text.index(anchor)
    end = text.index("\n};", at)
    return set(re.findall(r"(?m)^  (?:async\s+)?(\w+)\s*[:(]", text[at:end]))


try:
    api_keys = object_keys(api, "const tauriApi")
    mock_keys = object_keys(MOCK.read_text(), "export const mockApi")
    for k in sorted(api_keys - mock_keys):
        errors.append(f"mock.ts does not implement api method `{k}`")
    if len(api_keys) < 50:
        errors.append(f"parsed only {len(api_keys)} api methods; parser out of date?")
except ValueError as e:
    errors.append(f"could not parse api/mock objects: {e}")

for w in warnings:
    print(f"warning: {w}")
if errors:
    print("UI <-> Rust contract violations:", file=sys.stderr)
    for e in errors:
        print(f"  - {e}", file=sys.stderr)
    sys.exit(1)
print(f"contract ok: {len(used)} invoked commands, {len(registered)} registered, {len(commands)} defined")
