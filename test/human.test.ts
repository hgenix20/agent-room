import { describe, expect, it } from "vitest";
import { accessJwt, human } from "./access-helpers";
import { admin, advance, get, joinOrch, newIp, newTask, post, req, uid } from "./helpers";

const P = "genix";

async function myName(project = P, email?: string): Promise<string> {
  return (await human(`/h/${project}/me`, { email })).body.name;
}

describe("human API: access", () => {
  it("lists project names and never their keys", async () => {
    const r = await human("/h/projects");
    expect(r.status).toBe(200);
    expect(r.body.projects).toEqual(["genix", "other"]);
    expect(JSON.stringify(r.body)).not.toContain("test-key");
  });

  it("refuses a call with no Access header, a stranger, and an unknown project or call", async () => {
    expect((await human(`/h/${P}/board`, { jwt: null })).status).toBe(403);
    expect((await human(`/h/${P}/board`, { jwt: await accessJwt("stranger@example.com") })).status).toBe(403);
    expect((await human("/h/nope/board")).status).toBe(404);
    expect((await human(`/h/${P}/adopt`, { body: {} })).status).toBe(404);
    expect((await human(`/h/${P}/say`)).status).toBe(405);
  });

  it("refuses a POST without the worker's own Origin, and writes nothing", async () => {
    const text = uid("csrf");
    for (const origin of [null, "https://evil.test"]) {
      const r = await human(`/h/${P}/say`, { body: { text }, origin });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe("bad_origin");
    }
    const a = await joinOrch(P, uid("csrf-a"));
    const all = await get(a, "sync", "?before=999999999&limit=50");
    expect(all.body.events.some((e: any) => e.text === text)).toBe(false);
  });
});

describe("people in the room", () => {
  it("the first call puts the person on the roster once, named from the email", async () => {
    const first = await human(`/h/${P}/me`);
    expect(first.status).toBe(200);
    expect(first.body.kind).toBe("human");
    expect(first.body.email).toBe("kameron@example.com");
    expect(first.body.name).toMatch(/^kameron/);
    expect(await myName()).toBe(first.body.name);
    const a = await joinOrch(P, uid("seer"));
    const roster = (await get(a, "sync", "?since=999999999")).body.roster;
    const mine = roster.filter((r: any) => r.kind === "human" && r.name === first.body.name);
    expect(mine.length).toBe(1);
    expect(mine[0].model).toBe("human");
  });

  it("an email with characters outside the name rule still gives a valid name", async () => {
    const dotted = await myName("other", "k.green+room@example.com");
    expect(dotted).toMatch(/^k\.greenroom/);
    const symbols = await myName("other", "+++@example.com");
    expect(symbols).toMatch(/^human/);
  });

  it("a person's message reaches an agent's sync", async () => {
    const a = await joinOrch(P, uid("reader"));
    const me = await myName();
    const said = await human(`/h/${P}/say`, { body: { text: `@${a.name} T8 looks low` } });
    expect(said.status).toBe(200);
    const r = await get(a, "sync", `?since=${a.cursor}&only=mentions`);
    const ev = r.body.events.find((e: any) => e.kind === "say" && e.seq === said.body.seq);
    expect(ev.by).toBe(me);
    expect(ev.mentions).toContain(a.name);
  });

  it("a person adds a task with estimates and may update any task", async () => {
    const a = await joinOrch(P, uid("owner"));
    const b = await joinOrch(P, uid("other"));
    const theirs = await newTask(a, "agent's task");
    const mine = await human(`/h/${P}/task`, { body: { title: "rate limit tests", priority: "high", estimate_minutes: 45, estimate_tokens: 60000 } });
    expect(mine.status).toBe(200);
    expect((await human(`/h/${P}/task_update`, { body: { task_id: theirs, priority: "urgent" } })).status).toBe(200);
    expect((await post(b, "task_update", { task_id: theirs, priority: "low" })).status).toBe(403);
    const board = (await human(`/h/${P}/board`)).body.tasks;
    expect(board.find((t: any) => t.id === theirs).priority).toBe("urgent");
    expect(board.find((t: any) => t.id === mine.body.task_id).estimate_tokens).toBe(60000);
  });

  it("a person outlives the 30 minutes that end an agent, and shows as away in between", async () => {
    const mortal = await joinOrch(P, uid("mortal"));
    const me = await myName();
    await advance(P, 31 * 60_000);
    expect((await get(mortal, "board")).status).toBe(401);
    const fresh = await joinOrch(P, uid("fresh"));
    const entry = (r: any) => r.body.roster.find((x: any) => x.name === me);
    expect(entry(await get(fresh, "sync", "?since=999999999")).state).toBe("stale");
    expect((await human(`/h/${P}/board`)).status).toBe(200);
    expect(entry(await get(fresh, "sync", "?since=999999999")).state).toBe("active");
  });

  it("a person's row cannot be used through the agent API", async () => {
    const id = (await human(`/h/${P}/whoami`)).body.agent_id;
    const r = await req(`/p/${P}/board`, { ip: newIp(), token: `ar1.${P}.${id}.${"x".repeat(40)}` });
    expect(r.status).toBe(401);
  });

  it("nick renames, and refuses a taken or malformed name", async () => {
    const before = await myName();
    const a = await joinOrch(P, uid("taken"));
    const fresh = uid("kam");
    const ok = await human(`/h/${P}/nick`, { body: { name: fresh } });
    expect(ok.status).toBe(200);
    expect(await myName()).toBe(fresh);
    expect((await human(`/h/${P}/nick`, { body: { name: a.name } })).status).toBe(409);
    expect((await human(`/h/${P}/nick`, { body: { name: "has space" } })).status).toBe(400);
    expect((await human(`/h/${P}/nick`, { body: { name: "moderator" } })).status).toBe(409);
    const ev = (await get(a, "sync", `?since=${a.cursor}`)).body.events.find((e: any) => e.kind === "roster" && e.state === "renamed");
    expect(ev.name).toBe(fresh);
    expect(ev.was).toBe(before);
    expect((await human(`/h/${P}/nick`, { body: { name: before } })).status).toBe(200);
  });

  it("leave releases the person's claims and marks them away; the next call brings them back", async () => {
    const a = await joinOrch(P, uid("watch"));
    const me = await myName();
    const t = (await human(`/h/${P}/task`, { body: { title: "mine for now" } })).body.task_id;
    expect((await human(`/h/${P}/claim`, { body: { task_id: t, scopes: [uid("hum")] } })).status).toBe(200);
    const left = await human(`/h/${P}/leave`, { body: {} });
    expect(left.status).toBe(200);
    expect(left.body.released.length).toBe(1);
    const s = await get(a, "sync", "?since=999999999");
    expect(s.body.roster.find((x: any) => x.name === me).state).toBe("stale");
    expect((await get(a, "board")).body.tasks.find((x: any) => x.id === t).state).toBe("blocked");
    await human(`/h/${P}/board`);
    expect((await get(a, "sync", "?since=999999999")).body.roster.find((x: any) => x.name === me).state).toBe("active");
  });

  it("refused secrets never ban a person", async () => {
    for (let i = 0; i < 4; i++) {
      const r = await human(`/h/${P}/say`, { body: { text: `key AKIAABCDEFGHIJKLMNOP ${i}` } });
      expect(r.status).toBe(422);
    }
    expect((await human(`/h/${P}/say`, { body: { text: uid("still here") } })).status).toBe(200);
  });

  it("an admin revoke does not lock a person out", async () => {
    const me = await myName();
    await admin("/admin/revoke", { project: P, agent: me });
    expect((await human(`/h/${P}/say`, { body: { text: uid("after revoke") } })).status).toBe(200);
  });
});

describe("sync backwards", () => {
  it("before returns the newest events below a seq, oldest first", async () => {
    const a = await joinOrch(P, uid("back"));
    const texts = [uid("m1"), uid("m2"), uid("m3")];
    let last = 0;
    for (const text of texts) last = (await post(a, "say", { text })).body.seq;
    const r = await get(a, "sync", `?before=${last + 1}&limit=2`);
    expect(r.status).toBe(200);
    expect(r.body.events.map((e: any) => e.text)).toEqual([texts[1], texts[2]]);
    expect(r.body.more).toBe(true);
    expect(r.body.cursor).toBeGreaterThanOrEqual(last);
  });
});
