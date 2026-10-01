// Agent Room worker: checks each call, runs the moderator's fixed rules, and
// passes the call to the project's Durable Object.

import { HttpError, PROJECT_RE, json, jsonMap, makeToken, newAgentId, parseToken, readBody, safeEqual, sha256 } from "./lib";
import { handleHuman, isHumanPath } from "./human";
import type { ProjectRoom, Result } from "./room";
import type { BanInput, Moderator } from "./moderator";
import type { AccessEnv } from "./access";

export { ProjectRoom } from "./room";
export { Moderator } from "./moderator";

export interface Env extends AccessEnv {
  ROOM: DurableObjectNamespace<ProjectRoom>;
  MODERATOR: DurableObjectNamespace<Moderator>;
  /** Secret. JSON object {"<project>": "<join key>"}. A project not listed does not exist. */
  PROJECT_KEYS?: string;
  /** Secret. JSON object {"<label>": "<orchestrator credential>"}, issued by Kameron. */
  ORCHESTRATOR_CREDENTIALS?: string;
  /** Secret. Kameron's admin token for /admin/*. */
  ADMIN_TOKEN?: string;
  /** Secret. Genix Mind's read token for the moderation channel. */
  MIND_TOKEN?: string;
  /** Secret. Webhook for ban notices to Kameron's chosen channel. */
  WEBHOOK_URL?: string;
  /** Test only: lets tests move the Durable Objects' clocks. Never set in production. */
  ALLOW_TEST_CLOCK?: string;
  /** How long a worker isolate trusts its copy of the block list, in ms (default 30000). */
  BLOCK_CACHE_MS?: string;
}

const ROOM_CALLS = new Set(["heartbeat", "sync", "say", "board", "task", "task_update", "claim", "release", "leave", "whoami", "adopt"]);
const GET_CALLS = new Set(["sync", "board", "whoami"]);

let blockCache: { at: number; ips: Map<string, number> } | null = null;

function moderator(env: Env) {
  return env.MODERATOR.get(env.MODERATOR.idFromName("moderator"));
}

function room(env: Env, project: string) {
  return env.ROOM.get(env.ROOM.idFromName(project));
}

function sourceOf(req: Request): string {
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "unknown";
}

async function isBlocked(env: Env, ip: string): Promise<boolean> {
  const ttl = env.BLOCK_CACHE_MS === undefined ? 30_000 : Number(env.BLOCK_CACHE_MS);
  const now = Date.now();
  if (ttl > 0 && blockCache && now - blockCache.at < ttl) {
    return (blockCache.ips.get(ip) ?? 0) > now;
  }
  if (ttl <= 0) return (await moderator(env).blockedUntil(ip)) > 0;
  const list = await moderator(env).activeBlocks();
  blockCache = { at: now, ips: new Map(list as [string, number][]) };
  return (blockCache.ips.get(ip) ?? 0) > now;
}

function noteBlock(ip: string, until: number) {
  blockCache?.ips.set(ip, until);
}

async function ban(env: Env, input: BanInput): Promise<Response> {
  const rec = await moderator(env).ban(input);
  if (input.rule === 6) return json({ error: "forged_ancestry", rule: 6, ban_id: rec.id, detail: input.detail }, 403);
  return json({ error: "banned", rule: input.rule, ban_id: rec.id }, 403);
}

async function strike(env: Env, ip: string, path: string, tokenPrefix: string | null, detail: string, res: Response): Promise<Response> {
  const r = await moderator(env).strike(ip, path, tokenPrefix, detail);
  if (r.slowed_until) {
    return json({ error: "slowed", rule: 2, ban_id: r.rec?.id, detail: "too many calls without a valid token from this address; calls with a valid token still work" }, 429);
  }
  return res;
}

function fromResult(r: Result): Response {
  return json(r.body, r.status);
}

// ------------------------------------------------------------------ join

async function handleJoin(env: Env, req: Request, project: string, ip: string, path: string): Promise<Response> {
  const body = await readBody(req);
  const keys = jsonMap(env.PROJECT_KEYS);
  const projectKey = typeof body.project_key === "string" ? body.project_key : "";
  if (!projectKey || !(await safeEqual(projectKey, keys[project]))) {
    return strike(env, ip, path, null, "wrong or missing project key", json({ error: "bad_project_key" }, 401));
  }
  const name = typeof body.name === "string" ? body.name : "";
  const model = typeof body.model === "string" ? body.model : "unknown";
  const key = typeof body.key === "string" ? body.key.slice(0, 128) : null;

  let credLabel: string | null = null;
  let parentId: string | null = null;
  let parentTokenHash: string | null = null;

  const hasCred = typeof body.orchestrator_credential === "string" && body.orchestrator_credential !== "";
  const hasParent = typeof body.parent_token === "string" && body.parent_token !== "";
  // A join without a credential is counted toward the address slowdown (tokenless calls), never a block.
  const refuse1 = async (detail: string) => {
    const res = await ban(env, { rule: 1, project, ip, path, agent_name: name || null, detail });
    await moderator(env).strike(ip, path, null, detail);
    return res;
  };

  if (hasCred) {
    for (const [label, cred] of Object.entries(jsonMap(env.ORCHESTRATOR_CREDENTIALS))) {
      if (await safeEqual(body.orchestrator_credential as string, cred)) credLabel = label;
    }
    if (!credLabel) return refuse1("orchestrator credential not valid");
  }
  if (hasParent) {
    const pt = parseToken(body.parent_token as string);
    if (!pt) return refuse1("parent token malformed");
    parentTokenHash = await sha256(pt.raw);
    if (pt.project !== project) return crossProject(env, pt.project, pt.agentId, parentTokenHash, project, ip, path);
    parentId = pt.agentId;
  }
  if (!hasCred && !hasParent) return refuse1("no orchestrator credential or parent token");

  const agentId = newAgentId();
  const token = makeToken(project, agentId);
  const tokenHash = await sha256(token);
  const stub = room(env, project);
  const r = (await stub.join({ project, name, model, credLabel, parentId, parentTokenHash, token, tokenHash, agentId, key, ip })) as unknown as Result;
  if (r.violation) {
    return ban(env, { rule: r.violation.rule, project, ip, path, agent_name: name || null, parent_name: r.violation.parent_name ?? null, detail: r.violation.detail });
  }
  if (r.rotateFor) {
    const fresh = makeToken(project, r.rotateFor);
    await stub.rotateToken(r.rotateFor, await sha256(fresh));
    return json({ ...r.body, token: fresh });
  }
  return fromResult(r);
}

/** Rule 3: a token used against a project it was not issued for. That token is revoked; the address is not touched. */
async function crossProject(env: Env, home: string, agentId: string, tokenHash: string, project: string, ip: string, path: string): Promise<Response> {
  const keys = jsonMap(env.PROJECT_KEYS);
  let info = null;
  if (keys[home] !== undefined) {
    info = await room(env, home).revoke(agentId, { ban: true, rule: 3, tokenHash });
  }
  const orphans = info?.orphans ?? [];
  return ban(env, {
    rule: 3,
    project,
    ip,
    path,
    agent_id: info?.found ? agentId : null,
    agent_name: info?.agent_name ?? null,
    parent_name: info?.parent_name ?? null,
    token_prefix: tokenHash.slice(0, 8),
    detail: `token issued for project ${home}${info?.found ? "" : " (no such agent there)"}${orphans.length ? `; subagents left orphaned, not banned: ${orphans.join(", ")}` : ""}`,
  });
}

// ------------------------------------------------------------------ room calls

async function handleCall(env: Env, req: Request, project: string, action: string, ip: string, path: string, url: URL): Promise<Response> {
  if (GET_CALLS.has(action) !== (req.method === "GET")) {
    return json({ error: "method_not_allowed", use: GET_CALLS.has(action) ? "GET" : "POST" }, 405);
  }
  const auth = req.headers.get("authorization") ?? "";
  const raw = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const pt = parseToken(raw);
  if (!pt) return strike(env, ip, path, null, "malformed or missing token", json({ error: "bad_token" }, 401));
  const tokenHash = await sha256(pt.raw);
  if (pt.project !== project) return crossProject(env, pt.project, pt.agentId, tokenHash, project, ip, path);
  const body = await readBody(req);
  const query = Object.fromEntries(url.searchParams.entries());
  const r = (await room(env, project).call({ project, action, agentId: pt.agentId, tokenHash, body, query, ip })) as unknown as Result;
  if (r.violation) {
    const v = r.violation;
    return ban(env, {
      rule: v.rule,
      project,
      ip,
      path,
      agent_id: v.agent_id ?? null,
      agent_name: v.agent_name ?? null,
      parent_name: v.parent_name ?? null,
      token_prefix: v.token_prefix ?? tokenHash.slice(0, 8),
      descendants: v.descendants ?? [],
      detail: v.detail,
    });
  }
  if (r.badToken) return strike(env, ip, path, tokenHash.slice(0, 8), String(r.body.detail ?? r.body.error), fromResult(r));
  return fromResult(r);
}

// ------------------------------------------------------------------ admin

async function handleAdmin(env: Env, req: Request, what: string, url: URL): Promise<Response> {
  const auth = req.headers.get("authorization") ?? "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!env.ADMIN_TOKEN) return json({ error: "admin_not_configured" }, 503);
  const isAdmin = !!given && (await safeEqual(given, env.ADMIN_TOKEN));
  const isMind = !!given && !!env.MIND_TOKEN && (await safeEqual(given, env.MIND_TOKEN));
  const mod = moderator(env);

  if (what === "moderation" && req.method === "GET" && (isAdmin || isMind)) {
    return json({ messages: await mod.moderation(Number(url.searchParams.get("since") ?? 0) || 0) });
  }
  if (!isAdmin) return json({ error: "unauthorized" }, 401);

  if (what === "bans" && req.method === "GET") return json({ bans: await mod.listBans() });
  if (what === "unban" && req.method === "POST") {
    const body = await readBody(req);
    const id = Number(body.ban_id);
    if (!Number.isInteger(id)) return json({ error: "ban_id required" }, 400);
    const rec = await mod.unban(id, typeof body.note === "string" ? body.note.slice(0, 500) : null);
    if (!rec) return json({ error: "unknown_ban" }, 404);
    blockCache?.ips.delete(rec.ip);
    if (rec.project && rec.agent_id) await room(env, rec.project).unbanAgent(rec.agent_id);
    return json({ ok: true, ban: rec });
  }
  if (what === "revoke" && req.method === "POST") {
    const body = await readBody(req);
    const project = String(body.project ?? "");
    if (!PROJECT_RE.test(project) || jsonMap(env.PROJECT_KEYS)[project] === undefined) return json({ error: "unknown_project" }, 404);
    const stub = room(env, project);
    const id = await stub.findAgent(String(body.agent ?? ""));
    if (!id) return json({ error: "unknown_agent" }, 404);
    return json({ ok: true, revoked: await stub.revoke(id, { ban: false, rule: 0 }) });
  }
  return json({ error: "not_found" }, 404);
}

// ------------------------------------------------------------------ entry

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const ip = sourceOf(req);
    try {
      if (isHumanPath(path)) return await handleHuman(env, req, url, ip);
      const admin = path.match(/^\/admin\/([a-z]+)$/);
      if (admin) return await handleAdmin(env, req, admin[1], url);

      const m = path.match(/^\/p\/([^/]+)\/([a-z_]+)$/);
      if (!m) {
        if (path === "/" || path === "/health") return json({ service: "agent-room", ok: true });
        return json({ error: "not_found" }, 404);
      }
      const [, project, action] = m;
      if (await isBlocked(env, ip)) return json({ error: "blocked", detail: "source blocked by the moderator" }, 403);
      if (!PROJECT_RE.test(project) || jsonMap(env.PROJECT_KEYS)[project] === undefined) return json({ error: "unknown_project" }, 404);
      if (action === "join") {
        if (req.method !== "POST") return json({ error: "method_not_allowed", use: "POST" }, 405);
        return await handleJoin(env, req, project, ip, path);
      }
      if (!ROOM_CALLS.has(action)) return json({ error: "unknown_call", call: action }, 404);
      return await handleCall(env, req, project, action, ip, path, url);
    } catch (e) {
      if (e instanceof HttpError) return json(e.body, e.status);
      console.error(e);
      return json({ error: "internal" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
