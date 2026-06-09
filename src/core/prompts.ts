import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedDirs } from "./workspace.js";

/** A prompt template stored in the prompts directory. */
export interface PromptEntry {
  name: string;
  path: string;
  content: string;
}

export function listPrompts(dirs: ResolvedDirs): PromptEntry[] {
  if (!existsSync(dirs.prompts)) return [];
  return readdirSync(dirs.prompts)
    .filter((f) => !f.startsWith("."))
    .map((name) => ({
      name,
      path: join(dirs.prompts, name),
      content: readFileSync(join(dirs.prompts, name), "utf8"),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function readPrompt(dirs: ResolvedDirs, name: string): string {
  const candidates = [name, `${name}.md`, `${name}.txt`];
  for (const c of candidates) {
    const p = join(dirs.prompts, c);
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  throw new Error(`Prompt "${name}" not found in ${dirs.prompts}`);
}

export function writePrompt(dirs: ResolvedDirs, name: string, content: string): void {
  mkdirSync(dirs.prompts, { recursive: true });
  writeFileSync(join(dirs.prompts, name), content);
}

export interface RenderContext {
  vars?: Record<string, string>;
  /** Concatenated text of all resolved inputs, substituted for {{inputs}}. */
  inputsText?: string;
  /** Per-input text keyed by basename, substituted for {{input:NAME}}. */
  named?: Record<string, string>;
}

/**
 * Render a template. Supported placeholders:
 *   {{inputs}}        all resolved inputs, concatenated with file headers
 *   {{input:NAME}}    the content of a single input file (by basename)
 *   {{var}}           a value from `vars`
 *
 * If a template contains no {{inputs}} placeholder but inputs exist, the inputs
 * are appended under a "# Context" heading so a prompt never silently drops its
 * source material.
 */
export function renderTemplate(template: string, ctx: RenderContext): string {
  const vars = ctx.vars ?? {};
  const named = ctx.named ?? {};
  let out = template;
  let usedInputs = false;

  out = out.replace(/\{\{\s*inputs\s*\}\}/g, () => {
    usedInputs = true;
    return ctx.inputsText ?? "";
  });

  out = out.replace(/\{\{\s*input:([^}]+?)\s*\}\}/g, (_m, name: string) => {
    usedInputs = true;
    return named[name.trim()] ?? "";
  });

  out = out.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, key: string) => {
    return key in vars ? vars[key] : m;
  });

  if (!usedInputs && ctx.inputsText && ctx.inputsText.trim()) {
    out += `\n\n# Context\n\n${ctx.inputsText}`;
  }
  return out;
}
