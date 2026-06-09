import type { DagEdge, Step, Workflow } from "./types.js";

/** Ids of sibling steps this step depends on (via `step:` input refs). */
export function stepDeps(step: Step): string[] {
  return (step.inputs ?? [])
    .filter((r) => r.startsWith("step:"))
    .map((r) => r.slice("step:".length));
}

/** Dependency edges (dep -> step) for visualizing a workflow DAG. */
export function dagEdges(workflow: Workflow): DagEdge[] {
  const ids = new Set(workflow.steps.map((s) => s.id));
  const edges: DagEdge[] = [];
  for (const step of workflow.steps) {
    for (const dep of stepDeps(step)) {
      if (ids.has(dep)) edges.push({ from: dep, to: step.id });
    }
  }
  return edges;
}

/**
 * Topologically order the steps of a workflow so every `step:` dependency runs
 * before its dependents. Throws on cycles or references to unknown steps.
 */
export function topoSort(workflow: Workflow): Step[] {
  const byId = new Map(workflow.steps.map((s) => [s.id, s]));
  const visited = new Map<string, "visiting" | "done">();
  const ordered: Step[] = [];

  const visit = (step: Step, trail: string[]) => {
    const state = visited.get(step.id);
    if (state === "done") return;
    if (state === "visiting") {
      throw new Error(`Cycle detected in workflow "${workflow.id}": ${[...trail, step.id].join(" -> ")}`);
    }
    visited.set(step.id, "visiting");
    for (const depId of stepDeps(step)) {
      const dep = byId.get(depId);
      if (!dep) {
        throw new Error(`Step "${step.id}" depends on unknown step "${depId}" in workflow "${workflow.id}".`);
      }
      visit(dep, [...trail, step.id]);
    }
    visited.set(step.id, "done");
    ordered.push(step);
  };

  for (const step of workflow.steps) visit(step, []);
  return ordered;
}
