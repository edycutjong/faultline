import { describe, it, expect } from "vitest";

import {
  DEFAULT_BAND_SIZE,
  culpritIndex,
  estimateRounds,
  isSettled,
  narrow,
  planBand,
  type ProbeOutcome,
} from "@/lib/planner";
import type { Verdict } from "@/lib/types";

/**
 * Oracle: commit `i` is bad iff `i >= culprit`. That is exactly the assumption bisection
 * rests on, so a search that cannot find a planted culprit under it is broken.
 */
function verdictFor(index: number, culprit: number): Verdict {
  return index >= culprit ? "fail" : "pass";
}

interface SimResult {
  rounds: number;
  found: number | null;
  /** Candidate count at the start of each round — the sequence the claim is about. */
  trail: number[];
}

function simulate(rangeSize: number, culprit: number, n: number): SimResult {
  let low = 0;
  let high = rangeSize;
  let rounds = 0;
  const trail: number[] = [];

  while (!isSettled(low, high)) {
    trail.push(high - low);
    const band = planBand(low, high, n);
    if (band.length === 0) throw new Error(`planner stalled at (${low}, ${high}) with n=${n}`);
    rounds += 1;
    const results: ProbeOutcome[] = band.map((index) => ({
      index,
      verdict: verdictFor(index, culprit),
    }));
    const next = narrow(low, high, results);
    if (next.highIndex - next.lowIndex >= high - low) {
      throw new Error(`no progress at (${low}, ${high})`);
    }
    low = next.lowIndex;
    high = next.highIndex;
    if (rounds > 200) throw new Error("runaway search");
  }

  trail.push(high - low);
  return { rounds, found: culpritIndex(low, high), trail };
}

/** Worst case over every possible culprit position — the number the product claims. */
function worstCaseRounds(rangeSize: number, n: number): number {
  let worst = 0;
  for (let culprit = 1; culprit <= rangeSize; culprit += 1) {
    const result = simulate(rangeSize, culprit, n);
    expect(result.found).toBe(culprit);
    worst = Math.max(worst, result.rounds);
  }
  return worst;
}

/** Largest range that can survive one round — the "256 -> 28, not 32" number. */
function worstRemainingAfterOneRound(rangeSize: number, n: number): number {
  const band = planBand(0, rangeSize, n);
  let largest = 0;
  let previous = 0;
  for (const index of band) {
    largest = Math.max(largest, index - previous);
    previous = index;
  }
  return Math.max(largest, rangeSize - previous);
}

describe("the N+1 divisor", () => {
  it("cuts a range into n+1 segments, not n and not 2", () => {
    // 8 probes make 9 segments: 256/9 = 28.4, not 256/8 = 32 and not 256/2 = 128.
    expect(worstRemainingAfterOneRound(256, 8)).toBe(29);
    expect(worstRemainingAfterOneRound(256, 8)).toBeLessThan(32);
    expect(worstRemainingAfterOneRound(64, 8)).toBe(8);
    expect(worstRemainingAfterOneRound(128, 8)).toBe(15);
    expect(worstRemainingAfterOneRound(1000, 8)).toBe(112);
  });

  it("places probes at k*C/(n+1)", () => {
    expect(planBand(0, 256, 8)).toEqual([28, 57, 85, 114, 142, 171, 199, 228]);
    expect(planBand(0, 9, 8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(planBand(0, 100, 4)).toEqual([20, 40, 60, 80]);
  });

  it("degrades to plain binary search at n=1", () => {
    expect(planBand(0, 256, 1)).toEqual([128]);
    expect(planBand(0, 101, 1)).toEqual([51]);
    expect(estimateRounds(256, 1)).toBe(8); // log2(256)
    expect(estimateRounds(64, 1)).toBe(6);
    expect(estimateRounds(128, 1)).toBe(7);
    expect(estimateRounds(1000, 1)).toBe(10); // ceil(log2(1000))
  });
});

describe("round counts (the headline claim)", () => {
  it("settles 64 commits in 2 rounds at n=8", () => {
    expect(estimateRounds(64, DEFAULT_BAND_SIZE)).toBe(2);
    expect(worstCaseRounds(64, DEFAULT_BAND_SIZE)).toBe(2);
  });

  it("settles 128 commits in 3 rounds at n=8", () => {
    expect(estimateRounds(128, DEFAULT_BAND_SIZE)).toBe(3);
    expect(worstCaseRounds(128, DEFAULT_BAND_SIZE)).toBe(3);
  });

  it("settles 256 commits in 3 rounds at n=8, via ~28 and ~3", () => {
    expect(estimateRounds(256, DEFAULT_BAND_SIZE)).toBe(3);
    expect(worstCaseRounds(256, DEFAULT_BAND_SIZE)).toBe(3);

    // Worked by hand for culprit 29: round 1 probes [28,57,85,...] so 28 passes and 57 is
    // the lowest fail, leaving (28,57] = 29 candidates. Round 2 probes [31,34,...,54], all
    // of which fail, leaving (28,31] = 3. Round 3 probes the two interior commits and
    // settles. A 256 -> 32 trail would mean the divisor was N instead of N+1.
    const worstPath = simulate(256, 29, DEFAULT_BAND_SIZE);
    expect(worstPath.trail).toEqual([256, 29, 3, 1]);
    expect(worstPath.trail[1]).not.toBe(32);
    expect(worstPath.found).toBe(29);
  });

  it("settles 1000 commits in 4 rounds at n=8", () => {
    expect(estimateRounds(1000, DEFAULT_BAND_SIZE)).toBe(4);
    expect(worstCaseRounds(1000, DEFAULT_BAND_SIZE)).toBe(4);
  });

  it("finds the culprit at either edge of the range", () => {
    const first = simulate(256, 1, DEFAULT_BAND_SIZE);
    expect(first.found).toBe(1);
    expect(first.rounds).toBeLessThanOrEqual(3);

    const last = simulate(256, 256, DEFAULT_BAND_SIZE);
    expect(last.found).toBe(256);
    expect(last.rounds).toBeLessThanOrEqual(3);
  });

  it("beats serial bisection by the ratio the pitch claims", () => {
    // 9x per round vs 2x per round: fewer than half the rounds at every interesting size.
    expect(estimateRounds(256, 8)).toBeLessThan(estimateRounds(256, 1) / 2);
    expect(estimateRounds(1000, 8)).toBeLessThan(estimateRounds(1000, 1) / 2);
  });
});

describe("estimateRounds", () => {
  it("is zero for a settled or empty range", () => {
    expect(estimateRounds(1, 8)).toBe(0);
    expect(estimateRounds(0, 8)).toBe(0);
    expect(estimateRounds(-5, 8)).toBe(0);
  });

  it("never disagrees with a real search", () => {
    for (const size of [2, 3, 7, 9, 10, 17, 33, 50, 81, 200, 512]) {
      for (const n of [1, 2, 4, 8]) {
        expect(worstCaseRounds(size, n)).toBe(estimateRounds(size, n));
      }
    }
  });

  it("is monotone in range size and non-increasing in band size", () => {
    expect(estimateRounds(1000, 8)).toBeGreaterThanOrEqual(estimateRounds(256, 8));
    expect(estimateRounds(1000, 8)).toBeLessThanOrEqual(estimateRounds(1000, 4));
    expect(estimateRounds(1000, 4)).toBeLessThanOrEqual(estimateRounds(1000, 2));
  });

  it("coerces a band below 1 to a single probe rather than reporting an impossible zero", () => {
    expect(estimateRounds(64, 0)).toBe(estimateRounds(64, 1));
    expect(estimateRounds(64, -3)).toBe(estimateRounds(64, 1));
  });
});

describe("planBand", () => {
  it("returns probes that are strictly interior, sorted and unique", () => {
    for (const size of [5, 12, 29, 64, 137, 256, 999]) {
      for (const n of [1, 2, 3, 8, 11]) {
        const band = planBand(4, 4 + size, n);
        expect(new Set(band).size).toBe(band.length);
        expect([...band].sort((a, b) => a - b)).toEqual(band);
        for (const index of band) {
          expect(index).toBeGreaterThan(4);
          expect(index).toBeLessThan(4 + size);
        }
      }
    }
  });

  it("uses the whole band when there is room for it", () => {
    expect(planBand(0, 256, 8)).toHaveLength(8);
    expect(planBand(10, 110, 8)).toHaveLength(8);
    expect(planBand(0, 10, 8)).toHaveLength(8); // one more interior commit than probes
  });

  it("spaces probes evenly (segments differ by at most one commit)", () => {
    for (const size of [37, 64, 100, 256, 1000]) {
      for (const n of [2, 5, 8]) {
        const band = planBand(0, size, n);
        const gaps: number[] = [];
        let previous = 0;
        for (const index of band) {
          gaps.push(index - previous);
          previous = index;
        }
        gaps.push(size - previous);
        expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("is offset-invariant", () => {
    const atZero = planBand(0, 100, 8);
    const shifted = planBand(500, 600, 8).map((index) => index - 500);
    expect(shifted).toEqual(atZero);
  });

  describe("degenerate inputs", () => {
    it("returns nothing once one candidate remains", () => {
      expect(planBand(0, 1, 8)).toEqual([]);
      expect(planBand(41, 42, 8)).toEqual([]);
    });

    it("returns nothing for an empty or inverted range", () => {
      expect(planBand(7, 7, 8)).toEqual([]);
      expect(planBand(9, 3, 8)).toEqual([]);
      expect(planBand(0, 0, 8)).toEqual([]);
    });

    it("needs exactly one probe when two candidates remain", () => {
      expect(planBand(0, 2, 8)).toEqual([1]);
      expect(planBand(0, 2, 1)).toEqual([1]);
      expect(planBand(30, 32, 4)).toEqual([31]);
    });

    it("tests every interior commit when the band outnumbers them", () => {
      expect(planBand(0, 5, 8)).toEqual([1, 2, 3, 4]);
      expect(planBand(0, 5, 100)).toEqual([1, 2, 3, 4]);
      expect(planBand(0, 4, 8)).toHaveLength(3);
    });

    it("returns nothing for a band of zero or fewer", () => {
      expect(planBand(0, 256, 0)).toEqual([]);
      expect(planBand(0, 256, -1)).toEqual([]);
      expect(planBand(0, 256, Number.NaN)).toEqual([]);
    });

    it("settles a 5-commit range in one round with a wide band", () => {
      const result = simulate(5, 3, 8);
      expect(result.rounds).toBe(1);
      expect(result.found).toBe(3);
    });
  });
});

describe("narrow", () => {
  it("raises the floor to the highest pass and drops the ceiling to the lowest fail", () => {
    const bounds = narrow(0, 100, [
      { index: 20, verdict: "pass" },
      { index: 40, verdict: "pass" },
      { index: 60, verdict: "fail" },
      { index: 80, verdict: "fail" },
    ]);
    expect(bounds).toEqual({ lowIndex: 40, highIndex: 60 });
  });

  it("keeps the old bound when nothing passed", () => {
    const bounds = narrow(5, 100, [
      { index: 20, verdict: "fail" },
      { index: 40, verdict: "fail" },
    ]);
    expect(bounds).toEqual({ lowIndex: 5, highIndex: 20 });
  });

  it("keeps the old bound when nothing failed", () => {
    const bounds = narrow(5, 100, [
      { index: 20, verdict: "pass" },
      { index: 40, verdict: "pass" },
    ]);
    expect(bounds).toEqual({ lowIndex: 40, highIndex: 100 });
  });

  it("ignores error verdicts without crashing or losing the rest", () => {
    const bounds = narrow(0, 100, [
      { index: 20, verdict: "pass" },
      { index: 40, verdict: "error" },
      { index: 60, verdict: "error" },
      { index: 80, verdict: "fail" },
    ]);
    expect(bounds).toEqual({ lowIndex: 20, highIndex: 80 });
  });

  it("returns the range untouched when every probe errored", () => {
    const bounds = narrow(3, 90, [
      { index: 30, verdict: "error" },
      { index: 60, verdict: "error" },
    ]);
    expect(bounds).toEqual({ lowIndex: 3, highIndex: 90 });
  });

  it("returns the range untouched for no results at all", () => {
    expect(narrow(3, 90, [])).toEqual({ lowIndex: 3, highIndex: 90 });
  });

  it("only ever tightens, never widens", () => {
    const bounds = narrow(50, 60, [
      { index: 10, verdict: "pass" }, // stale, below the floor
      { index: 90, verdict: "fail" }, // stale, above the ceiling
    ]);
    expect(bounds).toEqual({ lowIndex: 50, highIndex: 60 });
  });

  it("settles directly when a single probe splits two candidates", () => {
    const bounds = narrow(0, 2, [{ index: 1, verdict: "fail" }]);
    expect(isSettled(bounds.lowIndex, bounds.highIndex)).toBe(true);
    expect(culpritIndex(bounds.lowIndex, bounds.highIndex)).toBe(1);

    const other = narrow(0, 2, [{ index: 1, verdict: "pass" }]);
    expect(culpritIndex(other.lowIndex, other.highIndex)).toBe(2);
  });

  it("survives a mixed round where only some probes reported", () => {
    const bounds = narrow(0, 64, [
      { index: 7, verdict: "error" },
      { index: 14, verdict: "pass" },
      { index: 21, verdict: "error" },
      { index: 28, verdict: "error" },
      { index: 35, verdict: "fail" },
      { index: 42, verdict: "fail" },
    ]);
    expect(bounds).toEqual({ lowIndex: 14, highIndex: 35 });
  });
});

describe("isSettled / culpritIndex", () => {
  it("is settled only at exactly one remaining candidate", () => {
    expect(isSettled(0, 1)).toBe(true);
    expect(isSettled(41, 42)).toBe(true);
    expect(isSettled(0, 2)).toBe(false);
    expect(isSettled(0, 0)).toBe(false);
    expect(isSettled(5, 3)).toBe(false);
  });

  it("names the culprit only when settled", () => {
    expect(culpritIndex(41, 42)).toBe(42);
    expect(culpritIndex(0, 1)).toBe(1);
    expect(culpritIndex(0, 9)).toBeNull();
    expect(culpritIndex(9, 9)).toBeNull();
  });
});

describe("property: the search always finds the planted culprit", () => {
  it("holds over randomised ranges, culprits and band sizes", () => {
    // Deterministic LCG: a failure here must be reproducible, not a coin flip in CI.
    let seed = 0x5eed1234;
    const next = (bound: number): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed % bound) + 1;
    };

    for (let trial = 0; trial < 400; trial += 1) {
      const rangeSize = next(500) + 1; // 2..501
      const culprit = next(rangeSize); // 1..rangeSize
      const n = next(12); // 1..12
      const budget = estimateRounds(rangeSize, n);

      const result = simulate(rangeSize, culprit, n);
      expect(result.found).toBe(culprit);
      expect(result.rounds).toBeLessThanOrEqual(budget);
      expect(result.rounds).toBeGreaterThanOrEqual(1);
      // Every round must strictly shrink the range.
      for (let i = 1; i < result.trail.length; i += 1) {
        expect(result.trail[i]).toBeLessThan(result.trail[i - 1]);
      }
    }
  });
});

describe("DEFAULT_BAND_SIZE", () => {
  it("stays inside the eu-north1 concurrent-VM quota with headroom", () => {
    expect(DEFAULT_BAND_SIZE).toBe(8);
    expect(DEFAULT_BAND_SIZE).toBeLessThan(12);
  });
});
