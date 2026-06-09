import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import YAML from "yaml";
import type { WorkspaceConfig, Workflow } from "./types.js";

export const CONFIG_NAMES = ["loom.yaml", "loom.yml", "loom.json"];

export interface Workspace {
  root: string;
  configPath: string;
  config: WorkspaceConfig;
}

export interface ResolvedDirs {
  inputs: string;
  prompts: string;
  context: string;
  loom: string;
}

/** Walk up from `start` looking for a workspace config file. */
export function findWorkspaceRoot(start: string = process.cwd()): string | null {
  let dir = resolve(start);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const name of CONFIG_NAMES) {
      if (existsSync(join(dir, name))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadWorkspace(start: string = process.cwd()): Workspace {
  const root = findWorkspaceRoot(start);
  if (!root) {
    throw new Error(
      "No Loom workspace found (looked for loom.yaml). Run `loom init` to create one.",
    );
  }
  const configPath = CONFIG_NAMES.map((n) => join(root, n)).find((p) => existsSync(p))!;
  const raw = readFileSync(configPath, "utf8");
  const config = configPath.endsWith(".json")
    ? (JSON.parse(raw) as WorkspaceConfig)
    : (YAML.parse(raw) as WorkspaceConfig);
  validateWorkspaceConfig(config);
  return { root, configPath, config };
}

export function saveConfig(ws: Workspace): void {
  const raw = ws.configPath.endsWith(".json")
    ? JSON.stringify(ws.config, null, 2)
    : YAML.stringify(ws.config);
  writeFileSync(ws.configPath, raw);
}

/** Validate then persist a full config object to the workspace's config file. */
export function writeConfig(ws: Workspace, config: WorkspaceConfig): void {
  validateWorkspaceConfig(config);
  const raw = ws.configPath.endsWith(".json")
    ? JSON.stringify(config, null, 2)
    : YAML.stringify(config);
  writeFileSync(ws.configPath, raw);
}

/** Validate raw config text (yaml/json) then write it verbatim, preserving format. */
export function writeConfigRaw(ws: Workspace, raw: string): WorkspaceConfig {
  const parsed = (ws.configPath.endsWith(".json") ? JSON.parse(raw) : YAML.parse(raw)) as WorkspaceConfig;
  validateWorkspaceConfig(parsed);
  writeFileSync(ws.configPath, raw);
  return parsed;
}

export function resolveDirs(ws: Workspace): ResolvedDirs {
  const { root, config } = ws;
  return {
    inputs: join(root, config.inputsDir ?? "inputs"),
    prompts: join(root, config.promptsDir ?? "prompts"),
    context: join(root, config.contextDir ?? "context"),
    loom: join(root, ".loom"),
  };
}

export function defaultModel(ws: Workspace): string {
  return ws.config.defaultModel ?? "claude-opus-4-8";
}

/**
 * Validate a workspace config (used on load and before any config write so the
 * UI/CLI can never persist a broken loom.yaml). Throws with a human message.
 */
export function validateWorkspaceConfig(config: WorkspaceConfig): void {
  if (!config || typeof config !== "object") throw new Error("Invalid loom config: not an object.");
  if (!config.name) throw new Error("Invalid loom config: missing `name`.");
  if (!Array.isArray(config.workflows)) {
    config.workflows = [];
  }
  const workflows: Workflow[] = config.workflows;
  const seen = new Set<string>();
  for (const wf of workflows) {
    if (!wf.id) throw new Error("Invalid loom config: a workflow is missing `id`.");
    if (seen.has(wf.id)) throw new Error(`Invalid loom config: duplicate workflow id "${wf.id}".`);
    seen.add(wf.id);
    const stepIds = new Set<string>();
    for (const step of wf.steps ?? []) {
      if (!step.id) throw new Error(`Workflow "${wf.id}": a step is missing \`id\`.`);
      if (stepIds.has(step.id)) {
        throw new Error(`Workflow "${wf.id}": duplicate step id "${step.id}".`);
      }
      stepIds.add(step.id);
      if (!step.output) throw new Error(`Step "${wf.id}/${step.id}": missing \`output\`.`);
      const stepType: string = step.type;
      if (stepType !== "inference" && stepType !== "agent") {
        throw new Error(`Step "${wf.id}/${step.id}": type must be "inference" or "agent".`);
      }
    }
  }
}

/** Recursively list files under `dir`, returned as paths relative to `dir`. */
export function listFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Expand a glob pattern (relative to the workspace root) to a sorted list of
 * absolute file paths. Supports `**` (any depth), `*` (one path segment), and
 * `?` (one character). A pattern with no wildcard is treated as a literal path.
 */
export function globFiles(root: string, pattern: string): string[] {
  const hasMagic = /[*?]/.test(pattern);
  if (!hasMagic) {
    const p = resolve(root, pattern);
    return existsSync(p) && statSync(p).isFile() ? [p] : [];
  }
  const regex = globToRegExp(pattern);
  const all = listFilesRecursive(root).map((p) => p.split(sep).join("/"));
  return all
    .filter((p) => regex.test(p))
    .map((p) => resolve(root, p))
    .sort();
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` -> any number of path segments; `**` -> anything
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}
