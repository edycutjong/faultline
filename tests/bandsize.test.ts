import { describe, it, expect } from "vitest";

import { huntBandSize, newHunt } from "@/lib/hunt";
import { DEFAULT_BAND_SIZE, estimateRounds, planBand } from "@/lib/planner";
import type { Commit, Hunt } from "@/lib/types";

function commits(n: number): Commit[] {
  return Array.from({ length: n }, (_, i) => ({
    sha: `c${String(i + 1).padStart(39, "0")}`,
    index: i + 1,
    subject: `change ${i + 1}`,
    author: "Dana",
    date: "2026-08-01T00:00:00Z",
  }));
}

/**
 * `bandSize` exists so the sequential baseline can be MEASURED rather than derived: a hunt at
 * band 1 is `git bisect` on the same infrastructure. That makes it load-bearing for the only
 * performance claim this project will publish, so it gets its own tests.
 */
describe("hunt band size", () => {
  it("defaults to DEFAULT_BAND_SIZE when the caller does not ask", () => {
    expect(newHunt({
      repoUrl: "https://github.com/a/b", testCommand: "pytest", goodRef: "v1",
      badRef: "HEAD", commits: commits(64),
    }).bandSize).toBe(DEFAULT_BAND_SIZE);
  });

  it("carries an explicit band size through creation", () => {
    expect(newHunt({
      repoUrl: "https://github.com/a/b", testCommand: "pytest", goodRef: "v1",
      badRef: "HEAD", commits: commits(64), bandSize: 1,
    }).bandSize).toBe(1);
  });

  /**
   * The regression this guard exists for: a hunt written to Object Storage before `bandSize`
   * existed reads back without the field. Passing `undefined` to planBand yields an empty
   * band, dispatchBand sends nothing, and the hunt stalls forever without erroring — the
   * worst possible failure, because it looks like a slow hunt rather than a broken one.
   */
  it("falls back to the default for hunts stored before the field existed", () => {
    // Omit<> rather than an intersection: `Hunt & { bandSize?: number }` still has bandSize
    // required, so `delete` on it is a type error.
    const legacy: Omit<Hunt, "bandSize"> & { bandSize?: number } = newHunt({
      repoUrl: "https://github.com/a/b", testCommand: "pytest", goodRef: "v1",
      badRef: "HEAD", commits: commits(64),
    });
    delete legacy.bandSize;

    expect(huntBandSize(legacy as Hunt)).toBe(DEFAULT_BAND_SIZE);
    expect(planBand(0, 64, huntBandSize(legacy as Hunt)).length).toBeGreaterThan(0);
  });

  it.each([0, -1, 1.5, NaN])("rejects %p and falls back rather than planning an empty band", (bad) => {
    const hunt = { ...newHunt({
      repoUrl: "https://github.com/a/b", testCommand: "pytest", goodRef: "v1",
      badRef: "HEAD", commits: commits(64),
    }), bandSize: bad as number };
    expect(huntBandSize(hunt)).toBe(DEFAULT_BAND_SIZE);
  });

  /**
   * The headline, as arithmetic: eight probes cut a range into nine segments, so a 256-commit
   * range needs three rounds where one probe at a time needs eight. If this ever changes, the
   * README, the hero animation and the benchmark are all wrong together.
   */
  it("reproduces the published round counts for a 256-commit range", () => {
    expect(estimateRounds(256, 8)).toBe(3);
    expect(estimateRounds(256, 1)).toBe(8);
  });

  it("plans exactly one probe per round at band 1, which is what git bisect does", () => {
    expect(planBand(0, 256, 1)).toHaveLength(1);
    expect(planBand(0, 256, 8)).toHaveLength(8);
  });
});
