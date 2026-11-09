"""ACP agent whose context is always 90% full; "/compact" brings it to 10% unless the first
argument is "stuck". Logs every prompt it gets to the file in the second argument."""

import json
import sys

STUCK = len(sys.argv) > 1 and sys.argv[1] == "stuck"
LOG = sys.argv[2] if len(sys.argv) > 2 else None


def send(m):
    sys.stdout.write(json.dumps(m) + "\n")
    sys.stdout.flush()


def update(sid, u):
    send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": u}})


for line in sys.stdin:
    msg = json.loads(line)
    method, mid = msg.get("method"), msg.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": 1, "agentCapabilities": {}, "authMethods": []}})
    elif method in ("session/new", "session/resume", "session/load"):
        send({"jsonrpc": "2.0", "id": mid, "result": {"sessionId": msg["params"].get("sessionId", "s1")}})
    elif method == "session/prompt":
        sid = msg["params"]["sessionId"]
        text = msg["params"]["prompt"][0]["text"]
        if LOG:
            with open(LOG, "a") as f:
                f.write(text + "\n")
        update(sid, {"sessionUpdate": "available_commands_update", "availableCommands": [
            {"name": "compact", "description": "Compact", "input": None}]})
        update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "reply to " + text}})
        used = 10 if text == "/compact" and not STUCK else 90
        update(sid, {"sessionUpdate": "usage_update", "used": used, "size": 100})
        send({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "end_turn"}})
    elif mid is not None:
        send({"jsonrpc": "2.0", "id": mid, "result": {}})
