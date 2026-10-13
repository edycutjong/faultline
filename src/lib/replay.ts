/**
 * Replaying a recorded hunt, round by round.
 *
 * Pure reconstruction from the recording itself: every frame is the hunt as it stood at a
 * moment that really happened — a round's probes dispatched, then their verdicts landed — with
 * the real time since the hunt started. Nothing is interpolated or invented; a frame is a
 * filter over the recorded probes plus the planner's own narrowing.
 */

import type { Hunt, Probe } from "@/lib/types";
import { narrow } from "@/lib/planner";

export interface ReplayFrame {
  hunt: Hunt;
  /** What this frame shows, in the words the status label uses. */
  caption: string;
  /** Real elapsed time since the hunt was created, when the recording says so. */
  elapsedMs: number | null;
}

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function boundsAfter(hunt: Hunt, probes: readonly Probe[]) {
  const decided = probes
    .filter((p) => p.verdict === "pass" || p.verdict === "fail")
    .map((p) => ({ index: p.commitIndex, verdict: p.verdict as "pass" | "fail" }));
  return narrow(0, hunt.commits.length, decided);
}

/** Frames for a finished recording: start, then each round dispatched and resolved, then the end. */
export function replayFrames(hunt: Hunt): ReplayFrame[] {
  const start = ms(hunt.createdAt);
  const since = (t: number | null) => (start !== null && t !== null ? Math.max(0, t - start) : null);
  const frames: ReplayFrame[] = [];
  const blank = {
    report: null,
    inconclusive: null,
    pause: null,
    finishedAt: null,
    wallClockMs: null,
    costUsd: null,
  };

  frames.push({
    hunt: { ...hunt, ...blank, status: "running", round: 0, probes: [], lowIndex: 0, highIndex: hunt.commits.length },
    caption: `${hunt.commits.length} suspect commits · nothing dispatched yet`,
    elapsedMs: 0,
  });

  for (let round = 1; round <= hunt.round; round += 1) {
    const earlier = hunt.probes.filter((p) => p.round < round);
    const current = hunt.probes.filter((p) => p.round === round);
    if (current.length === 0) continue;
    const before = boundsAfter(hunt, earlier);
    const dispatched = Math.min(...current.map((p) => ms(p.dispatchedAt) ?? Infinity));
    frames.push({
      hunt: {
        ...hunt,
        ...blank,
        status: "running",
        round,
        lowIndex: before.lowIndex,
        highIndex: before.highIndex,
        probes: [
          ...earlier,
          ...current.map((p) => ({
            ...p,
            phase: "running" as const,
            verdict: null,
            detail: null,
            finishedAt: null,
            durationMs: null,
            vmMs: null, // not yet known at this moment: the replay prices only what had happened
          })),
        ],
      },
      caption: `round ${round} · ${current.length} probes dispatched`,
      elapsedMs: since(Number.isFinite(dispatched) ? dispatched : null),
    });

    const last = round === hunt.round;
    const after = boundsAfter(hunt, [...earlier, ...current]);
    const landed = Math.max(...current.map((p) => ms(p.finishedAt) ?? -Infinity));
    frames.push({
      hunt: last
        ? hunt
        : { ...hunt, ...blank, status: "running", round, lowIndex: after.lowIndex, highIndex: after.highIndex, probes: [...earlier, ...current] },
      caption: last
        ? hunt.report
          ? `round ${round} · verdicts in · one commit named`
          : `round ${round} · verdicts in · no single commit named`
        : `round ${round} · verdicts in · ${after.highIndex - after.lowIndex} commits still suspect`,
      elapsedMs: since(Number.isFinite(landed) ? landed : null),
    });
  }

  return frames;
}

/** `+mm:ss` of real time, for the replay label. */
export function formatElapsed(elapsedMs: number | null): string {
  if (elapsedMs === null) return "";
  const total = Math.round(elapsedMs / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `+${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
