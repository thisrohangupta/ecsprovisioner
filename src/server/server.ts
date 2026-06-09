import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, extname, sep } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { loadWorkspace, resolveDirs, type Workspace, type ResolvedDirs, defaultModel } from "../core/workspace.js";
import { Store } from "../core/store.js";
import { Engine } from "../core/engine.js";
import { listPrompts } from "../core/prompts.js";
import { dagEdges } from "../core/graph.js";
import { snapshot as gitSnapshot, listSnapshots } from "../core/snapshot.js";
import { exportWorkflowHtml } from "../core/exporter.js";
import { listFilesRecursive } from "../core/workspace.js";
import { diffLines, diffStats } from "../core/diff.js";

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

function ctx(): Ctx {
  const ws = loadWorkspace();
  const dirs = resolveDirs(ws);
  const store = new Store(dirs.loom);
  store.init();
  return { ws, dirs, store, engine: new Engine(ws, dirs, store) };
}

export async function startServer({ port = 4319 }: { port?: number } = {}): Promise<void> {
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
  wss.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "hello", ts: new Date().toISOString() }));
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
      const file = join(store.exportsDir, path.slice("/export/".length));
      if (existsSync(file) && file.startsWith(store.exportsDir)) {
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
  console.log(`\n  Loom UI running at http://localhost:${port}\n  (Ctrl+C to stop)\n`);
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

  if (path === "/api/export" && method === "POST") {
    const { ws, store } = ctx();
    const body = JSON.parse(await readBody(req)) as { workflow: string };
    const { path: filePath } = exportWorkflowHtml(ws, store, body.workflow);
    broadcast(store.appendEvent("export", { workflowId: body.workflow, path: filePath }));
    return sendJson(res, 200, { path: filePath, url: `/export/${body.workflow}.html` });
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
