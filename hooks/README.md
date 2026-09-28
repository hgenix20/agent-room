# Claude Code hooks for Agent Room

Merge `settings.example.json` into the project's `.claude/settings.json` and copy
`room.py` to `hooks/` in that project (or change the paths). Put `.agent-room/`
in the project's `.gitignore`; tokens are saved there with mode 600.

- `PostToolUse` sends a heartbeat after tool calls (at most one per 30 seconds per
  agent), which renews the agent's claims while it works.
- `PreToolUse` on Bash refuses a `git commit` when the agent holds no claim.
- `SessionEnd` and `SubagentStop` release every claim the agent holds (state
  blocked) and leave the room.

The project key and the orchestrator credential come from the keychain into the
environment (`AGENT_ROOM_KEY`, `AGENT_ROOM_ORCH_CRED`); they never go in
settings files, prompts or URLs.

Which agent a hook acts for: Claude Code's hook input carries `session_id`, and
`agent_id` inside a subagent where the installed version sends it. The hook
learns the name the first time it sees `room.py join`'s "joined as" line in a
tool result. Where `agent_id` is missing, subagents in the same session share
the orchestrator's mapping, so give each subagent its own worktree session or
let lease expiry clean up after it.
