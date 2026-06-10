# Loom — demo script

A self-contained walkthrough that proves the product with **no API key** — mock
mode synthesizes every output offline, so the whole thing (build caching, DAG,
diffs, the cost dashboard, live collaboration, sharing) runs with zero setup.
Plan on ~3 minutes for the core story, ~5 with collaboration + sharing.

## Setup (once)

```bash
npm install && npm run build
mkdir loom-demo && cd loom-demo
node ../dist/cli/index.js demo "Acme AI"   # scaffolds + builds a full pipeline
node ../dist/cli/index.js serve --mock     # http://localhost:4319
```

## The story (what to click, what to say)

**1. The problem (Workflows tab).**
You're looking at a real pipeline as a graph: *research → analysis → PRD →
launch blog → a landing page built by a coding agent.* Today teams run this by
hand — paste docs, copy a prompt, save the output, repeat — and re-pay every
time.

> Point at the **DAG**. Each node is a step, color-coded by freshness
> (green = fresh). Click a node → **Output** to see the compiled artifact.

**2. It's a build system (the "aha").**
Click **Rebuild**. Steps stream live… then settle to **cached** instantly. Now
open **Inputs**, edit `market.md`, come back and **Build** — only the steps that
*depend* on what changed recompute; everything else stays cached. Click the
changed node → **Diff** and pick two versions to see exactly what moved.

> "This is `make` for LLM work. Each step is content-hashed over its inputs +
> prompt + model; unchanged steps are never recomputed."

**3. The money (Metrics tab).**
The headline card is **Saved by caching** — real model spend avoided by serving
unchanged steps from cache — next to what you actually spent and the cache-hit
rate. That's the ROI line in one number.

**4. Coding agents, not just chat (Workflows → `landing` step).**
The last step is a **Claude coding agent** that actually wrote
`site/index.html` + `styles.css`. Its report is the artifact; the files are real
build outputs — agents are first-class build steps, not a chat box.

**5. Real-time collaboration (Inputs tab, two windows).**
Open the same input in a second browser window and type in one — edits merge
live in the other via a **conflict-free CRDT** (no last-writer-wins clobbering).
You'll see **presence avatars** for who's in the file and a **remote cursor**
(name-flagged, in their color) that stays on the right character even as you both
type. Flip to **Workflows**: click a step in one window and a **presence avatar
appears on that node** in the other — you can see who's looking at what.

> "Git-backed today, designed for live multiplayer — and here it is."

**6. Share it with roles (Share tab → Collaborators).**
As the owner, pick **viewer** or **editor**, click **Create invite link**, and
copy it. Open it in another browser: that session joins with exactly that role —
a **viewer** gets a read-only UI (no build/edit controls, editor is read-only),
an **editor** can edit and build. The server enforces it on every request and
every keystroke. One `loom serve` (on your laptop or a shared host) is now a
live, multi-user workspace.

**7. Many projects, one server (workspace switcher, top-right).**
The dropdown switches between workspaces hosted by the same server — documents,
presence, builds, and access are all isolated per workspace, so different teams
never cross streams.

**8. Author in-product (Workflows → "+ New workflow" / "+ Step").**
Add a step with a form (or edit `loom.yaml` directly, validated on save), then
build it — the DAG grows. Inputs, prompts, and context are all created and
edited right here.

**9. Ship & version (Share + Snapshots).**
**Export everything** → a self-contained HTML bundle with full provenance
(inputs, model, tokens, cost, time) you can email or host. Then take a git
**Snapshot** of the whole workspace + results and browse history.

## The one-liner

> Loom is GNU Autotools × Notion for LLM work: versioned inputs and a prompt
> library compiled by workflows into cached, content-addressed artifacts —
> coding agents included — with conflict-free live collaboration, role-based
> sharing, a real cost story, and shareable outputs.
