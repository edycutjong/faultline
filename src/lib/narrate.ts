/**
 * Root-cause narration by an NVIDIA model on Nebius Token Factory.
 *
 * One chat-completion call per hunt, to `nvidia/nemotron-3-super-120b-a12b`, made only
 * after test execution has already named the culprit. The model explains; it never
 * decides. A bad completion degrades the report's prose without touching the claim the
 * report defends, and an empty one is reported as an error — never papered over.
 *
 * Nemotron 3 Super is a reasoning model: with a small `max_tokens` it can spend the whole
 * budget thinking and return no answer at all (seen on 2026-10-13 with 40 tokens). So the
 * call asks for low reasoning effort AND leaves generous room, and reads `content` only.
 */

import type { Hunt } from "@/lib/types";
import type { TokenFactoryConfig } from "@/lib/nebius/config";

export const NARRATION_PROVIDER = "nebius-token-factory";
export const NARRATION_MAX_TOKENS = 4096;

const SYSTEM_PROMPT =
  "You explain software regressions to the maintainer who will fix them. Answer with exactly " +
  "one plain-English paragraph: no headings, no bullet points, no preamble.";

/**
 * The prompt.
 *
 * Kept here rather than in a template service so it is reviewable in the repo, and so the
 * single-paragraph constraint is visible next to the UI that renders it. A second generated
 * block would be a second way to be visibly wrong on the payoff screen.
 */
export function buildPrompt(hunt: Hunt, diff: string, failureOutput: string): string {
  const report = hunt.report;
  return [
    `Repository: ${hunt.repoUrl}`,
    `Failing test: ${hunt.testCommand}`,
    `Guilty commit: ${report?.culpritSha ?? "unknown"} — ${report?.culpritSubject ?? ""}`,
    "",
    "This commit was identified by running the failing test on commits across the range, each",
    "in a fresh container with that commit's own dependencies installed: the commit before it",
    "passes and this one fails. The identification is established fact; do not question it or",
    "suggest the cause may lie elsewhere.",
    "",
    "The diff:",
    "```diff",
    diff,
    "```",
    "",
    "The failing test output:",
    "```",
    failureOutput || "(no output captured)",
    "```",
    "",
    "Write ONE paragraph, at most 120 words, explaining exactly how this change causes that",
    "test to fail. Name the specific lines responsible. If there is an obvious fix, state it in",
    "the same paragraph. Begin with the mechanism, not with a restatement of the question.",
  ].join("\n");
}

export interface NarrationOutcome {
  rootCauseMd: string | null;
  error: string | null;
  requestId: string | null;
  model: string;
  durationMs: number;
  usage: { promptTokens: number | null; completionTokens: number | null; reasoningTokens: number | null };
  /**
   * The same request could succeed if sent again: no response, 429, 5xx, or a body that is not
   * JSON. An empty answer is not retryable — with the same budget the model would think until
   * it ran out of room again.
   */
  retryable: boolean;
}

interface ChatCompletion {
  id?: string;
  model?: string;
  choices?: Array<{ finish_reason?: string; message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number | null } | null;
  };
}

/** Tidy the model's answer into the single paragraph the report renders. */
export function toParagraph(content: string): string {
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/[  ]/g, " ")
    .split(/\n\s*\n/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

/** One call. Every failure path returns an `error` rather than throwing or inventing prose. */
export async function narrate(
  tf: TokenFactoryConfig,
  prompt: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NarrationOutcome> {
  const started = Date.now();
  const outcome = (patch: Partial<NarrationOutcome>): NarrationOutcome => ({
    rootCauseMd: null,
    error: null,
    requestId: null,
    model: tf.model,
    durationMs: Date.now() - started,
    usage: { promptTokens: null, completionTokens: null, reasoningTokens: null },
    retryable: false,
    ...patch,
  });

  let res: Response;
  try {
    res = await fetchImpl(`${tf.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tf.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: tf.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        max_tokens: NARRATION_MAX_TOKENS,
        temperature: 0.2,
        reasoning_effort: "low",
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    return outcome({ error: `Token Factory request failed: ${error instanceof Error ? error.message : String(error)}`, retryable: true });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return outcome({
      error: `Token Factory returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
      retryable: res.status === 429 || res.status >= 500,
    });
  }

  let body: ChatCompletion;
  try {
    body = (await res.json()) as ChatCompletion;
  } catch {
    return outcome({ error: "Token Factory returned a response that is not JSON.", retryable: true });
  }

  const choice = body.choices?.[0];
  const usage = {
    promptTokens: body.usage?.prompt_tokens ?? null,
    completionTokens: body.usage?.completion_tokens ?? null,
    reasoningTokens: body.usage?.completion_tokens_details?.reasoning_tokens ?? null,
  };
  const paragraph = toParagraph(choice?.message?.content ?? "");

  if (!paragraph) {
    // A reasoning model that thought until it ran out of room. Say so; never fake a paragraph.
    return outcome({
      requestId: body.id ?? null,
      usage,
      error:
        `The model returned no answer (finish_reason ${choice?.finish_reason ?? "unknown"}` +
        `${usage.reasoningTokens !== null ? `, ${usage.reasoningTokens} reasoning tokens` : ""}).`,
    });
  }

  return outcome({ rootCauseMd: paragraph, requestId: body.id ?? null, model: body.model ?? tf.model, usage });
}
