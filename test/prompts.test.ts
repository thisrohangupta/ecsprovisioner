import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTemplate } from "../src/core/prompts.js";

test("substitutes {{inputs}}", () => {
  const out = renderTemplate("Read this:\n{{inputs}}", { inputsText: "SOURCE" });
  assert.equal(out, "Read this:\nSOURCE");
});

test("substitutes {{input:NAME}} by name", () => {
  const out = renderTemplate("{{input:notes}}", { named: { notes: "hello" } });
  assert.equal(out, "hello");
});

test("substitutes {{var}} from vars", () => {
  const out = renderTemplate("Audience: {{audience}}", { vars: { audience: "execs" } });
  assert.equal(out, "Audience: execs");
});

test("leaves unknown {{var}} untouched", () => {
  const out = renderTemplate("Hi {{missing}}", { vars: {} });
  assert.equal(out, "Hi {{missing}}");
});

test("appends inputs under a Context heading when no {{inputs}} placeholder", () => {
  const out = renderTemplate("Just instructions.", { inputsText: "SRC" });
  assert.match(out, /# Context/);
  assert.match(out, /SRC$/);
});

test("does not append a Context block when there are no inputs", () => {
  const out = renderTemplate("Instructions only.", { inputsText: "" });
  assert.equal(out, "Instructions only.");
});
