import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LOOM_HOME = mkdtempSync(join(tmpdir(), "loom-home-"));
const {
  roleAtLeast, isRole, createToken, listTokens, publicTokens, revokeToken, resolveRole,
} = await import("../src/core/access.js");

test("role ranking is owner > editor > viewer", () => {
  assert.equal(roleAtLeast("owner", "editor"), true);
  assert.equal(roleAtLeast("editor", "editor"), true);
  assert.equal(roleAtLeast("viewer", "editor"), false);
  assert.equal(roleAtLeast("owner", "viewer"), true);
  assert.equal(roleAtLeast("viewer", "viewer"), true);
});

test("isRole guards bad input", () => {
  assert.equal(isRole("owner"), true);
  assert.equal(isRole("admin"), false);
  assert.equal(isRole(undefined), false);
});

test("create / resolve / revoke a token", () => {
  const ws = "wsA-123";
  const t = createToken(ws, "editor", "Alice");
  assert.equal(t.role, "editor");
  assert.ok(t.token.length > 16);
  assert.equal(resolveRole(ws, t.token), "editor");
  assert.equal(resolveRole(ws, "nope"), null);
  assert.equal(resolveRole("otherWs", t.token), null, "a token is scoped to its workspace");
  assert.equal(revokeToken(ws, t.id), true);
  assert.equal(resolveRole(ws, t.token), null, "revoked token no longer resolves");
  assert.equal(revokeToken(ws, t.id), false, "revoking again is a no-op");
});

test("publicTokens never leaks the secret", () => {
  const ws = "wsB-456";
  createToken(ws, "viewer", "Bob");
  const pub = publicTokens(ws);
  assert.equal(pub.length, listTokens(ws).length);
  for (const p of pub) {
    assert.ok(p.id && p.role && "createdAt" in p);
    assert.equal((p as Record<string, unknown>).token, undefined, "no secret in the public view");
  }
});
