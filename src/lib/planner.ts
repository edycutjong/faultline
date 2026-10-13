/**
 * Faultline — the search planner.
 *
 * Pure integer arithmetic over commit indices. No network, no filesystem, no Nebius. How
 * many rounds a hunt takes is decided entirely by this file, which is why it is provable by
 * unit test alone.
 *
 * Model: commits are indexed `0 .. M`, oldest first. Index 0 is the caller's known-GOOD
 * ref, index `M` the known-BAD ref. The culprit is the FIRST commit that is bad, so it always
 * lies in the half-open interval `(lowIndex, highIndex]` — `lowIndex` being the highest index
 * proven good, `highIndex` the lowest index proven bad. Round 1 PROVES both ends rather than
 * assuming them; see `firstRoundInterior`.
 */

import type { Verdict } from "@/lib/types";

/**
 * The most interior probes a round will use. What a hunt actually gets is
 * `min(bandSize, slots)`: the backend's capacity, not this constant, is the real limit —
 * on Nebius Serverless Jobs here, 2 concurrent VMs per region (measured 2026-10-13).
 */
export const DEFAULT_BAND_SIZE = 8;

/** Interior probes per round once the backend's capacity is applied. Never below 1. */
export function effectiveBand(slots: number, bandSize: number): number {
  const s = Number.isFinite(slots) ? Math.floor(slots) : 1;
  const n = Number.isFinite(bandSize) ? Math.floor(bandSize) : 1;
  return Math.max(1, Math.min(n, s));
}

/**
 * Interior probes that run in round 1 beside the two endpoint probes.
 *
 * Round 1 always tests the known-good ref and the failing ref, each in its own clean
 * environment — a search that assumes them can blame an innocent commit with full
 * confidence. When the backend has room for a full band beside them the endpoints are
 * ADDED; otherwise they take two of the band's slots, which costs a little narrowing in
 * round 1 and, at two slots, all of it.
 */
export function firstRoundInterior(slots: number, bandSize: number): number {
  const s = Number.isFinite(slots) ? Math.floor(slots) : 2;
  return Math.max(0, Math.min(effectiveBand(Math.max(s, 1), bandSize), s - 2));
}

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
export function planBand(
  lowIndex: number,
  highIndex: number,
  n: number,
  skipped: ReadonlySet<number> = new Set(),
): number[] {
  const candidates = highIndex - lowIndex;

  // C <= 1 means the culprit is already pinned at highIndex; C <= 0 is an empty range.
  if (candidates <= 1) return [];
  if (!Number.isFinite(n) || n < 1) return [];

  const band = Math.floor(n);

  // Indices strictly between the bounds that a probe could still learn something from. A
  // skipped commit (it would not build or run) is not testable — but it is still a candidate
  // culprit, which is why spacing below is computed over ALL candidates, not testable ones.
  const testable: number[] = [];
  for (let i = lowIndex + 1; i < highIndex; i += 1) if (!skipped.has(i)) testable.push(i);

  // Fewer unknowns than probes: test all of them and finish this round.
  if (testable.length <= band) return testable;

  const picked = new Set<number>();
  for (let k = 1; k <= band; k += 1) {
    const ideal = lowIndex + (k * candidates) / (band + 1);
    if (skipped.size === 0) {
      const index = lowIndex + Math.round((k * candidates) / (band + 1));
      // Probing a bound re-proves what we already know, so clamp strictly inside.
      if (index > lowIndex && index < highIndex) picked.add(index);
      continue;
    }
    // With skips, take the testable commit nearest the ideal cut that is not already taken
    // (ties to the later commit, matching Math.round above).
    let best: number | null = null;
    for (const index of testable) {
      if (picked.has(index)) continue;
      if (best === null) {
        best = index;
        continue;
      }
      const d = Math.abs(index - ideal);
      const bestD = Math.abs(best - ideal);
      if (d < bestD || (d === bestD && index > best)) best = index;
    }
    if (best !== null) picked.add(best);
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

/**
 * True when commits remain in contention but none of them can be tested: every index
 * strictly inside the bounds was skipped. The culprit is then one of `(low, high]`, and the
 * honest answer is that range, not a guess inside it.
 */
export function isHemmedBySkips(
  lowIndex: number,
  highIndex: number,
  skipped: ReadonlySet<number>,
): boolean {
  if (highIndex - lowIndex <= 1) return false;
  for (let i = lowIndex + 1; i < highIndex; i += 1) if (!skipped.has(i)) return false;
  return true;
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
    const largest = worstRemaining(remaining, band);
    if (largest === null) return rounds;

    rounds += 1;
    if (largest >= remaining) return rounds; // no progress; refuse to spin
    remaining = largest;
  }

  return rounds;
}

/**
 * Candidates left after one round of `n` probes when the adversary hides the culprit in the
 * largest surviving segment. Null when the band places no probe at all.
 */
export function worstRemaining(rangeSize: number, n: number): number | null {
  const indices = planBand(0, rangeSize, n);
  if (indices.length === 0) return null;
  let largest = 0;
  let previous = 0;
  for (const index of indices) {
    largest = Math.max(largest, index - previous);
    previous = index;
  }
  return Math.max(largest, rangeSize - previous);
}

/**
 * Worst-case rounds for a whole hunt over `rangeSize` suspect commits, the endpoint round
 * included, on a backend that holds `slots` probes at once.
 */
export function estimateHuntRounds(rangeSize: number, slots: number, bandSize: number): number {
  if (!Number.isFinite(rangeSize) || rangeSize < 1) return 0;
  let remaining = Math.floor(rangeSize);
  const first = firstRoundInterior(slots, bandSize);
  if (first > 0 && remaining > 1) remaining = worstRemaining(remaining, first) ?? remaining;
  return 1 + estimateRounds(remaining, effectiveBand(slots, bandSize));
}

/**
 * Records written before a field existed read back without it. A band of `undefined` would
 * plan an empty round and a hunt that silently stalls forever, so fall back instead.
 */
export function huntBandSize(hunt: { bandSize?: number }): number {
  const n = hunt.bandSize;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : DEFAULT_BAND_SIZE;
}

/** Concurrent probes a hunt was planned around. Two is this tenant's per-region quota. */
export function huntSlots(hunt: { slots?: number }): number {
  const n = hunt.slots;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 2;
}

/** Worst-case rounds for one hunt, endpoint round included, for "Round 2 of ~3". */
export function expectedRounds(hunt: { commits: { length: number }; bandSize?: number; slots?: number }): number {
  return estimateHuntRounds(hunt.commits.length, huntSlots(hunt), huntBandSize(hunt));
}

