"""ACP agent for tests that reports a usage limit until a moment passes, then works.

Its behaviour is read from `.mock-limit.json` in its working folder on every prompt, so one command
serves many tests and a test can change it mid-way:

  {"lifts_at": <unix ms, or null = never>, "message": "<the error text>", "rate_limit": <_claude/rateLimit meta or null>}

Prompts it received (and whether it refused them) are appended to `.mock-limit.log` as JSON lines.
"""

import json
import os
import sys
import time


def send(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def update(session_id, upd):
    send({"jsonrpc": "2.0", "method": "session/update",
          "params": {"sessionId": session_id, "update": upd}})


def read():
    line = sys.stdin.readline()
    if not line:
        sys.exit(0)
    return json.loads(line)


def config():
    try:
        with open(".mock-limit.json") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def log(text, refused):
    with open(".mock-limit.log", "a") as f:
        f.write(json.dumps({"text": text, "refused": refused, "at": int(time.time() * 1000)}) + "\n")


while True:
    msg = read()
    method = msg.get("method")
    mid = msg.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": 1,
            "agentCapabilities": {"loadSession": True, "sessionCapabilities": {"resume": {}}},
            "authMethods": []}})
    elif method in ("session/new", "session/resume", "session/load"):
        sid = msg["params"].get("sessionId", "mock-limit-session")
        send({"jsonrpc": "2.0", "id": mid, "result": {"sessionId": sid}})
    elif method == "session/prompt":
        sid = msg["params"]["sessionId"]
        text = msg["params"]["prompt"][0]["text"]
        cfg = config()
        lifts_at = cfg.get("lifts_at")
        limited = lifts_at is None or time.time() * 1000 < lifts_at
        log(text, limited)
        if limited:
            if cfg.get("rate_limit"):
                update(sid, {"sessionUpdate": "usage_update", "used": 10, "size": 1000,
                             "_meta": {"_claude/rateLimit": cfg["rate_limit"]}})
            send({"jsonrpc": "2.0", "id": mid, "error": {
                "code": -32000, "message": cfg.get("message", "You've hit your usage limit")}})
            continue
        update(sid, {"sessionUpdate": "agent_message_chunk",
                     "content": {"type": "text", "text": "Continuing: " + text}})
        send({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "end_turn"}})
    elif mid is not None and method is not None:
        send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "unsupported"}})
