/**
 * Faultline — honest refusal.
 *
 * A bisection that always names a commit is a bisection that sometimes lies. These functions
 * read verdicts that have ALREADY been collected and decide whether the evidence supports
 * naming anyone. They are pure: they never dispatch, retry, or ask for another probe.
 */

import type { Commit, Inconclusive, Probe, Verdict } from "@/lib/types";

/** The two commits whose verdicts cannot both be true of a single first-bad commit. */
export interface Contradiction {
  passSha: string;
  failSha: string;
}

interface Decided {
  sha: string;
  index: number;
  verdict: Exclude<Verdict, "error">;
}

function decided(probes: readonly Probe[]): Decided[] {
  const out: Decided[] = [];
  for (const probe of probes) {
    if (probe.verdict === "pass" || probe.verdict === "fail") {
      out.push({ sha: probe.commitSha, index: probe.commitIndex, verdict: probe.verdict });
    }
  }
  return out;
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * A `pass` at a HIGHER index than a `fail` means history went bad, then good again. No single
 * first-bad commit produces that, so the premise of the whole search is broken.
 *
 * Of all such pairs the widest one is the most illustrative, so we report the highest-index
 * pass against the lowest-index fail.
 */
export function detectContradiction(probes: readonly Probe[]): Contradiction | null {
  let highestPass: Decided | null = null;
  let lowestFail: Decided | null = null;

  for (const item of decided(probes)) {
    if (item.verdict === "pass") {
      if (highestPass === null || item.index > highestPass.index) highestPass = item;
    } else if (lowestFail === null || item.index < lowestFail.index) {
      lowestFail = item;
    }
  }

  if (highestPass === null || lowestFail === null) return null;
  if (highestPass.index <= lowestFail.index) return null;

  return { passSha: highestPass.sha, failSha: lowestFail.sha };
}

function describe(commits: readonly Commit[], sha: string, index: number): string {
  const commit = commits.find((c) => c.sha === sha || c.index === index);
  return commit === undefined ? short(sha) : `${short(commit.sha)} "${commit.subject}"`;
}

/** Probes from the most recent round present, which is the unit "half a round" refers to. */
function latestRound(probes: readonly Probe[]): Probe[] {
  if (probes.length === 0) return [];
  let max = probes[0].round;
  for (const probe of probes) if (probe.round > max) max = probe.round;
  return probes.filter((probe) => probe.round === max);
}

/**
 * Decide whether the collected evidence refuses to name a culprit, and say why in copy a
 * maintainer can act on. Returns null when the search may legitimately continue.
 *
 * Order matters: a contradiction outranks everything, because a range where every probe
 * failed AND a later probe passed is a contradiction first and an "already broken" range
 * second — reporting the weaker reason would hide the real problem.
 */
export function classifyInconclusive(
  probes: readonly Probe[],
  commits: readonly Commit[],
): Inconclusive | null {
  const contradiction = detectContradiction(probes);
  if (contradiction !== null) {
    return {
      reason: "contradiction",
      headline: "Two probes disagree about the same history.",
      explanation:
        `Commit ${short(contradiction.passSha)} passed the test, but ` +
        `${short(contradiction.failSha)}, which comes before it, failed. One first-bad commit ` +
        `cannot produce that ordering. Either the test is flaky, the failure depends on ` +
        `something outside the repository, or this range contains more than one independent ` +
        `break. Faultline names no commit here, because any commit it named would be a guess.`,
      evidence: contradiction,
    };
  }

  const answers = decided(probes);
  if (answers.length === 0) {
    const errored = latestRound(probes).filter((probe) => probe.verdict === "error");
    return errored.length === 0 ? null : probeErrors(errored.length, latestRound(probes).length);
  }

  const sorted = [...answers].sort((a, b) => a.index - b.index);
  const oldest = sorted[0];
  const newest = sorted[sorted.length - 1];

  if (answers.every((item) => item.verdict === "fail")) {
    return {
      reason: "all_fail",
      headline: "The break is older than this range.",
      explanation:
        `Every commit tested failed, including the oldest one probed — ` +
        `${describe(commits, oldest.sha, oldest.index)}. A bisection can only work when the ` +
        `range starts from something that genuinely passes, and nothing here does. The break ` +
        `is older than this window: the good ref needs to move further back, to a commit where ` +
        `this test is actually green.`,
      evidence: null,
    };
  }

  if (answers.every((item) => item.verdict === "pass")) {
    return {
      reason: "all_pass",
      headline: "Nothing in this range reproduces the failure.",
      explanation:
        `Every commit tested passed, up to and including ` +
        `${describe(commits, newest.sha, newest.index)}. The code itself is green under this ` +
        `test command, which points away from the commits and toward what surrounds them — ` +
        `dependency versions, service state, seed data, or the machine. A bisection cannot ` +
        `find a fault the code does not contain.`,
      evidence: null,
    };
  }

  const round = latestRound(probes);
  const errored = round.filter((probe) => probe.verdict === "error").length;
  // Half a round of silence is enough to make the surviving verdicts unsafe to narrow on.
  if (round.length > 0 && errored * 2 >= round.length) {
    return probeErrors(errored, round.length);
  }

  return null;
}

function probeErrors(errored: number, total: number): Inconclusive {
  return {
    reason: "probe_errors",
    headline: "Too many probes never reported.",
    explanation:
      `${errored} of ${total} probes in this round returned no verdict — the container stopped ` +
      `before the test could answer. That is a fault in how the test runs, not in the commits, ` +
      `and the handful of verdicts that did come back are too thin to narrow on. The test ` +
      `command and the probe image are where the answer is.`,
    evidence: null,
  };
}
