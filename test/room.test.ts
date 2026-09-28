import { describe, expect, it } from "vitest";
import { advance, get, joinOrch, joinSub, newIp, newTask, post, req, uid } from "./helpers";

const P = "genix";

describe("join and roster", () => {
  it("orchestrator and subagent join; roster reads as a tree", async () => {
    const o = await joinOrch(P, uid("orch"));
    expect(o.token).toMatch(/^ar1\.genix\.a[0-9a-f]{12}\./);
    const s = await joinSub(o, uid("sub"));
    const r = await get(o, "sync", `?since=${o.cursor - 1}`);
    expect(r.status).toBe(200);
    const sub = r.body.roster.find((x: any) => x.name === s.name);
    expect(sub.parent).toBe(o.name);
    expect(r.body.events.some((e: any) => e.kind === "join" && e.name === s.name && e.parent === o.name)).toBe(true);
  });

  it("adds a suffix when a live agent holds the name", async () => {
    const name = uid("dup");
    const a = await joinOrch(P, name);
    const b = await joinOrch(P, name);
    expect(a.name).toBe(name);
    expect(b.name).toBe(`${name}-2`);
  });

  it("wrong project key is refused without a ban", async () => {
    const r = await req(`/p/${P}/join`, { ip: newIp(), body: { name: "x", model: "m", project_key: "nope", orchestrator_credential: "orch-cred-box" } });
    expect(r.status).toBe(401);
  });
});

describe("claims", () => {
  it("two agents racing for the same task: exactly one wins", async () => {
    const a = await joinOrch(P, uid("race-a"));
    const b = await joinOrch(P, uid("race-b"));
    const t = await newTask(a, "auth middleware");
    await post(b, "heartbeat", { status_line: "reading the auth code" });
    const [ra, rb] = await Promise.all([
      post(a, "claim", { task_id: t, scopes: ["src/auth/*"] }),
      post(b, "claim", { task_id: t, scopes: ["src/auth/*"] }),
    ]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = ra.status === 409 ? ra : rb;
    const winnerName = ra.status === 200 ? a.name : b.name;
    expect(loser.body.holder).toBe(winnerName);
    expect(loser.body).toHaveProperty("status_line");
  });

  it("racing for overlapping scopes on different tasks: exactly one wins", async () => {
    const a = await joinOrch(P, uid("ov-a"));
    const b = await joinOrch(P, uid("ov-b"));
    const dir = uid("pkg");
    const t1 = await newTask(a, "one");
    const t2 = await newTask(a, "two");
    const res = await Promise.all([
      post(a, "claim", { task_id: t1, scopes: [`${dir}/**`] }),
      post(b, "claim", { task_id: t2, scopes: [`${dir}/api/user.ts`] }),
    ]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = res.find((r) => r.status === 409)!;
    expect(loser.body.reason).toBe("scope overlap");
  });

  it("disjoint scopes and named areas do not conflict; same named area does", async () => {
    const a = await joinOrch(P, uid("dj-a"));
    const b = await joinOrch(P, uid("dj-b"));
    const area = uid("db-schema");
    const [t1, t2, t3] = [await newTask(a, "1"), await newTask(a, "2"), await newTask(a, "3")];
    expect((await post(a, "claim", { task_id: t1, scopes: [`${area}`, "web/a/*"] })).status).toBe(200);
    expect((await post(b, "claim", { task_id: t2, scopes: ["web/b/*"] })).status).toBe(200);
    expect((await post(b, "claim", { task_id: t3, scopes: [area] })).status).toBe(409);
  });

  it("a stale claim cannot be released; a wrong version cannot release a live one", async () => {
    const a = await joinOrch(P, uid("st-a"));
    const b = await joinOrch(P, uid("st-b"));
    const t = await newTask(a, "stale test");
    const ca = await post(a, "claim", { task_id: t, scopes: [uid("stale") + "/*"] });
    expect(ca.status).toBe(200);
    // wrong version on a live claim
    const wrong = await post(a, "release", { claim_id: ca.body.claim_id, version: ca.body.version + 1000, state: "done" });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error).toBe("stale_version");
    // a goes quiet past the lease; b takes the task
    await advance(P, 21 * 60_000);
    await post(b, "heartbeat", { status_line: "back" });
    const cb = await post(b, "claim", { task_id: t, scopes: ["x/*"] });
    expect(cb.status).toBe(200);
    expect(cb.body.version).not.toBe(ca.body.version);
    // a comes back and tries to release its old claim
    const old = await post(a, "release", { claim_id: ca.body.claim_id, version: ca.body.version, state: "done" });
    expect(old.status).toBe(409);
    expect(old.body.error).toBe("claim_not_live");
    // or b's claim, quoting b's version
    const steal = await post(a, "release", { claim_id: cb.body.claim_id, version: cb.body.version, state: "done" });
    expect(steal.status).toBe(403);
    const board = await get(b, "board");
    const task = board.body.tasks.find((x: any) => x.id === t);
    expect(task.state).toBe("claimed");
    expect(task.owner).toBe(b.name);
    // b releases properly
    const ok = await post(b, "release", { claim_id: cb.body.claim_id, version: cb.body.version, state: "done", commit: "abc1234", branch: "b/stale" });
    expect(ok.status).toBe(200);
    const after = (await get(b, "board")).body.tasks.find((x: any) => x.id === t);
    expect(after).toMatchObject({ state: "done", commit: "abc1234", branch: "b/stale", owner: b.name });
  });

  it("lease expiry: heartbeats renew, silence expires, expiry reopens the task", async () => {
    const a = await joinOrch(P, uid("le-a"));
    const t = await newTask(a, "lease test");
    const c = await post(a, "claim", { task_id: t, scopes: [uid("lease") + "/*"] });
    expect(c.body.lease_s).toBe(1200);
    await advance(P, 15 * 60_000);
    const hb = await post(a, "heartbeat", { status_line: "still on it" });
    expect(hb.body.renewed.map((x: any) => x.claim_id)).toContain(c.body.claim_id);
    await advance(P, 15 * 60_000); // 30 minutes since claim, 15 since heartbeat
    let sync = await get(a, "sync", "?since=0&limit=1");
    expect(sync.body.claims.some((x: any) => x.claim_id === c.body.claim_id)).toBe(true);
    await advance(P, 21 * 60_000); // silence past the lease
    // any call sweeps; the claim is gone and the task is open again
    const other = await joinOrch(P, uid("le-b"));
    sync = await get(other, "sync", `?task=${t}`);
    expect(sync.body.claims.some((x: any) => x.claim_id === c.body.claim_id)).toBe(false);
    expect(sync.body.events.some((e: any) => e.kind === "claim_expired" && e.claim_id === c.body.claim_id)).toBe(true);
    const task = (await get(other, "board")).body.tasks.find((x: any) => x.id === t);
    expect(task.state).toBe("open");
  });

  it("a heartbeat after expiry does not revive the claim", async () => {
    const a = await joinOrch(P, uid("rv-a"));
    const t = await newTask(a, "revive test");
    const c = await post(a, "claim", { task_id: t, scopes: [], lease: 120 });
    expect(c.body.lease_s).toBe(120);
    await advance(P, 3 * 60_000);
    const hb = await post(a, "heartbeat", { status_line: "hello again" });
    expect(hb.status).toBe(200);
    expect(hb.body.renewed).toEqual([]);
  });

  it("long leases up to two hours; a short heartbeat does not shorten one", async () => {
    const a = await joinOrch(P, uid("ll-a"));
    const t = await newTask(a, "long step");
    expect((await post(a, "claim", { task_id: t, lease: 7201 })).status).toBe(400);
    const c = await post(a, "claim", { task_id: t, lease: 7200 });
    expect(c.status).toBe(200);
    const hb = await post(a, "heartbeat", { lease: 60 }); // a short renewal never pulls expiry in
    expect(hb.body.renewed[0].expires_at).toBe(c.body.expires_at);
    await advance(P, 110 * 60_000);
    const hb2 = await post(a, "heartbeat", { lease: 7200 });
    expect(hb2.body.renewed[0].claim_id).toBe(c.body.claim_id);
  });

  it("release all (the hook path) marks every held task blocked", async () => {
    const a = await joinOrch(P, uid("ra-a"));
    const t1 = await newTask(a, "r1");
    const t2 = await newTask(a, "r2");
    await post(a, "claim", { task_id: t1, scopes: [uid("r1")] });
    await post(a, "claim", { task_id: t2, scopes: [uid("r2")] });
    const r = await post(a, "release", { all: true });
    expect(r.status).toBe(200);
    expect(r.body.released.map((x: any) => x.task_id).sort()).toEqual([t1, t2].sort());
    const tasks = (await get(a, "board")).body.tasks.filter((x: any) => x.id === t1 || x.id === t2);
    expect(tasks.every((x: any) => x.state === "blocked")).toBe(true);
  });

  it("leave releases claims and drops the agent; its subagents' tokens go with it", async () => {
    const o = await joinOrch(P, uid("lv-o"));
    const s = await joinSub(o, uid("lv-s"));
    const t = await newTask(o, "leave");
    await post(o, "claim", { task_id: t, scopes: [uid("lv")] });
    expect((await post(o, "leave")).status).toBe(200);
    expect((await get(o, "sync")).status).toBe(401);
    expect((await get(s, "sync")).status).toBe(401);
  });
});

describe("idempotency", () => {
  it("say with the same key twice posts once", async () => {
    const a = await joinOrch(P, uid("id-a"));
    const key = uid("k");
    const r1 = await post(a, "say", { text: "changing User type", key });
    const r2 = await post(a, "say", { text: "changing User type", key });
    expect(r1.status).toBe(200);
    expect(r2.body.seq).toBe(r1.body.seq);
    expect(r2.body.replayed).toBe(true);
    const s = await get(a, "sync", `?since=${a.cursor}`);
    expect(s.body.events.filter((e: any) => e.kind === "say").length).toBe(1);
  });

  it("claim and task retries return the first result", async () => {
    const a = await joinOrch(P, uid("id-b"));
    const k1 = uid("k");
    const t1 = await post(a, "task", { title: "idem task", key: k1 });
    const t2 = await post(a, "task", { title: "idem task", key: k1 });
    expect(t2.body.task_id).toBe(t1.body.task_id);
    const k2 = uid("k");
    const c1 = await post(a, "claim", { task_id: t1.body.task_id, key: k2 });
    const c2 = await post(a, "claim", { task_id: t1.body.task_id, key: k2 });
    expect(c2.body.claim_id).toBe(c1.body.claim_id);
    expect(c2.body.version).toBe(c1.body.version);
  });

  it("a retried join returns the same agent with a fresh token; the lost one stops working", async () => {
    const ip = newIp();
    const key = uid("jk");
    const body = { name: uid("jr"), model: "m", project_key: "test-key-genix", orchestrator_credential: "orch-cred-box", key };
    const j1 = await req(`/p/${P}/join`, { ip, body });
    const j2 = await req(`/p/${P}/join`, { ip, body });
    expect(j2.body.agent_id).toBe(j1.body.agent_id);
    expect(j2.body.token).not.toBe(j1.body.token);
    expect((await req(`/p/${P}/sync`, { ip, token: j2.body.token })).status).toBe(200);
    expect((await req(`/p/${P}/sync`, { ip, token: j1.body.token })).status).toBe(401);
  });
});

describe("sync", () => {
  it("pages 100 at a time and the cursor walks the whole log", async () => {
    const a = await joinOrch(P, uid("pg-a"));
    const start = a.cursor;
    for (let i = 0; i < 130; i++) {
      if (i > 0 && i % 55 === 0) await advance(P, 61_000); // stay under 60 writes a minute
      const r = await post(a, "say", { text: `message ${i}` });
      expect(r.status).toBe(200);
    }
    const p1 = await get(a, "sync", `?since=${start}`);
    expect(p1.body.events.length).toBe(100);
    expect(p1.body.more).toBe(true);
    const p2 = await get(a, "sync", `?since=${p1.body.cursor}`);
    expect(p2.body.more).toBe(false);
    const texts = [...p1.body.events, ...p2.body.events].filter((e: any) => e.kind === "say").map((e: any) => e.text);
    expect(texts.length).toBe(130);
    expect(texts[0]).toBe("message 0");
    expect(texts[129]).toBe("message 129");
    const small = await get(a, "sync", `?since=${start}&limit=10`);
    expect(small.body.events.length).toBe(10);
    const empty = await get(a, "sync", `?since=${p2.body.cursor}`);
    expect(empty.body.events).toEqual([]);
    expect(empty.body.cursor).toBe(p2.body.cursor);
  });

  it("task filter and mentions filter", async () => {
    const a = await joinOrch(P, uid("fa"));
    const b = await joinOrch(P, uid("fb"));
    const c = await joinOrch(P, uid("fc"));
    const ta = await newTask(a, "filter A");
    const tb = await newTask(b, "filter B");
    await post(a, "claim", { task_id: ta, scopes: [uid("fa")] });
    await post(b, "claim", { task_id: tb, scopes: [uid("fb")] });
    const since = (await get(c, "sync", "?since=999999999")).body.cursor;
    const m1 = await post(a, "say", { text: "on task A, nobody named" });
    const m2 = await post(b, "say", { text: `@${c.name} does this break the signup form?` });
    const m3 = await post(a, "say", { text: `@${b.name} fine on my side` });
    const m4 = await post(b, "say", { text: "reply to c's thread", reply_to: m2.body.seq });
    const cmsg = await post(c, "say", { text: "question from c" });
    const m5 = await post(a, "say", { text: "answering c", reply_to: cmsg.body.seq });
    expect(m1.body.task).toBe(ta);
    expect(m2.body.task).toBe(tb);

    const byTask = await get(c, "sync", `?since=${since}&task=${ta}`);
    const taskSeqs = byTask.body.events.map((e: any) => e.seq);
    expect(taskSeqs).toContain(m1.body.seq);
    expect(taskSeqs).toContain(m3.body.seq);
    expect(taskSeqs).not.toContain(m2.body.seq);
    expect(byTask.body.events.every((e: any) => e.kind !== "say" || e.by.endsWith(`/${ta}`))).toBe(true);

    const mentions = await get(c, "sync", `?since=${since}&only=mentions`);
    const mSeqs = mentions.body.events.map((e: any) => e.seq);
    expect(mSeqs).toEqual([m2.body.seq, m5.body.seq]);
    expect(mentions.body.events[0].by).toBe(`${b.name}/${tb}`);

    const both = await get(c, "sync", `?since=${since}&only=mentions&task=${ta}`);
    const bothSeqs = both.body.events.map((e: any) => e.seq);
    expect(bothSeqs).toEqual(expect.arrayContaining([m1.body.seq, m2.body.seq, m3.body.seq, m5.body.seq]));
    expect(bothSeqs).not.toContain(m4.body.seq);
    // a filtered sync still moves the cursor to the head
    expect(mentions.body.cursor).toBeGreaterThanOrEqual(m5.body.seq);
  });

  it("messages up to 5000 characters", async () => {
    const a = await joinOrch(P, uid("len"));
    const words = "the signup form reads the user email field only ";
    const long = words.repeat(200).slice(0, 5000);
    expect((await post(a, "say", { text: long })).status).toBe(200);
    expect((await post(a, "say", { text: long + "x" })).status).toBe(400);
  });

  it("GET for reads and POST for writes", async () => {
    const a = await joinOrch(P, uid("mth"));
    expect((await post(a, "sync", {})).status).toBe(405);
    expect((await get(a, "say")).status).toBe(405);
  });
});
