// The moderator: one Durable Object for the whole service. It holds the bans
// table (append-only), source-address blocks, bad-token strikes per source and
// the moderation channel that only Genix Mind and Kameron can read.

import { DurableObject } from "cloudflare:workers";
import { LIMITS, RULES } from "./lib";
import type { Env } from "./index";

export interface BanInput {
  rule: number;
  project?: string | null;
  agent_id?: string | null;
  agent_name?: string | null;
  parent_name?: string | null;
  ip: string;
  token_prefix?: string | null;
  path: string;
  detail?: string | null;
  descendants?: string[];
}

export interface BanRecord extends BanInput {
  id: number;
  at: number;
  reason: string;
  blocked_until: number;
  unbanned_at?: number | null;
  unban_note?: string | null;
}

export class Moderator extends DurableObject<Env> {
  private sql: SqlStorage;
  private offset = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS bans (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, rule INTEGER NOT NULL,
        project TEXT, agent_id TEXT, agent_name TEXT, parent_name TEXT, ip TEXT NOT NULL,
        token_prefix TEXT, path TEXT NOT NULL, detail TEXT, descendants TEXT, blocked_until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS unbans (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ban_id INTEGER NOT NULL, at INTEGER NOT NULL, note TEXT);
      CREATE TABLE IF NOT EXISTS blocks (ip TEXT PRIMARY KEY, until INTEGER NOT NULL, ban_id INTEGER);
      CREATE TABLE IF NOT EXISTS slows (ip TEXT PRIMARY KEY, until INTEGER NOT NULL, ban_id INTEGER);
      CREATE TABLE IF NOT EXISTS strikes (ip TEXT NOT NULL, at INTEGER NOT NULL, token_prefix TEXT, path TEXT);
      CREATE INDEX IF NOT EXISTS strikes_ip ON strikes(ip, at);
      CREATE TABLE IF NOT EXISTS moderation (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, ban_id INTEGER, text TEXT NOT NULL);
    `);
  }

  private now(): number {
    return Date.now() + this.offset;
  }

  /** Test hook, refused unless the ALLOW_TEST_CLOCK binding is set. */
  async _testAdvance(ms: number): Promise<void> {
    if (this.env.ALLOW_TEST_CLOCK !== "1") throw new Error("test clock disabled");
    this.offset += ms;
  }

  async blockedUntil(ip: string): Promise<number> {
    const row = this.sql.exec<{ until: number }>("SELECT until FROM blocks WHERE ip = ?", ip).toArray()[0];
    return row && row.until > this.now() ? row.until : 0;
  }

  async activeBlocks(): Promise<[string, number][]> {
    const now = this.now();
    return this.sql
      .exec<{ ip: string; until: number }>("SELECT ip, until FROM blocks WHERE until > ?", now)
      .toArray()
      .map((r) => [r.ip, r.until]);
  }

  /**
   * Records one call with no valid token from a source. The fifth in ten minutes slows that
   * address (rule 2) for ten minutes, for tokenless calls only. Nothing here blocks the address:
   * callers with a valid token are never checked against it. A call made while slowed is refused
   * and adds no strike, so the slowdown ends ten minutes after it began.
   */
  async strike(ip: string, path: string, tokenPrefix: string | null, detail: string): Promise<{ slowed_until: number; rec: BanRecord | null }> {
    const now = this.now();
    const out = this.ctx.storage.transactionSync(() => {
      const slow = this.sql.exec<{ until: number; ban_id: number | null }>("SELECT until, ban_id FROM slows WHERE ip = ?", ip).toArray()[0];
      if (slow && slow.until > now) return { slowed_until: slow.until, rec: null, ban_id: slow.ban_id };
      this.sql.exec("DELETE FROM strikes WHERE at < ?", now - LIMITS.badTokenWindowMs);
      this.sql.exec("INSERT INTO strikes (ip, at, token_prefix, path) VALUES (?, ?, ?, ?)", ip, now, tokenPrefix, path);
      const n = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM strikes WHERE ip = ?", ip).one().n;
      if (n < LIMITS.badTokenStrikes) return { slowed_until: 0, rec: null, ban_id: null };
      this.sql.exec("DELETE FROM strikes WHERE ip = ?", ip);
      const until = now + LIMITS.slowMs;
      const rec = this.insertBan({ rule: 2, ip, path, token_prefix: tokenPrefix, detail: `${n} calls without a valid token: ${detail}` }, until);
      this.sql.exec(
        "INSERT INTO slows (ip, until, ban_id) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET until = excluded.until, ban_id = excluded.ban_id",
        ip, until, rec.id,
      );
      return { slowed_until: until, rec, ban_id: rec.id };
    });
    if (out.rec) await this.notify(out.rec);
    return { slowed_until: out.slowed_until, rec: out.rec };
  }

  async ban(input: BanInput): Promise<BanRecord> {
    // A ban row is a record of one agent's revoked token or a refused join. It never blocks an address.
    const rec = this.ctx.storage.transactionSync(() => this.insertBan(input, null));
    await this.notify(rec);
    return rec;
  }

  /** `until` null: the ban row is a record only. `until` is the end of a slowdown (rule 2). No address is ever blocked here. */
  private insertBan(input: BanInput, until?: number | null): BanRecord {
    const at = this.now();
    if (until === null || until === undefined) until = at;
    const id = this.sql
      .exec<{ id: number }>(
        `INSERT INTO bans (at, rule, project, agent_id, agent_name, parent_name, ip, token_prefix, path, detail, descendants, blocked_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        at, input.rule, input.project ?? null, input.agent_id ?? null, input.agent_name ?? null,
        input.parent_name ?? null, input.ip, input.token_prefix ?? null, input.path, input.detail ?? null,
        JSON.stringify(input.descendants ?? []), until,
      )
      .one().id;
    const rec: BanRecord = { ...input, id, at, reason: RULES[input.rule], blocked_until: until };
    this.sql.exec("INSERT INTO moderation (at, ban_id, text) VALUES (?, ?, ?)", at, id, noticeText(rec));
    return rec;
  }

  private async notify(rec: BanRecord): Promise<void> {
    const url = this.env.WEBHOOK_URL;
    if (!url) return;
    const text = noticeText(rec);
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, content: text, ban: { id: rec.id, rule: rec.rule, agent: rec.agent_name, project: rec.project } }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // The ban stands whether or not the notice got through; the moderation channel has it.
    }
  }

  async listBans(): Promise<BanRecord[]> {
    return this.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT b.*, u.at AS unbanned_at, u.note AS unban_note FROM bans b
         LEFT JOIN unbans u ON u.ban_id = b.id ORDER BY b.id`,
      )
      .toArray()
      .map((r) => ({ ...r, reason: RULES[r.rule as number], descendants: JSON.parse((r.descendants as string) || "[]") }) as unknown as BanRecord);
  }

  async unban(banId: number, note: string | null): Promise<BanRecord | null> {
    const now = this.now();
    const row = this.ctx.storage.transactionSync(() => {
      const b = this.sql.exec<Record<string, SqlStorageValue>>("SELECT * FROM bans WHERE id = ?", banId).toArray()[0];
      if (!b) return null;
      this.sql.exec("INSERT INTO unbans (ban_id, at, note) VALUES (?, ?, ?)", banId, now, note);
      this.sql.exec("DELETE FROM blocks WHERE ip = ?", b.ip as string);
      this.sql.exec("DELETE FROM slows WHERE ip = ?", b.ip as string);
      this.sql.exec("DELETE FROM strikes WHERE ip = ?", b.ip as string);
      this.sql.exec(
        "INSERT INTO moderation (at, ban_id, text) VALUES (?, ?, ?)",
        now, banId, `Unban of ban ${banId} (${b.agent_name ?? "no agent"}, ${b.ip}): block lifted.${note ? " Note: " + note : ""}`,
      );
      return b;
    });
    return row ? ({ ...row, reason: RULES[row.rule as number], unbanned_at: now } as unknown as BanRecord) : null;
  }

  async moderation(since: number): Promise<{ seq: number; at: number; ban_id: number | null; text: string }[]> {
    return this.sql
      .exec<{ seq: number; at: number; ban_id: number | null; text: string }>(
        "SELECT seq, at, ban_id, text FROM moderation WHERE seq > ? ORDER BY seq LIMIT 500",
        since,
      )
      .toArray();
  }
}

export function noticeText(rec: BanInput & { id?: number }): string {
  const who = rec.agent_name ? `agent ${rec.agent_name}${rec.parent_name ? ` (parent ${rec.parent_name})` : ""}` : "no agent (unauthenticated)";
  const parts = [
    `Agent Room ban${rec.id ? ` #${rec.id}` : ""}: rule ${rec.rule}, ${RULES[rec.rule]}.`,
    `Who: ${who}${rec.project ? ` in project ${rec.project}` : ""}, source ${rec.ip}, path ${rec.path}.`,
  ];
  if (rec.token_prefix) parts.push(`Token hash prefix ${rec.token_prefix}.`);
  if (rec.descendants && rec.descendants.length) parts.push(`Subagents revoked with it: ${rec.descendants.join(", ")}.`);
  if (rec.detail) parts.push(`Detail: ${rec.detail}.`);
  if (rec.rule === 1) parts.push("Recommend rotating the project key; rotation is Kameron's call.");
  parts.push("Reverse with POST /admin/unban if this was a false positive.");
  return parts.join(" ");
}
