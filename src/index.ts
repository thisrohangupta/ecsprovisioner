/**
 * Loom — a local-first build system for LLM workflows.
 *
 * Public library surface. The CLI (`loom`) and the web server are thin layers
 * over these modules.
 */
export * from "./core/types.js";
export * from "./core/workspace.js";
export { Store } from "./core/store.js";
export { Engine } from "./core/engine.js";
export type { BuildOptions, BuildResult, StepResult, StepStatus, StepRunners } from "./core/engine.js";
export { topoSort, dagEdges, stepDeps } from "./core/graph.js";
export { resolveInputs } from "./core/resolve.js";
export { listPrompts, readPrompt, writePrompt, renderTemplate } from "./core/prompts.js";
export { scaffoldWorkspace } from "./core/scaffold.js";
export { snapshot, listSnapshots, isGitRepo } from "./core/snapshot.js";
export { exportWorkflowHtml, exportAllHtml } from "./core/exporter.js";
export type { ExportedPage } from "./core/exporter.js";
export { renderMarkdown } from "./core/markdown.js";
export { diffLines, diffStats } from "./core/diff.js";
export type { DiffOp, DiffOpType, DiffStats } from "./core/diff.js";
export { computeMetrics } from "./core/metrics.js";
export type { Metrics } from "./core/metrics.js";
export { scaffoldDemo } from "./core/scaffold.js";
export { mockRunners, mockInference, mockAgent } from "./llm/mock.js";
export { selectRunners, mockEnabled } from "./llm/runners.js";
