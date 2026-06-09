import { Store } from "./store.js";

/**
 * Workspace-level usage metrics derived from the event log + artifacts. The
 * headline number is `savedUsd` — money *not* spent because unchanged steps were
 * served from cache instead of re-running the model. That's the core value prop:
 * an LLM build system that doesn't re-pay for work that didn't change.
 */
export interface Metrics {
  builds: number;
  lastBuildAt?: string;
  modelCalls: number;
  cacheHits: number;
  tokensIn: number;
  tokensOut: number;
  spentUsd: number;
  savedUsd: number;
  artifacts: number;
  cacheHitRate: number; // 0..1 over (modelCalls + cacheHits)
}

export function computeMetrics(store: Store): Metrics {
  const events = store.readEvents(1_000_000);
  let builds = 0;
  let modelCalls = 0;
  let cacheHits = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let spentUsd = 0;
  let savedUsd = 0;
  let lastBuildAt: string | undefined;

  for (const e of events) {
    if (e.type === "build.start") {
      builds++;
      lastBuildAt = e.ts;
    } else if (e.type === "step.done") {
      modelCalls++;
      const u = e.data.usage as { inputTokens?: number; outputTokens?: number; costUsd?: number } | undefined;
      if (u) {
        tokensIn += u.inputTokens ?? 0;
        tokensOut += u.outputTokens ?? 0;
        spentUsd += u.costUsd ?? 0;
      }
    } else if (e.type === "step.cached") {
      cacheHits++;
      const key = e.data.key as string;
      const a = key ? store.getArtifact(key) : null;
      if (a?.usage?.costUsd) savedUsd += a.usage.costUsd;
    }
  }

  const decisions = modelCalls + cacheHits;
  return {
    builds,
    lastBuildAt,
    modelCalls,
    cacheHits,
    tokensIn,
    tokensOut,
    spentUsd,
    savedUsd,
    artifacts: store.listArtifacts().length,
    cacheHitRate: decisions ? cacheHits / decisions : 0,
  };
}
