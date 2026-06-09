import { test } from "node:test";
import assert from "node:assert/strict";
import { CRDT, type Op } from "../src/core/crdt.js";

function typeString(doc: CRDT, s: string): Op[] {
  const ops: Op[] = [];
  for (let i = 0; i < s.length; i++) ops.push(doc.localInsert(i, s[i]));
  return ops;
}

test("sequential typing builds the string", () => {
  const a = new CRDT(1);
  typeString(a, "hello");
  assert.equal(a.value(), "hello");
});

test("insert in the middle", () => {
  const a = new CRDT(1);
  typeString(a, "ac");
  a.localInsert(1, "b");
  assert.equal(a.value(), "abc");
});

test("delete removes the character but converges", () => {
  const a = new CRDT(1);
  typeString(a, "abc");
  a.localDelete(1); // remove "b"
  assert.equal(a.value(), "ac");
});

test("concurrent inserts at the same position converge on both replicas", () => {
  const a = new CRDT(1);
  const b = new CRDT(2);
  // both start from the same base "X"
  const base = a.localInsert(0, "X");
  b.apply(base);
  // concurrently, each inserts a different char after X
  const opA = a.localInsert(1, "A");
  const opB = b.localInsert(1, "B");
  // exchange
  a.apply(opB);
  b.apply(opA);
  assert.equal(a.value(), b.value(), "replicas converge");
  assert.ok(a.value() === "XAB" || a.value() === "XBA");
});

test("delete applied before its insert still converges (out-of-order)", () => {
  const a = new CRDT(1);
  const ins = a.localInsert(0, "Z");
  const del: Op = { t: "del", id: (ins as { id: { c: number; s: number } }).id };
  const b = new CRDT(2);
  b.apply(del); // delete first
  b.apply(ins); // then the insert
  assert.equal(b.value(), "");
});

test("snapshot round-trips through a fresh replica", () => {
  const a = new CRDT(1);
  typeString(a, "graph");
  a.localDelete(0); // drop "g" -> "raph"
  const b = new CRDT(2);
  b.loadSnapshot(a.snapshot());
  assert.equal(b.value(), a.value());
});

// ---- cursor anchors (the basis for CRDT-aware remote cursors) ----

test("anchor round-trips at every caret position", () => {
  const a = new CRDT(1);
  typeString(a, "weave");
  for (let i = 0; i <= 5; i++) {
    assert.equal(a.indexOfAnchor(a.anchorAt(i)), i, `caret at ${i}`);
  }
});

test("anchor survives a concurrent insert before the caret", () => {
  const a = new CRDT(1);
  const b = new CRDT(2);
  const seed = typeString(a, "abc");
  b.applyMany(seed);
  // A's caret sits after "b" (index 2)
  const anchor = a.anchorAt(2);
  // B concurrently prepends "ZZ"
  a.apply(b.localInsert(0, "Z"));
  a.apply(b.localInsert(1, "Z"));
  assert.equal(a.value(), "ZZabc");
  // the anchor still names the "b" character — caret index shifted with it
  assert.equal(a.indexOfAnchor(anchor), 4);
});

test("anchor is unmoved by a concurrent insert after the caret", () => {
  const a = new CRDT(1);
  const b = new CRDT(2);
  const seed = typeString(a, "abc");
  b.applyMany(seed);
  const anchor = a.anchorAt(1); // after "a"
  a.apply(b.localInsert(3, "!")); // edit beyond the caret
  assert.equal(a.value(), "abc!");
  assert.equal(a.indexOfAnchor(anchor), 1);
});

test("anchor on a deleted character collapses to where it was", () => {
  const a = new CRDT(1);
  typeString(a, "abcd");
  const anchor = a.anchorAt(3); // after "c"
  a.localDelete(2); // tombstone "c"
  assert.equal(a.value(), "abd");
  assert.equal(a.indexOfAnchor(anchor), 2); // between "b" and "d"
});

test("null anchor means document start; unknown anchor is unresolvable", () => {
  const a = new CRDT(1);
  typeString(a, "xy");
  assert.equal(a.anchorAt(0), null);
  assert.equal(a.indexOfAnchor(null), 0);
  assert.equal(a.indexOfAnchor({ c: 99, s: 7 }), -1); // op never received
});

test("anchors resolve identically across replicas", () => {
  const a = new CRDT(1);
  const b = new CRDT(2);
  const seed = typeString(a, "shared");
  b.applyMany(seed);
  const anchor = b.anchorAt(4); // B's caret after "r"
  // both sides edit concurrently, then exchange
  const opA = a.localInsert(0, "<");
  const opB = b.localInsert(6, ">");
  a.apply(opB);
  b.apply(opA);
  assert.equal(a.value(), b.value());
  assert.equal(a.indexOfAnchor(anchor), b.indexOfAnchor(anchor));
  assert.equal(a.value()[a.indexOfAnchor(anchor) - 1], "r"); // still after "r"
});

// Randomized convergence: two replicas make independent (concurrent) edits;
// applying the union of ops in any order yields the same document everywhere.
test("randomized concurrent edits converge regardless of op order", () => {
  const ALPHA = "abcdefghij";
  const rand = (n: number) => Math.floor(Math.random() * n);
  for (let trial = 0; trial < 40; trial++) {
    const a = new CRDT(1);
    const b = new CRDT(2);
    // shared starting point
    const seed: Op[] = typeString(a, "start");
    b.applyMany(seed);

    const opsA: Op[] = [];
    const opsB: Op[] = [];
    for (let i = 0; i < 25; i++) {
      for (const [doc, ops] of [[a, opsA], [b, opsB]] as const) {
        const len = doc.value().length;
        if (len > 0 && rand(3) === 0) {
          const op = doc.localDelete(rand(len));
          if (op) ops.push(op);
        } else {
          ops.push(doc.localInsert(rand(len + 1), ALPHA[rand(ALPHA.length)]));
        }
      }
    }

    const union = [...opsA, ...opsB];
    const shuffle = (arr: Op[]) => {
      const c = arr.slice();
      for (let i = c.length - 1; i > 0; i--) {
        const j = rand(i + 1);
        [c[i], c[j]] = [c[j], c[i]];
      }
      return c;
    };

    // a fresh replica applying a random permutation of all ops
    const r1 = new CRDT(3);
    r1.applyMany(seed);
    r1.applyMany(shuffle(union));
    const r2 = new CRDT(4);
    r2.applyMany(seed);
    r2.applyMany(shuffle(union));

    // and the original replicas exchanging their peer's ops
    a.applyMany(opsB);
    b.applyMany(opsA);

    assert.equal(r1.value(), r2.value(), `trial ${trial}: permutations diverged`);
    assert.equal(a.value(), b.value(), `trial ${trial}: replicas diverged`);
    assert.equal(a.value(), r1.value(), `trial ${trial}: replica vs fresh diverged`);
  }
});
