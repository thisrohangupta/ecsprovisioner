/**
 * Workspace sharing via capability tokens.
 *
 * Hosted multiplayer keeps files as the source of truth and layers access on
 * top: a workspace owner mints share tokens, each carrying a role. Anyone who
 * presents a token gets its role for that workspace; without a token, only a
 * request from the host machine itself (loopback) is trusted (as owner).
 *
 * Tokens are host/server state — they live under $LOOM_HOME (next to the
 * workspace registry), never inside the shared workspace files, so they don't
 * leak through git.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

export type Role = "owner" | "editor" | "viewer";

const RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

/** True if `role` is at least as privileged as `min`. */
export function roleAtLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

export function isRole(v: unknown): v is Role {
  return v === "owner" || v === "editor" || v === "viewer";
}

export interface ShareToken {
  id: string;
  token: string;
  role: Role;
  label: string;
  createdAt: string;
}

/** What the API returns about a token (never leaks the secret except on creation). */
export interface ShareTokenInfo {
  id: string;
  role: Role;
  label: string;
  createdAt: string;
}

function loomHome(): string {
  return process.env.LOOM_HOME || join(homedir(), ".loom");
}
function tokensPath(): string {
  return join(loomHome(), "tokens.json");
}

type TokenFile = Record<string, ShareToken[]>; // wsId -> tokens

function load(): TokenFile {
  const p = tokensPath();
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as TokenFile) : {};
  } catch {
    return {};
  }
}
function save(data: TokenFile): void {
  mkdirSync(loomHome(), { recursive: true });
  writeFileSync(tokensPath(), JSON.stringify(data, null, 2));
}

export function listTokens(wsId: string): ShareToken[] {
  return load()[wsId] ?? [];
}

export function publicTokens(wsId: string): ShareTokenInfo[] {
  return listTokens(wsId).map(({ id, role, label, createdAt }) => ({ id, role, label, createdAt }));
}

export function createToken(wsId: string, role: Role, label = ""): ShareToken {
  const data = load();
  const entry: ShareToken = {
    id: randomUUID().slice(0, 8),
    token: randomBytes(24).toString("base64url"),
    role,
    label: label.slice(0, 80),
    createdAt: new Date().toISOString(),
  };
  (data[wsId] ??= []).push(entry);
  save(data);
  return entry;
}

export function revokeToken(wsId: string, id: string): boolean {
  const data = load();
  const list = data[wsId] ?? [];
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) return false;
  data[wsId] = next;
  save(data);
  return true;
}

/** Resolve a presented token secret to its role for a workspace, or null. */
export function resolveRole(wsId: string, token: string | null | undefined): Role | null {
  if (!token) return null;
  const hit = (load()[wsId] ?? []).find((t) => t.token === token);
  return hit ? hit.role : null;
}
