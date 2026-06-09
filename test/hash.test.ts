import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256, shortHash, hashJson, stableStringify } from "../src/core/hash.js";

test("sha256 is deterministic and hex", () => {
  assert.equal(sha256("loom"), sha256("loom"));
  assert.match(sha256("loom"), /^[0-9a-f]{64}$/);
});

test("shortHash is a 12-char prefix of sha256", () => {
  assert.equal(shortHash("x").length, 12);
  assert.ok(sha256("x").startsWith(shortHash("x")));
});

test("hashJson is independent of object key order", () => {
  assert.equal(hashJson({ a: 1, b: 2 }), hashJson({ b: 2, a: 1 }));
});

test("hashJson differs when values differ", () => {
  assert.notEqual(hashJson({ a: 1 }), hashJson({ a: 2 }));
});

test("stableStringify sorts nested keys", () => {
  assert.equal(stableStringify({ b: { d: 1, c: 2 }, a: 3 }), '{"a":3,"b":{"c":2,"d":1}}');
});
