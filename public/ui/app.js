// The Agent Room page: DOM, network and socket. Room text is untrusted, so every piece of it
// goes on the page through textContent or a text node, never as markup.

import {
  HELP, PRIORITIES, actualNow, describeError, eventLine, fmtDuration, fmtTime, fmtTokens, freshEvents,
  nickColor, overEstimate, parseCommand, parseDuration, parseTokens, sortTasks, topicLine,
} from "./logic.js";

const MAX_LINES = 500;
const PAGE = 200;
const FAR = 9007199254740991;
const PING_EVERY_MS = 30000;
const PONG_WAIT_MS = 10000;
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
  // While a catch-up runs, socket messages wait here and are applied in arrival order after it.
  catching: 0, queue: [], queueBroken: false,
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
  const lines = fresh.map((e) => eventLine(e, myName())).filter((line) => line !== null);
  if (lines.length) addLines(lines, atTop);
}

function rosterRow(r, away) {
  const mark = r.kind === "human" ? "@" : r.parent ? "\u00a0\u00a0" : "+";
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
  input.value = col === "estimate_tokens"
    ? (t.estimate_tokens === null || t.estimate_tokens === undefined ? "" : String(t.estimate_tokens))
    : td.textContent;
  const opened = input.value.trim();
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
    if (raw === opened) return finish();
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

/**
 * First load: the newest page of events. After a reconnect: everything since the cursor, paged
 * with a local cursor so an event the socket delivers meanwhile cannot skip part of the gap.
 * Returns false when the room refused a page. A failed catch-up after a reconnect closes the
 * socket, so the close handler retries; the messages queued meanwhile are dropped, because the
 * next catch-up reads them again.
 */
async function catchUp(initial) {
  if (initial) {
    const r = await api(h("sync", `?before=${FAR}&limit=${PAGE}`));
    if (r.status !== 200) {
      sysLine(describeError(r.status, r.body), true);
      return false;
    }
    st.cursor = Math.max(st.cursor, r.body.cursor);
    st.moreOlder = r.body.more;
    st.roster = r.body.roster;
    showEvents(r.body.events);
  } else {
    st.catching += 1;
    let ok = false;
    try {
      ok = await readSince();
    } finally {
      st.catching -= 1;
      if (!ok) st.queueBroken = true;
      if (st.catching === 0) {
        const queued = st.queue;
        const broken = st.queueBroken;
        st.queue = [];
        st.queueBroken = false;
        if (!broken) for (const msg of queued) onMessage(msg);
      }
      if (!ok && st.ws) st.ws.close();
    }
    if (!ok) return false;
  }
  renderRoster();
  await loadBoard(st.project);
  return true;
}

/** Reads every event after the cursor, page by page. False when the room refuses a page. */
async function readSince() {
  let cursor = st.cursor;
  for (let more = true; more; ) {
    const r = await api(h("sync", `?since=${cursor}&limit=500`));
    if (r.status !== 200) return false;
    showEvents(r.body.events);
    cursor = Math.max(cursor, r.body.cursor);
    st.roster = r.body.roster;
    more = r.body.more;
  }
  st.cursor = Math.max(st.cursor, cursor);
  return true;
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
  // A socket that died without a close frame looks like a quiet room. The room answers the
  // text ping with pong; no pong within PONG_WAIT_MS closes the socket, and the close handler
  // reconnects.
  let pongWait = null;
  const pinger = setInterval(() => {
    if (ws.readyState !== 1 || pongWait !== null) return;
    ws.send("ping");
    pongWait = setTimeout(() => ws.close(), PONG_WAIT_MS);
  }, PING_EVERY_MS);
  const stopPing = () => {
    clearInterval(pinger);
    clearTimeout(pongWait);
    pongWait = null;
  };
  ws.addEventListener("open", () => {
    catchUp(false).then(
      (ok) => {
        if (!ok || st.ws !== ws) return;
        st.backoff = 1000;
        setStatus("live");
      },
      (e) => console.warn("catch-up failed; the socket is closed and will reconnect", e),
    );
  });
  ws.addEventListener("message", (m) => {
    if (m.data === "pong") {
      clearTimeout(pongWait);
      pongWait = null;
      return;
    }
    let msg;
    try {
      msg = JSON.parse(m.data);
    } catch {
      return;
    }
    if (st.catching) st.queue.push(msg);
    else onMessage(msg);
  });
  ws.addEventListener("close", async () => {
    stopPing();
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
  if (!(await catchUp(true))) {
    sysLine("could not load the room; reload to try again", true);
    return;
  }
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
