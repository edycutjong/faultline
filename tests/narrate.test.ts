/**
 * Narration on Nebius Token Factory.
 *
 * One call per hunt to an NVIDIA reasoning model. The rules under test: the request is the
 * documented OpenAI-compatible shape with room for the model to reason AND answer; the answer
 * is read from `content` and nothing else; and every failure — HTTP, network, empty answer —
 * comes back as an error string, never as invented prose.
 */

import { describe, it, expect } from "vitest";
import { buildPrompt, narrate, toParagraph, NARRATION_MAX_TOKENS } from "@/lib/narrate";
import type { TokenFactoryConfig } from "@/lib/nebius/config";
import { loadTokenFactoryConfig, NARRATION_MODEL } from "@/lib/nebius/config";
import type { Hunt } from "@/lib/types";

const TF: TokenFactoryConfig = {
  apiKey: "tf-key-for-tests",
  baseUrl: "https://api.tokenfactory.nebius.com/v1",
  model: NARRATION_MODEL,
};

function capture(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return response();
  };
  return { impl, calls };
}

function completion(content: string | null, extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      model: NARRATION_MODEL,
      choices: [{ finish_reason: content ? "stop" : "length", message: { content } }],
      usage: { prompt_tokens: 900, completion_tokens: 140, completion_tokens_details: { reasoning_tokens: 12 } },
      ...extra,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const HUNT = {
  repoUrl: "https://github.com/faultline-bench/tzdata-pipeline",
  testCommand: "pytest tests/test_normalize.py::test_naive_local_midnight_is_interpreted_in_zone",
  report: {
    culpritSha: "406f7fce5a137398a0c2a739c087bfc9f54ab3cb",
    culpritSubject: "normalize: simplify to_utc",
  },
} as unknown as Hunt;

describe("the request", () => {
  it("posts one chat completion to Token Factory with the NVIDIA model and generous room", async () => {
    const net = capture(() => completion("It stamps UTC on naive input."));
    await narrate(TF, "prompt text", net.impl);

    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]?.url).toBe("https://api.tokenfactory.nebius.com/v1/chat/completions");
    const headers = new Headers(net.calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer tf-key-for-tests");
    const body = JSON.parse(String(net.calls[0]?.init?.body));
    expect(body.model).toBe("nvidia/nemotron-3-super-120b-a12b");
    // A reasoning model given 40 tokens spent all 40 thinking (2026-10-13). Never again.
    expect(body.max_tokens).toBe(NARRATION_MAX_TOKENS);
    expect(body.max_tokens).toBeGreaterThanOrEqual(2048);
    expect(body.reasoning_effort).toBe("low");
    expect(body.messages.at(-1)).toEqual({ role: "user", content: "prompt text" });
  });
});

describe("the answer", () => {
  it("returns the content as one paragraph, with the request id for provenance", async () => {
    const net = capture(() => completion("\n\nFirst part.\n\nSecond part."));
    const outcome = await narrate(TF, "p", net.impl);
    expect(outcome.rootCauseMd).toBe("First part. Second part.");
    expect(outcome.requestId).toBe("chatcmpl-test");
    expect(outcome.error).toBeNull();
    expect(outcome.usage.reasoningTokens).toBe(12);
  });

  it("reports an empty answer as an error — it never fakes a paragraph", async () => {
    const net = capture(() => completion(""));
    const outcome = await narrate(TF, "p", net.impl);
    expect(outcome.rootCauseMd).toBeNull();
    expect(outcome.error).toMatch(/returned no answer \(finish_reason length, 12 reasoning tokens\)/);
  });

  it("treats a think-only answer as empty", async () => {
    const net = capture(() => completion("<think>hmm</think>"));
    const outcome = await narrate(TF, "p", net.impl);
    expect(outcome.rootCauseMd).toBeNull();
    expect(outcome.error).toMatch(/no answer/);
  });

  it("returns the HTTP status as the error on a rejected call", async () => {
    const net = capture(() => new Response("rate limited", { status: 429 }));
    const outcome = await narrate(TF, "p", net.impl);
    expect(outcome.error).toBe("Token Factory returned 429: rate limited");
  });

  it("returns a network failure as an error rather than throwing", async () => {
    const impl: typeof fetch = async () => {
      throw new Error("ECONNRESET");
    };
    const outcome = await narrate(TF, "p", impl);
    expect(outcome.error).toMatch(/ECONNRESET/);
  });

  it("returns a non-JSON body as an error", async () => {
    const net = capture(() => new Response("<html>", { status: 200 }));
    expect((await narrate(TF, "p", net.impl)).error).toMatch(/not JSON/);
  });
});

describe("the prompt", () => {
  it("carries the repo, the test, the culprit, the diff and the failure, and asks for one paragraph", () => {
    const prompt = buildPrompt(HUNT, "-a\n+b", "E   AssertionError");
    expect(prompt).toContain(HUNT.repoUrl);
    expect(prompt).toContain(HUNT.testCommand);
    expect(prompt).toContain("406f7fce5a137398a0c2a739c087bfc9f54ab3cb");
    expect(prompt).toContain("```diff\n-a\n+b\n```");
    expect(prompt).toContain("E   AssertionError");
    expect(prompt).toMatch(/ONE paragraph, at most 120 words/);
  });

  it("says so when no failure output was captured", () => {
    expect(buildPrompt(HUNT, "", "")).toContain("(no output captured)");
  });
});

describe("toParagraph", () => {
  it("joins paragraphs and normalises unusual spaces", () => {
    expect(toParagraph("a\n\n b  c")).toBe("a b c");
  });
});

describe("loadTokenFactoryConfig", () => {
  it("is null without a key, and defaults the endpoint and the NVIDIA model", () => {
    expect(loadTokenFactoryConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(loadTokenFactoryConfig({ TOKENFACTORY_API_KEY: " k " } as unknown as NodeJS.ProcessEnv)).toEqual({
      apiKey: "k",
      baseUrl: "https://api.tokenfactory.nebius.com/v1",
      model: "nvidia/nemotron-3-super-120b-a12b",
    });
  });
});
