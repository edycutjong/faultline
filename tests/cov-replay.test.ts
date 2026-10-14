import { describe, it, expect } from "vitest";
import { formatElapsed, replayFrames } from "@/lib/replay";
import { newHunt } from "@/lib/hunt";
import type { Hunt } from "@/lib/types";
import { probe, shaFor, syntheticCommits } from "./helpers";

function base(): Hunt {
  return newHunt({
    repoUrl: "https://github.com/a/b", testCommand: "pytest", goodRef: "v1", goodSha: shaFor(0),
    badRef: "HEAD", commits: syntheticCommits(8), slots: 4, backend: "fake", regions: ["eu-west1"],
    now: new Date("2026-10-13T10:00:00Z"),
  });
}

function withProbes(over: Partial<Hunt>, probeOver: Record<string, unknown> = {}): Hunt {
  return {
    ...base(),
    status: "done",
    round: 1,
    probes: [probe(4, "fail", { round: 1, dispatchedAt: "2026-10-13T10:00:05.000Z", finishedAt: "2026-10-13T10:00:30.000Z", ...probeOver })],
    ...over,
  };
}

describe("replayFrames edge cases", () => {
  it("labels a last round without a report as 'no single commit named'", () => {
    const frames = replayFrames(withProbes({ report: null }));
    expect(frames.map((f) => f.caption)).toEqual([
      "8 suspect commits · nothing dispatched yet",
      "round 1 · 1 probes dispatched",
      "round 1 · verdicts in · no single commit named",
    ]);
    expect(frames.map((f) => f.elapsedMs)).toEqual([0, 5000, 30000]);
  });

  it("gives null elapsed when the hunt's createdAt is unparseable", () => {
    const frames = replayFrames(withProbes({ createdAt: "not-a-date" }));
    expect(frames.map((f) => f.elapsedMs)).toEqual([0, null, null]);
  });

  it("gives null elapsed when the hunt has no createdAt", () => {
    const frames = replayFrames(withProbes({ createdAt: null as unknown as string }));
    expect(frames[1]?.elapsedMs).toBeNull();
  });

  it("gives null elapsed when probes carry no timestamps", () => {
    const frames = replayFrames(withProbes({}, { dispatchedAt: null, finishedAt: null }));
    expect(frames[1]?.elapsedMs).toBeNull();
    expect(frames[2]?.elapsedMs).toBeNull();
  });

  it("treats an unparseable probe timestamp as missing", () => {
    const frames = replayFrames(withProbes({}, { dispatchedAt: "garbage", finishedAt: "garbage" }));
    expect(frames[1]?.elapsedMs).toBeNull();
    expect(frames[2]?.elapsedMs).toBeNull();
  });

  it("clamps elapsed time at zero when a probe predates the hunt", () => {
    const frames = replayFrames(withProbes({}, { dispatchedAt: "2026-10-13T09:00:00.000Z", finishedAt: "2026-10-13T09:00:01.000Z" }));
    expect(frames[1]?.elapsedMs).toBe(0);
    expect(frames[2]?.elapsedMs).toBe(0);
  });

  it("skips rounds that have no probes and ignores inconclusive verdicts when narrowing", () => {
    const hunt = withProbes({ round: 3, report: null }, { round: 3, verdict: "error" });
    const frames = replayFrames(hunt);
    expect(frames).toHaveLength(3);
    expect(frames[1]?.caption).toBe("round 3 · 1 probes dispatched");
    expect([frames[1]?.hunt.lowIndex, frames[1]?.hunt.highIndex]).toEqual([0, 8]);
  });

  it("shows the narrowed bounds on an intermediate resolved frame", () => {
    const hunt = withProbes({ round: 2, report: null });
    hunt.probes.push(probe(2, "pass", { round: 2, dispatchedAt: "2026-10-13T10:01:00.000Z", finishedAt: "2026-10-13T10:01:10.000Z" }));
    const frames = replayFrames(hunt);
    expect(frames[2]?.caption).toBe("round 1 · verdicts in · 4 commits still suspect");
    expect([frames[3]?.hunt.lowIndex, frames[3]?.hunt.highIndex]).toEqual([0, 4]);
  });
});

describe("formatElapsed", () => {
  it("returns empty for null and pads mm:ss otherwise", () => {
    expect(formatElapsed(null)).toBe("");
    expect(formatElapsed(65_400)).toBe("+01:05");
    expect(formatElapsed(0)).toBe("+00:00");
  });
});
