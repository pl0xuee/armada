"""Minimal ACP agent for tests: streams a reply, asks for one permission, edits nothing."""

import json
import os
import sys

pending = {}
next_id = 1000
mcp_count = 0


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


# An agent that takes a system prompt (claude-agent-acp does) unless MOCK_NO_SYSTEM_PROMPT is set.
SESSION_CAPS = {"resume": {}}
if not os.environ.get("MOCK_NO_SYSTEM_PROMPT"):
    SESSION_CAPS["systemPrompt"] = {"mode": {"override": {}}}

while True:
    msg = read()
    method = msg.get("method")
    mid = msg.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": 1,
            "agentCapabilities": {"loadSession": True, "sessionCapabilities": SESSION_CAPS},
            "authMethods": []}})
    elif method in ("session/new", "session/resume", "session/load"):
        mcp_count = len(msg["params"].get("mcpServers", []))
        sid = msg["params"].get("sessionId", "mock-session-1")
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "sessionId": sid,
            "modes": {"currentModeId": "ask", "availableModes": [
                {"id": "ask", "name": "Ask"}, {"id": "auto", "name": "Auto"}]}}})
    elif method == "session/set_mode":
        send({"jsonrpc": "2.0", "id": mid, "result": {}})
    elif method == "session/prompt":
        sid = msg["params"]["sessionId"]
        text = msg["params"]["prompt"][0]["text"]
        update(sid, {"sessionUpdate": "available_commands_update", "availableCommands": [
            {"name": "compact", "description": "Compact the conversation", "input": None},
            {"name": "review", "description": "Review code", "input": {"hint": "path"}}]})
        if text.startswith("TRIGGER_LIMIT"):
            send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32000,
                  "message": "You've hit your usage limit for this account"}})
            continue
        if "SUBAGENT" in text:
            # A Claude Code style sub-agent: a Task call, tool calls made under it, and
            # the sub-agent's own text (which must stay out of the main stream).
            task_meta = {"claudeCode": {"toolName": "Task"}}
            sub_meta = {"claudeCode": {"parentToolUseId": "task1"}}
            update(sid, {"sessionUpdate": "tool_call", "toolCallId": "task1", "title": "Task", "kind": "think",
                         "status": "in_progress", "_meta": task_meta,
                         "rawInput": {"description": "Explore the repo", "subagent_type": "Explore", "prompt": "look around"}})
            update(sid, {"sessionUpdate": "tool_call", "toolCallId": "sub1", "title": "Read a.txt", "kind": "read",
                         "status": "completed", "_meta": sub_meta})
            update(sid, {"sessionUpdate": "tool_call", "toolCallId": "sub2", "title": "Run ls", "kind": "execute",
                         "status": "completed", "rawInput": {"command": "ls"}, "_meta": sub_meta})
            update(sid, {"sessionUpdate": "agent_thought_chunk", "_meta": sub_meta, "content": {"type": "text", "text": "sub thinking"}})
            update(sid, {"sessionUpdate": "agent_message_chunk", "_meta": sub_meta, "content": {"type": "text", "text": "sub-agent chatter"}})
            for part in ["found", " it"]:
                update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": "task1",
                             "content": [{"type": "content", "content": {"type": "text", "text": "found" if part == "found" else "found it"}}]})
            update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": "task1", "status": "completed"})
            update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Done with the sub-agent"}})
            send({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "end_turn"}})
            continue
        update(sid, {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "thinking"}})
        update(sid, {"sessionUpdate": "plan", "entries": [
            {"content": "Look around", "status": "completed", "priority": "high"},
            {"content": "Answer", "status": "in_progress", "priority": "medium"}]})
        update(sid, {"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Run ls",
                     "kind": "execute", "status": "pending", "rawInput": {"command": "ls -la"}})
        next_id += 1
        perm_id = next_id
        send({"jsonrpc": "2.0", "id": perm_id, "method": "session/request_permission", "params": {
            "sessionId": sid,
            "toolCall": {"toolCallId": "t1", "title": "Run ls", "kind": "execute"},
            "options": [
                {"optionId": "yes", "name": "Allow", "kind": "allow_once"},
                {"optionId": "no", "name": "Deny", "kind": "reject_once"}]}})
        # Wait for the permission answer (ignore anything else meanwhile).
        while True:
            reply = read()
            if reply.get("id") == perm_id and "method" not in reply:
                break
        chosen = reply["result"]["outcome"].get("optionId", "cancelled")
        update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": "t1",
                     "status": "completed" if chosen == "yes" else "failed",
                     "content": [{"type": "content", "content": {"type": "text", "text": "file.txt"}}]})
        if "MCP?" in text:
            text = "mcp=%d" % mcp_count
        for chunk in ["You said: ", text]:
            update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": chunk}})
        update(sid, {"sessionUpdate": "usage_update", "used": 1200, "size": 200000,
                     "cost": {"amount": 0.0123, "currency": "USD"}})
        update(sid, {"sessionUpdate": "session_info_update", "title": "Mock title"})
        send({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "end_turn", "usage": {"totalTokens": 42}}})
    elif mid is not None and method is not None:
        send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "unsupported"}})
