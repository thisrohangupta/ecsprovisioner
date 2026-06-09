import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Create a starter Loom workspace: config, the inputs/prompts/context dirs, and
 * a couple of illustrative files plus a runnable two-step workflow.
 */
export function scaffoldWorkspace(root: string, name: string): string[] {
  const created: string[] = [];
  const write = (rel: string, content: string) => {
    const p = join(root, rel);
    if (existsSync(p)) return;
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
    created.push(rel);
  };

  write(
    "loom.yaml",
    `name: ${name}
description: A Loom workspace — managed inputs + prompts compiled into artifacts.
defaultModel: claude-opus-4-8

inputsDir: inputs
promptsDir: prompts
contextDir: context

workflows:
  - id: brief
    description: Turn raw notes into a polished one-page brief.
    steps:
      - id: outline
        type: inference
        prompt: outline.md
        inputs:
          - inputs/*.md
          - context:style
        output: outline.md

      - id: draft
        type: inference
        prompt: draft.md
        inputs:
          - step:outline
          - context:style
        vars:
          audience: a busy executive
        output: brief.md

      # An optional coding-agent step. Uncomment to have an agent turn the brief
      # into a small static site under ./site (needs ANTHROPIC_API_KEY).
      # - id: site
      #   type: agent
      #   instructions: |
      #     Using the brief below, create a single-file static site at index.html
      #     in this directory. Keep it clean and self-contained.
      #     {{inputs}}
      #   inputs:
      #     - step:draft
      #   agentDir: site
      #   allowedTools: [Read, Write, Edit, Glob]
      #   output: site-report.md
`,
  );

  write(
    "inputs/notes.md",
    `# Raw notes

- We're building "Loom", a local-first build system for LLM workflows.
- Think "make for prompts": managed inputs + a prompt library + workflows that
  compile into cached, content-addressed artifacts.
- Coding-agent steps (not just chat) can produce build artifacts too.
- Outputs are shareable as self-contained HTML; git provides snapshots.
- Audience cares about: reproducibility, not re-paying for unchanged steps,
  and being able to share a result with a link.
`,
  );

  write(
    "context/style.md",
    `# House style

- Lead with the conclusion.
- Short sentences. Active voice. No filler.
- Prefer concrete nouns over abstractions.
`,
  );

  write(
    "prompts/outline.md",
    `Read the source material below and produce a tight, structured outline
(headings + terse bullet points) capturing every important idea. Follow the
house style. Output Markdown only.

{{inputs}}
`,
  );

  write(
    "prompts/draft.md",
    `Using the outline below, write a polished one-page brief for {{audience}}.
Follow the house style. Output Markdown only — no preamble.

{{inputs}}
`,
  );

  return created;
}
