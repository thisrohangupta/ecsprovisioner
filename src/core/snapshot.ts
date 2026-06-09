import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface Snapshot {
  hash: string;
  date: string;
  subject: string;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

export function isGitRepo(root: string): boolean {
  return existsSync(join(root, ".git"));
}

export function ensureGitRepo(root: string): void {
  if (!isGitRepo(root)) {
    git(root, ["init"]);
  }
}

/**
 * Commit the current workspace state (inputs, prompts, config, and the tracked
 * parts of .loom) as a snapshot. Git provides versioning + history "for free";
 * the data model is also designed so a live-sync layer can be added later.
 */
export function snapshot(root: string, message: string): { ok: boolean; hash?: string; reason?: string } {
  ensureGitRepo(root);
  git(root, ["add", "-A"]);
  const staged = git(root, ["status", "--porcelain"]);
  if (!staged) return { ok: false, reason: "Nothing changed since the last snapshot." };
  // Disable commit signing so a snapshot never fails because of a user's global
  // gpg/ssh-signing config — snapshots are routine, automated checkpoints.
  git(root, ["-c", "commit.gpgsign=false", "commit", "--no-gpg-sign", "-m", message]);
  const hash = git(root, ["rev-parse", "--short", "HEAD"]);
  return { ok: true, hash };
}

export function listSnapshots(root: string, limit = 50): Snapshot[] {
  if (!isGitRepo(root)) return [];
  let log: string;
  try {
    // \x1f (unit separator) safely delimits fields; \x1e (record separator) rows.
    log = git(root, ["log", `-${limit}`, "--pretty=format:%h%x1f%ci%x1f%s%x1e"]);
  } catch {
    return []; // no commits yet
  }
  if (!log) return [];
  return log
    .split("\x1e")
    .map((row) => row.replace(/^\n/, ""))
    .filter(Boolean)
    .map((row) => {
      const [hash, date, subject] = row.split("\x1f");
      return { hash, date, subject };
    });
}
