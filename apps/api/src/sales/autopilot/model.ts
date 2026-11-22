// The model the autopilot asks (docs/sales-autopilot.md section 4, "The model"): one question, one structured answer, no tools. The real
// one follows expense-receipts.ts: `messages.parse` with a zod output format, no retries, a timeout, never throws. It logs nothing itself:
// the runner writes one JSON line per call (with the venture and the step), from the usage and the stop reason returned here. Never text.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

export type ModelUsage = { inputTokens: number; outputTokens: number; stop?: string | null };
/**
 * One question: the system prompt (the rules), the user message (the facts, outside text inside marked data blocks), the answer's schema.
 * `event` names the step in the log line.
 */
export type AskQuestion<T> = { event: string; system: string; user: string; schema: z.ZodType<T>; maxTokens: number; timeoutMs: number };
/**
 * The answer, or why not. `lasting`: asking again won't help (no key, a refused key, no permission, no credit): the pass stops. `busy`: about
 * us, not the item, and it passes by itself (a rate limit, an overloaded or failing API, a timeout, no connection): the pass stops asking for
 * this turn. Neither counts as a try on the item. Anything else (a refusal, an answer cut off) is about the item. `detail` is for the log
 * line only (the API's error type and status), never page text.
 */
export type AskResult<T> = { value: T; usage: ModelUsage } | { error: string; lasting?: boolean; busy?: boolean; usage?: ModelUsage; detail?: Record<string, string | number> };
export type AutopilotModel = { readonly name: string; ask<T>(question: AskQuestion<T>): Promise<AskResult<T>> };

export const NO_KEY = "Claude isn't set up on this server yet: an admin adds the key.";

/** The autopilot's model through Anthropic's API, as `model` (SALES_AUTOPILOT_MODEL). No key: every question answers with a lasting error. */
export function anthropicModel(options: { apiKey: string | undefined; model: string }): AutopilotModel {
  const client = options.apiKey ? new Anthropic({ apiKey: options.apiKey, maxRetries: 0 }) : undefined;
  return {
    name: options.model,
    async ask<T>(question: AskQuestion<T>): Promise<AskResult<T>> {
      if (!client) return { error: NO_KEY, lasting: true };
      try {
        const response = await client.messages.parse({
          // Opus 5.5 always thinks; effort is the only dial (its default is medium, set here so it doesn't drift).
          model: options.model, max_tokens: question.maxTokens, thinking: { type: "adaptive" }, system: question.system,
          output_config: { effort: "medium", format: zodOutputFormat(question.schema) },
          messages: [{ role: "user", content: question.user }],
        }, { timeout: question.timeoutMs });
        const usage: ModelUsage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, stop: response.stop_reason };
        if (response.stop_reason === "refusal") return { error: "Claude declined to answer this one", usage };
        if (response.stop_reason !== "end_turn" || response.parsed_output == null) return { error: "Claude's answer was cut off or could not be read", usage };
        return { value: response.parsed_output as T, usage };
      } catch (error) {
        const api = error instanceof Anthropic.APIError ? (error.error as { error?: { type?: string } } | undefined)?.error : undefined;
        const detail = { error: error instanceof Error ? error.constructor.name : typeof error, ...(error instanceof Anthropic.APIError && error.status ? { status: error.status } : {}), ...(api?.type ? { type: api.type } : {}) };
        if (error instanceof Anthropic.AuthenticationError) return { error: "The server's key for Claude was refused: an admin checks it.", lasting: true, detail };
        if (error instanceof Anthropic.PermissionDeniedError) return { error: "The server's key for Claude may not use this model: an admin checks it.", lasting: true, detail };
        // No credit left: the API answers 400 (or 402) with a billing error. Asking again won't help until someone adds credit.
        if (api?.type === "billing_error" || (error instanceof Anthropic.APIError && error.status === 402)) return { error: "Claude's account has no credit left: an admin adds credit.", lasting: true, detail };
        if (error instanceof Anthropic.NotFoundError) return { error: `The model ${options.model} isn't available: an admin checks SALES_AUTOPILOT_MODEL.`, lasting: true, detail };
        if (error instanceof Anthropic.RateLimitError) return { error: "Claude is busy: the autopilot tries again later.", busy: true, detail };
        if (error instanceof Anthropic.APIConnectionTimeoutError) return { error: "Claude took too long to answer.", busy: true, detail };
        if (error instanceof Anthropic.APIConnectionError) return { error: "Claude couldn't be reached.", busy: true, detail };
        // Overloaded (529) and the API's own failures (5xx) pass by themselves.
        if (error instanceof Anthropic.APIError && typeof error.status === "number" && error.status >= 500) return { error: "Claude's service is busy or failing: the autopilot tries again later.", busy: true, detail };
        return { error: "Claude could not answer this one.", detail };
      }
    },
  };
}
