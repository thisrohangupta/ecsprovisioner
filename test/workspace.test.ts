import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globFiles, findWorkspaceRoot, loadWorkspace } from "../src/core/workspace.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "loom-ws-"));
}

test("globFiles matches *.md in one segment", () => {
  const root = tmp();
  try {
    writeFileSync(join(root, "a.md"), "a");
    writeFileSync(join(root, "b.md"), "b");
    writeFileSync(join(root, "c.txt"), "c");
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "d.md"), "d");
    const got = globFiles(root, "*.md").map((p) => p.replace(root + "/", ""));
    assert.deepEqual(got.sort(), ["a.md", "b.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("globFiles ** matches any depth", () => {
  const root = tmp();
  try {
    mkdirSync(join(root, "x", "y"), { recursive: true });
    writeFileSync(join(root, "top.md"), "1");
    writeFileSync(join(root, "x", "mid.md"), "2");
    writeFileSync(join(root, "x", "y", "deep.md"), "3");
    const got = globFiles(root, "**/*.md").map((p) => p.replace(root + "/", ""));
    assert.deepEqual(got.sort(), ["top.md", "x/mid.md", "x/y/deep.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("globFiles treats a literal path as a single file", () => {
  const root = tmp();
  try {
    writeFileSync(join(root, "only.md"), "x");
    assert.equal(globFiles(root, "only.md").length, 1);
    assert.equal(globFiles(root, "missing.md").length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findWorkspaceRoot walks up to the config", () => {
  const root = tmp();
  try {
    writeFileSync(join(root, "loom.yaml"), "name: x\nworkflows: []\n");
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    assert.equal(findWorkspaceRoot(nested), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadWorkspace parses yaml config", () => {
  const root = tmp();
  try {
    writeFileSync(join(root, "loom.yaml"), "name: demo\nworkflows:\n  - id: w\n    steps: []\n");
    const ws = loadWorkspace(root);
    assert.equal(ws.config.name, "demo");
    assert.equal(ws.config.workflows[0].id, "w");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadWorkspace rejects duplicate workflow ids", () => {
  const root = tmp();
  try {
    writeFileSync(
      join(root, "loom.yaml"),
      "name: demo\nworkflows:\n  - id: dup\n    steps: []\n  - id: dup\n    steps: []\n",
    );
    assert.throws(() => loadWorkspace(root), /duplicate workflow id "dup"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadWorkspace rejects an invalid step type", () => {
  const root = tmp();
  try {
    writeFileSync(
      join(root, "loom.yaml"),
      "name: demo\nworkflows:\n  - id: w\n    steps:\n      - id: s\n        type: nope\n        output: o.md\n",
    );
    assert.throws(() => loadWorkspace(root), /must be "inference" or "agent"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
