/**
 * Faultline — honest refusal.
 *
 * A bisection that always names a commit is a bisection that sometimes lies. These functions
 * read verdicts that have ALREADY been collected and decide whether the evidence supports
 * naming anyone. They are pure: they never dispatch, retry, or ask for another probe.
 *
 * Three kinds of refusal, in the order they are checked:
 *   1. an endpoint the user gave us does not behave as claimed, in its own clean environment;
 *   2. two verdicts contradict each other (a pass above a fail);
 *   3. the search narrowed to a run of commits that cannot be tested (skips hem it in).
 * Infrastructure failures are none of these: they PAUSE a hunt (see hunt.ts), because a
 * probe that never reported is not evidence of anything.
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
 * pass against the lowest-index fail. `error` verdicts are skips and never contradict.
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

/**
 * The endpoints, tested rather than assumed.
 *
 * Every bisection rests on two claims it is handed: the good ref passes and the bad ref
 * fails. `git bisect` takes both on faith. Faultline tests both, each in a clean environment
 * built from that commit's own declared dependencies, and refuses — with the reason — when
 * either is false. "The failing ref passes in a clean environment" is often the most useful
 * answer a hunt can give: the bug is in the environment, not in any commit.
 */
export function endpointRefusal(probes: readonly Probe[]): Inconclusive | null {
  const good = probes.find((p) => p.role === "good" && p.verdict !== null);
  const bad = probes.find((p) => p.role === "bad" && p.verdict !== null);

  if (good?.verdict === "error") {
    if (testedNothing(good.detail)) {
      return refusal(
        "good_unbuildable",
        "Your known-good ref can't run this test.",
        `At ${short(good.commitSha)} the test command ran but tested nothing ` +
          `(${firstLine(good.detail)}). Faultline will not take its "good" on faith, so there is ` +
          `no floor to search from. Pick a newer known-good ref — one where this test exists.`,
      );
    }
    return refusal(
      "good_unbuildable",
      "Your known-good ref can't be built today.",
      `Commit ${short(good.commitSha)} could not be checked out, installed or run in a fresh ` +
        `container (${firstLine(good.detail)}). Faultline will not take its "good" on faith, so ` +
        `there is no floor to search from. Pick a newer known-good ref — one whose declared ` +
        `dependencies still install.`,
    );
  }
  if (good?.verdict === "fail") {
    return refusal(
      "good_fails",
      "Your known-good ref fails this test too.",
      `In a clean environment built from its own declared dependencies, ${short(good.commitSha)} ` +
        `fails the test. The break is older than this range — or the test depends on something ` +
        `outside the repository. Move the known-good ref further back and run again.`,
    );
  }
  if (bad?.verdict === "error") {
    return refusal(
      "bad_unbuildable",
      "The failing ref can't be built in a clean environment.",
      `Commit ${short(bad.commitSha)} could not be checked out, installed or run in a fresh ` +
        `container (${firstLine(bad.detail)}). Without a clean failure to anchor on, any commit ` +
        `Faultline named would be a guess. ${testedNothing(bad.detail) ? "Check the test command." : "Check the install command."}`,
    );
  }
  if (bad?.verdict === "pass") {
    return refusal(
      "bad_passes",
      "The failing ref passes in a clean environment.",
      `Built from scratch with its own declared dependencies, ${short(bad.commitSha)} passes ` +
        `the test. The failure you are seeing does not come from a commit in this range — look ` +
        `at the environment it failed in: a dependency that resolved differently, a stale ` +
        `virtualenv, a system library, or the clock.`,
    );
  }
  return null;
}

/**
 * Decide whether the collected evidence refuses to name a culprit, and say why in copy a
 * maintainer can act on. Returns null when the search may legitimately continue.
 *
 * Order matters: an endpoint that misbehaves invalidates every interior verdict, and a
 * contradiction outranks anything the narrowing would conclude.
 */
export function classifyInconclusive(probes: readonly Probe[]): Inconclusive | null {
  const endpoint = endpointRefusal(probes);
  if (endpoint) return endpoint;

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
      range: null,
    };
  }

  return null;
}

/**
 * The culprit is hemmed in by commits that cannot be tested: it is one of `(low, high]`.
 *
 * `git bisect` reports exactly this ("only skipped commits left to test … the first bad
 * commit could be any of"); so does Faultline, on the same amber screen as a refusal,
 * because naming one commit of the run would be a guess.
 */
export function skippedRange(
  commits: readonly Commit[],
  lowIndex: number,
  highIndex: number,
): Inconclusive {
  const shas = commits
    .filter((c) => c.index > lowIndex && c.index <= highIndex)
    .sort((a, b) => a.index - b.index)
    .map((c) => c.sha);
  const count = shas.length;
  return {
    reason: "skipped_range",
    headline: `The culprit is one of these ${count} commits.`,
    explanation:
      `Every commit between the last pass and the first fail could not be built or run, so ` +
      `the search cannot see inside this run. The first bad commit is one of these ${count}; ` +
      `the newest of them failed the test. Faultline names the range rather than guess a ` +
      `commit inside it — fix the install command or the build for these commits and the next ` +
      `hunt can split it.`,
    evidence: null,
    range: { fromIndex: lowIndex + 1, toIndex: highIndex, shas },
  };
}

function refusal(reason: Inconclusive["reason"], headline: string, explanation: string): Inconclusive {
  return { reason, headline, explanation, evidence: null, range: null };
}

/** The probe's detail for a command that ran but tested nothing (probe.py: exit 125, pytest 4/5). */
function testedNothing(detail: string | null): boolean {
  return /^(pytest exited [45] |test command exited 125 )/.test(detail ?? "");
}

function firstLine(text: string | null): string {
  // unreachable: String.split always yields at least one element, so [0] is never undefined
  /* v8 ignore next */
  const line = (text ?? "no detail reported").split("\n")[0]?.trim() ?? "";
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}
