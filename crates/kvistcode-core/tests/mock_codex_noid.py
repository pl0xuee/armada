"""Codex app-server stand-in whose turn events carry no turn id (the turn/start reply has one)."""
import json, sys

def send(m):
    sys.stdout.write(json.dumps(m) + "\n"); sys.stdout.flush()

while True:
    line = sys.stdin.readline()
    if not line:
        sys.exit(0)
    msg = json.loads(line); method = msg.get("method"); mid = msg.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {}})
    elif method == "thread/start":
        send({"jsonrpc": "2.0", "id": mid, "result": {"thread": {"id": "th1"}, "model": "m"}})
    elif method == "model/list":
        send({"jsonrpc": "2.0", "id": mid, "result": {"data": []}})
    elif method == "turn/start":
        send({"jsonrpc": "2.0", "id": mid, "result": {"turn": {"id": "t1"}}})
        send({"jsonrpc": "2.0", "method": "turn/started", "params": {"threadId": "th1", "turn": {}}})
        send({"jsonrpc": "2.0", "method": "item/completed", "params": {"threadId": "th1",
              "item": {"id": "m1", "type": "agentMessage", "text": "all done"}}})
        send({"jsonrpc": "2.0", "method": "turn/completed", "params": {"threadId": "th1", "turn": {"status": "completed"}}})
    elif mid is not None and method is not None:
        send({"jsonrpc": "2.0", "id": mid, "result": {}})
