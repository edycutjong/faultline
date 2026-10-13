/**
 * Honest refusal: when the evidence does not support naming a single commit.
 *
 * These are pure functions over verdicts already collected. The cases that matter most are
 * the ones a plain `git bisect` gets wrong silently: an endpoint that does not behave as the
 * user claimed, a pass sitting above a fail, and a culprit hidden among commits that could
 * not be built.
 */

import { describe, it, expect } from "vitest";

import { classifyInconclusive, detectContradiction, endpointRefusal, skippedRange } from "@/lib/verdicts";
import type { Commit, Probe, ProbeRole, Verdict } from "@/lib/types";
import { probe as baseProbe } from "./helpers";

function commit(index: number): Commit {
  return {
    sha: `${index}`.padStart(2, "0").repeat(20).slice(0, 40),
    index,
    subject: `commit number ${index}`,
    author: "maintainer <m@example.com>",
    date: "2026-09-01T00:00:00Z",
  };
}

const RANGE: Commit[] = Array.from({ length: 64 }, (_, i) => commit(i + 1));

function probe(index: number, verdict: Verdict | null, round = 1, role: ProbeRole = "interior"): Probe {
  return baseProbe(index, verdict, { commitSha: commit(index).sha, round, role });
}

const good = (verdict: Verdict | null) => probe(0, verdict, 1, "good");
const bad = (verdict: Verdict | null) => probe(64, verdict, 1, "bad");

describe("detectContradiction", () => {
  it("finds nothing in a clean monotone round", () => {
    expect(
      detectContradiction([
        probe(7, "pass"),
        probe(14, "pass"),
        probe(21, "fail"),
        probe(28, "fail"),
      ]),
    ).toBeNull();
  });

  it("finds nothing when every probe agrees", () => {
    expect(detectContradiction([probe(7, "pass"), probe(14, "pass")])).toBeNull();
    expect(detectContradiction([probe(7, "fail"), probe(14, "fail")])).toBeNull();
  });

  it("finds nothing in an empty or undecided set", () => {
    expect(detectContradiction([])).toBeNull();
    expect(detectContradiction([probe(7, null), probe(14, null)])).toBeNull();
    expect(detectContradiction([probe(7, "error"), probe(14, "error")])).toBeNull();
  });

  it("reports a pass sitting above a fail", () => {
    const found = detectContradiction([probe(10, "fail"), probe(20, "pass")]);
    expect(found).not.toBeNull();
    expect(found?.failSha).toBe(commit(10).sha);
    expect(found?.passSha).toBe(commit(20).sha);
  });

  it("picks the widest pair — highest pass against lowest fail", () => {
    const found = detectContradiction([
      probe(5, "fail"),
      probe(12, "fail"),
      probe(20, "pass"),
      probe(31, "pass"),
      probe(40, "fail"),
    ]);
    expect(found?.failSha).toBe(commit(5).sha);
    expect(found?.passSha).toBe(commit(31).sha);
  });

  it("spots a contradiction that spans two rounds", () => {
    const found = detectContradiction([
      probe(30, "fail", 1),
      probe(45, "pass", 2), // later round, higher index, disagrees with round 1
    ]);
    expect(found?.failSha).toBe(commit(30).sha);
    expect(found?.passSha).toBe(commit(45).sha);
  });

  it("ignores error verdicts when looking for disagreement", () => {
    expect(
      detectContradiction([probe(10, "fail"), probe(20, "error"), probe(30, "error")]),
    ).toBeNull();
  });

  it("treats adjacent pass-then-fail as consistent, not contradictory", () => {
    expect(detectContradiction([probe(19, "pass"), probe(20, "fail")])).toBeNull();
  });
});

describe("endpointRefusal", () => {
  it("says nothing while the endpoints behave as claimed", () => {
    expect(endpointRefusal([good("pass"), bad("fail")])).toBeNull();
  });

  it("says nothing while an endpoint is still running", () => {
    expect(endpointRefusal([good(null), bad(null)])).toBeNull();
  });

  it("refuses when the known-good ref fails in its own environment", () => {
    const refusal = endpointRefusal([good("fail"), bad("fail")]);
    expect(refusal?.reason).toBe("good_fails");
    expect(refusal?.explanation).toContain(commit(0).sha.slice(0, 7));
  });

  it("refuses — pointing at the environment — when the failing ref passes", () => {
    const refusal = endpointRefusal([good("pass"), bad("pass")]);
    expect(refusal?.reason).toBe("bad_passes");
    expect(refusal?.explanation).toMatch(/environment/);
  });

  it("gives an unbuildable known-good ref its own copy, with the probe's reason", () => {
    const refusal = endpointRefusal([good("error"), bad("fail")]);
    expect(refusal?.reason).toBe("good_unbuildable");
    expect(refusal?.headline).toBe("Your known-good ref can't be built today.");
    expect(refusal?.explanation).toContain("dependency install failed");
  });

  it("refuses an unbuildable failing ref", () => {
    expect(endpointRefusal([good("pass"), bad("error")])?.reason).toBe("bad_unbuildable");
  });

  it("checks the known-good ref first: a broken floor invalidates everything above it", () => {
    expect(endpointRefusal([good("fail"), bad("pass")])?.reason).toBe("good_fails");
  });
});

describe("classifyInconclusive", () => {
  it("returns null while the search can legitimately continue", () => {
    expect(classifyInconclusive([good("pass"), bad("fail"), probe(20, "pass"), probe(40, "fail")])).toBeNull();
  });

  it("returns null for no probes at all", () => {
    expect(classifyInconclusive([])).toBeNull();
  });

  it("lets an endpoint refusal outrank a contradiction", () => {
    const result = classifyInconclusive([good("fail"), bad("fail"), probe(10, "fail"), probe(30, "pass")]);
    expect(result?.reason).toBe("good_fails");
  });

  it("reports a contradiction with the offending pair as evidence", () => {
    const result = classifyInconclusive([good("pass"), bad("fail"), probe(5, "fail"), probe(20, "pass")]);
    expect(result?.reason).toBe("contradiction");
    expect(result?.evidence).toEqual({ passSha: commit(20).sha, failSha: commit(5).sha });
    expect(result?.explanation).toContain(commit(20).sha.slice(0, 7));
  });

  it("never treats skips as contradictions or refusals", () => {
    expect(classifyInconclusive([good("pass"), bad("fail"), probe(10, "error"), probe(30, "error")])).toBeNull();
  });

  it("does not refuse when every interior probe fails — the culprit is early, and the good end proves it", () => {
    expect(classifyInconclusive([good("pass"), bad("fail"), probe(9, "fail"), probe(18, "fail")])).toBeNull();
  });

  it("does not refuse when every interior probe passes — the culprit is late, and the bad end proves it", () => {
    expect(classifyInconclusive([good("pass"), bad("fail"), probe(30, "pass"), probe(60, "pass")])).toBeNull();
  });

  it.each([
    ["contradiction", [good("pass"), bad("fail"), probe(5, "fail"), probe(20, "pass")]],
    ["good_fails", [good("fail"), bad("fail")]],
    ["bad_passes", [good("pass"), bad("pass")]],
    ["good_unbuildable", [good("error"), bad("fail")]],
    ["bad_unbuildable", [good("pass"), bad("error")]],
  ] as const)("%s reads as a refusal a maintainer can act on, not a crash", (reason, probes) => {
    const result = classifyInconclusive(probes);
    expect(result?.reason).toBe(reason);
    expect(result?.headline.length).toBeGreaterThan(10);
    expect(result?.headline).not.toMatch(/error|exception|undefined|null/i);
    expect(result?.explanation.length).toBeGreaterThan(80);
  });
});

describe("skippedRange", () => {
  it("names every commit the culprit could be, oldest first", () => {
    const result = skippedRange(RANGE, 29, 33);
    expect(result.reason).toBe("skipped_range");
    expect(result.range).toEqual({
      fromIndex: 30,
      toIndex: 33,
      shas: [commit(30).sha, commit(31).sha, commit(32).sha, commit(33).sha],
    });
    expect(result.headline).toBe("The culprit is one of these 4 commits.");
    expect(result.evidence).toBeNull();
  });
});
