import type { StepRunners } from "../core/engine.js";
import { mockRunners } from "./mock.js";

/** True when mock mode is requested via flag or the LOOM_MOCK env var. */
export function mockEnabled(flag?: boolean): boolean {
  if (flag) return true;
  const v = process.env.LOOM_MOCK;
  return v === "1" || v === "true";
}

/** Runners to hand the Engine: mock pair when enabled, otherwise the real ones. */
export function selectRunners(mock: boolean): Partial<StepRunners> | undefined {
  return mock ? mockRunners() : undefined;
}
