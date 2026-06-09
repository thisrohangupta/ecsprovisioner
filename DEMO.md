# Loom — 3-minute demo script

A self-contained walkthrough that proves the product with **no API key** (mock
mode synthesizes outputs offline). Use this for a VC or design-partner demo.

## Setup (once)

```bash
npm install && npm run build
mkdir loom-demo && cd loom-demo
node ../dist/cli/index.js demo "Acme AI"   # scaffolds + builds a full pipeline
node ../dist/cli/index.js serve --mock     # http://localhost:4319
```

## The story (what to click, what to say)

**1. The problem (Workflows tab).**
You're looking at a real pipeline: *research → analysis → PRD → launch blog → a
landing page built by a coding agent.* Today teams run this by hand — paste docs,
copy a prompt, save the output, repeat — and re-pay every time.

> Point at the **DAG**. Each node is a step; green = fresh.

**2. It's a build system (the "aha").**
Click **Rebuild**. Every step streams… then settles to **cached** instantly.
Now open the **Inputs** tab, edit `market.md`, and rebuild — only the steps that
*depend* on what changed recompute. Diff a step (click a node → **Diff**) to see
exactly what changed between versions.

> "This is `make` for LLM work. Unchanged steps are never recomputed."

**3. The money (Metrics tab).**
The headline card is **Saved by caching** — real model spend avoided because we
didn't recompute unchanged work, next to what you actually spent and the cache
hit rate. This is the ROI line.

**4. Coding agents, not just chat (Workflows → `landing` step).**
The last step is a **coding agent** that actually wrote `site/index.html` +
`styles.css`. Its report is the artifact; the files are real build outputs.

**5. Real-time collaboration (Inputs tab, two windows).**
Open the same input in a second browser window. Type in one — it appears live in
the other, with **presence avatars** showing who's in the file.

**6. Author in-product (Workflows → "+ New workflow" / "+ Step").**
Add a step with a form (or edit `loom.yaml` directly, validated on save), then
build it — the DAG grows. Prompts, inputs, and context are all created/edited
here too.

**7. Ship it (Share tab).**
Click **Export everything** → you get a self-contained HTML bundle with an index
and full provenance (inputs, model, tokens, cost, time). Copy the link, or
download and send it to anyone.

**8. Versioned (Snapshots tab).**
Take a git snapshot — the whole workspace + results — and browse history.

## The one-liner

> Loom is GNU Autotools × Notion for LLM work: versioned inputs and a prompt
> library compiled by workflows into cached, content-addressed artifacts —
> coding agents included — with live collaboration, a real cost story, and
> shareable outputs.
