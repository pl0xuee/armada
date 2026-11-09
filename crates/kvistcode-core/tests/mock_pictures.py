"""Minimal ACP agent for tests: takes pictures, records the picture bytes it was sent
(MOCK_LOG), and answers with a picture in its reply and one in a tool call."""

import json
import os
import sys

# A 1x1 PNG.
PNG = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/"
       "iZk9HQAAAABJRU5ErkJggg==")


def send(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def update(sid, upd):
    send({"jsonrpc": "2.0", "method": "session/update",
          "params": {"sessionId": sid, "update": upd}})


def log(entry):
    path = os.environ.get("MOCK_LOG")
    if path:
        with open(path, "a") as f:
            f.write(json.dumps(entry) + "\n")


while True:
    line = sys.stdin.readline()
    if not line:
        sys.exit(0)
    msg = json.loads(line)
    method, mid = msg.get("method"), msg.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": 1,
            "agentCapabilities": {"promptCapabilities": {"image": True}},
            "authMethods": []}})
    elif method in ("session/new", "session/resume", "session/load"):
        send({"jsonrpc": "2.0", "id": mid, "result": {"sessionId": msg["params"].get("sessionId", "pic-session")}})
    elif method == "session/prompt":
        sid = msg["params"]["sessionId"]
        for block in msg["params"]["prompt"]:
            if block.get("type") == "image":
                log({"image": block.get("data", "")})
        update(sid, {"sessionUpdate": "tool_call", "toolCallId": "shot", "title": "Screenshot",
                     "kind": "other", "status": "completed",
                     "content": [{"type": "content", "content": {"type": "image", "mimeType": "image/png", "data": PNG}}]})
        update(sid, {"sessionUpdate": "agent_message_chunk",
                     "content": {"type": "image", "mimeType": "image/png", "data": PNG}})
        update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Here you go."}})
        send({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "end_turn"}})
    elif mid is not None and method is not None:
        send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "unsupported"}})
