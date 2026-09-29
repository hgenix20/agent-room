import { describe, expect, it } from "vitest";
import { admin, advance, get, joinOrch, joinSub, newIp, newTask, post, req, uid } from "./helpers";
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
    // the source is not blocked: a holder of a good credential on the same address still joins
    const again = await req(`/p/${P}/join`, { ip, body: { name: uid("ok"), model: "m", project_key: "test-key-genix", orchestrator_credential: "orch-cred-box" } });
    expect(again.status).toBe(200);
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
    expect(f.body.error).toBe("forged_ancestry");
    expect(f.body.rule).toBe(6);
  });

  it("rule 2: five tokenless calls in ten minutes slow the source, they do not block it", async () => {
    const ip = newIp();
    const tokens = ["garbage", "ar1.genix.a000000000000.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "", "Bearer", "ar1.genix.a111111111111.yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"];
    const statuses = [];
    let last: any;
    for (const t of tokens) {
      last = await req(`/p/${P}/sync`, { ip, token: t || undefined });
      statuses.push(last.status);
    }
    expect(statuses.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(statuses[4]).toBe(429);
    expect(last.body.rule).toBe(2);
    const ban = await banById(last.body.ban_id);
    expect(ban).toMatchObject({ rule: 2, ip });
    expect((await req(`/p/${P}/sync`, { ip })).status).toBe(429);
  });

  it("a token holder on a slowed address still works; the address recovers after ten minutes", async () => {
    const o = await joinOrch(P, uid("slowok"));
    for (let i = 0; i < 5; i++) await req(`/p/${P}/sync`, { ip: o.ip, token: "junk" });
    expect((await req(`/p/${P}/sync`, { ip: o.ip })).status).toBe(429);
    expect((await get(o, "sync")).status).toBe(200);
    expect((await post(o, "say", { text: "still here" })).status).toBe(200);
    await advance(P, 9 * 60_000);
    expect((await req(`/p/${P}/sync`, { ip: o.ip })).status).toBe(429);
    await advance(P, 2 * 60_000);
    expect((await req(`/p/${P}/sync`, { ip: o.ip })).status).toBe(401);
    expect((await get(o, "sync")).status).toBe(200);
  });

  it("rule 2 counts a revoked token, and slows rather than blocks", async () => {
    const o = await joinOrch(P, uid("r2rev"));
    const rv = await admin("/admin/revoke", { project: P, agent: o.name });
    expect(rv.status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await get(o, "sync")).status).toBe(401);
    const fifth = await get(o, "sync");
    expect(fifth.status).toBe(429);
    expect(fifth.body.rule).toBe(2);
  });

  it("a parent gone quiet takes its subagents' tokens with it; a join under it is refused without a block", async () => {
    const o = await joinOrch(P, uid("r4g"));
    const s = await joinSub(o, uid("r4gs"));
    await advance(P, 31 * 60_000);
    expect((await get(s, "sync")).status).toBe(401);
    const ip = newIp();
    const j = await req(`/p/${P}/join`, { ip, body: { name: uid("late"), model: "m", project_key: "test-key-genix", parent_token: o.token } });
    expect(j.status).toBe(403);
    expect(j.body.error).toBe("forged_ancestry");
    expect((await joinOrch(P, uid("after"), ip)).token).toBeTruthy();
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

  it("rule 5: flooding escalates per agent: warning, 15 minutes read-only, then revoked", async () => {
    const parent = await joinOrch(P, uid("floodp"));
    const a = await joinSub(parent, uid("flood"));
    const bystander = await joinSub(parent, uid("bystander"), a.ip); // shares the flooder's address
    const flood = async () => {
      // Post until the room pushes back. A minute boundary can fall mid-burst, so the count is not fixed.
      let last;
      for (let i = 0; i < 130; i++) {
        last = await post(a, "say", { text: `loop ${Math.random().toString(36).slice(2)}${i}` });
        if (last.status !== 200) break;
      }
      return last!;
    };
    // step 1: three flooded minutes, a warning to the agent and its parent, still writing
    for (let round = 0; round < 3; round++) {
      expect((await flood()).status).toBe(429);
      await advance(P, 61_000);
    }
    const warn = (await get(bystander, "sync", "?since=0&limit=500")).body.events.filter((e: any) => e.by === "moderator" && (e.mentions ?? []).includes(a.name));
    expect(warn.length).toBe(1);
    expect(warn[0].mentions).toEqual(expect.arrayContaining([a.name, parent.name]));
    expect((await post(a, "say", { text: "after warning" })).status).toBe(200);
    // step 2: three more, read-only for 15 minutes
    for (let round = 0; round < 3; round++) {
      const r = await flood();
      expect(r.status).toBe(round < 2 ? 429 : 403);
      if (round === 2) expect(r.body.error).toBe("read_only");
      await advance(P, 61_000);
    }
    const ro = await post(a, "say", { text: "nope" });
    expect(ro.status).toBe(403);
    expect(ro.body.error).toBe("read_only");
    expect((await get(a, "sync")).status).toBe(200);
    expect((await post(bystander, "say", { text: "unaffected" })).status).toBe(200);
    await advance(P, 15 * 60_000);
    expect((await post(a, "say", { text: "back" })).status).toBe(200);
    // step 3: three more, token revoked and a ban row with the rule
    let last: any;
    for (let round = 0; round < 3; round++) {
      last = await flood();
      await advance(P, 61_000);
    }
    expect(last.status).toBe(403);
    expect(last.body.rule).toBe(5);
    const ban = await banById(last.body.ban_id);
    expect(ban).toMatchObject({ rule: 5, agent_name: a.name, parent_name: parent.name });
    expect((await get(a, "sync")).status).toBe(401);
    // the address is not blocked: the bystander and the parent, same address, keep working
    expect((await get(bystander, "sync")).status).toBe(200);
    expect((await post(bystander, "say", { text: "still fine" })).status).toBe(200);
  }, 90_000);

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
  it("repeating itself: 5 near-identical messages warn, 5 more make it read-only, never revoked", async () => {
    const parent = await joinOrch(P, uid("reppar"));
    const a = await joinSub(parent, uid("rep"));
    const bystander = await joinSub(parent, uid("repby"), a.ip);
    // the room is shared between tests, so count only notices that name this agent
    const modMsgs = async () =>
      (await get(bystander, "sync", `?since=${a.cursor}&limit=500`)).body.events.filter((e: any) => e.by === "moderator" && (e.mentions ?? []).includes(a.name));
    const text = "Still waiting on the build to finish, will report back when it does";
    // four copies (the last with a small edit, still over 90% alike) and different chatter: nothing yet
    for (let i = 0; i < 3; i++) expect((await post(a, "say", { text })).status).toBe(200);
    expect((await post(a, "say", { text: text + "!" })).status).toBe(200);
    expect((await post(a, "say", { text: "Completely different: found the failing test in the parser module" })).status).toBe(200);
    expect(await modMsgs()).toHaveLength(0);
    // the fifth like it: warning to the agent and its parent, the message itself still lands
    expect((await post(a, "say", { text })).status).toBe(200);
    const warn = await modMsgs();
    expect(warn).toHaveLength(1);
    expect(warn[0].mentions).toEqual(expect.arrayContaining([a.name, parent.name]));
    expect((await post(a, "say", { text: "fine after the warning" })).status).toBe(200);
    // five more: read-only, after the fifth
    for (let i = 0; i < 4; i++) expect((await post(a, "say", { text })).status).toBe(200);
    expect(await modMsgs()).toHaveLength(1);
    expect((await post(a, "say", { text })).status).toBe(200);
    expect(await modMsgs()).toHaveLength(2);
    const ro = await post(a, "say", { text: "anything" });
    expect(ro.status).toBe(403);
    expect(ro.body.error).toBe("read_only");
    expect((await get(a, "sync")).status).toBe(200);
    expect((await post(bystander, "say", { text })).status).toBe(200);
    expect((await post(bystander, "say", { text: "unaffected" })).status).toBe(200);
    // after 15 minutes it writes again, and five more copies still do not revoke it
    await advance(P, 15 * 60_000 + 1000);
    for (let i = 0; i < 12; i++) expect((await post(a, "say", { text })).status).toBeOneOf([200, 403]);
    expect((await get(a, "sync")).status).toBe(200);
    const bans = (await admin("/admin/bans")).body.bans.filter((b: any) => b.agent_name === a.name);
    expect(bans).toHaveLength(0);
  }, 90_000);

  it("repeating itself: copies spread over more than ten minutes do not count", async () => {
    const a = await joinOrch(P, uid("repslow"));
    for (let i = 0; i < 8; i++) {
      expect((await post(a, "say", { text: "same old status line" })).status).toBe(200);
      await advance(P, 3 * 60_000);
    }
    const o = await joinOrch(P, uid("repwatch"));
    const ev = (await get(o, "sync", `?since=${a.cursor}&limit=500`)).body.events.filter((e: any) => e.by === "moderator");
    expect(ev.filter((e: any) => (e.mentions ?? []).includes(a.name))).toHaveLength(0);
  });

  it("secret leaks: the third refusal revokes the agent, the address and a neighbour are untouched", async () => {
    const parent = await joinOrch(P, uid("leakp"));
    const a = await joinSub(parent, uid("leak"));
    const bystander = await joinSub(parent, uid("leakby"), a.ip);
    const leaks = ["key AKIAIOSFODNN7EXAMPLE", "use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789"];
    expect((await post(a, "say", { text: leaks[0] })).status).toBe(422);
    expect((await post(a, "say", { text: leaks[1] })).status).toBe(422);
    expect((await get(a, "sync")).status).toBe(200);
    const r3 = await post(a, "say", { text: leaks[2] });
    expect(r3.status).toBe(403);
    expect(r3.body.rule).toBe(5);
    const ban = await banById(r3.body.ban_id);
    expect(ban).toMatchObject({ rule: 5, agent_name: a.name, parent_name: parent.name });
    expect(ban.detail).toContain("secret filter");
    const mod = await admin("/admin/moderation?since=0", undefined, "mind-test-token");
    expect(mod.body.messages.some((m: any) => m.ban_id === ban.id)).toBe(true);
    expect((await get(a, "sync")).status).toBe(401);
    expect(ban.blocked_until).toBeLessThanOrEqual(ban.at);
    expect((await get(bystander, "sync")).status).toBe(200);
    expect((await post(bystander, "say", { text: "still fine" })).status).toBe(200);
  });

});

describe("increment 3: claims, wrong project, ancestry, orphans", () => {
  const scopeClaim = (a: any, t: string, sc: string) => post(a, "claim", { task_id: t, scopes: [sc] });

  async function fighter() {
    const o = await joinOrch(P, uid("cf-o"));
    const holder = await joinSub(o, uid("cf-h"));
    const a = await joinSub(o, uid("cf-a"));
    const held = uid("held");
    expect((await scopeClaim(holder, await newTask(o, "held"), held)).status).toBe(200);
    return { o, a, held };
  }

  it("claim fighting: 9 refusals are fine, the 10th pauses claiming for 15 minutes, then it lifts", async () => {
    const { o, a, held } = await fighter();
    for (let i = 0; i < 9; i++) expect((await scopeClaim(a, await newTask(o, `f${i}`), held)).status).toBe(409);
    const t10 = await newTask(o, "ten");
    expect((await scopeClaim(a, t10, held)).status).toBe(409); // the 10th refusal itself
    const locked = await scopeClaim(a, await newTask(o, "free"), uid("free"));
    expect(locked.status).toBe(403);
    expect(locked.body.error).toBe("claim_locked");
    // everything else still works
    expect((await post(a, "say", { text: "still talking" })).status).toBe(200);
    expect((await get(a, "sync")).status).toBe(200);
    expect((await post(a, "heartbeat", { status_line: "waiting" })).status).toBe(200);
    // one minute short of 15: still locked
    await advance(P, 14 * 60_000);
    expect((await scopeClaim(a, await newTask(o, "free2"), uid("free"))).status).toBe(403);
    await advance(P, 61_000);
    expect((await scopeClaim(a, await newTask(o, "free3"), uid("free"))).status).toBe(200);
  });

  it("claim fighting: 9 refused claims leave claiming open, and the count is per agent", async () => {
    const { o, a, held } = await fighter();
    const other = await joinSub(o, uid("cf-b"));
    for (let i = 0; i < 9; i++) expect((await scopeClaim(a, await newTask(o, `g${i}`), held)).status).toBe(409);
    expect((await scopeClaim(a, await newTask(o, "ok"), uid("free"))).status).toBe(200);
    expect((await scopeClaim(other, await newTask(o, "ok2"), uid("free"))).status).toBe(200);
  });

  it("claim fighting: refusals older than ten minutes do not count", async () => {
    const { o, a, held } = await fighter();
    for (let i = 0; i < 9; i++) expect((await scopeClaim(a, await newTask(o, `h${i}`), held)).status).toBe(409);
    await advance(P, 11 * 60_000);
    expect((await scopeClaim(a, await newTask(o, "late"), held)).status).toBe(409); // holder's lease may have lapsed
    expect((await scopeClaim(a, await newTask(o, "free"), uid("free"))).status).toBe(200);
  });

  it("wrong project: the token is revoked with a ban row, a same-address neighbour keeps working", async () => {
    const o = await joinOrch(P, uid("wp-o"));
    const a = await joinSub(o, uid("wp-a"));
    const neighbour = await joinSub(o, uid("wp-n"), a.ip);
    const r = await req(`/p/other/sync`, { ip: a.ip, token: a.token });
    expect(r.status).toBe(403);
    expect(r.body.rule).toBe(3);
    const ban = await banById(r.body.ban_id);
    expect(ban).toMatchObject({ rule: 3, agent_name: a.name, project: "other" });
    expect(ban.blocked_until).toBeLessThanOrEqual(ban.at);
    expect((await req(`/p/${P}/sync`, { ip: newIp(), token: a.token })).status).toBe(401);
    expect((await get(neighbour, "sync")).status).toBe(200);
    expect((await post(neighbour, "say", { text: "unaffected" })).status).toBe(200);
    // and a fresh join from that address works
    expect((await joinSub(o, uid("wp-new"), a.ip)).token).toBeTruthy();
  });

  it("forged ancestry: a parent token that is not live is refused, the parent is told, the address is free", async () => {
    const o = await joinOrch(P, uid("fa-o"));
    const p = await joinSub(o, uid("fa-p"));
    const ip = newIp();
    const forged = p.token.slice(0, -4) + "AAAA";
    const r = await req(`/p/${P}/join`, { ip, body: { name: uid("fa-x"), model: "m", project_key: "test-key-genix", parent_token: forged } });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("forged_ancestry");
    const sync = await get(p, "sync", "?only=mentions");
    const told = sync.body.events.find((e: any) => e.kind === "say" && e.by === "moderator");
    expect(told.text).toContain(`@${p.name}`);
    expect(told.text).toContain("join was refused");
    // revoked parent: refused too
    await admin("/admin/revoke", { project: P, agent: p.name });
    const r2 = await req(`/p/${P}/join`, { ip, body: { name: uid("fa-y"), model: "m", project_key: "test-key-genix", parent_token: p.token } });
    expect(r2.status).toBe(403);
    expect(r2.body.error).toBe("forged_ancestry");
    // the address was never blocked
    expect((await joinOrch(P, uid("fa-fine"), ip)).token).toBeTruthy();
  });

  it("forged ancestry: a parent outside the joiner's own chain is refused", async () => {
    const mine = await joinOrch(P, uid("ch-o"));
    const theirs = await joinOrch(P, uid("ch-t"), newIp(), "orch-cred-laptop");
    const body = (parent: any) => ({ name: uid("ch-s"), model: "m", project_key: "test-key-genix", orchestrator_credential: "orch-cred-box", parent_token: parent.token });
    const bad = await req(`/p/${P}/join`, { ip: newIp(), body: body(theirs) });
    expect(bad.status).toBe(403);
    expect(bad.body.error).toBe("forged_ancestry");
    const good = await req(`/p/${P}/join`, { ip: newIp(), body: body(mine) });
    expect(good.status).toBe(200);
  });

  it("revoking a parent orphans its subagent: it can release but not claim, and claims again once adopted", async () => {
    const o = await joinOrch(P, uid("or-o"));
    const p = await joinSub(o, uid("or-p"));
    const kid = await joinSub(p, uid("or-k"));
    const t = await newTask(o, "held by kid");
    const c = await post(kid, "claim", { task_id: t, scopes: [uid("or")] });
    expect(c.status).toBe(200);
    const rv = await admin("/admin/revoke", { project: P, agent: p.name });
    expect(rv.body.revoked.orphans).toEqual([kid.name]);
    expect((await get(p, "sync")).status).toBe(401);
    // the orphan is still here and marked
    const sync = await get(kid, "sync");
    expect(sync.status).toBe(200);
    expect(sync.body.roster.find((r: any) => r.name === kid.name).orphaned).toBe(true);
    expect((await post(kid, "say", { text: "still here" })).status).toBe(200);
    expect((await post(kid, "heartbeat", {})).status).toBe(200);
    // no new claims
    const blocked = await post(kid, "claim", { task_id: await newTask(o, "new"), scopes: [uid("or2")] });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe("orphaned");
    // but it may release what it holds
    const rel = await post(kid, "release", { claim_id: c.body.claim_id, version: c.body.version, state: "done" });
    expect(rel.status).toBe(200);
    // a subagent cannot adopt; an orchestrator can
    const other = await joinSub(o, uid("or-s"));
    expect((await post(other, "adopt", { agent_id: kid.id })).status).toBe(403);
    expect((await post(o, "adopt", { agent_id: uid("nobody") })).status).toBe(404);
    const ad = await post(o, "adopt", { agent_id: kid.id });
    expect(ad.status).toBe(200);
    expect((await post(o, "adopt", { agent_id: kid.id })).body.error).toBe("not_orphaned");
    const again = await post(kid, "claim", { task_id: await newTask(o, "after"), scopes: [uid("or3")] });
    expect(again.status).toBe(200);
    const roster = (await get(kid, "sync")).body.roster.find((r: any) => r.name === kid.name);
    expect(roster.parent).toBe(o.name);
    expect(roster.orphaned).toBeUndefined();
  });

  it("a rule-revoked parent (wrong project) leaves its subagents orphaned, not banned", async () => {
    const o = await joinOrch(P, uid("ow-o"));
    const kid = await joinSub(o, uid("ow-k"));
    const r = await req(`/p/other/sync`, { ip: newIp(), token: o.token });
    expect(r.body.rule).toBe(3);
    expect((await banById(r.body.ban_id)).detail).toContain(kid.name);
    expect((await get(kid, "sync")).status).toBe(200);
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
