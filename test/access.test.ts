import { beforeEach, describe, expect, it } from "vitest";
import { _resetCertCache, verifyAccess, type AccessEnv } from "../src/access";
import { claimsFor, signJwt } from "./access-helpers";

const RSA = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
const ENV: AccessEnv = { ACCESS_TEAM_DOMAIN: "team.test", ACCESS_AUD: "test-aud", HUMANS: JSON.stringify(["kameron@example.com"]) };

async function keyPair(kid: string) {
  const pair = (await crypto.subtle.generateKey(RSA, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = { ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey), kid };
  return { priv: pair.privateKey, jwk };
}

function certs(keys: unknown[]) {
  const calls: string[] = [];
  const fetcher = async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({ keys }), { status: 200 });
  };
  return { calls, fetcher };
}

function withJwt(jwt: string | null): Request {
  return new Request("https://room.test/h/genix/board", { headers: jwt ? { "cf-access-jwt-assertion": jwt } : {} });
}

describe("verifyAccess", () => {
  beforeEach(() => _resetCertCache());

  it("accepts a valid token and returns the email lowercased", async () => {
    const k = await keyPair("k1");
    const { calls, fetcher } = certs([k.jwk]);
    const jwt = await signJwt(k.priv, "k1", claimsFor("Kameron@Example.com"));
    const r = await verifyAccess(withJwt(jwt), ENV, fetcher);
    expect(r).toEqual({ ok: true, email: "kameron@example.com" });
    expect(calls).toEqual(["https://team.test/cdn-cgi/access/certs"]);
    await verifyAccess(withJwt(jwt), ENV, fetcher);
    expect(calls.length).toBe(1);
  });

  it("refuses a request with no header or a malformed one", async () => {
    const { fetcher } = certs([]);
    for (const jwt of [null, "abc", "a.b", "a.b.c.d", "!!.??.**"]) {
      const r = await verifyAccess(withJwt(jwt), ENV, fetcher);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(403);
        expect(r.error).toBe("access_required");
      }
    }
  });

  it("refuses a bad signature, wrong audience, wrong issuer, expired or not-yet-valid token, and an unlisted email", async () => {
    const k = await keyPair("k1");
    const other = await keyPair("k1");
    const { fetcher } = certs([k.jwk]);
    const now = Math.floor(Date.now() / 1000);
    const bad: string[] = [
      await signJwt(other.priv, "k1", claimsFor("kameron@example.com")),
      await signJwt(k.priv, "k1", claimsFor("kameron@example.com", { aud: ["someone-else"] })),
      await signJwt(k.priv, "k1", claimsFor("kameron@example.com", { iss: "https://evil.test" })),
      await signJwt(k.priv, "k1", claimsFor("kameron@example.com", { exp: now - 120 })),
      await signJwt(k.priv, "k1", claimsFor("kameron@example.com", { nbf: now + 120 })),
      await signJwt(k.priv, "k1", claimsFor("stranger@example.com")),
      await signJwt(k.priv, "k1", claimsFor("kameron@example.com", { email: 42 })),
    ];
    for (const jwt of bad) {
      const r = await verifyAccess(withJwt(jwt), ENV, fetcher);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(403);
    }
  });

  it("allows 60 seconds of clock slack on exp", async () => {
    const k = await keyPair("k1");
    const { fetcher } = certs([k.jwk]);
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signJwt(k.priv, "k1", claimsFor("kameron@example.com", { exp: now - 30 }));
    expect((await verifyAccess(withJwt(jwt), ENV, fetcher)).ok).toBe(true);
  });

  it("accepts aud as a plain string", async () => {
    const k = await keyPair("k1");
    const { fetcher } = certs([k.jwk]);
    const jwt = await signJwt(k.priv, "k1", claimsFor("kameron@example.com", { aud: "test-aud" }));
    expect((await verifyAccess(withJwt(jwt), ENV, fetcher)).ok).toBe(true);
  });

  it("fetches the certs once more for an unknown key id, then refuses", async () => {
    const k = await keyPair("k1");
    const rotated = await keyPair("k2");
    const { calls, fetcher } = certs([k.jwk]);
    await verifyAccess(withJwt(await signJwt(k.priv, "k1", claimsFor("kameron@example.com"))), ENV, fetcher);
    const r = await verifyAccess(withJwt(await signJwt(rotated.priv, "k2", claimsFor("kameron@example.com"))), ENV, fetcher);
    expect(r.ok).toBe(false);
    expect(calls.length).toBe(2);
  });

  it("refuses when the certs cannot be fetched", async () => {
    const k = await keyPair("k1");
    const jwt = await signJwt(k.priv, "k1", claimsFor("kameron@example.com"));
    const r = await verifyAccess(withJwt(jwt), ENV, async () => new Response("no", { status: 500 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it("answers 503 when the settings are missing or unusable", async () => {
    const { fetcher } = certs([]);
    const broken: AccessEnv[] = [
      { ...ENV, ACCESS_AUD: "" },
      { ...ENV, ACCESS_TEAM_DOMAIN: undefined },
      { ...ENV, HUMANS: undefined },
      { ...ENV, HUMANS: "not json" },
      { ...ENV, HUMANS: "[]" },
      { ...ENV, HUMANS: JSON.stringify({ a: 1 }) },
    ];
    for (const env of broken) {
      const r = await verifyAccess(withJwt("a.b.c"), env, fetcher);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(503);
        expect(r.error).toBe("human_ui_not_configured");
      }
    }
  });
});
