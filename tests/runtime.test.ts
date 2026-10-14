import { describe, it, expect, beforeEach } from "vitest";
import { bypassCodeMatches, publicBaseUrl, resetTickThrottle, tickDue } from "@/lib/runtime";

describe("publicBaseUrl", () => {
  const request = new Request("https://preview-abc123.faultline.example/api/hunts");

  it("prefers an explicit public URL", () => {
    expect(publicBaseUrl(request, { FAULTLINE_PUBLIC_URL: "https://faultline.example/" } as unknown as NodeJS.ProcessEnv)).toBe(
      "https://faultline.example",
    );
  });

  it("uses the stable production domain in production, never the per-deployment URL", () => {
    expect(
      publicBaseUrl(request, {
        VERCEL_ENV: "production",
        VERCEL_PROJECT_PRODUCTION_URL: "faultline.edycu.dev",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe("https://faultline.edycu.dev");
  });

  it("falls back to the request origin elsewhere", () => {
    expect(publicBaseUrl(request, {} as NodeJS.ProcessEnv)).toBe("https://preview-abc123.faultline.example");
  });
});

describe("tickDue", () => {
  beforeEach(() => resetTickThrottle());

  it("runs one tick per hunt per window", () => {
    expect(tickDue("h", 1500, 1_000)).toBe(true);
    expect(tickDue("h", 1500, 2_000)).toBe(false);
    expect(tickDue("other", 1500, 2_000)).toBe(true);
    expect(tickDue("h", 1500, 2_600)).toBe(true);
  });
});

describe("bypassCodeMatches", () => {
  const env = { FAULTLINE_BYPASS_CODE: "judge-code-123" } as unknown as NodeJS.ProcessEnv;

  it("matches only the configured code", () => {
    expect(bypassCodeMatches("judge-code-123", env)).toBe(true);
    expect(bypassCodeMatches(" judge-code-123 ", env)).toBe(true);
    expect(bypassCodeMatches("judge-code-124", env)).toBe(false);
    expect(bypassCodeMatches("", env)).toBe(false);
    expect(bypassCodeMatches(undefined, env)).toBe(false);
  });

  it("never matches when no code is configured", () => {
    expect(bypassCodeMatches("anything", {} as NodeJS.ProcessEnv)).toBe(false);
  });
});
