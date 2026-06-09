import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  appendFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Artifact, LoomEvent, WorkspaceState } from "./types.js";

/**
 * The on-disk store under `.loom/`:
 *
 *   .loom/cache/<key>.json   artifact metadata   (gitignored — rebuildable)
 *   .loom/cache/<key>.out    artifact content    (gitignored — rebuildable)
 *   .loom/outputs/<wf>/<out> latest materialized output (tracked)
 *   .loom/state.json         step -> current artifact key (tracked)
 *   .loom/events.log         append-only JSONL event history (tracked)
 *   .loom/exports/           shareable HTML exports
 */
export class Store {
  readonly dir: string;
  readonly cacheDir: string;
  readonly outputsDir: string;
  readonly exportsDir: string;
  readonly statePath: string;
  readonly eventsPath: string;

  constructor(loomDir: string) {
    this.dir = loomDir;
    this.cacheDir = join(loomDir, "cache");
    this.outputsDir = join(loomDir, "outputs");
    this.exportsDir = join(loomDir, "exports");
    this.statePath = join(loomDir, "state.json");
    this.eventsPath = join(loomDir, "events.log");
  }

  init(): void {
    mkdirSync(this.cacheDir, { recursive: true });
    mkdirSync(this.outputsDir, { recursive: true });
    mkdirSync(this.exportsDir, { recursive: true });
    if (!existsSync(this.statePath)) this.writeState({ steps: {}, updatedAt: now() });
  }

  // --- artifacts ---------------------------------------------------------

  hasArtifact(key: string): boolean {
    return existsSync(join(this.cacheDir, `${key}.json`));
  }

  getArtifact(key: string): Artifact | null {
    const p = join(this.cacheDir, `${key}.json`);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as Artifact;
  }

  getArtifactContent(key: string): string {
    return readFileSync(join(this.cacheDir, `${key}.out`), "utf8");
  }

  putArtifact(artifact: Artifact, content: string): void {
    this.init();
    writeFileSync(join(this.cacheDir, `${artifact.key}.out`), content);
    writeFileSync(join(this.cacheDir, `${artifact.key}.json`), JSON.stringify(artifact, null, 2));
  }

  listArtifacts(): Artifact[] {
    if (!existsSync(this.cacheDir)) return [];
    return readdirSync(this.cacheDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.cacheDir, f), "utf8")) as Artifact)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Version history for one step (newest first) — the basis for diffs. */
  listStepArtifacts(workflowId: string, stepId: string): Artifact[] {
    return this.listArtifacts().filter(
      (a) => a.workflowId === workflowId && a.stepId === stepId,
    );
  }

  /** Write the human-browsable copy of an output under outputs/<wf>/<output>. */
  materialize(workflowId: string, output: string, content: string): string {
    const path = join(this.outputsDir, workflowId, output);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  }

  // --- state -------------------------------------------------------------

  readState(): WorkspaceState {
    if (!existsSync(this.statePath)) return { steps: {}, updatedAt: now() };
    return JSON.parse(readFileSync(this.statePath, "utf8")) as WorkspaceState;
  }

  writeState(state: WorkspaceState): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(state, null, 2));
  }

  setStepArtifact(workflowId: string, stepId: string, key: string): void {
    const state = this.readState();
    state.steps[`${workflowId}/${stepId}`] = key;
    state.updatedAt = now();
    this.writeState(state);
  }

  getStepArtifactKey(workflowId: string, stepId: string): string | undefined {
    return this.readState().steps[`${workflowId}/${stepId}`];
  }

  // --- event log ---------------------------------------------------------

  appendEvent(type: LoomEvent["type"], data: Record<string, unknown>, actor?: string): LoomEvent {
    const event: LoomEvent = { id: randomUUID(), ts: now(), type, actor, data };
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.eventsPath, JSON.stringify(event) + "\n");
    return event;
  }

  readEvents(limit = 200): LoomEvent[] {
    if (!existsSync(this.eventsPath)) return [];
    const lines = readFileSync(this.eventsPath, "utf8").trim().split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map((l) => JSON.parse(l) as LoomEvent);
  }
}

function now(): string {
  return new Date().toISOString();
}
