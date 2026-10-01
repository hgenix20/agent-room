import { env as rawEnv, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { closeSockets, human, openSocket, until } from "./access-helpers";
import { advance, get, joinOrch, newTask, post, uid } from "./helpers";

const P = "genix";

async function socketCount(project: string, tag?: string): Promise<number> {
  const stub = (rawEnv as any).ROOM.get((rawEnv as any).ROOM.idFromName(project));
  return (runInDurableObject as any)(stub, async (_room: any, state: DurableObjectState) =>
    state.getWebSockets(tag).filter((ws: WebSocket) => ws.readyState === 1).length,
  );
}

afterEach(async () => {
  await closeSockets(P);
  await closeSockets("other");
});

describe("room socket", () => {
  it("says hello with the room's newest seq", async () => {
    const a = await joinOrch(P, uid("ws-a"));
    const s = await openSocket(P);
    expect(s.status).toBe(101);
    await until(() => s.msgs.length > 0);
    expect(s.msgs[0].type).toBe("hello");
    const head = (await get(a, "sync", "?since=999999999")).body.cursor;
    expect(s.msgs[0].cursor).toBe(head);
  });

  it("delivers each committed event once, in order, in the shape sync returns", async () => {
    const a = await joinOrch(P, uid("ws-b"));
    const s = await openSocket(P);
    await until(() => s.msgs.length > 0);
    const texts = [uid("one"), uid("two")];
    const seqs: number[] = [];
    for (const text of texts) seqs.push((await post(a, "say", { text })).body.seq);
    await until(() => s.msgs.filter((m) => m.type === "event" && m.event.kind === "say").length >= 2);
    const says = s.msgs.filter((m) => m.type === "event" && m.event.kind === "say").map((m) => m.event);
    expect(says.map((e) => e.seq)).toEqual(seqs);
    expect(says.map((e) => e.text)).toEqual(texts);
    const viaSync = (await get(a, "sync", `?since=${seqs[1] - 1}&limit=1`)).body.events[0];
    expect(says[1]).toEqual(viaSync);
  });

  it("sends nothing for a refused call", async () => {
    const a = await joinOrch(P, uid("ws-c"));
    const s = await openSocket(P);
    await until(() => s.msgs.length > 0);
    const start = s.msgs.length;
    expect((await post(a, "task", { title: uid("bad"), priority: "asap" })).status).toBe(400);
    const text = uid("after");
    await post(a, "say", { text });
    await until(() => s.msgs.slice(start).some((m) => m.type === "event" && m.event.text === text));
    const first = s.msgs.slice(start).find((m) => m.type === "event");
    expect(first.event.text).toBe(text);
  });

  it("sends the task when it changes, and when an agent reports tokens", async () => {
    const a = await joinOrch(P, uid("ws-d"));
    const s = await openSocket(P);
    await until(() => s.msgs.length > 0);
    const t = await newTask(a, "watched", { estimate_tokens: 1000 });
    await until(() => s.msgs.some((m) => m.type === "task" && m.task.id === t));
    await post(a, "claim", { task_id: t, scopes: [uid("ws")] });
    await until(() => s.msgs.some((m) => m.type === "task" && m.task.id === t && m.task.state === "claimed"));
    const before = s.msgs.length;
    await post(a, "heartbeat", { tokens_used: 4321 });
    await until(() => s.msgs.slice(before).some((m) => m.type === "task" && m.task.id === t));
    const row = s.msgs.slice(before).find((m) => m.type === "task" && m.task.id === t).task;
    expect(row.tokens_used).toBe(4321);
    expect(s.msgs.slice(before).some((m) => m.type === "event")).toBe(false);
  });

  it("sends the roster when someone joins", async () => {
    const s = await openSocket(P);
    await until(() => s.msgs.length > 0);
    const before = s.msgs.length;
    const a = await joinOrch(P, uid("ws-e"));
    await until(() => s.msgs.slice(before).some((m) => m.type === "roster"));
    const roster = s.msgs.slice(before).reverse().find((m) => m.type === "roster").roster;
    expect(roster.some((r: any) => r.name === a.name)).toBe(true);
  });

  it("two tabs both get the event", async () => {
    const a = await joinOrch(P, uid("ws-f"));
    const s1 = await openSocket(P);
    const s2 = await openSocket(P);
    await until(() => s1.msgs.length > 0 && s2.msgs.length > 0);
    const text = uid("both");
    await post(a, "say", { text });
    await until(() => [s1, s2].every((s) => s.msgs.some((m) => m.type === "event" && m.event.text === text)));
  });

  it("refuses a plain GET, another origin, a missing Access header, and a ninth socket", async () => {
    expect((await human(`/h/${P}/ws`)).status).toBe(426);
    expect((await openSocket(P, { origin: "https://evil.test" })).status).toBe(403);
    expect((await openSocket(P, { headers: { "cf-access-jwt-assertion": "" } })).status).toBe(403);
    for (let i = 0; i < 8; i++) expect((await openSocket("other")).status).toBe(101);
    expect((await openSocket("other")).status).toBe(429);
  });

  it("takes the identity from the Access token, never from a header the browser sends", async () => {
    const mine = (await human(`/h/${P}/whoami`)).body.agent_id;
    const theirs = (await human(`/h/${P}/whoami`, { email: "second@example.com" })).body.agent_id;
    const s = await openSocket(P, { headers: { "x-room-human": "second@example.com" } });
    expect(s.status).toBe(101);
    expect(await socketCount(P, mine)).toBe(1);
    expect(await socketCount(P, theirs)).toBe(0);
  });

  it("an open socket keeps the person present; closing it lets them go away", async () => {
    const me = (await human(`/h/${P}/me`)).body.name;
    const s = await openSocket(P);
    await until(() => s.msgs.length > 0);
    await advance(P, 11 * 60_000);
    const a = await joinOrch(P, uid("ws-g"));
    const state = async () => (await get(a, "sync", "?since=999999999")).body.roster.find((r: any) => r.name === me).state;
    expect(await state()).toBe("active");
    s.ws!.close(1000, "bye");
    await until(async () => (await socketCount(P)) === 0);
    await advance(P, 11 * 60_000);
    const b = await joinOrch(P, uid("ws-h"));
    expect((await get(b, "sync", "?since=999999999")).body.roster.find((r: any) => r.name === me).state).toBe("stale");
  });

  it("a failure while telling the sockets never reaches the caller", async () => {
    const a = await joinOrch(P, uid("ws-i"));
    const s = await openSocket(P);
    await until(() => s.msgs.length > 0);
    const stub = (rawEnv as any).ROOM.get((rawEnv as any).ROOM.idFromName(P));
    await (runInDurableObject as any)(stub, async (room: any) => {
      room.taskView = () => {
        throw new Error("taskView broke");
      };
    });
    const title = uid("after a broken broadcast");
    let r;
    try {
      r = await post(a, "task", { title });
    } finally {
      await (runInDurableObject as any)(stub, async (room: any) => {
        delete room.taskView;
      });
    }
    expect(r.status).toBe(200);
    const board = (await human(`/h/${P}/board`)).body.tasks;
    expect(board.some((t: any) => t.id === r.body.task_id && t.title === title)).toBe(true);
  });
});
