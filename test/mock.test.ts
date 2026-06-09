process.env.LOOM_MOCK_DELAY = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockInference, mockAgent } from "../src/llm/mock.js";

test("mockInference is deterministic for the same prompt", async () => {
  const a = await mockInference({ model: "claude-opus-4-8", prompt: "# Topic\n\n- one\n- two" });
  const b = await mockInference({ model: "claude-opus-4-8", prompt: "# Topic\n\n- one\n- two" });
  assert.equal(a.content, b.content);
});

test("mockInference output changes when the prompt changes (so diffs/caching work)", async () => {
  const a = await mockInference({ model: "claude-opus-4-8", prompt: "# A\n\n- alpha" });
  const b = await mockInference({ model: "claude-opus-4-8", prompt: "# B\n\n- beta" });
  assert.notEqual(a.content, b.content);
});

test("mockInference reports usage and streams deltas equal to content", async () => {
  let streamed = "";
  const r = await mockInference({
    model: "claude-opus-4-8",
    prompt: "# X\n\n- point",
    onDelta: (t) => (streamed += t),
  });
  assert.ok((r.usage?.outputTokens ?? 0) > 0);
  assert.ok((r.usage?.costUsd ?? 0) > 0);
  assert.equal(streamed, r.content);
});

test("mockAgent writes files into cwd and reports success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-mockagent-"));
  try {
    const r = await mockAgent({ model: "claude-opus-4-8", cwd: dir, prompt: "# Cool Product\n\nbuild me a page" });
    assert.equal(r.subtype, "success");
    assert.ok(existsSync(join(dir, "index.html")));
    assert.ok(existsSync(join(dir, "styles.css")));
    assert.match(r.content, /index\.html/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
