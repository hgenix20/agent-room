// One Durable Object per project: roster, room, board and claims in its own
// SQLite. Every check-then-write runs inside one synchronous transaction, so
// two agents can never win the same claim.

import { DurableObject } from "cloudflare:workers";
import {
  HttpError,
  LIMITS,
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

export interface RevokeInfo {
  found: boolean;
  agent_id: string;
  agent_name: string | null;
  parent_name: string | null;
  token_prefix: string | null;
  descendants: string[];
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
  [k: string]: SqlStorageValue;
}

const WRITE_ACTIONS = new Set(["heartbeat", "say", "task", "claim", "release", "leave"]);

export class ProjectRoom extends DurableObject<Env> {
  private sql: SqlStorage;
  private offset = 0;
  private project = "";

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
      CREATE TABLE IF NOT EXISTS strikes (agent_id TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL);
    `);
    const off = this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'clock_offset'").toArray()[0];
    if (off) this.offset = Number(off.v);
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
      const next = quiet >= LIMITS.goneMs ? "gone" : quiet >= LIMITS.staleMs ? "stale" : "active";
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
    return this.ctx.storage.transactionSync((): Result => {
      const now = this.now();
      this.sweep(now);
      let parent: AgentRow | undefined;
      if (input.parentId) {
        parent = this.agent(input.parentId);
        if (!parent || parent.token_hash !== input.parentTokenHash || parent.state === "revoked") {
          return { status: 403, body: { error: "banned", rule: 1 }, violation: { rule: 1, detail: "parent token not valid" } };
        }
        const problem = this.chainProblem(parent, now);
        if (problem === "banned" || problem === "parent_banned") {
          return {
            status: 403,
            body: { error: "banned", rule: 4 },
            violation: { rule: 4, parent_name: parent.name, detail: `parent ${parent.name} is banned` },
          };
        }
        if (problem) {
          // Parent gone or left: the join is refused and counted as an expired token (rule 2).
          return { status: 401, body: { error: "parent_gone", detail: problem }, badToken: true };
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
      const model = String(input.model || "unknown").slice(0, 80);
      let name = input.name;
      const taken = (n: string) =>
        this.rows<AgentRow>("SELECT * FROM agents WHERE name = ? AND state = 'active'", n).some((a) => this.alive(a, now));
      for (let i = 2; taken(name); i++) name = `${input.name}-${i}`;
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

  /** Completes an idempotent join replay: store the hash of the rotated token. */
  async rotateToken(agentId: string, tokenHash: string): Promise<void> {
    this.sql.exec("UPDATE agents SET token_hash = ? WHERE id = ?", tokenHash, agentId);
  }

  // ------------------------------------------------------------------ calls

  async call(input: CallInput & { project: string }): Promise<Result> {
    this.project = input.project;
    return this.ctx.storage.transactionSync((): Result => {
      const now = this.now();
      this.sweep(now);
      const me = this.agent(input.agentId);
      if (!me || me.token_hash !== input.tokenHash) return { status: 401, body: { error: "bad_token" }, badToken: true };
      const problem = this.chainProblem(me, now);
      if (problem) return { status: 401, body: { error: "token_not_valid", detail: problem }, badToken: true };

      const write = WRITE_ACTIONS.has(input.action);
      const key = write && typeof input.body.key === "string" ? input.body.key.slice(0, 128) : null;
      const scope = `${me.id}:${input.action}`;
      const replay = this.idemGet(scope, key);
      if (replay) {
        this.touch(me, now);
        return replay;
      }

      if (write) {
        const limited = this.rateCheck(me, input.action === "heartbeat" ? "h" : "w", now);
        if (limited) return limited;
      }

      let r: Result;
      try {
        r = this.dispatch(input.action, me, input.body, input.query, now);
      } catch (e) {
        if (e instanceof SecretRefused) {
          r = this.secretStrike(me, e.reason, now);
          if (r.violation) return r;
        } else if (e instanceof HttpError) {
          r = { status: e.status, body: e.body };
        } else throw e;
      }
      if (this.agent(me.id)?.state === "active") this.touch(me, now);
      this.idemPut(scope, key, r);
      return r;
    });
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
      const v = this.maybeBan(me, "rate", now, "rate limit exceeded");
      if (v) return v;
    }
    return { status: 429, body: { error: "rate_limited", limit_per_minute: limit, retry_after_s: 60 - Math.floor((now % 60_000) / 1000) } };
  }

  private secretStrike(me: AgentRow, reason: string, now: number): Result {
    this.sql.exec("INSERT INTO strikes (agent_id, kind, at) VALUES (?, 'secret', ?)", me.id, now);
    const v = this.maybeBan(me, "secret", now, `secret filter refused: ${reason}`);
    if (v) return v;
    return { status: 422, body: { error: "secret_refused", reason, detail: "text looks like a key or token; the room never holds secrets" } };
  }

  private maybeBan(me: AgentRow, kind: string, now: number, detail: string): Result | null {
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
        detail: `${n} times in an hour: ${detail}`,
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
      case "claim":
        return this.claim(me, body, now);
      case "release":
        return this.release(me, body, now);
      case "leave":
        return this.leave(me, now);
      case "whoami":
        return { status: 200, body: { agent_id: me.id, name: me.name, model: me.model, parent: this.nameOf(me.parent_id), task: this.currentTask(me.id) } };
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
    const status = body.status_line === undefined ? me.status_line : str(body.status_line, "status_line", LIMITS.statusChars);
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
    return { status: 200, body: { ok: true, renewed } };
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
    return { status: 200, body: { seq, task } };
  }

  private createTask(me: AgentRow, body: Record<string, unknown>, now: number): Result {
    const title = str(body.title, "title", LIMITS.titleChars, true);
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
    const num = this.counter("task_num");
    const id = `T${num}`;
    this.sql.exec(
      `INSERT INTO tasks (id, num, title, detail, state, parent_task, depends_on, created_by, updated_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      id, num, title, detail, parentTask, JSON.stringify(deps), me.id, now,
    );
    this.event("task", id, me.id, id, { task: id, title, by: me.name, depends_on: deps, parent_task: parentTask });
    return { status: 200, body: { task_id: id } };
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
        if (hit) return { status: 409, body: { ...holderOf(c), reason: "scope overlap", scope: s, overlaps: hit } };
      }
    }
    const version = this.counter("claim_version");
    const id = "c" + randomId(6);
    const expires = now + leaseMs;
    this.sql.exec(
      "INSERT INTO claims (id, task_id, owner_id, scopes, version, lease_ms, expires_at, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'live', ?)",
      id, taskId, me.id, JSON.stringify(scopes), version, leaseMs, expires, now,
    );
    this.sql.exec("UPDATE tasks SET state = 'claimed', owner_id = ?, updated_at = ? WHERE id = ?", me.id, now, taskId);
    this.sql.exec("UPDATE agents SET task_id = ? WHERE id = ?", taskId, me.id);
    this.event("claim", id, me.id, taskId, { by: this.label(me, taskId), task: taskId, title: task.title, scopes, claim_id: id, version, lease_s: leaseMs / 1000 });
    const deps: string[] = JSON.parse(task.depends_on);
    const openDeps = deps.filter((d) => this.first<TaskRow>("SELECT state FROM tasks WHERE id = ?", d)?.state !== "done");
    const out: Record<string, unknown> = { claim_id: id, version, task_id: taskId, scopes, expires_at: expires, lease_s: leaseMs / 1000 };
    if (openDeps.length) out.warning = `depends on tasks not done: ${openDeps.join(", ")}`;
    return { status: 200, body: out };
  }

  private release(me: AgentRow, body: Record<string, unknown>, now: number): Result {
    const state = body.state === undefined ? (body.all ? "blocked" : undefined) : body.state;
    if (state !== "done" && state !== "blocked") throw new HttpError(400, { error: "bad_state", detail: "state is done or blocked" });
    const commit = body.commit === undefined || body.commit === null ? null : str(body.commit, "commit", 80);
    const branch = body.branch === undefined || body.branch === null ? null : str(body.branch, "branch", 200);
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
    const released = [];
    for (const c of targets) {
      this.sql.exec("UPDATE claims SET state = 'released' WHERE id = ?", c.id);
      this.sql.exec(
        "UPDATE tasks SET state = ?, owner_id = ?, branch = COALESCE(?, branch), commit_sha = COALESCE(?, commit_sha), updated_at = ? WHERE id = ?",
        state, me.id, branch, commit, now, c.task_id,
      );
      this.sql.exec("UPDATE agents SET task_id = NULL WHERE id = ? AND task_id = ?", me.id, c.task_id);
      this.event("release", c.id, me.id, c.task_id, { by: this.label(me, c.task_id), task: c.task_id, state, commit, branch, claim_id: c.id });
      released.push({ claim_id: c.id, task_id: c.task_id, state });
    }
    return { status: 200, body: { ok: true, released } };
  }

  private leave(me: AgentRow, now: number): Result {
    const r = this.release(me, { all: true, state: "blocked" }, now);
    this.sql.exec("UPDATE agents SET state = 'left', task_id = NULL WHERE id = ?", me.id);
    this.event("roster", me.id, me.id, null, { name: me.name, state: "left" });
    return { status: 200, body: { ok: true, released: r.body.released } };
  }

  private board(now: number): Result {
    const tasks = this.rows<TaskRow>("SELECT * FROM tasks ORDER BY num").map((t) => {
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
      };
    });
    return { status: 200, body: { tasks } };
  }

  private sync(me: AgentRow, query: Record<string, string>, now: number): Result {
    const since = Math.max(0, Math.floor(Number(query.since ?? 0)) || 0);
    const limit = Math.min(LIMITS.syncMax, Math.max(1, Math.floor(Number(query.limit ?? LIMITS.syncDefault)) || LIMITS.syncDefault));
    const mentionsOnly = query.only === "mentions";
    const task = query.task ? String(query.task).slice(0, 40) : null;
    const conds: string[] = ["e.seq > ?"];
    const args: SqlStorageValue[] = [since];
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
      `SELECT e.seq, e.kind, e.agent_id, e.task_id, e.data, e.created_at, m.text, m.reply_to, m.mentions
       FROM events e LEFT JOIN messages m ON m.seq = e.seq
       WHERE ${conds.join(" AND ")} ORDER BY e.seq LIMIT ?`,
      ...args, limit + 1,
    );
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const cursor = more ? (page[page.length - 1].seq as number) : this.head();
    const events = page.map((r) => {
      const data = JSON.parse(r.data as string);
      const e: Record<string, unknown> = { seq: r.seq, kind: r.kind, at: r.created_at, ...data };
      if (r.kind === "say") {
        e.text = r.text;
        if (r.reply_to !== null) e.reply_to = r.reply_to;
        const ms = (r.mentions as string).split(",").filter(Boolean);
        if (ms.length) e.mentions = ms;
      }
      return e;
    });
    const roster = this.rows<AgentRow>("SELECT * FROM agents WHERE state = 'active' ORDER BY joined_at")
      .filter((a) => a.roster_state !== "gone" || this.liveClaimsOf(a.id).length > 0)
      .map((a) => ({
        name: a.name,
        model: a.model,
        parent: this.nameOf(a.parent_id),
        task: this.currentTask(a.id),
        status: a.status_line || undefined,
        state: a.roster_state,
        idle_min: Math.floor((now - a.last_seen) / 60_000),
      }));
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
    if (!a) return { found: false, agent_id: agentId, agent_name: null, parent_name: null, token_prefix: null, descendants: [] };
    const descendants: string[] = [];
    const drop = (x: AgentRow, state: string, reason: string) => {
      for (const c of this.liveClaimsOf(x.id)) {
        this.sql.exec("UPDATE claims SET state = 'revoked' WHERE id = ?", c.id);
        this.sql.exec("UPDATE tasks SET state = 'open', owner_id = NULL, updated_at = ? WHERE id = ? AND owner_id = ?", now, c.task_id, x.id);
        this.event("claim_expired", c.id, x.id, c.task_id, { task: c.task_id, owner: x.name, claim_id: c.id, reason });
      }
      this.sql.exec("UPDATE agents SET state = ?, task_id = NULL WHERE id = ?", state, x.id);
      this.event("roster", x.id, x.id, null, { name: x.name, state: "removed", reason });
    };
    drop(a, ban ? "banned" : "revoked", ban ? `banned under rule ${rule}` : "token revoked");
    const queue = [a.id];
    while (queue.length) {
      const pid = queue.shift()!;
      for (const c of this.rows<AgentRow>("SELECT * FROM agents WHERE parent_id = ? AND state = 'active'", pid)) {
        drop(c, "revoked", `parent ${a.name} ${ban ? "banned" : "revoked"}`);
        descendants.push(c.name);
        queue.push(c.id);
      }
    }
    return {
      found: true,
      agent_id: a.id,
      agent_name: a.name,
      parent_name: this.nameOf(a.parent_id),
      token_prefix: a.token_hash.slice(0, 8),
      descendants,
    };
  }

  /** Revoke (or ban) an agent and every subagent under it. With tokenHash, only when it matches. */
  async revoke(agentId: string, opts: { ban: boolean; rule: number; tokenHash?: string }): Promise<RevokeInfo> {
    return this.ctx.storage.transactionSync(() => {
      const a = this.agent(agentId);
      if (!a || (opts.tokenHash && a.token_hash !== opts.tokenHash)) {
        return { found: false, agent_id: agentId, agent_name: null, parent_name: null, token_prefix: null, descendants: [] };
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

class SecretRefused extends Error {
  constructor(public reason: string) {
    super("secret");
  }
}

function checkSecret(text: string): void {
  const r = secretReason(text);
  if (r) throw new SecretRefused(r);
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
