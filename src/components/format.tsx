/**
 * Shared formatting + derivation helpers for the Faultline UI.
 *
 * Rule for this whole surface: no number is rendered that was not computed from real data.
 * Every "unknown" path in here returns an em dash rather than a plausible-looking value.
 */

import type { Commit, Hunt, Probe, Verdict } from "@/lib/types";
import { DEFAULT_BAND_SIZE, estimateRounds } from "@/lib/planner";

export const EM_DASH = "—";

export type TickState = "unknown" | "innocent" | "guilty" | "error" | "pending";

export const VERDICT_LABEL: Record<Verdict, string> = {
  pass: "pass",
  fail: "fail",
  error: "error",
};

export function shortSha(sha: string): string {
  return sha ? sha.slice(0, 7) : EM_DASH;
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return EM_DASH;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Costs are sub-cent. Four decimals is the resolution the billing data actually has. */
export function formatCost(usd: number | null): string {
  if (usd === null || !Number.isFinite(usd)) return EM_DASH;
  return `$${usd.toFixed(4)}`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return EM_DASH;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return EM_DASH;
  return date.toISOString().replace("T", " ").slice(0, 16) + "Z";
}

export function formatDay(iso: string | null): string {
  if (!iso) return EM_DASH;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return EM_DASH;
  return date.toISOString().slice(0, 10);
}

export function isActive(status: Hunt["status"]): boolean {
  return status === "planning" || status === "running" || status === "narrating";
}

/** Probe keyed by commit index — the timeline asks this question once per tick. */
export function probesByIndex(probes: readonly Probe[]): Map<number, Probe> {
  const map = new Map<number, Probe>();
  for (const probe of probes) {
    const existing = map.get(probe.commitIndex);
    // Later rounds win; a re-probed index shows its most recent answer.
    if (!existing || probe.round >= existing.round) map.set(probe.commitIndex, probe);
  }
  return map;
}

export function tickState(probe: Probe | undefined): TickState {
  if (!probe) return "unknown";
  if (probe.verdict === "pass") return "innocent";
  if (probe.verdict === "fail") return "guilty";
  if (probe.verdict === "error") return "error";
  return "pending";
}

export function tickColor(state: TickState): string {
  switch (state) {
    case "innocent":
      return "var(--innocent)";
    case "guilty":
      return "var(--guilty)";
    case "error":
      return "var(--inconclusive)";
    default:
      return "var(--unknown)";
  }
}

/**
 * The culprit lies in the half-open interval (lowIndex, highIndex]: lowIndex is the highest
 * index proven good, highIndex the lowest proven bad. Anything outside is eliminated.
 */
export function isLive(hunt: Hunt, index: number): boolean {
  return index > hunt.lowIndex && index <= hunt.highIndex;
}

export interface StatusFacts {
  round: number;
  totalRounds: number;
  probesComplete: number;
  probesTotal: number;
  commitsRemaining: number;
  costUsd: number | null;
}

/**
 * Every number in the status line, derived. The round estimate comes from the same
 * `estimateRounds` the search itself is planned by, so the UI can never disagree with it.
 */
export function statusFacts(hunt: Hunt): StatusFacts {
  return {
    round: Math.max(hunt.round, 1),
    totalRounds: estimateRounds(hunt.commits.length, DEFAULT_BAND_SIZE),
    probesComplete: hunt.probes.filter((p) => p.verdict !== null).length,
    probesTotal: hunt.probes.length,
    commitsRemaining: Math.max(hunt.highIndex - hunt.lowIndex, 0),
    costUsd: hunt.costUsd,
  };
}

export function commitBySha(commits: readonly Commit[], sha: string): Commit | undefined {
  return commits.find((c) => c.sha === sha);
}
