process.env.LOOM_MOCK_DELAY = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldWorkspace } from "../src/core/scaffold.js";
import { loadWorkspace, resolveDirs } from "../src/core/workspace.js";
import { Store } from "../src/core/store.js";
import { Engine } from "../src/core/engine.js";
import { mockRunners } from "../src/llm/mock.js";
import { computeMetrics } from "../src/core/metrics.js";

async function buildTwice() {
  const root = mkdtempSync(join(tmpdir(), "loom-metrics-"));
  scaffoldWorkspace(root, "demo");
  const ws = loadWorkspace(root);
  const dirs = resolveDirs(ws);
  const store = new Store(dirs.loom);
  store.init();
  const engine = new Engine(ws, dirs, store, mockRunners());
  await engine.buildWorkflow("brief"); // first run: model calls
  await engine.buildWorkflow("brief"); // second run: cache hits
  return { root, store };
}

test("metrics record spend on the first build and savings on the cached rebuild", async () => {
  const { root, store } = await buildTwice();
  try {
    const m = computeMetrics(store);
    assert.equal(m.modelCalls, 2, "two steps ran on the first build");
    assert.equal(m.cacheHits, 2, "two steps were cached on the rebuild");
    assert.ok(m.spentUsd > 0, "spent money on the first build");
    assert.ok(m.savedUsd > 0, "saved money on the cached rebuild");
    assert.ok(m.cacheHitRate > 0 && m.cacheHitRate <= 1);
    assert.equal(m.builds, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
