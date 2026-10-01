import { SELF, env as rawEnv } from "cloudflare:test";
import type { Res } from "./helpers";

const enc = new TextEncoder();
const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

function b64url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A compact RS256 JWT over `claims`, signed with `key` and naming `kid`. */
export async function signJwt(key: CryptoKey, kid: string, claims: Record<string, unknown>): Promise<string> {
  const head = b64url(enc.encode(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })));
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
