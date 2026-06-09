// Loom web UI — vanilla JS, no build step.

const main = document.getElementById("main");
const activityEl = document.getElementById("activity");
const SVGNS = "http://www.w3.org/2000/svg";

const api = {
  async get(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  },
  async send(method, path, body) {
    const r = await fetch(path, {
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
  ws: null,
  clientId: null,
  me: loadIdentity(),
  activePath: null,
  onState: null,
  onUpdate: null,
  onPresence: null,
};

function sendCollab(obj) {
  if (collab.ws && collab.ws.readyState === WebSocket.OPEN) collab.ws.send(JSON.stringify(obj));
}
function closeActiveDoc() {
  if (collab.activePath) sendCollab({ type: "doc.close", path: collab.activePath });
  collab.activePath = null;
  collab.onState = collab.onUpdate = collab.onPresence = null;
}
function handleCollab(m) {
  if (m.data.path !== collab.activePath) return;
  if (m.type === "doc.state") collab.onState?.(m.data);
  else if (m.type === "doc.update") { if (m.data.by !== collab.clientId) collab.onUpdate?.(m.data); }
  else if (m.type === "presence") collab.onPresence?.(m.data.users);
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
      sendCollab({ type: "identify", name: collab.me.name, color: collab.me.color });
      // re-join the doc currently open (e.g. after a reconnect)
      if (collab.activePath) sendCollab({ type: "doc.open", path: collab.activePath });
      return;
    }
    if (m.type === "doc.state" || m.type === "doc.update" || m.type === "presence") return handleCollab(m);
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
    render();
  }),
);

async function boot() {
  workspace = await api.get("/api/workspace");
  document.getElementById("ws-name").textContent = workspace.name;
  document.getElementById("ws-desc").textContent = workspace.description || "";
  if (workspace.mock && !document.querySelector(".mockpill")) {
    document.querySelector(".brand > div").append(el("span", { class: "mockpill" }, "mock"));
  }
  const events = await api.get("/api/events?limit=20").catch(() => ({ events: [] }));
  events.events.reverse().forEach((e) => handleEvent(e));
  connectWS();
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
    );
    dag.nodes.set(key, g);
    if (dag.stateByKey.has(key)) applyNodeState(key);
    svg.append(g);
  }
  return svg;
}

const statusMaps = {};
async function refreshStatuses() {
  for (const wf of workspace.workflows) {
    try {
      const { status } = await api.get(`/api/status?workflow=${encodeURIComponent(wf.id)}`);
      statusMaps[wf.id] = Object.fromEntries(status.map((s) => [s.stepId, s]));
      for (const s of status) {
        const state = s.fresh ? "fresh" : s.hasArtifact ? "stale" : "unbuilt";
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

    main.append(
      el("div", { class: "card" },
        el("div", { class: "row" },
          el("h2", {}, wf.id),
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
      el("button", { class: "btn ghost small", onclick: () => { detail.style.display = "none"; if (dag.selectedKey) { const k = dag.selectedKey; dag.selectedKey = null; applyNodeState(k); } } }, "✕"),
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
  editorCard.append(
    el("div", { class: "row" }, fileLabel, el("span", { class: "spacer" }), youChip, presenceEl, saveBtn),
    textarea,
  );

  // debounced live edit broadcast
  let editTimer = null;
  textarea.addEventListener("input", () => {
    if (!currentPath) return;
    clearTimeout(editTimer);
    editTimer = setTimeout(() => sendCollab({ type: "doc.edit", path: currentPath, content: textarea.value }), 250);
  });

  const applyRemote = (content) => {
    const pos = textarea.selectionStart;
    const atEnd = pos >= textarea.value.length;
    textarea.value = content;
    const p = atEnd ? content.length : Math.min(pos, content.length);
    textarea.selectionStart = textarea.selectionEnd = p;
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
    const { content } = await api.get(`/api/file?path=${encodeURIComponent(relPath)}`);
    currentPath = relPath;
    fileLabel.textContent = relPath;
    textarea.value = content;
    editorCard.style.display = "block";
    // join the collaborative session for this file
    collab.activePath = relPath;
    collab.onState = (d) => { if (d.content !== textarea.value) applyRemote(d.content); };
    collab.onUpdate = (d) => applyRemote(d.content);
    collab.onPresence = renderPresence;
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
  const allRow = el("div", {});
  allBtn.onclick = async () => {
    try {
      const { indexUrl, pages } = await api.post("/api/export-all", {});
      allRow.replaceChildren(shareLinkRow(indexUrl));
      toast(`Exported ${pages.length} workflow${pages.length === 1 ? "" : "s"}`);
    } catch (err) { toast(err.message); }
  };
  main.append(el("div", { class: "card" },
    el("div", { class: "row" }, el("strong", {}, "Whole workspace"),
      el("span", { class: "muted" }, "one index linking every compiled output"),
      el("span", { class: "spacer" }), allBtn),
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
}

boot().catch((err) => {
  main.replaceChildren(el("div", { class: "card" },
    el("h2", {}, "No workspace"),
    el("p", { class: "muted" }, String(err.message || err)),
    el("p", {}, "Run ", el("code", {}, "loom init"), " in a directory, then ", el("code", {}, "loom serve"), "."),
  ));
});
