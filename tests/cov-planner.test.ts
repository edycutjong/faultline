import { describe, expect, it } from "vitest";
import {
  DEFAULT_BAND_SIZE,
  culpritIndex,
  effectiveBand,
  estimateHuntRounds,
  estimateRounds,
  expectedRounds,
  firstRoundInterior,
  huntBandSize,
  huntSlots,
  isHemmedBySkips,
  isSettled,
  narrow,
  planBand,
  worstRemaining,
} from "@/lib/planner";

describe("planner coverage", () => {
  it("effectiveBand falls back to 1 for non-finite inputs", () => {
    expect(effectiveBand(Number.NaN, 8)).toBe(1);
    expect(effectiveBand(4, Number.POSITIVE_INFINITY)).toBe(1);
    expect(effectiveBand(4.9, 8.9)).toBe(4);
    expect(effectiveBand(0, 8)).toBe(1);
  });

  it("firstRoundInterior handles non-finite slots", () => {
    expect(firstRoundInterior(Number.NaN, 8)).toBe(0);
    expect(firstRoundInterior(10, 8)).toBe(8);
    expect(firstRoundInterior(4, 8)).toBe(2);
    expect(firstRoundInterior(0, 8)).toBe(0);
  });

  it("planBand rejects empty ranges and bad bands", () => {
    expect(planBand(0, 1, 4)).toEqual([]);
    expect(planBand(5, 3, 4)).toEqual([]);
    expect(planBand(0, 10, 0)).toEqual([]);
    expect(planBand(0, 10, Number.NaN)).toEqual([]);
  });

  it("planBand tests every unknown when fewer than the band", () => {
    expect(planBand(0, 4, 8)).toEqual([1, 2, 3]);
    expect(planBand(0, 4, 8, new Set([2]))).toEqual([1, 3]);
  });

  it("planBand spaces probes evenly without skips", () => {
    expect(planBand(0, 9, 2)).toEqual([3, 6]);
    expect(planBand(0, 100, 3.7)).toEqual([25, 50, 75]);
  });

  it("planBand picks nearest testable commits with skips", () => {
    // ideal cuts at 3 and 6; 3 is skipped so 2 and 4 tie -> later (4)
    expect(planBand(0, 9, 2, new Set([3]))).toEqual([4, 6]);
    // ideal cut 6 skipped, 5 and 7 tie -> 7; ideal 3 -> 3
    expect(planBand(0, 9, 2, new Set([6]))).toEqual([3, 7]);
    // exact hit, and already-picked commits are skipped over
    expect(planBand(0, 12, 3, new Set([1]))).toEqual([3, 6, 9]);
    expect(planBand(0, 6, 2, new Set([1, 2]))).toEqual([3, 4]);
  });

  it("narrow tightens on pass/fail and ignores errors and stale results", () => {
    expect(
      narrow(0, 10, [
        { index: 3, verdict: "pass" },
        { index: 2, verdict: "pass" },
        { index: 7, verdict: "fail" },
        { index: 9, verdict: "fail" },
        { index: 5, verdict: "error" },
      ]),
    ).toEqual({ lowIndex: 3, highIndex: 7 });
    expect(narrow(0, 10, [])).toEqual({ lowIndex: 0, highIndex: 10 });
  });

  it("isSettled / culpritIndex", () => {
    expect(isSettled(2, 3)).toBe(true);
    expect(isSettled(2, 5)).toBe(false);
    expect(culpritIndex(2, 3)).toBe(3);
    expect(culpritIndex(2, 5)).toBeNull();
  });

  it("isHemmedBySkips", () => {
    expect(isHemmedBySkips(0, 1, new Set())).toBe(false);
    expect(isHemmedBySkips(0, 4, new Set([1, 2]))).toBe(false);
    expect(isHemmedBySkips(0, 4, new Set([1, 2, 3]))).toBe(true);
  });

  it("estimateRounds", () => {
    expect(estimateRounds(Number.NaN, 4)).toBe(0);
    expect(estimateRounds(1, 4)).toBe(0);
    expect(estimateRounds(9, 2)).toBe(2);
    expect(estimateRounds(100, 8)).toBe(3);
    expect(estimateRounds(8, Number.NaN)).toBe(3);
    expect(estimateRounds(8, 0)).toBe(3);
  });

  it("worstRemaining", () => {
    expect(worstRemaining(1, 4)).toBeNull();
    expect(worstRemaining(9, 2)).toBe(3);
    expect(worstRemaining(2, 5)).toBe(1);
  });

  it("estimateHuntRounds", () => {
    expect(estimateHuntRounds(Number.NaN, 2, 8)).toBe(0);
    expect(estimateHuntRounds(0, 2, 8)).toBe(0);
    expect(estimateHuntRounds(1, 10, 8)).toBe(1);
    expect(estimateHuntRounds(2, 2, 8)).toBe(2);
    expect(estimateHuntRounds(100, 10, 8)).toBe(1 + estimateRounds((worstRemaining(100, 8) as number), 8));
  });

  it("huntBandSize / huntSlots fall back on bad values", () => {
    expect(huntBandSize({})).toBe(DEFAULT_BAND_SIZE);
    expect(huntBandSize({ bandSize: 2.5 })).toBe(DEFAULT_BAND_SIZE);
    expect(huntBandSize({ bandSize: 0 })).toBe(DEFAULT_BAND_SIZE);
    expect(huntBandSize({ bandSize: 3 })).toBe(3);
    expect(huntSlots({})).toBe(2);
    expect(huntSlots({ slots: -1 })).toBe(2);
    expect(huntSlots({ slots: 6 })).toBe(6);
  });

  it("expectedRounds combines hunt fields", () => {
    expect(expectedRounds({ commits: { length: 100 }, bandSize: 8, slots: 10 })).toBe(
      estimateHuntRounds(100, 10, 8),
    );
    expect(expectedRounds({ commits: { length: 0 } })).toBe(0);
    expect(expectedRounds({ commits: { length: 50 } })).toBe(estimateHuntRounds(50, 2, DEFAULT_BAND_SIZE));
  });
});
