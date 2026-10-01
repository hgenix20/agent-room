// Verifies the header Cloudflare Access adds to a signed-in request. The worker trusts
// nothing about the request until this passes, so a mistake in the Access setup cannot
// open the room.

export interface AccessEnv {
  /** Plain var: the team's Access host, for example "kamerongreen.cloudflareaccess.com". */
  ACCESS_TEAM_DOMAIN?: string;
  /** Plain var: the audience tag of the Access application that covers /ui and /h. */
  ACCESS_AUD?: string;
  /** Secret: JSON array of the emails allowed to act as people in the room. */
  HUMANS?: string;
  /** Test only: a JWKS used in place of fetching the team's certs, honored only with ALLOW_TEST_CLOCK. */
  ACCESS_TEST_JWKS?: string;
  /** Test only: "1" in the test run. Never set in production. */
  ALLOW_TEST_CLOCK?: string;
}

export type AccessResult = { ok: true; email: string } | { ok: false; status: number; error: string; detail: string };

type Jwk = JsonWebKey & { kid?: string };

const CERT_TTL_MS = 60 * 60_000;
// An unknown key id forces a certs fetch at most this often, so a stream of made-up key ids
// cannot make the worker fetch on every request.
const REFETCH_GAP_MS = 60_000;
// An email is printable ASCII only, so lowercasing cannot fold another character into a listed one.
const EMAIL_CHARS = /^[!-~]+$/;
const SLACK_S = 60;
const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

let certCache: { at: number; domain: string; keys: Jwk[] } | null = null;
let lastForcedFetch = Number.NEGATIVE_INFINITY;

/** Test hook: forget the cached certs and when a refetch was last forced. */
export function _resetCertCache(): void {
  certCache = null;
  lastForcedFetch = Number.NEGATIVE_INFINITY;
}

function refuse(detail: string): AccessResult {
  return { ok: false, status: 403, error: "access_required", detail };
}

function b64urlBytes(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function b64urlJson(s: string): Record<string, unknown> | null {
  const bytes = b64urlBytes(s);
  if (!bytes) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function allowList(raw: string | undefined): string[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    const emails = v
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim())
      .filter((x) => EMAIL_CHARS.test(x))
      .map((x) => x.toLowerCase());
    return emails.length ? emails : null;
  } catch {
    return null;
  }
}

async function keysFor(env: AccessEnv, domain: string, fetcher: (url: string) => Promise<Response>, force: boolean): Promise<Jwk[]> {
  if (env.ACCESS_TEST_JWKS && env.ALLOW_TEST_CLOCK === "1") {
    const v = JSON.parse(env.ACCESS_TEST_JWKS) as { keys?: Jwk[] };
    return Array.isArray(v.keys) ? v.keys : [];
  }
  const now = Date.now();
  if (!force && certCache && certCache.domain === domain && now - certCache.at < CERT_TTL_MS) return certCache.keys;
  const r = await fetcher(`https://${domain}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error(`certs answered ${r.status}`);
  const body = (await r.json()) as { keys?: Jwk[] };
  certCache = { at: now, domain, keys: Array.isArray(body.keys) ? body.keys : [] };
  return certCache.keys;
}

/**
 * Checks the Cf-Access-Jwt-Assertion header: RS256 signature against the team's keys, audience,
 * issuer, expiry (60 s of slack), and that the email is on the HUMANS list.
 * 503 when the settings are missing or the team's certs cannot be read; 403 for every other failure.
 */
export async function verifyAccess(
  req: Request,
  env: AccessEnv,
  fetcher: (url: string) => Promise<Response> = (url) => fetch(url),
  nowMs: number = Date.now(),
): Promise<AccessResult> {
  const domain = env.ACCESS_TEAM_DOMAIN;
  const aud = env.ACCESS_AUD;
  const humans = allowList(env.HUMANS);
  if (!domain || !aud || !humans) {
    return { ok: false, status: 503, error: "human_ui_not_configured", detail: "ACCESS_TEAM_DOMAIN, ACCESS_AUD and HUMANS must be set" };
  }
  const raw = req.headers.get("cf-access-jwt-assertion");
  if (!raw) return refuse("no Access header on the request");
  const parts = raw.split(".");
  if (parts.length !== 3) return refuse("Access header is not a token");
  const head = b64urlJson(parts[0]);
  const claims = b64urlJson(parts[1]);
  const sig = b64urlBytes(parts[2]);
  if (!head || !claims || !sig) return refuse("Access header is not a token");
  if (head.alg !== "RS256" || typeof head.kid !== "string") return refuse("token is not RS256 with a key id");

  let key: Jwk | undefined;
  try {
    key = (await keysFor(env, domain, fetcher, false)).find((k) => k.kid === head.kid);
    if (!key && nowMs - lastForcedFetch >= REFETCH_GAP_MS) {
      lastForcedFetch = nowMs;
      key = (await keysFor(env, domain, fetcher, true)).find((k) => k.kid === head.kid);
    }
  } catch {
    // Not the person's fault: the page must not tell them their session expired.
    return { ok: false, status: 503, error: "access_unavailable", detail: "the team's certs could not be read" };
  }
  if (!key) return refuse("token signed with an unknown key");

  let valid = false;
  try {
    const pub = await crypto.subtle.importKey("jwk", key, RSA, false, ["verify"]);
    valid = await crypto.subtle.verify(RSA.name, pub, sig, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch {
    valid = false;
  }
  if (!valid) return refuse("token signature does not verify");

  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) return refuse("token is for another application");
  if (claims.iss !== `https://${domain}`) return refuse("token is from another issuer");
  const now = Math.floor(nowMs / 1000);
  if (typeof claims.exp !== "number" || claims.exp < now - SLACK_S) return refuse("token has expired");
  if (claims.nbf !== undefined && typeof claims.nbf !== "number") return refuse("token has a malformed nbf");
  if (typeof claims.nbf === "number" && claims.nbf > now + SLACK_S) return refuse("token is not valid yet");
  if (typeof claims.email !== "string") return refuse("token names no email");
  const trimmed = claims.email.trim();
  if (!EMAIL_CHARS.test(trimmed)) return refuse("token email has a character outside printable ASCII");
  const email = trimmed.toLowerCase();
  if (!humans.includes(email)) return refuse("this email is not on the room's list");
  return { ok: true, email };
}
