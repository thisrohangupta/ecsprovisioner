#!/usr/bin/env node
import { resolve } from "node:path";
import { loadWorkspace, resolveDirs, findWorkspaceRoot } from "../core/workspace.js";
import { Store } from "../core/store.js";
import { Engine } from "../core/engine.js";
import { listPrompts } from "../core/prompts.js";
import { scaffoldWorkspace } from "../core/scaffold.js";
import { snapshot as gitSnapshot, listSnapshots } from "../core/snapshot.js";
import { exportWorkflowHtml } from "../core/exporter.js";
import { dagEdges } from "../core/graph.js";
import { diffLines, diffStats } from "../core/diff.js";

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
    case "build":
      return cmdBuild(positionals[0], flags);
    case "status":
      return cmdStatus(positionals[0]);
    case "ls":
    case "workflows":
      return cmdLs();
    case "prompts":
      return cmdPrompts();
    case "snapshot":
      return cmdSnapshot(positionals, flags);
    case "export":
      return cmdExport(positionals[0]);
    case "diff":
      return cmdDiff(positionals, flags);
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
  build [workflow]         Build a workflow (or all workflows). --force, --all
  status [workflow]        Show which steps are fresh vs stale
  ls                       List workflows and their steps
  prompts                  List the prompt library
  snapshot -m "message"    Commit a git snapshot of the workspace
  snapshot list            List recent snapshots
  export <workflow>        Write a shareable self-contained HTML file
  diff <workflow> <step>   Diff a step's current output vs its previous version
  serve [--port 4319]      Launch the local web UI (with live updates)
  version                  Print version

${c.bold("Examples:")}
  loom init my-project
  ANTHROPIC_API_KEY=... loom build brief
  loom status brief
  loom export brief && open .loom/exports/brief.html
  loom serve
`);
}

function openWorkspace() {
  const ws = loadWorkspace();
  const dirs = resolveDirs(ws);
  const store = new Store(dirs.loom);
  store.init();
  return { ws, dirs, store, engine: new Engine(ws, dirs, store) };
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

async function cmdBuild(workflow: string | undefined, flags: Record<string, string | boolean>) {
  const { ws, engine } = openWorkspace();
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
      const mark = s.fresh ? c.green("✓ fresh") : s.hasArtifact ? c.yellow("~ stale") : c.dim("· unbuilt");
      console.log(`  ${mark}  ${s.stepId} ${c.dim(`(${s.type})`)}${s.note ? c.dim("  " + s.note) : ""}`);
    }
  }
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
  const message = (flags.m as string) ?? (flags.message as string) ?? `Snapshot ${new Date().toISOString()}`;
  const res = gitSnapshot(ws.root, message);
  if (res.ok) console.log(c.green(`✓ snapshot ${res.hash}`) + c.dim(` — ${message}`));
  else console.log(c.yellow(res.reason ?? "Nothing to snapshot."));
}

function cmdExport(workflow: string | undefined) {
  const { ws, store } = openWorkspace();
  const targets = workflow ? [workflow] : ws.config.workflows.map((w) => w.id);
  for (const id of targets) {
    const { path } = exportWorkflowHtml(ws, store, id);
    console.log(c.green("✓ exported ") + path);
  }
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

async function cmdServe(flags: Record<string, string | boolean>) {
  const { startServer } = await import("../server/server.js");
  const port = flags.port ? Number(flags.port) : 4319;
  await startServer({ port });
}

main().catch((err) => {
  console.error(c.red(err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
