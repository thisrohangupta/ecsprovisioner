import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, extname, sep } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import {
  loadWorkspace,
  findWorkspaceRoot,
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
import {
  listWorkspaces,
  addWorkspace,
  removeWorkspace,
  resolveWorkspaceRoot,
} from "../core/registry.js";

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
// The workspace used when a request doesn't name one (the cwd workspace, or the
// first registered workspace). Set in startServer.
let defaultWsId: string | null = null;

function buildCtx(ws: Workspace): Ctx {
  const dirs = resolveDirs(ws);
  const store = new Store(dirs.loom);
  store.init();
  return { ws, dirs, store, engine: new Engine(ws, dirs, store, selectRunners(MOCK)) };
}

/**
 * Resolve a request's workspace. With an id, look the root up in the registry;
 * without one, fall back to the default (or cwd discovery for single-workspace
 * back-compat). Everything downstream is constructed fresh and statelessly.
 */
function ctx(wsId?: string | null): Ctx {
  const id = wsId || defaultWsId;
  if (id) {
    const root = resolveWorkspaceRoot(id);
    if (!root) throw new Error(`Unknown workspace: ${id}`);
    return buildCtx(loadWorkspace(root));
  }
  return buildCtx(loadWorkspace());
}

/** The workspace id carried on a request (query param), or the default. */
function reqWs(url: URL): string | null {
  return url.searchParams.get("ws") || defaultWsId;
}

export interface ServerHandle {
  port: number;
  close: () => Promise<void>;
}

export async function startServer({ port = 4319, host = "127.0.0.1", mock = false, quiet = false }: { port?: number; host?: string; mock?: boolean; quiet?: boolean } = {}): Promise<ServerHandle> {
  MOCK = mock;
  // Register the cwd workspace (if any) and make it the default; otherwise fall
  // back to the first already-registered workspace so the UI still has one.
  const cwdRoot = findWorkspaceRoot();
  if (cwdRoot) {
    defaultWsId = addWorkspace(cwdRoot).id;
  } else if (listWorkspaces().length) {
    defaultWsId = listWorkspaces()[0].id;
  }
  // Validate there is at least one workspace before binding.
  ctx();

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => sendJson(res, 500, { error: String(err?.message ?? err) }));
  });

  const wss = new WebSocketServer({
    server,
    path: "/ws",
    // reject cross-site WebSocket hijacking from a page on another origin
    verifyClient: (info: { origin?: string }) => isAllowedOrigin(info.origin),
  });
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
    ws: string; // workspace this socket is currently viewing
    path: string | null;
    // caret anchor = CRDT id of the char before the caret (null = doc start).
    // The server never interprets it; it just relays so peers can resolve it
    // against their own replica (edit-stable, unlike a plain index).
    cursor: unknown;
    // where this client is looking in the workspace — a "<wfId>::<stepId>"
    // key (or null). Opaque to the server; drives presence avatars on the DAG.
    focus: string | null;
  }
  const docs = new Map<string, CRDT>();
  const presence = new Map<string, Map<string, CollabUser>>();
  const sockState = new WeakMap<WebSocket, SocketState>();
  let nextId = 1;

  // Collaboration state is namespaced per workspace so two open workspaces
  // never share documents, presence, carets, or DAG focus. The composite key
  // joins the workspace id and the file path; every broadcast carries `ws` so
  // clients ignore traffic for a workspace they're not currently viewing.
  const dkey = (ws: string, path: string) => `${ws}\u0000${path}`;

  const loadDoc = (ws: string, path: string): CRDT => {
    const k = dkey(ws, path);
    if (!docs.has(k)) {
      const abs = safeJoin(ctx(ws).ws.root, path);
      const doc = new CRDT(0); // server is site 0
      const text = existsSync(abs) ? readFileSync(abs, "utf8") : "";
      for (let i = 0; i < text.length; i++) doc.localInsert(i, text[i]);
      docs.set(k, doc);
    }
    return docs.get(k)!;
  };
  const persist = (ws: string, path: string, doc: CRDT) => {
    const abs = safeJoin(ctx(ws).ws.root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, doc.value());
  };
  const usersOn = (ws: string, path: string): CollabUser[] => [...(presence.get(dkey(ws, path))?.values() ?? [])];
  const announce = (ws: string, path: string) =>
    broadcast({ type: "presence", data: { ws, path, users: usersOn(ws, path) } });
  const cursorsOn = (ws: string, path: string) => {
    const out: Array<{ id: string; name: string; color: string; anchor: unknown }> = [];
    for (const client of wss.clients) {
      const s = sockState.get(client);
      if (s && s.ws === ws && s.path === path) out.push({ id: s.id, name: s.user.name, color: s.user.color, anchor: s.cursor });
    }
    return out;
  };
  const announceCursors = (ws: string, path: string) =>
    broadcast({ type: "doc.cursors", data: { ws, path, cursors: cursorsOn(ws, path) } });
  // per-workspace "who's looking at which step" roster (presence in the DAG)
  const focusRoster = (ws: string) => {
    const out: Array<{ id: string; name: string; color: string; key: string }> = [];
    for (const client of wss.clients) {
      const s = sockState.get(client);
      if (s && s.ws === ws && s.focus) out.push({ id: s.id, name: s.user.name, color: s.user.color, key: s.focus });
    }
    return out;
  };
  const announceFocus = (ws: string) => broadcast({ type: "presence.focus", data: { ws, focus: focusRoster(ws) } });
  const isManaged = (ws: string, path: string): boolean => {
    const { ws: w, dirs } = ctx(ws);
    const file = resolve(w.root, path); // resolve (not safeJoin) so traversal just reads as unmanaged
    return [dirs.inputs, dirs.prompts, dirs.context].some((d) => isInside(d, file));
  };
  const leave = (socket: WebSocket) => {
    const st = sockState.get(socket);
    if (st?.path && presence.has(dkey(st.ws, st.path))) {
      const { ws, path } = st;
      const k = dkey(ws, path);
      const room = presence.get(k)!;
      room.delete(st.id);
      st.path = null;
      st.cursor = null;
      announce(ws, path);
      announceCursors(ws, path); // drop their caret from peers' editors
      // free the in-memory CRDT once the last editor leaves; it's already
      // persisted to disk and reloads cleanly on the next open.
      if (room.size === 0) {
        presence.delete(k);
        docs.delete(k);
      }
    } else if (st) {
      st.path = null;
      st.cursor = null;
    }
  };

  wss.on("connection", (socket) => {
    const site = nextId++;
    const id = `c${site}`;
    sockState.set(socket, { id, user: { id, name: "Guest", color: "#888" }, ws: defaultWsId ?? "", path: null, cursor: null, focus: null });
    socket.send(JSON.stringify({ type: "hello", clientId: id, site, ws: defaultWsId, ts: new Date().toISOString() }));

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
        if (st.path) announce(st.ws, st.path);
        if (st.focus) announceFocus(st.ws); // refresh name/color on the DAG too
      } else if (m.type === "ws.select" && typeof m.ws === "string") {
        // switching workspaces: drop presence/focus in the old one
        const old = st.ws;
        leave(socket);
        if (st.focus) { st.focus = null; announceFocus(old); }
        st.ws = m.ws;
      } else if (m.type === "doc.open" && typeof m.path === "string") {
        // only managed files (inputs/, prompts/, context/) can be opened — the
        // same confinement the REST file API enforces
        if (!isManaged(st.ws, m.path)) return;
        leave(socket);
        st.path = m.path;
        const k = dkey(st.ws, m.path);
        if (!presence.has(k)) presence.set(k, new Map());
        presence.get(k)!.set(st.id, st.user);
        const doc = loadDoc(st.ws, m.path);
        socket.send(JSON.stringify({ type: "doc.snapshot", data: { ws: st.ws, path: m.path, nodes: doc.snapshot() } }));
        announce(st.ws, m.path);
        announceCursors(st.ws, m.path); // bring the new joiner up to date on carets
      } else if (m.type === "doc.close") {
        leave(socket);
      } else if (m.type === "doc.ops" && typeof m.path === "string" && Array.isArray(m.ops)) {
        if (!isManaged(st.ws, m.path)) return;
        const doc = loadDoc(st.ws, m.path);
        for (const op of m.ops as Op[]) doc.apply(op);
        persist(st.ws, m.path, doc);
        // relay to everyone else editing this file in this workspace
        broadcast({ type: "doc.ops", data: { ws: st.ws, path: m.path, ops: m.ops, by: st.id } });
      } else if (m.type === "cursor" && typeof m.path === "string" && st.path === m.path) {
        // anchor is opaque to the server — peers resolve it via their CRDT
        st.cursor = m.anchor ?? null;
        announceCursors(st.ws, m.path);
      } else if (m.type === "focus") {
        // which workflow step this client is viewing (or null) — drives DAG presence
        const next = typeof m.focus === "string" ? m.focus.slice(0, 200) : null;
        if (next !== st.focus) {
          st.focus = next;
          announceFocus(st.ws);
        }
      }
    });

    socket.on("close", () => {
      const st = sockState.get(socket);
      const ws = st?.ws;
      leave(socket);
      if (ws) announceFocus(ws); // the socket is gone from wss.clients, so it drops off the DAG
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    // CSRF guard: a state-changing request carrying a non-loopback Origin is a
    // cross-site forgery from a page in the user's browser — refuse it. (GETs
    // are protected by the same-origin policy: a cross-site page can't read the
    // response without a CORS header, which we never send.)
    if (method !== "GET" && method !== "HEAD" && !isAllowedOrigin(req.headers.origin)) {
      return sendJson(res, 403, { error: "cross-origin request refused" });
    }

    // --- API ---
    if (path.startsWith("/api/")) return api(req, res, url, method, broadcast);

    // --- exported HTML, scoped per workspace: /export/<wsId>/<file> ---
    if (path.startsWith("/export/")) {
      const parts = path.slice("/export/".length).split("/");
      // First segment is a workspace id when it resolves; otherwise treat the
      // whole tail as a file under the default workspace (back-compat).
      const hasWs = parts[0] && resolveWorkspaceRoot(parts[0]);
      const exWs = hasWs ? parts[0] : defaultWsId;
      const rel = (hasWs ? parts.slice(1).join("/") : parts.join("/")) || "index.html";
      const { store } = ctx(exWs);
      const file = join(store.exportsDir, rel);
      if (existsSync(file) && isInside(store.exportsDir, file) && statSync(file).isFile()) {
        res.writeHead(200, { "content-type": MIME[".html"] });
        return res.end(readFileSync(file));
      }
      return send(res, 404, "not found");
    }

    // --- static SPA ---
    return serveStatic(path, res);
  }

  await new Promise<void>((r) => server.listen(port, host, r));
  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
  const lan = host !== "127.0.0.1" && host !== "localhost" && host !== "::1";
  if (!quiet) {
    // eslint-disable-next-line no-console
    console.log(
      `\n  Loom UI running at http://localhost:${boundPort}` +
        (MOCK ? "  (mock mode — no API calls)" : "") +
        (lan ? `\n  ⚠ bound to ${host} — reachable on your network; the file API has no auth` : "") +
        `\n  (Ctrl+C to stop)\n`,
    );
  }
  return {
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => {
          // Force-close any lingering sockets (e.g. a rejected cross-origin
          // upgrade left a keep-alive connection) so close() can't hang.
          server.closeAllConnections?.();
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }),
  };
}

function serveStatic(path: string, res: ServerResponse) {
  const rel = path === "/" ? "index.html" : path.replace(/^\//, "");
  const file = resolve(PUBLIC_DIR, rel);
  if (!isInside(PUBLIC_DIR, file) || !existsSync(file) || !statSync(file).isFile()) {
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
  const wsId = reqWs(url); // which workspace this request is scoped to
  // Tag broadcast events with the workspace so clients viewing a different one
  // ignore them (e.g. a build in workspace A must not animate workspace B's DAG).
  const bcast = (e: unknown) => broadcast(e && typeof e === "object" ? { ...(e as object), ws: wsId } : e);

  // --- multi-workspace registry ---
  if (path === "/api/workspaces" && method === "GET") {
    return sendJson(res, 200, {
      workspaces: listWorkspaces().map((w) => ({ ...w, default: w.id === defaultWsId })),
      current: wsId,
    });
  }
  if (path === "/api/workspaces" && method === "POST") {
    const body = JSON.parse(await readBody(req)) as { root?: string };
    if (!body.root) return sendJson(res, 400, { error: "missing `root`" });
    try {
      const entry = addWorkspace(body.root);
      return sendJson(res, 200, { workspace: entry });
    } catch (err) {
      return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (path === "/api/workspaces" && method === "DELETE") {
    const id = url.searchParams.get("id") ?? "";
    if (id === defaultWsId) return sendJson(res, 400, { error: "can't remove the active workspace" });
    return sendJson(res, 200, { ok: removeWorkspace(id) });
  }

  // An explicitly-named workspace that doesn't resolve is a 400, not a 500.
  const explicitWs = url.searchParams.get("ws");
  if (explicitWs && !resolveWorkspaceRoot(explicitWs)) {
    return sendJson(res, 400, { error: `Unknown workspace: ${explicitWs}` });
  }

  if (path === "/api/workspace" && method === "GET") {
    const { ws, store } = ctx(wsId);
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
    const { dirs } = ctx(wsId);
    const inputsRel = (dirs.inputs.split(sep).pop() ?? "inputs");
    const files = listFilesRecursive(dirs.inputs).map((f) => `${inputsRel}/${f}`);
    return sendJson(res, 200, { files });
  }

  if (path === "/api/prompts" && method === "GET") {
    const { dirs } = ctx(wsId);
    return sendJson(res, 200, { prompts: listPrompts(dirs).map((p) => ({ name: p.name, content: p.content })) });
  }

  if (path === "/api/context" && method === "GET") {
    const { dirs } = ctx(wsId);
    const rel = dirs.context.split(sep).pop() ?? "context";
    const files = listFilesRecursive(dirs.context).map((f) => `${rel}/${f}`);
    return sendJson(res, 200, { files, dir: rel });
  }

  if (path === "/api/config" && method === "GET") {
    const { ws } = ctx(wsId);
    return sendJson(res, 200, { config: ws.config, raw: readFileSync(ws.configPath, "utf8") });
  }

  if (path === "/api/config" && method === "PUT") {
    const { ws, store } = ctx(wsId);
    const body = JSON.parse(await readBody(req)) as { config?: unknown; raw?: string };
    try {
      if (typeof body.raw === "string") writeConfigRaw(ws, body.raw);
      else writeConfig(ws, body.config as never);
    } catch (err) {
      return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    bcast(store.appendEvent("file.changed", { path: "loom.yaml" }));
    return sendJson(res, 200, { ok: true });
  }

  if (path === "/api/file" && method === "GET") {
    const { ws, dirs } = ctx(wsId);
    const rel = url.searchParams.get("path") ?? "";
    const file = resolve(ws.root, rel);
    // reads are confined to the managed content dirs (same as writes), so the
    // API can't be used to slurp .loom/ internals or arbitrary workspace files
    const managed = [dirs.inputs, dirs.prompts, dirs.context];
    if (!managed.some((d) => isInside(d, file))) {
      return sendJson(res, 403, { error: "reads are only allowed under inputs/, prompts/, context/" });
    }
    if (!existsSync(file) || !statSync(file).isFile()) return sendJson(res, 404, { error: "not found" });
    return sendJson(res, 200, { path: rel, content: readFileSync(file, "utf8") });
  }

  if (path === "/api/file" && method === "PUT") {
    const { ws, dirs, store } = ctx(wsId);
    const body = JSON.parse(await readBody(req)) as { path: string; content: string };
    const file = resolve(ws.root, body.path);
    // Restrict writes to the managed content directories.
    const allowed = [dirs.inputs, dirs.prompts, dirs.context];
    if (!allowed.some((d) => isInside(d, file))) {
      return sendJson(res, 403, { error: "writes are only allowed under inputs/, prompts/, context/" });
    }
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body.content);
    const event = store.appendEvent("file.changed", { path: body.path });
    bcast(event);
    return sendJson(res, 200, { ok: true });
  }

  if (path === "/api/file" && method === "DELETE") {
    const { ws, dirs, store } = ctx(wsId);
    const rel = url.searchParams.get("path") ?? "";
    const file = resolve(ws.root, rel);
    const allowed = [dirs.inputs, dirs.prompts, dirs.context];
    if (!allowed.some((d) => isInside(d, file))) {
      return sendJson(res, 403, { error: "only files under inputs/, prompts/, context/ can be deleted" });
    }
    if (existsSync(file)) {
      const { rmSync } = await import("node:fs");
      rmSync(file);
    }
    bcast(store.appendEvent("file.changed", { path: rel, deleted: true }));
    return sendJson(res, 200, { ok: true });
  }

  if (path === "/api/artifacts" && method === "GET") {
    const { store } = ctx(wsId);
    return sendJson(res, 200, { artifacts: store.listArtifacts() });
  }

  if (path === "/api/artifact" && method === "GET") {
    const { store } = ctx(wsId);
    const key = url.searchParams.get("key") ?? "";
    const artifact = store.getArtifact(key);
    if (!artifact) return sendJson(res, 404, { error: "not found" });
    return sendJson(res, 200, { artifact, content: store.getArtifactContent(key) });
  }

  if (path === "/api/step-output" && method === "GET") {
    const { store } = ctx(wsId);
    const workflow = url.searchParams.get("workflow") ?? "";
    const step = url.searchParams.get("step") ?? "";
    const key = store.getStepArtifactKey(workflow, step);
    if (!key || !store.hasArtifact(key)) return sendJson(res, 404, { error: "not built" });
    return sendJson(res, 200, { artifact: store.getArtifact(key), content: store.getArtifactContent(key) });
  }

  if (path === "/api/artifact-history" && method === "GET") {
    const { store } = ctx(wsId);
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
    const { store } = ctx(wsId);
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
    const { engine } = ctx(wsId);
    const workflow = url.searchParams.get("workflow") ?? "";
    return sendJson(res, 200, { status: engine.status(workflow) });
  }

  if (path === "/api/metrics" && method === "GET") {
    const { store } = ctx(wsId);
    return sendJson(res, 200, { metrics: computeMetrics(store), mock: MOCK });
  }

  if (path === "/api/events" && method === "GET") {
    const { store } = ctx(wsId);
    const limit = Number(url.searchParams.get("limit") ?? "100");
    return sendJson(res, 200, { events: store.readEvents(limit) });
  }

  if (path === "/api/build" && method === "POST") {
    const { engine } = ctx(wsId);
    const body = JSON.parse(await readBody(req)) as { workflow: string; force?: boolean };
    // Fire-and-stream: events go over the websocket; the POST resolves with the result.
    const result = await engine.buildWorkflow(body.workflow, {
      force: body.force,
      onEvent: (e) => bcast(e),
      onDelta: (stepId, text) => bcast({ type: "step.delta", data: { stepId, text } }),
    });
    return sendJson(res, 200, { result });
  }

  if (path === "/api/snapshot" && method === "POST") {
    const { ws, store } = ctx(wsId);
    const body = JSON.parse(await readBody(req)) as { message?: string };
    const message = body.message || `Snapshot ${new Date().toISOString()}`;
    const result = gitSnapshot(ws.root, message);
    if (result.ok) bcast(store.appendEvent("snapshot", { hash: result.hash, message }));
    return sendJson(res, 200, result);
  }

  if (path === "/api/snapshots" && method === "GET") {
    const { ws } = ctx(wsId);
    return sendJson(res, 200, { snapshots: listSnapshots(ws.root) });
  }

  if (path === "/api/snapshot-changes" && method === "GET") {
    const { ws } = ctx(wsId);
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";
    return sendJson(res, 200, { files: changedFiles(ws.root, from, to) });
  }

  if (path === "/api/snapshot-diff" && method === "GET") {
    const { ws } = ctx(wsId);
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";
    const file = url.searchParams.get("path") ?? "";
    const a = readFileAtSnapshot(ws.root, from, file) ?? "";
    const b = readFileAtSnapshot(ws.root, to, file) ?? "";
    const ops = diffLines(a, b);
    return sendJson(res, 200, { ops, stats: diffStats(ops), path: file });
  }

  if (path === "/api/export" && method === "POST") {
    const { ws, store } = ctx(wsId);
    const body = JSON.parse(await readBody(req)) as { workflow: string };
    const { path: filePath } = exportWorkflowHtml(ws, store, body.workflow);
    bcast(store.appendEvent("export", { workflowId: body.workflow, path: filePath }));
    return sendJson(res, 200, { path: filePath, url: `/export/${wsId}/${body.workflow}.html` });
  }

  if (path === "/api/export-all" && method === "POST") {
    const { ws, store } = ctx(wsId);
    const { indexPath, pages } = exportAllHtml(ws, store);
    bcast(store.appendEvent("export", { workflowId: "*", path: indexPath }));
    return sendJson(res, 200, { indexPath, indexUrl: `/export/${wsId}/index.html`, pages });
  }

  if (path === "/api/export-bundle" && method === "POST") {
    const { ws, store } = ctx(wsId);
    const { path: filePath } = exportBundleHtml(ws, store);
    bcast(store.appendEvent("export", { workflowId: "bundle", path: filePath }));
    return sendJson(res, 200, { path: filePath, url: `/export/${wsId}/bundle.html` });
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

/** True if `child` is `dir` itself or strictly contained in it (no sibling-prefix). */
function isInside(dir: string, child: string): boolean {
  return child === dir || child.startsWith(dir + sep);
}

/**
 * Defend the local file API against malicious web pages (CSRF / cross-site
 * WebSocket hijacking): a browser always sends an Origin on WS handshakes and
 * on cross-site state-changing requests, so we only accept loopback origins.
 * A missing Origin means a non-browser client (the CLI, tests) — allowed.
 */
function isAllowedOrigin(origin: string | undefined | null): boolean {
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
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
