/**
 * Faultline — the search planner.
 *
 * Pure integer arithmetic over commit indices. No network, no filesystem, no Nebius. The
 * headline claim of the product ("a 256-commit range in 3 rounds") is decided entirely by
 * this file, which is why it is provable by unit test alone.
 *
 * Model: commits are indexed `0 .. M-1`, oldest first. Index 0 is the caller's known-GOOD
 * ref, index `M-1` the known-BAD ref (HEAD). The culprit is the FIRST commit that is bad,
 * so it always lies in the half-open interval `(lowIndex, highIndex]` — `lowIndex` being the
 * highest index proven good, `highIndex` the lowest index proven bad.
 */

import type { Verdict } from "@/lib/types";

/**
 * Probes per round.
 *
 * The ceiling is a real quota, not a preference: the Nebius `eu-north1` default is 12
 * concurrent non-GPU VMs, and every probe is one. Eight leaves four slots of headroom for
 * the narration job and for retries, and is therefore the largest band we can dispatch
 * without a round silently queueing behind its own tail.
 */
export const DEFAULT_BAND_SIZE = 8;

/** One collected answer, reduced to the only two fields narrowing cares about. */
export interface ProbeOutcome {
  index: number;
  verdict: Verdict;
}

/** Inclusive-low / inclusive-high bounds of the range still under suspicion. */
export interface Bounds {
  lowIndex: number;
  highIndex: number;
}

/**
 * Plan one round: which commit indices to test in parallel.
 *
 * N probes placed inside a range cut it into **N + 1** segments, so the surviving range is
 * `C / (N + 1)` — not `C / N`, and emphatically not `C / 2`. That off-by-one is the whole
 * advantage over serial bisection: at N=8 a range shrinks 9x per round, not 8x and not 2x.
 * Placing probes at `k * C / (N + 1)` for `k = 1..N` is what makes the segments equal, which
 * is what makes the WORST case (not the average) divide by N + 1.
 */
export function planBand(lowIndex: number, highIndex: number, n: number): number[] {
  const candidates = highIndex - lowIndex;

  // C <= 1 means the culprit is already pinned at highIndex; C <= 0 is an empty range.
  if (candidates <= 1) return [];
  if (!Number.isFinite(n) || n < 1) return [];

  const band = Math.floor(n);
  const interior = candidates - 1; // indices strictly between the bounds

  // Fewer unknowns than probes: test all of them and finish this round.
  if (interior <= band) {
    const all: number[] = [];
    for (let i = lowIndex + 1; i < highIndex; i += 1) all.push(i);
    return all;
  }

  const picked = new Set<number>();
  for (let k = 1; k <= band; k += 1) {
    const index = lowIndex + Math.round((k * candidates) / (band + 1));
    // Probing a bound re-proves what we already know, so clamp strictly inside.
    if (index > lowIndex && index < highIndex) picked.add(index);
  }

  return [...picked].sort((a, b) => a - b);
}

/**
 * Fold a round's verdicts into new bounds.
 *
 * Bounds only ever tighten — taking max/min against the current values keeps a stale or
 * out-of-band result from widening the search. `error` verdicts are ignored here (they prove
 * nothing about the commit) but are retained by the caller as evidence.
 */
export function narrow(
  lowIndex: number,
  highIndex: number,
  results: readonly ProbeOutcome[],
): Bounds {
  let low = lowIndex;
  let high = highIndex;

  for (const result of results) {
    if (result.verdict === "pass") {
      // A pass means everything up to here is clean: raise the floor.
      if (result.index > low) low = result.index;
    } else if (result.verdict === "fail") {
      // A fail means the culprit is at or before here: lower the ceiling.
      if (result.index < high) high = result.index;
    }
  }

  return { lowIndex: low, highIndex: high };
}

/** True when exactly one candidate remains and the search is over. */
export function isSettled(lowIndex: number, highIndex: number): boolean {
  return highIndex - lowIndex === 1;
}

/** The first bad commit's index, or null while more than one candidate survives. */
export function culpritIndex(lowIndex: number, highIndex: number): number | null {
  return isSettled(lowIndex, highIndex) ? highIndex : null;
}

/**
 * Worst-case rounds needed to settle a range of `rangeSize` candidates with a band of `n`.
 *
 * Derived by simulating the real planner against its own worst branch rather than from a
 * `log` formula, so the number the UI renders ("Round 2 of ~3") can never disagree with the
 * search actually running. A band below 1 cannot make progress, so it is coerced to 1.
 */
export function estimateRounds(rangeSize: number, n: number): number {
  if (!Number.isFinite(rangeSize) || rangeSize <= 1) return 0;

  const band = Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1;
  let remaining = Math.floor(rangeSize);
  let rounds = 0;

  while (remaining > 1) {
    const indices = planBand(0, remaining, band);
    if (indices.length === 0) return rounds;

    // The adversary always hides the culprit in the largest surviving segment.
    let largest = 0;
    let previous = 0;
    for (const index of indices) {
      largest = Math.max(largest, index - previous);
      previous = index;
    }
    largest = Math.max(largest, remaining - previous);

    rounds += 1;
    if (largest >= remaining) return rounds; // no progress; refuse to spin
    remaining = largest;
  }

  return rounds;
}
