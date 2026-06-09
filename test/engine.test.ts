import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldWorkspace } from "../src/core/scaffold.js";
import { loadWorkspace, resolveDirs } from "../src/core/workspace.js";
import { Store } from "../src/core/store.js";
import { Engine } from "../src/core/engine.js";
import { diffLines, diffStats } from "../src/core/diff.js";

/** A deterministic stand-in for a chat-model call: echoes the rendered prompt
 *  so output changes whenever inputs change, and counts invocations. */
function fakeInference() {
  let calls = 0;
  const runner = async (opts: { prompt: string }) => {
    calls++;
    return { content: `OUTPUT[${calls}]\n${opts.prompt}`, usage: { inputTokens: 1, outputTokens: 1 } };
  };
  return { runner, calls: () => calls };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "loom-engine-"));
  scaffoldWorkspace(root, "demo");
  const ws = loadWorkspace(root);
  const dirs = resolveDirs(ws);
  const store = new Store(dirs.loom);
  store.init();
  const fake = fakeInference();
  const engine = new Engine(ws, dirs, store, { inference: fake.runner as never });
  return { root, ws, dirs, store, engine, fake };
}

test("build runs each step once and produces artifacts", async () => {
  const { root, store, engine, fake } = setup();
  try {
    const result = await engine.buildWorkflow("brief");
    assert.deepEqual(result.steps.map((s) => s.status), ["built", "built"]);
    assert.equal(fake.calls(), 2);
    // both steps recorded in state and have content
    const outlineKey = store.getStepArtifactKey("brief", "outline");
    const draftKey = store.getStepArtifactKey("brief", "draft");
    assert.ok(outlineKey && store.hasArtifact(outlineKey));
    assert.ok(draftKey && store.hasArtifact(draftKey));
    assert.match(store.getArtifactContent(draftKey!), /OUTPUT\[/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rebuild with no changes is fully cached (runner not called again)", async () => {
  const { root, engine, fake } = setup();
  try {
    await engine.buildWorkflow("brief");
    assert.equal(fake.calls(), 2);
    const second = await engine.buildWorkflow("brief");
    assert.deepEqual(second.steps.map((s) => s.status), ["cached", "cached"]);
    assert.equal(fake.calls(), 2, "no new model calls on a clean rebuild");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status reports steps fresh after a build", async () => {
  const { root, engine } = setup();
  try {
    await engine.buildWorkflow("brief");
    const status = engine.status("brief");
    assert.ok(status.every((s) => s.fresh), "all steps fresh right after build");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("editing an input invalidates the affected steps and creates a new version", async () => {
  const { root, dirs, store, engine, fake } = setup();
  try {
    await engine.buildWorkflow("brief");
    assert.equal(fake.calls(), 2);

    // change a source input
    writeFileSync(join(dirs.inputs, "notes.md"), "# Different notes\n\nbrand new content");

    const status = engine.status("brief");
    const outline = status.find((s) => s.stepId === "outline")!;
    assert.equal(outline.fresh, false, "outline is no longer fresh after its input changed");
    // it was built once before, so it reads as *stale* (rebuildable), not *unbuilt*
    assert.equal(outline.built, true, "a previously-built step stays 'built' after an input change");
    assert.equal(outline.hasArtifact, false, "…even though the new content key isn't cached yet");

    const result = await engine.buildWorkflow("brief");
    assert.deepEqual(result.steps.map((s) => s.status), ["built", "built"]);
    assert.equal(fake.calls(), 4, "both steps recomputed");

    // a second version of the outline artifact now exists
    const versions = store.listStepArtifacts("brief", "outline");
    assert.equal(versions.length, 2);

    // and the two versions differ
    const ops = diffLines(
      store.getArtifactContent(versions[1].key),
      store.getArtifactContent(versions[0].key),
    );
    const stats = diffStats(ops);
    assert.ok(stats.added + stats.removed > 0, "versions should differ");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--force rebuilds even when nothing changed", async () => {
  const { root, engine, fake } = setup();
  try {
    await engine.buildWorkflow("brief");
    const forced = await engine.buildWorkflow("brief", { force: true });
    assert.deepEqual(forced.steps.map((s) => s.status), ["built", "built"]);
    assert.equal(fake.calls(), 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
