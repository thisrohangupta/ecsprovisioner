// Loom web UI — vanilla JS, no build step.
import { CRDT, editsFromDiff } from "/crdt.js";

const main = document.getElementById("main");
const activityEl = document.getElementById("activity");
const SVGNS = "http://www.w3.org/2000/svg";

// The web UI can host several workspaces; every /api/ call is scoped to the
// one currently selected by appending ?ws=<id> (the server defaults to the cwd
// workspace when it's absent, so /api/workspaces itself needs no scoping).
let currentWs = null;
function withWs(path) {
  if (!currentWs || !path.startsWith("/api/") || path.startsWith("/api/workspaces")) return path;
  return path + (path.includes("?") ? "&" : "?") + "ws=" + encodeURIComponent(currentWs);
}

const api = {
  async get(path) {
    const r = await fetch(withWs(path));
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  },
  async send(method, path, body) {
    const r = await fetch(withWs(path), {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  },
  put: (p, b) => api.send("PUT", p, b),
  post: (p, b) => api.send("POST", p, b),
};

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

function svgEl(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

function toast(msg) {
  const t = el("div", { class: "toast" }, msg);
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 300);
  }, 2200);
}

// ---- minimal markdown -> html (display only) ----
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function markdown(md) {
  const lines = (md || "").replace(/\r\n/g, "\n").split("\n");
  let out = "", inCode = false, code = [], list = null, para = [];
  const inline = (t) => {
    let s = escapeHtml(t);
    s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, l, h) => `<a href="${escapeHtml(h)}" target="_blank">${l}</a>`);
    return s;
  };
  const flushP = () => { if (para.length) { out += `<p>${inline(para.join(" "))}</p>`; para = []; } };
  const closeL = () => { if (list) { out += `</${list}>`; list = null; } };
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (inCode) { out += `<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`; code = []; inCode = false; }
      else { flushP(); closeL(); inCode = true; }
      continue;
    }
    if (inCode) { code.push(line); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flushP(); closeL(); out += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; continue; }
    if (/^\s*[-*]\s+/.test(line)) { flushP(); if (list !== "ul") { closeL(); list = "ul"; out += "<ul>"; } out += `<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`; continue; }
    if (/^\s*\d+\.\s+/.test(line)) { flushP(); if (list !== "ol") { closeL(); list = "ol"; out += "<ol>"; } out += `<li>${inline(line.replace(/^\s*\d+\.\s+/, ""))}</li>`; continue; }
    if (/^\s*>\s?/.test(line)) { flushP(); closeL(); out += `<blockquote>${inline(line.replace(/^\s*>\s?/, ""))}</blockquote>`; continue; }
    if (line.trim() === "") { flushP(); closeL(); continue; }
    para.push(line.trim());
  }
  if (inCode) out += `<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`;
  flushP(); closeL();
  return out;
}

// ---- DAG state (node elements + visual status, keyed by "wf::step") ----
const dag = {
  nodes: new Map(),     // key -> <g>
  stateByKey: new Map(),// key -> "fresh"|"stale"|"unbuilt"|"building"|"error"
  selectedKey: null,
  detailEls: new Map(), // wfId -> detail panel element
  presenceEls: new Map(),// wfId -> card-header presence <span>
  focusList: [],        // [{ id, name, color, key }] — who's looking at which step
};

function applyNodeState(key, state) {
  if (state) dag.stateByKey.set(key, state);
  const g = dag.nodes.get(key);
  if (!g) return;
  const s = dag.stateByKey.get(key) || "unbuilt";
  g.setAttribute("class", `node ${s}${key === dag.selectedKey ? " selected" : ""}`);
}

// ---- live collaboration (presence + shared editing) ----
function loadIdentity() {
  try {
    const saved = JSON.parse(localStorage.getItem("loom.user"));
    if (saved && saved.name) return saved;
  } catch { /* ignore */ }
  const names = ["Maple", "Cedar", "Wren", "Onyx", "Sage", "Rowan", "Iris", "Flint", "Lark", "Juno"];
  const colors = ["#c2643c", "#3f8f5b", "#3b6fb0", "#9c4dcc", "#c08a2c", "#1c8a8a"];
  const me = {
    name: names[Math.floor(Math.random() * names.length)],
    color: colors[Math.floor(Math.random() * colors.length)],
  };
  localStorage.setItem("loom.user", JSON.stringify(me));
  return me;
}

const collab = {
  ws: null,         // the WebSocket connection
  wsId: null,       // the workspace id we're currently viewing
  clientId: null,
  site: 1,
  me: loadIdentity(),
  activePath: null,
  doc: null,        // CRDT for the open file
  lastText: "",     // last text we reconciled against
  focus: null,      // "<wfId>::<stepId>" we're viewing — presence in the DAG
  onSnapshot: null,
  onOps: null,
  onPresence: null,
  onCursors: null,
};

// Broadcast which workflow step we're looking at (or null). Deduped.
function setFocus(key) {
  if (collab.focus === key) return;
  collab.focus = key;
  sendCollab({ type: "focus", focus: key });
}

function sendCollab(obj) {
  if (collab.ws && collab.ws.readyState === WebSocket.OPEN) collab.ws.send(JSON.stringify(obj));
}
function closeActiveDoc() {
  if (collab.activePath) sendCollab({ type: "doc.close", path: collab.activePath });
  collab.activePath = null;
  collab.doc = null;
  collab.onSnapshot = collab.onOps = collab.onPresence = collab.onCursors = null;
}
function handleCollab(m) {
  if (m.data.ws && m.data.ws !== collab.wsId) return; // another workspace's traffic
  if (m.data.path !== collab.activePath) return;
  if (m.type === "doc.snapshot") collab.onSnapshot?.(m.data);
  else if (m.type === "doc.ops") { if (m.data.by !== collab.clientId) collab.onOps?.(m.data); }
  else if (m.type === "presence") collab.onPresence?.(m.data.users);
  else if (m.type === "doc.cursors") collab.onCursors?.(m.data.cursors);
}
function initials(name) {
  return (name || "?").trim().slice(0, 2).toUpperCase();
}

// ---- websocket live updates ----
let logSink = null; // function(text, cls) when a build log is on screen
function connectWS() {
  const dot = document.getElementById("conn-dot");
  const label = document.getElementById("conn-label");
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  collab.ws = ws;
  ws.onopen = () => { dot.className = "dot on"; label.textContent = "live"; };
  ws.onclose = () => {
    dot.className = "dot off"; label.textContent = "reconnecting…";
    setTimeout(connectWS, 1500);
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "hello") {
      collab.clientId = m.clientId;
      if (typeof m.site === "number") collab.site = m.site;
      if (!collab.wsId && m.ws) collab.wsId = m.ws;
      sendCollab({ type: "identify", name: collab.me.name, color: collab.me.color });
      // re-assert our workspace / doc / focus after a (re)connect
      if (collab.wsId) sendCollab({ type: "ws.select", ws: collab.wsId });
      if (collab.activePath) sendCollab({ type: "doc.open", path: collab.activePath });
      if (collab.focus) sendCollab({ type: "focus", focus: collab.focus });
      return;
    }
    if (m.type === "presence.focus") {
      if (m.data.ws && m.data.ws !== collab.wsId) return; // another workspace
      dag.focusList = m.data.focus || []; renderDagPresence(); return;
    }
    if (m.type === "doc.snapshot" || m.type === "doc.ops" || m.type === "presence" || m.type === "doc.cursors") return handleCollab(m);
    if (m.ws && m.ws !== collab.wsId) return; // build/file/export events from another workspace
    handleEvent(m);
  };
}

function pushActivity(text) {
  const li = el("li", { html: text });
  activityEl.prepend(li);
  while (activityEl.children.length > 60) activityEl.lastChild.remove();
}

function handleEvent(e) {
  const nodeKey = e.data && e.data.workflowId && e.data.stepId ? `${e.data.workflowId}::${e.data.stepId}` : null;
  switch (e.type) {
    case "hello": return;
    case "build.start":
      logSink?.(`build ${e.data.workflowId} → ${e.data.steps.join(" → ")}\n`, "dim");
      pushActivity(`build <b>${e.data.workflowId}</b> started`);
      break;
    case "step.start":
      logSink?.(`● ${e.data.stepId} (${e.data.type}) …\n`, "dim");
      if (nodeKey) applyNodeState(nodeKey, "building");
      break;
    case "step.delta":
      logSink?.(e.data.text, "");
      break;
    case "step.cached":
      logSink?.(`◌ ${e.data.stepId} cached\n`, "dim");
      if (nodeKey) applyNodeState(nodeKey, "fresh");
      break;
    case "step.done": {
      const u = e.data.usage || {};
      const cost = u.costUsd != null ? ` ~$${u.costUsd.toFixed(4)}` : "";
      logSink?.(`\n✓ ${e.data.stepId} (${e.data.bytes}B ${e.data.durationMs}ms${cost})\n`, "ok");
      if (nodeKey) applyNodeState(nodeKey, "fresh");
      break;
    }
    case "step.error":
      logSink?.(`\n✗ ${e.data.stepId}: ${e.data.error}\n`, "err");
      if (nodeKey) applyNodeState(nodeKey, "error");
      pushActivity(`<b>${e.data.stepId}</b> failed`);
      break;
    case "build.done":
      logSink?.(e.data.ok ? `\nbuild complete\n` : `\nbuild failed at ${e.data.failedAt}\n`, e.data.ok ? "ok" : "err");
      pushActivity(`build <b>${e.data.workflowId}</b> ${e.data.ok ? "done" : "failed"}`);
      if (view === "workflows") refreshStatuses();
      if (view === "metrics") renderMetrics();
      break;
    case "file.changed":
      pushActivity(`edited <b>${e.data.path}</b>`);
      toast(`Updated ${e.data.path}`);
      break;
    case "snapshot":
      pushActivity(`snapshot <b>${e.data.hash || ""}</b>`);
      break;
    case "export":
      pushActivity(`exported <b>${e.data.workflowId}</b>`);
      break;
  }
}

// ---- views ----
let view = "workflows";
let workspace = null;

document.querySelectorAll(".nav").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    view = btn.dataset.view;
    logSink = null;
    closeActiveDoc();
    setFocus(null); // leaving the board — drop our DAG presence
    render();
  }),
);

// ---- multi-workspace switcher ----
let workspaces = [];
async function loadWorkspaces() {
  const r = await api.get("/api/workspaces").catch(() => ({ workspaces: [], current: null }));
  workspaces = r.workspaces || [];
  if (!currentWs) currentWs = r.current || (workspaces[0] && workspaces[0].id) || null;
  renderWsSwitcher();
}
function renderWsSwitcher() {
  const host = document.getElementById("ws-switcher");
  if (!host) return;
  host.replaceChildren();
  const sel = el("select", { class: "ws-select", title: "Switch workspace" });
  for (const w of workspaces) {
    sel.append(el("option", { value: w.id, selected: w.id === currentWs ? "selected" : null }, w.name));
  }
  sel.onchange = () => switchWorkspace(sel.value);
  const addBtn = el("button", { class: "btn ghost small", title: "Add a workspace by path" }, "+");
  addBtn.onclick = addWorkspacePrompt;
  host.append(sel, addBtn);
}
async function addWorkspacePrompt() {
  const root = prompt("Path to a Loom workspace (a directory with loom.yaml):");
  if (!root) return;
  try {
    const { workspace: entry } = await api.post("/api/workspaces", { root });
    await loadWorkspaces();
    switchWorkspace(entry.id);
    toast(`Added ${entry.name}`);
  } catch (err) { toast(err.message); }
}
async function switchWorkspace(id) {
  if (!id || id === currentWs) return;
  closeActiveDoc();
  setFocus(null);
  // reset all DAG visual state so a step key shared between workspaces (e.g.
  // two "brief::outline"s) can't carry the old workspace's color or selection.
  dag.focusList = [];
  dag.stateByKey.clear();
  dag.selectedKey = null;
  currentWs = id;
  collab.wsId = id;
  sendCollab({ type: "ws.select", ws: id }); // move our presence to the new workspace
  await boot({ keepConn: true });
}

async function boot(opts = {}) {
  await loadWorkspaces();
  workspace = await api.get("/api/workspace");
  document.getElementById("ws-name").textContent = workspace.name;
  document.getElementById("ws-desc").textContent = workspace.description || "";
  const existingPill = document.querySelector(".mockpill");
  if (workspace.mock && !existingPill) {
    document.querySelector(".brand > div").append(el("span", { class: "mockpill" }, "mock"));
  } else if (!workspace.mock && existingPill) {
    existingPill.remove();
  }
  activityEl.replaceChildren();
  const events = await api.get("/api/events?limit=20").catch(() => ({ events: [] }));
  events.events.reverse().forEach((e) => handleEvent(e));
  if (!opts.keepConn) connectWS();
  render();
}

async function render() {
  workspace = await api.get("/api/workspace");
  if (view === "workflows") return renderWorkflows();
  if (view === "metrics") return renderMetrics();
  if (view === "inputs") return renderInputs();
  if (view === "context") return renderContext();
  if (view === "prompts") return renderPrompts();
  if (view === "artifacts") return renderArtifacts();
  if (view === "snapshots") return renderSnapshots();
  if (view === "share") return renderShare();
}

// ---- DAG layout ----
const NODE_W = 184, NODE_H = 54, COL_GAP = 64, ROW_GAP = 26, PAD = 16;

function layoutDag(wf) {
  const deps = {};
  wf.steps.forEach((s) => (deps[s.id] = []));
  wf.edges.forEach((e) => { if (deps[e.to]) deps[e.to].push(e.from); });

  const rank = {};
  const rk = (id, seen = new Set()) => {
    if (rank[id] != null) return rank[id];
    if (seen.has(id)) return 0;
    seen.add(id);
    let r = 0;
    for (const d of deps[id] || []) r = Math.max(r, rk(d, seen) + 1);
    return (rank[id] = r);
  };
  wf.steps.forEach((s) => rk(s.id));

  const cols = {};
  wf.steps.forEach((s) => { const r = rank[s.id]; (cols[r] = cols[r] || []).push(s); });
  const ranks = Object.keys(cols).map(Number);
  const maxRank = ranks.length ? Math.max(...ranks) : 0;
  const maxCol = Math.max(1, ...Object.values(cols).map((c) => c.length));

  const pos = {};
  for (let r = 0; r <= maxRank; r++) {
    const col = cols[r] || [];
    const offsetY = ((maxCol - col.length) * (NODE_H + ROW_GAP)) / 2;
    col.forEach((s, idx) => {
      pos[s.id] = { x: PAD + r * (NODE_W + COL_GAP), y: PAD + offsetY + idx * (NODE_H + ROW_GAP) };
    });
  }
  const width = PAD * 2 + (maxRank + 1) * NODE_W + maxRank * COL_GAP;
  const height = PAD * 2 + maxCol * NODE_H + (maxCol - 1) * ROW_GAP;
  return { pos, width, height };
}

function renderDagSvg(wf) {
  const { pos, width, height } = layoutDag(wf);
  const svg = svgEl("svg", { class: "dagsvg", width, height, viewBox: `0 0 ${width} ${height}` });

  // edges first (under nodes)
  for (const e of wf.edges) {
    const a = pos[e.from], b = pos[e.to];
    if (!a || !b) continue;
    const sx = a.x + NODE_W, sy = a.y + NODE_H / 2, tx = b.x, ty = b.y + NODE_H / 2;
    const dx = Math.max(28, (tx - sx) / 2);
    svg.append(svgEl("path", { class: "edge", d: `M${sx},${sy} C${sx + dx},${sy} ${tx - dx},${ty} ${tx},${ty}` }));
  }

  // nodes
  for (const step of wf.steps) {
    const p = pos[step.id];
    const key = `${wf.id}::${step.id}`;
    const g = svgEl("g", { class: "node unbuilt", transform: `translate(${p.x},${p.y})`,
      onclick: () => selectStep(wf, step.id) });
    g.append(
      svgEl("rect", { class: "nbox", width: NODE_W, height: NODE_H, rx: 11 }),
      svgEl("circle", { class: "ndot", cx: NODE_W - 15, cy: 16, r: 5 }),
      svgEl("text", { class: "nname", x: 13, y: 23 }, step.id),
      svgEl("text", { class: "ntype", x: 13, y: 41 }, `${step.type} → ${step.output}`),
      svgEl("g", { class: "npresence" }), // live viewer avatars (filled by renderDagPresence)
    );
    dag.nodes.set(key, g);
    if (dag.stateByKey.has(key)) applyNodeState(key);
    svg.append(g);
  }
  return svg;
}

// Paint "who's looking at what" avatars onto DAG nodes + workflow card headers.
function renderDagPresence() {
  const byKey = new Map();      // stepKey -> [user]
  const byWf = new Map();       // wfId    -> [user]
  for (const u of dag.focusList) {
    if (!u.key || u.id === collab.clientId) continue; // others only
    (byKey.get(u.key) || byKey.set(u.key, []).get(u.key)).push(u);
    const wfId = u.key.split("::")[0];
    (byWf.get(wfId) || byWf.set(wfId, []).get(wfId)).push(u);
  }
  const svgAvatar = (u, x) => {
    const a = svgEl("g", { class: "navatar", transform: `translate(${x},-1)` });
    a.append(
      svgEl("circle", { r: 9, fill: u.color }),
      svgEl("text", { class: "navinit", x: 0, y: 3 }, initials(u.name)),
      svgEl("title", {}, `${u.name} is viewing this step`),
    );
    return a;
  };
  for (const [key, g] of dag.nodes) {
    const layer = g.querySelector(".npresence");
    if (!layer) continue;
    layer.replaceChildren();
    const users = byKey.get(key) || [];
    users.slice(0, 4).forEach((u, i) => layer.append(svgAvatar(u, 16 + i * 15)));
    if (users.length > 4) {
      const more = svgEl("g", { class: "navatar more", transform: `translate(${16 + 4 * 15},-1)` });
      more.append(svgEl("circle", { r: 9 }), svgEl("text", { class: "navinit", x: 0, y: 3 }, `+${users.length - 4}`));
      layer.append(more);
    }
  }
  for (const [wfId, span] of dag.presenceEls) {
    const users = byWf.get(wfId) || [];
    span.replaceChildren(
      ...users.map((u) => el("span", { class: "avatar", style: `background:${u.color}`, title: `${u.name} · ${u.key.split("::")[1]}` }, initials(u.name))),
    );
    if (users.length) span.append(el("span", { class: "muted editing-note" }, `${users.length} viewing`));
  }
}

const statusMaps = {};
async function refreshStatuses() {
  for (const wf of workspace.workflows) {
    try {
      const { status } = await api.get(`/api/status?workflow=${encodeURIComponent(wf.id)}`);
      statusMaps[wf.id] = Object.fromEntries(status.map((s) => [s.stepId, s]));
      for (const s of status) {
        const state = s.fresh ? "fresh" : s.built ? "stale" : "unbuilt";
        const key = `${wf.id}::${s.stepId}`;
        if (dag.stateByKey.get(key) !== "building") applyNodeState(key, state);
      }
    } catch { /* ignore */ }
  }
}

async function renderWorkflows() {
  main.replaceChildren(el("h1", { class: "page" }, "Workflows"));
  dag.nodes.clear();
  dag.detailEls.clear();
  dag.presenceEls.clear();

  const newWfBtn = el("button", { class: "btn small" }, "+ New workflow");
  newWfBtn.onclick = () => newWorkflow();
  const yamlBtn = el("button", { class: "btn ghost small" }, "Edit loom.yaml");
  yamlBtn.onclick = () => editConfigYaml();
  main.append(el("div", { class: "row toolbar" }, newWfBtn, yamlBtn));

  if (!workspace.workflows.length) {
    main.append(el("p", { class: "empty" }, "No workflows yet — create one with “+ New workflow”."));
  }

  for (const wf of workspace.workflows) {
    const logEl = el("div", { class: "log", style: "display:none" });
    const setLog = () => {
      logSink = (t, cls) => {
        logEl.style.display = "block";
        logEl.append(el("span", cls ? { class: cls } : {}, t));
        logEl.scrollTop = logEl.scrollHeight;
      };
    };

    const buildBtn = el("button", { class: "btn small" }, "Build");
    buildBtn.onclick = async () => {
      setLog(); logEl.textContent = ""; buildBtn.disabled = true;
      try { await api.post("/api/build", { workflow: wf.id }); }
      catch (err) { toast(err.message); }
      finally { buildBtn.disabled = false; }
    };
    const forceBtn = el("button", { class: "btn ghost small" }, "Rebuild");
    forceBtn.onclick = async () => {
      setLog(); logEl.textContent = ""; forceBtn.disabled = true;
      try { await api.post("/api/build", { workflow: wf.id, force: true }); }
      catch (err) { toast(err.message); }
      finally { forceBtn.disabled = false; }
    };
    const exportBtn = el("button", { class: "btn ghost small" }, "Export");
    exportBtn.onclick = async () => {
      try { const { url } = await api.post("/api/export", { workflow: wf.id }); window.open(url, "_blank"); }
      catch (err) { toast(err.message); }
    };
    const addStepBtn = el("button", { class: "btn ghost small" }, "+ Step");
    addStepBtn.onclick = () => addStep(wf.id);

    const dagWrap = el("div", { class: "dag" }, renderDagSvg(wf));
    const detail = el("div", { class: "detail", style: "display:none" });
    dag.detailEls.set(wf.id, detail);
    const wfPresence = el("span", { class: "presence wf-presence" });
    dag.presenceEls.set(wf.id, wfPresence);

    main.append(
      el("div", { class: "card" },
        el("div", { class: "row" },
          el("h2", {}, wf.id),
          wfPresence,
          el("span", { class: "spacer" }),
          addStepBtn, buildBtn, forceBtn, exportBtn,
        ),
        wf.description ? el("p", { class: "muted" }, wf.description) : null,
        el("div", { class: "legend" },
          legendDot("fresh", "fresh"), legendDot("stale", "stale"),
          legendDot("unbuilt", "unbuilt"), legendDot("error", "error"),
          el("span", { class: "muted hint" }, "click a step to inspect its output and diffs"),
        ),
        dagWrap,
        logEl,
        detail,
      ),
    );
  }
  refreshStatuses();
  renderDagPresence(); // repaint viewer avatars onto the freshly built nodes
}

function legendDot(cls, label) {
  return el("span", { class: "legend-item" }, el("span", { class: `legend-dot ${cls}` }), label);
}

// ---- authoring: workflows, steps, raw config ----
function modal(title, body, onSave, saveLabel = "Save") {
  const err = el("div", { class: "banner", style: "display:none" });
  const overlay = el("div", { class: "overlay" });
  const saveB = el("button", { class: "btn" }, saveLabel);
  const cancelB = el("button", { class: "btn ghost" }, "Cancel");
  const close = () => overlay.remove();
  cancelB.onclick = close;
  saveB.onclick = async () => {
    err.style.display = "none";
    try {
      const ok = await onSave();
      if (ok !== false) close();
    } catch (e) {
      err.textContent = e.message || String(e);
      err.style.display = "block";
    }
  };
  overlay.append(el("div", { class: "modal" },
    el("div", { class: "row" }, el("h2", {}, title)),
    err, body,
    el("div", { class: "row", style: "justify-content:flex-end;gap:.5rem;margin-top:1rem" }, cancelB, saveB),
  ));
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.body.append(overlay);
}

async function refreshAndRender() {
  workspace = await api.get("/api/workspace");
  render();
}

async function loadConfig() {
  return (await api.get("/api/config")).config;
}

async function newWorkflow() {
  const id = prompt("New workflow id", "my-workflow");
  if (!id) return;
  const config = await loadConfig();
  if ((config.workflows || []).some((w) => w.id === id)) { toast("That id already exists."); return; }
  config.workflows = config.workflows || [];
  config.workflows.push({ id: id.trim(), description: "", steps: [] });
  try { await api.put("/api/config", { config }); toast("Workflow created"); refreshAndRender(); }
  catch (err) { toast(err.message); }
}

function field(labelText, control, hint) {
  return el("label", { class: "field" },
    el("span", { class: "field-label" }, labelText),
    control,
    hint ? el("span", { class: "field-hint" }, hint) : null);
}

async function addStep(wfId) {
  const config = await loadConfig();
  const wf = config.workflows.find((w) => w.id === wfId);
  if (!wf) return;

  const id = el("input", { class: "text", placeholder: "e.g. summarize" });
  const type = el("select", { class: "vers" }, el("option", { value: "inference" }, "inference"), el("option", { value: "agent" }, "agent"));
  const promptFile = el("input", { class: "text", placeholder: "prompt file in prompts/ (optional)" });
  const body = el("textarea", { class: "editor", style: "min-height:7rem", placeholder: "inline prompt / agent instructions (optional). Use {{inputs}} and {{var}}." });
  const inputs = el("input", { class: "text", placeholder: "inputs/*.md, step:other, context:style" });
  const output = el("input", { class: "text", placeholder: "e.g. result.md" });
  const model = el("input", { class: "text", placeholder: "(optional) e.g. claude-opus-4-8" });
  const agentDir = el("input", { class: "text", placeholder: "(agent) working dir, e.g. site" });
  const agentRow = field("Agent working dir", agentDir);
  agentRow.style.display = "none";
  type.onchange = () => { agentRow.style.display = type.value === "agent" ? "" : "none"; };

  const form = el("div", { class: "form" },
    field("Step id", id),
    field("Type", type),
    field("Prompt file", promptFile, "a file in prompts/ — or use the inline box below"),
    field("Inline prompt / instructions", body),
    field("Inputs (comma-separated)", inputs),
    field("Output file", output),
    field("Model", model),
    agentRow,
  );

  modal(`Add step to “${wfId}”`, form, async () => {
    const step = { id: id.value.trim(), type: type.value, output: output.value.trim() };
    if (!step.id || !step.output) throw new Error("Step id and output are required.");
    if (model.value.trim()) step.model = model.value.trim();
    const inps = inputs.value.split(",").map((s) => s.trim()).filter(Boolean);
    if (inps.length) step.inputs = inps;
    if (type.value === "inference") {
      if (promptFile.value.trim()) step.prompt = promptFile.value.trim();
      else if (body.value.trim()) step.promptText = body.value;
    } else {
      if (body.value.trim()) step.instructions = body.value;
      else if (promptFile.value.trim()) step.prompt = promptFile.value.trim();
      if (agentDir.value.trim()) step.agentDir = agentDir.value.trim();
    }
    wf.steps.push(step);
    await api.put("/api/config", { config }); // server validates; throws on bad config
    toast("Step added");
    refreshAndRender();
  }, "Add step");
}

async function editConfigYaml() {
  const { raw } = await api.get("/api/config");
  const ta = el("textarea", { class: "editor", style: "min-height:55vh" });
  ta.value = raw;
  modal("Edit loom.yaml", el("div", { class: "form" }, field("Workspace config (validated on save)", ta)), async () => {
    await api.put("/api/config", { raw: ta.value }); // throws on invalid → shown in modal
    toast("Config saved");
    refreshAndRender();
  });
}

async function selectStep(wf, stepId) {
  const key = `${wf.id}::${stepId}`;
  const prev = dag.selectedKey;
  dag.selectedKey = key;
  if (prev) applyNodeState(prev);
  applyNodeState(key);
  setFocus(key); // tell peers which step we're inspecting

  const step = wf.steps.find((s) => s.id === stepId);
  const detail = dag.detailEls.get(wf.id);
  detail.style.display = "block";
  const content = el("div", { class: "detail-body" });
  const tabs = el("div", { class: "tabs" });
  const tab = (name, fn) => {
    const b = el("button", { class: "tab" }, name);
    b.onclick = () => {
      tabs.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      b.classList.add("active");
      fn(content);
    };
    return b;
  };
  const outputTab = tab("Output", (c) => renderOutputTab(c, wf.id, stepId));
  const diffTab = tab("Diff", (c) => renderDiffTab(c, wf.id, stepId));
  tabs.append(outputTab, diffTab);

  detail.replaceChildren(
    el("div", { class: "detail-head" },
      el("strong", {}, stepId),
      el("span", { class: "pill" }, step.type),
      el("span", { class: "muted" }, `→ ${step.output}`),
      el("span", { class: "spacer" }),
      el("button", { class: "btn ghost small", onclick: () => { detail.style.display = "none"; setFocus(null); if (dag.selectedKey) { const k = dag.selectedKey; dag.selectedKey = null; applyNodeState(k); } } }, "✕"),
    ),
    tabs, content,
  );
  outputTab.click();
}

async function renderOutputTab(container, wfId, stepId) {
  container.replaceChildren(el("p", { class: "muted" }, "Loading…"));
  try {
    const { content } = await api.get(`/api/step-output?workflow=${encodeURIComponent(wfId)}&step=${encodeURIComponent(stepId)}`);
    container.replaceChildren(el("div", { class: "output", html: markdown(content) }));
  } catch {
    container.replaceChildren(el("p", { class: "empty" }, "Not built yet — run the workflow."));
  }
}

async function renderDiffTab(container, wfId, stepId) {
  container.replaceChildren(el("p", { class: "muted" }, "Loading…"));
  let history;
  try {
    history = await api.get(`/api/artifact-history?workflow=${encodeURIComponent(wfId)}&step=${encodeURIComponent(stepId)}`);
  } catch {
    container.replaceChildren(el("p", { class: "empty" }, "No history yet."));
    return;
  }
  const versions = history.versions;
  if (versions.length < 2) {
    container.replaceChildren(el("p", { class: "empty" },
      "Only one version so far. Edit an input or prompt and rebuild to compare versions."));
    return;
  }
  const label = (v) => `${new Date(v.createdAt).toLocaleString()} · ${v.key.slice(0, 8)}${v.current ? " (current)" : ""}`;
  const opt = (v) => el("option", { value: v.key }, label(v));
  const fromSel = el("select", { class: "vers" }, ...versions.map(opt));
  const toSel = el("select", { class: "vers" }, ...versions.map(opt));
  toSel.value = versions[0].key;   // newest / current
  fromSel.value = versions[1].key; // previous

  const diffBox = el("div", { class: "diffbox" });
  const load = () => renderDiffInto(diffBox, fromSel.value, toSel.value);
  fromSel.onchange = load;
  toSel.onchange = load;

  container.replaceChildren(
    el("div", { class: "vers-row" },
      el("span", { class: "muted" }, "from"), fromSel,
      el("span", { class: "arrow" }, "→"),
      el("span", { class: "muted" }, "to"), toSel,
    ),
    diffBox,
  );
  load();
}

async function renderDiffInto(box, fromKey, toKey) {
  if (fromKey === toKey) {
    box.replaceChildren(el("p", { class: "empty" }, "Pick two different versions."));
    return;
  }
  box.replaceChildren(el("p", { class: "muted" }, "Diffing…"));
  let d;
  try { d = await api.get(`/api/diff?from=${fromKey}&to=${toKey}`); }
  catch (err) { box.replaceChildren(el("p", { class: "empty" }, err.message)); return; }

  const head = el("div", { class: "diffhead" },
    el("span", { class: "add" }, `+${d.stats.added}`),
    el("span", { class: "del" }, `−${d.stats.removed}`),
    el("span", { class: "muted" }, `${d.from.key.slice(0, 8)} → ${d.to.key.slice(0, 8)}`),
  );
  box.replaceChildren(head, renderDiffOps(d.ops));
}

// Collapse long runs of unchanged lines, keeping a little context around changes.
function renderDiffOps(ops) {
  const CONTEXT = 3;
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.type !== "eq") for (let k = i - CONTEXT; k <= i + CONTEXT; k++) if (k >= 0 && k < ops.length) keep[k] = true;
  });
  const wrap = el("div", { class: "diff" });
  let i = 0;
  while (i < ops.length) {
    if (!keep[i]) {
      let j = i;
      while (j < ops.length && !keep[j]) j++;
      wrap.append(el("div", { class: "dl skip" }, `⋯ ${j - i} unchanged line${j - i === 1 ? "" : "s"}`));
      i = j;
      continue;
    }
    const o = ops[i];
    const sign = o.type === "add" ? "+" : o.type === "del" ? "−" : " ";
    wrap.append(el("div", { class: `dl ${o.type}` }, el("span", { class: "sign" }, sign), el("span", { class: "txt" }, o.text)));
    i++;
  }
  if (!ops.length) wrap.append(el("div", { class: "dl skip" }, "identical"));
  return wrap;
}

// ---- file editors (inputs / context / prompts) ----
// items: [{ label, path }]; dir: relative managed dir ("inputs"/"context"/"prompts")
function renderFileEditor(title, items, dir, rerender) {
  main.replaceChildren(el("h1", { class: "page" }, title));
  const editorCard = el("div", { class: "card", style: "display:none" });
  const listCard = el("div", { class: "card" });
  const list = el("ul", { class: "list" });

  let currentPath = null;
  const textarea = el("textarea", { class: "editor" });
  const saveBtn = el("button", { class: "btn small" }, "Publish");
  const fileLabel = el("strong", {}, "");
  const presenceEl = el("span", { class: "presence" });
  const youChip = el("span", { class: "avatar you", style: `background:${collab.me.color}`, title: `You (${collab.me.name})` }, initials(collab.me.name));
  saveBtn.onclick = async () => {
    if (!currentPath) return;
    // Edits already sync live; Publish writes + emits a change event so build
    // status and other views refresh.
    try { await api.put("/api/file", { path: currentPath, content: textarea.value }); toast("Published"); }
    catch (err) { toast(err.message); }
  };
  // remote carets render in an overlay; a hidden mirror div (same metrics as
  // the textarea) measures where a character index lands in pixels
  const cursorLayer = el("div", { class: "cursor-layer" });
  const mirror = el("div", { class: "editor-mirror" });
  const editorWrap = el("div", { class: "editor-wrap" }, textarea, cursorLayer, mirror);
  editorCard.append(
    el("div", { class: "row" }, fileLabel, el("span", { class: "spacer" }), youChip, presenceEl, saveBtn),
    editorWrap,
  );

  // ---- CRDT-aware remote cursors ----
  // Each peer's caret is anchored to the CRDT id of the character before it
  // (not a plain index), so as concurrent edits land we re-resolve the anchor
  // against our replica and the caret stays on the right character.
  let remoteCursors = []; // [{ id, name, color, anchor }]
  const renderRemoteCursors = () => {
    cursorLayer.replaceChildren();
    if (!collab.doc || collab.activePath !== currentPath) return;
    const others = remoteCursors.filter((c) => c.id !== collab.clientId);
    if (!others.length) return;
    const cs = getComputedStyle(textarea);
    for (const p of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing",
      "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]) mirror.style[p] = cs[p];
    mirror.style.width = `${textarea.clientWidth}px`;
    const text = textarea.value;
    const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4 || 16;
    for (const c of others) {
      const idx = collab.doc.indexOfAnchor(c.anchor ?? null);
      if (idx < 0) continue; // anchor op hasn't reached us yet
      mirror.textContent = text.slice(0, Math.min(idx, text.length));
      const marker = el("span", {}, "\u200b"); // zero-width space marks the caret cell
      mirror.append(marker);
      const top = marker.offsetTop + 1 - textarea.scrollTop;
      const left = marker.offsetLeft + 1 - textarea.scrollLeft;
      if (top < -lineH || top > textarea.clientHeight) continue; // out of view
      cursorLayer.append(el("span", {
        class: "rcursor",
        style: `left:${left}px; top:${top}px; height:${lineH}px; --ccolor:${c.color}`,
      }, el("span", { class: "flag" }, c.name)));
    }
    mirror.textContent = "";
  };
  let lastSentAnchor = "?";
  const sendCursor = () => {
    if (!collab.doc || collab.activePath !== currentPath) return;
    const anchor = collab.doc.anchorAt(textarea.selectionStart);
    const key = anchor ? `${anchor.c}:${anchor.s}` : "start";
    if (key === lastSentAnchor) return; // dedupe — only broadcast real moves
    lastSentAnchor = key;
    sendCollab({ type: "cursor", path: currentPath, anchor });
  };
  let cursorTimer = null;
  const queueCursor = () => { clearTimeout(cursorTimer); cursorTimer = setTimeout(sendCursor, 80); };
  for (const evt of ["keyup", "click", "select", "focus"]) textarea.addEventListener(evt, queueCursor);
  textarea.addEventListener("scroll", renderRemoteCursors);

  // local edits → derive CRDT ops vs. last reconciled text → broadcast
  const pushLocalEdits = () => {
    if (!collab.doc || collab.activePath !== currentPath) return;
    const ops = editsFromDiff(collab.doc, collab.lastText, textarea.value);
    collab.lastText = textarea.value;
    if (ops.length) {
      sendCollab({ type: "doc.ops", path: currentPath, ops });
      sendCursor();          // our edits moved our caret
      renderRemoteCursors(); // …and shifted where peers' anchors resolve
    }
  };
  let editTimer = null;
  textarea.addEventListener("input", () => {
    if (!currentPath) return;
    clearTimeout(editTimer);
    editTimer = setTimeout(pushLocalEdits, 200);
  });

  // remote ops → apply to CRDT → reflect in the textarea, preserving caret
  const applyRemoteText = (content) => {
    const pos = textarea.selectionStart;
    const atEnd = pos >= textarea.value.length;
    textarea.value = content;
    collab.lastText = content;
    const p = atEnd ? content.length : Math.min(pos, content.length);
    textarea.selectionStart = textarea.selectionEnd = p;
    renderRemoteCursors(); // anchors re-resolve against the updated text
  };
  const renderPresence = (users) => {
    const others = users.filter((u) => u.id !== collab.clientId);
    presenceEl.replaceChildren(
      ...others.map((u) => el("span", { class: "avatar", style: `background:${u.color}`, title: u.name }, initials(u.name))),
    );
    if (others.length) presenceEl.append(el("span", { class: "muted editing-note" }, `${others.length} other${others.length === 1 ? "" : "s"} here`));
  };

  const openFile = async (relPath) => {
    closeActiveDoc();
    currentPath = relPath;
    fileLabel.textContent = relPath;
    editorCard.style.display = "block";
    remoteCursors = [];
    lastSentAnchor = "?";
    cursorLayer.replaceChildren();
    // join the collaborative session; the server replies with a CRDT snapshot
    collab.activePath = relPath;
    collab.onSnapshot = (d) => {
      collab.doc = new CRDT(collab.site);
      collab.doc.loadSnapshot(d.nodes);
      const text = collab.doc.value();
      collab.lastText = text;
      applyRemoteText(text);
    };
    collab.onOps = (d) => {
      if (!collab.doc) return;
      // fold in any un-pushed local edits first so we don't lose keystrokes
      pushLocalEdits();
      collab.doc.applyMany(d.ops);
      applyRemoteText(collab.doc.value());
    };
    collab.onPresence = renderPresence;
    collab.onCursors = (cursors) => {
      remoteCursors = cursors || [];
      renderRemoteCursors();
    };
    sendCollab({ type: "doc.open", path: relPath });
  };

  const newBtn = el("button", { class: "btn small" }, "+ New");
  newBtn.onclick = async () => {
    let name = prompt(`New file name in ${dir}/`, "untitled.md");
    if (!name) return;
    if (!/\.[a-z0-9]+$/i.test(name)) name += ".md";
    const path = `${dir}/${name}`;
    try {
      await api.put("/api/file", { path, content: "" });
      await rerender();
      openFile(path);
    } catch (err) { toast(err.message); }
  };
  listCard.append(el("div", { class: "row" }, el("strong", {}, `${dir}/`), el("span", { class: "spacer" }), newBtn));

  if (!items.length) list.append(el("li", { class: "empty" }, "Nothing here yet — create one with “+ New”."));
  for (const it of items) {
    const del = el("button", { class: "btn ghost small", title: "delete" }, "✕");
    del.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm(`Delete ${it.path}?`)) return;
      try { await api.send("DELETE", `/api/file?path=${encodeURIComponent(it.path)}`); await rerender(); }
      catch (err) { toast(err.message); }
    };
    list.append(el("li", { onclick: () => openFile(it.path) },
      el("span", { class: "fname" }, it.label), el("span", { class: "spacer" }), del));
  }
  listCard.append(list);
  main.append(listCard, editorCard);
}

async function renderInputs() {
  const { files } = await api.get("/api/inputs");
  renderFileEditor("Inputs", files.map((f) => ({ label: f, path: f })), "inputs", renderInputs);
}

async function renderContext() {
  const { files, dir } = await api.get("/api/context");
  renderFileEditor("Context", files.map((f) => ({ label: f, path: f })), dir || "context", renderContext);
}

async function renderPrompts() {
  const { prompts } = await api.get("/api/prompts");
  renderFileEditor("Prompts", prompts.map((p) => ({ label: p.name, path: `prompts/${p.name}` })), "prompts", renderPrompts);
}

async function renderArtifacts() {
  const { artifacts } = await api.get("/api/artifacts");
  main.replaceChildren(el("h1", { class: "page" }, "Artifacts"));
  if (!artifacts.length) { main.append(el("p", { class: "empty" }, "No artifacts yet — build a workflow.")); return; }
  const detail = el("div", { class: "card", style: "display:none" });
  for (const a of artifacts) {
    const u = a.usage || {};
    main.append(
      el("div", { class: "card", onclick: async () => {
        const { content } = await api.get(`/api/artifact?key=${a.key}`);
        const diffBtn = el("button", { class: "btn ghost small" }, "Diff vs previous");
        diffBtn.onclick = async (ev) => {
          ev.stopPropagation();
          const box = detail.querySelector(".diffbox");
          const hist = await api.get(`/api/artifact-history?workflow=${encodeURIComponent(a.workflowId)}&step=${encodeURIComponent(a.stepId)}`);
          const idx = hist.versions.findIndex((v) => v.key === a.key);
          const prev = hist.versions[idx + 1];
          if (!prev) { toast("No earlier version to diff against."); return; }
          renderDiffInto(box, prev.key, a.key);
        };
        detail.style.display = "block";
        detail.replaceChildren(
          el("div", { class: "row" }, el("h2", {}, `${a.workflowId} / ${a.stepId}`),
            el("span", { class: "spacer" }), diffBtn, el("span", { class: "hash" }, a.key.slice(0, 12))),
          el("div", { class: "output", html: markdown(content) }),
          el("div", { class: "diffbox" }),
        );
        detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
      } },
        el("div", { class: "row" },
          el("strong", {}, `${a.workflowId} / ${a.stepId}`),
          el("span", { class: "pill" }, a.stepType),
          el("span", { class: "spacer" }),
          el("span", { class: "muted" }, new Date(a.createdAt).toLocaleString()),
        ),
        el("div", { class: "kv" },
          el("dt", {}, "model"), el("dd", {}, a.model || "—"),
          el("dt", {}, "size"), el("dd", {}, `${a.contentBytes} B`),
          el("dt", {}, "tokens"), el("dd", {}, `${u.inputTokens ?? "?"} in / ${u.outputTokens ?? "?"} out${u.costUsd != null ? ` · ~$${u.costUsd.toFixed(4)}` : ""}`),
        ),
      ),
    );
  }
  main.append(detail);
}

async function renderMetrics() {
  const { metrics: m, mock } = await api.get("/api/metrics");
  main.replaceChildren(el("h1", { class: "page" }, "Metrics"));
  if (mock) {
    main.append(el("div", { class: "banner" },
      "Mock mode — outputs are synthesized offline and costs are modeled estimates."));
  }
  const usd = (n) => `$${n.toFixed(4)}`;
  const stat = (label, value, sub, cls) =>
    el("div", { class: `stat ${cls || ""}` },
      el("div", { class: "stat-val" }, value),
      el("div", { class: "stat-label" }, label),
      sub ? el("div", { class: "stat-sub" }, sub) : null);

  main.append(
    el("div", { class: "stats-grid" },
      stat("Saved by caching", usd(m.savedUsd), `${m.cacheHits} cache hit${m.cacheHits === 1 ? "" : "s"}`, "good"),
      stat("Spent on model calls", usd(m.spentUsd), `${m.modelCalls} call${m.modelCalls === 1 ? "" : "s"}`),
      stat("Cache hit rate", `${Math.round(m.cacheHitRate * 100)}%`),
      stat("Tokens", (m.tokensIn + m.tokensOut).toLocaleString(),
        `${m.tokensIn.toLocaleString()} in / ${m.tokensOut.toLocaleString()} out`),
      stat("Artifacts", String(m.artifacts)),
      stat("Builds", String(m.builds), m.lastBuildAt ? `last ${new Date(m.lastBuildAt).toLocaleString()}` : ""),
    ),
    el("p", { class: "muted" },
      "“Saved by caching” is the model spend avoided by serving unchanged steps from cache instead of recomputing them — the core of treating LLM work like a build."),
  );
}

function shareLinkRow(url) {
  const full = location.origin + url;
  const input = el("input", { class: "text", readonly: "readonly", value: full, style: "flex:1;font-size:.82rem" });
  const copy = el("button", { class: "btn ghost small" }, "Copy");
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(full); toast("Link copied"); }
    catch { input.select(); document.execCommand?.("copy"); toast("Link copied"); }
  };
  const open = el("a", { class: "btn ghost small", href: url, target: "_blank" }, "Open");
  const dl = el("a", { class: "btn ghost small", href: url, download: "" }, "Download");
  return el("div", { class: "row share-link" }, input, copy, open, dl);
}

async function renderShare() {
  main.replaceChildren(el("h1", { class: "page" }, "Share"));
  main.append(el("p", { class: "muted" },
    "Exports are self-contained HTML — open offline, email them, or host anywhere. The links below work while this local server runs."));

  const allBtn = el("button", { class: "btn" }, "Export everything");
  const bundleBtn = el("button", { class: "btn ghost" }, "Single file");
  const allRow = el("div", {});
  allBtn.onclick = async () => {
    try {
      const { indexUrl, pages } = await api.post("/api/export-all", {});
      allRow.replaceChildren(shareLinkRow(indexUrl));
      toast(`Exported ${pages.length} workflow${pages.length === 1 ? "" : "s"}`);
    } catch (err) { toast(err.message); }
  };
  bundleBtn.onclick = async () => {
    try {
      const { url } = await api.post("/api/export-bundle", {});
      allRow.replaceChildren(shareLinkRow(url));
      toast("Bundled into one self-contained file");
    } catch (err) { toast(err.message); }
  };
  main.append(el("div", { class: "card" },
    el("div", { class: "row" }, el("strong", {}, "Whole workspace"),
      el("span", { class: "muted" }, "a linked index, or one self-contained file"),
      el("span", { class: "spacer" }), bundleBtn, allBtn),
    allRow));

  for (const wf of workspace.workflows) {
    const linkRow = el("div", {});
    const btn = el("button", { class: "btn small" }, "Export & link");
    btn.onclick = async () => {
      try {
        const { url } = await api.post("/api/export", { workflow: wf.id });
        linkRow.replaceChildren(shareLinkRow(url));
      } catch (err) { toast(err.message); }
    };
    main.append(el("div", { class: "card" },
      el("div", { class: "row" }, el("strong", {}, wf.id),
        wf.description ? el("span", { class: "muted" }, wf.description) : null,
        el("span", { class: "spacer" }), btn),
      linkRow));
  }
}

async function renderSnapshots() {
  const { snapshots } = await api.get("/api/snapshots");
  main.replaceChildren(el("h1", { class: "page" }, "Snapshots"));
  const msg = el("input", { class: "text", placeholder: "Snapshot message…", style: "flex:1" });
  const btn = el("button", { class: "btn" }, "Snapshot");
  btn.onclick = async () => {
    try {
      const res = await api.post("/api/snapshot", { message: msg.value });
      if (res.ok) { toast(`Snapshot ${res.hash}`); msg.value = ""; renderSnapshots(); }
      else toast(res.reason || "Nothing to snapshot");
    } catch (err) { toast(err.message); }
  };
  main.append(el("div", { class: "card" }, el("div", { class: "row" }, msg, btn)));

  const card = el("div", { class: "card" });
  if (!snapshots.length) card.append(el("p", { class: "empty" }, "No snapshots yet."));
  const ul = el("ul", { class: "list" });
  for (const s of snapshots) {
    ul.append(el("li", {},
      el("span", { class: "hash" }, s.hash),
      el("span", {}, s.subject),
      el("span", { class: "spacer" }),
      el("span", { class: "muted" }, new Date(s.date).toLocaleString()),
    ));
  }
  card.append(ul);
  main.append(card);

  if (snapshots.length >= 2) main.append(renderSnapshotCompare(snapshots));
}

function renderSnapshotCompare(snapshots) {
  const opt = (s) => el("option", { value: s.hash }, `${s.hash} · ${s.subject.slice(0, 40)}`);
  const fromSel = el("select", { class: "vers" }, ...snapshots.map(opt));
  const toSel = el("select", { class: "vers" }, ...snapshots.map(opt));
  fromSel.value = snapshots[1].hash; // older
  toSel.value = snapshots[0].hash;   // newer
  const filesBox = el("div", { class: "snap-files" });
  const diffBox = el("div", { class: "diffbox" });

  const loadFiles = async () => {
    diffBox.replaceChildren();
    filesBox.replaceChildren(el("span", { class: "muted" }, "Loading…"));
    try {
      const { files } = await api.get(`/api/snapshot-changes?from=${fromSel.value}&to=${toSel.value}`);
      if (!files.length) { filesBox.replaceChildren(el("span", { class: "empty" }, "No tracked files changed.")); return; }
      filesBox.replaceChildren(...files.map((f) => {
        const b = el("button", { class: "btn ghost small" }, f);
        b.onclick = async () => {
          diffBox.replaceChildren(el("p", { class: "muted" }, "Diffing…"));
          const d = await api.get(`/api/snapshot-diff?from=${fromSel.value}&to=${toSel.value}&path=${encodeURIComponent(f)}`);
          diffBox.replaceChildren(
            el("div", { class: "diffhead" },
              el("span", { class: "add" }, `+${d.stats.added}`),
              el("span", { class: "del" }, `−${d.stats.removed}`),
              el("span", { class: "muted" }, f)),
            renderDiffOps(d.ops),
          );
        };
        return b;
      }));
    } catch (err) { filesBox.replaceChildren(el("span", { class: "empty" }, err.message)); }
  };
  fromSel.onchange = loadFiles;
  toSel.onchange = loadFiles;
  loadFiles();

  return el("div", { class: "card" },
    el("div", { class: "row" }, el("strong", {}, "Compare snapshots"), el("span", { class: "spacer" }),
      el("span", { class: "muted" }, "from"), fromSel, el("span", { class: "arrow" }, "→"), el("span", { class: "muted" }, "to"), toSel),
    el("p", { class: "muted", style: "margin:.4rem 0" }, "Pick a changed file to see the diff between the two snapshots."),
    filesBox, diffBox);
}

boot().catch((err) => {
  main.replaceChildren(el("div", { class: "card" },
    el("h2", {}, "No workspace"),
    el("p", { class: "muted" }, String(err.message || err)),
    el("p", {}, "Run ", el("code", {}, "loom init"), " in a directory, then ", el("code", {}, "loom serve"), "."),
  ));
});
