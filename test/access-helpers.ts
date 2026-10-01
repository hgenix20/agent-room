import { SELF, env as rawEnv, runInDurableObject } from "cloudflare:test";
import type { Res } from "./helpers";

const enc = new TextEncoder();
const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

function b64url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A compact JWT over `claims`, signed RS256 with `key` and naming `kid`. `headOver` replaces
 * header fields, so a test can claim another `alg` over a real RS256 signature.
 */
export async function signJwt(key: CryptoKey, kid: string, claims: Record<string, unknown>, headOver: Record<string, unknown> = {}): Promise<string> {
  const head = b64url(enc.encode(JSON.stringify({ alg: "RS256", kid, typ: "JWT", ...headOver })));
  const body = b64url(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign(RSA.name, key, enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

/** Claims Cloudflare Access would send for `email` under the test config; `over` replaces any of them. */
export function claimsFor(email: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: ["test-aud"], iss: "https://team.test", email, exp: now + 600, nbf: now - 10, iat: now - 10, ...over };
}

let configKey: Promise<CryptoKey> | null = null;

/** An Access token the worker under test accepts, signed with the key pair from vitest.config.ts. */
export async function accessJwt(email = "kameron@example.com", over: Record<string, unknown> = {}): Promise<string> {
  configKey ??= crypto.subtle.importKey("jwk", JSON.parse((rawEnv as any).TEST_ACCESS_PRIVATE_JWK), RSA, false, ["sign"]);
  return signJwt(await configKey, "test-kid", claimsFor(email, over));
}

/**
 * A call as a signed-in person. A POST carries the worker's own Origin unless `origin` says
 * otherwise (null sends none). `jwt: null` sends no Access header.
 */
export async function human(
  path: string,
  opts: { email?: string; body?: unknown; method?: string; origin?: string | null; jwt?: string | null } = {},
): Promise<Res> {
  const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
  const headers: Record<string, string> = { "cf-connecting-ip": "10.250.0.1" };
  const jwt = opts.jwt === undefined ? await accessJwt(opts.email) : opts.jwt;
  if (jwt) headers["cf-access-jwt-assertion"] = jwt;
  const origin = opts.origin === undefined ? (method === "GET" ? null : "https://room.test") : opts.origin;
  if (origin) headers.origin = origin;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const r = await SELF.fetch(`https://room.test${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: r.status, body: await r.json() };
}

/** Opens the room's socket as a signed-in person. `msgs` fills with parsed messages as they arrive. */
export async function openSocket(
  project: string,
  opts: { email?: string; headers?: Record<string, string>; origin?: string | null } = {},
): Promise<{ status: number; ws?: WebSocket; msgs: any[] }> {
  const headers: Record<string, string> = {
    Upgrade: "websocket",
    "cf-connecting-ip": "10.250.0.1",
    "cf-access-jwt-assertion": await accessJwt(opts.email),
    ...(opts.headers ?? {}),
  };
  const origin = opts.origin === undefined ? "https://room.test" : opts.origin;
  if (origin) headers.origin = origin;
  const r = await SELF.fetch(`https://room.test/h/${project}/ws`, { headers });
  const msgs: any[] = [];
  if (r.status !== 101 || !r.webSocket) return { status: r.status, msgs };
  const ws = r.webSocket;
  ws.addEventListener("message", (e) => msgs.push(JSON.parse(String(e.data))));
  ws.accept();
  return { status: 101, ws, msgs };
}

/** Waits until `check` is true, polling every 10 ms; throws after `ms`. */
export async function until(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Closes every socket the room holds, so one test's sockets never count against another's. */
export async function closeSockets(project: string): Promise<void> {
  const stub = (rawEnv as any).ROOM.get((rawEnv as any).ROOM.idFromName(project));
  await (runInDurableObject as any)(stub, async (_room: any, state: DurableObjectState) => {
    for (const ws of state.getWebSockets()) ws.close(1000, "test over");
  });
}
