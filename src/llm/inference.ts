import Anthropic from "@anthropic-ai/sdk";
import type { Usage } from "../core/types.js";
import { estimateCost } from "./pricing.js";

export interface InferenceOptions {
  model: string;
  system?: string;
  prompt: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
  /** Called with each streamed text delta (for live progress). */
  onDelta?: (text: string) => void;
}

export interface InferenceResult {
  content: string;
  usage?: Usage;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Export it before running inference steps.",
    );
  }
  if (!client) client = new Anthropic();
  return client;
}

/**
 * Run a single Claude chat-model inference. Streams (so large outputs don't hit
 * request timeouts) and uses adaptive thinking — the recommended setup for the
 * 4.x models.
 */
export async function runInference(opts: InferenceOptions): Promise<InferenceResult> {
  const c = getClient();
  const params: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 16000,
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content: opts.prompt }],
  };
  if (opts.system) params.system = opts.system;
  if (opts.effort) params.output_config = { effort: opts.effort };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream = c.messages.stream(params as any);
  if (opts.onDelta) stream.on("text", (t: string) => opts.onDelta!(t));
  const message = await stream.finalMessage();

  const content = message.content
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((b: any) => b.type === "text")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((b: any) => b.text)
    .join("");

  const inputTokens = message.usage?.input_tokens ?? 0;
  const outputTokens = message.usage?.output_tokens ?? 0;
  return {
    content,
    usage: {
      inputTokens,
      outputTokens,
      costUsd: estimateCost(opts.model, inputTokens, outputTokens),
    },
  };
}
