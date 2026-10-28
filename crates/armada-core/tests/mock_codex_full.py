"""Codex app-server stand-in for one full turn: a sub-agent whose item arrives before
its collaborator call, then every kind of server request Armada must answer. The
final message reports the thread's approval policy and every answer it got."""
import json, sys

def send(m):
    sys.stdout.write(json.dumps(m) + "\n"); sys.stdout.flush()

def read():
    line = sys.stdin.readline()
    if not line:
        sys.exit(0)
    return json.loads(line)

def ask(rid, method, params):
    send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
    while True:
        r = read()
        if r.get("id") == rid and "method" not in r:
            return r.get("result", r.get("error"))

def note(method, params):
    send({"jsonrpc": "2.0", "method": method, "params": params})

policy = None
while True:
    msg = read(); method = msg.get("method"); mid = msg.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {}})
    elif method == "thread/start":
        policy = msg["params"].get("approvalPolicy")
        send({"jsonrpc": "2.0", "id": mid, "result": {"thread": {"id": "th1"}, "model": "m", "approvalPolicy": policy}})
    elif method == "model/list":
        send({"jsonrpc": "2.0", "id": mid, "result": {"data": []}})
    elif method == "turn/start":
        send({"jsonrpc": "2.0", "id": mid, "result": {"turn": {"id": "t1"}}})
        note("turn/started", {"threadId": "th1", "turn": {"id": "t1"}})
        # The sub-agent's item shows up before the call that started it.
        note("item/completed", {"threadId": "sub1", "item": {"id": "c-orphan", "type": "commandExecution",
             "command": "ls", "status": "completed", "aggregatedOutput": "a.txt"}})
        note("item/completed", {"threadId": "th1", "item": {"id": "collab1", "type": "collabAgentToolCall",
             "tool": "spawnAgent", "status": "completed", "prompt": "explore", "receiverThreadIds": ["sub1"]}})
        answers = {}
        answers["perm"] = ask(500, "item/permissions/requestApproval", {"itemId": "p1", "threadId": "th1", "turnId": "t1",
             "cwd": "/", "startedAtMs": 0, "reason": "needs the network", "permissions": {"network": {"enabled": True}}})
        answers["exec"] = ask(501, "execCommandApproval", {"callId": "c1", "command": ["rm", "-rf", "build"],
             "conversationId": "th1", "cwd": "/", "parsedCmd": []})
        answers["input"] = ask(502, "item/tool/requestUserInput", {"itemId": "q1", "threadId": "th1", "turnId": "t1",
             "isBlocking": True, "questions": [{"id": "q", "header": "Pick", "question": "Which database?"}]})
        answers["elicit"] = ask(503, "mcpServer/elicitation/request", {"serverName": "srv", "threadId": "th1",
             "turnId": "t1", "message": "Need a token", "mode": "form", "requestedSchema": {"type": "object", "properties": {}}})
        text = "policy=%s answers=%s" % (policy, json.dumps(answers, sort_keys=True))
        note("item/completed", {"threadId": "th1", "item": {"id": "m1", "type": "agentMessage", "text": text}})
        note("turn/completed", {"threadId": "th1", "turn": {"id": "t1", "status": "completed"}})
    elif mid is not None and method is not None:
        send({"jsonrpc": "2.0", "id": mid, "result": {}})
