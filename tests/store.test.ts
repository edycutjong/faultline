/**
 * The coordination layer: compare-and-swap, verdict validity, the live-hunt lock and the
 * daily counter — run against the in-memory bucket, which has the same 412 semantics the
 * real one was measured to have (evidence/g5-conditional-writes.json).
 */

import { describe, it, expect } from "vitest";
import {
  MemoryKv,
  acquireLiveLock,
  dailyCap,
  incrementDailyCount,
  parseVerdict,
  readDailyCount,
  readLiveLock,
  releaseLiveLock,
  replaceHunt,
  LIVE_LOCK_TTL_MS,
  type StoreContext,
} from "@/lib/store";
import type { Hunt } from "@/lib/types";
import { must } from "./helpers";

function ctx(kv = new MemoryKv(), now = new Date("2026-10-13T10:00:00Z")): StoreContext {
  return { kv, config: null, backend: null, tokenFactory: null, fetchImpl: fetch, now: () => now };
}

describe("MemoryKv", () => {
  it("lets exactly one concurrent create win", async () => {
    const kv = new MemoryKv();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => kv.put("k", String(i), { ifNoneMatch: "*" })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("refuses a stale ETag and accepts a fresh one", async () => {
    const kv = new MemoryKv();
    const first = await kv.put("k", "1");
    if (!first.ok) throw new Error("expected ok");
    expect((await kv.put("k", "2", { ifMatch: must(first.etag) })).ok).toBe(true);
    expect((await kv.put("k", "3", { ifMatch: must(first.etag) })).ok).toBe(false);
    expect((await kv.get("k"))?.value).toBe("2");
  });
});

describe("replaceHunt", () => {
  it("refuses to overwrite blind when the backend returned no ETag", async () => {
    await expect(replaceHunt(ctx(), { id: "h" } as Hunt, null)).rejects.toThrow(/refusing an unconditional overwrite/);
  });
});

describe("parseVerdict", () => {
  const doc = {
    schema: "faultline.probe.v2",
    huntId: "h1",
    probeKey: "r1-i7-abc-a1",
    commitSha: "abc",
    verdict: "fail",
    exitCode: 1,
    durationMs: 4800,
    installCommand: null,
    timings: {},
    detail: null,
    tail: null,
  };

  it("accepts the complete document for this exact probe", () => {
    expect(parseVerdict(JSON.stringify(doc), "h1", "r1-i7-abc-a1", "abc").kind).toBe("valid");
  });

  it.each([
    ["a torn document", '{"schema":"faultline.probe.v2","verd'],
    ["an old schema", JSON.stringify({ ...doc, schema: "faultline.probe.v1" })],
    ["another probe's verdict", JSON.stringify({ ...doc, probeKey: "r1-i8-def-a1" })],
    ["another commit's verdict", JSON.stringify({ ...doc, commitSha: "def" })],
    ["no verdict value", JSON.stringify({ ...doc, verdict: "maybe" })],
    ["no duration", JSON.stringify({ ...doc, durationMs: undefined })],
  ])("treats %s as no verdict at all", (_label, text) => {
    expect(parseVerdict(text, "h1", "r1-i7-abc-a1", "abc").kind).toBe("invalid");
  });
});

describe("the live-hunt lock", () => {
  it("is held by the first hunt and refused to the second, naming the holder", async () => {
    const c = ctx();
    expect(await acquireLiveLock(c, "first", async () => false)).toEqual({ acquired: true });
    expect(await acquireLiveLock(c, "second", async () => false)).toEqual({ acquired: false, holder: "first" });
  });

  it("is taken over once the holder has finished", async () => {
    const c = ctx();
    await acquireLiveLock(c, "first", async () => false);
    expect(await acquireLiveLock(c, "second", async (holder) => holder === "first")).toEqual({ acquired: true });
    expect((await readLiveLock(c))?.huntId).toBe("second");
  });

  it("is taken over once it has expired, even if the holder never said so", async () => {
    const kv = new MemoryKv();
    await acquireLiveLock(ctx(kv), "first", async () => false);
    const later = ctx(kv, new Date(Date.parse("2026-10-13T10:00:00Z") + LIVE_LOCK_TTL_MS + 1));
    expect(await acquireLiveLock(later, "second", async () => false)).toEqual({ acquired: true });
  });

  it("is released only by its holder", async () => {
    const c = ctx();
    await acquireLiveLock(c, "first", async () => false);
    await releaseLiveLock(c, "someone-else");
    expect((await readLiveLock(c))?.released).toBe(false);
    await releaseLiveLock(c, "first");
    expect((await readLiveLock(c))?.released).toBe(true);
    expect(await acquireLiveLock(c, "second", async () => false)).toEqual({ acquired: true });
  });
});

describe("the daily counter", () => {
  it("counts concurrent increments exactly once each", async () => {
    const c = ctx();
    await Promise.all(Array.from({ length: 5 }, () => incrementDailyCount(c)));
    expect(await readDailyCount(c)).toEqual({ day: "2026-10-13", count: 5 });
  });

  it("starts from zero on a new day", async () => {
    const kv = new MemoryKv();
    await incrementDailyCount(ctx(kv));
    expect((await readDailyCount(ctx(kv, new Date("2026-10-14T00:00:01Z")))).count).toBe(0);
  });

  it("keeps a floor of one live hunt a day whatever the override says", () => {
    expect(dailyCap({} as NodeJS.ProcessEnv)).toBe(10);
    expect(dailyCap({ FAULTLINE_DAILY_CAP: "3" } as unknown as NodeJS.ProcessEnv)).toBe(3);
    expect(dailyCap({ FAULTLINE_DAILY_CAP: "0" } as unknown as NodeJS.ProcessEnv)).toBe(10);
  });
});
