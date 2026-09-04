"use client";

/**
 * The status line above the timeline.
 *
 * Shape, fixed by specs/ui.md and on screen in the demo video:
 *   Round 2 of ~3 · 8 probes complete · ~28 commits remaining · $0.0041 so far
 *
 * The round estimate is `estimateRounds(commits.length, DEFAULT_BAND_SIZE)` — the same
 * function the search is planned by — so it can never disagree with the search. With 8
 * parallel probes a range divides by N+1 = 9, so 256 -> ~28 -> ~3 -> 1. Nothing here is
 * hard-coded, and a cost that has not been measured renders as an em dash.
 */

import type { Hunt } from "@/lib/types";
import { EM_DASH, formatCost, isActive, statusFacts } from "./format";

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

  if (active) {
    lead = (
      <>
        Round {f.round} of ~{f.totalRounds}
      </>
    );
    remaining = <>~{f.commitsRemaining} commits remaining</>;
    costSuffix = "so far";
  } else if (hunt.status === "done") {
    lead = <>Settled in {f.round} rounds</>;
    remaining = <>1 commit named</>;
    costSuffix = "total";
  } else if (hunt.status === "inconclusive") {
    lead = <>Stopped after {f.round} rounds</>;
    remaining = <>no culprit named</>;
    costSuffix = "total";
  } else {
    lead = <>Halted in round {f.round}</>;
    remaining = <>{f.commitsRemaining} commits unresolved</>;
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
      <span>{f.probesComplete} probes complete</span>
      <Dot />
      <span>{remaining}</span>
      <Dot />
      <span className={cost === EM_DASH ? "text-muted" : undefined}>
        {cost} {costSuffix}
      </span>
    </p>
  );
}
