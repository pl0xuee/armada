"""Configurable ACP agent for lifecycle tests.
Modes: normal, die, badstderr, slowinit, hanginit, replay, noresume, flood, steer.
Prompt keywords: CRASH, PERM, HANG, CANCELERR, NOOPTS, EXITLATER, COST, ECHO."""
import json, sys, os, time
MODE = sys.argv[1] if len(sys.argv) > 1 else "normal"
next_id = 1000
steered = []
def send(m):
    sys.stdout.write(json.dumps(m) + "\n"); sys.stdout.flush()
def update(sid, u):
    send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": u}})
def read():
    line = sys.stdin.readline()
    if not line:
        sys.exit(0)
    return json.loads(line)
if MODE == "die":
    sys.stderr.write("fatal: cannot start\n"); sys.stderr.flush(); sys.exit(3)
if MODE == "badstderr":
    sys.stderr.buffer.write(b"\xff\xfe bad bytes\n"); sys.stderr.flush()
while True:
    msg = read(); method = msg.get("method"); mid = msg.get("id")
    if method == "initialize":
        if MODE == "slowinit":
            time.sleep(3)
        if MODE == "hanginit":
            # Never answer: a hung handshake.
            while True:
                read()
        caps = {"loadSession": True}
        if MODE != "replay":
            caps["sessionCapabilities"] = {"resume": {}}
        result = {"protocolVersion": 1, "agentCapabilities": caps}
        if MODE == "steer":
            # claude-agent-acp's steering extension.
            result["_meta"] = {"steering": {"supported": True}}
        send({"jsonrpc": "2.0", "id": mid, "result": result})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": mid, "result": {"sessionId": "s1"}})
    elif method in ("session/resume", "session/load") and MODE == "noresume":
        send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32002, "message": "session not found"}})
    elif method == "session/resume":
        send({"jsonrpc": "2.0", "id": mid, "result": {"sessionId": msg["params"]["sessionId"]}})
    elif method == "session/load":
        sid = msg["params"]["sessionId"]
        update(sid, {"sessionUpdate": "available_commands_update", "availableCommands": [
            {"name": "replayed", "description": "Sent during replay", "input": None}]})
        for i in range(400):
            update(sid, {"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": "old user %d" % i}})
            update(sid, {"sessionUpdate": "tool_call", "toolCallId": "old%d" % i, "title": "Old tool %d" % i, "kind": "read", "status": "completed"})
            update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "old reply %d" % i}})
        send({"jsonrpc": "2.0", "id": mid, "result": {}})
    elif method == "session/prompt":
        sid = msg["params"]["sessionId"]; text = msg["params"]["prompt"][0]["text"]
        if MODE == "badstderr":
            for i in range(20000):
                sys.stderr.write("noise line %d ................................................\n" % i)
            sys.stderr.flush()
        if "CRASH" in text:
            sys.exit(1)
        if "HANG" in text:
            # Never finish, and ignore session/cancel.
            while True:
                read()
        if "CANCELERR" in text:
            # Answer the cancelled prompt with an error instead of stopReason "cancelled".
            while read().get("method") != "session/cancel":
                pass
            send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32603, "message": "Request aborted"}})
            continue
        if "NOOPTS" in text:
            next_id += 1; pid = next_id
            send({"jsonrpc": "2.0", "id": pid, "method": "session/request_permission", "params": {"sessionId": sid,
                  "toolCall": {"toolCallId": "t1", "title": "Do something", "kind": "execute"}, "options": []}})
            while True:
                r = read()
                if r.get("id") == pid and "method" not in r:
                    break
            text = text + " outcome=" + r["result"]["outcome"]["outcome"]
        if "COST" in text:
            update(sid, {"sessionUpdate": "usage_update", "used": 10, "size": 100, "cost": {"amount": 0.5, "currency": "USD"}})
        if "PERM" in text:
            next_id += 1; pid = next_id
            send({"jsonrpc": "2.0", "id": pid, "method": "session/request_permission", "params": {"sessionId": sid,
                  "toolCall": {"toolCallId": "t1", "title": "Run ls", "kind": "execute"},
                  "options": [{"optionId": "yes", "name": "Allow", "kind": "allow_once"}]}})
            if MODE == "flood":
                # Keep the client's queue busy so our exit is processed late.
                for i in range(30000):
                    update(sid, {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "."}})
            while True:
                r = read()
                if r.get("method") == "_session/steering":
                    # Taken into this turn while it waits for the approval.
                    steered.append(r["params"]["prompt"][0]["text"])
                    send({"jsonrpc": "2.0", "id": r["id"], "result": {"outcome": "injected"}})
                    continue
                if r.get("id") == pid and "method" not in r:
                    break
        if steered:
            text = text + " +steered " + ", ".join(steered)
            steered.clear()
        update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "reply to " + text}})
        send({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "end_turn"}})
        if "EXITLATER" in text:
            time.sleep(0.3)
            sys.exit(0)
    elif method == "session/cancel":
        pass
    elif method == "_session/steering" and MODE == "steer":
        # No turn running: the client sends it as a normal prompt.
        send({"jsonrpc": "2.0", "id": mid, "result": {"outcome": "promptRequired"}})
    elif mid is not None and method is not None:
        send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "unsupported"}})
