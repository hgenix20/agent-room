import { describe, expect, it } from "vitest";
import { admin, advance, get, joinOrch, joinSub, newIp, post, req, uid } from "./helpers";
import { secretReason, scopesOverlap } from "../src/lib";

const P = "genix";

async function banById(id: number) {
  const r = await admin("/admin/bans");
  expect(r.status).toBe(200);
  return r.body.bans.find((b: any) => b.id === id);
}

describe("ban rules", () => {
  it("rule 1: project key without an orchestrator credential or parent token", async () => {
    const ip = newIp();
    const r = await req(`/p/${P}/join`, { ip, body: { name: "intruder", model: "m", project_key: "test-key-genix" } });
    expect(r.status).toBe(403);
    expect(r.body.rule).toBe(1);
    const ban = await banById(r.body.ban_id);
    expect(ban).toMatchObject({ rule: 1, ip, agent_name: "intruder", project: P });
    // the source is blocked for 24 hours, even with a good credential
    const again = await req(`/p/${P}/join`, { ip, body: { name: "x", model: "m", project_key: "test-key-genix", orchestrator_credential: "orch-cred-box" } });
    expect(again.status).toBe(403);
    expect(again.body.error).toBe("blocked");
    // the moderation channel carries the notice, recommending key rotation
    const mod = await admin("/admin/moderation?since=0", undefined, "mind-test-token");
    const note = mod.body.messages.find((m: any) => m.ban_id === ban.id);
    expect(note.text).toContain("rule 1");
    expect(note.text).toContain("rotating the project key");
  });

  it("rule 1: a wrong orchestrator credential or a forged parent token", async () => {
    const bad = await req(`/p/${P}/join`, { ip: newIp(), body: { name: "x", model: "m", project_key: "test-key-genix", orchestrator_credential: "guess" } });
    expect(bad.body.rule).toBe(1);
    const o = await joinOrch(P, uid("r1o"));
    const forged = o.token.slice(0, -4) + "AAAA";
    const f = await req(`/p/${P}/join`, { ip: newIp(), body: { name: "y", model: "m", project_key: "test-key-genix", parent_token: forged } });
    expect(f.status).toBe(403);
    expect(f.body.rule).toBe(1);
  });

  it("rule 2: five bad-token calls in ten minutes from one source", async () => {
    const ip = newIp();
    const tokens = ["garbage", "ar1.genix.a000000000000.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "", "Bearer", "ar1.genix.a111111111111.yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"];
    const statuses = [];
    for (const t of tokens) statuses.push((await req(`/p/${P}/sync`, { ip, token: t || undefined })).status);
    expect(statuses.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(statuses[4]).toBe(403);
    const last = await req(`/p/${P}/sync`, { ip });
    expect(last.body.error).toBe("blocked");
  });

  it("rule 2 counts a revoked token", async () => {
    const o = await joinOrch(P, uid("r2rev"));
    const rv = await admin("/admin/revoke", { project: P, agent: o.name });
    expect(rv.status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await get(o, "sync")).status).toBe(401);
    const fifth = await get(o, "sync");
    expect(fifth.status).toBe(403);
    expect(fifth.body.rule).toBe(2);
  });

  it("rule 3: a token used against another project", async () => {
    const o = await joinOrch(P, uid("r3"));
    const s = await joinSub(o, uid("r3s"), newIp());
    const r = await req(`/p/other/sync`, { ip: o.ip, token: o.token });
    expect(r.status).toBe(403);
    expect(r.body.rule).toBe(3);
    const ban = await banById(r.body.ban_id);
    expect(ban).toMatchObject({ rule: 3, agent_name: o.name, project: "other" });
    expect(ban.descendants).toContain(s.name);
    // revoked at home too, and its subagent with it (checked from clean sources)
    expect((await req(`/p/${P}/sync`, { ip: newIp(), token: o.token })).status).toBe(401);
    expect((await get(s, "sync")).status).toBe(401);
  });

  it("rule 4: joining under a banned parent", async () => {
    const o = await joinOrch(P, uid("r4"));
    await req(`/p/other/board`, { ip: o.ip, token: o.token }); // rule 3 bans the parent
    const ip = newIp();
    const r = await req(`/p/${P}/join`, { ip, body: { name: uid("r4s"), model: "m", project_key: "test-key-genix", parent_token: o.token } });
    expect(r.status).toBe(403);
    expect(r.body.rule).toBe(4);
    expect((await banById(r.body.ban_id)).parent_name).toBe(o.name);
  });

  it("rule 4: a parent gone quiet takes its subagents' tokens with it; a join under it is refused", async () => {
    const o = await joinOrch(P, uid("r4g"));
    const s = await joinSub(o, uid("r4gs"));
    await advance(P, 31 * 60_000);
    expect((await get(s, "sync")).status).toBe(401);
    const j = await req(`/p/${P}/join`, { ip: newIp(), body: { name: uid("late"), model: "m", project_key: "test-key-genix", parent_token: o.token } });
    expect(j.status).toBe(401);
    expect(j.body.error).toBe("parent_gone");
  });

  it("a working subagent keeps its quiet orchestrator alive", async () => {
    const o = await joinOrch(P, uid("keep"));
    const s = await joinSub(o, uid("keeps"));
    for (let i = 0; i < 4; i++) {
      await advance(P, 10 * 60_000);
      expect((await post(s, "heartbeat", { status_line: `step ${i}` })).status).toBe(200);
    }
    expect((await get(o, "sync")).status).toBe(200);
  });

  it("rule 5: rate limit exceeded in three separate minutes within an hour", async () => {
    const a = await joinOrch(P, uid("r5r"));
    for (let round = 0; round < 3; round++) {
      let last;
      for (let i = 0; i < 61; i++) last = await post(a, "say", { text: `loop ${round} ${i}` });
      if (round < 2) {
        expect(last!.status).toBe(429);
        await advance(P, 61_000);
      } else {
        expect(last!.status).toBe(403);
        expect(last!.body.rule).toBe(5);
      }
    }
    expect((await req(`/p/${P}/sync`, { ip: newIp(), token: a.token })).status).toBe(401);
  });

  it("rule 5: three messages refused by the secret filter", async () => {
    const a = await joinOrch(P, uid("r5s"));
    const leaks = [
      "here is the key AKIAIOSFODNN7EXAMPLE",
      "use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123",
      "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    ];
    const r1 = await post(a, "say", { text: leaks[0] });
    expect(r1.status).toBe(422);
    expect(r1.body.error).toBe("secret_refused");
    expect((await post(a, "say", { text: leaks[1] })).status).toBe(422);
    const r3 = await post(a, "say", { text: leaks[2] });
    expect(r3.status).toBe(403);
    expect(r3.body.rule).toBe(5);
    // the refused text never reached the room
    const o = await joinOrch(P, uid("r5watch"));
    const s = await get(o, "sync", "?since=0&limit=500");
    expect(JSON.stringify(s.body)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});

describe("admin", () => {
  it("admin endpoints refuse agent tokens and the mind token outside the moderation channel", async () => {
    const o = await joinOrch(P, uid("adm"));
    expect((await admin("/admin/bans", undefined, o.token)).status).toBe(401);
    expect((await admin("/admin/bans", undefined, "mind-test-token")).status).toBe(401);
    expect((await admin("/admin/moderation", undefined, o.token)).status).toBe(401);
  });

  it("unban lifts the block and records the reversal", async () => {
    const ip = newIp();
    const r = await req(`/p/${P}/join`, { ip, body: { name: "oops", model: "m", project_key: "test-key-genix" } });
    const u = await admin("/admin/unban", { ban_id: r.body.ban_id, note: "false positive" });
    expect(u.status).toBe(200);
    const ok = await req(`/p/${P}/join`, { ip, body: { name: uid("fine"), model: "m", project_key: "test-key-genix", orchestrator_credential: "orch-cred-box" } });
    expect(ok.status).toBe(200);
    const ban = await banById(r.body.ban_id);
    expect(ban.unbanned_at).toBeTruthy();
    expect(ban.unban_note).toBe("false positive");
  });
});

describe("secret filter", () => {
  it("refuses keys and tokens", () => {
    for (const s of [
      "-----BEGIN RSA PRIVATE KEY-----",
      "AKIAIOSFODNN7EXAMPLE",
      "sk-proj-abcdefghijklmnopqrstuvwxyz012345",
      "sk-ant-api03-AbCdEf0123456789xyzXYZ",
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
      "xoxb-123456789012-abcdefghijkl",
      "AIzaSyA1234567890abcdefghijklmnopqrstuv",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "ar1.genix.a0123456789ab.AbCdEfGhIjKlMnOpQrStUvWxYz012345",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
      "k=Zx9Qm2Lp7Rt4Vw8Yb3Nc6Hd1Jf5Gs0Ka",
    ]) {
      expect(secretReason(s), s).not.toBeNull();
    }
  });

  it("passes ordinary build talk", () => {
    for (const s of [
      "done: branch agent/t7 commit 3f9a2c1d4e5b6a7f8091a2b3c4d5e6f708192a3b",
      "claim id 0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0",
      "changing src/auth/middleware/verifyToken.ts and src/auth/session.ts",
      "@sub-a2 does the User type change break the signup form?",
      'curl -H "Authorization: Bearer $ROOM_TOKEN" $ROOM/p/genix/sync',
      "const token = crypto.randomUUID();",
      "task-scoped messages and the sync filter are in; see T12",
    ]) {
      expect(secretReason(s), s).toBeNull();
    }
  });
});

describe("scope overlap", () => {
  it("decides overlap conservatively", () => {
    expect(scopesOverlap("src/auth/*", "src/auth/session.ts")).toBe(true);
    expect(scopesOverlap("src/**", "src/auth/*")).toBe(true);
    expect(scopesOverlap("src", "src/auth/session.ts")).toBe(true);
    expect(scopesOverlap("src/auth/*", "src/api/*")).toBe(false);
    expect(scopesOverlap("db-schema", "db-schema")).toBe(true);
    expect(scopesOverlap("db-schema", "api-contract")).toBe(false);
    expect(scopesOverlap("src/a.ts", "src/ab.ts")).toBe(false);
  });
});
