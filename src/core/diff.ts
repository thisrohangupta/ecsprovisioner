/**
 * Minimal line-level diff (LCS-based) used for comparing two artifact versions.
 * Returns a flat op list suitable for rendering a unified diff.
 */
export type DiffOpType = "eq" | "add" | "del";
export interface DiffOp {
  type: DiffOpType;
  text: string;
}
export interface DiffStats {
  added: number;
  removed: number;
}

/** Guard so a pathological pair of huge artifacts can't blow up memory. */
const MAX_CELLS = 4_000_000;

export function diffLines(aText: string, bText: string): DiffOp[] {
  const A = aText.length ? aText.replace(/\n$/, "").split("\n") : [];
  const B = bText.length ? bText.replace(/\n$/, "").split("\n") : [];
  const n = A.length;
  const m = B.length;

  if ((n + 1) * (m + 1) > MAX_CELLS) {
    // Fallback: treat as full replacement rather than risk OOM.
    return [
      ...A.map((text) => ({ type: "del" as const, text })),
      ...B.map((text) => ({ type: "add" as const, text })),
    ];
  }

  // dp[i][j] = LCS length of A[i:], B[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      ops.push({ type: "eq", text: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", text: A[i] });
      i++;
    } else {
      ops.push({ type: "add", text: B[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", text: A[i++] });
  while (j < m) ops.push({ type: "add", text: B[j++] });
  return ops;
}

export function diffStats(ops: DiffOp[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === "add") added++;
    else if (op.type === "del") removed++;
  }
  return { added, removed };
}
