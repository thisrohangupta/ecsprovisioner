import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function writer(root: string, created: string[]) {
  return (rel: string, content: string) => {
    const p = join(root, rel);
    if (existsSync(p)) return;
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
    created.push(rel);
  };
}

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

/**
 * A richer, demo-ready workspace that tells an end-to-end product story:
 * raw research → analysis → PRD → launch blog → a shipped landing page (agent).
 * Pairs with mock mode so it runs with no API key.
 */
export function scaffoldDemo(root: string, name: string): string[] {
  const created: string[] = [];
  const write = writer(root, created);

  write(
    "loom.yaml",
    `name: ${name}
description: From raw research to a shipped landing page — an end-to-end LLM build.
defaultModel: claude-opus-4-8

inputsDir: inputs
promptsDir: prompts
contextDir: context

workflows:
  - id: launch
    description: Turn market research into an analysis, PRD, launch post, and live page.
    steps:
      - id: analysis
        type: inference
        prompt: analyze.md
        inputs:
          - inputs/*.md
          - context:audience
        output: analysis.md

      - id: prd
        type: inference
        prompt: prd.md
        inputs:
          - step:analysis
          - context:audience
        output: prd.md

      - id: blog
        type: inference
        prompt: blog.md
        inputs:
          - step:prd
          - context:brand
        vars:
          product: ${name}
        output: launch-post.md

      - id: landing
        type: agent
        instructions: |
          Build a single, self-contained landing page for the product described
          in the launch post below. Keep it clean and on-brand.
          {{inputs}}
        inputs:
          - step:blog
        agentDir: site
        allowedTools: [Read, Write, Edit, Glob]
        output: landing-report.md
`,
  );

  write(
    "inputs/market.md",
    `# Market research

- Teams run the same LLM "pipelines" by hand: paste docs, copy a prompt, save the output, repeat.
- Every re-run re-pays for tokens even when nothing changed — wasteful and slow.
- No shared source of truth: prompts live in chat history and personal notes.
- Buyers want reproducibility and an audit trail of how an output was produced.
`,
  );

  write(
    "inputs/interviews.md",
    `# Customer interviews

- "I just want to change one input and not rebuild everything." — Head of Content
- "Our prompts are tribal knowledge. Onboarding takes weeks." — Eng Manager
- "Finance asks what we spent on AI last month and we have no idea." — COO
- "I need to send the result to a client as a link, not a Google Doc." — PM
`,
  );

  write(
    "inputs/metrics.md",
    `# Signals

- 8 internal pipelines, run ~40x/week combined.
- ~60% of re-runs change a single input — the rest is recomputed needlessly.
- Average pipeline: 5 steps, ~25k tokens end to end.
`,
  );

  write(
    "context/audience.md",
    `# Audience

Technical product and content teams who treat LLM work like a build: versioned
inputs, reusable prompts, cached artifacts, and a clear cost story.
`,
  );

  write(
    "context/brand.md",
    `# Brand voice

Confident and concrete. Short sentences. Lead with the outcome. No hype words.
`,
  );

  write(
    "prompts/analyze.md",
    `You are a product strategist. From the research below, produce a crisp analysis:
the core problem, who has it, why now, and the top 3 opportunities. Markdown only.

{{inputs}}
`,
  );

  write(
    "prompts/prd.md",
    `Write a one-page PRD from the analysis below: problem, goals, non-goals, the
core user flow, and success metrics. Be concrete. Markdown only.

{{inputs}}
`,
  );

  write(
    "prompts/blog.md",
    `Write a punchy launch blog post for {{product}} based on the PRD below.
Open with the problem, show the "aha", end with a call to action. Follow the
brand voice. Markdown only — no preamble.

{{inputs}}
`,
  );

  return created;
}
