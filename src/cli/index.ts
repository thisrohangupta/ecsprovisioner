#!/usr/bin/env node
import { resolve } from "node:path";
import { loadWorkspace, resolveDirs, findWorkspaceRoot } from "../core/workspace.js";
import { Store } from "../core/store.js";
import { Engine } from "../core/engine.js";
import { listPrompts } from "../core/prompts.js";
import { scaffoldWorkspace, scaffoldDemo } from "../core/scaffold.js";
import { mockEnabled, selectRunners } from "../llm/runners.js";
import { snapshot as gitSnapshot, listSnapshots, readFileAtSnapshot, changedFiles } from "../core/snapshot.js";
import { exportWorkflowHtml, exportAllHtml, exportBundleHtml } from "../core/exporter.js";
import { dagEdges } from "../core/graph.js";
import { diffLines, diffStats } from "../core/diff.js";
import { computeMetrics } from "../core/metrics.js";

const c = {
  reset: "\x1b[0m",
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function parseFlags(args: string[]): { positionals: string[]; flags: Record<string, string | boolean> } {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.length > 1 && a.startsWith("-")) {
      const key = a.replace(/^-+/, "");
      const next = args[i + 1];
      if (next !== undefined && !(next.length > 1 && next.startsWith("-"))) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positionals.push(a);
  }
  return { positionals, flags };
}

async function main() {
  const [, , command, ...rest] = process.argv;
  const { positionals, flags } = parseFlags(rest);

  switch (command) {
    case "init":
      return cmdInit(positionals[0], flags);
    case "demo":
      return cmdDemo(positionals[0], flags);
    case "build":
      return cmdBuild(positionals[0], flags);
    case "status":
      return cmdStatus(positionals[0]);
    case "stats":
      return cmdStats();
    case "ls":
    case "workflows":
      return cmdLs();
    case "prompts":
      return cmdPrompts();
    case "snapshot":
      return cmdSnapshot(positionals, flags);
    case "export":
      return cmdExport(positionals[0], flags);
    case "diff":
      return cmdDiff(positionals, flags);
    case "workspace":
    case "ws":
      return cmdWorkspace(positionals, flags);
    case "share":
      return cmdShare(positionals, flags);
    case "serve":
      return cmdServe(flags);
    case "version":
    case "--version":
    case "-v":
      console.log("loom 0.1.0");
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return printHelp();
    default:
      console.error(c.red(`Unknown command: ${command}`));
      printHelp();
      process.exitCode = 1;
  }
}

function printHelp() {
  console.log(`${c.bold("loom")} — a local-first build system for LLM workflows

${c.bold("Usage:")} loom <command> [options]

${c.bold("Commands:")}
  init [name]              Scaffold a new workspace in the current directory
  demo [name]              Scaffold + build a rich demo workspace offline (mock)
  build [workflow]         Build a workflow (or all). --force, --all, --mock
  status [workflow]        Show which steps are fresh vs stale
  stats                    Tokens, cost, and $ saved by caching
  ls                       List workflows and their steps
  prompts                  List the prompt library
  snapshot -m "message"    Commit a git snapshot of the workspace
  snapshot list            List recent snapshots
  snapshot diff <a> <b> [path]  Diff tracked files across two snapshots
  export <workflow>        Write a shareable self-contained HTML file
  diff <workflow> <step>   Diff a step's current output vs its previous version
  workspace list|add|remove  Manage the multi-workspace registry
  share list|create <role>|revoke  Manage workspace invite links (owner/editor/viewer)
  serve [--port 4319]      Launch the local web UI (--mock offline; --host to expose on LAN)
  version                  Print version

${c.bold("Tip:")} run ${c.cyan("loom demo && loom serve --mock")} for a full, key-free walkthrough.

${c.bold("Examples:")}
  loom init my-project
  ANTHROPIC_API_KEY=... loom build brief
  loom status brief
  loom export brief && open .loom/exports/brief.html
  loom serve
`);
}

function openWorkspace(mock = false) {
  const ws = loadWorkspace();
  const dirs = resolveDirs(ws);
  const store = new Store(dirs.loom);
  store.init();
  return { ws, dirs, store, engine: new Engine(ws, dirs, store, selectRunners(mock)) };
}

function cmdInit(name: string | undefined, flags: Record<string, string | boolean>) {
  const root = resolve(process.cwd(), (flags.dir as string) ?? ".");
  if (findWorkspaceRoot(root) === root) {
    console.error(c.yellow("A Loom workspace already exists here."));
    return;
  }
  const wsName = name ?? root.split("/").pop() ?? "workspace";
  const created = scaffoldWorkspace(root, wsName);
  console.log(c.green(`Initialized Loom workspace "${wsName}".`));
  for (const f of created) console.log("  " + c.dim("created ") + f);
  console.log(`\nNext:\n  ${c.cyan("export ANTHROPIC_API_KEY=...")}\n  ${c.cyan("loom build brief")}\n  ${c.cyan("loom serve")}`);
}

async function cmdDemo(name: string | undefined, flags: Record<string, string | boolean>) {
  const root = resolve(process.cwd(), (flags.dir as string) ?? ".");
  if (findWorkspaceRoot(root) === root) {
    console.error(c.yellow("A Loom workspace already exists here — `cd` somewhere empty first."));
    return;
  }
  const wsName = name ?? "Loom Demo";
  const created = scaffoldDemo(root, wsName);
  console.log(c.green(`Created demo workspace "${wsName}".`));
  for (const f of created) console.log("  " + c.dim("created ") + f);

  if (flags["no-build"]) {
    console.log(`\nRun it offline:\n  ${c.cyan("loom build --mock")}\n  ${c.cyan("loom serve --mock")}`);
    return;
  }
  console.log(c.bold("\nBuilding the pipeline offline (mock mode)…"));
  await cmdBuild(undefined, { mock: true });
  console.log(
    `\n${c.green("Demo ready.")} Explore it:\n` +
      `  ${c.cyan("loom serve --mock")}   ${c.dim("# open the UI; build/rebuild, watch the DAG, diff versions")}\n` +
      `  ${c.cyan("loom stats")}          ${c.dim("# tokens, cost, and $ saved by caching")}\n` +
      `  ${c.cyan("loom export launch")}  ${c.dim("# shareable self-contained HTML")}`,
  );
}

async function cmdBuild(workflow: string | undefined, flags: Record<string, string | boolean>) {
  const mock = mockEnabled(!!flags.mock);
  const { ws, engine } = openWorkspace(mock);
  const force = !!flags.force;
  const targets = workflow
    ? [workflow]
    : flags.all || ws.config.workflows.length
      ? ws.config.workflows.map((w) => w.id)
      : [];
  if (!targets.length) {
    console.error(c.red("No workflows defined."));
    process.exitCode = 1;
    return;
  }
  if (mock) console.log(c.dim("(mock mode — synthesizing outputs offline, no API calls)"));

  let failed = false;
  for (const id of targets) {
    console.log(c.bold(`\n▸ building ${id}`) + (force ? c.dim(" (forced)") : ""));
    const result = await engine.buildWorkflow(id, {
      force,
      onEvent: (e) => {
        if (e.type === "step.start") {
          process.stdout.write(`  ${c.dim("●")} ${e.data.stepId} ${c.dim(`(${e.data.type})`)} … `);
        } else if (e.type === "step.cached") {
          console.log(`  ${c.cyan("◌")} ${e.data.stepId} ${c.dim("cached")}`);
        } else if (e.type === "step.done") {
          const u = e.data.usage as { costUsd?: number } | undefined;
          const cost = u?.costUsd != null ? c.dim(` ~$${u.costUsd.toFixed(4)}`) : "";
          console.log(`${c.green("done")} ${c.dim(`${e.data.bytes}B ${e.data.durationMs}ms`)}${cost}`);
        } else if (e.type === "step.error") {
          console.log(c.red("error"));
          console.log("    " + c.red(String(e.data.error)));
        }
      },
    });
    if (result.steps.some((s) => s.status === "error")) failed = true;
  }
  if (failed) process.exitCode = 1;
  else console.log(c.green("\n✓ build complete"));
}

function cmdStatus(workflow: string | undefined) {
  const { ws, engine } = openWorkspace();
  const targets = workflow ? [workflow] : ws.config.workflows.map((w) => w.id);
  for (const id of targets) {
    console.log(c.bold(`\n${id}`));
    for (const s of engine.status(id)) {
      const mark = s.fresh ? c.green("✓ fresh") : s.built ? c.yellow("~ stale") : c.dim("· unbuilt");
      console.log(`  ${mark}  ${s.stepId} ${c.dim(`(${s.type})`)}${s.note ? c.dim("  " + s.note) : ""}`);
    }
  }
}

function cmdStats() {
  const { store } = openWorkspace();
  const m = computeMetrics(store);
  const usd = (n: number) => `$${n.toFixed(4)}`;
  console.log(c.bold("Usage & savings"));
  console.log(`  ${c.dim("builds")}        ${m.builds}`);
  console.log(`  ${c.dim("model calls")}   ${m.modelCalls}`);
  console.log(`  ${c.dim("cache hits")}    ${m.cacheHits}  ${c.dim(`(${Math.round(m.cacheHitRate * 100)}% hit rate)`)}`);
  console.log(`  ${c.dim("tokens")}        ${m.tokensIn} in / ${m.tokensOut} out`);
  console.log(`  ${c.dim("artifacts")}     ${m.artifacts}`);
  console.log(`  ${c.dim("spent")}         ${c.yellow(usd(m.spentUsd))}`);
  console.log(`  ${c.dim("saved by cache")} ${c.green(usd(m.savedUsd))}`);
}

function cmdLs() {
  const { ws } = openWorkspace();
  console.log(c.bold(ws.config.name) + (ws.config.description ? c.dim(" — " + ws.config.description) : ""));
  for (const wf of ws.config.workflows) {
    console.log(`\n${c.cyan(wf.id)}${wf.description ? c.dim(" — " + wf.description) : ""}`);
    const edges = dagEdges(wf);
    for (const step of wf.steps) {
      const deps = edges.filter((e) => e.to === step.id).map((e) => e.from);
      const depStr = deps.length ? c.dim(`  ← ${deps.join(", ")}`) : "";
      console.log(`  ${step.id} ${c.dim(`(${step.type} → ${step.output})`)}${depStr}`);
    }
  }
}

function cmdPrompts() {
  const { dirs } = openWorkspace();
  const prompts = listPrompts(dirs);
  if (!prompts.length) {
    console.log(c.dim("No prompts yet."));
    return;
  }
  for (const p of prompts) {
    const firstLine = p.content.split("\n")[0].slice(0, 70);
    console.log(`${c.cyan(p.name)}  ${c.dim(firstLine)}`);
  }
}

function cmdSnapshot(positionals: string[], flags: Record<string, string | boolean>) {
  const { ws } = openWorkspace();
  if (positionals[0] === "list") {
    const snaps = listSnapshots(ws.root);
    if (!snaps.length) console.log(c.dim("No snapshots yet."));
    for (const s of snaps) console.log(`${c.cyan(s.hash)} ${c.dim(s.date)} ${s.subject}`);
    return;
  }
  if (positionals[0] === "diff") {
    const [, revA, revB, path] = positionals;
    if (!revA || !revB) {
      console.error(c.red("Usage: loom snapshot diff <revA> <revB> [path]"));
      process.exitCode = 1;
      return;
    }
    if (!path) {
      const files = changedFiles(ws.root, revA, revB);
      if (!files.length) console.log(c.dim("No tracked files changed between those snapshots."));
      for (const f of files) console.log("  " + f);
      console.log(c.dim(`\nDiff one with: loom snapshot diff ${revA} ${revB} <path>`));
      return;
    }
    const a = readFileAtSnapshot(ws.root, revA, path) ?? "";
    const b = readFileAtSnapshot(ws.root, revB, path) ?? "";
    const ops = diffLines(a, b);
    const stats = diffStats(ops);
    console.log(`${c.dim(revA)} ${c.dim("→")} ${c.dim(revB)}  ${c.green("+" + stats.added)} ${c.red("-" + stats.removed)}  ${path}`);
    if (!stats.added && !stats.removed) { console.log(c.dim("(identical)")); return; }
    for (const op of ops) {
      if (op.type === "add") console.log(c.green("+ " + op.text));
      else if (op.type === "del") console.log(c.red("- " + op.text));
      else console.log(c.dim("  " + op.text));
    }
    return;
  }
  const message = (flags.m as string) ?? (flags.message as string) ?? `Snapshot ${new Date().toISOString()}`;
  const res = gitSnapshot(ws.root, message);
  if (res.ok) console.log(c.green(`✓ snapshot ${res.hash}`) + c.dim(` — ${message}`));
  else console.log(c.yellow(res.reason ?? "Nothing to snapshot."));
}

function cmdExport(workflow: string | undefined, flags: Record<string, string | boolean>) {
  const { ws, store } = openWorkspace();
  if (flags.bundle) {
    const { path } = exportBundleHtml(ws, store);
    console.log(c.green("✓ bundle ") + path + c.dim("  (one self-contained file — email or host it)"));
    return;
  }
  if (workflow) {
    const { path } = exportWorkflowHtml(ws, store, workflow);
    console.log(c.green("✓ exported ") + path);
    return;
  }
  // No arg: export every workflow + a linked index.
  const { indexPath, pages } = exportAllHtml(ws, store);
  for (const p of pages) console.log(c.green("✓ exported ") + p.path);
  console.log(c.green("✓ index ") + indexPath + c.dim("  (self-contained — open or share these files)"));
}

function cmdDiff(positionals: string[], flags: Record<string, string | boolean>) {
  const { store } = openWorkspace();
  const [workflow, step] = positionals;
  if (!workflow || !step) {
    console.error(c.red("Usage: loom diff <workflow> <step> [--from <key>] [--to <key>]"));
    process.exitCode = 1;
    return;
  }
  const versions = store.listStepArtifacts(workflow, step);
  if (!versions.length) {
    console.log(c.dim(`No artifacts for ${workflow}/${step} yet — build it first.`));
    return;
  }
  const toKey = (flags.to as string) ?? store.getStepArtifactKey(workflow, step) ?? versions[0].key;
  let fromKey = flags.from as string | undefined;
  if (!fromKey) {
    const idx = versions.findIndex((v) => v.key === toKey);
    const prev = idx >= 0 ? versions[idx + 1] : versions.find((v) => v.key !== toKey);
    if (!prev) {
      console.log(c.dim("Only one version of this artifact — nothing to diff. Change an input and rebuild."));
      return;
    }
    fromKey = prev.key;
  }
  if (!store.hasArtifact(fromKey) || !store.hasArtifact(toKey)) {
    console.error(c.red("One or both artifact versions were not found."));
    process.exitCode = 1;
    return;
  }
  const ops = diffLines(store.getArtifactContent(fromKey), store.getArtifactContent(toKey));
  const stats = diffStats(ops);
  console.log(
    `${c.dim(fromKey.slice(0, 8))} ${c.dim("→")} ${c.dim(toKey.slice(0, 8))}  ` +
      `${c.green("+" + stats.added)} ${c.red("-" + stats.removed)}`,
  );
  if (!stats.added && !stats.removed) {
    console.log(c.dim("(identical)"));
    return;
  }
  for (const op of ops) {
    if (op.type === "add") console.log(c.green("+ " + op.text));
    else if (op.type === "del") console.log(c.red("- " + op.text));
    else console.log(c.dim("  " + op.text));
  }
}

async function cmdWorkspace(positionals: string[], _flags: Record<string, string | boolean>) {
  const { listWorkspaces, addWorkspace, removeWorkspace } = await import("../core/registry.js");
  const sub = positionals[0] ?? "list";
  if (sub === "list" || sub === "ls") {
    const list = listWorkspaces();
    if (!list.length) {
      console.log(c.dim("No workspaces registered yet. Run `loom workspace add` in a workspace."));
      return;
    }
    for (const w of list) {
      console.log(`${c.bold(w.id)}  ${c.cyan(w.name)}\n  ${c.dim(w.root)}`);
    }
    return;
  }
  if (sub === "add") {
    const root = positionals[1] ? resolve(positionals[1]) : process.cwd();
    const entry = addWorkspace(root);
    console.log(`${c.green("✓")} registered ${c.bold(entry.name)} (${c.dim(entry.id)})`);
    return;
  }
  if (sub === "remove" || sub === "rm") {
    const id = positionals[1];
    if (!id) { console.error(c.red("usage: loom workspace remove <id>")); process.exitCode = 1; return; }
    console.log(removeWorkspace(id) ? `${c.green("✓")} removed ${id}` : c.yellow(`no workspace with id ${id}`));
    return;
  }
  console.error(c.red(`Unknown workspace subcommand: ${sub}`));
  console.log("usage: loom workspace <list | add [dir] | remove <id>>");
  process.exitCode = 1;
}

async function cmdShare(positionals: string[], flags: Record<string, string | boolean>) {
  const { workspaceId } = await import("../core/registry.js");
  const { createToken, publicTokens, revokeToken, isRole } = await import("../core/access.js");
  const root = findWorkspaceRoot();
  if (!root) { console.error(c.red("No Loom workspace here. Run `loom init` first.")); process.exitCode = 1; return; }
  const ws = loadWorkspace(root);
  const wsId = workspaceId(ws.config.name, root);
  const sub = positionals[0] ?? "list";

  if (sub === "list" || sub === "ls") {
    const toks = publicTokens(wsId);
    if (!toks.length) { console.log(c.dim("No invite links yet. Create one with `loom share create <role>`.")); return; }
    for (const t of toks) console.log(`${c.bold(t.id)}  ${c.cyan(t.role)}  ${c.dim(t.label || "")}`);
    return;
  }
  if (sub === "create" || sub === "add") {
    const role = positionals[1];
    if (!isRole(role)) { console.error(c.red("usage: loom share create <owner|editor|viewer> [label]")); process.exitCode = 1; return; }
    const t = createToken(wsId, role, positionals.slice(2).join(" "));
    const host = typeof flags.host === "string" ? flags.host : "localhost";
    const port = flags.port ? Number(flags.port) : 4319;
    console.log(`${c.green("✓")} ${c.bold(role)} invite created (${c.dim(t.id)})`);
    console.log(`  link: ${c.cyan(`http://${host}:${port}/?ws=${wsId}&token=${t.token}`)}`);
    return;
  }
  if (sub === "revoke" || sub === "rm") {
    const id = positionals[1];
    if (!id) { console.error(c.red("usage: loom share revoke <id>")); process.exitCode = 1; return; }
    console.log(revokeToken(wsId, id) ? `${c.green("✓")} revoked ${id}` : c.yellow(`no invite with id ${id}`));
    return;
  }
  console.error(c.red(`Unknown share subcommand: ${sub}`));
  console.log("usage: loom share <list | create <role> [label] | revoke <id>>");
  process.exitCode = 1;
}

async function cmdServe(flags: Record<string, string | boolean>) {
  const { startServer } = await import("../server/server.js");
  const port = flags.port ? Number(flags.port) : 4319;
  // Loopback by default; pass --host 0.0.0.0 to expose on the LAN (no auth!).
  const host = typeof flags.host === "string" ? flags.host : "127.0.0.1";
  await startServer({ port, host, mock: mockEnabled(!!flags.mock) });
}

main().catch((err) => {
  console.error(c.red(err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
