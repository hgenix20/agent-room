import { env as rawEnv, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/index";
import { advance, get, joinOrch, newTask, post, uid, type Agent } from "./helpers";

const env = rawEnv as unknown as Env;
const P = "genix";

async function taskRow(a: Agent, id: string): Promise<any> {
  const r = await get(a, "board");
  return r.body.tasks.find((t: any) => t.id === id);
}

describe("task priority and estimates", () => {
  it("a task carries priority and estimates, and defaults when none are given", async () => {
    const a = await joinOrch(P, uid("est"));
    const plain = await newTask(a, "plain");
    const full = await newTask(a, "full", { priority: "urgent", estimate_minutes: 90, estimate_tokens: 70000 });
    const p = await taskRow(a, plain);
    expect(p.priority).toBe("normal");
    expect(p.estimate_minutes).toBeNull();
    expect(p.estimate_tokens).toBeNull();
    expect(p.started_at).toBeNull();
    expect(p.ended_at).toBeNull();
    expect(p.actual_minutes).toBeNull();
    const f = await taskRow(a, full);
    expect(f.priority).toBe("urgent");
    expect(f.estimate_minutes).toBe(90);
    expect(f.estimate_tokens).toBe(70000);
    expect(typeof f.rev).toBe("number");
  });

  it("refuses a bad priority or estimate and creates nothing", async () => {
    const a = await joinOrch(P, uid("bad"));
    const before = (await get(a, "board")).body.tasks.length;
    const cases: [Record<string, unknown>, string][] = [
      [{ priority: "asap" }, "bad_priority"],
      [{ priority: 3 }, "bad_priority"],
      [{ estimate_minutes: 0 }, "bad_estimate_minutes"],
      [{ estimate_minutes: 1.5 }, "bad_estimate_minutes"],
      [{ estimate_minutes: "90" }, "bad_estimate_minutes"],
      [{ estimate_minutes: 100001 }, "bad_estimate_minutes"],
      [{ estimate_tokens: -1 }, "bad_estimate_tokens"],
      [{ estimate_tokens: 2000000001 }, "bad_estimate_tokens"],
    ];
    for (const [extra, error] of cases) {
      const r = await post(a, "task", { title: uid("t"), ...extra });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe(error);
    }
    const mine = (await get(a, "board")).body.tasks.length;
    expect(mine).toBe(before);
  });
});

describe("task start and end", () => {
  it("start is the first claim, end is the done release, and a blocked release in between ends nothing", async () => {
    const a = await joinOrch(P, uid("t-a"));
    const b = await joinOrch(P, uid("t-b"));
    const t = await newTask(a, "timed");
    const scope = uid("timed");
    const c1 = await post(a, "claim", { task_id: t, scopes: [scope] });
    expect(c1.status).toBe(200);
    await advance(P, 5 * 60_000);
    let row = await taskRow(a, t);
    const started = row.started_at;
    expect(typeof started).toBe("number");
    expect(row.actual_minutes).toBe(5);
    await post(a, "release", { claim_id: c1.body.claim_id, version: c1.body.version, state: "blocked" });
    row = await taskRow(a, t);
    expect(row.ended_at).toBeNull();
    expect(row.actual_minutes).toBeNull();
    await advance(P, 3 * 60_000);
    const c2 = await post(b, "claim", { task_id: t, scopes: [scope] });
    expect(c2.status).toBe(200);
    await advance(P, 4 * 60_000);
    await post(b, "release", { claim_id: c2.body.claim_id, version: c2.body.version, state: "done" });
    row = await taskRow(b, t);
    expect(row.started_at).toBe(started);
    const span = row.ended_at - row.started_at;
    expect(span).toBeGreaterThanOrEqual(12 * 60_000);
    expect(span).toBeLessThan(12 * 60_000 + 10_000);
    expect(row.actual_minutes).toBe(12);
  });

  it("an old room gains the columns and its tasks get times from their events", async () => {
    const a = await joinOrch("other", uid("mig"));
    const t = await newTask(a, "old task");
    const c = await post(a, "claim", { task_id: t, scopes: [uid("mig-scope")] });
    await advance("other", 7 * 60_000);
    await post(a, "release", { claim_id: c.body.claim_id, version: c.body.version, state: "done" });
    const stub = env.ROOM.get(env.ROOM.idFromName("other"));
    await (runInDurableObject as any)(stub, async (room: any, state: DurableObjectState) => {
      const sql = state.storage.sql;
      sql.exec("ALTER TABLE tasks DROP COLUMN estimate_tokens");
      sql.exec("UPDATE tasks SET started_at = NULL, ended_at = NULL WHERE id = ?", t);
      sql.exec("DELETE FROM meta WHERE k = 'task_times_backfilled'");
      room.migrate();
      room.migrate();
    });
    const row = await taskRow(a, t);
    expect(row.estimate_tokens).toBeNull();
    const span = row.ended_at - row.started_at;
    expect(span).toBeGreaterThanOrEqual(7 * 60_000);
    expect(span).toBeLessThan(7 * 60_000 + 10_000);
    expect(row.actual_minutes).toBe(7);
  });

  it("the backfill skips an event whose data is not JSON instead of throwing", async () => {
    const a = await joinOrch("other", uid("mig-bad"));
    const t = await newTask(a, "old task, bad event");
    const c = await post(a, "claim", { task_id: t, scopes: [uid("mig-bad-scope")] });
    await post(a, "release", { claim_id: c.body.claim_id, version: c.body.version, state: "done" });
    const stub = env.ROOM.get(env.ROOM.idFromName("other"));
    await (runInDurableObject as any)(stub, async (room: any, state: DurableObjectState) => {
      const sql = state.storage.sql;
      const seq = sql.exec("INSERT INTO events (kind, ref_id, agent_id, task_id, data, created_at) VALUES ('release', NULL, ?, ?, 'not json', 1) RETURNING seq", a.id, t).one().seq;
      try {
        sql.exec("UPDATE tasks SET ended_at = NULL WHERE id = ?", t);
        sql.exec("DELETE FROM meta WHERE k = 'task_times_backfilled'");
        expect(() => room.migrate()).not.toThrow();
      } finally {
        sql.exec("DELETE FROM events WHERE seq = ?", seq);
      }
    });
    expect((await taskRow(a, t)).ended_at).not.toBeNull();
  });
});

describe("token reports", () => {
  it("sums one running total per agent, never lowers it, and reports it on release", async () => {
    const a = await joinOrch(P, uid("tok-a"));
    const b = await joinOrch(P, uid("tok-b"));
    const t = await newTask(a, "costed");
    const scope = uid("costed");
    expect((await taskRow(a, t)).tokens_used).toBeNull();
    const c1 = await post(a, "claim", { task_id: t, scopes: [scope] });
    expect((await post(a, "heartbeat", { tokens_used: 30000 })).body.tokens_ignored).toBeUndefined();
    await post(a, "heartbeat", { tokens_used: 20000 });
    expect((await taskRow(a, t)).tokens_used).toBe(30000);
    await post(a, "release", { claim_id: c1.body.claim_id, version: c1.body.version, state: "blocked" });
    const c2 = await post(b, "claim", { task_id: t, scopes: [scope] });
    await advance(P, 2 * 60_000);
    const cursor = (await get(b, "sync", "?since=999999999")).body.cursor;
    const rel = await post(b, "release", { claim_id: c2.body.claim_id, version: c2.body.version, state: "done", tokens_used: 12000 });
    expect(rel.status).toBe(200);
    expect((await taskRow(b, t)).tokens_used).toBe(42000);
    const ev = (await get(b, "sync", `?since=${cursor}`)).body.events.find((e: any) => e.kind === "release" && e.task === t);
    expect(ev.tokens).toBe(42000);
    expect(typeof ev.minutes).toBe("number");
  });

  it("ignores a report from an agent that holds no claim, and says so", async () => {
    const a = await joinOrch(P, uid("tok-n"));
    const t = await newTask(a, "unclaimed");
    const r = await post(a, "heartbeat", { tokens_used: 500 });
    expect(r.status).toBe(200);
    expect(r.body.tokens_ignored).toBe(true);
    expect((await taskRow(a, t)).tokens_used).toBeNull();
  });

  it("refuses a value that is not a whole number in range", async () => {
    const a = await joinOrch(P, uid("tok-bad"));
    const t = await newTask(a, "bad tokens");
    const c = await post(a, "claim", { task_id: t, scopes: [uid("tb")] });
    for (const v of [-1, 1.5, "12", 2000000001]) {
      const r = await post(a, "heartbeat", { tokens_used: v });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("bad_tokens_used");
    }
    const r = await post(a, "release", { claim_id: c.body.claim_id, version: c.body.version, state: "done", tokens_used: -5 });
    expect(r.status).toBe(400);
    expect((await taskRow(a, t)).state).toBe("claimed");
  });

  it("refuses one token number for several claims and releases none of them", async () => {
    const a = await joinOrch(P, uid("tok-all"));
    const t1 = await newTask(a, "one");
    const t2 = await newTask(a, "two");
    await post(a, "claim", { task_id: t1, scopes: [uid("x")] });
    await post(a, "claim", { task_id: t2, scopes: [uid("y")] });
    const r = await post(a, "release", { all: true, state: "blocked", tokens_used: 100 });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("tokens_need_one_claim");
    expect((await taskRow(a, t1)).state).toBe("claimed");
    expect((await taskRow(a, t2)).state).toBe("claimed");
  });
});
