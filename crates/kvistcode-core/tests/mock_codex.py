"""Codex app-server stand-in: the first launch fails its handshake, later launches crash mid-turn."""
import json, sys, os
STATE = sys.argv[1]
n = int(open(STATE).read()) if os.path.exists(STATE) else 0
open(STATE, "w").write(str(n + 1))
def send(m):
    sys.stdout.write(json.dumps(m) + "\n"); sys.stdout.flush()
while True:
    line = sys.stdin.readline()
    if not line: sys.exit(0)
    msg = json.loads(line); method = msg.get("method"); mid = msg.get("id")
    if method == "initialize":
        if n == 0:
            send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32000, "message": "first launch fails"}})
        else:
            send({"jsonrpc": "2.0", "id": mid, "result": {}})
    elif method == "thread/start" or method == "thread/resume":
        send({"jsonrpc": "2.0", "id": mid, "result": {"thread": {"id": "th1"}, "model": "m"}})
    elif method == "model/list":
        send({"jsonrpc": "2.0", "id": mid, "result": {"data": []}})
    elif method == "turn/start":
        send({"jsonrpc": "2.0", "id": mid, "result": {"turn": {"id": "turn1"}}})
        send({"jsonrpc": "2.0", "method": "turn/started", "params": {"turn": {"id": "turn1"}}})
        send({"jsonrpc": "2.0", "method": "item/agentMessage/delta", "params": {"itemId": "i1", "delta": "working..."}})
        sys.stderr.write("simulated crash\n"); sys.stderr.flush()
        os._exit(1)
    elif mid is not None and method is not None:
        send({"jsonrpc": "2.0", "id": mid, "result": {}})
