import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Workspace } from "./workspace.js";
import { Store } from "./store.js";
import { renderMarkdown, escapeHtml } from "./markdown.js";
import type { Artifact } from "./types.js";

/**
 * Produce a self-contained, shareable HTML page for a workflow: each step's
 * compiled output rendered as Markdown, with a provenance panel (inputs, model,
 * tokens, cost, build time) so the result is auditable when shared externally.
 */
export function exportWorkflowHtml(
  ws: Workspace,
  store: Store,
  workflowId: string,
): { path: string; html: string } {
  const wf = ws.config.workflows.find((w) => w.id === workflowId);
  if (!wf) throw new Error(`Workflow "${workflowId}" not found.`);

  const sections = wf.steps.map((step) => {
    const key = store.getStepArtifactKey(workflowId, step.id);
    if (!key || !store.hasArtifact(key)) {
      return `<section class="step"><h2>${escapeHtml(step.id)}</h2>
        <p class="muted">Not built yet.</p></section>`;
    }
    const artifact = store.getArtifact(key)!;
    const content = store.getArtifactContent(key);
    return `<section class="step">
      <h2>${escapeHtml(step.id)} <span class="badge">${escapeHtml(step.type)}</span></h2>
      <div class="output">${renderMarkdown(content)}</div>
      ${provenance(artifact)}
    </section>`;
  });

  const html = page(ws, wf.id, wf.description ?? "", sections.join("\n"));
  store.init();
  const path = join(store.exportsDir, `${workflowId}.html`);
  writeFileSync(path, html);
  store.appendEvent("export", { workflowId, path });
  return { path, html };
}

function provenance(a: Artifact): string {
  const inputs = a.inputs
    .flatMap((r) => r.files.map((f) => `<li><code>${escapeHtml(f.path)}</code> <span class="hash">${f.hash.slice(0, 10)}</span></li>`))
    .join("");
  const usage = a.usage
    ? `${a.usage.inputTokens ?? "?"} in / ${a.usage.outputTokens ?? "?"} out` +
      (a.usage.costUsd != null ? ` · ~$${a.usage.costUsd.toFixed(4)}` : "")
    : "n/a";
  return `<details class="prov">
    <summary>Provenance</summary>
    <dl>
      <dt>Model</dt><dd>${escapeHtml(a.model ?? "n/a")}</dd>
      <dt>Built</dt><dd>${escapeHtml(a.createdAt)} (${a.durationMs} ms)</dd>
      <dt>Tokens</dt><dd>${escapeHtml(usage)}</dd>
      <dt>Artifact</dt><dd><span class="hash">${a.key.slice(0, 16)}</span></dd>
      <dt>Inputs</dt><dd><ul>${inputs || "<li class='muted'>none</li>"}</ul></dd>
    </dl>
  </details>`;
}

function page(ws: Workspace, workflowId: string, description: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(ws.config.name)} — ${escapeHtml(workflowId)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
    max-width: 820px; margin: 0 auto; padding: 2.5rem 1.25rem; color: #1c2024; background: #fbfaf7; }
  @media (prefers-color-scheme: dark) { body { color: #e6e6e6; background: #16181c; } }
  header { border-bottom: 1px solid #d7d2c6; padding-bottom: 1rem; margin-bottom: 1.5rem; }
  h1 { margin: 0 0 .25rem; font-size: 1.6rem; }
  .sub { color: #7a756b; margin: 0; }
  .step { margin: 2rem 0; }
  .step h2 { font-size: 1.2rem; border-bottom: 1px solid #e4dfd3; padding-bottom: .3rem; }
  .badge { font-size: .7rem; background: #c2643c; color: #fff; padding: .1rem .45rem; border-radius: 999px; vertical-align: middle; }
  .output { margin: 1rem 0; }
  pre { background: #2b2b2b; color: #f2f2f2; padding: .9rem 1rem; border-radius: 8px; overflow:auto; }
  code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: .9em; }
  p code, li code { background: rgba(120,120,120,.18); padding: .05rem .3rem; border-radius: 4px; }
  blockquote { border-left: 3px solid #c2643c; margin: 1rem 0; padding: .2rem 1rem; color: #7a756b; }
  .prov { margin-top: 1rem; font-size: .85rem; color: #7a756b; }
  .prov summary { cursor: pointer; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .2rem .8rem; margin: .6rem 0; }
  dt { font-weight: 600; }
  .hash { font-family: ui-monospace, monospace; color: #c2643c; }
  .muted { color: #a09a8c; }
  footer { margin-top: 3rem; border-top: 1px solid #d7d2c6; padding-top: 1rem; color: #a09a8c; font-size: .8rem; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(ws.config.name)} · ${escapeHtml(workflowId)}</h1>
  <p class="sub">${escapeHtml(description)}</p>
</header>
${body}
<footer>Compiled with Loom · ${escapeHtml(new Date().toISOString())}</footer>
</body>
</html>`;
}
