// One Durable Object per project: roster, room, board and claims in its own
// SQLite. Every check-then-write runs inside one synchronous transaction, so
// two agents can never win the same claim.

import { DurableObject } from "cloudflare:workers";
import {
  HttpError,
  LIMITS,
  json,
  NAME_RE,
  newAgentId,
  parseMentions,
  randomId,
  scopesOverlap,
  secretReason,
} from "./lib";
import type { Env } from "./index";

export interface Result {
  status: number;
  body: Record<string, unknown>;
  /** A ban rule fired inside the room; the agent is already revoked. */
  violation?: { rule: number; agent_id?: string; agent_name?: string; parent_name?: string | null; token_prefix?: string; detail: string; descendants?: string[] };
  /** The token did not authenticate; the worker counts it toward rule 2. */
  badToken?: boolean;
  /** Idempotent join replay: the worker mints a new token for this agent id. */
  rotateFor?: string;
}

export interface JoinInput {
  name: string;
  model: string;
  credLabel: string | null; // orchestrator credential label, when joining as an orchestrator
  parentId: string | null; // from the parent token, when joining as a subagent
  parentTokenHash: string | null;
  tokenHash: string; // hash of the new token the worker minted
  token: string;
  agentId: string;
  key: string | null;
  ip: string;
}

export interface CallInput {
  action: string;
  agentId: string;
  tokenHash: string;
  body: Record<string, unknown>;
  query: Record<string, string>;
  ip: string;
}

export interface HumanInput {
  project: string;
  email: string; // verified by the worker from the Access header, lowercased
  action: string;
  body: Record<string, unknown>;
  query: Record<string, string>;
  ip: string;
}

export interface RevokeInfo {
  found: boolean;
  agent_id: string;
  agent_name: string | null;
  parent_name: string | null;
  token_prefix: string | null;
  descendants: string[];
  /** Direct subagents left on the roster without a parent. */
  orphans: string[];
}

interface AgentRow {
  id: string;
  name: string;
  model: string;
  parent_id: string | null;
  token_hash: string;
  status_line: string;
  task_id: string | null;
  last_seen: number;
  tree_seen: number;
  joined_at: number;
  state: string; // active | left | revoked | banned
  roster_state: string; // active | stale | gone
  orphaned: number; // 1 while its parent's token is revoked and nobody has adopted it
  kind: string; // agent | human
  email: string | null;
  [k: string]: SqlStorageValue;
}

interface ClaimRow {
  id: string;
  task_id: string;
  owner_id: string;
  scopes: string;
  version: number;
  lease_ms: number;
  expires_at: number;
  state: string; // live | released | expired | revoked
  created_at: number;
  [k: string]: SqlStorageValue;
}

interface TaskRow {
  id: string;
  num: number;
  title: string;
  detail: string;
  state: string;
  owner_id: string | null;
  parent_task: string | null;
  depends_on: string;
  branch: string | null;
  commit_sha: string | null;
  created_by: string;
  updated_at: number;
  priority: string;
  estimate_minutes: number | null;
  estimate_tokens: number | null;
  started_at: number | null;
  ended_at: number | null;
  [k: string]: SqlStorageValue;
}

const WRITE_ACTIONS = new Set(["heartbeat", "say", "task", "task_update", "claim", "release", "leave", "adopt", "nick"]);

/** Stored in token_hash for a person. A real hash is 64 hex characters, so no token matches it. */
const HUMAN_TOKEN_HASH = "human";

const EVENT_SELECT = `SELECT e.seq, e.kind, e.agent_id, e.task_id, e.data, e.created_at, m.text, m.reply_to, m.mentions
       FROM events e LEFT JOIN messages m ON m.seq = e.seq`;

/** Event kinds that change what the roster shows. */
const ROSTER_KINDS = new Set(["join", "roster", "status", "claim", "release", "claim_expired"]);
/** Event kinds that change a task row. */
const TASK_KINDS = new Set(["task", "task_updated", "claim", "release", "claim_expired"]);

export class ProjectRoom extends DurableObject<Env> {
  private sql: SqlStorage;
  private offset = 0;
  private project = "";
  /** Tasks changed in the current call without an event of their own (a token report). */
  private dirtyTasks = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, model TEXT NOT NULL, parent_id TEXT,
        token_hash TEXT NOT NULL, status_line TEXT NOT NULL DEFAULT '', task_id TEXT,
        last_seen INTEGER NOT NULL, tree_seen INTEGER NOT NULL, joined_at INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'active', roster_state TEXT NOT NULL DEFAULT 'active',
        cred_label TEXT, ip TEXT);
      CREATE INDEX IF NOT EXISTS agents_token ON agents(token_hash);
      CREATE INDEX IF NOT EXISTS agents_name ON agents(name);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref_id TEXT, agent_id TEXT,
        task_id TEXT, data TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS events_task ON events(task_id, seq);
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, task_id TEXT, text TEXT NOT NULL,
        reply_to INTEGER, mentions TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, num INTEGER NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'open', owner_id TEXT, parent_task TEXT, depends_on TEXT NOT NULL DEFAULT '[]',
        branch TEXT, commit_sha TEXT, created_by TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, owner_id TEXT NOT NULL, scopes TEXT NOT NULL,
        version INTEGER NOT NULL, lease_ms INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'live', created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS claims_live ON claims(state, expires_at);
      CREATE TABLE IF NOT EXISTS idem (
        scope TEXT NOT NULL, key TEXT NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY (scope, key));
      CREATE TABLE IF NOT EXISTS rate (
        agent_id TEXT NOT NULL, win INTEGER NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL,
        PRIMARY KEY (agent_id, win, kind));
      CREATE TABLE IF NOT EXISTS escalation (
        agent_id TEXT PRIMARY KEY, step INTEGER NOT NULL DEFAULT 0, read_only_until INTEGER NOT NULL DEFAULT 0,
        warned_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS repeat_state (
        agent_id TEXT PRIMARY KEY, step INTEGER NOT NULL DEFAULT 0, since_seq INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS strikes (agent_id TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS claim_lock (agent_id TEXT PRIMARY KEY, until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_tokens (
        task_id TEXT NOT NULL, agent_id TEXT NOT NULL, tokens INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, agent_id));
    `);
    this.migrate();
    // A sleeping room answers "ping" with "pong" without waking.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    const off = this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'clock_offset'").toArray()[0];
    if (off) this.offset = Number(off.v);
  }

  private addColumn(table: string, column: string, ddl: string): void {
    if (!this.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().some((c) => c.name === column)) {
      this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  }

  /** Brings a room made by an older version up to this one. Safe to run again. */
  private migrate(): void {
    this.addColumn("agents", "orphaned", "orphaned INTEGER NOT NULL DEFAULT 0");
    this.addColumn("agents", "kind", "kind TEXT NOT NULL DEFAULT 'agent'");
    this.addColumn("agents", "email", "email TEXT");
    this.addColumn("tasks", "priority", "priority TEXT NOT NULL DEFAULT 'normal'");
    this.addColumn("tasks", "estimate_minutes", "estimate_minutes INTEGER");
    this.addColumn("tasks", "estimate_tokens", "estimate_tokens INTEGER");
    this.addColumn("tasks", "started_at", "started_at INTEGER");
    this.addColumn("tasks", "ended_at", "ended_at INTEGER");
    if (!this.sql.exec("SELECT v FROM meta WHERE k = 'task_times_backfilled'").toArray().length) {
      // Tasks from before these columns: the claim and release events already hold the times.
      this.sql.exec(
        `UPDATE tasks SET started_at = (SELECT MIN(e.created_at) FROM events e WHERE e.kind = 'claim' AND e.task_id = tasks.id)
         WHERE started_at IS NULL`,
      );
      this.sql.exec(
        `UPDATE tasks SET ended_at = (SELECT MAX(e.created_at) FROM events e
           WHERE e.kind = 'release' AND e.task_id = tasks.id AND json_valid(e.data) AND json_extract(e.data, '$.state') = 'done')
         WHERE state = 'done' AND ended_at IS NULL`,
      );
      this.sql.exec("INSERT INTO meta (k, v) VALUES ('task_times_backfilled', '1') ON CONFLICT(k) DO NOTHING");
    }
  }

  /** Sockets that can still take a message. getWebSockets() may list one that is closing. */
  private openSockets(tag?: string): WebSocket[] {
    return this.ctx.getWebSockets(tag).filter((ws) => ws.readyState === 1);
  }

  /** Runs `fn` in one transaction, then tells the open sockets what it committed. */
  private commit<T>(fn: () => T): T {
    const before = this.head();
    this.dirtyTasks.clear();
    const out = this.ctx.storage.transactionSync(fn);
    this.broadcast(before);
    return out;
  }

  /**
   * New events in seq order, then each changed task, then the roster when it changed. Runs after
   * the transaction has committed, so a failure here is logged and never reaches the caller.
   */
  private broadcast(before: number): void {
    try {
      const dirty = new Set(this.dirtyTasks);
      this.dirtyTasks.clear();
      const socks = this.openSockets();
      if (!socks.length) return;
      const now = this.now();
      const out: string[] = [];
      let roster = false;
      for (const r of this.rows<Record<string, SqlStorageValue>>(`${EVENT_SELECT} WHERE e.seq > ? ORDER BY e.seq`, before)) {
        out.push(JSON.stringify({ type: "event", event: this.viewEvent(r) }));
        if (ROSTER_KINDS.has(r.kind as string)) roster = true;
        if (r.task_id && TASK_KINDS.has(r.kind as string)) dirty.add(r.task_id as string);
      }
      for (const id of dirty) {
        const t = this.first<TaskRow>("SELECT * FROM tasks WHERE id = ?", id);
        if (t) out.push(JSON.stringify({ type: "task", task: this.taskView(t, now) }));
      }
      if (roster) out.push(JSON.stringify({ type: "roster", roster: this.rosterView(now) }));
      if (!out.length) return;
      for (const ws of socks) {
        try {
          for (const m of out) ws.send(m);
        } catch {
          // A socket that cannot take a message is closed; the call that caused it is unaffected.
          try {
            ws.close(1011, "send failed");
          } catch {
            /* already closed */
          }
        }
      }
    } catch (e) {
      console.error("broadcast failed", e);
    }
  }

  /** The socket upgrade. Only the worker can reach this, and it sets x-room-human after the Access check. */
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "upgrade_required" }, 426);
    const email = req.headers.get("x-room-human") ?? "";
    const project = req.headers.get("x-room-project") ?? "";
    if (!email || !project) return json({ error: "access_required" }, 403);
    this.project = project;
    const open = this.openSockets();
    if (open.length >= LIMITS.maxSockets) {
      // At the cap, a person's newest tab replaces their oldest; only other people's sockets refuse it.
      const known = this.first<{ id: string }>("SELECT id FROM agents WHERE kind = 'human' AND email = ?", email);
      const theirs = known ? this.openSockets(known.id) : [];
      if (!theirs.length) return json({ error: "too_many_sockets" }, 429);
      const openedAt = (ws: WebSocket) => (ws.deserializeAttachment() as { at?: number } | null)?.at ?? 0;
      const oldest = theirs.reduce((a, b) => (openedAt(b) < openedAt(a) ? b : a));
      oldest.close(1000, "replaced by a newer tab");
    }
    const me = this.commit((): AgentRow => {
      const now = this.now();
      this.sweep(now);
      const row = this.ensureHuman(email, req.headers.get("x-room-ip") ?? "unknown", now);
      this.touch(row, now);
      return row;
    });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [me.id]);
    pair[1].serializeAttachment({ at: Date.now() });
    pair[1].send(JSON.stringify({ type: "hello", cursor: this.head() }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** The socket only carries messages from the room; whatever a client sends is ignored. */
  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {}

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, "socket error");
    } catch {
      /* already closed */
    }
  }

  // ------------------------------------------------------------------ basics

  private now(): number {
    return Date.now() + this.offset;
  }

  /** Test hook, refused unless the ALLOW_TEST_CLOCK binding is set. */
  async _testAdvance(ms: number): Promise<void> {
    if (this.env.ALLOW_TEST_CLOCK !== "1") throw new Error("test clock disabled");
    this.offset += ms;
    this.sql.exec("INSERT INTO meta (k, v) VALUES ('clock_offset', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", String(this.offset));
  }

  private rows<T extends Record<string, SqlStorageValue>>(q: string, ...args: SqlStorageValue[]): T[] {
    return this.sql.exec<T>(q, ...args).toArray();
  }

  private first<T extends Record<string, SqlStorageValue>>(q: string, ...args: SqlStorageValue[]): T | undefined {
    return this.sql.exec<T>(q, ...args).toArray()[0];
  }

  private counter(name: string): number {
    const row = this.first<{ v: string }>("SELECT v FROM meta WHERE k = ?", name);
    const next = (row ? Number(row.v) : 0) + 1;
    this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", name, String(next));
    return next;
  }

  private head(): number {
    return this.first<{ s: number | null }>("SELECT MAX(seq) AS s FROM events")?.s ?? 0;
  }

  private event(kind: string, refId: string | null, agentId: string | null, taskId: string | null, data: Record<string, unknown>): number {
    return this.sql
      .exec<{ seq: number }>(
        "INSERT INTO events (kind, ref_id, agent_id, task_id, data, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING seq",
        kind, refId, agentId, taskId, JSON.stringify(data), this.now(),
      )
      .one().seq;
  }

  private agent(id: string | null | undefined): AgentRow | undefined {
    if (!id) return undefined;
    return this.first<AgentRow>("SELECT * FROM agents WHERE id = ?", id);
  }

  private nameOf(id: string | null | undefined): string | null {
    return this.agent(id)?.name ?? null;
  }

  private liveClaimsOf(agentId: string): ClaimRow[] {
    return this.rows<ClaimRow>("SELECT * FROM claims WHERE owner_id = ? AND state = 'live' ORDER BY created_at", agentId);
  }

  /** An agent is alive while it or a descendant was seen in the last 30 minutes, or it holds a live claim. */
  private alive(a: AgentRow, now: number): boolean {
    if (a.state !== "active") return false;
    if (a.kind === "human") return true; // a person's credential is the Access session, checked by the worker
    if (a.tree_seen > now - LIMITS.goneMs) return true;
    return this.liveClaimsOf(a.id).length > 0;
  }

  /** A token is valid while its agent and every ancestor is alive and none is revoked, banned or left. */
  private chainProblem(a: AgentRow, now: number): string | null {
    let cur: AgentRow | undefined = a;
    let depth = 0;
    while (cur && depth < 50) {
      if (cur.state === "banned") return cur.id === a.id ? "banned" : "parent_banned";
      if (cur.state !== "active") return cur.id === a.id ? cur.state : "parent_" + cur.state;
      if (!this.alive(cur, now)) return cur.id === a.id ? "expired" : "parent_gone";
      if (cur.orphaned) break;
      cur = cur.parent_id ? this.agent(cur.parent_id) : undefined;
      depth++;
    }
    return null;
  }

  private touch(a: AgentRow, now: number): void {
    this.sql.exec("UPDATE agents SET last_seen = ? WHERE id = ?", now, a.id);
    let cur: AgentRow | undefined = a;
    let depth = 0;
    while (cur && depth < 50) {
      this.sql.exec("UPDATE agents SET tree_seen = ? WHERE id = ?", now, cur.id);
      if (cur.orphaned) break;
      cur = cur.parent_id ? this.agent(cur.parent_id) : undefined;
      depth++;
    }
    if (a.roster_state !== "active") {
      this.sql.exec("UPDATE agents SET roster_state = 'active' WHERE id = ?", a.id);
      this.event("roster", a.id, a.id, a.task_id, { name: a.name, state: "active" });
    }
  }

  /** Lazy housekeeping on every call: expire claims, age the roster, drop old idempotency rows. */
  private sweep(now: number): void {
    for (const c of this.rows<ClaimRow>("SELECT * FROM claims WHERE state = 'live' AND expires_at <= ?", now)) {
      this.sql.exec("UPDATE claims SET state = 'expired' WHERE id = ?", c.id);
      this.sql.exec(
        "UPDATE tasks SET state = 'open', owner_id = NULL, updated_at = ? WHERE id = ? AND state = 'claimed' AND owner_id = ?",
        now, c.task_id, c.owner_id,
      );
      this.sql.exec("UPDATE agents SET task_id = NULL WHERE id = ? AND task_id = ?", c.owner_id, c.task_id);
      this.event("claim_expired", c.id, c.owner_id, c.task_id, { task: c.task_id, owner: this.nameOf(c.owner_id), claim_id: c.id, version: c.version });
    }
    for (const a of this.rows<AgentRow>("SELECT * FROM agents WHERE state = 'active'")) {
      const quiet = now - a.last_seen;
      // A person is present while a socket of theirs is open, away after 10 quiet minutes, never gone.
      const here = a.kind === "human" && this.openSockets(a.id).length > 0;
      const next =
        a.kind === "human"
          ? here || quiet < LIMITS.staleMs ? "active" : "stale"
          : quiet >= LIMITS.goneMs ? "gone" : quiet >= LIMITS.staleMs ? "stale" : "active";
      if (next !== a.roster_state && next !== "active") {
        this.sql.exec("UPDATE agents SET roster_state = ? WHERE id = ?", next, a.id);
        this.event("roster", a.id, a.id, a.task_id, { name: a.name, state: next });
      }
    }
    this.sql.exec("DELETE FROM idem WHERE created_at < ?", now - LIMITS.idemKeepMs);
    this.sql.exec("DELETE FROM rate WHERE win < ?", Math.floor((now - 2 * 3600_000) / 60_000));
    this.sql.exec("DELETE FROM strikes WHERE at < ?", now - 3600_000);
  }

  private idemGet(scope: string, key: string | null): Result | null {
    if (!key) return null;
    const row = this.first<{ status: number; body: string }>("SELECT status, body FROM idem WHERE scope = ? AND key = ?", scope, key);
    if (!row) return null;
    return { status: row.status, body: { ...JSON.parse(row.body), replayed: true } };
  }

  private idemPut(scope: string, key: string | null, r: Result): void {
    if (!key || r.status >= 300) return;
    this.sql.exec(
      "INSERT OR REPLACE INTO idem (scope, key, status, body, created_at) VALUES (?, ?, ?, ?, ?)",
      scope, key, r.status, JSON.stringify(r.body), this.now(),
    );
  }

  // ------------------------------------------------------------------ join

  async join(input: JoinInput & { project: string }): Promise<Result> {
    this.project = input.project;
    return this.commit((): Result => {
      const now = this.now();
      this.sweep(now);
      let parent: AgentRow | undefined;
      if (input.parentId) {
        parent = this.agent(input.parentId);
        let why: string | null = null;
        if (!parent) why = "no such parent";
        else if (parent.token_hash !== input.parentTokenHash) why = "token does not match the parent";
        else why = this.chainProblem(parent, now);
        if (!why && parent && input.credLabel && !this.inChainOf(parent, input.credLabel)) why = "parent is not in your chain";
        if (why) {
          // Forged ancestry: refused, and the named parent (when it exists) is told. No address is blocked.
          if (parent) {
            this.moderatorSay(
              `@${parent.name} someone tried to join as a subagent of ${parent.name} with a parent token that is not valid (${why}). The join was refused. If it was not you or one of yours, nothing needs doing.`,
              now,
            );
          }
          return {
            status: 403,
            body: { error: "forged_ancestry", rule: 6, detail: why },
            violation: { rule: 6, parent_name: parent?.name ?? null, detail: `join named a parent token that is not live or not in the joiner's chain: ${why}` },
          };
        }
      }
      const idemScope = input.parentId ? `join:parent:${input.parentId}` : `join:cred:${input.credLabel}`;
      if (input.key) {
        const prior = this.first<{ body: string }>("SELECT body FROM idem WHERE scope = ? AND key = ?", idemScope, input.key);
        if (prior) {
          // Same join retried: same agent, fresh token (the lost one stops working).
          const pb = JSON.parse(prior.body) as { agent_id: string };
          const existing = this.agent(pb.agent_id);
          if (existing && existing.state === "active") {
            // The worker mints a fresh token for this id and stores its hash with rotateToken.
            return { status: 200, body: { ...pb, cursor: this.head(), replayed: true }, rotateFor: existing.id };
          }
        }
      }
      if (!NAME_RE.test(input.name)) return { status: 400, body: { error: "bad_name", detail: "letters, digits, . _ - up to 40" } };
      if (reserved(input.name)) return { status: 400, body: { error: "bad_name", detail: "that name is reserved" } };
      const model = oneLine(String(input.model || "unknown").slice(0, 80));
      let name = input.name;
      for (let i = 2; this.nameTaken(name, now); i++) name = `${input.name}-${i}`;
      this.sql.exec(
        `INSERT INTO agents (id, name, model, parent_id, token_hash, last_seen, tree_seen, joined_at, cred_label, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.agentId, name, model, parent?.id ?? null, input.tokenHash, now, now, now, input.credLabel, input.ip,
      );
      if (parent) this.touch(parent, now);
      const seq = this.event("join", input.agentId, input.agentId, null, { name, model, parent: parent?.name ?? null });
      const body = { agent_id: input.agentId, name, parent: parent?.name ?? null, cursor: seq };
      this.idemPut(idemScope, input.key, { status: 200, body });
      return { status: 200, body: { ...body, token: input.token } };
    });
  }

  /** True when the agent or an ancestor joined with this orchestrator credential label. */
  private inChainOf(a: AgentRow, label: string): boolean {
    let cur: AgentRow | undefined = a;
    for (let d = 0; cur && d < 50; d++) {
      if ((cur as { cred_label?: unknown }).cred_label === label) return true;
      cur = cur.parent_id ? this.agent(cur.parent_id) : undefined;
    }
    return false;
  }

  /** Completes an idempotent join replay: store the hash of the rotated token. */
  async rotateToken(agentId: string, tokenHash: string): Promise<void> {
    this.sql.exec("UPDATE agents SET token_hash = ? WHERE id = ?", tokenHash, agentId);
  }

  // ------------------------------------------------------------------ calls

  async call(input: CallInput & { project: string }): Promise<Result> {
    this.project = input.project;
    return this.commit((): Result => {
      const now = this.now();
      this.sweep(now);
      const me = this.agent(input.agentId);
      if (!me || me.kind === "human" || me.token_hash !== input.tokenHash) return { status: 401, body: { error: "bad_token" }, badToken: true };
      const problem = this.chainProblem(me, now);
      if (problem) return { status: 401, body: { error: "token_not_valid", detail: problem }, badToken: true };
      return this.runAction(me, input.action, input.body, input.query, now);
    });
  }

  /** A call from a signed-in person. The worker has already verified the email. */
  async humanCall(input: HumanInput): Promise<Result> {
    this.project = input.project;
    return this.commit((): Result => {
      const now = this.now();
      this.sweep(now);
      const me = this.ensureHuman(input.email, input.ip, now);
      return this.runAction(me, input.action, input.body, input.query, now);
    });
  }

  /** Idempotency, the read-only and rate checks, the action itself, and the bookkeeping after it. */
  private runAction(me: AgentRow, action: string, body: Record<string, unknown>, query: Record<string, string>, now: number): Result {
    const write = WRITE_ACTIONS.has(action);
    const key = write && typeof body.key === "string" ? body.key.slice(0, 128) : null;
    const scope = `${me.id}:${action}`;
    const replay = this.idemGet(scope, key);
    if (replay) {
      this.touch(me, now);
      return replay;
    }

    if (write) {
      const ro = this.first<{ read_only_until: number }>("SELECT read_only_until FROM escalation WHERE agent_id = ?", me.id);
      if (ro && ro.read_only_until > now) {
        return {
          status: 403,
          body: { error: "read_only", detail: "read-only: writes refused, reads and sync still work", read_only_until: ro.read_only_until, retry_after_s: Math.ceil((ro.read_only_until - now) / 1000) },
        };
      }
      const limited = this.rateCheck(me, action === "heartbeat" ? "h" : "w", now);
      if (limited) return limited;
    }

    let r: Result;
    try {
      r = this.dispatch(action, me, body, query, now);
    } catch (e) {
      if (e instanceof SecretRefused) {
        r = this.secretStrike(me, e.reason, now);
        if (r.violation) return r;
      } else if (e instanceof HttpError) {
        r = { status: e.status, body: e.body };
      } else throw e;
    }
    // After a leave the caller is away on purpose; touching would mark them present again.
    if (action !== "leave" && this.agent(me.id)?.state === "active") this.touch(me, now);
    this.idemPut(scope, key, r);
    return r;
  }

  /** True when a live row other than `exceptId` has this name, compared without regard to case. */
  private nameTaken(name: string, now: number, exceptId: string | null = null): boolean {
    return this.rows<AgentRow>("SELECT * FROM agents WHERE name = ? COLLATE NOCASE AND state = 'active'", name)
      .some((a) => a.id !== exceptId && this.alive(a, now));
  }

  /** The person's row for this email, made on their first call. One row per email per room. */
  private ensureHuman(email: string, ip: string, now: number): AgentRow {
    const found = this.first<AgentRow>("SELECT * FROM agents WHERE kind = 'human' AND email = ?", email);
    if (found) {
      if (found.state === "active") return found;
      this.sql.exec("UPDATE agents SET state = 'active', roster_state = 'stale' WHERE id = ?", found.id);
      return this.agent(found.id)!;
    }
    const local = email.split("@")[0].replace(/[^A-Za-z0-9._-]/g, "").replace(/^[^A-Za-z0-9]+/, "");
    const base = local.slice(0, LIMITS.nameChars - 4) || "human";
    let name = base;
    for (let i = 2; reserved(name) || this.nameTaken(name, now); i++) name = `${base}-${i}`;
    const id = newAgentId();
    this.sql.exec(
      `INSERT INTO agents (id, name, model, parent_id, token_hash, last_seen, tree_seen, joined_at, cred_label, ip, kind, email)
       VALUES (?, ?, 'human', NULL, ?, ?, ?, ?, NULL, ?, 'human', ?)`,
      id, name, HUMAN_TOKEN_HASH, now, now, now, ip, email,
    );
    this.event("join", id, id, null, { name, model: "human", parent: null });
    return this.agent(id)!;
  }

  private nick(me: AgentRow, body: Record<string, unknown>, now: number): Result {
    const name = str(body.name, "name", LIMITS.nameChars, true);
    if (!NAME_RE.test(name)) throw new HttpError(400, { error: "bad_name", detail: "letters, digits, . _ - up to 40" });
    if (name === me.name) return { status: 200, body: { name } };
    if (reserved(name) || this.nameTaken(name, now, me.id)) throw new HttpError(409, { error: "name_taken", name });
    this.sql.exec("UPDATE agents SET name = ? WHERE id = ?", name, me.id);
    this.event("roster", me.id, me.id, null, { name, state: "renamed", was: me.name });
    // The grid shows each task's owner by name, so every task this person owns goes out again.
    for (const t of this.rows<{ id: string }>("SELECT id FROM tasks WHERE owner_id = ?", me.id)) this.dirtyTasks.add(t.id);
    return { status: 200, body: { name } };
  }

  private rateCheck(me: AgentRow, kind: "h" | "w", now: number): Result | null {
    const win = Math.floor(now / 60_000);
    const limit = kind === "h" ? LIMITS.heartbeatsPerMinute : LIMITS.writesPerMinute;
    this.sql.exec(
      "INSERT INTO rate (agent_id, win, kind, n) VALUES (?, ?, ?, 1) ON CONFLICT(agent_id, win, kind) DO UPDATE SET n = n + 1",
      me.id, win, kind,
    );
    const n = this.first<{ n: number }>("SELECT n FROM rate WHERE agent_id = ? AND win = ? AND kind = ?", me.id, win, kind)!.n;
    if (n <= limit) return null;
    if (n === limit + 1) {
      // One exceedance per minute window counts toward rule 5.
      this.sql.exec("INSERT INTO strikes (agent_id, kind, at) VALUES (?, 'rate', ?)", me.id, now);
      const v = this.escalateFlood(me, now);
      if (v) return v;
    }
    return { status: 429, body: { error: "rate_limited", limit_per_minute: limit, retry_after_s: 60 - Math.floor((now % 60_000) / 1000) } };
  }

  /**
   * Flooding (rule 5), per agent: each time the agent goes over 60 writes a minute three times in
   * an hour, it moves one step: warning, then 15 minutes read-only, then the token is revoked.
   * Only the revoke step returns a violation (and so a bans row).
   */
  private escalateFlood(me: AgentRow, now: number): Result | null {
    const n = this.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM strikes WHERE agent_id = ? AND kind = 'rate' AND at > ?",
      me.id, now - 3600_000,
    )!.n;
    if (n < LIMITS.floodStrikes) return null;
    this.sql.exec("DELETE FROM strikes WHERE agent_id = ? AND kind = 'rate'", me.id);
    const cur = this.first<{ step: number }>("SELECT step FROM escalation WHERE agent_id = ?", me.id)?.step ?? 0;
    // A person is never revoked: after the warning, each further step is another read-only spell.
    const step = me.kind === "human" ? Math.min(cur + 1, 2) : cur + 1;
    if (step === 1) {
      this.sql.exec(
        "INSERT INTO escalation (agent_id, step, warned_at) VALUES (?, 1, ?) ON CONFLICT(agent_id) DO UPDATE SET step = 1, warned_at = excluded.warned_at",
        me.id, now,
      );
      const parent = this.nameOf(me.parent_id);
      this.moderatorSay(
        `@${me.name}${parent ? ` @${parent}` : ""} warning: ${me.name} went over ${LIMITS.writesPerMinute} writes a minute ${LIMITS.floodStrikes} times in an hour. ` +
          (me.kind === "human"
            ? `The next ${LIMITS.floodStrikes} makes it read-only for 15 minutes.`
            : `The next ${LIMITS.floodStrikes} makes it read-only for 15 minutes, and after that its token is revoked.`),
        now,
      );
      return null;
    }
    if (step === 2) {
      const until = now + LIMITS.readOnlyMs;
      this.sql.exec("UPDATE escalation SET step = 2, read_only_until = ? WHERE agent_id = ?", until, me.id);
      const parent = this.nameOf(me.parent_id);
      this.moderatorSay(`@${me.name}${parent ? ` @${parent}` : ""} ${me.name} is read-only for 15 minutes for flooding. Reads and sync still work.`, now);
      return {
        status: 403,
        body: { error: "read_only", detail: "flooding: writes refused for 15 minutes", read_only_until: until, retry_after_s: LIMITS.readOnlyMs / 1000 },
      };
    }
    this.sql.exec("UPDATE escalation SET step = 3 WHERE agent_id = ?", me.id);
    const info = this.revokeTree(me.id, true, 5, now);
    return {
      status: 403,
      body: { error: "banned", rule: 5 },
      violation: {
        rule: 5,
        agent_id: me.id,
        agent_name: me.name,
        parent_name: info.parent_name,
        token_prefix: info.token_prefix ?? undefined,
        detail: `flooding, third step: warned, then read-only, then revoked${orphanNote(info)}`,
        descendants: info.descendants,
      },
    };
  }

  /** A room message from the moderator, mentioning the agent and its parent. */
  private moderatorSay(text: string, now: number): void {
    const mentions = parseMentions(text);
    const seq = this.event("say", null, "moderator", null, { by: "moderator" });
    this.sql.exec(
      "INSERT INTO messages (seq, agent_id, task_id, text, reply_to, mentions, created_at) VALUES (?, 'moderator', NULL, ?, NULL, ?, ?)",
      seq, text, mentions.length ? `,${mentions.join(",")},` : "", now,
    );
    this.sql.exec("UPDATE events SET ref_id = ? WHERE seq = ?", String(seq), seq);
  }

  private secretStrike(me: AgentRow, reason: string, now: number): Result {
    this.sql.exec("INSERT INTO strikes (agent_id, kind, at) VALUES (?, 'secret', ?)", me.id, now);
    const v = this.maybeBan(me, "secret", now, `secret filter refused: ${reason}`);
    if (v) return v;
    return { status: 422, body: { error: "secret_refused", reason, detail: "text looks like a key or token; the room never holds secrets" } };
  }

  private maybeBan(me: AgentRow, kind: string, now: number, detail: string): Result | null {
    if (me.kind === "human") return null; // the refusal stands; a person is not banned by a rule
    const n = this.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM strikes WHERE agent_id = ? AND kind = ? AND at > ?",
      me.id, kind, now - 3600_000,
    )!.n;
    if (n < LIMITS.strikesForBan) return null;
    const info = this.revokeTree(me.id, true, 5, now);
    return {
      status: 403,
      body: { error: "banned", rule: 5 },
      violation: {
        rule: 5,
        agent_id: me.id,
        agent_name: me.name,
        parent_name: info.parent_name,
        token_prefix: info.token_prefix ?? undefined,
        detail: `${n} times in an hour: ${detail}${orphanNote(info)}`,
        descendants: info.descendants,
      },
    };
  }

  private dispatch(action: string, me: AgentRow, body: Record<string, unknown>, query: Record<string, string>, now: number): Result {
    switch (action) {
      case "heartbeat":
        return this.heartbeat(me, body, now);
      case "sync":
        return this.sync(me, query, now);
      case "say":
        return this.say(me, body, now);
      case "board":
        return this.board(now);
      case "task":
        return this.createTask(me, body, now);
      case "task_update":
        return this.updateTask(me, body, now);
      case "claim":
        return this.claim(me, body, now);
      case "release":
        return this.release(me, body, now);
      case "adopt":
        return this.adopt(me, body, now);
      case "leave":
        return this.leave(me, now);
      case "whoami":
        return { status: 200, body: { agent_id: me.id, name: me.name, model: me.model, parent: this.nameOf(me.parent_id), task: this.currentTask(me.id) } };
      case "me":
        if (me.kind !== "human") throw new HttpError(404, { error: "unknown_call", call: action });
        return { status: 200, body: { name: me.name, email: me.email, kind: "human" } };
      case "nick":
        if (me.kind !== "human") throw new HttpError(404, { error: "unknown_call", call: action });
        return this.nick(me, body, now);
      default:
        throw new HttpError(404, { error: "unknown_call", call: action });
    }
  }

  // ------------------------------------------------------------------ actions

  private currentTask(agentId: string): string | null {
    return this.first<{ task_id: string }>(
      "SELECT task_id FROM claims WHERE owner_id = ? AND state = 'live' ORDER BY created_at DESC LIMIT 1",
      agentId,
    )?.task_id ?? null;
  }

  private label(a: AgentRow | undefined, task: string | null): string {
    if (!a) return "?";
    return task ? `${a.name}/${task}` : a.name;
  }

  private heartbeat(me: AgentRow, body: Record<string, unknown>, now: number): Result {
    const tokens = body.tokens_used === undefined || body.tokens_used === null ? null : intOf(body.tokens_used, "bad_tokens_used", 0, LIMITS.tokensMax);
    let tokensIgnored = false;
    const status = body.status_line === undefined ? me.status_line : oneLine(str(body.status_line, "status_line", LIMITS.statusChars));
    checkSecret(status);
    const leaseMs = body.lease === undefined ? null : leaseOf(body.lease);
    let task = me.task_id;
    if (body.task_id !== undefined && body.task_id !== null) task = str(body.task_id, "task_id", 40);
    const renewed = [];
    for (const c of this.liveClaimsOf(me.id)) {
      const until = Math.max(c.expires_at, now + (leaseMs ?? c.lease_ms));
      this.sql.exec("UPDATE claims SET expires_at = ? WHERE id = ?", until, c.id);
      renewed.push({ claim_id: c.id, version: c.version, task_id: c.task_id, expires_at: until });
    }
    if (status !== me.status_line || task !== me.task_id) {
      this.sql.exec("UPDATE agents SET status_line = ?, task_id = ? WHERE id = ?", status, task, me.id);
      this.event("status", me.id, me.id, task, { name: me.name, task, status_line: status });
    }
    if (tokens !== null) {
      const held = this.currentTask(me.id);
      if (held) this.reportTokens(held, me.id, tokens, now);
      else tokensIgnored = true;
    }
    return { status: 200, body: tokensIgnored ? { ok: true, renewed, tokens_ignored: true } : { ok: true, renewed } };
  }

  private say(me: AgentRow, body: Record<string, unknown>, now: number): Result {
    const text = str(body.text, "text", LIMITS.messageChars, true);
    checkSecret(text);
    let replyTo: number | null = null;
    if (body.reply_to !== undefined && body.reply_to !== null) {
      replyTo = Number(body.reply_to);
      if (!Number.isInteger(replyTo) || !this.first("SELECT seq FROM messages WHERE seq = ?", replyTo)) {
        throw new HttpError(400, { error: "bad_reply_to" });
      }
    }
    const task = this.currentTask(me.id);
    const mentions = parseMentions(text);
    const seq = this.event("say", null, me.id, task, { by: this.label(me, task) });
    this.sql.exec(
      "INSERT INTO messages (seq, agent_id, task_id, text, reply_to, mentions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      seq, me.id, task, text, replyTo, mentions.length ? `,${mentions.join(",")},` : "", now,
    );
    this.sql.exec("UPDATE events SET ref_id = ? WHERE seq = ?", String(seq), seq);
    this.escalateRepeat(me, seq, text, now);
    return { status: 200, body: { seq, task } };
  }

  /**
   * Repeating itself, per agent: 5 messages in 10 minutes that are at least 90% the same text.
   * First time a warning, after that 15 minutes read-only. Never revokes, never touches the address.
   */
  private escalateRepeat(me: AgentRow, seq: number, text: string, now: number): void {
    const st = this.first<{ step: number; since_seq: number }>("SELECT step, since_seq FROM repeat_state WHERE agent_id = ?", me.id);
    const rows = this.rows<{ text: string }>(
      "SELECT text FROM messages WHERE agent_id = ? AND seq > ? AND seq <= ? AND created_at > ?",
      me.id, st?.since_seq ?? 0, seq, now - LIMITS.repeatWindowMs,
    );
    let same = 0;
    for (const r of rows) if (similarity(r.text, text) >= LIMITS.repeatSimilarity) same++;
    if (same < LIMITS.repeatMessages) return;
    const step = (st?.step ?? 0) + 1;
    this.sql.exec(
      "INSERT INTO repeat_state (agent_id, step, since_seq) VALUES (?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET step = excluded.step, since_seq = excluded.since_seq",
      me.id, step, seq,
    );
    const parent = this.nameOf(me.parent_id);
    const who = `@${me.name}${parent ? ` @${parent}` : ""}`;
    if (step === 1) {
      this.moderatorSay(
        `${who} warning: ${me.name} posted ${LIMITS.repeatMessages} nearly identical messages in 10 minutes. ` +
          `Doing it again makes it read-only for 15 minutes.`,
        now,
      );
      return;
    }
    const until = now + LIMITS.readOnlyMs;
    this.sql.exec(
      "INSERT INTO escalation (agent_id, read_only_until) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET read_only_until = MAX(read_only_until, excluded.read_only_until)",
      me.id, until,
    );
    this.moderatorSay(`${who} ${me.name} is read-only for 15 minutes for repeating itself. Reads and sync still work.`, now);
  }

  private createTask(me: AgentRow, body: Record<string, unknown>, now: number): Result {
    const title = oneLine(str(body.title, "title", LIMITS.titleChars, true));
    const detail = body.detail === undefined ? "" : str(body.detail, "detail", LIMITS.messageChars);
    checkSecret(title + "\n" + detail);
    const deps = body.depends_on === undefined || body.depends_on === null ? [] : body.depends_on;
    if (!Array.isArray(deps) || deps.length > 50) throw new HttpError(400, { error: "bad_depends_on" });
    for (const d of deps) {
      if (typeof d !== "string" || !this.first("SELECT id FROM tasks WHERE id = ?", d)) throw new HttpError(400, { error: "unknown_task", task: d });
    }
    let parentTask: string | null = null;
    if (body.parent_task !== undefined && body.parent_task !== null) {
      parentTask = str(body.parent_task, "parent_task", 40);
      if (!this.first("SELECT id FROM tasks WHERE id = ?", parentTask)) throw new HttpError(400, { error: "unknown_task", task: parentTask });
    }
    const priority = body.priority === undefined ? "normal" : priorityOf(body.priority);
    const estMinutes =
      body.estimate_minutes === undefined || body.estimate_minutes === null
        ? null
        : intOf(body.estimate_minutes, "bad_estimate_minutes", 1, LIMITS.estimateMinutesMax);
    const estTokens =
      body.estimate_tokens === undefined || body.estimate_tokens === null
        ? null
        : intOf(body.estimate_tokens, "bad_estimate_tokens", 0, LIMITS.tokensMax);
    const num = this.counter("task_num");
    const id = `T${num}`;
    this.sql.exec(
      `INSERT INTO tasks (id, num, title, detail, state, parent_task, depends_on, created_by, updated_at, priority, estimate_minutes, estimate_tokens)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
      id, num, title, detail, parentTask, JSON.stringify(deps), me.id, now, priority, estMinutes, estTokens,
    );
    this.event("task", id, me.id, id, {
      task: id, title, by: me.name, depends_on: deps, parent_task: parentTask,
      priority, estimate_minutes: estMinutes, estimate_tokens: estTokens,
    });
    return { status: 200, body: { task_id: id } };
  }

  /** Change a task's title, detail, priority or estimates. An agent may change a task it created or holds. */
  private updateTask(me: AgentRow, body: Record<string, unknown>, now: number): Result {
    const taskId = str(body.task_id, "task_id", 40, true);
    const t = this.first<TaskRow>("SELECT * FROM tasks WHERE id = ?", taskId);
    if (!t) throw new HttpError(404, { error: "unknown_task", task: taskId });
    const mine = t.created_by === me.id || this.liveClaimsOf(me.id).some((c) => c.task_id === taskId);
    if (me.kind !== "human" && !mine) throw new HttpError(403, { error: "not_yours", detail: "you can update a task you created or hold a claim on" });

    const next: Record<string, string | number | null> = {};
    if (body.title !== undefined) next.title = oneLine(str(body.title, "title", LIMITS.titleChars, true));
    if (body.detail !== undefined) next.detail = body.detail === null ? "" : str(body.detail, "detail", LIMITS.messageChars);
    if (body.priority !== undefined) next.priority = priorityOf(body.priority);
    if (body.estimate_minutes !== undefined) {
      next.estimate_minutes = body.estimate_minutes === null ? null : intOf(body.estimate_minutes, "bad_estimate_minutes", 1, LIMITS.estimateMinutesMax);
    }
    if (body.estimate_tokens !== undefined) {
      next.estimate_tokens = body.estimate_tokens === null ? null : intOf(body.estimate_tokens, "bad_estimate_tokens", 0, LIMITS.tokensMax);
    }
    if (next.title !== undefined || next.detail !== undefined) checkSecret(`${next.title ?? ""}
${next.detail ?? ""}`);

    const cols = Object.keys(next).filter((k) => t[k] !== next[k]);
    if (!cols.length) throw new HttpError(400, { error: "no_change" });
    const changes: Record<string, [unknown, unknown]> = {};
    // The detail can be 5000 characters; the event says it changed without carrying the text.
    for (const k of cols) changes[k] = k === "detail" ? [null, null] : [t[k], next[k]];
    // cols holds only the five keys set above, so building the SET list from it is safe.
    this.sql.exec(
      `UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
      ...cols.map((c) => next[c]), now, taskId,
    );
    this.event("task_updated", taskId, me.id, taskId, { task: taskId, by: me.name, changes });
    return { status: 200, body: { ok: true, task_id: taskId, changed: cols } };
  }

  private claim(me: AgentRow, body: Record<string, unknown>, now: number): Result {
    const taskId = str(body.task_id, "task_id", 40, true);
    const task = this.first<TaskRow>("SELECT * FROM tasks WHERE id = ?", taskId);
    if (!task) throw new HttpError(404, { error: "unknown_task", task: taskId });
    if (task.state === "done") throw new HttpError(409, { error: "task_done", task: taskId });
    const rawScopes = body.scopes === undefined || body.scopes === null ? [] : body.scopes;
    if (!Array.isArray(rawScopes) || rawScopes.length > LIMITS.scopeCount) throw new HttpError(400, { error: "bad_scopes" });
    const scopes = rawScopes.map((s) => str(s, "scope", LIMITS.scopeChars, true));
    const leaseMs = body.lease === undefined ? LIMITS.defaultLeaseMs : leaseOf(body.lease);

    if (me.orphaned) {
      throw new HttpError(403, { error: "orphaned", detail: "your parent's token was revoked; you can say, sync, heartbeat and release, but not claim until an orchestrator adopts you" });
    }
    const lock = this.first<{ until: number }>("SELECT until FROM claim_lock WHERE agent_id = ?", me.id);
    if (lock && lock.until > now) {
      throw new HttpError(403, { error: "claim_locked", detail: "too many refused claims: claiming is paused, everything else still works", until: lock.until, retry_after_s: Math.ceil((lock.until - now) / 1000) });
    }
    const live = this.rows<ClaimRow>("SELECT * FROM claims WHERE state = 'live'");
    const mine = live.find((c) => c.task_id === taskId && c.owner_id === me.id);
    if (mine) return { status: 200, body: claimBody(mine, "already yours") };
    const holderOf = (c: ClaimRow) => {
      const h = this.agent(c.owner_id);
      return { error: "conflict", holder: h?.name ?? null, status_line: h?.status_line ?? "", task_id: c.task_id, claim_scopes: JSON.parse(c.scopes) };
    };
    const onTask = live.find((c) => c.task_id === taskId);
    if (onTask) return { status: 409, body: { ...holderOf(onTask), reason: "task already claimed" } };
    for (const c of live) {
      if (c.owner_id === me.id) continue;
      const theirs: string[] = JSON.parse(c.scopes);
      for (const s of scopes) {
        const hit = theirs.find((t) => scopesOverlap(s, t));
        if (hit) {
          this.claimFight(me, now);
          return { status: 409, body: { ...holderOf(c), reason: "scope overlap", scope: s, overlaps: hit } };
        }
      }
    }
    const version = this.counter("claim_version");
    const id = "c" + randomId(6);
    const expires = now + leaseMs;
    this.sql.exec(
      "INSERT INTO claims (id, task_id, owner_id, scopes, version, lease_ms, expires_at, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'live', ?)",
      id, taskId, me.id, JSON.stringify(scopes), version, leaseMs, expires, now,
    );
    this.sql.exec(
      "UPDATE tasks SET state = 'claimed', owner_id = ?, updated_at = ?, started_at = COALESCE(started_at, ?), ended_at = NULL WHERE id = ?",
      me.id, now, now, taskId,
    );
    this.sql.exec("UPDATE agents SET task_id = ? WHERE id = ?", taskId, me.id);
    this.event("claim", id, me.id, taskId, { by: this.label(me, taskId), task: taskId, title: task.title, scopes, claim_id: id, version, lease_s: leaseMs / 1000 });
    const deps: string[] = JSON.parse(task.depends_on);
    const openDeps = deps.filter((d) => this.first<TaskRow>("SELECT state FROM tasks WHERE id = ?", d)?.state !== "done");
    const out: Record<string, unknown> = { claim_id: id, version, task_id: taskId, scopes, expires_at: expires, lease_s: leaseMs / 1000 };
    if (openDeps.length) out.warning = `depends on tasks not done: ${openDeps.join(", ")}`;
    return { status: 200, body: out };
  }

  /**
   * Fighting over claims, per agent: 10 refused scope claims in 10 minutes pause that agent's
   * claiming for 15 minutes. Say, sync, heartbeat and release keep working; nothing else is touched.
   */
  private claimFight(me: AgentRow, now: number): void {
    this.sql.exec("INSERT INTO strikes (agent_id, kind, at) VALUES (?, 'claim', ?)", me.id, now);
    const n = this.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM strikes WHERE agent_id = ? AND kind = 'claim' AND at > ?",
      me.id, now - LIMITS.claimFightWindowMs,
    )!.n;
    if (n < LIMITS.claimFightRefusals) return;
    this.sql.exec("DELETE FROM strikes WHERE agent_id = ? AND kind = 'claim'", me.id);
    this.sql.exec(
      "INSERT INTO claim_lock (agent_id, until) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET until = excluded.until",
      me.id, now + LIMITS.readOnlyMs,
    );
    const parent = this.nameOf(me.parent_id);
    this.moderatorSay(`@${me.name}${parent ? ` @${parent}` : ""} ${me.name} had ${LIMITS.claimFightRefusals} claims refused in 10 minutes and cannot claim for 15 minutes. Say, sync, heartbeat and release still work.`, now);
  }

  /** An orchestrator (an agent with no parent) takes an orphaned subagent as its own. */
  private adopt(me: AgentRow, body: Record<string, unknown>, now: number): Result {
    if (me.parent_id) throw new HttpError(403, { error: "not_an_orchestrator", detail: "only an agent with no parent can adopt" });
    const ref = str(body.agent_id, "agent_id", 60, true);
    const t = this.first<AgentRow>("SELECT * FROM agents WHERE id = ? AND state = 'active'", ref) ??
      this.first<AgentRow>("SELECT * FROM agents WHERE name = ? AND state = 'active' AND orphaned = 1 ORDER BY joined_at DESC LIMIT 1", ref);
    if (!t) throw new HttpError(404, { error: "unknown_agent" });
    if (!t.orphaned) throw new HttpError(409, { error: "not_orphaned" });
    this.sql.exec("UPDATE agents SET parent_id = ?, orphaned = 0, tree_seen = ? WHERE id = ?", me.id, now, t.id);
    this.event("roster", t.id, me.id, null, { name: t.name, state: "adopted", parent: me.name });
    return { status: 200, body: { ok: true, adopted: t.name } };
  }

  private release(me: AgentRow, body: Record<string, unknown>, now: number): Result {
    const state = body.state === undefined ? (body.all ? "blocked" : undefined) : body.state;
    if (state !== "done" && state !== "blocked") throw new HttpError(400, { error: "bad_state", detail: "state is done or blocked" });
    const commit = body.commit === undefined || body.commit === null ? null : str(body.commit, "commit", 80);
    const branch = body.branch === undefined || body.branch === null ? null : str(body.branch, "branch", 200);
    const tokens = body.tokens_used === undefined || body.tokens_used === null ? null : intOf(body.tokens_used, "bad_tokens_used", 0, LIMITS.tokensMax);
    let targets: ClaimRow[];
    if (body.all === true) {
      targets = this.liveClaimsOf(me.id);
    } else {
      const claimId = str(body.claim_id, "claim_id", 40, true);
      const version = Number(body.version);
      const c = this.first<ClaimRow>("SELECT * FROM claims WHERE id = ?", claimId);
      if (!c) throw new HttpError(404, { error: "unknown_claim" });
      if (c.owner_id !== me.id) throw new HttpError(403, { error: "not_owner", holder: this.nameOf(c.owner_id) });
      if (!Number.isInteger(version) || version !== c.version) throw new HttpError(409, { error: "stale_version", current: c.version });
      if (c.state !== "live") throw new HttpError(409, { error: "claim_not_live", state: c.state });
      targets = [c];
    }
    if (tokens !== null && targets.length > 1) {
      throw new HttpError(400, { error: "tokens_need_one_claim", detail: "tokens_used names one task; release that claim by its id" });
    }
    const released = [];
    for (const c of targets) {
      this.sql.exec("UPDATE claims SET state = 'released' WHERE id = ?", c.id);
      this.sql.exec(
        "UPDATE tasks SET state = ?, owner_id = ?, branch = COALESCE(?, branch), commit_sha = COALESCE(?, commit_sha), updated_at = ? WHERE id = ?",
        state, me.id, branch, commit, now, c.task_id,
      );
      if (state === "done") this.sql.exec("UPDATE tasks SET ended_at = ? WHERE id = ?", now, c.task_id);
      this.sql.exec("UPDATE agents SET task_id = NULL WHERE id = ? AND task_id = ?", me.id, c.task_id);
      if (tokens !== null) this.reportTokens(c.task_id, me.id, tokens, now);
      const after = this.first<TaskRow>("SELECT * FROM tasks WHERE id = ?", c.task_id)!;
      this.event("release", c.id, me.id, c.task_id, {
        by: this.label(me, c.task_id), task: c.task_id, state, commit, branch, claim_id: c.id,
        minutes: after.ended_at !== null ? actualMinutes(after, now) : null,
        tokens: this.taskTokens(c.task_id),
      });
      released.push({ claim_id: c.id, task_id: c.task_id, state });
    }
    return { status: 200, body: { ok: true, released } };
  }

  private leave(me: AgentRow, now: number): Result {
    const r = this.release(me, { all: true, state: "blocked" }, now);
    if (me.kind === "human") {
      // A person steps away; the row stays, and their next call marks them present again.
      this.sql.exec("UPDATE agents SET roster_state = 'stale', task_id = NULL WHERE id = ?", me.id);
      this.event("roster", me.id, me.id, null, { name: me.name, state: "stale" });
      return { status: 200, body: { ok: true, released: r.body.released } };
    }
    this.sql.exec("UPDATE agents SET state = 'left', task_id = NULL WHERE id = ?", me.id);
    this.event("roster", me.id, me.id, null, { name: me.name, state: "left" });
    return { status: 200, body: { ok: true, released: r.body.released } };
  }

  /** One running total per agent per task; a later, lower number never replaces a higher one. */
  private reportTokens(taskId: string, agentId: string, tokens: number, now: number): void {
    this.sql.exec(
      `INSERT INTO task_tokens (task_id, agent_id, tokens, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(task_id, agent_id) DO UPDATE SET tokens = MAX(tokens, excluded.tokens), updated_at = excluded.updated_at`,
      taskId, agentId, tokens, now,
    );
    this.sql.exec("UPDATE tasks SET updated_at = ? WHERE id = ?", now, taskId);
    this.dirtyTasks.add(taskId);
  }

  /** The task's total across agents, or null when no agent has reported. */
  private taskTokens(taskId: string): number | null {
    return this.first<{ s: number | null }>("SELECT SUM(tokens) AS s FROM task_tokens WHERE task_id = ?", taskId)?.s ?? null;
  }

  private taskView(t: TaskRow, now: number): Record<string, unknown> {
    const c = this.first<ClaimRow>("SELECT * FROM claims WHERE task_id = ? AND state = 'live'", t.id);
    return {
      id: t.id,
      title: t.title,
      detail: t.detail || undefined,
      state: t.state,
      owner: this.nameOf(t.owner_id),
      branch: t.branch,
      commit: t.commit_sha,
      parent_task: t.parent_task,
      depends_on: JSON.parse(t.depends_on),
      claim: c ? { scopes: JSON.parse(c.scopes), expires_in_s: Math.round((c.expires_at - now) / 1000) } : undefined,
      priority: t.priority,
      estimate_minutes: t.estimate_minutes,
      estimate_tokens: t.estimate_tokens,
      started_at: t.started_at,
      ended_at: t.ended_at,
      actual_minutes: actualMinutes(t, now),
      tokens_used: this.taskTokens(t.id),
      rev: t.updated_at,
    };
  }

  private board(now: number): Result {
    const tasks = this.rows<TaskRow>("SELECT * FROM tasks ORDER BY num").map((t) => this.taskView(t, now));
    return { status: 200, body: { tasks } };
  }

  /** One event in the shape callers read: the stored data, plus the text of a message. */
  private viewEvent(r: Record<string, SqlStorageValue>): Record<string, unknown> {
    const e: Record<string, unknown> = { seq: r.seq, kind: r.kind, at: r.created_at, ...JSON.parse(r.data as string) };
    if (r.kind === "say") {
      e.text = r.text;
      if (r.reply_to !== null) e.reply_to = r.reply_to;
      const ms = ((r.mentions as string | null) ?? "").split(",").filter(Boolean);
      if (ms.length) e.mentions = ms;
    }
    return e;
  }

  private rosterView(now: number): Record<string, unknown>[] {
    return this.rows<AgentRow>("SELECT * FROM agents WHERE state = 'active' ORDER BY joined_at")
      .filter((a) => a.roster_state !== "gone" || this.liveClaimsOf(a.id).length > 0)
      .map((a) => ({
        name: a.name,
        model: a.model,
        parent: this.nameOf(a.parent_id),
        task: this.currentTask(a.id),
        status: a.status_line || undefined,
        state: a.roster_state,
        orphaned: a.orphaned ? true : undefined,
        kind: a.kind === "human" ? "human" : undefined,
        idle_min: Math.floor((now - a.last_seen) / 60_000),
      }));
  }

  private sync(me: AgentRow, query: Record<string, string>, now: number): Result {
    const since = Math.max(0, Math.floor(Number(query.since ?? 0)) || 0);
    // before=<seq> pages backwards: the newest `limit` events below that seq, oldest first.
    const before = query.before === undefined ? null : Math.max(0, Math.floor(Number(query.before)) || 0);
    const limit = Math.min(LIMITS.syncMax, Math.max(1, Math.floor(Number(query.limit ?? LIMITS.syncDefault)) || LIMITS.syncDefault));
    const mentionsOnly = query.only === "mentions";
    const task = query.task ? String(query.task).slice(0, 40) : null;
    const conds: string[] = [before === null ? "e.seq > ?" : "e.seq < ?"];
    const args: SqlStorageValue[] = [before === null ? since : before];
    const mentionCond = "(e.kind = 'say' AND (m.mentions LIKE ? OR m.reply_to IN (SELECT seq FROM messages WHERE agent_id = ?)))";
    const mentionArgs = [`%,${me.name},%`, me.id];
    if (mentionsOnly && task) {
      conds.push(`(e.task_id = ? OR ${mentionCond})`);
      args.push(task, ...mentionArgs);
    } else if (mentionsOnly) {
      conds.push(mentionCond);
      args.push(...mentionArgs);
    } else if (task) {
      conds.push("e.task_id = ?");
      args.push(task);
    }
    const rows = this.rows<Record<string, SqlStorageValue>>(
      `${EVENT_SELECT} WHERE ${conds.join(" AND ")} ORDER BY e.seq ${before === null ? "ASC" : "DESC"} LIMIT ?`,
      ...args, limit + 1,
    );
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    if (before !== null) page.reverse();
    const cursor = before === null && more ? (page[page.length - 1].seq as number) : this.head();
    const events = page.map((r) => this.viewEvent(r));
    const roster = this.rosterView(now);
    const claims = this.rows<ClaimRow>("SELECT * FROM claims WHERE state = 'live' ORDER BY created_at").map((c) => ({
      claim_id: c.id,
      task: c.task_id,
      owner: this.nameOf(c.owner_id),
      scopes: JSON.parse(c.scopes),
      version: c.version,
      expires_in_s: Math.round((c.expires_at - now) / 1000),
    }));
    return { status: 200, body: { cursor, more, events, roster, claims } };
  }

  // ------------------------------------------------------------------ moderation

  private revokeTree(agentId: string, ban: boolean, rule: number, now: number): RevokeInfo {
    const a = this.agent(agentId);
    if (!a) return { found: false, agent_id: agentId, agent_name: null, parent_name: null, token_prefix: null, descendants: [], orphans: [] };
    const orphans: string[] = [];
    for (const c of this.liveClaimsOf(a.id)) {
      this.sql.exec("UPDATE claims SET state = 'revoked' WHERE id = ?", c.id);
      this.sql.exec("UPDATE tasks SET state = 'open', owner_id = NULL, updated_at = ? WHERE id = ? AND owner_id = ?", now, c.task_id, a.id);
      this.event("claim_expired", c.id, a.id, c.task_id, { task: c.task_id, owner: a.name, claim_id: c.id, reason: ban ? `banned under rule ${rule}` : "token revoked" });
    }
    this.sql.exec("UPDATE agents SET state = ?, task_id = NULL WHERE id = ?", ban ? "banned" : "revoked", a.id);
    this.event("roster", a.id, a.id, null, { name: a.name, state: "removed", reason: ban ? `banned under rule ${rule}` : "token revoked" });
    // Subagents are not punished for their parent: they stay, marked orphaned, until adopted.
    for (const c of this.rows<AgentRow>("SELECT * FROM agents WHERE parent_id = ? AND state = 'active'", a.id)) {
      this.sql.exec("UPDATE agents SET orphaned = 1 WHERE id = ?", c.id);
      this.event("roster", c.id, c.id, null, { name: c.name, state: "orphaned", reason: `parent ${a.name} revoked` });
      orphans.push(c.name);
    }
    return {
      found: true,
      agent_id: a.id,
      agent_name: a.name,
      parent_name: this.nameOf(a.parent_id),
      token_prefix: a.token_hash.slice(0, 8),
      descendants: [],
      orphans,
    };
  }

  /** Revoke (or ban) an agent and every subagent under it. With tokenHash, only when it matches. */
  async revoke(agentId: string, opts: { ban: boolean; rule: number; tokenHash?: string }): Promise<RevokeInfo> {
    return this.commit(() => {
      const a = this.agent(agentId);
      // A person's access is the HUMANS list, so a token revoke has nothing to revoke.
      if (!a || a.kind === "human" || (opts.tokenHash && a.token_hash !== opts.tokenHash)) {
        return { found: false, agent_id: agentId, agent_name: null, parent_name: null, token_prefix: null, descendants: [], orphans: [] };
      }
      return this.revokeTree(agentId, opts.ban, opts.rule, this.now());
    });
  }

  async findAgent(nameOrId: string): Promise<string | null> {
    const a =
      this.first<AgentRow>("SELECT * FROM agents WHERE id = ?", nameOrId) ??
      this.first<AgentRow>("SELECT * FROM agents WHERE name = ? ORDER BY joined_at DESC LIMIT 1", nameOrId);
    return a?.id ?? null;
  }

  /** After an unban the agent is revoked rather than banned, so its name and subagents are no longer tainted. */
  async unbanAgent(agentId: string): Promise<void> {
    this.sql.exec("UPDATE agents SET state = 'revoked' WHERE id = ? AND state = 'banned'", agentId);
  }
}

// ------------------------------------------------------------------ helpers

function orphanNote(info: RevokeInfo): string {
  return info.orphans.length ? `; subagents left orphaned, not banned: ${info.orphans.join(", ")}` : "";
}

class SecretRefused extends Error {
  constructor(public reason: string) {
    super("secret");
  }
}

/** Dice coefficient over character bigrams of the whitespace-normalised, lowercased text. */
function similarity(a: string, b: string): number {
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
  const x = norm(a);
  const y = norm(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) {
    const g = x.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let common = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const g = y.slice(i, i + 2);
    const n = grams.get(g);
    if (n) {
      common++;
      grams.set(g, n - 1);
    }
  }
  return (2 * common) / (x.length + y.length - 2);
}

function checkSecret(text: string): void {
  const r = secretReason(text);
  if (r) throw new SecretRefused(r);
}

/** A single-line field stored as one line: each control character becomes a space. Never refuses. */
function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
}

/** The room's own speaker; nobody may take the name, in any letter case. */
function reserved(name: string): boolean {
  return name.toLowerCase() === "moderator";
}

function str(v: unknown, field: string, max: number, required = false): string {
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, { error: "missing", field });
    return "";
  }
  if (typeof v !== "string") throw new HttpError(400, { error: "not_a_string", field });
  if (v.length > max) throw new HttpError(400, { error: "too_long", field, max });
  return v;
}

const PRIORITIES = new Set(["urgent", "high", "normal", "low"]);

function priorityOf(v: unknown): string {
  if (typeof v !== "string" || !PRIORITIES.has(v)) throw new HttpError(400, { error: "bad_priority", detail: "urgent, high, normal or low" });
  return v;
}

function intOf(v: unknown, error: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new HttpError(400, { error, detail: `whole number ${min} to ${max}` });
  }
  return v;
}

/** Wall-clock minutes from first claim to done, or so far while claimed; null otherwise. */
function actualMinutes(t: TaskRow, now: number): number | null {
  if (t.started_at === null) return null;
  const end = t.ended_at ?? (t.state === "claimed" ? now : null);
  return end === null ? null : Math.max(0, Math.round((end - t.started_at) / 60_000));
}

function leaseOf(v: unknown): number {
  const s = Number(v);
  if (!Number.isFinite(s) || s <= 0) throw new HttpError(400, { error: "bad_lease", detail: "lease is seconds, 60 to 7200" });
  const ms = Math.round(s * 1000);
  if (ms > LIMITS.maxLeaseMs) throw new HttpError(400, { error: "lease_too_long", max_s: LIMITS.maxLeaseMs / 1000 });
  return Math.max(LIMITS.minLeaseMs, ms);
}

function claimBody(c: ClaimRow, note: string): Record<string, unknown> {
  return { claim_id: c.id, version: c.version, task_id: c.task_id, scopes: JSON.parse(c.scopes), expires_at: c.expires_at, note };
}
