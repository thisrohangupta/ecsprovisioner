import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Artifact, LoomEvent, Step, Workflow } from "./types.js";
import { type Workspace, type ResolvedDirs, defaultModel } from "./workspace.js";
import { Store } from "./store.js";
import { hashJson, sha256 } from "./hash.js";
import { resolveInputs } from "./resolve.js";
import { renderTemplate } from "./prompts.js";
import { readPrompt } from "./prompts.js";
import { topoSort } from "./graph.js";
import { runInference } from "../llm/inference.js";
import { runAgent } from "../llm/agent.js";

const INFERENCE_SYSTEM =
  "You are a single build step in an automated LLM workflow (Loom). " +
  "Produce only the requested artifact as your response — no preamble, no meta-commentary, " +
  "no surrounding code fences unless the artifact itself is code. Your output is saved verbatim.";

const AGENT_SYSTEM =
  "You are an automated coding agent running as a build step in a Loom workflow. " +
  "Work within the provided working directory. Make the requested changes directly, " +
  "then end with a concise report of what you created or modified.";

export interface BuildOptions {
  force?: boolean;
  actor?: string;
  onEvent?: (event: LoomEvent) => void;
  onDelta?: (stepId: string, text: string) => void;
}

export interface StepResult {
  stepId: string;
  status: "cached" | "built" | "error";
  key: string;
  artifact?: Artifact;
  error?: string;
}

export interface BuildResult {
  workflowId: string;
  steps: StepResult[];
}

export interface StepStatus {
  stepId: string;
  type: Step["type"];
  fresh: boolean;
  hasArtifact: boolean;
  key?: string;
  note?: string;
}

export class Engine {
  constructor(
    private ws: Workspace,
    private dirs: ResolvedDirs,
    private store: Store,
  ) {}

  private emit(opts: BuildOptions, type: LoomEvent["type"], data: Record<string, unknown>): void {
    const event = this.store.appendEvent(type, data, opts.actor);
    opts.onEvent?.(event);
  }

  private getWorkflow(id: string): Workflow {
    const wf = this.ws.config.workflows.find((w) => w.id === id);
    if (!wf) throw new Error(`Workflow "${id}" not found.`);
    return wf;
  }

  /** Compose the rendered prompt and cache key for a step. */
  private prepare(workflowId: string, step: Step, runOutputs: Map<string, string>) {
    const resolved = resolveInputs(this.ws, this.dirs, this.store, workflowId, step, runOutputs);
    const template =
      step.type === "inference"
        ? step.promptText ?? (step.prompt ? readPrompt(this.dirs, step.prompt) : "")
        : (step as Extract<Step, { type: "agent" }>).instructions ??
          (step.prompt ? readPrompt(this.dirs, step.prompt) : "");
    if (!template) {
      throw new Error(
        `Step "${workflowId}/${step.id}": needs a prompt/instructions ` +
          `(set \`prompt\`, \`promptText\`, or \`instructions\`).`,
      );
    }
    const rendered = renderTemplate(template, {
      vars: step.vars,
      inputsText: resolved.text,
      named: resolved.named,
    });
    const model = step.model ?? defaultModel(this.ws);
    const agentDir = step.type === "agent" ? (step as any).agentDir ?? "." : undefined;
    const key = hashJson({
      type: step.type,
      model,
      rendered,
      agentDir,
      allowedTools: step.type === "agent" ? (step as any).allowedTools : undefined,
      effort: step.type === "inference" ? (step as any).effort : undefined,
    });
    return { resolved, template, rendered, model, key };
  }

  async buildWorkflow(workflowId: string, opts: BuildOptions = {}): Promise<BuildResult> {
    this.store.init();
    const wf = this.getWorkflow(workflowId);
    const ordered = topoSort(wf);
    const runOutputs = new Map<string, string>();
    const results: StepResult[] = [];

    this.emit(opts, "build.start", { workflowId, steps: ordered.map((s) => s.id), force: !!opts.force });

    for (const step of ordered) {
      const { resolved, template, rendered, model, key } = this.prepare(workflowId, step, runOutputs);

      if (!opts.force && this.store.hasArtifact(key)) {
        const content = this.store.getArtifactContent(key);
        runOutputs.set(step.id, content);
        this.store.setStepArtifact(workflowId, step.id, key);
        this.store.materialize(workflowId, step.output, content);
        const artifact = this.store.getArtifact(key) ?? undefined;
        results.push({ stepId: step.id, status: "cached", key, artifact });
        this.emit(opts, "step.cached", { workflowId, stepId: step.id, key });
        continue;
      }

      this.emit(opts, "step.start", { workflowId, stepId: step.id, type: step.type, model });
      const startedAt = Date.now();
      try {
        let content = "";
        let usage;
        if (step.type === "inference") {
          const res = await runInference({
            model,
            system: INFERENCE_SYSTEM,
            prompt: rendered,
            effort: step.effort,
            maxTokens: step.maxTokens,
            onDelta: (t) => opts.onDelta?.(step.id, t),
          });
          content = res.content;
          usage = res.usage;
        } else {
          const cwd = resolve(this.ws.root, step.agentDir ?? ".");
          mkdirSync(cwd, { recursive: true });
          const res = await runAgent({
            model,
            cwd,
            systemPrompt: AGENT_SYSTEM,
            prompt: rendered,
            allowedTools: step.allowedTools,
            permissionMode: step.permissionMode,
            maxTurns: step.maxTurns,
            onText: (t) => opts.onDelta?.(step.id, t),
          });
          content = res.content;
          usage = res.usage;
        }

        const artifact: Artifact = {
          key,
          workflowId,
          stepId: step.id,
          stepType: step.type,
          model,
          output: step.output,
          inputs: resolved.refs,
          promptHash: sha256(template),
          createdAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          usage,
          status: "success",
          contentBytes: Buffer.byteLength(content, "utf8"),
        };
        this.store.putArtifact(artifact, content);
        this.store.materialize(workflowId, step.output, content);
        this.store.setStepArtifact(workflowId, step.id, key);
        runOutputs.set(step.id, content);
        results.push({ stepId: step.id, status: "built", key, artifact });
        this.emit(opts, "step.done", {
          workflowId,
          stepId: step.id,
          key,
          bytes: artifact.contentBytes,
          durationMs: artifact.durationMs,
          usage,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ stepId: step.id, status: "error", key, error: message });
        this.emit(opts, "step.error", { workflowId, stepId: step.id, error: message });
        this.emit(opts, "build.done", { workflowId, ok: false, failedAt: step.id });
        return { workflowId, steps: results };
      }
    }

    this.emit(opts, "build.done", { workflowId, ok: true });
    return { workflowId, steps: results };
  }

  async buildAll(opts: BuildOptions = {}): Promise<BuildResult[]> {
    const out: BuildResult[] = [];
    for (const wf of this.ws.config.workflows) {
      out.push(await this.buildWorkflow(wf.id, opts));
    }
    return out;
  }

  /** Per-step freshness for a workflow, without running anything. */
  status(workflowId: string): StepStatus[] {
    const wf = this.getWorkflow(workflowId);
    const ordered = topoSort(wf);
    const runOutputs = new Map<string, string>();
    const freshById = new Map<string, boolean>();
    const out: StepStatus[] = [];

    for (const step of ordered) {
      try {
        const { key } = this.prepare(workflowId, step, runOutputs);
        const hasArtifact = this.store.hasArtifact(key);
        const depsFresh = (step.inputs ?? [])
          .filter((r) => r.startsWith("step:"))
          .every((r) => freshById.get(r.slice("step:".length)) ?? false);
        const fresh = hasArtifact && depsFresh;
        freshById.set(step.id, fresh);
        if (hasArtifact) runOutputs.set(step.id, this.store.getArtifactContent(key));
        out.push({ stepId: step.id, type: step.type, fresh, hasArtifact, key });
      } catch (err) {
        freshById.set(step.id, false);
        out.push({
          stepId: step.id,
          type: step.type,
          fresh: false,
          hasArtifact: false,
          note: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }
}
