/**
 * Loom data model.
 *
 * A Loom *workspace* is a directory containing managed input files, a library of
 * reusable prompts, general-purpose context, and a set of inference *workflows*.
 * A workflow is a DAG of *steps*; building it produces content-addressed
 * *artifacts* (the "compiled outputs"). Everything is plain files on disk so it
 * versions cleanly with git.
 */

export type StepType = "inference" | "agent";

/** Common fields shared by every step kind. */
interface StepBase {
  id: string;
  description?: string;
  /** Claude model id, e.g. "claude-opus-4-8". Falls back to the workspace default. */
  model?: string;
  /**
   * Input references consumed by this step. Each entry is one of:
   *  - a file path or glob, relative to the workspace root (e.g. "inputs/*.md")
   *  - "step:<id>"     — the output artifact of an earlier step in this workflow
   *  - "context:<name>"— a named entry from the context directory
   */
  inputs?: string[];
  /** Template variables substituted into the prompt/instructions ({{name}}). */
  vars?: Record<string, string>;
  /** Logical output name; materialized under .loom/outputs/<workflow>/<output>. */
  output: string;
}

/** A single chat-model inference call. */
export interface InferenceStep extends StepBase {
  type: "inference";
  /** Prompt template file in the prompts dir. */
  prompt?: string;
  /** ...or an inline prompt template (takes precedence over `prompt`). */
  promptText?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
}

/** A general-purpose coding agent run (Claude Agent SDK). */
export interface AgentStep extends StepBase {
  type: "agent";
  /** Inline instructions for the agent (takes precedence over `prompt`). */
  instructions?: string;
  /** ...or a prompt template file in the prompts dir. */
  prompt?: string;
  /** Tools the agent may use, e.g. ["Read", "Write", "Edit", "Glob", "Bash"]. */
  allowedTools?: string[];
  /** Agent SDK permission mode. Defaults to "bypassPermissions" for headless runs. */
  permissionMode?: string;
  /** Max agentic turns. */
  maxTurns?: number;
  /** Working directory (relative to workspace) the agent reads/writes in. */
  agentDir?: string;
}

export type Step = InferenceStep | AgentStep;

export interface Workflow {
  id: string;
  description?: string;
  steps: Step[];
}

export interface WorkspaceConfig {
  name: string;
  description?: string;
  /** Directory of managed input files (markdown/text). Default "inputs". */
  inputsDir?: string;
  /** Directory of reusable prompt templates. Default "prompts". */
  promptsDir?: string;
  /** Directory of general-purpose context entries. Default "context". */
  contextDir?: string;
  /** Default model for steps that don't specify one. Default "claude-opus-4-8". */
  defaultModel?: string;
  workflows: Workflow[];
}

/** One resolved input reference plus the hashes of the files it expanded to. */
export interface ArtifactInputRef {
  ref: string;
  files: { path: string; hash: string }[];
}

/** Token usage / cost recorded for provenance. */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/**
 * The record of one compiled output. Identified by `key`, a content hash over
 * the step config + resolved inputs + prompt + model, so an unchanged step is
 * never recomputed (the "make" staleness model).
 */
export interface Artifact {
  key: string;
  workflowId: string;
  stepId: string;
  stepType: StepType;
  model?: string;
  output: string;
  inputs: ArtifactInputRef[];
  promptHash?: string;
  createdAt: string;
  durationMs: number;
  usage?: Usage;
  status: "success" | "error";
  error?: string;
  contentBytes: number;
}

/**
 * Append-only event. The event log is the substrate the (future) real-time
 * collaboration layer builds on: today it records the build history and powers
 * live UI updates; tomorrow a CRDT/sync layer can replay and merge it.
 */
export interface LoomEvent {
  id: string;
  ts: string;
  type:
    | "build.start"
    | "build.done"
    | "step.start"
    | "step.cached"
    | "step.done"
    | "step.error"
    | "snapshot"
    | "file.changed"
    | "export";
  /** Who produced the event (defaults to the local user). */
  actor?: string;
  data: Record<string, unknown>;
}

/** Maps "workflowId/stepId" -> current artifact key. */
export interface WorkspaceState {
  steps: Record<string, string>;
  updatedAt: string;
}

/** A dependency edge in a workflow DAG, for visualization. */
export interface DagEdge {
  from: string;
  to: string;
}
