# Agent Room Human UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Kameron a browser page for Agent Room: an IRC-style channel he can talk in, and a task grid with estimates and actuals (time and tokens) per task.

**Architecture:** The existing Worker gains a human API under `/h/<project>/…` and a page under `/ui`, both behind a Cloudflare Access check the Worker verifies itself. A person is a row in the room's `agents` table, so their calls run through the same handlers as an agent's. The room pushes new events, changed tasks and the roster to open WebSockets after each call commits.

**Tech Stack:** Cloudflare Workers, Durable Objects with SQLite storage and the WebSocket hibernation API, Workers static assets, TypeScript, vitest with `@cloudflare/vitest-pool-workers`, plain HTML, CSS and ES modules in the browser.

**Spec:** `docs/superpowers/specs/2026-10-01-human-ui-design.md`

## Global Constraints

- No new npm dependency. No framework and no build step for the page.
- The page writes room text with `textContent` only. `innerHTML`, `outerHTML`, `insertAdjacentHTML` and `document.write` never appear in `public/ui/`.
- Priority is one of `urgent`, `high`, `normal`, `low`; default `normal`.
- `estimate_minutes` is a whole number 1 to 100000 or null. `estimate_tokens` and `tokens_used` are whole numbers 0 to 2000000000 or null.
- A task with no token report returns `tokens_used: null`. It is never 0.
- Validate every input before the first write in a handler. `runAction` turns an `HttpError` into an answer without rolling the transaction back, so a write before a failed check would stay.
- Errors use the room's shape: `{"error": "<code>", …}` with the HTTP status the spec names.
- `/p/…`, `/admin/…`, `/` and `/health` keep their behavior. The 44 existing tests stay green.
- Run tests with `npx vitest run` (the whole suite takes about 70 seconds; one file: `npx vitest run test/<file>`). Type-check with `npm run typecheck`. Both must pass before each commit.
- `runInDurableObject` needs a cast or `tsc` fails with TS2589: write `(runInDurableObject as any)(stub, async (room: any, state: DurableObjectState) => { … })`.
- The room's clock is `Date.now()` plus a test offset, so real milliseconds pass between two calls. Assert a time span with a tolerance, never with exact equality.
- Tests share the rooms `genix` and `other` across files. Give every agent, scope and task a unique name with `uid()`, and never assert on a whole-room count.
- Commit messages: plain sentences, no trailers. Docs and comments: no em-dashes, and never the words "silently", "quietly", or "surface" as a verb.
- Count and send to open sockets only: `ctx.getWebSockets()` can still list a socket that is closing, so filter on `readyState === 1`.
- Work on branch `human-ui`. Do not push and do not merge.

## Review Focus

1. A message from an agent that contains HTML or script markup is shown as text and never runs. (Tests in Task 7 and Task 8.)
2. A person whose email has characters outside the room's name rule, or no usable characters at all, still gets a valid roster name. (Test in Task 5.)
3. A browser that sends its own `x-room-human` header on the socket request gets the identity from its Access token, never the one it claimed. (Test in Task 6.)
4. An Access token whose email differs from the allow-list entry only in letter case is accepted. (Test in Task 4.)
5. Junk typed into a grid cell or a slash command (`abc`, `0m`, `-5k`, `99999999999`) is refused in the page with a message and no call is sent. (Tests in Task 7.)

## File Structure

| File | Responsibility |
|---|---|
| `src/lib.ts` (modify) | Limits, `readBody`, `jsonMap` moved here so two route files share them |
| `src/room.ts` (modify) | Task fields, token reports, `task_update`, people, `sync` paging backwards, sockets and broadcast |
| `src/access.ts` (create) | Verify the Cloudflare Access header; nothing else |
| `src/human.ts` (create) | Routes under `/h` and `/ui`: Access check, origin check, call the room, serve the page |
| `src/index.ts` (modify) | Send `/h` and `/ui` to `human.ts`; allow `task_update`; new `Env` fields |
| `public/ui/logic.js` (create) | Pure functions: formatting, parsing commands, sorting, event text |
| `public/ui/app.js` (create) | DOM, network and socket code for the page |
| `public/ui/index.html`, `public/ui/style.css` (create) | Page shell and the IRC look |
| `scripts/access-setup.py` (create) | Creates the Access application; Kameron runs it |
| `docs/human-ui.md` (create) | Setup and use |
| `agent-room/SKILL.md` (modify) | New fields and `task_update` for agents |
| `test/costs.test.ts`, `test/update.test.ts`, `test/access.test.ts`, `test/human.test.ts`, `test/socket.test.ts`, `test/logic.test.ts`, `test/ui.test.ts`, `test/access-helpers.ts` (create) | One test file per feature |
| `vitest.config.ts`, `tsconfig.json`, `wrangler.toml` (modify) | Test bindings, `allowJs`, assets and vars |

---

### Task 1: Task priority, estimates and times

**Files:**
- Modify: `src/lib.ts` (the `LIMITS` object)
- Modify: `src/room.ts` (`TaskRow`, constructor, `createTask`, `claim`, `release`, `board`)
- Test: `test/costs.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `LIMITS.estimateMinutesMax = 100_000`, `LIMITS.tokensMax = 2_000_000_000`
  - module functions in `room.ts`: `priorityOf(v: unknown): string`, `intOf(v: unknown, error: string, min: number, max: number): number`, `actualMinutes(t: TaskRow, now: number): number | null`
  - `ProjectRoom` private methods: `migrate(): void`, `addColumn(table: string, column: string, ddl: string): void`, `taskView(t: TaskRow, now: number): Record<string, unknown>`
  - `board` rows gain `priority`, `estimate_minutes`, `estimate_tokens`, `started_at`, `ended_at`, `actual_minutes`, `rev`

- [ ] **Step 1: Write the failing tests**

Create `test/costs.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/costs.test.ts`
Expected: FAIL. The first test fails on `expected undefined to be 'normal'`.

- [ ] **Step 3: Add the limits**

In `src/lib.ts`, inside `LIMITS`, after the `claimFightWindowMs` line, add:

```ts
  estimateMinutesMax: 100_000,
  tokensMax: 2_000_000_000,
```

- [ ] **Step 4: Add the columns, the migration and the row type**

In `src/room.ts`, add to `interface TaskRow`, before the index signature line:

```ts
  priority: string;
  estimate_minutes: number | null;
  estimate_tokens: number | null;
  started_at: number | null;
  ended_at: number | null;
```

In the constructor, replace this block:

```ts
    if (!this.sql.exec<{ name: string }>("PRAGMA table_info(agents)").toArray().some((c) => c.name === "orphaned")) {
      this.sql.exec("ALTER TABLE agents ADD COLUMN orphaned INTEGER NOT NULL DEFAULT 0");
    }
```

with:

```ts
    this.migrate();
```

Add these two methods directly above the `// --- basics` comment line:

```ts
  private addColumn(table: string, column: string, ddl: string): void {
    if (!this.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().some((c) => c.name === column)) {
      this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  }

  /** Brings a room made by an older version up to this one. Safe to run again. */
  private migrate(): void {
    this.addColumn("agents", "orphaned", "orphaned INTEGER NOT NULL DEFAULT 0");
    this.addColumn("tasks", "priority", "priority TEXT NOT NULL DEFAULT 'normal'");
    this.addColumn("tasks", "estimate_minutes", "estimate_minutes INTEGER");
    this.addColumn("tasks", "estimate_tokens", "estimate_tokens INTEGER");
    this.addColumn("tasks", "started_at", "started_at INTEGER");
    this.addColumn("tasks", "ended_at", "ended_at INTEGER");
    if (!this.sql.exec("SELECT v FROM meta WHERE k = 'task_times_backfilled'").toArray().length) {
      // Tasks from before these columns: the claim and release events already hold the times.
      this.sql.exec(
        `UPDATE tasks SET started_at = (SELECT MIN(e.created_at) FROM events e WHERE e.kind = 'claim' AND e.task_id = tasks.id)
         WHERE started_at IS NULL`,
      );
      this.sql.exec(
        `UPDATE tasks SET ended_at = (SELECT MAX(e.created_at) FROM events e
           WHERE e.kind = 'release' AND e.task_id = tasks.id AND json_extract(e.data, '$.state') = 'done')
         WHERE state = 'done' AND ended_at IS NULL`,
      );
      this.sql.exec("INSERT INTO meta (k, v) VALUES ('task_times_backfilled', '1') ON CONFLICT(k) DO NOTHING");
    }
  }
```

- [ ] **Step 5: Add the validators and `actualMinutes`**

In `src/room.ts`, in the helpers section at the bottom of the file, above `function leaseOf`, add:

```ts
const PRIORITIES = new Set(["urgent", "high", "normal", "low"]);

function priorityOf(v: unknown): string {
  if (typeof v !== "string" || !PRIORITIES.has(v)) throw new HttpError(400, { error: "bad_priority", detail: "urgent, high, normal or low" });
  return v;
}

function intOf(v: unknown, error: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new HttpError(400, { error, detail: `whole number ${min} to ${max}` });
  }
  return v;
}

/** Wall-clock minutes from first claim to done, or so far while claimed; null otherwise. */
function actualMinutes(t: TaskRow, now: number): number | null {
  if (t.started_at === null) return null;
  const end = t.ended_at ?? (t.state === "claimed" ? now : null);
  return end === null ? null : Math.max(0, Math.round((end - t.started_at) / 60_000));
}
```

- [ ] **Step 6: Store the fields on create**

In `createTask`, after the `parentTask` block and before `const num = this.counter("task_num");`, add:

```ts
    const priority = body.priority === undefined ? "normal" : priorityOf(body.priority);
    const estMinutes =
      body.estimate_minutes === undefined || body.estimate_minutes === null
        ? null
        : intOf(body.estimate_minutes, "bad_estimate_minutes", 1, LIMITS.estimateMinutesMax);
    const estTokens =
      body.estimate_tokens === undefined || body.estimate_tokens === null
        ? null
        : intOf(body.estimate_tokens, "bad_estimate_tokens", 0, LIMITS.tokensMax);
```

Replace the `INSERT INTO tasks` statement and the `this.event("task", …)` line that follow with:

```ts
    this.sql.exec(
      `INSERT INTO tasks (id, num, title, detail, state, parent_task, depends_on, created_by, updated_at, priority, estimate_minutes, estimate_tokens)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
      id, num, title, detail, parentTask, JSON.stringify(deps), me.id, now, priority, estMinutes, estTokens,
    );
    this.event("task", id, me.id, id, {
      task: id, title, by: me.name, depends_on: deps, parent_task: parentTask,
      priority, estimate_minutes: estMinutes, estimate_tokens: estTokens,
    });
```

- [ ] **Step 7: Set the times on claim and release**

In `claim`, replace:

```ts
    this.sql.exec("UPDATE tasks SET state = 'claimed', owner_id = ?, updated_at = ? WHERE id = ?", me.id, now, taskId);
```

with:

```ts
    this.sql.exec(
      "UPDATE tasks SET state = 'claimed', owner_id = ?, updated_at = ?, started_at = COALESCE(started_at, ?), ended_at = NULL WHERE id = ?",
      me.id, now, now, taskId,
    );
```

In `release`, inside the `for (const c of targets)` loop, directly after the `UPDATE tasks SET state = ?, owner_id = ?, branch = …` statement, add:

```ts
      if (state === "done") this.sql.exec("UPDATE tasks SET ended_at = ? WHERE id = ?", now, c.task_id);
```

- [ ] **Step 8: Return the fields from `board`**

Replace the whole `board` method with:

```ts
  private taskView(t: TaskRow, now: number): Record<string, unknown> {
    const c = this.first<ClaimRow>("SELECT * FROM claims WHERE task_id = ? AND state = 'live'", t.id);
    return {
      id: t.id,
      title: t.title,
      detail: t.detail || undefined,
      state: t.state,
      owner: this.nameOf(t.owner_id),
      branch: t.branch,
      commit: t.commit_sha,
      parent_task: t.parent_task,
      depends_on: JSON.parse(t.depends_on),
      claim: c ? { scopes: JSON.parse(c.scopes), expires_in_s: Math.round((c.expires_at - now) / 1000) } : undefined,
      priority: t.priority,
      estimate_minutes: t.estimate_minutes,
      estimate_tokens: t.estimate_tokens,
      started_at: t.started_at,
      ended_at: t.ended_at,
      actual_minutes: actualMinutes(t, now),
      rev: t.updated_at,
    };
  }

  private board(now: number): Result {
    const tasks = this.rows<TaskRow>("SELECT * FROM tasks ORDER BY num").map((t) => this.taskView(t, now));
    return { status: 200, body: { tasks } };
  }
```

- [ ] **Step 9: Run the tests and the type check**

Run: `npx vitest run test/costs.test.ts`
Expected: PASS, 4 tests.

Run: `npm run typecheck`
Expected: no output, exit 0.

Run: `npx vitest run`
Expected: 48 passed (44 existing, 4 new).

- [ ] **Step 10: Commit**

```bash
git add src/lib.ts src/room.ts test/costs.test.ts
git commit -m "Tasks carry priority, estimates, and start and end times"
```

---

### Task 2: Token reports from agents

**Files:**
- Modify: `src/room.ts` (constructor table list, `heartbeat`, `release`, `taskView`)
- Test: `test/costs.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `intOf`, `LIMITS.tokensMax`, `taskView` from Task 1.
- Produces:
  - table `task_tokens (task_id, agent_id, tokens, updated_at)`
  - `ProjectRoom` private methods: `reportTokens(taskId: string, agentId: string, tokens: number, now: number): void`, `taskTokens(taskId: string): number | null`
  - `heartbeat` and `release` accept `tokens_used`; `heartbeat` may answer `tokens_ignored: true`
  - `board` rows gain `tokens_used: number | null`; `release` events gain `minutes` and `tokens`

- [ ] **Step 1: Write the failing tests**

Append to `test/costs.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/costs.test.ts`
Expected: FAIL. The first new test fails on `expected undefined to be null`.

- [ ] **Step 3: Add the table and the two methods**

In the constructor's `CREATE TABLE` script, after the `claim_lock` line, add:

```sql
      CREATE TABLE IF NOT EXISTS task_tokens (
        task_id TEXT NOT NULL, agent_id TEXT NOT NULL, tokens INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, agent_id));
```

Add these methods directly above `private taskView`:

```ts
  /** One running total per agent per task; a later, lower number never replaces a higher one. */
  private reportTokens(taskId: string, agentId: string, tokens: number, now: number): void {
    this.sql.exec(
      `INSERT INTO task_tokens (task_id, agent_id, tokens, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(task_id, agent_id) DO UPDATE SET tokens = MAX(tokens, excluded.tokens), updated_at = excluded.updated_at`,
      taskId, agentId, tokens, now,
    );
    this.sql.exec("UPDATE tasks SET updated_at = ? WHERE id = ?", now, taskId);
  }

  /** The task's total across agents, or null when no agent has reported. */
  private taskTokens(taskId: string): number | null {
    return this.first<{ s: number | null }>("SELECT SUM(tokens) AS s FROM task_tokens WHERE task_id = ?", taskId)?.s ?? null;
  }
```

In `taskView`, add after the `actual_minutes` line:

```ts
      tokens_used: this.taskTokens(t.id),
```

- [ ] **Step 4: Accept `tokens_used` on heartbeat**

In `heartbeat`, add as the first two lines of the method:

```ts
    const tokens = body.tokens_used === undefined || body.tokens_used === null ? null : intOf(body.tokens_used, "bad_tokens_used", 0, LIMITS.tokensMax);
    let tokensIgnored = false;
```

Replace the method's last line, `return { status: 200, body: { ok: true, renewed } };`, with:

```ts
    if (tokens !== null) {
      const held = this.currentTask(me.id);
      if (held) this.reportTokens(held, me.id, tokens, now);
      else tokensIgnored = true;
    }
    return { status: 200, body: tokensIgnored ? { ok: true, renewed, tokens_ignored: true } : { ok: true, renewed } };
```

- [ ] **Step 5: Accept `tokens_used` on release**

In `release`, after the `const branch = …` line, add:

```ts
    const tokens = body.tokens_used === undefined || body.tokens_used === null ? null : intOf(body.tokens_used, "bad_tokens_used", 0, LIMITS.tokensMax);
```

Directly before `const released = [];`, add:

```ts
    if (tokens !== null && targets.length > 1) {
      throw new HttpError(400, { error: "tokens_need_one_claim", detail: "tokens_used names one task; release that claim by its id" });
    }
```

Inside the loop, replace the `this.event("release", …)` line with:

```ts
      if (tokens !== null) this.reportTokens(c.task_id, me.id, tokens, now);
      const after = this.first<TaskRow>("SELECT * FROM tasks WHERE id = ?", c.task_id)!;
      this.event("release", c.id, me.id, c.task_id, {
        by: this.label(me, c.task_id), task: c.task_id, state, commit, branch, claim_id: c.id,
        minutes: after.ended_at !== null ? actualMinutes(after, now) : null,
        tokens: this.taskTokens(c.task_id),
      });
```

- [ ] **Step 6: Run the tests and the type check**

Run: `npx vitest run test/costs.test.ts`
Expected: PASS, 8 tests.

Run: `npm run typecheck && npx vitest run`
Expected: type check clean; 52 passed.

- [ ] **Step 7: Commit**

```bash
git add src/room.ts test/costs.test.ts
git commit -m "Agents report tokens used per task on heartbeat and release"
```

---

### Task 3: `task_update`

**Files:**
- Modify: `src/index.ts` (`ROOM_CALLS`, the route regex)
- Modify: `src/room.ts` (`WRITE_ACTIONS`, `dispatch`, new `updateTask`)
- Modify: `agent-room/SKILL.md`
- Test: `test/update.test.ts` (create)

**Interfaces:**
- Consumes: `priorityOf`, `intOf`, `LIMITS` from Task 1.
- Produces:
  - agent action `task_update` (POST): `{task_id, title?, detail?, priority?, estimate_minutes?, estimate_tokens?, key?}` answers `{ok: true, task_id, changed: string[]}`
  - event kind `task_updated` with data `{task, by, changes: {field: [old, new]}}`; for `detail` the pair is `[null, null]`
  - `ProjectRoom` private method `updateTask(me: AgentRow, body: Record<string, unknown>, now: number): Result`
  - the agent route accepts action names with underscores

- [ ] **Step 1: Write the failing tests**

Create `test/update.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/update.test.ts`
Expected: FAIL with status 404 (`not_found`), because the route regex does not accept an underscore.

- [ ] **Step 3: Let the route and the call list accept it**

In `src/index.ts`, replace:

```ts
const ROOM_CALLS = new Set(["heartbeat", "sync", "say", "board", "task", "claim", "release", "leave", "whoami", "adopt"]);
```

with:

```ts
const ROOM_CALLS = new Set(["heartbeat", "sync", "say", "board", "task", "task_update", "claim", "release", "leave", "whoami", "adopt"]);
```

and replace:

```ts
      const m = path.match(/^\/p\/([^/]+)\/([a-z]+)$/);
```

with:

```ts
      const m = path.match(/^\/p\/([^/]+)\/([a-z_]+)$/);
```

- [ ] **Step 4: Add the action**

In `src/room.ts`, replace:

```ts
const WRITE_ACTIONS = new Set(["heartbeat", "say", "task", "claim", "release", "leave", "adopt"]);
```

with:

```ts
const WRITE_ACTIONS = new Set(["heartbeat", "say", "task", "task_update", "claim", "release", "leave", "adopt"]);
```

In `dispatch`, after the `case "task":` pair of lines, add:

```ts
      case "task_update":
        return this.updateTask(me, body, now);
```

Add this method directly above `private claim(`:

```ts
  /** Change a task's title, detail, priority or estimates. An agent may change a task it created or holds. */
  private updateTask(me: AgentRow, body: Record<string, unknown>, now: number): Result {
    const taskId = str(body.task_id, "task_id", 40, true);
    const t = this.first<TaskRow>("SELECT * FROM tasks WHERE id = ?", taskId);
    if (!t) throw new HttpError(404, { error: "unknown_task", task: taskId });
    const mine = t.created_by === me.id || this.liveClaimsOf(me.id).some((c) => c.task_id === taskId);
    if (!mine) throw new HttpError(403, { error: "not_yours", detail: "you can update a task you created or hold a claim on" });

    const next: Record<string, string | number | null> = {};
    if (body.title !== undefined) next.title = str(body.title, "title", LIMITS.titleChars, true);
    if (body.detail !== undefined) next.detail = body.detail === null ? "" : str(body.detail, "detail", LIMITS.messageChars);
    if (body.priority !== undefined) next.priority = priorityOf(body.priority);
    if (body.estimate_minutes !== undefined) {
      next.estimate_minutes = body.estimate_minutes === null ? null : intOf(body.estimate_minutes, "bad_estimate_minutes", 1, LIMITS.estimateMinutesMax);
    }
    if (body.estimate_tokens !== undefined) {
      next.estimate_tokens = body.estimate_tokens === null ? null : intOf(body.estimate_tokens, "bad_estimate_tokens", 0, LIMITS.tokensMax);
    }
    if (next.title !== undefined || next.detail !== undefined) checkSecret(`${next.title ?? ""}\n${next.detail ?? ""}`);

    const cols = Object.keys(next).filter((k) => t[k] !== next[k]);
    if (!cols.length) throw new HttpError(400, { error: "no_change" });
    const changes: Record<string, [unknown, unknown]> = {};
    // The detail can be 5000 characters; the event says it changed without carrying the text.
    for (const k of cols) changes[k] = k === "detail" ? [null, null] : [t[k], next[k]];
    // cols holds only the five keys set above, so building the SET list from it is safe.
    this.sql.exec(
      `UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
      ...cols.map((c) => next[c]), now, taskId,
    );
    this.event("task_updated", taskId, me.id, taskId, { task: taskId, by: me.name, changes });
    return { status: 200, body: { ok: true, task_id: taskId, changed: cols } };
  }
```

- [ ] **Step 5: Run the tests and the type check**

Run: `npx vitest run test/update.test.ts`
Expected: PASS, 5 tests.

Run: `npm run typecheck && npx vitest run`
Expected: type check clean; 57 passed.

- [ ] **Step 6: Tell agents about the new fields**

In `agent-room/SKILL.md`, replace this block:

````md
# task: add one to the board
curl -s -X POST "$ROOM/task" -H "$A" -d '{"title":"auth middleware","detail":"verify session cookie","depends_on":["T3"],"key":"t-auth"}'
````

with:

````md
# task: add one to the board; priority (urgent, high, normal, low) and estimates are optional
curl -s -X POST "$ROOM/task" -H "$A" -d '{"title":"auth middleware","detail":"verify session cookie","depends_on":["T3"],"priority":"high","estimate_minutes":60,"estimate_tokens":80000,"key":"t-auth"}'

# task_update: change title, detail, priority or estimates on a task you created or hold; null clears an estimate
curl -s -X POST "$ROOM/task_update" -H "$A" -d '{"task_id":"T7","priority":"urgent","estimate_minutes":90,"key":"u-T7"}'
````

Replace this block:

````md
# heartbeat: one-line status; renews your claims
curl -s -X POST "$ROOM/heartbeat" -H "$A" -d '{"status_line":"writing auth middleware tests"}'
````

with:

````md
# heartbeat: one-line status; renews your claims. tokens_used is your running total on the task you hold
curl -s -X POST "$ROOM/heartbeat" -H "$A" -d '{"status_line":"writing auth middleware tests","tokens_used":41200}'
````

Replace this line:

````md
curl -s -X POST "$ROOM/release" -H "$A" -d '{"claim_id":"c…","version":41,"state":"done","branch":"agent/t7","commit":"3f9a2c1","key":"r-T7"}'
````

with:

````md
curl -s -X POST "$ROOM/release" -H "$A" -d '{"claim_id":"c…","version":41,"state":"done","branch":"agent/t7","commit":"3f9a2c1","tokens_used":58300,"key":"r-T7"}'
````

After the line `Your messages are stamped with the task you hold a claim on (`sub-a2/T9`), so` and its continuation line `others can filter to it.`, add a blank line and:

```md
If you know how many tokens you have spent on a task, send `tokens_used` with your
heartbeats and with the release. It is a running total for you on that task, a
whole number; the room keeps the highest value you sent and adds up the agents
who worked on the task. A person watching the room sees it beside the estimate.
Leave it out when you do not know; never guess.
```

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/room.ts agent-room/SKILL.md test/update.test.ts
git commit -m "task_update changes a task's title, detail, priority and estimates"
```

---

### Task 4: Verify the Cloudflare Access header

**Files:**
- Create: `src/access.ts`
- Create: `test/access-helpers.ts`
- Modify: `src/index.ts` (the `Env` interface)
- Modify: `vitest.config.ts`
- Test: `test/access.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `src/access.ts`: `export interface AccessEnv { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string; HUMANS?: string; ACCESS_TEST_JWKS?: string }`
  - `export type AccessResult = { ok: true; email: string } | { ok: false; status: number; error: string; detail: string }`
  - `export async function verifyAccess(req: Request, env: AccessEnv, fetcher?: (url: string) => Promise<Response>, nowMs?: number): Promise<AccessResult>`
  - `export function _resetCertCache(): void` (tests only)
  - `test/access-helpers.ts`: `signJwt(key: CryptoKey, kid: string, claims: Record<string, unknown>): Promise<string>`, `claimsFor(email: string, over?: Record<string, unknown>): Record<string, unknown>`, `accessJwt(email?: string, over?: Record<string, unknown>): Promise<string>`
  - test bindings: `ACCESS_TEAM_DOMAIN = "team.test"`, `ACCESS_AUD = "test-aud"`, `HUMANS` = `["kameron@example.com", "second@example.com", "k.green+room@example.com", "+++@example.com"]`, `ACCESS_TEST_JWKS`, `TEST_ACCESS_PRIVATE_JWK`; the test key id is `test-kid`

- [ ] **Step 1: Add the test bindings**

Replace `vitest.config.ts` with:

```ts
import { generateKeyPairSync } from "node:crypto";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// A key pair made for this test run. The worker reads the public half from ACCESS_TEST_JWKS
// in place of fetching Cloudflare's certs; tests sign Access tokens with the private half.
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: "test-kid", alg: "RS256", use: "sig" };

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          PROJECT_KEYS: JSON.stringify({ genix: "test-key-genix", other: "test-key-other" }),
          ORCHESTRATOR_CREDENTIALS: JSON.stringify({ laptop: "orch-cred-laptop", box: "orch-cred-box" }),
          ADMIN_TOKEN: "admin-test-token",
          MIND_TOKEN: "mind-test-token",
          ALLOW_TEST_CLOCK: "1",
          BLOCK_CACHE_MS: "0",
          ACCESS_TEAM_DOMAIN: "team.test",
          ACCESS_AUD: "test-aud",
          HUMANS: JSON.stringify(["kameron@example.com", "second@example.com", "k.green+room@example.com", "+++@example.com"]),
          ACCESS_TEST_JWKS: JSON.stringify({ keys: [publicJwk] }),
          TEST_ACCESS_PRIVATE_JWK: JSON.stringify(privateKey.export({ format: "jwk" })),
        },
      },
    }),
  ],
  test: { maxWorkers: 1, fileParallelism: false, testTimeout: 90_000 },
});
```

- [ ] **Step 2: Write the test helpers**

Create `test/access-helpers.ts`:

```ts
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
```

- [ ] **Step 3: Write the failing tests**

Create `test/access.test.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests and watch them fail**

Run: `npx vitest run test/access.test.ts`
Expected: FAIL, cannot resolve `../src/access`.

- [ ] **Step 5: Write the verifier**

Create `src/access.ts`:

```ts
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
  /** Test only: a JWKS used in place of fetching the team's certs. Never set in production. */
  ACCESS_TEST_JWKS?: string;
}

export type AccessResult = { ok: true; email: string } | { ok: false; status: number; error: string; detail: string };

type Jwk = JsonWebKey & { kid?: string };

const CERT_TTL_MS = 60 * 60_000;
const SLACK_S = 60;
const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

let certCache: { at: number; domain: string; keys: Jwk[] } | null = null;

/** Test hook: forget the cached certs. */
export function _resetCertCache(): void {
  certCache = null;
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
    const emails = v.filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase()).filter(Boolean);
    return emails.length ? emails : null;
  } catch {
    return null;
  }
}

async function keysFor(env: AccessEnv, domain: string, fetcher: (url: string) => Promise<Response>, force: boolean): Promise<Jwk[]> {
  if (env.ACCESS_TEST_JWKS) {
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
 * 503 when the settings are missing; 403 for every other failure.
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
    if (!key) key = (await keysFor(env, domain, fetcher, true)).find((k) => k.kid === head.kid);
  } catch {
    return refuse("the team's certs could not be read");
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
  if (typeof claims.nbf === "number" && claims.nbf > now + SLACK_S) return refuse("token is not valid yet");
  if (typeof claims.email !== "string") return refuse("token names no email");
  const email = claims.email.trim().toLowerCase();
  if (!humans.includes(email)) return refuse("this email is not on the room's list");
  return { ok: true, email };
}
```

- [ ] **Step 6: Add the settings to `Env`**

In `src/index.ts`, change the import block at the top to add:

```ts
import type { AccessEnv } from "./access";
```

and replace `export interface Env {` with:

```ts
export interface Env extends AccessEnv {
```

- [ ] **Step 7: Run the tests and the type check**

Run: `npx vitest run test/access.test.ts`
Expected: PASS, 8 tests.

Run: `npm run typecheck && npx vitest run`
Expected: type check clean; 65 passed.

- [ ] **Step 8: Commit**

```bash
git add src/access.ts src/index.ts vitest.config.ts test/access-helpers.ts test/access.test.ts
git commit -m "Verify the Cloudflare Access header before any human route"
```

---

### Task 5: People in the room and the human API

**Files:**
- Modify: `src/lib.ts` (add `readBody`, `jsonMap`)
- Modify: `src/index.ts` (use the moved helpers; route `/h`)
- Modify: `src/room.ts` (`AgentRow`, `migrate`, `alive`, `sweep`, `join`, `call`, `escalateFlood`, `maybeBan`, `dispatch`, `leave`, `updateTask`, `sync`, `revoke`; new `humanCall`, `runAction`, `ensureHuman`, `nameTaken`, `nick`, `viewEvent`, `rosterView`)
- Create: `src/human.ts`
- Modify: `test/access-helpers.ts` (add `human`)
- Test: `test/human.test.ts` (create)

**Interfaces:**
- Consumes: `verifyAccess` and `accessJwt` from Task 4; `updateTask` from Task 3.
- Produces:
  - `src/lib.ts`: `export const MAX_BODY = 64 * 1024`, `export async function readBody(req: Request): Promise<Record<string, unknown>>`, `export function jsonMap(raw: string | undefined): Record<string, string>`
  - `src/room.ts`: `export interface HumanInput { project: string; email: string; action: string; body: Record<string, unknown>; query: Record<string, string>; ip: string }`, `async humanCall(input: HumanInput): Promise<Result>`
  - `ProjectRoom` private methods used by Task 6: `ensureHuman(email: string, ip: string, now: number): AgentRow`, `viewEvent(r: Record<string, SqlStorageValue>): Record<string, unknown>`, `rosterView(now: number): Record<string, unknown>[]`, and the module constant `EVENT_SELECT`
  - `AgentRow.kind: string` (`agent` or `human`) and `AgentRow.email: string | null`
  - `src/human.ts`: `export function isHumanPath(path: string): boolean`, `export async function handleHuman(env: Env, req: Request, url: URL, ip: string): Promise<Response>`
  - routes: `GET /h/projects`; `GET /h/<project>/{sync,board,whoami,me}`; `POST /h/<project>/{say,task,task_update,claim,release,heartbeat,leave,nick}`
  - `sync` accepts `before=<seq>`: the newest `limit` events with a lower seq, oldest first; `cursor` is then the room's newest seq and `more` says older events exist
  - roster entries carry `kind: "human"` for a person
  - `test/access-helpers.ts`: `human(path: string, opts?: { email?: string; body?: unknown; method?: string; origin?: string | null; jwt?: string | null }): Promise<Res>`

- [ ] **Step 1: Add the `human` test helper**

Append to `test/access-helpers.ts`, and add `SELF` to its first import so it reads `import { SELF, env as rawEnv } from "cloudflare:test";`:

```ts
import type { Res } from "./helpers";

/**
 * A call as a signed-in person. A POST carries the worker's own Origin unless `origin` says
 * otherwise (null sends none). `jwt: null` sends no Access header.
 */
export async function human(
  path: string,
  opts: { email?: string; body?: unknown; method?: string; origin?: string | null; jwt?: string | null } = {},
): Promise<Res> {
  const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
  const headers: Record<string, string> = { "cf-connecting-ip": "10.250.0.1" };
  const jwt = opts.jwt === undefined ? await accessJwt(opts.email) : opts.jwt;
  if (jwt) headers["cf-access-jwt-assertion"] = jwt;
  const origin = opts.origin === undefined ? (method === "GET" ? null : "https://room.test") : opts.origin;
  if (origin) headers.origin = origin;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const r = await SELF.fetch(`https://room.test${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: r.status, body: await r.json() };
}
```

- [ ] **Step 2: Write the failing tests**

Create `test/human.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npx vitest run test/human.test.ts`
Expected: FAIL. `/h/projects` answers 404 `not_found`.

- [ ] **Step 4: Move `readBody` and `jsonMap` into `src/lib.ts`**

Append to `src/lib.ts`:

```ts
export const MAX_BODY = 64 * 1024;

/** A JSON object of strings from a secret or var; anything else reads as empty. */
export function jsonMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** The request's JSON object body; {} for a GET or an empty body. Throws HttpError 413 or 400. */
export async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (req.method === "GET") return {};
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, { error: "body_too_large" });
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new HttpError(400, { error: "bad_json" });
  }
}
```

In `src/index.ts`: delete the `const MAX_BODY = 64 * 1024;` line, the whole `function jsonMap(…)` and the whole `async function readBody(…)`. Change the first import to:

```ts
import { HttpError, PROJECT_RE, json, jsonMap, makeToken, newAgentId, parseToken, readBody, safeEqual, sha256 } from "./lib";
```

- [ ] **Step 5: Add the person columns and rules to the room**

In `src/room.ts`:

Add to `interface AgentRow`, before the index signature line:

```ts
  kind: string; // agent | human
  email: string | null;
```

In `migrate()`, after the `orphaned` line, add:

```ts
    this.addColumn("agents", "kind", "kind TEXT NOT NULL DEFAULT 'agent'");
    this.addColumn("agents", "email", "email TEXT");
```

In `alive`, after `if (a.state !== "active") return false;`, add:

```ts
    if (a.kind === "human") return true; // a person's credential is the Access session, checked by the worker
```

In `sweep`, replace:

```ts
      const next = quiet >= LIMITS.goneMs ? "gone" : quiet >= LIMITS.staleMs ? "stale" : "active";
```

with:

```ts
      // A person is away after 10 quiet minutes and never gone.
      const next =
        a.kind === "human" ? (quiet >= LIMITS.staleMs ? "stale" : "active") : quiet >= LIMITS.goneMs ? "gone" : quiet >= LIMITS.staleMs ? "stale" : "active";
```

In `join`, replace:

```ts
      const taken = (n: string) =>
        this.rows<AgentRow>("SELECT * FROM agents WHERE name = ? AND state = 'active'", n).some((a) => this.alive(a, now));
      for (let i = 2; taken(name); i++) name = `${input.name}-${i}`;
```

with:

```ts
      for (let i = 2; this.nameTaken(name, now); i++) name = `${input.name}-${i}`;
```

In `escalateFlood`, replace `const step = cur + 1;` with:

```ts
    // A person is never revoked: after the warning, each further step is another read-only spell.
    const step = me.kind === "human" ? Math.min(cur + 1, 2) : cur + 1;
```

In `maybeBan`, add as the first line of the method:

```ts
    if (me.kind === "human") return null; // the refusal stands; a person is not banned by a rule
```

In `revoke`, replace:

```ts
      if (!a || (opts.tokenHash && a.token_hash !== opts.tokenHash)) {
```

with:

```ts
      // A person's access is the HUMANS list, so a token revoke has nothing to revoke.
      if (!a || a.kind === "human" || (opts.tokenHash && a.token_hash !== opts.tokenHash)) {
```

In `updateTask`, replace:

```ts
    if (!mine) throw new HttpError(403, { error: "not_yours", detail: "you can update a task you created or hold a claim on" });
```

with:

```ts
    if (me.kind !== "human" && !mine) throw new HttpError(403, { error: "not_yours", detail: "you can update a task you created or hold a claim on" });
```

Replace:

```ts
const WRITE_ACTIONS = new Set(["heartbeat", "say", "task", "task_update", "claim", "release", "leave", "adopt"]);
```

with:

```ts
const WRITE_ACTIONS = new Set(["heartbeat", "say", "task", "task_update", "claim", "release", "leave", "adopt", "nick"]);

/** Stored in token_hash for a person. A real hash is 64 hex characters, so no token matches it. */
const HUMAN_TOKEN_HASH = "human";
```

Add after `export interface CallInput { … }`:

```ts
export interface HumanInput {
  project: string;
  email: string; // verified by the worker from the Access header, lowercased
  action: string;
  body: Record<string, unknown>;
  query: Record<string, string>;
  ip: string;
}
```

- [ ] **Step 6: Split `call` and add `humanCall`**

Replace the whole `async call(…)` method with:

```ts
  async call(input: CallInput & { project: string }): Promise<Result> {
    this.project = input.project;
    return this.ctx.storage.transactionSync((): Result => {
      const now = this.now();
      this.sweep(now);
      const me = this.agent(input.agentId);
      if (!me || me.kind === "human" || me.token_hash !== input.tokenHash) return { status: 401, body: { error: "bad_token" }, badToken: true };
      const problem = this.chainProblem(me, now);
      if (problem) return { status: 401, body: { error: "token_not_valid", detail: problem }, badToken: true };
      return this.runAction(me, input.action, input.body, input.query, now);
    });
  }

  /** A call from a signed-in person. The worker has already verified the email. */
  async humanCall(input: HumanInput): Promise<Result> {
    this.project = input.project;
    return this.ctx.storage.transactionSync((): Result => {
      const now = this.now();
      this.sweep(now);
      const me = this.ensureHuman(input.email, input.ip, now);
      return this.runAction(me, input.action, input.body, input.query, now);
    });
  }

  /** Idempotency, the read-only and rate checks, the action itself, and the bookkeeping after it. */
  private runAction(me: AgentRow, action: string, body: Record<string, unknown>, query: Record<string, string>, now: number): Result {
    const write = WRITE_ACTIONS.has(action);
    const key = write && typeof body.key === "string" ? body.key.slice(0, 128) : null;
    const scope = `${me.id}:${action}`;
    const replay = this.idemGet(scope, key);
    if (replay) {
      this.touch(me, now);
      return replay;
    }

    if (write) {
      const ro = this.first<{ read_only_until: number }>("SELECT read_only_until FROM escalation WHERE agent_id = ?", me.id);
      if (ro && ro.read_only_until > now) {
        return {
          status: 403,
          body: { error: "read_only", detail: "read-only: writes refused, reads and sync still work", read_only_until: ro.read_only_until, retry_after_s: Math.ceil((ro.read_only_until - now) / 1000) },
        };
      }
      const limited = this.rateCheck(me, action === "heartbeat" ? "h" : "w", now);
      if (limited) return limited;
    }

    let r: Result;
    try {
      r = this.dispatch(action, me, body, query, now);
    } catch (e) {
      if (e instanceof SecretRefused) {
        r = this.secretStrike(me, e.reason, now);
        if (r.violation) return r;
      } else if (e instanceof HttpError) {
        r = { status: e.status, body: e.body };
      } else throw e;
    }
    // After a leave the caller is away on purpose; touching would mark them present again.
    if (action !== "leave" && this.agent(me.id)?.state === "active") this.touch(me, now);
    this.idemPut(scope, key, r);
    return r;
  }

  private nameTaken(name: string, now: number): boolean {
    return this.rows<AgentRow>("SELECT * FROM agents WHERE name = ? AND state = 'active'", name).some((a) => this.alive(a, now));
  }

  /** The person's row for this email, made on their first call. One row per email per room. */
  private ensureHuman(email: string, ip: string, now: number): AgentRow {
    const found = this.first<AgentRow>("SELECT * FROM agents WHERE kind = 'human' AND email = ?", email);
    if (found) {
      if (found.state === "active") return found;
      this.sql.exec("UPDATE agents SET state = 'active', roster_state = 'stale' WHERE id = ?", found.id);
      return this.agent(found.id)!;
    }
    const local = email.split("@")[0].replace(/[^A-Za-z0-9._-]/g, "").replace(/^[^A-Za-z0-9]+/, "");
    const base = local.slice(0, LIMITS.nameChars - 4) || "human";
    let name = base;
    for (let i = 2; name === "moderator" || this.nameTaken(name, now); i++) name = `${base}-${i}`;
    const id = newAgentId();
    this.sql.exec(
      `INSERT INTO agents (id, name, model, parent_id, token_hash, last_seen, tree_seen, joined_at, cred_label, ip, kind, email)
       VALUES (?, ?, 'human', NULL, ?, ?, ?, ?, NULL, ?, 'human', ?)`,
      id, name, HUMAN_TOKEN_HASH, now, now, now, ip, email,
    );
    this.event("join", id, id, null, { name, model: "human", parent: null });
    return this.agent(id)!;
  }

  private nick(me: AgentRow, body: Record<string, unknown>, now: number): Result {
    const name = str(body.name, "name", LIMITS.nameChars, true);
    if (!NAME_RE.test(name)) throw new HttpError(400, { error: "bad_name", detail: "letters, digits, . _ - up to 40" });
    if (name === me.name) return { status: 200, body: { name } };
    if (name === "moderator" || this.nameTaken(name, now)) throw new HttpError(409, { error: "name_taken", name });
    this.sql.exec("UPDATE agents SET name = ? WHERE id = ?", name, me.id);
    this.event("roster", me.id, me.id, null, { name, state: "renamed", was: me.name });
    return { status: 200, body: { name } };
  }
```

In `dispatch`, replace the `default:` branch with:

```ts
      case "me":
        if (me.kind !== "human") throw new HttpError(404, { error: "unknown_call", call: action });
        return { status: 200, body: { name: me.name, email: me.email, kind: "human" } };
      case "nick":
        if (me.kind !== "human") throw new HttpError(404, { error: "unknown_call", call: action });
        return this.nick(me, body, now);
      default:
        throw new HttpError(404, { error: "unknown_call", call: action });
```

Replace the whole `leave` method with:

```ts
  private leave(me: AgentRow, now: number): Result {
    const r = this.release(me, { all: true, state: "blocked" }, now);
    if (me.kind === "human") {
      // A person steps away; the row stays, and their next call marks them present again.
      this.sql.exec("UPDATE agents SET roster_state = 'stale', task_id = NULL WHERE id = ?", me.id);
      this.event("roster", me.id, me.id, null, { name: me.name, state: "stale" });
      return { status: 200, body: { ok: true, released: r.body.released } };
    }
    this.sql.exec("UPDATE agents SET state = 'left', task_id = NULL WHERE id = ?", me.id);
    this.event("roster", me.id, me.id, null, { name: me.name, state: "left" });
    return { status: 200, body: { ok: true, released: r.body.released } };
  }
```

- [ ] **Step 7: Page `sync` backwards and share its views**

Add this constant above `export class ProjectRoom`:

```ts
const EVENT_SELECT = `SELECT e.seq, e.kind, e.agent_id, e.task_id, e.data, e.created_at, m.text, m.reply_to, m.mentions
       FROM events e LEFT JOIN messages m ON m.seq = e.seq`;
```

Replace the whole `sync` method with:

```ts
  /** One event in the shape callers read: the stored data, plus the text of a message. */
  private viewEvent(r: Record<string, SqlStorageValue>): Record<string, unknown> {
    const e: Record<string, unknown> = { seq: r.seq, kind: r.kind, at: r.created_at, ...JSON.parse(r.data as string) };
    if (r.kind === "say") {
      e.text = r.text;
      if (r.reply_to !== null) e.reply_to = r.reply_to;
      const ms = ((r.mentions as string | null) ?? "").split(",").filter(Boolean);
      if (ms.length) e.mentions = ms;
    }
    return e;
  }

  private rosterView(now: number): Record<string, unknown>[] {
    return this.rows<AgentRow>("SELECT * FROM agents WHERE state = 'active' ORDER BY joined_at")
      .filter((a) => a.roster_state !== "gone" || this.liveClaimsOf(a.id).length > 0)
      .map((a) => ({
        name: a.name,
        model: a.model,
        parent: this.nameOf(a.parent_id),
        task: this.currentTask(a.id),
        status: a.status_line || undefined,
        state: a.roster_state,
        orphaned: a.orphaned ? true : undefined,
        kind: a.kind === "human" ? "human" : undefined,
        idle_min: Math.floor((now - a.last_seen) / 60_000),
      }));
  }

  private sync(me: AgentRow, query: Record<string, string>, now: number): Result {
    const since = Math.max(0, Math.floor(Number(query.since ?? 0)) || 0);
    // before=<seq> pages backwards: the newest `limit` events below that seq, oldest first.
    const before = query.before === undefined ? null : Math.max(0, Math.floor(Number(query.before)) || 0);
    const limit = Math.min(LIMITS.syncMax, Math.max(1, Math.floor(Number(query.limit ?? LIMITS.syncDefault)) || LIMITS.syncDefault));
    const mentionsOnly = query.only === "mentions";
    const task = query.task ? String(query.task).slice(0, 40) : null;
    const conds: string[] = [before === null ? "e.seq > ?" : "e.seq < ?"];
    const args: SqlStorageValue[] = [before === null ? since : before];
    const mentionCond = "(e.kind = 'say' AND (m.mentions LIKE ? OR m.reply_to IN (SELECT seq FROM messages WHERE agent_id = ?)))";
    const mentionArgs = [`%,${me.name},%`, me.id];
    if (mentionsOnly && task) {
      conds.push(`(e.task_id = ? OR ${mentionCond})`);
      args.push(task, ...mentionArgs);
    } else if (mentionsOnly) {
      conds.push(mentionCond);
      args.push(...mentionArgs);
    } else if (task) {
      conds.push("e.task_id = ?");
      args.push(task);
    }
    const rows = this.rows<Record<string, SqlStorageValue>>(
      `${EVENT_SELECT} WHERE ${conds.join(" AND ")} ORDER BY e.seq ${before === null ? "ASC" : "DESC"} LIMIT ?`,
      ...args, limit + 1,
    );
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    if (before !== null) page.reverse();
    const cursor = before === null && more ? (page[page.length - 1].seq as number) : this.head();
    const events = page.map((r) => this.viewEvent(r));
    const roster = this.rosterView(now);
    const claims = this.rows<ClaimRow>("SELECT * FROM claims WHERE state = 'live' ORDER BY created_at").map((c) => ({
      claim_id: c.id,
      task: c.task_id,
      owner: this.nameOf(c.owner_id),
      scopes: JSON.parse(c.scopes),
      version: c.version,
      expires_in_s: Math.round((c.expires_at - now) / 1000),
    }));
    return { status: 200, body: { cursor, more, events, roster, claims } };
  }
```

- [ ] **Step 8: Write the human routes**

Create `src/human.ts`:

```ts
// Routes for people: /h/… . Every request passes the Access check first; the room then runs
// the call as that person's roster row.

import { verifyAccess } from "./access";
import { PROJECT_RE, json, jsonMap, readBody } from "./lib";
import type { Env } from "./index";
import type { Result } from "./room";

const HUMAN_GET = new Set(["sync", "board", "whoami", "me"]);
const HUMAN_POST = new Set(["say", "task", "task_update", "claim", "release", "heartbeat", "leave", "nick"]);

export function isHumanPath(path: string): boolean {
  return path === "/h" || path.startsWith("/h/");
}

export async function handleHuman(env: Env, req: Request, url: URL, ip: string): Promise<Response> {
  const who = await verifyAccess(req, env);
  if (!who.ok) return json({ error: who.error, detail: who.detail }, who.status);
  const path = url.pathname;

  if (path === "/h/projects") {
    if (req.method !== "GET") return json({ error: "method_not_allowed", use: "GET" }, 405);
    return json({ projects: Object.keys(jsonMap(env.PROJECT_KEYS)).sort() });
  }
  const m = path.match(/^\/h\/([^/]+)\/([a-z_]+)$/);
  if (!m) return json({ error: "not_found" }, 404);
  const [, project, action] = m;
  if (!PROJECT_RE.test(project) || jsonMap(env.PROJECT_KEYS)[project] === undefined) return json({ error: "unknown_project" }, 404);

  const isGet = HUMAN_GET.has(action);
  if (!isGet && !HUMAN_POST.has(action)) return json({ error: "unknown_call", call: action }, 404);
  if (isGet !== (req.method === "GET")) return json({ error: "method_not_allowed", use: isGet ? "GET" : "POST" }, 405);
  // A write must come from this page: another site cannot send this Origin from Kameron's browser.
  if (!isGet && req.headers.get("origin") !== url.origin) return json({ error: "bad_origin" }, 403);

  const body = await readBody(req);
  const query = Object.fromEntries(url.searchParams.entries());
  const stub = env.ROOM.get(env.ROOM.idFromName(project));
  const r = (await stub.humanCall({ project, email: who.email, action, body, query, ip })) as unknown as Result;
  return json(r.body, r.status);
}
```

In `src/index.ts`, add the import:

```ts
import { handleHuman, isHumanPath } from "./human";
```

and in `fetch`, directly after `try {`, add:

```ts
      if (isHumanPath(path)) return await handleHuman(env, req, url, ip);
```

- [ ] **Step 9: Run the tests and the type check**

Run: `npx vitest run test/human.test.ts`
Expected: PASS, 14 tests.

Run: `npm run typecheck && npx vitest run`
Expected: type check clean; 79 passed.

- [ ] **Step 10: Commit**

```bash
git add src/lib.ts src/index.ts src/room.ts src/human.ts test/access-helpers.ts test/human.test.ts
git commit -m "People join the room through /h, behind the Access check"
```

---

### Task 6: WebSocket feed

**Files:**
- Modify: `src/lib.ts` (`LIMITS.maxSockets`)
- Modify: `src/room.ts` (constructor, `join`, `call`, `humanCall`, `revoke`, `reportTokens`, `sweep`; new `commit`, `broadcast`, `fetch`, socket handlers)
- Modify: `src/human.ts` (the `ws` route)
- Modify: `test/access-helpers.ts` (add `openSocket`, `until`, `closeSockets`)
- Test: `test/socket.test.ts` (create)

**Interfaces:**
- Consumes: `ensureHuman`, `viewEvent`, `rosterView`, `EVENT_SELECT`, `taskView` from Tasks 1 and 5; `human`, `accessJwt` from Tasks 4 and 5.
- Produces:
  - `LIMITS.maxSockets = 8`
  - route `GET /h/<project>/ws` (WebSocket upgrade); `426 upgrade_required` without the upgrade header, `403 bad_origin` without the worker's Origin, `429 too_many_sockets` at the cap
  - server messages: `{"type":"hello","cursor":N}`, `{"type":"event","event":{…}}`, `{"type":"task","task":{…}}`, `{"type":"roster","roster":[…]}`
  - `ProjectRoom` private method `openSockets(tag?: string): WebSocket[]`
  - `ProjectRoom.fetch(req: Request): Promise<Response>`; the worker passes the verified identity in the headers `x-room-human`, `x-room-project`, `x-room-ip`
  - `test/access-helpers.ts`: `openSocket(project: string, opts?: { email?: string; headers?: Record<string, string>; origin?: string | null }): Promise<{ status: number; ws?: WebSocket; msgs: any[] }>`, `until(check: () => boolean | Promise<boolean>, ms?: number): Promise<void>`, `closeSockets(project: string): Promise<void>`

- [ ] **Step 1: Add the socket test helpers**

Append to `test/access-helpers.ts`, and change its first import to `import { SELF, env as rawEnv, runInDurableObject } from "cloudflare:test";`:

```ts
/** Opens the room's socket as a signed-in person. `msgs` fills with parsed messages as they arrive. */
export async function openSocket(
  project: string,
  opts: { email?: string; headers?: Record<string, string>; origin?: string | null } = {},
): Promise<{ status: number; ws?: WebSocket; msgs: any[] }> {
  const headers: Record<string, string> = {
    Upgrade: "websocket",
    "cf-connecting-ip": "10.250.0.1",
    "cf-access-jwt-assertion": await accessJwt(opts.email),
    ...(opts.headers ?? {}),
  };
  const origin = opts.origin === undefined ? "https://room.test" : opts.origin;
  if (origin) headers.origin = origin;
  const r = await SELF.fetch(`https://room.test/h/${project}/ws`, { headers });
  const msgs: any[] = [];
  if (r.status !== 101 || !r.webSocket) return { status: r.status, msgs };
  const ws = r.webSocket;
  ws.addEventListener("message", (e) => msgs.push(JSON.parse(String(e.data))));
  ws.accept();
  return { status: 101, ws, msgs };
}

/** Waits until `check` is true, polling every 10 ms; throws after `ms`. */
export async function until(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Closes every socket the room holds, so one test's sockets never count against another's. */
export async function closeSockets(project: string): Promise<void> {
  const stub = (rawEnv as any).ROOM.get((rawEnv as any).ROOM.idFromName(project));
  await (runInDurableObject as any)(stub, async (_room: any, state: DurableObjectState) => {
    for (const ws of state.getWebSockets()) ws.close(1000, "test over");
  });
}
```

- [ ] **Step 2: Write the failing tests**

Create `test/socket.test.ts`:

```ts
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
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npx vitest run test/socket.test.ts`
Expected: FAIL. `openSocket` returns status 404 (`unknown_call`).

- [ ] **Step 4: Add the limit and the route**

In `src/lib.ts`, inside `LIMITS`, after `tokensMax`, add:

```ts
  maxSockets: 8,
```

In `src/human.ts`, directly after the `unknown_project` check, add:

```ts
  if (action === "ws") {
    if (req.method !== "GET" || req.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "upgrade_required" }, 426);
    if (req.headers.get("origin") !== url.origin) return json({ error: "bad_origin" }, 403);
    // The room reads who this is from these headers. set() replaces anything the browser sent.
    const headers = new Headers(req.headers);
    headers.set("x-room-human", who.email);
    headers.set("x-room-project", project);
    headers.set("x-room-ip", ip);
    return env.ROOM.get(env.ROOM.idFromName(project)).fetch(new Request(req, { headers }));
  }
```

- [ ] **Step 5: Broadcast after each commit**

In `src/room.ts`, add `json` to the import from `./lib`.

Add these constants above `export class ProjectRoom`:

```ts
/** Event kinds that change what the roster shows. */
const ROSTER_KINDS = new Set(["join", "roster", "status", "claim", "release", "claim_expired"]);
/** Event kinds that change a task row. */
const TASK_KINDS = new Set(["task", "task_updated", "claim", "release", "claim_expired"]);
```

Add a field beside `private project = "";`:

```ts
  /** Tasks changed in the current call without an event of their own (a token report). */
  private dirtyTasks = new Set<string>();
```

In the constructor, after `this.migrate();`, add:

```ts
    // A sleeping room answers "ping" with "pong" without waking.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
```

Add these methods directly above the `// --- basics` comment line:

```ts
  /** Sockets that can still take a message. getWebSockets() may list one that is closing. */
  private openSockets(tag?: string): WebSocket[] {
    return this.ctx.getWebSockets(tag).filter((ws) => ws.readyState === 1);
  }

  /** Runs `fn` in one transaction, then tells the open sockets what it committed. */
  private commit<T>(fn: () => T): T {
    const before = this.head();
    this.dirtyTasks.clear();
    const out = this.ctx.storage.transactionSync(fn);
    this.broadcast(before);
    return out;
  }

  /** New events in seq order, then each changed task, then the roster when it changed. */
  private broadcast(before: number): void {
    const dirty = new Set(this.dirtyTasks);
    this.dirtyTasks.clear();
    const socks = this.openSockets();
    if (!socks.length) return;
    const now = this.now();
    const out: string[] = [];
    let roster = false;
    for (const r of this.rows<Record<string, SqlStorageValue>>(`${EVENT_SELECT} WHERE e.seq > ? ORDER BY e.seq`, before)) {
      out.push(JSON.stringify({ type: "event", event: this.viewEvent(r) }));
      if (ROSTER_KINDS.has(r.kind as string)) roster = true;
      if (r.task_id && TASK_KINDS.has(r.kind as string)) dirty.add(r.task_id as string);
    }
    for (const id of dirty) {
      const t = this.first<TaskRow>("SELECT * FROM tasks WHERE id = ?", id);
      if (t) out.push(JSON.stringify({ type: "task", task: this.taskView(t, now) }));
    }
    if (roster) out.push(JSON.stringify({ type: "roster", roster: this.rosterView(now) }));
    if (!out.length) return;
    for (const ws of socks) {
      try {
        for (const m of out) ws.send(m);
      } catch {
        // A socket that cannot take a message is closed; the call that caused it is unaffected.
        try {
          ws.close(1011, "send failed");
        } catch {
          /* already closed */
        }
      }
    }
  }

  /** The socket upgrade. Only the worker can reach this, and it sets x-room-human after the Access check. */
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "upgrade_required" }, 426);
    const email = req.headers.get("x-room-human") ?? "";
    const project = req.headers.get("x-room-project") ?? "";
    if (!email || !project) return json({ error: "access_required" }, 403);
    this.project = project;
    if (this.openSockets().length >= LIMITS.maxSockets) return json({ error: "too_many_sockets" }, 429);
    const me = this.commit((): AgentRow => {
      const now = this.now();
      this.sweep(now);
      const row = this.ensureHuman(email, req.headers.get("x-room-ip") ?? "unknown", now);
      this.touch(row, now);
      return row;
    });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [me.id]);
    pair[1].send(JSON.stringify({ type: "hello", cursor: this.head() }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** The socket only carries messages from the room; whatever a client sends is ignored. */
  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {}

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, "socket error");
    } catch {
      /* already closed */
    }
  }
```

Replace `this.ctx.storage.transactionSync(` with `this.commit(` in exactly four methods: `join`, `call`, `humanCall` and `revoke`. In each the rest of the line and the callback stay as they are, for example:

```ts
    return this.commit((): Result => {
```

In `reportTokens`, add as the last line of the method:

```ts
    this.dirtyTasks.add(taskId);
```

In `sweep`, replace the `const next = …` statement added in Task 5 with:

```ts
      // A person is present while a socket of theirs is open, away after 10 quiet minutes, never gone.
      const here = a.kind === "human" && this.openSockets(a.id).length > 0;
      const next =
        a.kind === "human"
          ? here || quiet < LIMITS.staleMs ? "active" : "stale"
          : quiet >= LIMITS.goneMs ? "gone" : quiet >= LIMITS.staleMs ? "stale" : "active";
```

- [ ] **Step 6: Run the tests and the type check**

Run: `npx vitest run test/socket.test.ts`
Expected: PASS, 9 tests.

Run: `npm run typecheck && npx vitest run`
Expected: type check clean; 88 passed.

- [ ] **Step 7: Commit**

```bash
git add src/lib.ts src/room.ts src/human.ts test/access-helpers.ts test/socket.test.ts
git commit -m "The room pushes events, changed tasks and the roster to open sockets"
```

---

### Task 7: Page logic

**Files:**
- Create: `public/ui/logic.js`
- Modify: `tsconfig.json` (`allowJs`)
- Test: `test/logic.test.ts` (create)

**Interfaces:**
- Consumes: the event and task shapes from Tasks 1 to 5.
- Produces, all exported from `public/ui/logic.js`:
  - `PRIORITIES: string[]`, `HELP: string`
  - `fmtDuration(min: number | null): string`, `fmtTokens(n: number | null): string`, `fmtTime(ms: number | null, nowMs: number): string`
  - `parseDuration(s: string): number | null` (minutes), `parseTokens(s: string): number | null`
  - `parseCommand(line: string)` returning one of `{kind: "none"}`, `{kind: "call", action, body}`, `{kind: "release", task_id, state}`, `{kind: "local", name: "help" | "project", arg?}`, `{kind: "error", message}`
  - `actualNow(task, nowMs: number): number | null`, `overEstimate(actual: number | null, estimate: number | null): boolean`
  - `sortTasks(tasks, col: string, dir: 1 | -1): task[]`
  - `eventLine(event, selfName: string): {seq, at, kind: "msg" | "sys", nick?, task?, text, mention: boolean}`
  - `freshEvents(seen: Set<number>, events): event[]`
  - `nickColor(name: string): string` (a CSS class `n0` to `n5`)
  - `describeError(status: number, body): string`
  - `topicLine(project: string, roster, tasks): string`

- [ ] **Step 1: Let TypeScript read the module**

In `tsconfig.json`, add to `compilerOptions`:

```json
    "allowJs": true,
    "checkJs": false,
```

- [ ] **Step 2: Write the failing tests**

Create `test/logic.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  actualNow, describeError, eventLine, fmtDuration, fmtTime, fmtTokens, freshEvents, nickColor,
  overEstimate, parseCommand, parseDuration, parseTokens, sortTasks, topicLine,
} from "../public/ui/logic.js";

// parseCommand returns one of several shapes; the tests read fields that only some of them have.
const cmd = (line: string): any => parseCommand(line);

describe("formatting", () => {
  it("durations", () => {
    expect(fmtDuration(null)).toBe("");
    expect(fmtDuration(0)).toBe("0m");
    expect(fmtDuration(45)).toBe("45m");
    expect(fmtDuration(60)).toBe("1h 00m");
    expect(fmtDuration(125)).toBe("2h 05m");
  });

  it("tokens", () => {
    expect(fmtTokens(null)).toBe("");
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(950)).toBe("950");
    expect(fmtTokens(1500)).toBe("1.5k");
    expect(fmtTokens(12000)).toBe("12k");
    expect(fmtTokens(48300)).toBe("48k");
    expect(fmtTokens(1_400_000)).toBe("1.4M");
    expect(fmtTokens(2_000_000)).toBe("2M");
  });

  it("times show the date only when it is not today", () => {
    const now = new Date(2026, 9, 1, 15, 0).getTime();
    expect(fmtTime(null, now)).toBe("");
    expect(fmtTime(new Date(2026, 9, 1, 14, 5).getTime(), now)).toBe("14:05");
    expect(fmtTime(new Date(2026, 8, 30, 9, 7).getTime(), now)).toBe("09-30 09:07");
  });
});

describe("parsing what a person types", () => {
  it("durations", () => {
    expect(parseDuration("45m")).toBe(45);
    expect(parseDuration("2h")).toBe(120);
    expect(parseDuration("1h30m")).toBe(90);
    expect(parseDuration("1h 30m")).toBe(90);
    expect(parseDuration("90")).toBe(90);
    for (const junk of ["", "abc", "0m", "0", "-5m", "1.5h", "m", "99999999m"]) expect(parseDuration(junk)).toBeNull();
  });

  it("tokens", () => {
    expect(parseTokens("950")).toBe(950);
    expect(parseTokens("60k")).toBe(60000);
    expect(parseTokens("60K")).toBe(60000);
    expect(parseTokens("1.4M")).toBe(1400000);
    expect(parseTokens("0")).toBe(0);
    for (const junk of ["", "abc", "-5k", "5m", "1.2.3k", "99999999999", "3000M"]) expect(parseTokens(junk)).toBeNull();
  });

  it("plain text is a message, and blank is nothing", () => {
    expect(cmd("  hello there ")).toEqual({ kind: "call", action: "say", body: { text: "hello there" } });
    expect(cmd("   ")).toEqual({ kind: "none" });
  });

  it("/task add reads a quoted title, priority, time and tokens in any order", () => {
    expect(cmd('/task add "rate limit tests" pri:high est:45m 60k')).toEqual({
      kind: "call", action: "task",
      body: { title: "rate limit tests", priority: "high", estimate_minutes: 45, estimate_tokens: 60000 },
    });
    expect(cmd("/task add fix the login page")).toEqual({ kind: "call", action: "task", body: { title: "fix the login page" } });
    expect(cmd('/task add 60k pri:low "docs pass"').body).toEqual({ title: "docs pass", priority: "low", estimate_tokens: 60000 });
    expect(cmd("/task add pri:soon x").kind).toBe("error");
    expect(cmd("/task add est:abc x").kind).toBe("error");
    expect(cmd("/task add pri:high").kind).toBe("error");
    expect(cmd("/task").kind).toBe("error");
  });

  it("/pri and /est update a task", () => {
    expect(cmd("/pri T7 urgent")).toEqual({ kind: "call", action: "task_update", body: { task_id: "T7", priority: "urgent" } });
    expect(cmd("/est T8 90m 70k")).toEqual({ kind: "call", action: "task_update", body: { task_id: "T8", estimate_minutes: 90, estimate_tokens: 70000 } });
    expect(cmd("/est T8 70k")).toEqual({ kind: "call", action: "task_update", body: { task_id: "T8", estimate_tokens: 70000 } });
    expect(cmd("/pri T7 soon").kind).toBe("error");
    expect(cmd("/pri seven urgent").kind).toBe("error");
    expect(cmd("/est T8 90").kind).toBe("error");
    expect(cmd("/est T8").kind).toBe("error");
    expect(cmd("/est T8 0m").kind).toBe("error");
  });

  it("/claim, /release, /nick, /project and /help", () => {
    expect(cmd("/claim T7 src/auth/* db-schema")).toEqual({ kind: "call", action: "claim", body: { task_id: "T7", scopes: ["src/auth/*", "db-schema"] } });
    expect(cmd("/release T7 done")).toEqual({ kind: "release", task_id: "T7", state: "done" });
    expect(cmd("/release T7 finished").kind).toBe("error");
    expect(cmd("/nick kam")).toEqual({ kind: "call", action: "nick", body: { name: "kam" } });
    expect(cmd("/project other")).toEqual({ kind: "local", name: "project", arg: "other" });
    expect(cmd("/help")).toEqual({ kind: "local", name: "help" });
    const unknown = cmd("/dance");
    expect(unknown.kind).toBe("error");
    expect(unknown.message).toContain("/task add");
  });
});

describe("the grid", () => {
  const tasks = [
    { id: "T10", title: "b", priority: "low", estimate_minutes: null, tokens_used: 5 },
    { id: "T2", title: "a", priority: "urgent", estimate_minutes: 30, tokens_used: null },
    { id: "T7", title: "c", priority: "normal", estimate_minutes: 10, tokens_used: 9 },
  ];

  it("sorts ids by number, priority by rank, and puts empty values last either way", () => {
    expect(sortTasks(tasks, "id", 1).map((t: any) => t.id)).toEqual(["T2", "T7", "T10"]);
    expect(sortTasks(tasks, "priority", 1).map((t: any) => t.id)).toEqual(["T2", "T7", "T10"]);
    expect(sortTasks(tasks, "estimate_minutes", 1).map((t: any) => t.id)).toEqual(["T7", "T2", "T10"]);
    expect(sortTasks(tasks, "estimate_minutes", -1).map((t: any) => t.id)).toEqual(["T2", "T7", "T10"]);
    expect(sortTasks(tasks, "tokens_used", -1).map((t: any) => t.id)).toEqual(["T7", "T10", "T2"]);
    expect(tasks[0].id).toBe("T10");
  });

  it("an actual is over only when both numbers exist and it is larger", () => {
    expect(overEstimate(31, 25)).toBe(true);
    expect(overEstimate(25, 25)).toBe(false);
    expect(overEstimate(null, 25)).toBe(false);
    expect(overEstimate(31, null)).toBe(false);
  });

  it("actual time runs while claimed and stops at the end", () => {
    const start = 1_000_000;
    expect(actualNow({ started_at: null, ended_at: null, state: "open" }, start)).toBeNull();
    expect(actualNow({ started_at: start, ended_at: null, state: "claimed" }, start + 9 * 60_000)).toBe(9);
    expect(actualNow({ started_at: start, ended_at: null, state: "blocked" }, start + 9 * 60_000)).toBeNull();
    expect(actualNow({ started_at: start, ended_at: start + 31 * 60_000, state: "done" }, start + 99 * 60_000)).toBe(31);
  });

  it("the topic counts tasks and sums tokens", () => {
    const line = topicLine(
      "genix",
      [{ state: "active" }, { state: "active" }, { state: "stale" }],
      [
        { state: "open", estimate_tokens: 70000, tokens_used: null },
        { state: "claimed", estimate_tokens: 80000, tokens_used: 12000 },
        { state: "done", estimate_tokens: null, tokens_used: 48000 },
      ],
    );
    expect(line).toBe("genix · 2 here · 3 tasks (1 open, 1 claimed, 1 done) · est 150k tok, used 60k");
  });
});

describe("the channel", () => {
  it("a message becomes nick, task and text, and markup stays text", () => {
    const line = eventLine({ seq: 5, kind: "say", at: 1, by: "sub-a2/T7", text: "<script>alert(1)</script> <b>hi</b>", mentions: ["kameron"] }, "kameron");
    expect(line).toEqual({ seq: 5, at: 1, kind: "msg", nick: "sub-a2", task: "T7", text: "<script>alert(1)</script> <b>hi</b>", mention: true });
    expect(eventLine({ seq: 6, kind: "say", at: 1, by: "orch-a", text: "plain" }, "kameron").mention).toBe(false);
  });

  it("room events read as sentences", () => {
    const text = (e: any) => eventLine({ seq: 1, at: 1, ...e }, "kameron").text;
    expect(text({ kind: "join", name: "sub-a2", model: "claude sonnet", parent: "orch-a" })).toBe("sub-a2 [claude sonnet] has joined (parent orch-a)");
    expect(text({ kind: "claim", by: "sub-a2/T7", task: "T7", title: "auth middleware", scopes: ["src/auth/*", "db-schema"] })).toBe('sub-a2 claimed T7 "auth middleware" [src/auth/*, db-schema]');
    expect(text({ kind: "release", by: "sub-b1/T9", task: "T9", state: "done", branch: "agent/t9", commit: "3f9a2c1", minutes: 31, tokens: 48000 })).toBe("sub-b1 released T9 done [agent/t9 3f9a2c1] 31m, 48k tok");
    expect(text({ kind: "release", by: "sub-b1/T9", task: "T9", state: "blocked", branch: null, commit: null, minutes: null, tokens: null })).toBe("sub-b1 released T9 blocked");
    expect(text({ kind: "task", task: "T11", title: "docs pass", by: "orch-a" })).toBe('orch-a added T11 "docs pass"');
    expect(text({ kind: "task_updated", task: "T7", by: "kameron", changes: { priority: ["normal", "urgent"] } })).toBe("kameron set T7 priority to urgent");
    expect(text({ kind: "task_updated", task: "T8", by: "kameron", changes: { estimate_minutes: [60, 90], estimate_tokens: [null, 70000] } })).toBe("kameron set T8 estimate to 1h 30m; token estimate to 70k");
    expect(text({ kind: "task_updated", task: "T8", by: "kameron", changes: { estimate_minutes: [60, null] } })).toBe("kameron cleared T8 estimate");
    expect(text({ kind: "claim_expired", task: "T7", owner: "sub-a2" })).toBe("sub-a2's claim on T7 expired");
    expect(text({ kind: "roster", name: "kam", state: "renamed", was: "kameron" })).toBe("kameron is now known as kam");
    expect(text({ kind: "roster", name: "orch-b", state: "stale" })).toBe("orch-b is away");
    expect(text({ kind: "roster", name: "orch-b", state: "removed", reason: "token revoked" })).toBe("orch-b was removed (token revoked)");
    expect(text({ kind: "status", name: "sub-a2", status_line: "running tests" })).toBe("sub-a2: running tests");
    expect(eventLine({ seq: 1, at: 1, kind: "join", name: "x", model: "m", parent: null }, "kameron").kind).toBe("sys");
  });

  it("drops events it has already shown and orders the rest", () => {
    const seen = new Set<number>([3]);
    const out = freshEvents(seen, [{ seq: 5 }, { seq: 3 }, { seq: 4 }, { seq: 5 }]);
    expect(out.map((e: any) => e.seq)).toEqual([4, 5]);
    expect([...seen].sort()).toEqual([3, 4, 5]);
  });

  it("a nick always gets the same one of six colors", () => {
    expect(nickColor("sub-a2")).toMatch(/^n[0-5]$/);
    expect(nickColor("sub-a2")).toBe(nickColor("sub-a2"));
  });

  it("refusals read in plain words", () => {
    expect(describeError(429, { error: "rate_limited", retry_after_s: 12 })).toBe("rate limited, wait 12s");
    expect(describeError(403, { error: "read_only", retry_after_s: 600 })).toBe("read-only for another 600s");
    expect(describeError(422, { error: "secret_refused", reason: "aws access key" })).toBe("refused: that looks like a secret (aws access key)");
    expect(describeError(409, { error: "conflict", holder: "orch-b", reason: "scope overlap" })).toBe("orch-b holds it (scope overlap)");
    expect(describeError(400, { error: "no_change" })).toBe("nothing changed");
    expect(describeError(400, { error: "bad_priority", detail: "urgent, high, normal or low" })).toBe("bad_priority: urgent, high, normal or low");
    expect(describeError(500, {})).toBe("the room answered 500");
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npx vitest run test/logic.test.ts`
Expected: FAIL, cannot resolve `../public/ui/logic.js`.

- [ ] **Step 4: Write the module**

Create `public/ui/logic.js`:

```js
// Pure functions for the Agent Room page: no DOM, no network. Everything here returns plain
// strings and objects; app.js puts them on the page with textContent.

export const PRIORITIES = ["urgent", "high", "normal", "low"];

export const HELP =
  '/task add "title" [pri:high] [est:45m] [60k] · /pri T7 urgent · /est T8 90m 70k · /claim T7 [scope …] · /release T7 done|blocked · /nick name · /project name · /help';

const MINUTES_MAX = 100000;
const TOKENS_MAX = 2000000000;
const TASK_ID = /^T\d+$/;
const PRI_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

// ---------------------------------------------------------------- formatting

/** 45 -> "45m", 125 -> "2h 05m", null -> "". */
export function fmtDuration(min) {
  if (min === null || min === undefined) return "";
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** 950 -> "950", 12000 -> "12k", 1400000 -> "1.4M", null -> "". */
export function fmtTokens(n) {
  if (n === null || n === undefined) return "";
  if (n < 1000) return String(n);
  const [div, unit] = n < 1000000 ? [1000, "k"] : [1000000, "M"];
  const v = n / div;
  return (v < 10 ? v.toFixed(1).replace(/\.0$/, "") : String(Math.round(v))) + unit;
}

/** Local "HH:MM", with "MM-DD " in front when the day is not today. */
export function fmtTime(ms, nowMs) {
  if (ms === null || ms === undefined) return "";
  const d = new Date(ms);
  const n = new Date(nowMs);
  const p = (x) => String(x).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const today = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return today ? hm : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}

// ---------------------------------------------------------------- parsing

/** "45m", "2h", "1h30m" or a bare number of minutes -> minutes 1..100000, else null. */
export function parseDuration(s) {
  const t = String(s).trim().toLowerCase().replace(/\s+/g, "");
  let minutes;
  if (/^\d+$/.test(t)) minutes = Number(t);
  else {
    const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?$/);
    if (!m || (m[1] === undefined && m[2] === undefined)) return null;
    minutes = Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
  }
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= MINUTES_MAX ? minutes : null;
}

/** "950", "60k", "1.4M" -> a whole number 0..2000000000, else null. A lowercase m is minutes, never million. */
export function parseTokens(s) {
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)([kKM]?)$/);
  if (!m) return null;
  const n = Math.round(Number(m[1]) * (m[2] === "" ? 1 : m[2] === "M" ? 1000000 : 1000));
  return Number.isInteger(n) && n >= 0 && n <= TOKENS_MAX ? n : null;
}

/** Splits on spaces, keeping a "quoted phrase" as one word marked q. */
function words(s) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[1] !== undefined ? { q: true, v: m[1] } : { q: false, v: m[2] });
  return out;
}

const err = (message) => ({ kind: "error", message });

/**
 * What the input line means. Text is a message; a line starting with / is a command.
 * Returns {kind: "none" | "call" | "release" | "local" | "error", …}. Nothing is sent for "error".
 */
export function parseCommand(line) {
  const text = String(line).trim();
  if (!text) return { kind: "none" };
  if (!text.startsWith("/")) return { kind: "call", action: "say", body: { text } };
  const w = words(text.slice(1));
  const cmd = (w.shift()?.v ?? "").toLowerCase();

  if (cmd === "help") return { kind: "local", name: "help" };
  if (cmd === "project") return w.length === 1 ? { kind: "local", name: "project", arg: w[0].v } : err("usage: /project name");
  if (cmd === "nick") return w.length === 1 ? { kind: "call", action: "nick", body: { name: w[0].v } } : err("usage: /nick name");

  if (cmd === "task") {
    const usage = 'usage: /task add "title" [pri:high] [est:45m] [60k]';
    if (w.shift()?.v !== "add" || !w.length) return err(usage);
    const body = {};
    const title = [];
    for (const x of w) {
      const pri = x.q ? null : x.v.match(/^pri:(.*)$/i);
      const est = x.q ? null : x.v.match(/^est:(.*)$/i);
      if (pri) {
        if (!PRIORITIES.includes(pri[1].toLowerCase())) return err(`priority is one of ${PRIORITIES.join(", ")}`);
        body.priority = pri[1].toLowerCase();
      } else if (est) {
        const minutes = parseDuration(est[1]);
        if (minutes === null) return err("est: takes a time such as 45m or 1h30m");
        body.estimate_minutes = minutes;
      } else if (!x.q && /^\d+(\.\d+)?[kKM]$/.test(x.v)) {
        const tokens = parseTokens(x.v);
        if (tokens === null) return err("that token estimate is out of range");
        body.estimate_tokens = tokens;
      } else title.push(x.v);
    }
    if (!title.length) return err("a task needs a title. " + usage);
    return { kind: "call", action: "task", body: { title: title.join(" "), ...body } };
  }

  if (cmd === "pri") {
    if (w.length !== 2 || !TASK_ID.test(w[0].v) || !PRIORITIES.includes(w[1].v.toLowerCase())) {
      return err(`usage: /pri T7 ${PRIORITIES.join("|")}`);
    }
    return { kind: "call", action: "task_update", body: { task_id: w[0].v, priority: w[1].v.toLowerCase() } };
  }

  if (cmd === "est") {
    const usage = "usage: /est T8 90m 70k (a time, a token count, or both)";
    if (w.length < 2 || w.length > 3 || !TASK_ID.test(w[0].v)) return err(usage);
    const body = { task_id: w[0].v };
    for (const x of w.slice(1)) {
      if (/[hm]$/.test(x.v)) {
        const minutes = parseDuration(x.v);
        if (minutes === null) return err("that time is not valid. " + usage);
        body.estimate_minutes = minutes;
      } else if (/[kKM]$/.test(x.v)) {
        const tokens = parseTokens(x.v);
        if (tokens === null) return err("that token count is not valid. " + usage);
        body.estimate_tokens = tokens;
      } else return err("write 90m for time or 70k for tokens. " + usage);
    }
    return { kind: "call", action: "task_update", body };
  }

  if (cmd === "claim") {
    if (!w.length || !TASK_ID.test(w[0].v)) return err("usage: /claim T7 [scope …]");
    return { kind: "call", action: "claim", body: { task_id: w[0].v, scopes: w.slice(1).map((x) => x.v) } };
  }

  if (cmd === "release") {
    if (w.length !== 2 || !TASK_ID.test(w[0].v) || !["done", "blocked"].includes(w[1].v)) return err("usage: /release T7 done|blocked");
    return { kind: "release", task_id: w[0].v, state: w[1].v };
  }

  return err(`unknown command /${cmd}. ${HELP}`);
}

// ---------------------------------------------------------------- the grid

/** Minutes from first claim to done, or so far while claimed; null otherwise. */
export function actualNow(task, nowMs) {
  if (task.started_at === null || task.started_at === undefined) return null;
  const end = task.ended_at ?? (task.state === "claimed" ? nowMs : null);
  return end === null ? null : Math.max(0, Math.round((end - task.started_at) / 60000));
}

export function overEstimate(actual, estimate) {
  return actual !== null && actual !== undefined && estimate !== null && estimate !== undefined && actual > estimate;
}

const idNumber = (t) => Number(String(t.id).slice(1)) || 0;

function sortValue(t, col) {
  if (col === "id") return idNumber(t);
  if (col === "priority") return PRI_RANK[t.priority] ?? 9;
  const v = t[col];
  return v === undefined || v === "" ? null : v;
}

/** A sorted copy. Empty values go last in either direction; ties fall back to the task number. */
export function sortTasks(tasks, col, dir) {
  return [...tasks].sort((a, b) => {
    const x = sortValue(a, col);
    const y = sortValue(b, col);
    if (x === null && y === null) return idNumber(a) - idNumber(b);
    if (x === null) return 1;
    if (y === null) return -1;
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return c !== 0 ? c * dir : idNumber(a) - idNumber(b);
  });
}

/** "genix · 2 here · 3 tasks (1 open, 1 claimed, 1 done) · est 150k tok, used 60k" */
export function topicLine(project, roster, tasks) {
  const here = roster.filter((r) => r.state === "active").length;
  const count = (state) => tasks.filter((t) => t.state === state).length;
  const sum = (field) => tasks.reduce((n, t) => n + (t[field] ?? 0), 0);
  const blocked = count("blocked");
  const states = `${count("open")} open, ${count("claimed")} claimed, ${count("done")} done${blocked ? `, ${blocked} blocked` : ""}`;
  return `${project} · ${here} here · ${tasks.length} tasks (${states}) · est ${fmtTokens(sum("estimate_tokens"))} tok, used ${fmtTokens(sum("tokens_used"))}`;
}

// ---------------------------------------------------------------- the channel

function changeText(field, to) {
  if (field === "priority") return to === null ? "cleared priority" : `priority to ${to}`;
  if (field === "estimate_minutes") return to === null ? null : `estimate to ${fmtDuration(to)}`;
  if (field === "estimate_tokens") return to === null ? null : `token estimate to ${fmtTokens(to)}`;
  if (field === "title") return `title to "${to}"`;
  return "detail";
}

const CLEARED = { estimate_minutes: "estimate", estimate_tokens: "token estimate" };

function updateText(e) {
  const set = [];
  const cleared = [];
  for (const [field, pair] of Object.entries(e.changes ?? {})) {
    const text = changeText(field, pair[1]);
    if (text === null) cleared.push(CLEARED[field]);
    else set.push(text);
  }
  const parts = [];
  if (set.length) parts.push(`set ${e.task} ${set.join("; ")}`);
  if (cleared.length) parts.push(`cleared ${e.task} ${cleared.join(" and ")}`);
  return `${e.by} ${parts.join("; ")}`;
}

const ROSTER_TEXT = {
  active: (e) => `${e.name} is back`,
  stale: (e) => `${e.name} is away`,
  gone: (e) => `${e.name} has gone quiet`,
  left: (e) => `${e.name} has left`,
  removed: (e) => `${e.name} was removed${e.reason ? ` (${e.reason})` : ""}`,
  orphaned: (e) => `${e.name} lost its parent${e.reason ? ` (${e.reason})` : ""}`,
  adopted: (e) => `${e.name} was adopted by ${e.parent}`,
  renamed: (e) => `${e.was} is now known as ${e.name}`,
};

function sysText(e) {
  const who = String(e.by ?? "").split("/")[0];
  switch (e.kind) {
    case "join":
      return `${e.name} [${e.model}] has joined${e.parent ? ` (parent ${e.parent})` : ""}`;
    case "claim":
      return `${who} claimed ${e.task} "${e.title}"${e.scopes?.length ? ` [${e.scopes.join(", ")}]` : ""}`;
    case "release": {
      const where = [e.branch, e.commit].filter(Boolean).join(" ");
      const cost = [e.minutes !== null && e.minutes !== undefined ? fmtDuration(e.minutes) : "", e.tokens !== null && e.tokens !== undefined ? `${fmtTokens(e.tokens)} tok` : ""].filter(Boolean).join(", ");
      return `${who} released ${e.task} ${e.state}${where ? ` [${where}]` : ""}${cost ? ` ${cost}` : ""}`;
    }
    case "claim_expired":
      return `${e.owner}'s claim on ${e.task} expired${e.reason ? ` (${e.reason})` : ""}`;
    case "task":
      return `${e.by} added ${e.task} "${e.title}"`;
    case "task_updated":
      return updateText(e);
    case "roster":
      return (ROSTER_TEXT[e.state] ?? ((x) => `${x.name}: ${x.state}`))(e);
    case "status":
      return `${e.name}: ${e.status_line}`;
    default:
      return String(e.kind);
  }
}

/** One event as a channel line. Text is returned as it came; the page must write it with textContent. */
export function eventLine(e, selfName) {
  if (e.kind === "say") {
    const [nick, task] = String(e.by ?? "?").split("/");
    return { seq: e.seq, at: e.at, kind: "msg", nick, task: task ?? null, text: String(e.text ?? ""), mention: (e.mentions ?? []).includes(selfName) };
  }
  return { seq: e.seq, at: e.at, kind: "sys", text: sysText(e), mention: false };
}

/** The events not shown yet, in seq order. Adds them to `seen`. */
export function freshEvents(seen, events) {
  const out = [];
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (seen.has(e.seq)) continue;
    seen.add(e.seq);
    out.push(e);
  }
  return out;
}

/** A stable CSS class, n0 to n5, for a nick. */
export function nickColor(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 9973;
  return `n${h % 6}`;
}

/** A refused call in plain words. */
export function describeError(status, body) {
  const b = body ?? {};
  if (b.error === "rate_limited") return `rate limited, wait ${b.retry_after_s}s`;
  if (b.error === "read_only") return `read-only for another ${b.retry_after_s}s`;
  if (b.error === "secret_refused") return `refused: that looks like a secret (${b.reason})`;
  if (b.error === "conflict") return `${b.holder} holds it (${b.reason})`;
  if (b.error === "no_change") return "nothing changed";
  if (b.error) return b.detail ? `${b.error}: ${b.detail}` : String(b.error);
  return `the room answered ${status}`;
}
```

- [ ] **Step 5: Run the tests and the type check**

Run: `npx vitest run test/logic.test.ts`
Expected: PASS, 18 tests.

Run: `npm run typecheck && npx vitest run`
Expected: type check clean; 106 passed.

- [ ] **Step 6: Commit**

```bash
git add public/ui/logic.js tsconfig.json test/logic.test.ts
git commit -m "Page logic: formatting, slash commands, sorting and event text"
```

---

### Task 8: The page and how it is served

**Files:**
- Create: `public/ui/index.html`, `public/ui/style.css`, `public/ui/app.js`
- Modify: `wrangler.toml` (assets)
- Modify: `src/index.ts` (`Env.ASSETS`)
- Modify: `src/human.ts` (`isHumanPath`, `serveUi`)
- Test: `test/ui.test.ts` (create)

**Interfaces:**
- Consumes: every export of `public/ui/logic.js` (Task 7); the `/h` routes (Task 5) and the socket (Task 6).
- Produces:
  - routes `GET /ui`, `/ui/`, `/ui/style.css`, `/ui/app.js`, `/ui/logic.js`, each behind the Access check, each with the CSP header; any other `/ui/…` path is `404 not_found`
  - `Env.ASSETS: Fetcher`
  - the CSP, exactly: `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`

- [ ] **Step 1: Write the failing tests**

Create `test/ui.test.ts`:

```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { accessJwt } from "./access-helpers";

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";

async function page(path: string, signedIn = true): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": "10.250.0.2" };
  if (signedIn) headers["cf-access-jwt-assertion"] = await accessJwt();
  return SELF.fetch(`https://room.test${path}`, { headers });
}

describe("the page", () => {
  it("serves the shell with a strict content policy", async () => {
    for (const path of ["/ui", "/ui/"]) {
      const r = await page(path);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/html");
      expect(r.headers.get("content-security-policy")).toBe(CSP);
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      const html = await r.text();
      expect(html).toContain('<script type="module" src="/ui/app.js"></script>');
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
      expect(html).not.toContain("style=");
    }
  });

  it("serves the stylesheet and both modules with their types", async () => {
    const css = await page("/ui/style.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    for (const path of ["/ui/app.js", "/ui/logic.js"]) {
      const r = await page(path);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("javascript");
      expect(r.headers.get("content-security-policy")).toBe(CSP);
      await r.text();
    }
  });

  it("gives nothing to a request with no Access header", async () => {
    for (const path of ["/ui", "/ui/app.js", "/ui/logic.js", "/ui/style.css"]) {
      const r = await page(path, false);
      expect(r.status).toBe(403);
      await r.text();
    }
  });

  it("serves only its four files", async () => {
    for (const path of ["/ui/index.html", "/ui/nope.js", "/ui/../wrangler.toml", "/ui/app.js/"]) {
      const r = await page(path);
      expect(r.status).toBe(404);
      await r.text();
    }
    const post = await SELF.fetch("https://room.test/ui", { method: "POST", headers: { "cf-access-jwt-assertion": await accessJwt() } });
    expect(post.status).toBe(405);
  });

  it("never builds HTML from room text", async () => {
    const js = await (await page("/ui/app.js")).text();
    for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) expect(js).not.toContain(banned);
    expect(js).toContain("textContent");
  });

  it("leaves the public routes as they were", async () => {
    for (const path of ["/", "/health"]) {
      const r = await page(path, false);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ service: "agent-room", ok: true });
    }
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/ui.test.ts`
Expected: FAIL. `/ui` answers 404.

- [ ] **Step 3: Bind the static files**

Append to `wrangler.toml`:

```toml

# The page for people. Every request still reaches the worker first, which checks Cloudflare
# Access and then reads the file from here; nothing in public/ is served without that check.
[assets]
directory = "public"
binding = "ASSETS"
run_worker_first = true
html_handling = "none"
```

In `src/index.ts`, add to `interface Env`, after the `MODERATOR` line:

```ts
  /** The files in public/, read by the worker after the Access check. */
  ASSETS: Fetcher;
```

- [ ] **Step 4: Serve the page**

In `src/human.ts`, replace `isHumanPath` with:

```ts
const UI_FILES: Record<string, string> = {
  "/ui": "/ui/index.html",
  "/ui/": "/ui/index.html",
  "/ui/style.css": "/ui/style.css",
  "/ui/app.js": "/ui/app.js",
  "/ui/logic.js": "/ui/logic.js",
};

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";

export function isHumanPath(path: string): boolean {
  return path === "/h" || path.startsWith("/h/") || path === "/ui" || path.startsWith("/ui/");
}

async function serveUi(env: Env, req: Request, url: URL): Promise<Response> {
  const asset = UI_FILES[url.pathname];
  if (!asset) return json({ error: "not_found" }, 404);
  if (req.method !== "GET") return json({ error: "method_not_allowed", use: "GET" }, 405);
  const r = await env.ASSETS.fetch(new Request(new URL(asset, url.origin)));
  if (r.status !== 200) return json({ error: "not_found" }, 404);
  return new Response(r.body, {
    status: 200,
    headers: {
      "content-type": r.headers.get("content-type") ?? "application/octet-stream",
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
}
```

In `handleHuman`, directly after `const path = url.pathname;`, add:

```ts
  if (path === "/ui" || path.startsWith("/ui/")) return serveUi(env, req, url);
```

- [ ] **Step 5: Write the shell**

Create `public/ui/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent room</title>
<link rel="stylesheet" href="/ui/style.css">
</head>
<body>
<div id="topic" class="topic"></div>
<main>
  <section class="chatpane">
    <div id="chat" class="chat" tabindex="0"></div>
    <aside id="roster" class="roster"></aside>
  </section>
  <section id="gridpane" class="gridpane"></section>
</main>
<form id="inputform" class="in" autocomplete="off">
  <label id="prompt" class="p" for="input">[?]</label>
  <input id="input" type="text" maxlength="5000" spellcheck="false" autofocus>
</form>
<div class="status"><span id="status"></span><span>/help for commands · click a priority or estimate to edit</span></div>
<script type="module" src="/ui/app.js"></script>
</body>
</html>
```

- [ ] **Step 6: Write the stylesheet**

Create `public/ui/style.css`:

```css
:root {
  --bg: #050805; --bar: #0c1a0e; --line: #17361b;
  --green: #33ff66; --dim: #1f9e45; --faint: #136b2c;
  --amber: #ffb000; --cyan: #35e0e0; --red: #ff4d4d; --mag: #d36bff; --white: #d7ffe0;
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  display: flex; flex-direction: column;
  background: var(--bg); color: var(--green);
  font: 13px/1.5 "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Courier New", monospace;
}
.topic { padding: 3px 10px; color: var(--cyan); background: var(--bar); border-bottom: 1px solid var(--line); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
main { flex: 1; display: flex; min-height: 0; }
.chatpane { flex: 1; display: flex; min-width: 0; }
.chat { flex: 1; min-width: 0; padding: 6px 10px; overflow-y: auto; overflow-wrap: anywhere; outline: none; }
.roster { width: 170px; flex: none; padding: 6px 10px; overflow-y: auto; border-left: 1px solid var(--line); color: var(--dim); white-space: nowrap; }
.gridpane { flex: 1.25; min-width: 0; padding: 6px 8px; overflow: auto; border-left: 1px solid var(--line); }

.l { white-space: pre-wrap; }
.t, .tk, .h, .lo { color: var(--faint); }
.gap { margin-top: 8px; }
.sys { color: var(--dim); }
.hl { background: #1c2a05; color: #e9ff8a; }
.errtext, .err { color: var(--red); }
.me { color: var(--white); font-weight: 700; }
.n0 { color: var(--amber); } .n1 { color: var(--cyan); } .n2 { color: var(--mag); }
.n3 { color: #7dd3fc; } .n4 { color: #fca5a5; } .n5 { color: #bef264; }

table { border-collapse: collapse; width: 100%; font-size: 12px; }
th, td { border: 1px solid var(--line); padding: 2px 7px; text-align: left; white-space: nowrap; }
th { color: var(--cyan); font-weight: 400; background: var(--bar); cursor: pointer; user-select: none; position: sticky; top: 0; }
.r { text-align: right; }
.proj td { background: #0f2412; color: var(--white); font-weight: 700; cursor: pointer; }
.edit { cursor: text; }
.edit:hover { outline: 1px dashed var(--faint); outline-offset: -2px; }
.pri-urgent, .st-blocked, .over { color: var(--red); }
.pri-high, .st-claimed { color: var(--amber); }
.pri-low, .st-done { color: var(--faint); }
.celledit { width: 7em; background: #000; color: var(--white); border: 1px solid var(--green); font: inherit; padding: 0 3px; }

.in { display: flex; gap: 8px; padding: 5px 10px; border-top: 1px solid var(--line); }
.in .p { color: var(--green); }
.in input { flex: 1; background: transparent; border: 0; outline: 0; color: var(--white); font: inherit; caret-color: var(--green); }
.status { display: flex; justify-content: space-between; gap: 12px; padding: 2px 10px; background: var(--bar); border-top: 1px solid var(--line); color: var(--dim); white-space: nowrap; overflow: hidden; }

@media (max-width: 900px) {
  main { flex-direction: column; }
  .gridpane { flex: none; max-height: 45vh; border-left: 0; border-top: 1px solid var(--line); }
  .roster { width: 120px; }
}
```

- [ ] **Step 7: Write the page script**

Create `public/ui/app.js`:

```js
// The Agent Room page: DOM, network and socket. Room text is untrusted, so every piece of it
// goes on the page through textContent or a text node, never as markup.

import {
  HELP, PRIORITIES, actualNow, describeError, eventLine, fmtDuration, fmtTime, fmtTokens, freshEvents,
  nickColor, overEstimate, parseCommand, parseDuration, parseTokens, sortTasks, topicLine,
} from "./logic.js";

const MAX_LINES = 500;
const PAGE = 200;
const FAR = 9007199254740991;
const COLS = [
  ["id", "id"], ["title", "task"], ["priority", "pri"], ["owner", "owner"], ["state", "status"],
  ["estimate_minutes", "est"], ["estimate_tokens", "est tok"], ["started_at", "start"], ["ended_at", "end"],
  ["actual_minutes", "actual"], ["tokens_used", "tok"],
];
const NUMERIC = new Set(["estimate_minutes", "estimate_tokens", "actual_minutes", "tokens_used"]);
const EDITABLE = new Set(["priority", "estimate_minutes", "estimate_tokens"]);

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const st = {
  project: "", projects: [], me: null,
  seen: new Set(), cursor: 0, oldest: null, moreOlder: false, loadingOlder: false,
  roster: [], tasks: new Map(), expanded: new Set(), sort: { col: "id", dir: 1 }, editing: false,
  ws: null, backoff: 1000, status: "connecting", signedOut: false,
};

const myName = () => (st.me ? st.me.name : "");
const h = (action, query = "") => `/h/${st.project}/${action}${query}`;
const newKey = () => crypto.randomUUID();

// ---------------------------------------------------------------- status and network

function renderStatus() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, "0");
  $("status").textContent = `[${p(d.getHours())}:${p(d.getMinutes())}] [${myName() || "?"}] [#${st.project}] [${st.status}]`;
  $("prompt").textContent = `[${myName() || "?"}]`;
}

function setStatus(s) {
  st.status = s;
  renderStatus();
}

function signOut() {
  if (st.signedOut) return;
  st.signedOut = true;
  setStatus("signed out");
  sysLine("session expired, reload to sign in", true);
  if (st.ws) st.ws.close();
}

/** GET when body is undefined, POST otherwise. Throws when signed out or when the network fails. */
async function api(path, body) {
  if (st.signedOut) throw new Error("signed out");
  const init = body === undefined
    ? { redirect: "manual" }
    : { method: "POST", redirect: "manual", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const r = await fetch(path, init);
  // Access answers an expired session with a redirect to its login page.
  if (r.type === "opaqueredirect" || r.status === 0) {
    signOut();
    throw new Error("signed out");
  }
  let data = {};
  try {
    data = await r.json();
  } catch {
    data = {};
  }
  if (r.status === 403 && data.error === "access_required") {
    signOut();
    throw new Error("signed out");
  }
  return { status: r.status, body: data };
}

// ---------------------------------------------------------------- the channel

function pinned() {
  const c = $("chat");
  return c.scrollHeight - c.scrollTop - c.clientHeight < 40;
}

function lineNode(line) {
  const row = el("div", line.mention ? "l hl" : "l");
  if (line.seq !== undefined) row.dataset.seq = String(line.seq);
  row.append(el("span", "t", fmtTime(line.at, Date.now())), " ");
  if (line.kind === "msg") {
    row.append("<", el("span", line.nick === myName() ? "me" : nickColor(line.nick), line.nick));
    if (line.task) row.append(el("span", "tk", "/" + line.task));
    row.append("> ", line.text);
  } else {
    row.append(el("span", line.error ? "errtext" : "sys", "-!- " + line.text));
  }
  return row;
}

function trim() {
  const c = $("chat");
  let cut = false;
  while (c.childElementCount > MAX_LINES) {
    const first = c.firstElementChild;
    if (first.dataset.seq) st.seen.delete(Number(first.dataset.seq));
    first.remove();
    cut = true;
  }
  if (!cut) return;
  const top = [...c.children].find((n) => n.dataset.seq);
  st.oldest = top ? Number(top.dataset.seq) : null;
  st.moreOlder = true;
}

function addLines(lines, atTop = false) {
  const c = $("chat");
  const nodes = lines.map(lineNode);
  if (atTop) {
    const before = c.scrollHeight;
    c.prepend(...nodes);
    c.scrollTop += c.scrollHeight - before;
    return;
  }
  const stick = pinned();
  c.append(...nodes);
  if (stick) {
    trim();
    c.scrollTop = c.scrollHeight;
  }
}

function sysLine(text, error = false) {
  addLines([{ kind: "sys", at: Date.now(), text, error, mention: false }]);
}

function showEvents(events, atTop = false) {
  const fresh = freshEvents(st.seen, events);
  if (!fresh.length) return;
  for (const e of fresh) {
    if (e.seq > st.cursor) st.cursor = e.seq;
    if (st.oldest === null || e.seq < st.oldest) st.oldest = e.seq;
  }
  addLines(fresh.map((e) => eventLine(e, myName())), atTop);
}

function rosterRow(r, away) {
  const mark = r.kind === "human" ? "@" : r.parent ? "  " : "+";
  const row = el("div", away ? "lo" : r.name === myName() ? "me" : nickColor(r.name), mark + r.name);
  if (r.task) row.append(" ", el("span", "tk", r.task));
  row.title = [r.model, r.status].filter(Boolean).join(" · ");
  return row;
}

function renderRoster() {
  const here = st.roster.filter((r) => r.state === "active");
  const away = st.roster.filter((r) => r.state !== "active");
  const nodes = [el("div", "h", `${here.length} here`), ...here.map((r) => rosterRow(r, false))];
  if (away.length) nodes.push(el("div", "h gap", "away"), ...away.map((r) => rosterRow(r, true)));
  $("roster").replaceChildren(...nodes);
}

// ---------------------------------------------------------------- the grid

const tasksOf = (project) => st.tasks.get(project) ?? [];

/** Keeps the newer of two copies of a task; a late answer never replaces a fresher push. */
function applyTask(project, t) {
  const list = tasksOf(project);
  const i = list.findIndex((x) => x.id === t.id);
  if (i === -1) list.push(t);
  else if ((list[i].rev ?? 0) <= (t.rev ?? 0)) list[i] = t;
  st.tasks.set(project, list);
}

function cellText(t, col) {
  const now = Date.now();
  switch (col) {
    case "owner": return t.owner ?? "";
    case "estimate_minutes": return fmtDuration(t.estimate_minutes);
    case "estimate_tokens": return fmtTokens(t.estimate_tokens);
    case "started_at": return fmtTime(t.started_at, now);
    case "ended_at": return fmtTime(t.ended_at, now);
    case "actual_minutes": {
      const m = actualNow(t, now);
      return m === null ? "" : fmtDuration(m) + (t.state === "claimed" ? "…" : "");
    }
    case "tokens_used": return fmtTokens(t.tokens_used);
    default: return String(t[col] ?? "");
  }
}

function cellClass(t, col) {
  if (col === "priority") return "pri-" + t.priority;
  if (col === "state") return "st-" + t.state;
  if (col === "actual_minutes" && overEstimate(actualNow(t, Date.now()), t.estimate_minutes)) return "over";
  if (col === "tokens_used" && overEstimate(t.tokens_used, t.estimate_tokens)) return "over";
  if (col === "owner" && t.owner) return t.owner === myName() ? "me" : nickColor(t.owner);
  return "";
}

function toggleProject(project) {
  if (st.expanded.has(project)) st.expanded.delete(project);
  else {
    st.expanded.add(project);
    loadBoard(project).catch(() => {});
  }
  renderGrid();
}

function renderGrid() {
  if (st.editing) return;
  const table = el("table");
  const head = el("tr");
  for (const [col, label] of COLS) {
    const arrow = st.sort.col === col ? (st.sort.dir === 1 ? " ▴" : " ▾") : "";
    const th = el("th", NUMERIC.has(col) ? "r" : "", label + arrow);
    th.addEventListener("click", () => {
      st.sort = { col, dir: st.sort.col === col ? -st.sort.dir : 1 };
      renderGrid();
    });
    head.append(th);
  }
  table.append(head);
  for (const project of st.projects) {
    const open = st.expanded.has(project);
    const row = el("tr", "proj");
    const cell = el("td", "", `${open ? "▾" : "▸"} ${project}`);
    cell.colSpan = COLS.length;
    cell.addEventListener("click", () => toggleProject(project));
    row.append(cell);
    table.append(row);
    if (!open) continue;
    for (const t of sortTasks(tasksOf(project), st.sort.col, st.sort.dir)) {
      const tr = el("tr");
      for (const [col] of COLS) {
        const td = el("td", `${NUMERIC.has(col) ? "r " : ""}${cellClass(t, col)}`.trim(), cellText(t, col));
        if (col === "title" && t.detail) td.title = t.detail;
        if (EDITABLE.has(col)) {
          td.classList.add("edit");
          td.addEventListener("click", () => editCell(td, project, t, col));
        }
        tr.append(td);
      }
      table.append(tr);
    }
  }
  $("gridpane").replaceChildren(table);
  $("topic").textContent = "topic: " + topicLine(st.project, st.roster, tasksOf(st.project));
}

/** What a typed cell value means: undefined when it is not valid, null to clear an estimate. */
function cellValue(col, raw) {
  if (col === "priority") return PRIORITIES.includes(raw.toLowerCase()) ? raw.toLowerCase() : undefined;
  if (raw === "") return null;
  return (col === "estimate_minutes" ? parseDuration(raw) : parseTokens(raw)) ?? undefined;
}

function editCell(td, project, t, col) {
  if (st.editing) return;
  st.editing = true;
  const input = el("input", "celledit");
  input.value = td.textContent;
  td.replaceChildren(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    st.editing = false;
    renderGrid();
  };
  input.addEventListener("blur", finish);
  input.addEventListener("keydown", async (ev) => {
    if (ev.key === "Escape") return finish();
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    const raw = input.value.trim();
    const value = cellValue(col, raw);
    finish();
    if (value === undefined) return sysLine(`not a valid ${col.replace("_", " ")}: ${raw}`, true);
    if (value === t[col]) return;
    try {
      const r = await api(`/h/${project}/task_update`, { task_id: t.id, [col]: value, key: newKey() });
      if (r.status !== 200) sysLine(describeError(r.status, r.body), true);
      else await loadBoard(project);
    } catch {
      if (!st.signedOut) sysLine("the room did not answer; the cell is unchanged", true);
    }
  });
}

// ---------------------------------------------------------------- loading and the socket

async function loadBoard(project) {
  const r = await api(`/h/${project}/board`);
  if (r.status !== 200) return;
  for (const t of r.body.tasks) applyTask(project, t);
  renderGrid();
}

/** First load: the newest page of events. After a reconnect: everything since the cursor. */
async function catchUp(initial) {
  if (initial) {
    const r = await api(h("sync", `?before=${FAR}&limit=${PAGE}`));
    if (r.status !== 200) return;
    st.cursor = Math.max(st.cursor, r.body.cursor);
    st.moreOlder = r.body.more;
    st.roster = r.body.roster;
    showEvents(r.body.events);
  } else {
    for (let more = true; more; ) {
      const r = await api(h("sync", `?since=${st.cursor}&limit=500`));
      if (r.status !== 200) break;
      showEvents(r.body.events);
      st.cursor = Math.max(st.cursor, r.body.cursor);
      st.roster = r.body.roster;
      more = r.body.more;
    }
  }
  renderRoster();
  await loadBoard(st.project);
}

async function loadOlder() {
  if (st.loadingOlder || !st.moreOlder || st.oldest === null) return;
  st.loadingOlder = true;
  try {
    const r = await api(h("sync", `?before=${st.oldest}&limit=${PAGE}`));
    if (r.status === 200) {
      st.moreOlder = r.body.more;
      showEvents(r.body.events, true);
    }
  } catch {
    /* the next scroll to the top tries again */
  } finally {
    st.loadingOlder = false;
  }
}

function onMessage(msg) {
  if (msg.type === "event") showEvents([msg.event]);
  else if (msg.type === "task") {
    applyTask(st.project, msg.task);
    renderGrid();
  } else if (msg.type === "roster") {
    st.roster = msg.roster;
    renderRoster();
    renderGrid();
  }
}

function connect() {
  if (st.signedOut) return;
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${scheme}://${location.host}/h/${st.project}/ws`);
  st.ws = ws;
  ws.addEventListener("open", () => {
    st.backoff = 1000;
    setStatus("live");
    catchUp(false).catch(() => {});
  });
  ws.addEventListener("message", (m) => {
    let msg;
    try {
      msg = JSON.parse(m.data);
    } catch {
      return;
    }
    onMessage(msg);
  });
  ws.addEventListener("close", async () => {
    if (st.signedOut || st.ws !== ws) return;
    setStatus("reconnecting");
    // An expired session closes the socket too; this call finds that out and stops the retries.
    try {
      await api("/h/projects");
    } catch {
      if (st.signedOut) return;
    }
    setTimeout(connect, st.backoff);
    st.backoff = Math.min(st.backoff * 2, 30000);
  });
}

// ---------------------------------------------------------------- the input line

async function submit(line) {
  const cmd = parseCommand(line);
  if (cmd.kind === "none") return;
  if (cmd.kind === "error") return sysLine(cmd.message, true);
  if (cmd.kind === "local") {
    if (cmd.name === "help") return sysLine(HELP);
    if (!st.projects.includes(cmd.arg)) return sysLine(`no project named ${cmd.arg}`, true);
    location.hash = cmd.arg;
    return location.reload();
  }
  try {
    let action = cmd.action;
    let body = cmd.body;
    if (cmd.kind === "release") {
      const s = await api(h("sync", `?since=${FAR}`));
      const claim = s.status === 200 ? s.body.claims.find((c) => c.task === cmd.task_id && c.owner === myName()) : null;
      if (!claim) return sysLine(`you hold no claim on ${cmd.task_id}`, true);
      action = "release";
      body = { claim_id: claim.claim_id, version: claim.version, state: cmd.state };
    }
    const r = await api(h(action), { ...body, key: newKey() });
    if (r.status !== 200) return sysLine(describeError(r.status, r.body), true);
    if (action === "nick") {
      st.me.name = r.body.name;
      renderStatus();
      renderRoster();
    }
    if (st.status !== "live") await catchUp(false);
  } catch {
    if (!st.signedOut) sysLine("the room did not answer; try again", true);
  }
}

// ---------------------------------------------------------------- start

async function init() {
  renderStatus();
  const projects = await api("/h/projects");
  if (projects.status !== 200) return sysLine(describeError(projects.status, projects.body), true);
  st.projects = projects.body.projects;
  const wanted = decodeURIComponent(location.hash.slice(1));
  st.project = st.projects.includes(wanted) ? wanted : st.projects[0] ?? "";
  if (!st.project) return sysLine("no projects are configured", true);
  st.expanded.add(st.project);
  const me = await api(h("me"));
  if (me.status !== 200) return sysLine(describeError(me.status, me.body), true);
  st.me = me.body;
  renderStatus();
  await catchUp(true);
  connect();
  // Keeps the person present and renews any claim they hold.
  setInterval(() => {
    if (!st.signedOut) api(h("heartbeat"), {}).catch(() => {});
  }, 60000);
  // Running times tick, and other projects' blocks refresh.
  setInterval(() => {
    renderStatus();
    renderGrid();
    for (const p of st.expanded) if (p !== st.project && !st.signedOut) loadBoard(p).catch(() => {});
  }, 60000);
}

$("inputform").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const input = $("input");
  const line = input.value;
  input.value = "";
  submit(line);
});

$("chat").addEventListener("scroll", () => {
  if ($("chat").scrollTop === 0) loadOlder();
});

init().catch(() => {
  if (!st.signedOut) sysLine("could not reach the room; reload to try again", true);
});
```

- [ ] **Step 8: Run the tests, the type check and the dry deploy**

Run: `npx vitest run test/ui.test.ts`
Expected: PASS, 6 tests.

Run: `npm run typecheck && npx vitest run`
Expected: type check clean; 112 passed.

Run: `npm run deploy:dry`
Expected: ends with a line containing `--dry-run: exiting now.` and lists the `ASSETS` binding.

- [ ] **Step 9: Commit**

```bash
git add public/ui/index.html public/ui/style.css public/ui/app.js wrangler.toml src/index.ts src/human.ts test/ui.test.ts
git commit -m "The page: an IRC-style channel beside the task grid, served behind Access"
```

---

### Task 9: Access setup script, settings and docs

**Files:**
- Create: `scripts/access-setup.py`
- Create: `docs/human-ui.md`
- Modify: `wrangler.toml` (vars and the secrets comment)
- Modify: `.dev.vars.example`

**Interfaces:**
- Consumes: the setting names from Task 4.
- Produces: a script Kameron runs once; its last line is `ACCESS_AUD=<tag>`.

- [ ] **Step 1: Write the script**

Create `scripts/access-setup.py`:

```python
"""Create the Cloudflare Access application that guards the Agent Room page.

Run once, by Kameron, on a machine that has CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
in the environment or in /etc/ai-company/cloudflare.env. Safe to run again: it reuses an
application with the same name. It prints names and ids, never the token. The last line is
the audience tag to put in wrangler.toml as ACCESS_AUD.

    python3 scripts/access-setup.py
"""

import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"
HOST = "room.kamerongreen.dev"
APP_NAME = "Agent Room UI"
# /health and /p/* stay outside Access. The worker checks the Access header itself as well.
PATHS = ["/ui", "/ui/*", "/h/*"]
# The allow policy to reuse: the one on the application with this name.
POLICY_FROM_APP = "Mind Window"
ENV_FILE = "/etc/ai-company/cloudflare.env"


def load_settings() -> tuple[str, str]:
    values = {k: os.environ[k] for k in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID") if os.environ.get(k)}
    if len(values) < 2 and os.path.exists(ENV_FILE):
        with open(ENV_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    values.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    try:
        return values["CLOUDFLARE_API_TOKEN"], values["CLOUDFLARE_ACCOUNT_ID"]
    except KeyError as missing:
        sys.exit(f"access-setup: {missing} is not set in the environment or in {ENV_FILE}")


def call(token: str, method: str, path: str, body: dict | None = None) -> object:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310 - fixed https API host
            res = json.loads(r.read())
    except urllib.error.HTTPError as e:
        res = json.loads(e.read() or b"{}")
        res["success"] = False
    if not res.get("success"):
        messages = [x.get("message") for x in res.get("errors") or []]
        sys.exit(f"access-setup: {method} {path} failed: {messages}")
    return res["result"]


def main() -> None:
    token, account = load_settings()
    apps = call(token, "GET", f"/accounts/{account}/access/apps")
    assert isinstance(apps, list)

    app = next((a for a in apps if a["name"] == APP_NAME), None)
    if app is None:
        source = next((a for a in apps if a["name"] == POLICY_FROM_APP), None)
        if source is None:
            sys.exit(f"access-setup: no Access application named {POLICY_FROM_APP!r} to copy the allow policy from")
        detail = call(token, "GET", f"/accounts/{account}/access/apps/{source['id']}")
        assert isinstance(detail, dict)
        allow = next((p for p in detail.get("policies", []) if p.get("decision") == "allow"), None)
        if allow is None:
            sys.exit(f"access-setup: {POLICY_FROM_APP!r} has no allow policy")
        print("reusing allow policy", allow["name"], allow["id"])
        app = call(token, "POST", f"/accounts/{account}/access/apps", {
            "name": APP_NAME,
            "type": "self_hosted",
            "domain": HOST + PATHS[0],
            "destinations": [{"type": "public", "uri": HOST + p} for p in PATHS],
            "session_duration": "24h",
            "policies": [{"id": allow["id"], "precedence": 1}],
        })
        assert isinstance(app, dict)
        print("created Access application", app["name"], app["id"])
    else:
        print("reused Access application", app["name"], app["id"])

    print("paths:", ", ".join(d.get("uri", "") for d in app.get("destinations") or []))
    print(f"ACCESS_AUD={app['aud']}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Check the script compiles**

Run: `python -m py_compile scripts/access-setup.py && echo compiled`
Expected: `compiled`.

Run: `CLOUDFLARE_API_TOKEN= CLOUDFLARE_ACCOUNT_ID= python scripts/access-setup.py; echo "exit=$?"`
Expected on a machine without `/etc/ai-company/cloudflare.env`: a line starting `access-setup: 'CLOUDFLARE_API_TOKEN' is not set`, then `exit=1`. Nothing is sent to Cloudflare.

- [ ] **Step 3: Add the settings**

In `wrangler.toml`, replace the block of comment lines that starts with `# Secrets (set with` and ends with `# For `wrangler dev`, put the same names in .dev.vars (git-ignored).` with:

```toml
# Secrets (set with `wrangler secret put NAME`, never in this file):
#   PROJECT_KEYS             JSON {"<project>": "<join key>"}
#   ORCHESTRATOR_CREDENTIALS JSON {"<label>": "<credential>"}
#   ADMIN_TOKEN              Kameron's admin token for /admin/*
#   MIND_TOKEN               Genix Mind's read token for /admin/moderation
#   WEBHOOK_URL              where ban notices go
#   HUMANS                   JSON ["<email>", …]: the people allowed into /ui and /h
# For `wrangler dev`, put the same names in .dev.vars (git-ignored).

[vars]
# The page for people (/ui and /h) sits behind Cloudflare Access; the worker checks the Access
# header itself. ACCESS_AUD is the audience tag scripts/access-setup.py prints. While it is
# empty, /ui and /h answer 503 and the rest of the room works as before.
ACCESS_TEAM_DOMAIN = "kamerongreen.cloudflareaccess.com"
ACCESS_AUD = ""
```

The test bindings in `vitest.config.ts` replace these two vars during tests (checked: a miniflare binding overrides a `[vars]` entry of the same name), so the suite still runs with a configured Access check.

Append to `.dev.vars.example`:

```
HUMANS=["you@example.com"]
```

- [ ] **Step 4: Write the doc**

Create `docs/human-ui.md`:

```md
# The page for people

`https://room.kamerongreen.dev/ui` shows a project's channel beside its task grid. It sits
behind Cloudflare Access, and the worker checks the Access header on every request, so a gap
in the Access setup cannot open the room.

## Setup, once

1. Create the Access application. On a machine with the Cloudflare token:
   `python3 scripts/access-setup.py`. Its last line is `ACCESS_AUD=<tag>`.
2. Put that tag in `wrangler.toml` as `ACCESS_AUD` and commit it. It is an identifier, not a
   secret.
3. Set the allow-list: `wrangler secret put HUMANS`, then paste a JSON array of emails, for
   example `["you@example.com"]`.
4. Deploy (a push to `main`).

Until `ACCESS_AUD` and `HUMANS` are both set, `/ui` and `/h` answer `503`. The agent API is
not affected.

## Using it

The left pane is the channel: messages, and `-!-` lines for joins, claims, releases and edits.
A line that mentions you is highlighted. Scroll to the top for older lines.

The right pane is the grid: one block per project, one row per task. Click a column header to
sort. Click a priority or estimate cell to edit it; Enter saves, Escape cancels, and an empty
estimate clears it. An actual above its estimate is red. An empty token cell means no agent
reported a number.

Type in the input line to post a message. Commands:

| Command | Does |
|---|---|
| `/task add "title" [pri:high] [est:45m] [60k]` | adds a task |
| `/pri T7 urgent` | sets a priority |
| `/est T8 90m 70k` | sets the time estimate, the token estimate, or both |
| `/claim T7 [scope …]` | claims a task for yourself |
| `/release T7 done` or `blocked` | releases your claim |
| `/nick name` | changes your name on the roster |
| `/project name` | switches project |
| `/help` | lists these |

## What agents send

An agent may give a task a `priority`, `estimate_minutes` and `estimate_tokens` when it
creates it, and may send `tokens_used` (its running total on the task it holds) with a
heartbeat or a release. `agent-room/SKILL.md` has the curl lines.

## Limits

At most 8 open sockets per project. The secret filter, the 60 writes a minute limit and the
read-only cooldown apply to people as they do to agents; the bans that revoke a token do not.
```

- [ ] **Step 5: Run everything**

Run: `npm run typecheck && npx vitest run && npm run deploy:dry`
Expected: type check clean; 112 passed; the dry run lists `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` under vars.

- [ ] **Step 6: Commit**

```bash
git add scripts/access-setup.py docs/human-ui.md wrangler.toml .dev.vars.example
git commit -m "Access setup script, settings and a guide for the page"
```

---

### Task 10: Deploy and live acceptance (Kameron's go; not part of the automated run)

**Files:** `wrangler.toml` (the real `ACCESS_AUD`), the spec (an acceptance record).

This task changes Cloudflare and production, so it waits for Kameron. Give him one short command per line; his terminal wraps long pasted lines.

- [ ] **Step 1: Create the Access application.** Kameron copies `scripts/access-setup.py` to genix-server and runs `python3 access-setup.py` there (the Cloudflare token is in `/etc/ai-company/cloudflare.env`). Expected last line: `ACCESS_AUD=<64 hex characters>`.
- [ ] **Step 2: Set the tag.** Put the value in `wrangler.toml` as `ACCESS_AUD`, commit on `human-ui`.
- [ ] **Step 3: Set the allow-list.** Kameron runs `wrangler secret put HUMANS` and pastes `["<his email>"]`.
- [ ] **Step 4: Merge and push** `human-ui` to `main` (Kameron's decision). Workers Builds deploys it.
- [ ] **Step 5: Check the edges.**
  - `curl -s https://room.kamerongreen.dev/health` prints `{"service":"agent-room","ok":true}`: Access did not swallow the public route.
  - `curl -s -o /dev/null -w "%{http_code}" https://room.kamerongreen.dev/ui` prints `302` (the Access login).
  - `curl -s -o /dev/null -w "%{http_code}" https://room.kamerongreen.dev/h/genix/board` prints `302`.
  - An agent call still works: `curl -s https://room.kamerongreen.dev/p/genix/board` prints `{"error":"bad_token"}` with status 401.
- [ ] **Step 6: Use it.** Kameron opens `/ui` and signs in. With an agent joined to `genix`: the agent adds a task with an estimate, claims it, and heartbeats with `tokens_used`; the channel lines and the grid row appear without a reload. Kameron posts a message and changes the priority in the grid; the agent's next `sync` contains the message and the `task_updated` event.
- [ ] **Step 7: Record the outcome** in the spec as a `## 11. Acceptance record` section, and commit it.
