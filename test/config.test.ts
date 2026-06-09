import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkspace, writeConfig, writeConfigRaw, validateWorkspaceConfig } from "../src/core/workspace.js";

function ws() {
  const root = mkdtempSync(join(tmpdir(), "loom-cfg-"));
  writeFileSync(join(root, "loom.yaml"), "name: demo\nworkflows:\n  - id: a\n    steps: []\n");
  return { root, ws: loadWorkspace(root) };
}

test("writeConfig persists a new workflow and reloads it", () => {
  const { root, ws: w } = ws();
  try {
    w.config.workflows.push({ id: "b", steps: [] });
    writeConfig(w, w.config);
    const reloaded = loadWorkspace(root);
    assert.deepEqual(reloaded.config.workflows.map((x) => x.id), ["a", "b"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeConfigRaw rejects invalid config and leaves the file intact", () => {
  const { root, ws: w } = ws();
  try {
    assert.throws(
      () => writeConfigRaw(w, "name: demo\nworkflows:\n  - id: a\n    steps:\n      - id: s\n        type: bogus\n        output: o.md\n"),
      /must be "inference" or "agent"/,
    );
    // original file is untouched / still loadable
    assert.equal(loadWorkspace(root).config.workflows[0].id, "a");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validateWorkspaceConfig flags duplicate step ids", () => {
  assert.throws(
    () =>
      validateWorkspaceConfig({
        name: "x",
        workflows: [
          {
            id: "w",
            steps: [
              { id: "s", type: "inference", output: "o", prompt: "p" },
              { id: "s", type: "inference", output: "o2", prompt: "p" },
            ],
          },
        ],
      }),
    /duplicate step id "s"/,
  );
});
