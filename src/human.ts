// Routes for people: /h/... . Every request passes the Access check first; the room then runs
// the call as that person's roster row.

import { verifyAccess } from "./access";
import { PROJECT_RE, json, jsonMap, readBody } from "./lib";
import type { Env } from "./index";
import type { Result } from "./room";

const HUMAN_GET = new Set(["sync", "board", "whoami", "me"]);
const HUMAN_POST = new Set(["say", "task", "task_update", "claim", "release", "heartbeat", "leave", "nick"]);

const UI_FILES: Record<string, string> = {
  "/ui": "/ui/index.html",
  "/ui/": "/ui/index.html",
  "/ui/style.css": "/ui/style.css",
  "/ui/app.js": "/ui/app.js",
  "/ui/logic.js": "/ui/logic.js",
};

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";

export function isHumanPath(path: string): boolean {
  return path === "/h" || path.startsWith("/h/") || path === "/ui" || path.startsWith("/ui/");
}

async function serveUi(env: Env, req: Request, url: URL): Promise<Response> {
  const asset = UI_FILES[url.pathname];
  if (!asset) return json({ error: "not_found" }, 404);
  if (req.method !== "GET") return json({ error: "method_not_allowed", use: "GET" }, 405);
  const r = await env.ASSETS.fetch(new Request(new URL(asset, url.origin)));
  if (r.status !== 200) return json({ error: "not_found" }, 404);
  return new Response(r.body, {
    status: 200,
    headers: {
      "content-type": r.headers.get("content-type") ?? "application/octet-stream",
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
}

export async function handleHuman(env: Env, req: Request, url: URL, ip: string): Promise<Response> {
  const who = await verifyAccess(req, env);
  if (!who.ok) return json({ error: who.error, detail: who.detail }, who.status);
  const path = url.pathname;
  if (path === "/ui" || path.startsWith("/ui/")) return serveUi(env, req, url);
  // Another site cannot read the answer, but a GET would still create the person's row and mark
  // them present, so the browser's own report of a cross-site request is refused.
  if (req.method === "GET" && req.headers.get("sec-fetch-site") === "cross-site") return json({ error: "bad_origin" }, 403);

  if (path === "/h/projects") {
    if (req.method !== "GET") return json({ error: "method_not_allowed", use: "GET" }, 405);
    return json({ projects: Object.keys(jsonMap(env.PROJECT_KEYS)).sort() });
  }
  const m = path.match(/^\/h\/([^/]+)\/([a-z_]+)$/);
  if (!m) return json({ error: "not_found" }, 404);
  const [, project, action] = m;
  if (!PROJECT_RE.test(project) || jsonMap(env.PROJECT_KEYS)[project] === undefined) return json({ error: "unknown_project" }, 404);

  if (action === "ws") {
    if (req.method !== "GET" || req.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "upgrade_required" }, 426);
    if (req.headers.get("origin") !== url.origin) return json({ error: "bad_origin" }, 403);
    // The room reads who this is from these headers. set() replaces anything the browser sent.
    const headers = new Headers(req.headers);
    headers.set("x-room-human", who.email);
    headers.set("x-room-project", project);
    headers.set("x-room-ip", ip);
    return env.ROOM.get(env.ROOM.idFromName(project)).fetch(new Request(req, { headers }));
  }

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
