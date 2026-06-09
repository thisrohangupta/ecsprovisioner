import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/core/markdown.js";

test("renders headings", () => {
  assert.equal(renderMarkdown("# Title"), "<h1>Title</h1>");
});

test("renders bold and inline code", () => {
  assert.match(renderMarkdown("**bold**"), /<strong>bold<\/strong>/);
  assert.match(renderMarkdown("use `code` here"), /<code>code<\/code>/);
});

test("renders unordered lists", () => {
  const html = renderMarkdown("- one\n- two");
  assert.match(html, /<ul>/);
  assert.match(html, /<li>one<\/li>/);
});

test("renders fenced code blocks and escapes HTML inside", () => {
  const html = renderMarkdown("```\n<script>\n```");
  assert.match(html, /<pre><code>/);
  assert.match(html, /&lt;script&gt;/);
});

test("escapes HTML in inline text (no raw injection)", () => {
  const html = renderMarkdown("a < b & c > d");
  assert.doesNotMatch(html, /<b /);
  assert.match(html, /&lt;/);
  assert.match(html, /&amp;/);
});

test("only allows safe link protocols", () => {
  const html = renderMarkdown("[x](javascript:alert(1))");
  assert.doesNotMatch(html, /javascript:/);
});
