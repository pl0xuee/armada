"""Configurable ACP agent for lifecycle tests.
Modes: normal, die, badstderr, slowinit, hanginit, replay, noresume, flood, steer, queue.
(queue: like claude-agent-acp, a session/prompt sent while a turn waits is queued and read by that turn;
_session/steering is advertised too but would abort the response, so using it shows as "!steered".)
Prompt keywords: BOUNCE (queue mode: a prompt sent mid-turn is refused), STEERFAIL (steer mode: a steer is refused), CRASH, PERM, HANG, CANCELERR, NOOPTS, EXITLATER, COST, ECHO, ASK, LATEQ, PIC, SHOTS, WITHDRAW."""
import json, sys, os, time
MODE = sys.argv[1] if len(sys.argv) > 1 else "normal"
next_id = 1000
steered = []
queued = []  # (request id, text) of prompts that arrived while a turn was running (queue mode)
forms = False  # the client can show form elicitations (claude-agent-acp's AskUserQuestion)
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
        forms = bool(msg["params"].get("clientCapabilities", {}).get("elicitation", {}).get("form"))
        if MODE == "slowinit":
            time.sleep(3)
        if MODE == "hanginit":
            # Never answer: a hung handshake.
            while True:
                read()
        caps = {"loadSession": True}
        if MODE != "replay":
            caps["sessionCapabilities"] = {"resume": {}, "systemPrompt": {"mode": {"override": {}}}}
        if MODE == "queue":
            caps["_meta"] = {"claudeCode": {"promptQueueing": True}}
        result = {"protocolVersion": 1, "agentCapabilities": caps}
        if MODE in ("steer", "queue"):
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
        if "ASK" in text:
            # Claude's AskUserQuestion as claude-agent-acp sends it; the tool is off
            # unless the client said it can show forms.
            if not forms:
                text = text + " ask=unavailable"
            else:
                next_id += 1; qid = next_id
                send({"jsonrpc": "2.0", "id": qid, "method": "elicitation/create", "params": {
                    "mode": "form", "sessionId": sid, "message": "Please answer the following questions.",
                    "requestedSchema": {"type": "object", "properties": {
                        "question_0": {"type": "string", "title": "Database", "description": "Which database?",
                                       "oneOf": [{"const": "Postgres", "title": "Postgres", "description": "Relational"},
                                                 {"const": "SQLite", "title": "SQLite"}]},
                        "question_0_custom": {"type": "string", "title": "Other"},
                        "question_1": {"type": "array", "title": "Features", "description": "Which features?",
                                       "items": {"anyOf": [{"const": "Auth", "title": "Auth"}, {"const": "Search", "title": "Search"}]}},
                        "question_1_custom": {"type": "string", "title": "Other"}}}}})
                while True:
                    r = read()
                    if r.get("id") == qid and "method" not in r:
                        break
                res = r["result"]
                text = text + " action=" + res["action"] + " content=" + json.dumps(res.get("content"), sort_keys=True)
        if "SHOTS" in text:
            # A runaway agent: many distinct pictures, and one of them again.
            for i in range(30):
                update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "image", "mimeType": "image/png", "data": "iVBOR%03d=" % i}})
            update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "image", "mimeType": "image/png", "data": "iVBOR000="}})
            send({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "end_turn"}})
            continue
        if "WITHDRAW" in text:
            # A question the agent then gives up on (ACP $/cancel_request).
            next_id += 1; qid = next_id
            send({"jsonrpc": "2.0", "id": qid, "method": "elicitation/create", "params": {
                "mode": "form", "sessionId": sid, "message": "Pick one",
                "requestedSchema": {"type": "object", "properties": {"x": {"type": "string", "oneOf": [{"const": "a", "title": "A"}]}}}}})
            time.sleep(0.3)
            send({"jsonrpc": "2.0", "method": "$/cancel_request", "params": {"id": qid}})
            time.sleep(0.3)
            update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "moved on"}})
            send({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "end_turn"}})
            continue
        if "PIC" in text:
            # An image block in the reply, as claude-agent-acp sends the model's pictures.
            update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "before "}})
            update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "image", "mimeType": "image/png", "data": "iVBORw0KGgo="}})
            update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "image", "mimeType": "image/png", "data": "", "uri": "https://example.com/a.png"}})
            update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "after"}})
            send({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "end_turn"}})
            continue
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
            cancelled = False
            while True:
                r = read()
                if r.get("method") == "_session/steering" and "STEERFAIL" in r["params"]["prompt"][0]["text"]:
                    send({"jsonrpc": "2.0", "id": r["id"], "error": {"code": -32603, "message": "steering failed"}})
                    continue
                if r.get("method") == "_session/steering":
                    # Taken into this turn while it waits for the approval.
                    steered.append(r["params"]["prompt"][0]["text"] + (" !steered" if MODE == "queue" else ""))
                    send({"jsonrpc": "2.0", "id": r["id"], "result": {"outcome": "injected"}})
                    continue
                if MODE == "queue" and r.get("method") == "session/prompt":
                    # A prompt typed meanwhile: queued, read by this turn at its next step.
                    if "BOUNCE" in r["params"]["prompt"][0]["text"]:
                        # The agent refuses it (e.g. its queue is gone): an error reply.
                        send({"jsonrpc": "2.0", "id": r["id"], "error": {"code": -32603, "message": "bounced"}})
                        continue
                    queued.append((r["id"], r["params"]["prompt"][0]["text"]))
                    continue
                if MODE == "queue" and r.get("method") == "session/cancel":
                    cancelled = True
                    break
                if r.get("id") == pid and "method" not in r:
                    # The client cancelling the turn answers the approval with "cancelled".
                    cancelled = MODE == "queue" and r["result"]["outcome"]["outcome"] == "cancelled"
                    break
            if cancelled:
                for qid, _ in queued:
                    send({"jsonrpc": "2.0", "id": qid, "result": {"stopReason": "cancelled"}})
                queued.clear()
                send({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "cancelled"}})
                continue
        if steered:
            text = text + " +steered " + ", ".join(steered)
            steered.clear()
        folded = [(qid, t) for qid, t in queued if "AFTER" not in t]
        later = [(qid, t) for qid, t in queued if "AFTER" in t]
        queued.clear()
        if folded:
            text = text + " +queued " + ", ".join(t for _, t in folded)
        update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "reply to " + text}})
        send({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "end_turn"}})
        for qid, _ in folded:
            send({"jsonrpc": "2.0", "id": qid, "result": {"stopReason": "end_turn"}})
        for qid, t in later:
            # Not read by the first turn: the agent runs it as a turn of its own right after.
            time.sleep(0.3)
            update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "reply to " + t}})
            send({"jsonrpc": "2.0", "id": qid, "result": {"stopReason": "end_turn"}})
        if "LATEQ" in text:
            # A form that arrives after the turn ended (an MCP server asking between turns).
            time.sleep(0.5)
            next_id += 1
            send({"jsonrpc": "2.0", "id": next_id, "method": "elicitation/create", "params": {
                "mode": "form", "sessionId": sid, "message": "Late question",
                "requestedSchema": {"type": "object", "properties": {"x": {"type": "string", "title": "X"}}}}})
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
