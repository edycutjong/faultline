import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ afterCb: [] as Array<() => Promise<void>>, tick: vi.fn(), ctx: { ctx: true } }));

vi.mock("next/server", () => ({ after: (cb: () => Promise<void>) => { h.afterCb.push(cb); } }));
vi.mock("@/lib/hunt", async (orig) => ({ ...(await orig<typeof import("@/lib/hunt")>()), tick: h.tick }));
vi.mock("@/lib/store", () => ({ storeContext: () => h.ctx }));

import { retickAfterBackoff, retickDelayMs } from "@/lib/retick";
import { newHunt } from "@/lib/hunt";
import type { Hunt } from "@/lib/types";
import { probe, shaFor, syntheticCommits } from "./helpers";

const NOW = "2026-10-13T16:00:00Z";

function running(notBefore: string | null, tickUrl?: string): Hunt {
  const base = newHunt({
    repoUrl: "https://github.com/a/b", testCommand: "pytest", goodRef: "v1", goodSha: shaFor(0),
    badRef: "HEAD", commits: syntheticCommits(16), slots: 2, backend: "fake", regions: ["eu-west1"],
  });
  return { ...base, tickUrl: tickUrl ?? null, status: "running", round: 1, probes: [probe(8, null, { phase: "queued", jobId: null, notBefore })] };
}

/** Schedule, run the captured after() callback through its sleep, and return when it settles. */
async function runAfter(hunt: Hunt | null): Promise<void> {
  retickAfterBackoff(hunt);
  const cb = h.afterCb.shift();
  if (!cb) return;
  const p = cb();
  await vi.advanceTimersByTimeAsync(60_000);
  await p;
}

describe("retickAfterBackoff", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    h.afterCb.length = 0;
    h.tick.mockReset().mockResolvedValue(undefined);
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("uses the current time by default", () => {
    expect(retickDelayMs(running("2026-10-13T16:00:05Z"))).toBe(6_000);
  });

  it("schedules nothing for a null hunt or one with no backoff", () => {
    retickAfterBackoff(null);
    retickAfterBackoff(running(null));
    expect(h.afterCb).toHaveLength(0);
  });

  it("sleeps the backoff, then POSTs the tick URL and stops on success", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const hunt = running("2026-10-13T16:00:10Z", "https://x.test/tick");
    retickAfterBackoff(hunt);
    const cb = h.afterCb.shift();
    if (!cb) throw new Error("no after callback");
    const p = cb();
    await vi.advanceTimersByTimeAsync(10_999);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://x.test/tick");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(h.tick).not.toHaveBeenCalled();
  });

  it("treats 404 as the hunt being gone and does not tick", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    await runAfter(running("2026-10-13T16:00:01Z", "https://x.test/tick"));
    expect(h.tick).not.toHaveBeenCalled();
  });

  it("ticks locally when the tick URL answers 5xx", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    const hunt = running("2026-10-13T16:00:01Z", "https://x.test/tick");
    await runAfter(hunt);
    expect(h.tick).toHaveBeenCalledWith(h.ctx, hunt.id);
  });

  it("ticks locally when the request fails outright", async () => {
    fetchMock.mockRejectedValue(new Error("net"));
    const hunt = running("2026-10-13T16:00:01Z", "https://x.test/tick");
    await runAfter(hunt);
    expect(h.tick).toHaveBeenCalledWith(h.ctx, hunt.id);
  });

  it("ticks locally without fetching when the hunt has no tick URL, swallowing tick errors", async () => {
    h.tick.mockRejectedValue(new Error("boom"));
    const hunt = running("2026-10-13T16:00:01Z");
    await expect(runAfter(hunt)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.tick).toHaveBeenCalledWith(h.ctx, hunt.id);
  });
});
