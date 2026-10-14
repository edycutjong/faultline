/**
 * Branch coverage for recentProbeJobs: sparse job shapes, defaults, cache and timeout paths.
 * listJobs is mocked so arbitrary (partial) job records can be fed in without HTTP.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { NebiusConfig } from "@/lib/nebius/config";

const listJobs = vi.fn();
vi.mock("@/lib/nebius/jobs", () => ({ listJobs: (...args: unknown[]) => listJobs(...args) }));

import { clearRecentJobsCache, recentProbeJobs } from "@/lib/nebius/recent-jobs";

function cfg(...projects: Array<[string, string]>): NebiusConfig {
  return { probeRegions: projects.map(([region, projectId]) => ({ region, projectId })) } as unknown as NebiusConfig;
}

beforeEach(() => {
  listJobs.mockReset();
  clearRecentJobsCache();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("recentProbeJobs sparse data", () => {
  it("fills defaults for missing status/createdAt/finishedAt and skips jobs without a probe name", async () => {
    listJobs.mockResolvedValue([
      { metadata: { id: "a", name: "faultline-x" } },
      { metadata: { id: "b", name: "other-job", createdAt: "2026-10-13T12:00:00Z" } },
      { metadata: { id: "c" } },
      {},
      { metadata: { id: "d", name: "faultline-y", createdAt: "garbage" }, status: { state: "RUNNING", finishedAt: "2026-10-13T13:00:00Z" } },
    ]);
    const res = await recentProbeJobs(cfg(["eu-west1", "p1"]), { now: () => Date.parse("2026-10-14T00:00:00Z") });
    expect(res.unavailable).toEqual([]);
    expect(res.readAt).toBe("2026-10-14T00:00:00.000Z");
    expect(res.jobs).toEqual([
      { id: "a", name: "faultline-x", region: "eu-west1", state: "STATE_UNSPECIFIED", createdAt: null, finishedAt: null },
      { id: "d", name: "faultline-y", region: "eu-west1", state: "RUNNING", createdAt: "garbage", finishedAt: "2026-10-13T13:00:00Z" },
    ]);
  });

  it("sorts newest first, treating missing/invalid dates as oldest, and honours limit", async () => {
    listJobs.mockResolvedValue([
      { metadata: { id: "none", name: "faultline-n" } },
      { metadata: { id: "old", name: "faultline-o", createdAt: "2026-10-13T10:00:00Z" } },
      { metadata: { id: "new", name: "faultline-w", createdAt: "2026-10-13T11:00:00Z" } },
    ]);
    const res = await recentProbeJobs(cfg(["r", "p"]), { limit: 2 });
    expect(res.jobs.map((j) => j.id)).toEqual(["new", "old"]);
  });
});

describe("recentProbeJobs defaults, cache and failure", () => {
  it("uses the default limit, Date.now and global fetch, then serves the cache within a minute", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const many = Array.from({ length: 10 }, (_, i) => ({
        metadata: { id: `j${i}`, name: "faultline-z", createdAt: `2026-10-13T10:0${i}:00Z` },
      }));
      listJobs.mockResolvedValue(many);
      const config = cfg(["r", "p"]);
      const first = await recentProbeJobs(config);
      expect(first.jobs).toHaveLength(8);
      expect(listJobs).toHaveBeenCalledWith(config, "p", fetchSpy);
      const second = await recentProbeJobs(config);
      expect(second).toBe(first);
      expect(listJobs).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("re-reads when the cache key differs or the cache has expired", async () => {
    listJobs.mockResolvedValue([]);
    let t = 1_000;
    const now = () => t;
    await recentProbeJobs(cfg(["r", "p"]), { now });
    await recentProbeJobs(cfg(["r", "p"]), { now, limit: 3 }); // different key
    expect(listJobs).toHaveBeenCalledTimes(2);
    t += 60_000; // expired
    await recentProbeJobs(cfg(["r", "p"]), { now, limit: 3 });
    expect(listJobs).toHaveBeenCalledTimes(3);
  });

  it("lists failed regions as unavailable, keeps partial results cached, and does not cache a total failure", async () => {
    listJobs.mockImplementation(async (_c: unknown, project: string) => {
      if (project === "bad") throw new Error("503");
      return [{ metadata: { id: "ok", name: "faultline-ok", createdAt: "2026-10-13T10:00:00Z" } }];
    });
    const partial = await recentProbeJobs(cfg(["good", "p"], ["down", "bad"]));
    expect(partial.unavailable).toEqual(["down"]);
    expect(partial.jobs.map((j) => j.id)).toEqual(["ok"]);
    expect(await recentProbeJobs(cfg(["good", "p"], ["down", "bad"]))).toBe(partial);

    clearRecentJobsCache();
    listJobs.mockReset();
    listJobs.mockRejectedValue(new Error("down"));
    const none = await recentProbeJobs(cfg(["a", "p1"], ["b", "p2"]));
    expect(none.unavailable).toEqual(["a", "b"]);
    expect(none.jobs).toEqual([]);
    await recentProbeJobs(cfg(["a", "p1"], ["b", "p2"]));
    expect(listJobs).toHaveBeenCalledTimes(4);
  });

  it("times out a hanging region with the default timeout and clears the timer when one answers", async () => {
    vi.useFakeTimers();
    listJobs.mockImplementation((_c: unknown, project: string) =>
      project === "hang" ? new Promise(() => {}) : Promise.resolve([]),
    );
    const pending = recentProbeJobs(cfg(["fast", "p"], ["slow", "hang"]));
    await vi.advanceTimersByTimeAsync(4_000);
    const res = await pending;
    expect(res.unavailable).toEqual(["slow"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honours a custom timeoutMs", async () => {
    vi.useFakeTimers();
    listJobs.mockReturnValue(new Promise(() => {}));
    const pending = recentProbeJobs(cfg(["slow", "p"]), { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    expect((await pending).unavailable).toEqual(["slow"]);
  });
});
