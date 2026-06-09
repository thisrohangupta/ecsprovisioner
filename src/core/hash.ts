import { createHash } from "node:crypto";

/** Stable sha256 of a string, returned as hex. */
export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Short (12-char) hash, convenient for filenames and display. */
export function shortHash(input: string): string {
  return sha256(input).slice(0, 12);
}

/**
 * Deterministic hash of an arbitrary JSON-serializable value. Object keys are
 * sorted so that logically-equal values always hash identically (important for
 * cache stability — see shared/prompt-caching guidance on deterministic keys).
 */
export function hashJson(value: unknown): string {
  return sha256(stableStringify(value));
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
