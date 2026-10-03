#!/usr/bin/env python3
"""Agent Room helper and Claude Code hook.

Commands you run yourself:
  room.py join NAME [MODEL]   join the room; saves the token, prints only name, id and cursor
  room.py token NAME          print a saved token (for $(...) in a curl, never echo it)

Commands the hooks run (they read the hook's JSON on stdin):
  room.py heartbeat           PostToolUse: heartbeat, at most once per 30 seconds per agent
  room.py leave               SessionEnd / SubagentStop: release every claim and leave
  room.py precommit           PreToolUse on Bash: refuse `git commit` when the agent holds no claim

Environment:
  AGENT_ROOM_URL        https://<room host>
  AGENT_ROOM_PROJECT    project name, e.g. genix
  AGENT_ROOM_KEY        project join key (from the keychain, passed by the orchestrator's environment)
  AGENT_ROOM_ORCH_CRED  orchestrator credential (orchestrators only)
  AGENT_ROOM_PARENT     parent agent's name, for a subagent join (its saved token is used)
  AGENT_ROOM_DIR        where tokens live (default: .agent-room in the project dir), git-ignored

Which agent a hook acts for: the hook input's agent_id when Claude Code sends one
(a subagent), else its session_id. The mapping is recorded the first time the hook
sees this script's "agent-room: joined as NAME" line in a tool result.
Hooks never fail the session: every error is swallowed except precommit's refusal.
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

JOINED = re.compile(r"agent-room: joined as ([A-Za-z0-9._-]+)")


def room_dir():
    base = os.environ.get("AGENT_ROOM_DIR") or os.path.join(os.environ.get("CLAUDE_PROJECT_DIR", "."), ".agent-room")
    for sub in ("tokens", "who", "stamps"):
        os.makedirs(os.path.join(base, sub), mode=0o700, exist_ok=True)
    return base


def api(call, token=None, body=None, method=None, query=""):
    url = f"{os.environ['AGENT_ROOM_URL'].rstrip('/')}/p/{os.environ['AGENT_ROOM_PROJECT']}/{call}{query}"
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method or ("POST" if body is not None else "GET"))
    req.add_header("content-type", "application/json")
    # Cloudflare answers Python-urllib's default user agent with error 1010 (403, HTML body).
    req.add_header("user-agent", "agent-room-hooks/1")
    if token:
        req.add_header("authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}


def token_path(name):
    return os.path.join(room_dir(), "tokens", f"{name}.token")


def load_token(name):
    try:
        with open(token_path(name)) as f:
            return f.read().strip()
    except OSError:
        return None


def cmd_join(args):
    name = args[0]
    model = args[1] if len(args) > 1 else "unknown"
    body = {"name": name, "model": model, "project_key": os.environ["AGENT_ROOM_KEY"], "key": f"join-{name}-{os.getpid()}"}
    if os.environ.get("AGENT_ROOM_ORCH_CRED"):
        body["orchestrator_credential"] = os.environ["AGENT_ROOM_ORCH_CRED"]
    elif os.environ.get("AGENT_ROOM_PARENT"):
        parent = load_token(os.environ["AGENT_ROOM_PARENT"])
        if not parent:
            sys.exit(f"agent-room: no saved token for parent {os.environ['AGENT_ROOM_PARENT']}")
        body["parent_token"] = parent
    else:
        sys.exit("agent-room: set AGENT_ROOM_ORCH_CRED (orchestrator) or AGENT_ROOM_PARENT (subagent)")
    status, res = api("join", body=body)
    if status != 200:
        sys.exit(f"agent-room: join failed {status} {res.get('error')}")
    path = token_path(res["name"])
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(res["token"])
    print(f"agent-room: joined as {res['name']} (id {res['agent_id']}, cursor {res['cursor']}, parent {res.get('parent')})")
    print(f"token saved; use: -H \"Authorization: Bearer $(python3 {sys.argv[0]} token {res['name']})\"")


def cmd_token(args):
    t = load_token(args[0])
    if not t:
        sys.exit(1)
    sys.stdout.write(t)


def hook_input():
    try:
        return json.load(sys.stdin)
    except ValueError:
        return {}


def who_key(inp):
    return inp.get("agent_id") or inp.get("session_id") or "default"


def who(inp):
    """The agent name this hook call acts for, learning it from a join line when one appears."""
    d = room_dir()
    key = re.sub(r"[^A-Za-z0-9._-]", "_", who_key(inp))
    path = os.path.join(d, "who", key)
    resp = inp.get("tool_response")
    text = resp if isinstance(resp, str) else json.dumps(resp) if resp is not None else ""
    m = JOINED.search(text)
    if m:
        with open(path, "w") as f:
            f.write(m.group(1))
        return m.group(1)
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None


def cmd_heartbeat(_):
    inp = hook_input()
    name = who(inp)
    token = name and load_token(name)
    if not token:
        return
    stamp = os.path.join(room_dir(), "stamps", name)
    try:
        if time.time() - os.path.getmtime(stamp) < 30:
            return
    except OSError:
        pass
    open(stamp, "w").close()
    tool = inp.get("tool_name", "tool")
    api("heartbeat", token, {"status_line": f"working ({tool})"})


def cmd_leave(_):
    inp = hook_input()
    name = who(inp)
    token = name and load_token(name)
    if not token:
        return
    api("leave", token, {})
    try:
        os.remove(token_path(name))
    except OSError:
        pass


def cmd_precommit(_):
    inp = hook_input()
    command = (inp.get("tool_input") or {}).get("command", "")
    if not re.search(r"\bgit\b[^;&|]*\bcommit\b", command):
        return
    name = who(inp)
    token = name and load_token(name)
    if not token:
        return  # not in a room; nothing to enforce
    status, res = api("whoami", token)
    if status == 200 and not res.get("task"):
        print("agent-room: you hold no claim. Sync, claim your task, then commit.", file=sys.stderr)
        sys.exit(2)


COMMANDS = {"join": cmd_join, "token": cmd_token, "heartbeat": cmd_heartbeat, "leave": cmd_leave, "precommit": cmd_precommit}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        sys.exit(__doc__)
    hook = sys.argv[1] in ("heartbeat", "leave", "precommit")
    try:
        COMMANDS[sys.argv[1]](sys.argv[2:])
    except SystemExit:
        raise
    except Exception as e:  # a hook must never break the session
        if not hook:
            raise
        print(f"agent-room hook: {e}", file=sys.stderr)
