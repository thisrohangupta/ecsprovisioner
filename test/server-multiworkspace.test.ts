import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

// Hermetic registry before importing anything that touches it.
process.env.LOOM_HOME = mkdtempSync(join(tmpdir(), "loom-home-"));
const { scaffoldWorkspace } = await import("../src/core/scaffold.js");
const { addWorkspace, workspaceId } = await import("../src/core/registry.js");
const { startServer } = await import("../src/server/server.js");
type ServerHandle = Awaited<ReturnType<typeof startServer>>;

function connect(port: number, name: string) {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const msgs: any[] = [];
  const waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = [];
  const client = {
    ws,
    id: null as string | null,
    defaultWs: null as string | null,
    send: (o: unknown) => ws.send(JSON.stringify(o)),
    waitFor(pred: (m: any) => boolean, ms = 2000): Promise<any> {
      const hit = msgs.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${name}: timed out`)), ms);
        waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
      });
    },
    close: () => ws.close(),
  };
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    msgs.push(m);
    if (m.type === "hello") {
      client.id = m.clientId;
      client.defaultWs = m.ws;
      client.send({ type: "identify", name, color: "#3b6fb0" });
    }
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(m)) { waiters[i].resolve(m); waiters.splice(i, 1); }
    }
  });
  return new Promise<typeof client>((resolve, reject) => {
    ws.on("open", () => resolve(client));
    ws.on("error", reject);
  });
}

// Two workspaces: A is the cwd (default), B is registered alongside it.
async function withTwoWorkspaces(fn: (ctx: { port: number; aRoot: string; bRoot: string; aId: string; bId: string }) => Promise<void>) {
  const aRoot = mkdtempSync(join(tmpdir(), "loom-A-"));
  const bRoot = mkdtempSync(join(tmpdir(), "loom-B-"));
  scaffoldWorkspace(aRoot, "alpha");
  scaffoldWorkspace(bRoot, "beta");
  const aId = workspaceId("alpha", aRoot);
  const bId = workspaceId("beta", bRoot);
  addWorkspace(bRoot); // register B; A gets registered as cwd on startServer
  const cwd = process.cwd();
  process.chdir(aRoot);
  let handle: ServerHandle | null = null;
  try {
    handle = await startServer({ port: 0, mock: true, quiet: true });
    await fn({ port: handle.port, aRoot, bRoot, aId, bId });
  } finally {
    if (handle) await handle.close();
    process.chdir(cwd);
    rmSync(aRoot, { recursive: true, force: true });
    rmSync(bRoot, { recursive: true, force: true });
  }
}

test("/api/workspaces lists both, and /api/workspace is scoped by ?ws", async () => {
  await withTwoWorkspaces(async ({ port, aId, bId }) => {
    const list = await (await fetch(`http://localhost:${port}/api/workspaces`)).json();
    const ids = list.workspaces.map((w: any) => w.id).sort();
    assert.deepEqual(ids.sort(), [aId, bId].sort());
    assert.equal(list.current, aId, "cwd workspace is the default");

    const a = await (await fetch(`http://localhost:${port}/api/workspace?ws=${aId}`)).json();
    const b = await (await fetch(`http://localhost:${port}/api/workspace?ws=${bId}`)).json();
    assert.equal(a.name, "alpha");
    assert.equal(b.name, "beta");

    // an unknown workspace id is a clean 400, not a silent default or a 500
    const bad = await fetch(`http://localhost:${port}/api/workspace?ws=nope-000000`);
    assert.equal(bad.status, 400);
  });
});

test("DAG focus presence is isolated per workspace", async () => {
  await withTwoWorkspaces(async ({ port, bId }) => {
    const a = await connect(port, "Alice"); // stays on default workspace A
    const b = await connect(port, "Bob");
    await a.waitFor((m) => m.type === "hello");
    await b.waitFor((m) => m.type === "hello");

    // Bob switches to workspace B
    b.send({ type: "ws.select", ws: bId });

    // Alice focuses a step in A; Bob focuses the same key but in B
    a.send({ type: "focus", focus: "brief::outline" });
    b.send({ type: "focus", focus: "brief::outline" });

    // The roster for A names only Alice; the roster for B names only Bob.
    const rosterA = await a.waitFor((m) => m.type === "presence.focus" && m.data.ws === a.defaultWs && m.data.focus.length > 0);
    const rosterB = await b.waitFor((m) => m.type === "presence.focus" && m.data.ws === bId && m.data.focus.length > 0);
    assert.deepEqual(rosterA.data.focus.map((f: any) => f.id), [a.id]);
    assert.deepEqual(rosterB.data.focus.map((f: any) => f.id), [b.id]);

    a.close();
    b.close();
  });
});

test("edits in two workspaces persist to their own files, not each other", async () => {
  await withTwoWorkspaces(async ({ port, aRoot, bRoot, bId }) => {
    const a = await connect(port, "Alice");
    const b = await connect(port, "Bob");
    await a.waitFor((m) => m.type === "hello");
    await b.waitFor((m) => m.type === "hello");
    b.send({ type: "ws.select", ws: bId });

    // Both open the same relative path, but in different workspaces.
    const path = "inputs/notes.md";
    a.send({ type: "doc.open", path });
    b.send({ type: "doc.open", path });
    const snapA = await a.waitFor((m) => m.type === "doc.snapshot" && m.data.path === path);

    // Alice prepends "AAA" at the very start of A's file.
    const ops: any[] = [];
    let prev: any = null;
    for (const ch of "AAA") {
      const id = { c: (ops.length + 1), s: a.id === null ? 1 : 1 }; // site doesn't matter for the server merge
      ops.push({ t: "ins", id: { c: ops.length + 1, s: 9 }, origin: prev, ch });
      prev = { c: ops.length, s: 9 };
    }
    a.send({ type: "doc.ops", path, ops });

    // Give the server a beat to apply + persist.
    await new Promise((r) => setTimeout(r, 150));

    const aText = readFileSync(join(aRoot, path), "utf8");
    const bText = readFileSync(join(bRoot, path), "utf8");
    assert.ok(aText.startsWith("AAA"), "A's file received the edit");
    assert.ok(!bText.startsWith("AAA"), "B's file is untouched by A's edit");
    assert.ok(snapA.data.nodes.length > 0);

    a.close();
    b.close();
  });
});
