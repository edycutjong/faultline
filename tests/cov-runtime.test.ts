import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { bypassCodeMatches, publicBaseUrl, resetTickThrottle, tickDue } from "@/lib/runtime";

const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;
const req = new Request("https://preview.faultline.example/api/x?y=1");

describe("publicBaseUrl branches", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("falls back to the request origin and uses process.env by default", () => {
    vi.stubEnv("FAULTLINE_PUBLIC_URL", "");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
    expect(publicBaseUrl(req)).toBe("https://preview.faultline.example");
  });

  it("reads the explicit URL from process.env by default", () => {
    vi.stubEnv("FAULTLINE_PUBLIC_URL", " https://faultline.example// ");
    expect(publicBaseUrl(req)).toBe("https://faultline.example");
  });

  it("ignores production URL outside production", () => {
    expect(publicBaseUrl(req, env({ VERCEL_ENV: "preview", VERCEL_PROJECT_PRODUCTION_URL: "p.example" }))).toBe(
      "https://preview.faultline.example",
    );
  });

  it("ignores production env when no production URL is set", () => {
    expect(publicBaseUrl(req, env({ VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "  " }))).toBe(
      "https://preview.faultline.example",
    );
  });
});

describe("tickDue", () => {
  beforeEach(() => resetTickThrottle());
  afterEach(() => vi.useRealTimers());

  it("defaults now to Date.now and throttles within the window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    expect(tickDue("h")).toBe(true);
    expect(tickDue("h")).toBe(false);
    vi.setSystemTime(11_600);
    expect(tickDue("h")).toBe(true);
  });

  it("prunes stale entries once the map exceeds 500", () => {
    for (let i = 0; i < 500; i++) tickDue(`old-${i}`, 1500, 1000);
    // 501st entry, far later: triggers prune; stale ones deleted, fresh one kept
    expect(tickDue("fresh", 1500, 100_000)).toBe(true);
    expect(tickDue("fresh", 1500, 100_001)).toBe(false);
    // pruned entry is due again even within its original window
    expect(tickDue("old-0", 1500, 100_002)).toBe(true);
  });

  it("keeps recent entries during a prune", () => {
    for (let i = 0; i < 500; i++) tickDue(`r-${i}`, 1500, 90_000);
    expect(tickDue("x", 1500, 100_000)).toBe(true);
    expect(tickDue("r-0", 20_000, 100_001)).toBe(false);
  });
});

describe("bypassCodeMatches", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses process.env by default", () => {
    vi.stubEnv("FAULTLINE_BYPASS_CODE", "sekret");
    expect(bypassCodeMatches(" sekret ")).toBe(true);
    expect(bypassCodeMatches("wrong!")).toBe(false);
  });

  it("rejects when unset, non-string, blank, or different length", () => {
    expect(bypassCodeMatches("a", env({}))).toBe(false);
    expect(bypassCodeMatches(123, env({ FAULTLINE_BYPASS_CODE: "abc" }))).toBe(false);
    expect(bypassCodeMatches("   ", env({ FAULTLINE_BYPASS_CODE: "abc" }))).toBe(false);
    expect(bypassCodeMatches("abcd", env({ FAULTLINE_BYPASS_CODE: "abc" }))).toBe(false);
  });
});
