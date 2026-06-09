import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines, diffStats } from "../src/core/diff.js";

test("diffLines: identical content has no changes", () => {
  const ops = diffLines("a\nb\nc", "a\nb\nc");
  assert.ok(ops.every((o) => o.type === "eq"));
  assert.deepEqual(diffStats(ops), { added: 0, removed: 0 });
});

test("diffLines: detects an added line", () => {
  const ops = diffLines("a\nb", "a\nb\nc");
  assert.deepEqual(diffStats(ops), { added: 1, removed: 0 });
  assert.deepEqual(
    ops.map((o) => `${o.type}:${o.text}`),
    ["eq:a", "eq:b", "add:c"],
  );
});

test("diffLines: detects a removed line", () => {
  const ops = diffLines("a\nb\nc", "a\nc");
  assert.deepEqual(diffStats(ops), { added: 0, removed: 1 });
});

test("diffLines: detects a modified line as del+add", () => {
  const ops = diffLines("hello\nworld", "hello\nthere");
  assert.deepEqual(diffStats(ops), { added: 1, removed: 1 });
  assert.ok(ops.some((o) => o.type === "del" && o.text === "world"));
  assert.ok(ops.some((o) => o.type === "add" && o.text === "there"));
});

test("diffLines: empty -> content is all additions", () => {
  const ops = diffLines("", "x\ny");
  assert.deepEqual(diffStats(ops), { added: 2, removed: 0 });
});

test("diffLines: trailing newline does not register as a change", () => {
  const ops = diffLines("a\nb\n", "a\nb");
  assert.deepEqual(diffStats(ops), { added: 0, removed: 0 });
});
