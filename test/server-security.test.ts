import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

process.env.LOOM_HOME = mkdtempSync(join(tmpdir(), "loom-home-"));
const { scaffoldWorkspace } = await import("../src/core/scaffold.js");
const { startServer } = await import("../src/server/server.js");
type ServerHandle = Awaited<ReturnType<typeof startServer>>;

async function withServer(fn: (port: number) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "loom-sec-"));
  scaffoldWorkspace(root, "sec");
  const cwd = process.cwd();
  process.chdir(root);
  let handle: ServerHandle | null = null;
  try {
    handle = await startServer({ port: 0, mock: true, quiet: true });
    await fn(handle.port);
  } finally {
    if (handle) await handle.close();
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
}

test("state-changing requests from a foreign origin are refused", async () => {
  await withServer(async (port) => {
    const body = JSON.stringify({ path: "inputs/notes.md", content: "x" });
    const headers = { "content-type": "application/json" };

    const evil = await fetch(`http://localhost:${port}/api/file`, {
      method: "PUT", headers: { ...headers, origin: "https://evil.example" }, body,
    });
    assert.equal(evil.status, 403, "cross-origin PUT is blocked");

    const ok = await fetch(`http://localhost:${port}/api/file`, {
      method: "PUT", headers: { ...headers, origin: `http://localhost:${port}` }, body,
    });
    assert.notEqual(ok.status, 403, "same-origin PUT is allowed");

    const noOrigin = await fetch(`http://localhost:${port}/api/file`, { method: "PUT", headers, body });
    assert.notEqual(noOrigin.status, 403, "a non-browser client (no Origin) is allowed");
  });
});

test("GET requests are not blocked by the CSRF guard", async () => {
  await withServer(async (port) => {
    // a cross-site GET still runs (the same-origin policy stops the page from
    // reading the response); we only gate mutations
    const r = await fetch(`http://localhost:${port}/api/workspace`, { headers: { origin: "https://evil.example" } });
    assert.equal(r.status, 200);
  });
});

test("the file API confines reads to the managed directories", async () => {
  await withServer(async (port) => {
    const get = (p: string) => fetch(`http://localhost:${port}/api/file?path=${encodeURIComponent(p)}`);

    assert.equal((await get("inputs/notes.md")).status, 200, "managed file is readable");
    assert.equal((await get("loom.yaml")).status, 403, "config is not exposed via the file API");
    assert.equal((await get(".loom/state.json")).status, 403, "internal state is not exposed");
    assert.equal((await get("../../../etc/hosts")).status, 403, "traversal escapes are blocked");
  });
});

test("WebSocket doc.open is confined to managed files", async () => {
  await withServer(async (port) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const got: any[] = [];
    // attach the handler synchronously so the server's immediate `hello` isn't missed
    await new Promise<void>((resolve) => {
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        got.push(m);
        if (m.type === "hello") {
          ws.send(JSON.stringify({ type: "identify", name: "T", color: "#000" }));
          // an unmanaged file: the server must not open it (no snapshot back)
          ws.send(JSON.stringify({ type: "doc.open", path: "loom.yaml" }));
          // a managed file: this one should yield a snapshot
          ws.send(JSON.stringify({ type: "doc.open", path: "inputs/notes.md" }));
        }
        if (m.type === "doc.snapshot") resolve();
      });
    });
    const snaps = got.filter((m) => m.type === "doc.snapshot");
    assert.equal(snaps.length, 1, "exactly one snapshot — only the managed file opened");
    assert.equal(snaps[0].data.path, "inputs/notes.md");
    assert.ok(!got.some((m) => m.type === "doc.snapshot" && m.data.path === "loom.yaml"), "loom.yaml never opened");
    ws.close();
  });
});

test("WebSocket upgrades from a foreign origin are rejected", async () => {
  await withServer(async (port) => {
    const foreign = new WebSocket(`ws://localhost:${port}/ws`, { origin: "https://evil.example" } as any);
    const rejected = await new Promise<boolean>((resolve) => {
      foreign.on("open", () => { foreign.close(); resolve(false); });
      foreign.on("error", () => resolve(true));
      foreign.on("unexpected-response", () => resolve(true));
    });
    assert.equal(rejected, true, "foreign-origin WS handshake is refused");

    // a same-origin handshake (browser) still connects
    const same = new WebSocket(`ws://localhost:${port}/ws`, { origin: `http://localhost:${port}` } as any);
    const opened = await new Promise<boolean>((resolve) => {
      same.on("open", () => resolve(true));
      same.on("error", () => resolve(false));
    });
    assert.equal(opened, true, "same-origin WS handshake is accepted");
    same.close();
  });
});
