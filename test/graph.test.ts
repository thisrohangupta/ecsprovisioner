import { test } from "node:test";
import assert from "node:assert/strict";
import { topoSort, dagEdges, stepDeps } from "../src/core/graph.js";
import type { Workflow } from "../src/core/types.js";

function wf(steps: Workflow["steps"]): Workflow {
  return { id: "wf", steps };
}

const a = { id: "a", type: "inference", output: "a.md", prompt: "p" } as const;
const b = { id: "b", type: "inference", output: "b.md", prompt: "p", inputs: ["step:a"] } as const;
const c = { id: "c", type: "inference", output: "c.md", prompt: "p", inputs: ["step:b", "inputs/x.md"] } as const;

test("stepDeps extracts only step: references", () => {
  assert.deepEqual(stepDeps(c), ["b"]);
  assert.deepEqual(stepDeps(a), []);
});

test("dagEdges returns dependency edges", () => {
  assert.deepEqual(dagEdges(wf([a, b, c])), [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
  ]);
});

test("topoSort orders dependencies before dependents", () => {
  // authored out of order on purpose
  const order = topoSort(wf([c, b, a])).map((s) => s.id);
  assert.ok(order.indexOf("a") < order.indexOf("b"));
  assert.ok(order.indexOf("b") < order.indexOf("c"));
});

test("topoSort throws on an unknown dependency", () => {
  const bad = { id: "x", type: "inference", output: "x.md", prompt: "p", inputs: ["step:ghost"] } as const;
  assert.throws(() => topoSort(wf([bad])), /unknown step "ghost"/);
});

test("topoSort throws on a cycle", () => {
  const a1 = { id: "a", type: "inference", output: "a", prompt: "p", inputs: ["step:b"] } as const;
  const b1 = { id: "b", type: "inference", output: "b", prompt: "p", inputs: ["step:a"] } as const;
  assert.throws(() => topoSort(wf([a1, b1])), /Cycle detected/);
});
