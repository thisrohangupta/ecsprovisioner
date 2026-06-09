import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, extname, sep } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import {
  loadWorkspace,
  resolveDirs,
  writeConfig,
  writeConfigRaw,
  type Workspace,
  type ResolvedDirs,
  defaultModel,
} from "../core/workspace.js";
import { Store } from "../core/store.js";
import { Engine } from "../core/engine.js";
import { listPrompts } from "../core/prompts.js";
import { dagEdges } from "../core/graph.js";
import { snapshot as gitSnapshot, listSnapshots, readFileAtSnapshot, changedFiles } from "../core/snapshot.js";
import { exportWorkflowHtml, exportAllHtml, exportBundleHtml } from "../core/exporter.js";
import { listFilesRecursive } from "../core/workspace.js";
import { diffLines, diffStats } from "../core/diff.js";
import { selectRunners } from "../llm/runners.js";
import { computeMetrics } from "../core/metrics.js";
import { CRDT, type Op } from "../core/crdt.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, "../web/public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

interface Ctx {
  ws: Workspace;
  dirs: ResolvedDirs;
  store: Store;
  engine: Engine;
}

let MOCK = false;

function ctx(): Ctx {
  const ws = loadWorkspace();
  const dirs = resolveDirs(ws);
  const store = new Store(dirs.loom);
  store.init();
  return { ws, dirs, store, engine: new Engine(ws, dirs, store, selectRunners(MOCK)) };
}

export async function startServer({ port = 4319, mock = false }: { port?: number; mock?: boolean } = {}): Promise<void> {
  MOCK = mock;
  // Validate there is a workspace before binding.
  ctx();

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => sendJson(res, 500, { error: String(err?.message ?? err) }));
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  const broadcast = (msg: unknown) => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  };

  // --- live collaboration (CRDT op-based content sync + presence), per file ---
  interface CollabUser {
    id: string;
    name: string;
    color: string;
  }
  interface SocketState {
    id: string;
    user: CollabUser;
    path: string | null;
    // caret anchor = CRDT id of the char before the caret (null = doc start).
    // The server never interprets it; it just relays so peers can resolve it
    // against their own replica (edit-stable, unlike a plain index).
    cursor: unknown;
  }
  const docs = new Map<string, CRDT>();
  const presence = new Map<string, Map<string, CollabUser>>();
  const sockState = new WeakMap<WebSocket, SocketState>();
  let nextId = 1;

  const loadDoc = (path: string): CRDT => {
    if (!docs.has(path)) {
      const { ws } = ctx();
      const abs = safeJoin(ws.root, path);
      const doc = new CRDT(0); // server is site 0
      const text = existsSync(abs) ? readFileSync(abs, "utf8") : "";
      for (let i = 0; i < text.length; i++) doc.localInsert(i, text[i]);
      docs.set(path, doc);
    }
    return docs.get(path)!;
  };
  const persist = (path: string, doc: CRDT) => {
    const { ws } = ctx();
    const abs = safeJoin(ws.root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, doc.value());
  };
  const usersOn = (path: string): CollabUser[] => [...(presence.get(path)?.values() ?? [])];
  const announce = (path: string) =>
    broadcast({ type: "presence", data: { path, users: usersOn(path) } });
  const cursorsOn = (path: string) => {
    const out: Array<{ id: string; name: string; color: string; anchor: unknown }> = [];
    for (const client of wss.clients) {
      const s = sockState.get(client);
      if (s && s.path === path) out.push({ id: s.id, name: s.user.name, color: s.user.color, anchor: s.cursor });
    }
    return out;
  };
  const announceCursors = (path: string) =>
    broadcast({ type: "doc.cursors", data: { path, cursors: cursorsOn(path) } });
  const isManaged = (path: string): boolean => {
    const { ws, dirs } = ctx();
    const file = safeJoin(ws.root, path);
    return [dirs.inputs, dirs.prompts, dirs.context].some((d) => file.startsWith(d + sep));
  };
  const leave = (socket: WebSocket) => {
    const st = sockState.get(socket);
    if (st?.path && presence.has(st.path)) {
      const path = st.path;
      presence.get(path)!.delete(st.id);
      st.path = null;
      st.cursor = null;
      announce(path);
      announceCursors(path); // drop their caret from peers' editors
    } else if (st) {
      st.path = null;
      st.cursor = null;
    }
  };

  wss.on("connection", (socket) => {
    const site = nextId++;
    const id = `c${site}`;
    sockState.set(socket, { id, user: { id, name: "Guest", color: "#888" }, path: null, cursor: null });
    socket.send(JSON.stringify({ type: "hello", clientId: id, site, ts: new Date().toISOString() }));

    socket.on("message", (raw) => {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const st = sockState.get(socket);
      if (!st) return;

      if (m.type === "identify") {
        st.user = { id: st.id, name: String(m.name ?? "Guest").slice(0, 40), color: String(m.color ?? "#888") };
        if (st.path) announce(st.path);
      } else if (m.type === "doc.open" && typeof m.path === "string") {
        leave(socket);
        st.path = m.path;
        if (!presence.has(m.path)) presence.set(m.path, new Map());
        presence.get(m.path)!.set(st.id, st.user);
        const doc = loadDoc(m.path);
        socket.send(JSON.stringify({ type: "doc.snapshot", data: { path: m.path, nodes: doc.snapshot() } }));
        announce(m.path);
        announceCursors(m.path); // bring the new joiner up to date on carets
      } else if (m.type === "doc.close") {
        leave(socket);
      } else if (m.type === "doc.ops" && typeof m.path === "string" && Array.isArray(m.ops)) {
        if (!isManaged(m.path)) return;
        const doc = loadDoc(m.path);
        for (const op of m.ops as Op[]) doc.apply(op);
        persist(m.path, doc);
        // relay to everyone else editing this file
        broadcast({ type: "doc.ops", data: { path: m.path, ops: m.ops, by: st.id } });
      } else if (m.type === "cursor" && typeof m.path === "string" && st.path === m.path) {
        // anchor is opaque to the server — peers resolve it via their CRDT
        st.cursor = m.anchor ?? null;
        announceCursors(m.path);
      }
    });

    socket.on("close", () => leave(socket));
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    // --- API ---
    if (path.startsWith("/api/")) return api(req, res, url, method, broadcast);

    // --- exported HTML ---
    if (path.startsWith("/export/")) {
      const { store } = ctx();
      const rel = path.slice("/export/".length) || "index.html";
      const file = join(store.exportsDir, rel);
      if (existsSync(file) && file.startsWith(store.exportsDir) && statSync(file).isFile()) {
        res.writeHead(200, { "content-type": MIME[".html"] });
        return res.end(readFileSync(file));
      }
      return send(res, 404, "not found");
    }

    // --- static SPA ---
    return serveStatic(path, res);
  }

  await new Promise<void>((r) => server.listen(port, r));
  // eslint-disable-next-line no-console
  console.log(
    `\n  Loom UI running at http://localhost:${port}` +
      (MOCK ? "  (mock mode — no API calls)" : "") +
      `\n  (Ctrl+C to stop)\n`,
  );
}

function serveStatic(path: string, res: ServerResponse) {
  const rel = path === "/" ? "index.html" : path.replace(/^\//, "");
  const file = resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file) || !statSync(file).isFile()) {
    // SPA fallback
    const index = join(PUBLIC_DIR, "index.html");
    if (existsSync(index)) {
      res.writeHead(200, { "content-type": MIME[".html"] });
      return res.end(readFileSync(index));
    }
    return send(res, 404, "not found");
  }
  readFile(file, (err, data) => {
    if (err) return send(res, 500, "read error");
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  });
}

async function api(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  broadcast: (msg: unknown) => void,
) {
  const path = url.pathname;

  if (path === "/api/workspace" && method === "GET") {
    const { ws, store } = ctx();
    const workflows = ws.config.workflows.map((wf) => ({
      id: wf.id,
      description: wf.description,
      steps: wf.steps.map((s) => ({
        id: s.id,
        type: s.type,
        output: s.output,
        inputs: s.inputs ?? [],
        model: s.model ?? defaultModel(ws),
      })),
      edges: dagEdges(wf),
    }));
    return sendJson(res, 200, {
      name: ws.config.name,
      description: ws.config.description,
      root: ws.root,
      defaultModel: defaultModel(ws),
      mock: MOCK,
      workflows,
      state: store.readState(),
    });
  }

  if (path === "/api/inputs" && method === "GET") {
    const { dirs } = ctx();
    const inputsRel = (dirs.inputs.split(sep).pop() ?? "inputs");
    const files = listFilesRecursive(dirs.inputs).map((f) => `${inputsRel}/${f}`);
    return sendJson(res, 200, { files });
  }

  if (path === "/api/prompts" && method === "GET") {
    const { dirs } = ctx();
    return sendJson(res, 200, { prompts: listPrompts(dirs).map((p) => ({ name: p.name, content: p.content })) });
  }

  if (path === "/api/context" && method === "GET") {
    const { dirs } = ctx();
    const rel = dirs.context.split(sep).pop() ?? "context";
    const files = listFilesRecursive(dirs.context).map((f) => `${rel}/${f}`);
    return sendJson(res, 200, { files, dir: rel });
  }

  if (path === "/api/config" && method === "GET") {
    const { ws } = ctx();
    return sendJson(res, 200, { config: ws.config, raw: readFileSync(ws.configPath, "utf8") });
  }

  if (path === "/api/config" && method === "PUT") {
    const { ws, store } = ctx();
    const body = JSON.parse(await readBody(req)) as { config?: unknown; raw?: string };
    try {
      if (typeof body.raw === "string") writeConfigRaw(ws, body.raw);
      else writeConfig(ws, body.config as never);
    } catch (err) {
      return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    broadcast(store.appendEvent("file.changed", { path: "loom.yaml" }));
    return sendJson(res, 200, { ok: true });
  }

  if (path === "/api/file" && method === "GET") {
    const { ws } = ctx();
    const rel = url.searchParams.get("path") ?? "";
    const file = safeJoin(ws.root, rel);
    if (!existsSync(file)) return sendJson(res, 404, { error: "not found" });
    return sendJson(res, 200, { path: rel, content: readFileSync(file, "utf8") });
  }

  if (path === "/api/file" && method === "PUT") {
    const { ws, dirs, store } = ctx();
    const body = JSON.parse(await readBody(req)) as { path: string; content: string };
    const file = safeJoin(ws.root, body.path);
    // Restrict writes to the managed content directories.
    const allowed = [dirs.inputs, dirs.prompts, dirs.context];
    if (!allowed.some((d) => file === d || file.startsWith(d + sep))) {
      return sendJson(res, 403, { error: "writes are only allowed under inputs/, prompts/, context/" });
    }
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body.content);
    const event = store.appendEvent("file.changed", { path: body.path });
    broadcast(event);
    return sendJson(res, 200, { ok: true });
  }

  if (path === "/api/file" && method === "DELETE") {
    const { ws, dirs, store } = ctx();
    const rel = url.searchParams.get("path") ?? "";
    const file = safeJoin(ws.root, rel);
    const allowed = [dirs.inputs, dirs.prompts, dirs.context];
    if (!allowed.some((d) => file.startsWith(d + sep))) {
      return sendJson(res, 403, { error: "only files under inputs/, prompts/, context/ can be deleted" });
    }
    if (existsSync(file)) {
      const { rmSync } = await import("node:fs");
      rmSync(file);
    }
    broadcast(store.appendEvent("file.changed", { path: rel, deleted: true }));
    return sendJson(res, 200, { ok: true });
  }

  if (path === "/api/artifacts" && method === "GET") {
    const { store } = ctx();
    return sendJson(res, 200, { artifacts: store.listArtifacts() });
  }

  if (path === "/api/artifact" && method === "GET") {
    const { store } = ctx();
    const key = url.searchParams.get("key") ?? "";
    const artifact = store.getArtifact(key);
    if (!artifact) return sendJson(res, 404, { error: "not found" });
    return sendJson(res, 200, { artifact, content: store.getArtifactContent(key) });
  }

  if (path === "/api/step-output" && method === "GET") {
    const { store } = ctx();
    const workflow = url.searchParams.get("workflow") ?? "";
    const step = url.searchParams.get("step") ?? "";
    const key = store.getStepArtifactKey(workflow, step);
    if (!key || !store.hasArtifact(key)) return sendJson(res, 404, { error: "not built" });
    return sendJson(res, 200, { artifact: store.getArtifact(key), content: store.getArtifactContent(key) });
  }

  if (path === "/api/artifact-history" && method === "GET") {
    const { store } = ctx();
    const workflow = url.searchParams.get("workflow") ?? "";
    const step = url.searchParams.get("step") ?? "";
    const currentKey = store.getStepArtifactKey(workflow, step);
    const versions = store.listStepArtifacts(workflow, step).map((a) => ({
      key: a.key,
      createdAt: a.createdAt,
      contentBytes: a.contentBytes,
      model: a.model,
      usage: a.usage,
      status: a.status,
      current: a.key === currentKey,
    }));
    return sendJson(res, 200, { workflow, step, currentKey, versions });
  }

  if (path === "/api/diff" && method === "GET") {
    const { store } = ctx();
    const fromKey = url.searchParams.get("from") ?? "";
    const toKey = url.searchParams.get("to") ?? "";
    if (!store.hasArtifact(fromKey) || !store.hasArtifact(toKey)) {
      return sendJson(res, 404, { error: "one or both artifact versions not found" });
    }
    const ops = diffLines(store.getArtifactContent(fromKey), store.getArtifactContent(toKey));
    return sendJson(res, 200, {
      from: store.getArtifact(fromKey),
      to: store.getArtifact(toKey),
      ops,
      stats: diffStats(ops),
    });
  }

  if (path === "/api/status" && method === "GET") {
    const { engine } = ctx();
    const workflow = url.searchParams.get("workflow") ?? "";
    return sendJson(res, 200, { status: engine.status(workflow) });
  }

  if (path === "/api/metrics" && method === "GET") {
    const { store } = ctx();
    return sendJson(res, 200, { metrics: computeMetrics(store), mock: MOCK });
  }

  if (path === "/api/events" && method === "GET") {
    const { store } = ctx();
    const limit = Number(url.searchParams.get("limit") ?? "100");
    return sendJson(res, 200, { events: store.readEvents(limit) });
  }

  if (path === "/api/build" && method === "POST") {
    const { engine } = ctx();
    const body = JSON.parse(await readBody(req)) as { workflow: string; force?: boolean };
    // Fire-and-stream: events go over the websocket; the POST resolves with the result.
    const result = await engine.buildWorkflow(body.workflow, {
      force: body.force,
      onEvent: (e) => broadcast(e),
      onDelta: (stepId, text) => broadcast({ type: "step.delta", data: { stepId, text } }),
    });
    return sendJson(res, 200, { result });
  }

  if (path === "/api/snapshot" && method === "POST") {
    const { ws, store } = ctx();
    const body = JSON.parse(await readBody(req)) as { message?: string };
    const message = body.message || `Snapshot ${new Date().toISOString()}`;
    const result = gitSnapshot(ws.root, message);
    if (result.ok) broadcast(store.appendEvent("snapshot", { hash: result.hash, message }));
    return sendJson(res, 200, result);
  }

  if (path === "/api/snapshots" && method === "GET") {
    const { ws } = ctx();
    return sendJson(res, 200, { snapshots: listSnapshots(ws.root) });
  }

  if (path === "/api/snapshot-changes" && method === "GET") {
    const { ws } = ctx();
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";
    return sendJson(res, 200, { files: changedFiles(ws.root, from, to) });
  }

  if (path === "/api/snapshot-diff" && method === "GET") {
    const { ws } = ctx();
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";
    const file = url.searchParams.get("path") ?? "";
    const a = readFileAtSnapshot(ws.root, from, file) ?? "";
    const b = readFileAtSnapshot(ws.root, to, file) ?? "";
    const ops = diffLines(a, b);
    return sendJson(res, 200, { ops, stats: diffStats(ops), path: file });
  }

  if (path === "/api/export" && method === "POST") {
    const { ws, store } = ctx();
    const body = JSON.parse(await readBody(req)) as { workflow: string };
    const { path: filePath } = exportWorkflowHtml(ws, store, body.workflow);
    broadcast(store.appendEvent("export", { workflowId: body.workflow, path: filePath }));
    return sendJson(res, 200, { path: filePath, url: `/export/${body.workflow}.html` });
  }

  if (path === "/api/export-all" && method === "POST") {
    const { ws, store } = ctx();
    const { indexPath, pages } = exportAllHtml(ws, store);
    broadcast(store.appendEvent("export", { workflowId: "*", path: indexPath }));
    return sendJson(res, 200, { indexPath, indexUrl: "/export/index.html", pages });
  }

  if (path === "/api/export-bundle" && method === "POST") {
    const { ws, store } = ctx();
    const { path: filePath } = exportBundleHtml(ws, store);
    broadcast(store.appendEvent("export", { workflowId: "bundle", path: filePath }));
    return sendJson(res, 200, { path: filePath, url: "/export/bundle.html" });
  }

  return sendJson(res, 404, { error: "unknown endpoint" });
}

function safeJoin(root: string, rel: string): string {
  const p = resolve(root, rel);
  if (p !== root && !p.startsWith(root + sep)) {
    throw new Error("path escapes workspace");
  }
  return p;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolveBody(data));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": MIME[".json"] });
  res.end(JSON.stringify(body));
}

function send(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}
