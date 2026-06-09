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

// ---- websocket live updates ----
let logSink = null; // function(text, cls) when a build log is on screen
function connectWS() {
  const dot = document.getElementById("conn-dot");
  const label = document.getElementById("conn-label");
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => { dot.className = "dot on"; label.textContent = "live"; };
  ws.onclose = () => {
    dot.className = "dot off"; label.textContent = "reconnecting…";
    setTimeout(connectWS, 1500);
  };
  ws.onmessage = (ev) => handleEvent(JSON.parse(ev.data));
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
    render();
  }),
);

async function boot() {
  workspace = await api.get("/api/workspace");
  document.getElementById("ws-name").textContent = workspace.name;
  document.getElementById("ws-desc").textContent = workspace.description || "";
  const events = await api.get("/api/events?limit=20").catch(() => ({ events: [] }));
  events.events.reverse().forEach((e) => handleEvent(e));
  connectWS();
  render();
}

async function render() {
  workspace = await api.get("/api/workspace");
  if (view === "workflows") return renderWorkflows();
  if (view === "inputs") return renderInputs();
  if (view === "prompts") return renderPrompts();
  if (view === "artifacts") return renderArtifacts();
  if (view === "snapshots") return renderSnapshots();
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

    const dagWrap = el("div", { class: "dag" }, renderDagSvg(wf));
    const detail = el("div", { class: "detail", style: "display:none" });
    dag.detailEls.set(wf.id, detail);

    main.append(
      el("div", { class: "card" },
        el("div", { class: "row" },
          el("h2", {}, wf.id),
          el("span", { class: "spacer" }),
          buildBtn, forceBtn, exportBtn,
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

// ---- file editors (inputs / prompts) ----
async function renderFileEditor(title, files, opts = {}) {
  main.replaceChildren(el("h1", { class: "page" }, title));
  const editorCard = el("div", { class: "card", style: "display:none" });
  const listCard = el("div", { class: "card" });
  const list = el("ul", { class: "list" });

  let currentPath = null;
  const textarea = el("textarea", { class: "editor" });
  const saveBtn = el("button", { class: "btn small" }, "Save");
  const fileLabel = el("strong", {}, "");
  saveBtn.onclick = async () => {
    if (!currentPath) return;
    try { await api.put("/api/file", { path: currentPath, content: textarea.value }); toast("Saved"); }
    catch (err) { toast(err.message); }
  };
  editorCard.append(
    el("div", { class: "row" }, fileLabel, el("span", { class: "spacer" }), saveBtn),
    textarea,
  );

  const openFile = async (relPath) => {
    const { content } = await api.get(`/api/file?path=${encodeURIComponent(relPath)}`);
    currentPath = relPath;
    fileLabel.textContent = relPath;
    textarea.value = content;
    editorCard.style.display = "block";
  };

  if (!files.length) list.append(el("li", { class: "empty" }, "Nothing here yet."));
  for (const f of files) {
    const path = opts.toPath ? opts.toPath(f) : f;
    list.append(el("li", { onclick: () => openFile(path) }, el("span", { class: "fname" }, opts.label ? opts.label(f) : f)));
  }
  listCard.append(list);
  main.append(listCard, editorCard);
}

async function renderInputs() {
  const { files } = await api.get("/api/inputs");
  await renderFileEditor("Inputs", files);
}

async function renderPrompts() {
  const { prompts } = await api.get("/api/prompts");
  await renderFileEditor("Prompts", prompts, {
    label: (p) => p.name,
    toPath: (p) => `prompts/${p.name}`,
  });
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
