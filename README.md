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
- **Real-time & versioned.** **Conflict-free (CRDT) multi-user editing** with
  presence — open the same input in two windows and concurrent edits merge
  deterministically (no last-writer-wins clobbering), with avatars showing who's
  in the file — plus git snapshots for history.

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
| `loom snapshot -m "msg"` | Commit a git snapshot · `list` · `diff <a> <b> [path]` |
| `loom export [workflow]` | Shareable HTML (no arg = all + index; `--bundle` = one file) |
| `loom diff <workflow> <step>` | Diff a step's current output vs its previous version (`--from`, `--to`) |
| `loom workspace list \| add [dir] \| remove <id>` | Manage the multi-workspace registry |
| `loom share list \| create <role> [label] \| revoke <id>` | Manage workspace invite links |
| `loom serve [--port 4319] [--host 0.0.0.0]` | Launch the local web UI (loopback by default) |

## The web UI

`loom serve` starts a local server (no external services) with:

- **Workflows** — an interactive **DAG view**: each step is a node laid out by
  dependency rank, color-coded by freshness (fresh / stale / unbuilt / error)
  and animated live as a build runs. **Live presence right on the graph:**
  collaborator avatars appear on the step each person is inspecting (and on the
  workflow header), so you can see who's looking at what in real time. Click a
  node to inspect it:
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
  files, with **conflict-free (CRDT) collaborative editing**: concurrent edits
  merge deterministically, presence avatars show who else is in the file, and
  **remote cursors** render each collaborator's caret (name-flagged, in their
  color) at the right character even while everyone types at once.
- **Artifacts** — every compiled output with full provenance, plus a
  "diff vs previous" button per artifact.
- **Snapshots** — create and browse git snapshots.
- **Share** — invite collaborators with role-based links (see *Sharing & roles*
  below), and export a workflow or the whole workspace to self-contained HTML to
  send externally.

A **workspace switcher** in the top bar hosts several workspaces from one
`loom serve`: pick one to scope every view to it, or **+** to register another
by path. Documents, presence, cursors, DAG focus, and build events are all
isolated per workspace, so two teams on two workspaces never cross streams. The
registry lives at `$LOOM_HOME/workspaces.json` (default `~/.loom`) and is also
editable from the CLI (`loom workspace list | add | remove`).

## Sharing & roles (hosted multiplayer)

Invite collaborators into a workspace with a **share link** that carries a role:

- **viewer** — read-only: browse the DAG, outputs, artifacts, metrics, and
  snapshots, and watch edits + presence live, but can't change anything.
- **editor** — viewer, plus edit managed files (collaboratively), build,
  snapshot, and export.
- **owner** — editor, plus mint/revoke invite links and manage the workspace.

The owner opens **Share → Collaborators**, picks a role, and copies a link like
`http://host:4319/?ws=<id>&token=<secret>`. Anyone who opens it joins with that
role — the UI hides controls they can't use and the server enforces it on every
request and every WebSocket edit. Mint links from the terminal too:

```bash
loom share create editor "Dana"   # prints an invite link
loom share list                    # list active invites
loom share revoke <id>             # revoke one
```

Tokens live in `$LOOM_HOME/tokens.json` (host-side, never in the workspace
files, so they don't leak through git). Files stay the source of truth; identity
and access are a thin layer on top, so a single `loom serve` (on your machine or
a shared host) becomes a live, multi-user workspace.

## Security model

Loom serves a web app that reads and writes files, so access is locked down:

- **Loopback by default.** `loom serve` binds to `127.0.0.1` — not reachable
  from the network. Pass `--host 0.0.0.0` to share on a (trusted) network or a
  tunnel so collaborators can connect.
- **Token-gated.** The host machine (loopback) is the owner; everyone else needs
  a valid share token, whose role governs what they can do. Every REST request
  and every collaborative edit is checked.
- **Origin-checked.** WebSocket handshakes and state-changing HTTP requests are
  refused unless they're **same-origin** (or loopback), so a malicious web page
  you visit can't drive the API (CSRF / cross-site WebSocket hijacking).
  Non-browser clients (the CLI, scripts) send no `Origin` and are allowed.
- **Confined file access.** The file API (REST and the collaborative editor)
  only reads and writes under the managed `inputs/`, `prompts/`, and `context/`
  directories; path traversal and reads of `.loom/` internals or `loom.yaml` are
  refused.

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

- **Now:** git snapshots + diffing across snapshots; interactive DAG view;
  per-artifact history + diffs; cost/cache-savings metrics; in-UI authoring;
  **conflict-free (CRDT) collaborative editing with presence and remote
  cursors** (carets are anchored to CRDT character ids, so they stay on the
  right character as concurrent edits land); **live presence on the DAG**
  (avatars on the step each collaborator is inspecting); **multi-workspace**
  (one `loom serve` hosts a registry of workspaces with an in-UI switcher;
  documents, presence, and builds are isolated per workspace); **shared
  workspaces with role-based invite links** (owner / editor / viewer, enforced
  on every request and edit); offline mock provider + demo; single-file
  shareable export bundle.
- **Next:** named accounts (vs. anonymous invite links), and a cloud-hosted
  deployment so workspaces live beyond one machine.

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
