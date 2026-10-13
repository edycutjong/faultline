/**
 * The replay is a filter over the recording — never an invention.
 */

import { describe, it, expect } from "vitest";
import { formatElapsed, replayFrames } from "@/lib/replay";
import { newHunt } from "@/lib/hunt";
import type { Hunt } from "@/lib/types";
import { probe, shaFor, syntheticCommits } from "./helpers";

function recorded(): Hunt {
  const base = newHunt({
    repoUrl: "https://github.com/a/b", testCommand: "pytest", goodRef: "v1", goodSha: shaFor(0),
    badRef: "HEAD", commits: syntheticCommits(64), slots: 8, backend: "fake", regions: ["eu-west1"],
    now: new Date("2026-10-13T10:00:00Z"),
  });
  const r1 = [0, 9, 18, 27, 37, 46, 55, 64].map((i) =>
    probe(i, i >= 30 ? "fail" : "pass", {
      round: 1, role: i === 0 ? "good" : i === 64 ? "bad" : "interior",
      dispatchedAt: "2026-10-13T10:00:05.000Z", finishedAt: "2026-10-13T10:04:40.000Z",
    }),
  );
  const r2 = [28, 29].map((i) =>
    probe(i, i >= 30 ? "fail" : "pass", { round: 2, dispatchedAt: "2026-10-13T10:04:45.000Z", finishedAt: "2026-10-13T10:09:30.000Z" }),
  );
  return {
    ...base, status: "done", round: 2, probes: [...r1, ...r2], lowIndex: 29, highIndex: 30,
    wallClockMs: 570_000, costUsd: 0.04, recorded: true, recordedAt: "2026-10-13",
    report: { culpritSha: shaFor(30), culpritSubject: "change number 30", culpritAuthor: "a", culpritDate: "d", diffText: "", rootCauseMd: "why", modelId: "m", narrationProvider: "p", narrationRequestId: "r", narrationError: null },
  };
}

describe("replayFrames", () => {
  it("steps start → each round dispatched → each round resolved, ending on the recording itself", () => {
    const hunt = recorded();
    const frames = replayFrames(hunt);
    expect(frames.map((f) => f.caption)).toEqual([
      "64 suspect commits · nothing dispatched yet",
      "round 1 · 8 probes dispatched",
      "round 1 · verdicts in · 10 commits still suspect",
      "round 2 · 2 probes dispatched",
      "round 2 · verdicts in · one commit named",
    ]);
    expect(frames.at(-1)?.hunt).toBe(hunt);
  });

  it("shows a round's probes pending before their verdicts, and narrows only on what had landed", () => {
    const frames = replayFrames(recorded());
    const dispatched = frames[1]?.hunt;
    expect(dispatched?.probes.every((p) => p.verdict === null)).toBe(true);
    expect([dispatched?.lowIndex, dispatched?.highIndex]).toEqual([0, 64]);
    const resolved = frames[2]?.hunt;
    expect([resolved?.lowIndex, resolved?.highIndex]).toEqual([27, 37]);
    expect(resolved?.report).toBeNull();
  });

  it("labels every frame with the real elapsed time the recording holds", () => {
    const frames = replayFrames(recorded());
    expect(frames.map((f) => formatElapsed(f.elapsedMs))).toEqual(["+00:00", "+00:05", "+04:40", "+04:45", "+09:30"]);
  });
});
