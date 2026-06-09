# Loom

[![CI](https://github.com/thisrohangupta/ecsprovisioner/actions/workflows/ci.yml/badge.svg)](https://github.com/thisrohangupta/ecsprovisioner/actions/workflows/ci.yml)

**A local-first build system for LLM workflows — `make` for prompts, agents, and context.**

Many projects have this shape: *there's a pile of source material you want to
process/compute over in an iterated way, and some of the build artifacts are
important and worth saving.* Loom is "GNU Autotools × Notion" for exactly that —
a workspace of managed inputs + a prompt library + inference **workflows** that
compile into cached, content-addressed **artifacts**, with a local web UI,
git-backed snapshots, and one-click shareable HTML.

```
inputs/ + context/ + prompts/  ──▶  workflow (DAG of steps)  ──▶  artifacts
   (markdown, notes)              (inference + coding agents)     (cached, shareable)
```

## Why

- **Files & context, managed.** Markdown/text inputs plus a general-purpose
  context store, editable from the CLI or the web UI.
- **A prompt library + workflows.** Reusable prompt templates, and workflows
  that are DAGs of steps wiring inputs/prompts/context together.
- **Coding agents, not just chat.** A step can be a **Claude coding agent** that
  reads/edits files and runs tools — its output is a build artifact too.
- **Compiled outputs, like `make`.** Each step is content-hashed over its inputs
  + prompt + model; unchanged steps are **never recomputed**. Every artifact
  carries provenance (inputs, model, tokens, cost, time).
- **Shareable results.** Export any workflow — or the whole workspace as one
  linked index — to self-contained HTML you can open offline, email, or host.
- **Real-time & versioned.** Live multi-user editing with presence (open the
  same input in two windows and watch edits + avatars sync), plus git snapshots
  for history. Built on an append-only event log so conflict-free (CRDT)
  co-editing can be layered on next.

## Try it in 10 seconds (no API key)

```bash
npm install && npm run build
mkdir demo && cd demo
node ../dist/cli/index.js demo          # scaffolds + builds a full pipeline offline
node ../dist/cli/index.js serve --mock  # open http://localhost:4319
```

`demo` builds a believable product pipeline — **research → analysis → PRD → launch
blog → a coding-agent that ships a landing page** — using a deterministic **mock
provider**, so the whole product (DAG, caching, diffs, cost dashboard, sharing)
is demoable with zero setup. Rebuild and watch every step go *cached*; the
**Metrics** tab shows the model spend you just avoided.

## Install

```bash
npm install
npm run build        # compile TS -> dist/ and copy the web assets
npm link             # optional: put `loom` on your PATH
```

During development you can skip the build and run via `tsx`:

```bash
npm run loom -- <command>      # e.g. npm run loom -- status brief
```

Set your key for any step that calls a model:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

## Quickstart

```bash
mkdir my-project && cd my-project
loom init                  # scaffolds loom.yaml + inputs/ prompts/ context/
loom build brief           # runs the 2-step "brief" workflow
loom status brief          # see which steps are fresh vs stale
loom build brief           # ← re-run: cached steps are skipped instantly
loom export brief          # writes .loom/exports/brief.html (shareable)
loom serve                 # open the web UI at http://localhost:4319
```

Edit `inputs/notes.md`, run `loom build brief` again — only the steps whose
inputs actually changed are recomputed.

## The workspace

A workspace is just a directory with a `loom.yaml` and three content folders.
Everything is plain files, so it versions cleanly with git.

```yaml
name: my-project
defaultModel: claude-opus-4-8

workflows:
  - id: brief
    steps:
      - id: outline
        type: inference          # a single chat-model call
        prompt: outline.md        # a template from prompts/
        inputs:
          - inputs/*.md           # file globs, relative to the workspace
          - context:style         # a named entry from context/
        output: outline.md

      - id: draft
        type: inference
        prompt: draft.md
        inputs:
          - step:outline          # depends on a prior step's output
        vars: { audience: a busy executive }
        output: brief.md

      - id: site
        type: agent               # a Claude *coding agent*
        instructions: |
          Build a single-file static site from the brief below. {{inputs}}
        inputs:
          - step:draft
        agentDir: site            # the agent reads/writes here
        allowedTools: [Read, Write, Edit, Glob]
        output: site-report.md
```

**Input references** can be:
- a file path or glob (`inputs/*.md`),
- `step:<id>` — another step's compiled output,
- `context:<name>` — a named entry from the context directory.

**Prompt templates** support `{{inputs}}` (all resolved inputs), `{{input:NAME}}`
(one input by basename/step id), and `{{var}}` (from a step's `vars`). If a
template omits `{{inputs}}`, the inputs are appended under a `# Context` heading
so source material is never silently dropped.

## How caching works (the "make" part)

Each step's cache key is a hash over its rendered prompt + resolved input
hashes + model + step config. On build:

- key already present in `.loom/cache/` → **reuse** the artifact (instant), and
- otherwise → run the step, store the artifact + provenance, materialize the
  output under `.loom/outputs/<workflow>/<output>`, and update state.

`loom status` shows each step as **fresh** (cached & up to date), **stale**
(built, but an input changed), or **unbuilt**.

## CLI

| Command | What it does |
| --- | --- |
| `loom init [name]` | Scaffold a new workspace |
| `loom demo [name]` | Scaffold + build a rich demo workspace offline (mock) |
| `loom build [workflow]` | Build a workflow (or all). `--force`, `--all`, `--mock` |
| `loom status [workflow]` | Fresh / stale / unbuilt per step |
| `loom stats` | Tokens, cost, and **$ saved by caching** |
| `loom ls` | List workflows and their step DAG |
| `loom prompts` | List the prompt library |
| `loom snapshot -m "msg"` | Commit a git snapshot · `loom snapshot list` |
| `loom export [workflow]` | Write shareable HTML (no arg = every workflow + an index) |
| `loom diff <workflow> <step>` | Diff a step's current output vs its previous version (`--from`, `--to`) |
| `loom serve [--port 4319]` | Launch the local web UI with live updates |

## The web UI

`loom serve` starts a local server (no external services) with:

- **Workflows** — an interactive **DAG view**: each step is a node laid out by
  dependency rank, color-coded by freshness (fresh / stale / unbuilt / error)
  and animated live as a build runs. Click a node to inspect it:
  - **Output** — the compiled artifact, rendered.
  - **Diff** — pick any two versions of that step's output and see a
    line-level diff (with collapsed unchanged context). Versions accumulate as
    you change inputs/prompts and rebuild.
  Build/rebuild stream a live log; one-click HTML export. **Author right here:**
  create a new workflow, add steps with a form, or edit `loom.yaml` directly
  (validated on save).
- **Metrics** — tokens, model spend, and the headline **$ saved by caching**,
  refreshed live as you build.
- **Inputs / Context / Prompts** — browse, **create**, edit, and delete managed
  files, with **live collaborative editing**: edits sync across clients in real
  time and presence avatars show who else is in the file.
- **Artifacts** — every compiled output with full provenance, plus a
  "diff vs previous" button per artifact.
- **Snapshots** — create and browse git snapshots.
- **Share** — export a workflow or the whole workspace to self-contained HTML;
  copy a link, open, or download to send externally.

## Layout under `.loom/`

```
.loom/
  cache/<key>.{json,out}   content-addressed artifacts   (gitignored, rebuildable)
  outputs/<wf>/<output>    latest materialized outputs   (tracked)
  state.json               step -> current artifact key  (tracked)
  events.log               append-only build/edit log    (tracked)
  exports/<wf>.html        shareable exports
```

## Roadmap (staged)

- **Now:** git snapshots; interactive DAG view; per-artifact history + diffs;
  cost/cache-savings metrics; in-UI authoring; **live collaborative editing with
  presence**; offline mock provider + one-command demo.
- **Next:** conflict-free (CRDT/Yjs) concurrent editing layered over the event
  log; remote sharing of exports; diffing across snapshots.

## Tech

TypeScript (ESM). Inference via `@anthropic-ai/sdk` (model `claude-opus-4-8`,
adaptive thinking). Coding agents via `@anthropic-ai/claude-agent-sdk` (`query()`,
headless). `yaml` for config, `ws` for live updates. No database — just files.

> The Anthropic SDKs are pinned to `latest` since they move quickly; pin exact
> versions in `package.json` if you need reproducible installs.

## Development

```bash
npm run typecheck     # tsc --noEmit over src/
npm run build         # compile + copy web assets
npm test              # node:test suite (via tsx) — no API key needed
```

Tests live in `test/` and run on Node's built-in test runner. The engine accepts
injectable step runners (`new Engine(ws, dirs, store, { inference, agent })`), so
the full build → cache → rebuild → diff flow is tested deterministically without
calling a model. **CI** (GitHub Actions) runs typecheck + build + tests on Node 20
and 22 for every push and pull request.

## License

MIT
