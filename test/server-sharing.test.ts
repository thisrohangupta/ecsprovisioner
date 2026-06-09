import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

process.env.LOOM_HOME = mkdtempSync(join(tmpdir(), "loom-home-"));
const { scaffoldWorkspace } = await import("../src/core/scaffold.js");
const { workspaceId } = await import("../src/core/registry.js");
const { startServer } = await import("../src/server/server.js");
type ServerHandle = Awaited<ReturnType<typeof startServer>>;

// Run with ownerLoopback:false so the loopback test client is NOT auto-owner —
// access is governed entirely by tokens, exactly as in a hosted deployment.
async function withServer(fn: (ctx: { port: number; wsId: string }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "loom-share-"));
  scaffoldWorkspace(root, "sharews");
  const wsId = workspaceId("sharews", root); // this server's default workspace
  const cwd = process.cwd();
  process.chdir(root);
  let handle: ServerHandle | null = null;
  try {
    handle = await startServer({ port: 0, mock: true, quiet: true, ownerLoopback: false });
    await fn({ port: handle.port, wsId });
  } finally {
    if (handle) await handle.close();
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
}

const j = (r: Response) => r.json();

test("an owner mints role tokens; viewers read-only, editors can write", async () => {
  await withServer(async ({ port, wsId }) => {
    const base = `http://localhost:${port}`;
    // With ownerLoopback off there's no implicit owner: an un-scoped request
    // with no token is unauthorized.
    const noAuth = await fetch(`${base}/api/workspace?ws=${wsId}`);
    assert.equal(noAuth.status, 401, "no token → unauthorized");

    // Seed an owner token directly through the access store (simulating the
    // host that created the deployment), then everything else goes through HTTP.
    const { createToken } = await import("../src/core/access.js");
    const owner = createToken(wsId, "owner", "host");

    const withTok = (t: string, path: string, init?: RequestInit) =>
      fetch(`${base}${path}${path.includes("?") ? "&" : "?"}ws=${wsId}&token=${t}`, init);

    // owner sees role + can manage sharing
    const meOwner = await j(await withTok(owner.token, "/api/workspace"));
    assert.equal(meOwner.role, "owner");
    const made = await j(
      await withTok(owner.token, "/api/share", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "viewer", label: "guest" }),
      }),
    );
    assert.equal(made.token.role, "viewer");
    const viewerTok = made.token.token;
    const editor = createToken(wsId, "editor", "ed");

    // viewer: can read, cannot write or build or manage sharing
    assert.equal((await withTok(viewerTok, "/api/workspace")).status, 200);
    const vPut = await withTok(viewerTok, "/api/file", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "inputs/notes.md", content: "x" }),
    });
    assert.equal(vPut.status, 403, "viewer cannot write");
    const vBuild = await withTok(viewerTok, "/api/build", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workflow: "brief" }),
    });
    assert.equal(vBuild.status, 403, "viewer cannot build");
    assert.equal((await withTok(viewerTok, "/api/share")).status, 403, "viewer cannot see share links");

    // editor: can write + build, but not manage sharing
    const ePut = await withTok(editor.token, "/api/file", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "inputs/notes.md", content: "edited" }),
    });
    assert.equal(ePut.status, 200, "editor can write");
    assert.equal((await withTok(editor.token, "/api/share")).status, 403, "editor cannot manage sharing");

    // owner can list + revoke the tokens it created
    const tokenList = await j(await withTok(owner.token, "/api/share"));
    assert.ok(tokenList.tokens.length >= 2);
    const delOk = await j(await withTok(owner.token, `/api/share?id=${made.token.id}`, { method: "DELETE" }));
    assert.equal(delOk.ok, true);
    // the revoked viewer token no longer works
    assert.equal((await withTok(viewerTok, "/api/workspace")).status, 401);
  });
});

test("a bad token is unauthorized", async () => {
  await withServer(async ({ port, wsId }) => {
    const r = await fetch(`http://localhost:${port}/api/workspace?ws=${wsId}&token=bogus`);
    assert.equal(r.status, 401);
  });
});

test("a viewer's WebSocket edits are dropped, a viewer can still watch", async () => {
  await withServer(async ({ port, wsId }) => {
    const { createToken } = await import("../src/core/access.js");
    const viewer = createToken(wsId, "viewer", "v");
    const editor = createToken(wsId, "editor", "e");

    function open(tok: string) {
      const ws = new WebSocket(`ws://localhost:${port}/ws?token=${tok}`);
      const msgs: any[] = [];
      const waiters: Array<{ p: (m: any) => boolean; r: (m: any) => void }> = [];
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        msgs.push(m);
        if (m.type === "hello") { ws.send(JSON.stringify({ type: "identify", name: "x", color: "#000" })); ws.send(JSON.stringify({ type: "ws.select", ws: wsId, token: tok })); }
        for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].p(m)) { waiters[i].r(m); waiters.splice(i, 1); }
      });
      const client = {
        ws,
        send: (o: unknown) => ws.send(JSON.stringify(o)),
        waitFor: (p: (m: any) => boolean, ms = 1500) => {
          const hit = msgs.find(p); if (hit) return Promise.resolve(hit);
          return new Promise<any>((res, rej) => { const t = setTimeout(() => rej(new Error("timeout")), ms); waiters.push({ p, r: (m) => { clearTimeout(t); res(m); } }); });
        },
        close: () => ws.close(),
      };
      return new Promise<typeof client>((res) => ws.on("open", () => res(client)));
    }

    const v = await open(viewer.token);
    const e = await open(editor.token);
    // the server tells each client its role for the workspace
    const vRole = await v.waitFor((m) => m.type === "ws.role");
    const eRole = await e.waitFor((m) => m.type === "ws.role");
    assert.equal(vRole.data.role, "viewer");
    assert.equal(eRole.data.role, "editor");

    // both open the same managed file
    v.send({ type: "doc.open", path: "inputs/notes.md" });
    e.send({ type: "doc.open", path: "inputs/notes.md" });
    await v.waitFor((m) => m.type === "doc.snapshot");
    await e.waitFor((m) => m.type === "doc.snapshot");

    // the viewer attempts an edit — the server must NOT relay it to the editor
    let editorSawViewerOp = false;
    e.ws.on("message", (raw) => { const m = JSON.parse(raw.toString()); if (m.type === "doc.ops" && m.data.by && m.data.by !== e.ws) editorSawViewerOp = true; });
    v.send({ type: "doc.ops", path: "inputs/notes.md", ops: [{ t: "ins", id: { c: 1, s: 9 }, origin: null, ch: "Z" }] });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(editorSawViewerOp, false, "the viewer's op was not relayed");

    v.close();
    e.close();
  });
});
