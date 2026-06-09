import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.js";
import type { Artifact } from "../src/core/types.js";

function makeStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "loom-store-"));
  const store = new Store(join(dir, ".loom"));
  store.init();
  return { store, dir };
}

function artifact(key: string, createdAt: string, stepId = "outline"): Artifact {
  return {
    key,
    workflowId: "wf",
    stepId,
    stepType: "inference",
    model: "claude-opus-4-8",
    output: "o.md",
    inputs: [],
    createdAt,
    durationMs: 1,
    status: "success",
    contentBytes: 0,
  };
}

test("putArtifact / getArtifact round-trips content + metadata", () => {
  const { store, dir } = makeStore();
  try {
    store.putArtifact(artifact("k1", "2026-01-01T00:00:00Z"), "hello");
    assert.equal(store.hasArtifact("k1"), true);
    assert.equal(store.getArtifactContent("k1"), "hello");
    assert.equal(store.getArtifact("k1")?.model, "claude-opus-4-8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listStepArtifacts returns versions newest-first, filtered by step", () => {
  const { store, dir } = makeStore();
  try {
    store.putArtifact(artifact("old", "2026-01-01T00:00:00Z"), "v1");
    store.putArtifact(artifact("new", "2026-02-01T00:00:00Z"), "v2");
    store.putArtifact(artifact("other", "2026-03-01T00:00:00Z", "draft"), "x");
    const versions = store.listStepArtifacts("wf", "outline").map((a) => a.key);
    assert.deepEqual(versions, ["new", "old"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state tracks the current artifact per step", () => {
  const { store, dir } = makeStore();
  try {
    store.setStepArtifact("wf", "outline", "k1");
    assert.equal(store.getStepArtifactKey("wf", "outline"), "k1");
    store.setStepArtifact("wf", "outline", "k2");
    assert.equal(store.getStepArtifactKey("wf", "outline"), "k2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("event log appends and reads back in order", () => {
  const { store, dir } = makeStore();
  try {
    store.appendEvent("build.start", { workflowId: "wf" });
    store.appendEvent("build.done", { workflowId: "wf", ok: true });
    const events = store.readEvents();
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "build.start");
    assert.equal(events[1].type, "build.done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("materialize writes the output under outputs/<wf>/<output>", () => {
  const { store, dir } = makeStore();
  try {
    const path = store.materialize("wf", "brief.md", "BODY");
    assert.equal(readFileSync(path, "utf8"), "BODY");
    assert.match(path, /outputs\/wf\/brief\.md$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
