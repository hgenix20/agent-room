import { SELF, env as rawEnv } from "cloudflare:test";
import type { Env } from "../src/index";

const env = rawEnv as unknown as Env;

let n = 0;
/** A fresh source address per caller, so one test's ban never blocks another. */
export function newIp(): string {
  n++;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

export interface Res {
  status: number;
  body: any;
}

export async function req(
  path: string,
  opts: { method?: string; token?: string; body?: unknown; ip: string },
): Promise<Res> {
  const headers: Record<string, string> = { "cf-connecting-ip": opts.ip };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const r = await SELF.fetch(`https://room.test${path}`, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: r.status, body: await r.json() };
}

export interface Agent {
  id: string;
  name: string;
  token: string;
  cursor: number;
  ip: string;
  project: string;
}

export async function joinOrch(project: string, name: string, ip = newIp(), cred = "orch-cred-box"): Promise<Agent> {
  const r = await req(`/p/${project}/join`, {
    ip,
    body: { name, model: "claude opus", project_key: `test-key-${project}`, orchestrator_credential: cred },
  });
  if (r.status !== 200) throw new Error(`join failed ${r.status} ${JSON.stringify(r.body)}`);
  return { id: r.body.agent_id, name: r.body.name, token: r.body.token, cursor: r.body.cursor, ip, project };
}

export async function joinSub(parent: Agent, name: string, ip = parent.ip): Promise<Agent> {
  const r = await req(`/p/${parent.project}/join`, {
    ip,
    body: { name, model: "claude sonnet", project_key: `test-key-${parent.project}`, parent_token: parent.token },
  });
  if (r.status !== 200) throw new Error(`join failed ${r.status} ${JSON.stringify(r.body)}`);
  return { id: r.body.agent_id, name: r.body.name, token: r.body.token, cursor: r.body.cursor, ip, project: parent.project };
}

export function post(a: Agent, call: string, body: unknown = {}): Promise<Res> {
  return req(`/p/${a.project}/${call}`, { ip: a.ip, token: a.token, body });
}

export function get(a: Agent, call: string, query = ""): Promise<Res> {
  return req(`/p/${a.project}/${call}${query}`, { ip: a.ip, token: a.token });
}

export async function newTask(a: Agent, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await post(a, "task", { title, ...extra });
  if (r.status !== 200) throw new Error(`task failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.task_id;
}

/** Moves the project's clock (and the moderator's) forward. */
export async function advance(project: string, ms: number): Promise<void> {
  await env.ROOM.get(env.ROOM.idFromName(project))._testAdvance(ms);
  await env.MODERATOR.get(env.MODERATOR.idFromName("moderator"))._testAdvance(ms);
}

export function admin(path: string, body?: unknown, token = "admin-test-token"): Promise<Res> {
  return req(path, { ip: newIp(), token, body });
}

export function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 7)}`;
}
