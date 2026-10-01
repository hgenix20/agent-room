import { env as rawEnv } from "cloudflare:test";

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
