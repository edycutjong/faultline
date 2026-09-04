import { describe, it, expect } from "vitest";

import { classifyInconclusive, detectContradiction, edgeCaveat } from "@/lib/verdicts";
import type { Commit, Probe, Verdict } from "@/lib/types";

function commit(index: number): Commit {
  return {
    sha: `${index}`.padStart(2, "0").repeat(20).slice(0, 40),
    index,
    subject: `commit number ${index}`,
    author: "maintainer <m@example.com>",
    date: "2026-09-01T00:00:00Z",
  };
}

/** A full commit range, so `classifyInconclusive` can resolve subjects for its copy. */
const RANGE: Commit[] = Array.from({ length: 64 }, (_, i) => commit(i));

function probe(index: number, verdict: Verdict | null, round = 1): Probe {
  return {
    commitSha: commit(index).sha,
    commitIndex: index,
    round,
    jobId: `job-${round}-${index}`,
    jobState: verdict === null ? "RUNNING" : "COMPLETED",
    verdict,
    detail: verdict === "error" ? "container exited before writing a verdict" : null,
    dispatchedAt: "2026-09-01T00:00:00Z",
    startedAt: "2026-09-01T00:00:02Z",
    finishedAt: verdict === null ? null : "2026-09-01T00:00:40Z",
    durationMs: verdict === null ? null : 38_000,
    verdictKey: `hunts/h1/round-${round}/${index}.json`,
  };
}

const shortSha = (index: number): string => commit(index).sha.slice(0, 7);

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

describe("classifyInconclusive", () => {
  it("returns null while the search can legitimately continue", () => {
    const result = classifyInconclusive(
      [probe(7, "pass"), probe(14, "pass"), probe(21, "fail"), probe(28, "fail")],
      RANGE,
    );
    expect(result).toBeNull();
  });

  it("returns null for no probes at all", () => {
    expect(classifyInconclusive([], RANGE)).toBeNull();
  });

  it("returns null while probes are still running", () => {
    expect(classifyInconclusive([probe(7, null), probe(14, null)], RANGE)).toBeNull();
  });

  describe("contradiction", () => {
    const probes = [probe(5, "fail"), probe(20, "pass"), probe(35, "fail")];
    const result = classifyInconclusive(probes, RANGE);

    it("is reported with the offending pair as evidence", () => {
      expect(result?.reason).toBe("contradiction");
      expect(result?.evidence).toEqual({
        passSha: commit(20).sha,
        failSha: commit(5).sha,
      });
    });

    it("names both commits in the explanation", () => {
      expect(result?.explanation).toContain(shortSha(20));
      expect(result?.explanation).toContain(shortSha(5));
    });

    it("outranks all_fail when both could apply", () => {
      // Oldest probe failed and most probes failed, but one later pass breaks the premise.
      const mostlyFailing = classifyInconclusive(
        [probe(5, "fail"), probe(10, "fail"), probe(15, "fail"), probe(40, "pass")],
        RANGE,
      );
      expect(mostlyFailing?.reason).toBe("contradiction");
      expect(mostlyFailing?.evidence?.passSha).toBe(commit(40).sha);
      expect(mostlyFailing?.evidence?.failSha).toBe(commit(5).sha);
    });

    it("outranks probe_errors when both could apply", () => {
      const noisy = classifyInconclusive(
        [probe(5, "fail"), probe(20, "pass"), probe(30, "error"), probe(40, "error")],
        RANGE,
      );
      expect(noisy?.reason).toBe("contradiction");
    });
  });

  describe("all_fail", () => {
    // `all_fail` is no longer a refusal reason: the hunt assumes the good ref really
    // passes, so a round where everything fails just means the culprit is early in the
    // range. classifyInconclusive must resolve to null and let the search keep narrowing.
    it("is no longer reported — it resolves to null with no evidence pair", () => {
      const result = classifyInconclusive(
        [probe(1, "fail"), probe(9, "fail"), probe(18, "fail"), probe(27, "fail")],
        RANGE,
      );
      expect(result).toBeNull();
    });

    it("applies to a single failing probe too", () => {
      expect(classifyInconclusive([probe(1, "fail")], RANGE)).toBeNull();
    });

    it("does not apply when one probe passed", () => {
      const mixed = classifyInconclusive([probe(1, "pass"), probe(9, "fail")], RANGE);
      expect(mixed).toBeNull();
    });
  });

  describe("all_pass", () => {
    // `all_pass` is no longer a refusal reason either: it means the culprit is late in
    // the range, which relies on the failing ref really failing — a real, narrowable
    // answer, not an unexplainable one.
    it("is no longer reported — it resolves to null with no evidence pair", () => {
      const result = classifyInconclusive(
        [probe(9, "pass"), probe(18, "pass"), probe(27, "pass"), probe(36, "pass")],
        RANGE,
      );
      expect(result).toBeNull();
    });

    it("falls back to null even when the commit is not in the supplied range", () => {
      const orphan = classifyInconclusive([probe(9, "pass")], []);
      expect(orphan).toBeNull();
    });
  });

  describe("probe_errors", () => {
    it("fires when exactly half a round returned nothing", () => {
      const result = classifyInconclusive(
        [
          probe(7, "pass"),
          probe(14, "pass"),
          probe(21, "fail"),
          probe(28, "fail"),
          probe(35, "error"),
          probe(42, "error"),
          probe(49, "error"),
          probe(56, "error"),
        ],
        RANGE,
      );
      expect(result?.reason).toBe("probe_errors");
      expect(result?.evidence).toBeNull();
      expect(result?.explanation).toContain("4 of 8");
    });

    it("fires when nothing in the round reported at all", () => {
      const result = classifyInconclusive([probe(7, "error"), probe(14, "error")], RANGE);
      expect(result?.reason).toBe("probe_errors");
      expect(result?.explanation).toContain("2 of 2");
    });

    it("does not fire below half a round", () => {
      const result = classifyInconclusive(
        [probe(7, "pass"), probe(14, "pass"), probe(21, "fail"), probe(28, "error")],
        RANGE,
      );
      expect(result).toBeNull();
    });

    it("counts only the latest round, so old failures do not poison a clean one", () => {
      const result = classifyInconclusive(
        [
          probe(7, "error", 1),
          probe(14, "error", 1),
          probe(21, "pass", 2),
          probe(28, "fail", 2),
        ],
        RANGE,
      );
      expect(result).toBeNull();
    });

    it("fires on the latest round even when earlier rounds were clean", () => {
      const result = classifyInconclusive(
        [
          probe(7, "pass", 1),
          probe(14, "fail", 1),
          probe(9, "error", 2),
          probe(11, "error", 2),
        ],
        RANGE,
      );
      expect(result?.reason).toBe("probe_errors");
      expect(result?.explanation).toContain("2 of 2");
    });
  });

  describe("copy quality (this is rendered on a judged screen)", () => {
    // Only `contradiction` and `probe_errors` are refusals now — `all_fail` and `all_pass`
    // produce no copy at all because they no longer produce an Inconclusive.
    const cases: ReadonlyArray<[string, Probe[]]> = [
      ["contradiction", [probe(5, "fail"), probe(20, "pass")]],
      ["probe_errors", [probe(9, "error"), probe(18, "error")]],
    ];

    for (const [reason, probes] of cases) {
      it(`${reason} reads as a refusal, not a crash`, () => {
        const result = classifyInconclusive(probes, RANGE);
        expect(result).not.toBeNull();
        expect(result?.reason).toBe(reason);
        expect(result?.headline.length).toBeGreaterThan(15);
        expect(result?.headline.endsWith(".")).toBe(true);
        expect(result?.explanation.length).toBeGreaterThan(120);
        // No apologising, no stack-trace language, no promise to try again.
        expect(result?.explanation.toLowerCase()).not.toMatch(
          /sorry|oops|unexpected error|exception|stack trace|retry|re-?run|try again/,
        );
        expect(result?.headline.toLowerCase()).not.toMatch(/error|failed to|sorry|oops/);
      });
    }

    it("all_fail reads as a resolution, not a refusal", () => {
      const result = classifyInconclusive([probe(1, "fail"), probe(9, "fail")], RANGE);
      expect(result).toBeNull();
    });

    it("all_pass reads as a resolution, not a refusal", () => {
      const result = classifyInconclusive([probe(9, "pass"), probe(18, "pass")], RANGE);
      expect(result).toBeNull();
    });

    it("carries evidence only for the contradiction case", () => {
      for (const [reason, probes] of cases) {
        const result = classifyInconclusive(probes, RANGE);
        if (reason === "contradiction") {
          expect(result?.evidence).not.toBeNull();
        } else {
          expect(result?.evidence).toBeNull();
        }
      }
    });
  });
});
