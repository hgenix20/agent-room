// Boots the real public/ui/app.js against stub globals (document, WebSocket, fetch, location,
// timers) and drives its network code: the catch-up after a reconnect, status events, and the
// ping timer. The stubs hold only what app.js touches.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

class Node {
  children: (Node | string)[] = [];
  parent: Node | null = null;
  className = "";
  dataset: Record<string, string> = {};
  title = "";
  value = "";
  colSpan = 1;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  listeners: Record<string, ((ev: any) => void)[]> = {};
  classList = { add: (c: string) => { this.className = `${this.className} ${c}`.trim(); } };
  constructor(public tag: string) {}
  get textContent(): string {
    return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join("");
  }
  set textContent(v: string) {
    this.replaceChildren(String(v));
  }
  get elements(): Node[] {
    return this.children.filter((c): c is Node => typeof c !== "string");
  }
  get childElementCount(): number {
    return this.elements.length;
  }
  get firstElementChild(): Node | undefined {
    return this.elements[0];
  }
  private adopt(items: (Node | string)[]): (Node | string)[] {
    for (const n of items) if (typeof n !== "string") n.parent = this;
    return items;
  }
  append(...items: (Node | string)[]): void {
    this.children.push(...this.adopt(items));
  }
  prepend(...items: (Node | string)[]): void {
    this.children.unshift(...this.adopt(items));
  }
  replaceChildren(...items: (Node | string)[]): void {
    this.children = this.adopt(items);
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
  }
  addEventListener(type: string, fn: (ev: any) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  focus(): void {}
  select(): void {}
}

class StubSocket {
  static all: StubSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  listeners: Record<string, ((ev: any) => void)[]> = {};
  constructor(public url: string) {
    StubSocket.all.push(this);
  }
  addEventListener(type: string, fn: (ev: any) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  emit(type: string, ev: any = {}): void {
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }
  open(): void {
    this.readyState = 1;
    this.emit("open");
  }
  push(data: unknown): void {
    this.emit("message", { data: typeof data === "string" ? data : JSON.stringify(data) });
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
}

type Timer = { id: number; fn: () => void; ms: number; repeat: boolean };
const timers = new Map<number, Timer>();
let timerId = 0;
const addTimer = (fn: () => void, ms: number, repeat: boolean): number => {
  timerId += 1;
  timers.set(timerId, { id: timerId, fn, ms, repeat });
  return timerId;
};
const liveTimers = (ms: number, repeat: boolean): Timer[] => [...timers.values()].filter((t) => t.ms === ms && t.repeat === repeat);
/** Runs a one-shot timer as if its time had come. */
const fire = (t: Timer): void => {
  if (!t.repeat) timers.delete(t.id);
  t.fn();
};

// The fake room. Events are say lines from orch-a, except a status event at STATUS_SEQ.
const STATUS_SEQ = 101;
let head = 100;
let duringNextSince: (() => void) | null = null;
let sayAnswer: "ok" | "refuse" | "throw" = "ok";
const requests: string[] = [];
const event = (seq: number) =>
  seq === STATUS_SEQ
    ? { seq, at: 1, kind: "status", name: "orch-a", status_line: "working (Bash)" }
    : { seq, at: 1, kind: "say", by: "orch-a", text: `line ${seq}`, mentions: [] };
const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => event(from + i));

function answer(body: unknown) {
  return { type: "basic", status: 200, json: async () => body };
}

async function stubFetch(path: string) {
  requests.push(path);
  const url = new URL(path, "https://room.test");
  if (url.pathname === "/h/projects") return answer({ projects: ["genix"] });
  if (url.pathname === "/h/genix/me") return answer({ name: "kameron", kind: "human" });
  if (url.pathname === "/h/genix/board") return answer({ tasks: [] });
  if (url.pathname === "/h/genix/heartbeat") return answer({ ok: true });
  if (url.pathname === "/h/genix/say") {
    if (sayAnswer === "throw") throw new Error("network down");
    return sayAnswer === "refuse" ? { type: "basic", status: 400, json: async () => ({ error: "too_long" }) } : answer({ seq: 1 });
  }
  if (url.pathname === "/h/genix/sync") {
    const before = url.searchParams.get("before");
    if (before !== null) return answer({ cursor: head, more: false, events: range(1, Math.min(head, Number(before) - 1)), roster: [], claims: [] });
    if (duringNextSince) {
      const push = duringNextSince;
      duringNextSince = null;
      push();
    }
    const since = Number(url.searchParams.get("since"));
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const last = Math.min(head, since + limit);
    const more = head > since + limit;
    return answer({ cursor: more ? last : head, more, events: range(since + 1, last), roster: [], claims: [] });
  }
  throw new Error(`stub fetch: no route for ${path}`);
}

const ids = ["topic", "chat", "roster", "gridpane", "inputform", "prompt", "input", "status"];
const nodes: Record<string, Node> = {};
const saved: Record<string, unknown> = {};
const GLOBALS = ["document", "location", "WebSocket", "fetch", "setTimeout", "setInterval", "clearTimeout", "clearInterval"];
const realSetTimeout = globalThis.setTimeout;
/** Lets every pending promise in the page run; the stub fetch answers at once. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => realSetTimeout(r, 0));
};

const chat = () => nodes.chat;
const seqsOnScreen = () => chat().elements.filter((n) => n.dataset.seq).map((n) => Number(n.dataset.seq));
const socket = () => StubSocket.all[StubSocket.all.length - 1];

beforeAll(async () => {
  for (const id of ids) nodes[id] = new Node(id);
  // Scrolled up, so the page keeps every line and the test can read all of them.
  Object.assign(nodes.chat, { scrollHeight: 100000, scrollTop: 0, clientHeight: 500 });
  const g = globalThis as any;
  for (const k of GLOBALS) saved[k] = g[k];
  g.document = { getElementById: (id: string) => nodes[id], createElement: (tag: string) => new Node(tag) };
  // A malformed % in the hash falls back to the first project.
  g.location = { protocol: "https:", host: "room.test", hash: "#%zz", reload() {} };
  g.WebSocket = StubSocket;
  g.fetch = stubFetch;
  g.setTimeout = (fn: () => void, ms: number) => addTimer(fn, ms, false);
  g.setInterval = (fn: () => void, ms: number) => addTimer(fn, ms, true);
  g.clearTimeout = (id: number) => timers.delete(id);
  g.clearInterval = (id: number) => timers.delete(id);
  await import("../public/ui/app.js");
  await settle();
});

afterAll(() => {
  const g = globalThis as any;
  for (const k of GLOBALS) g[k] = saved[k];
});

describe("the page's network code", () => {
  it("boots, shows the newest page, and goes live once the catch-up after the socket opens succeeds", async () => {
    expect(seqsOnScreen()).toEqual(range(1, 100).map((e) => e.seq));
    expect(StubSocket.all.length).toBe(1);
    expect(nodes.status.textContent).not.toContain("[live]");
    socket().open();
    await settle();
    expect(nodes.status.textContent).toContain("[live]");
  });

  it("a status event adds no line and still moves the cursor", async () => {
    const before = chat().childElementCount;
    head = STATUS_SEQ;
    socket().push({ type: "event", event: event(STATUS_SEQ) });
    await settle();
    expect(chat().childElementCount).toBe(before);
    expect(chat().textContent).not.toContain("working (Bash)");
  });

  it("no ping timer survives a close, and an open socket sends ping and closes when no pong comes", async () => {
    expect(liveTimers(30000, true).length).toBe(1);
    fire(liveTimers(30000, true)[0]);
    expect(socket().sent).toEqual(["ping"]);
    expect(liveTimers(10000, false).length).toBe(1);
    socket().push("pong");
    expect(liveTimers(10000, false).length).toBe(0);
    // No pong this time: the page closes the socket.
    fire(liveTimers(30000, true)[0]);
    const first = socket();
    fire(liveTimers(10000, false)[0]);
    expect(first.readyState).toBe(3);
    expect(liveTimers(30000, true).length).toBe(0);
    expect(liveTimers(10000, false).length).toBe(0);
    await settle();
    expect(nodes.status.textContent).toContain("[reconnecting]");
  });

  it("a 700-event gap with one event pushed during the first page ends with every seq on screen, in order", async () => {
    // The room moves on while the page is away: 700 events, 102 to 801, with 801 pushed mid-page.
    head = 800;
    const retry = liveTimers(1000, false);
    expect(retry.length).toBe(1);
    fire(retry[0]);
    expect(StubSocket.all.length).toBe(2);
    const second = socket();
    duringNextSince = () => {
      head = 801;
      second.push({ type: "event", event: event(801) });
    };
    requests.length = 0;
    second.open();
    await settle();
    expect(requests.filter((r) => r.includes("since="))).toEqual([
      `/h/genix/sync?since=${STATUS_SEQ}&limit=500`,
      `/h/genix/sync?since=${STATUS_SEQ + 500}&limit=500`,
    ]);
    const expected = [...range(1, 100), ...range(STATUS_SEQ + 1, 801)].map((e) => e.seq);
    expect(seqsOnScreen()).toEqual(expected);
    expect(nodes.status.textContent).toContain("[live]");
    expect(liveTimers(30000, true).length).toBe(1);
  });

  it("each continuation line of a message is its own row behind the gutter mark, with no nick", async () => {
    head = 802;
    socket().push({ type: "event", event: { seq: 802, at: 1, kind: "say", by: "orch-a", text: "ok\n12:01 <kameron> approved", mentions: [] } });
    await settle();
    const rows = chat().elements.slice(-2);
    expect(rows[0].dataset.seq).toBe("802");
    expect(rows[0].textContent).toMatch(/<orch-a> ok$/);
    expect(rows[1].dataset.seq).toBeUndefined();
    expect(rows[1].textContent).toMatch(/^\u00a0+ \u2506 12:01 <kameron> approved$/);
    expect(rows[1].elements.some((n) => n.className === "gut")).toBe(true);
  });

  it("grid text cells pass through clean: title, owner and the detail tooltip", async () => {
    socket().push({
      type: "task",
      task: { id: "T1", title: "fix\u202elogin", owner: "sub\u200ba", detail: "see\u2066notes", state: "claimed", priority: "normal", rev: 1 },
    });
    await settle();
    const cells: Node[] = [];
    const walk = (n: Node) => {
      for (const c of n.elements) {
        if (c.tag === "td") cells.push(c);
        walk(c);
      }
    };
    walk(nodes.gridpane);
    const title = cells.find((c) => c.textContent.startsWith("fix"))!;
    expect(title.textContent).toBe("fix\u00b7login");
    expect(title.title).toBe("see\u00b7notes");
    expect(cells.some((c) => c.textContent === "sub\u00b7a")).toBe(true);
  });

  it("the input is cleared only when the room takes the line, and a refused line comes back", async () => {
    const send = async (text: string, clearMeanwhile = false) => {
      nodes.input.value = text;
      for (const fn of nodes.inputform.listeners.submit) fn({ preventDefault() {} });
      if (clearMeanwhile) nodes.input.value = "";
      await settle();
    };
    sayAnswer = "refuse";
    await send("refuse me");
    expect(nodes.input.value).toBe("refuse me");
    sayAnswer = "throw";
    await send("no answer", true);
    expect(nodes.input.value).toBe("no answer");
    sayAnswer = "ok";
    await send("hello");
    expect(nodes.input.value).toBe("");
  });

  it("a failed catch-up leaves the page off live and closes the socket so it retries", async () => {
    const third = socket();
    third.close();
    await settle();
    expect(liveTimers(30000, true).length).toBe(0);
    fire(liveTimers(1000, false)[0]);
    const fourth = socket();
    expect(fourth).not.toBe(third);
    const g = globalThis as any;
    g.fetch = async (path: string) => (path.includes("since=") ? { type: "basic", status: 500, json: async () => ({}) } : stubFetch(path));
    fourth.open();
    await settle();
    g.fetch = stubFetch;
    expect(fourth.readyState).toBe(3);
    expect(nodes.status.textContent).not.toContain("[live]");
    expect(liveTimers(30000, true).length).toBe(0);
  });
});
