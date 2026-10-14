import { describe, it, expect, vi, afterEach } from "vitest";
import { buildPrompt, narrate, toParagraph } from "@/lib/narrate";
import type { Hunt } from "@/lib/types";

const TF = { apiKey: "k", baseUrl: "https://x.test/v1", model: "m-default" };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("narrate branch coverage", () => {
  it("uses the global fetch by default", async () => {
    const f = vi.fn(async () => json({ choices: [{ message: { content: "ok" } }] }));
    vi.stubGlobal("fetch", f);
    const out = await narrate(TF, "p");
    expect(f).toHaveBeenCalledOnce();
    expect(out.rootCauseMd).toBe("ok");
  });

  it("falls back to null id/usage and configured model when the body is sparse", async () => {
    const out = await narrate(TF, "p", async () => json({ choices: [{ message: { content: "ok" } }] }));
    expect(out).toMatchObject({
      rootCauseMd: "ok",
      requestId: null,
      model: "m-default",
      error: null,
      usage: { promptTokens: null, completionTokens: null, reasoningTokens: null },
    });
  });

  it("treats null completion_tokens_details as no reasoning tokens", async () => {
    const out = await narrate(TF, "p", async () =>
      json({ id: "r1", model: "m-actual", choices: [{ message: { content: "x" } }], usage: { completion_tokens_details: null } }),
    );
    expect(out.model).toBe("m-actual");
    expect(out.requestId).toBe("r1");
    expect(out.usage.reasoningTokens).toBeNull();
  });

  it("reports non-Error rejections as strings", async () => {
    const out = await narrate(TF, "p", async () => {
      throw "boom";
    });
    expect(out.error).toBe("Token Factory request failed: boom");
  });

  it("reports Error rejections by message", async () => {
    const out = await narrate(TF, "p", async () => {
      throw new Error("down");
    });
    expect(out.error).toBe("Token Factory request failed: down");
    expect(out.retryable).toBe(true);
  });

  it("includes a truncated body for HTTP errors", async () => {
    const out = await narrate(TF, "p", async () => new Response("x".repeat(500), { status: 500 }));
    expect(out.error).toBe(`Token Factory returned 500: ${"x".repeat(200)}`);
    expect(out.retryable).toBe(true);
  });

  it("omits the body suffix when it is empty or unreadable", async () => {
    const empty = await narrate(TF, "p", async () => new Response("", { status: 502 }));
    expect(empty.error).toBe("Token Factory returned 502");
    const bad = { ok: false, status: 503, text: () => Promise.reject(new Error("x")) } as unknown as Response;
    const unreadable = await narrate(TF, "p", async () => bad);
    expect(unreadable.error).toBe("Token Factory returned 503");
  });

  it("marks 429 retryable and any other 4xx not (a2a r06)", async () => {
    expect((await narrate(TF, "p", async () => new Response("slow down", { status: 429 }))).retryable).toBe(true);
    expect((await narrate(TF, "p", async () => new Response("bad", { status: 400 }))).retryable).toBe(false);
    expect((await narrate(TF, "p", async () => new Response("no", { status: 401 }))).retryable).toBe(false);
  });

  it("reports non-JSON 200 responses", async () => {
    const out = await narrate(TF, "p", async () => new Response("<html>", { status: 200 }));
    expect(out.error).toBe("Token Factory returned a response that is not JSON.");
    expect(out.retryable).toBe(true);
  });

  it("reports an empty answer with unknown finish_reason and no reasoning count", async () => {
    const out = await narrate(TF, "p", async () => json({}));
    expect(out.rootCauseMd).toBeNull();
    expect(out.requestId).toBeNull();
    expect(out.error).toBe("The model returned no answer (finish_reason unknown).");
    expect(out.retryable).toBe(false);
  });

  it("reports an empty answer with finish_reason, id and reasoning tokens", async () => {
    const out = await narrate(TF, "p", async () =>
      json({
        id: "r2",
        choices: [{ finish_reason: "length", message: { content: "<think>hmm</think>" } }],
        usage: { completion_tokens_details: { reasoning_tokens: 7 } },
      }),
    );
    expect(out.requestId).toBe("r2");
    expect(out.usage.reasoningTokens).toBe(7);
    expect(out.error).toBe("The model returned no answer (finish_reason length, 7 reasoning tokens).");
  });
});

describe("toParagraph / buildPrompt edges", () => {
  it("strips think blocks, nbsp and joins paragraphs", () => {
    expect(toParagraph("<think>a</think>One two\n\nThree\n  four")).toBe("One two Three four");
  });

  it("builds a prompt without a report", () => {
    const p = buildPrompt({ repoUrl: "r", testCommand: "t" } as unknown as Hunt, "D", "");
    expect(p).toContain("Guilty commit: unknown — ");
    expect(p).toContain("(no output captured)");
  });

  it("builds a prompt with a report", () => {
    const hunt = { repoUrl: "r", testCommand: "t", report: { culpritSha: "abc", culpritSubject: "s" } } as unknown as Hunt;
    expect(buildPrompt(hunt, "D", "FAIL")).toContain("Guilty commit: abc — s");
  });
});
