/** Best-effort USD cost estimate from token usage. Prices per 1M tokens. */
const PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-opus-4-6": { in: 5, out: 25 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

export function estimateCost(model: string, inputTokens = 0, outputTokens = 0): number | undefined {
  const key = Object.keys(PRICES).find((k) => model.startsWith(k));
  if (!key) return undefined;
  const p = PRICES[key];
  return (inputTokens / 1e6) * p.in + (outputTokens / 1e6) * p.out;
}
