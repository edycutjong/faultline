"use client";

/**
 * The status line above the timeline.
 *
 * Shape:
 *   Round 2 of ~3 · 8 probes complete · ~28 commits remaining · $0.0041 so far
 *
 * The round estimate is `estimateRounds(commits.length, DEFAULT_BAND_SIZE)` — the same
 * function the search is planned by — so it can never disagree with the search. With 8
 * parallel probes a range divides by N+1 = 9, so 256 -> ~28 -> ~3 -> 1. Nothing here is
 * hard-coded, and a cost that has not been measured renders as an em dash.
 */

import type { Hunt } from "@/lib/types";
import { EM_DASH, formatCost, isActive, statusFacts } from "./format";

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function Dot() {
  return (
    <span aria-hidden="true" className="px-2 text-unknown">
      ·
    </span>
  );
}

export function StatusLine({ hunt }: { hunt: Hunt }) {
  const f = statusFacts(hunt);
  const cost = formatCost(f.costUsd);
  const active = isActive(hunt.status);

  let lead: React.ReactNode;
  let remaining: React.ReactNode;
  let costSuffix: string;

  // A named culprit ends the search even while narration is still running, so the line stops
  // counting rounds the moment there is a report rather than implying more probing to come.
  const settled = hunt.report !== null;

  if (settled) {
    lead = <>Settled in {plural(f.round, "round")}</>;
    remaining = <>1 commit named</>;
    costSuffix = hunt.status === "narrating" ? "so far" : "total";
  } else if (active) {
    lead = (
      <>
        Round {f.round} of ~{f.totalRounds}
      </>
    );
    remaining = (
      <>
        ~{f.commitsRemaining} {f.commitsRemaining === 1 ? "commit" : "commits"} remaining
      </>
    );
    costSuffix = "so far";
  } else if (hunt.status === "inconclusive") {
    lead = <>Stopped after {plural(f.round, "round")}</>;
    remaining = <>no culprit named</>;
    costSuffix = "total";
  } else {
    lead = <>Halted in round {f.round}</>;
    remaining = (
      <>
        {f.commitsRemaining} {f.commitsRemaining === 1 ? "commit" : "commits"} unresolved
      </>
    );
    costSuffix = "total";
  }

  return (
    <p
      aria-live="polite"
      aria-atomic="true"
      className="font-mono text-[20px] leading-snug tracking-tight text-text max-md:text-[16px]"
    >
      <span>{lead}</span>
      <Dot />
      <span>{plural(f.probesComplete, "probe")} complete</span>
      <Dot />
      <span>{remaining}</span>
      <Dot />
      <span className={cost === EM_DASH ? "text-muted" : undefined}>
        {cost} {costSuffix}
      </span>
    </p>
  );
}
