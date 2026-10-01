// Routes for people: /h/... . Every request passes the Access check first; the room then runs
// the call as that person's roster row.

import { verifyAccess } from "./access";
import { PROJECT_RE, json, jsonMap, readBody } from "./lib";
import type { Env } from "./index";
import type { Result } from "./room";

const HUMAN_GET = new Set(["sync", "board", "whoami", "me"]);
const HUMAN_POST = new Set(["say", "task", "task_update", "claim", "release", "heartbeat", "leave", "nick"]);

export function isHumanPath(path: string): boolean {
  return path === "/h" || path.startsWith("/h/");
}

export async function handleHuman(env: Env, req: Request, url: URL, ip: string): Promise<Response> {
  const who = await verifyAccess(req, env);
  if (!who.ok) return json({ error: who.error, detail: who.detail }, who.status);
  const path = url.pathname;

  if (path === "/h/projects") {
    if (req.method !== "GET") return json({ error: "method_not_allowed", use: "GET" }, 405);
    return json({ projects: Object.keys(jsonMap(env.PROJECT_KEYS)).sort() });
  }
  const m = path.match(/^\/h\/([^/]+)\/([a-z_]+)$/);
  if (!m) return json({ error: "not_found" }, 404);
  const [, project, action] = m;
  if (!PROJECT_RE.test(project) || jsonMap(env.PROJECT_KEYS)[project] === undefined) return json({ error: "unknown_project" }, 404);

  const isGet = HUMAN_GET.has(action);
  if (!isGet && !HUMAN_POST.has(action)) return json({ error: "unknown_call", call: action }, 404);
  if (isGet !== (req.method === "GET")) return json({ error: "method_not_allowed", use: isGet ? "GET" : "POST" }, 405);
  // A write must come from this page: another site cannot send this Origin from Kameron's browser.
  if (!isGet && req.headers.get("origin") !== url.origin) return json({ error: "bad_origin" }, 403);

  const body = await readBody(req);
  const query = Object.fromEntries(url.searchParams.entries());
  const stub = env.ROOM.get(env.ROOM.idFromName(project));
  const r = (await stub.humanCall({ project, email: who.email, action, body, query, ip })) as unknown as Result;
  return json(r.body, r.status);
}
