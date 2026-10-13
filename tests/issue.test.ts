/**
 * The pasteable GitHub issue.
 *
 * This text leaves the product and lands in someone else's repository, so it has to be both
 * correct and complete: a maintainer receiving it should be able to audit the conclusion
 * without opening Faultline.
 */

import { describe, it, expect } from "vitest";
import { renderIssue } from "@/lib/issue";
import type { Hunt, Probe } from "@/lib/types";
import { probe as baseProbe } from "./helpers";

function probe(index: number, verdict: Probe["verdict"], round = 1): Probe {
  return baseProbe(index, verdict, {
    commitSha: `c${String(index).padStart(38, "0")}`,
    round,
    jobId: `computejob-e00${String(index).padStart(6, "0")}`,
    durationMs: 41_000,
  });
}

function hunt(overrides: Partial<Hunt> = {}): Hunt {
  const commits = Array.from({ length: 64 }, (_, i) => ({
    sha: `c${String(i + 1).padStart(38, "0")}`,
    index: i + 1,
    subject: `change ${i + 1}`,
    author: "Dana",
    date: "2026-08-01T00:00:00Z",
  }));

  return {
    id: "hunt-1",
    repoUrl: "https://github.com/faultline-bench/tzdata-pipeline",
    testCommand: "pytest tests/test_window.py::test_daily_boundary",
    goodRef: "v1.4.0",
    goodSha: "c".repeat(40),
    badRef: "HEAD",
    installCommand: "pip install -e .[test]",
    status: "done",
    commits,
    bandSize: 8,
    slots: 8,
    backend: "nebius-serverless-jobs",
    regions: ["eu-west1"],
    probeTimeoutSeconds: 900,
    probeSha256: "0".repeat(64),
    tickUrl: null,
    pause: null,
    probes: [probe(7, "pass"), probe(14, "fail")],
    round: 2,
    lowIndex: 12,
    highIndex: 13,
    report: {
      culpritSha: commits[12]?.sha ?? "",
      culpritSubject: "change 13",
      culpritAuthor: "Dana",
      culpritDate: "2026-08-05T00:00:00Z",
      diffText: "diff --git a/x b/x",
      rootCauseMd: "The replace(tzinfo=) call keeps the local offset, so the boundary shifts.",
      modelId: "nvidia/nemotron-3-super-120b-a12b",
      narrationProvider: "nebius-token-factory",
      narrationRequestId: "chatcmpl-1",
      narrationError: null,
    },
    inconclusive: null,
    createdAt: "2026-09-04T10:00:00Z",
    finishedAt: "2026-09-04T10:02:00Z",
    wallClockMs: 120_000,
    costUsd: 0.0011,
    recorded: false,
    recordedAt: null,
    ...overrides,
  };
}

describe("renderIssue", () => {
  it("leads with the culprit and carries the facts a maintainer needs", () => {
    const md = renderIssue(hunt());

    expect(md).toContain("Regression bisected to");
    expect(md).toContain("change 13");
    expect(md).toContain("pytest tests/test_window.py::test_daily_boundary");
    expect(md).toContain("64 commits");
    expect(md).toContain("v1.4.0");
  });

  it("attributes the generated paragraph to the model, and the commit to execution", () => {
    const md = renderIssue(hunt());

    expect(md).toContain("The replace(tzinfo=) call keeps the local offset");
    expect(md).toContain("nvidia/nemotron-3-super-120b-a12b on Nebius Token Factory");
    // The distinction the whole report rests on: prose is generated, the commit is not.
    expect(md).toContain("established by running the test, not by a model");
  });

  it("includes the evidence trail with the Nebius job ids", () => {
    const md = renderIssue(hunt());

    expect(md).toContain("Evidence trail");
    expect(md).toContain("computejob-e00000007");
    expect(md).toContain("computejob-e00000014");
  });

  it("omits the explanation section rather than inventing prose when narration failed", () => {
    const base = hunt();
    const md = renderIssue({
      ...base,
      report: base.report
        ? { ...base.report, rootCauseMd: null, narrationError: "the narration job timed out" }
        : null,
    });

    expect(md).toContain("No generated explanation");
    expect(md).not.toContain("nvidia/nemotron-3-super-120b-a12b");
    expect(md).toContain("Evidence trail");
  });

  it("states that both ends were tested rather than assumed", () => {
    // Endpoints are probed in round 1, so an edge culprit needs no caveat — the report says
    // what was proven instead.
    const md = renderIssue(hunt());
    expect(md).toContain("Both ends were tested, not assumed");
    expect(md).not.toContain("Worth knowing");
  });

  it("records the install command every probe ran, and labels the endpoint probes", () => {
    const base = hunt();
    const md = renderIssue({
      ...base,
      probes: [{ ...probe(0, "pass"), role: "good" }, ...base.probes, { ...probe(64, "fail"), role: "bad" }],
    });
    expect(md).toContain("`pip install -e .[test]`");
    expect(md).toContain("(known good)");
    expect(md).toContain("(failing ref)");
  });

  it("shows an untestable commit as a skip, not an error", () => {
    const base = hunt();
    const md = renderIssue({ ...base, probes: [...base.probes, probe(20, "error")] });
    expect(md).toContain("| skip |");
  });

  it("renders an em dash for a probe with no measured duration", () => {
    const base = hunt();
    const md = renderIssue({
      ...base,
      probes: [{ ...probe(7, "pass"), durationMs: null, jobId: null }],
    });

    expect(md).toContain("| — |");
  });

  it("returns an empty string for a hunt with no report", () => {
    expect(renderIssue(hunt({ report: null }))).toBe("");
  });
});
