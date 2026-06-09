import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { ArtifactInputRef, Step } from "./types.js";
import { type Workspace, type ResolvedDirs, globFiles } from "./workspace.js";
import { Store } from "./store.js";
import { sha256 } from "./hash.js";

export interface ResolvedInputs {
  /** Provenance: every ref and the file hashes it expanded to. */
  refs: ArtifactInputRef[];
  /** All input bodies concatenated with headers (for {{inputs}}). */
  text: string;
  /** Per-input bodies keyed by basename (for {{input:NAME}}). */
  named: Record<string, string>;
}

/**
 * Resolve a step's `inputs` into concrete content + provenance. `runOutputs`
 * holds the fresh output of steps already executed in the current build so that
 * `step:` references see up-to-date content; otherwise we fall back to the
 * last-built artifact recorded in state.
 */
export function resolveInputs(
  ws: Workspace,
  dirs: ResolvedDirs,
  store: Store,
  workflowId: string,
  step: Step,
  runOutputs: Map<string, string>,
): ResolvedInputs {
  const refs: ArtifactInputRef[] = [];
  const named: Record<string, string> = {};
  const sections: string[] = [];

  for (const ref of step.inputs ?? []) {
    if (ref.startsWith("step:")) {
      const stepId = ref.slice("step:".length);
      const content = readStepOutput(store, workflowId, stepId, runOutputs);
      refs.push({ ref, files: [{ path: ref, hash: sha256(content) }] });
      named[stepId] = content;
      sections.push(`## (step) ${stepId}\n\n${content}`);
    } else if (ref.startsWith("context:")) {
      const name = ref.slice("context:".length);
      const { path, content } = readContext(dirs, name);
      refs.push({ ref, files: [{ path: relRoot(ws, path), hash: sha256(content) }] });
      named[name] = content;
      sections.push(`## (context) ${name}\n\n${content}`);
    } else {
      const matches = globFiles(ws.root, ref);
      const files = matches.map((p) => {
        const content = readFileSync(p, "utf8");
        named[basename(p)] = content;
        sections.push(`## ${relRoot(ws, p)}\n\n${content}`);
        return { path: relRoot(ws, p), hash: sha256(content) };
      });
      refs.push({ ref, files });
    }
  }

  return { refs, named, text: sections.join("\n\n---\n\n") };
}

function readStepOutput(
  store: Store,
  workflowId: string,
  stepId: string,
  runOutputs: Map<string, string>,
): string {
  if (runOutputs.has(stepId)) return runOutputs.get(stepId)!;
  const key = store.getStepArtifactKey(workflowId, stepId);
  if (key && store.hasArtifact(key)) return store.getArtifactContent(key);
  throw new Error(
    `Step "${stepId}" referenced by step:${stepId} has not been built yet. ` +
      `Make sure it runs earlier in the workflow.`,
  );
}

function readContext(dirs: ResolvedDirs, name: string): { path: string; content: string } {
  for (const c of [name, `${name}.md`, `${name}.txt`]) {
    const p = join(dirs.context, c);
    if (existsSync(p)) return { path: p, content: readFileSync(p, "utf8") };
  }
  throw new Error(`Context entry "${name}" not found in ${dirs.context}`);
}

function relRoot(ws: Workspace, p: string): string {
  return relative(ws.root, p).split("\\").join("/");
}
