import { describe, expect, it } from "vitest";
import { get, joinOrch, newTask, post, uid, type Agent } from "./helpers";

const P = "genix";

async function taskRow(a: Agent, id: string): Promise<any> {
  return (await get(a, "board")).body.tasks.find((t: any) => t.id === id);
}

describe("task_update", () => {
  it("the creator changes priority and estimates, and the room logs what changed", async () => {
    const a = await joinOrch(P, uid("up-a"));
    const t = await newTask(a, "first title", { estimate_minutes: 30 });
    const cursor = (await get(a, "sync", "?since=999999999")).body.cursor;
    const r = await post(a, "task_update", { task_id: t, priority: "urgent", estimate_minutes: 90, estimate_tokens: 70000, title: "second title" });
    expect(r.status).toBe(200);
    expect(r.body.changed.sort()).toEqual(["estimate_minutes", "estimate_tokens", "priority", "title"]);
    const row = await taskRow(a, t);
    expect(row.priority).toBe("urgent");
    expect(row.estimate_minutes).toBe(90);
    expect(row.estimate_tokens).toBe(70000);
    expect(row.title).toBe("second title");
    const ev = (await get(a, "sync", `?since=${cursor}`)).body.events.find((e: any) => e.kind === "task_updated");
    expect(ev.task).toBe(t);
    expect(ev.by).toBe(a.name);
    expect(ev.changes.priority).toEqual(["normal", "urgent"]);
    expect(ev.changes.estimate_minutes).toEqual([30, 90]);
  });

  it("null clears an estimate", async () => {
    const a = await joinOrch(P, uid("up-n"));
    const t = await newTask(a, "clear me", { estimate_minutes: 30, estimate_tokens: 5000 });
    expect((await post(a, "task_update", { task_id: t, estimate_minutes: null })).status).toBe(200);
    const row = await taskRow(a, t);
    expect(row.estimate_minutes).toBeNull();
    expect(row.estimate_tokens).toBe(5000);
  });

  it("another agent cannot update it, unless it holds the claim", async () => {
    const a = await joinOrch(P, uid("up-own"));
    const b = await joinOrch(P, uid("up-oth"));
    const t = await newTask(a, "not yours");
    const no = await post(b, "task_update", { task_id: t, priority: "low" });
    expect(no.status).toBe(403);
    expect(no.body.error).toBe("not_yours");
    expect((await post(b, "claim", { task_id: t, scopes: [uid("up")] })).status).toBe(200);
    expect((await post(b, "task_update", { task_id: t, priority: "low" })).status).toBe(200);
    expect((await taskRow(a, t)).priority).toBe("low");
  });

  it("refuses an unknown task, a bad value, and a call that changes nothing", async () => {
    const a = await joinOrch(P, uid("up-bad"));
    const t = await newTask(a, "steady", { priority: "high" });
    expect((await post(a, "task_update", { task_id: "T999999", priority: "low" })).status).toBe(404);
    const bad = await post(a, "task_update", { task_id: t, priority: "soon" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("bad_priority");
    const same = await post(a, "task_update", { task_id: t, priority: "high" });
    expect(same.status).toBe(400);
    expect(same.body.error).toBe("no_change");
    const none = await post(a, "task_update", { task_id: t });
    expect(none.body.error).toBe("no_change");
    const mixed = await post(a, "task_update", { task_id: t, priority: "low", estimate_minutes: 0 });
    expect(mixed.status).toBe(400);
    expect((await taskRow(a, t)).priority).toBe("high");
  });

  it("a title that looks like a key is refused", async () => {
    const a = await joinOrch(P, uid("up-sec"));
    const t = await newTask(a, "plain");
    const r = await post(a, "task_update", { task_id: t, title: "use AKIAABCDEFGHIJKLMNOP" });
    expect(r.status).toBe(422);
    expect((await taskRow(a, t)).title).toBe("plain");
  });
});
