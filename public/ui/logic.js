// Pure functions for the Agent Room page: no DOM, no network. Everything here returns plain
// strings and objects; app.js puts them on the page with textContent.

export const PRIORITIES = ["urgent", "high", "normal", "low"];

export const HELP =
  '/task add "title" [pri:high] [est:45m] [60k] \u00b7 /pri T7 urgent \u00b7 /est T8 90m 70k \u00b7 /claim T7 [scope \u2026] \u00b7 /release T7 done|blocked \u00b7 /nick name \u00b7 /project name \u00b7 /help \u00b7 //text sends a line that starts with /';

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
  // 999500 rounds to 1000k, so from there on it is written in millions.
  const [div, unit] = n < 999500 ? [1000, "k"] : [1000000, "M"];
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

/** "45m", "2h", "1h30m" or a bare number of minutes -> minutes 1..100000, else null. A capital M is million tokens, never minutes. */
export function parseDuration(s) {
  if (/M/.test(String(s))) return null;
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
const CAPITAL_M = "a capital M means million tokens";

/**
 * What the input line means. Text is a message; a line starting with / is a command.
 * Returns {kind: "none" | "call" | "release" | "local" | "error", …}. Nothing is sent for "error".
 */
export function parseCommand(line) {
  const text = String(line).trim();
  if (!text) return { kind: "none" };
  if (!text.startsWith("/")) return { kind: "call", action: "say", body: { text } };
  // "//" escapes the command slash: the message is the line with one slash removed.
  if (text.startsWith("//")) return { kind: "call", action: "say", body: { text: text.slice(1) } };
  const w = words(text.slice(1));
  const cmd = (w.shift()?.v ?? "").toLowerCase();

  if (cmd === "help") return { kind: "local", name: "help" };
  if (cmd === "project") return w.length === 1 ? { kind: "local", name: "project", arg: w[0].v } : err("usage: /project name");
  if (cmd === "nick") return w.length === 1 ? { kind: "call", action: "nick", body: { name: w[0].v } } : err("usage: /nick name");

  if (cmd === "task") {
    const usage = 'usage: /task add "title" [pri:high] [est:45m] [60k]';
    if (w.shift()?.v.toLowerCase() !== "add" || !w.length) return err(usage);
    const body = {};
    const title = [];
    for (const x of w) {
      const pri = x.q ? null : x.v.match(/^pri:(.*)$/i);
      const est = x.q ? null : x.v.match(/^est:(.*)$/i);
      if (pri) {
        if (!PRIORITIES.includes(pri[1].toLowerCase())) return err(`priority is one of ${PRIORITIES.join(", ")}`);
        body.priority = pri[1].toLowerCase();
      } else if (est) {
        if (/M$/.test(est[1])) return err(`est: takes a time; ${CAPITAL_M}, and time is written like 45m or 1h30m`);
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

// Control characters, and the bidi and zero-width characters that can make text read in an
// order other than the one it was written in.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** A single-line field made safe to show: each character UNSAFE matches becomes a visible dot. */
export function clean(s) {
  return String(s ?? "").replace(UNSAFE, "\u00b7");
}

function changeText(field, to) {
  if (field === "priority") return to === null ? "cleared priority" : `priority to ${to}`;
  if (field === "estimate_minutes") return to === null ? null : `estimate to ${fmtDuration(to)}`;
  if (field === "estimate_tokens") return to === null ? null : `token estimate to ${fmtTokens(to)}`;
  if (field === "title") return `title to "${to}"`;
  return field;
}

const CLEARED = { estimate_minutes: "estimate", estimate_tokens: "token estimate" };

function updateText(e) {
  const set = [];
  const cleared = [];
  let detail = false;
  for (const [field, pair] of Object.entries(e.changes ?? {})) {
    // The event says the detail changed without carrying the text.
    if (field === "detail") {
      detail = true;
      continue;
    }
    const text = changeText(field, pair[1]);
    if (text === null) cleared.push(CLEARED[field]);
    else set.push(text);
  }
  const parts = [];
  if (set.length) parts.push(`set ${e.task} ${set.join("; ")}`);
  if (cleared.length) parts.push(`cleared ${e.task} ${cleared.join(" and ")}`);
  if (detail) parts.push(`changed ${e.task} detail`);
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
    default:
      return String(e.kind);
  }
}

/**
 * One event as a channel line, or null for an event that makes no line (a status change shows
 * in the roster's tooltip). A message's first line is `text` and its continuation lines are
 * `more`; every other field is one line, passed through clean. The page must write all of it
 * with textContent.
 */
export function eventLine(e, selfName) {
  if (e.kind === "status") return null;
  if (e.kind === "say") {
    const [nick, task] = String(e.by ?? "?").split("/");
    const [text, ...more] = String(e.text ?? "").split(/\r\n|\n|\r/).map(clean);
    return {
      seq: e.seq, at: e.at, kind: "msg", nick: clean(nick), task: task === undefined ? null : clean(task),
      text, more, mention: (e.mentions ?? []).includes(selfName),
    };
  }
  // Every field of a room event is single-line, so cleaning the whole sentence cleans each field.
  return { seq: e.seq, at: e.at, kind: "sys", text: clean(sysText(e)), mention: false };
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
