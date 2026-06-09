process.env.LOOM_MOCK_DELAY = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldWorkspace } from "../src/core/scaffold.js";
import { loadWorkspace, resolveDirs } from "../src/core/workspace.js";
import { Store } from "../src/core/store.js";
import { Engine } from "../src/core/engine.js";
import { mockRunners } from "../src/llm/mock.js";
import { exportWorkflowHtml, exportAllHtml } from "../src/core/exporter.js";

async function builtWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "loom-export-"));
  scaffoldWorkspace(root, "demo");
  const ws = loadWorkspace(root);
  const dirs = resolveDirs(ws);
  const store = new Store(dirs.loom);
  store.init();
  await new Engine(ws, dirs, store, mockRunners()).buildWorkflow("brief");
  return { root, ws, store };
}

test("exportWorkflowHtml writes a self-contained page with the output", async () => {
  const { root, ws, store } = await builtWorkspace();
  try {
    const { path, html } = exportWorkflowHtml(ws, store, "brief");
    assert.ok(existsSync(path));
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /Provenance/); // provenance panel present
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exportAllHtml writes an index linking every workflow page", async () => {
  const { root, ws, store } = await builtWorkspace();
  try {
    const { indexPath, pages } = exportAllHtml(ws, store);
    assert.ok(existsSync(indexPath));
    assert.equal(pages.length, ws.config.workflows.length);
    const index = readFileSync(indexPath, "utf8");
    for (const wf of ws.config.workflows) {
      assert.match(index, new RegExp(`${wf.id}\\.html`));
      assert.ok(existsSync(join(store.exportsDir, `${wf.id}.html`)));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
