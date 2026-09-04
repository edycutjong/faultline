"use client";

/**
 * One hunt, rendered.
 *
 * Shared deliberately between the recorded example on the landing page and the live hunt
 * page: a replay and a live run are the same product, so they must be the same component.
 * The only difference is the label above it, which the caller supplies.
 */

import type { Hunt } from "@/lib/types";
import { StatusLine } from "./StatusLine";
import { Timeline, TimelineLegend } from "./Timeline";
import { ProbeList } from "./ProbeList";
import { FaultReportView } from "./FaultReportView";
import { InconclusiveView } from "./InconclusiveView";
import { formatDuration, isActive } from "./format";

function StatusBadge({ hunt }: { hunt: Hunt }) {
  const map: Record<Hunt["status"], { text: string; color: string }> = {
    planning: { text: "planning", color: "var(--muted)" },
    running: { text: "running", color: "var(--accent)" },
    narrating: { text: "narrating", color: "var(--accent)" },
    done: { text: "culprit found", color: "var(--guilty)" },
    inconclusive: { text: "inconclusive", color: "var(--inconclusive)" },
    error: { text: "stopped", color: "var(--muted)" },
  };
  const badge = map[hunt.status];
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-line px-3 py-1 text-[12px] text-muted">
      <span
        aria-hidden="true"
        className={`inline-block h-2 w-2 rounded-full ${isActive(hunt.status) ? "animate-pulse" : ""}`}
        style={{ background: badge.color }}
      />
      {badge.text}
    </span>
  );
}

export function HuntView({
  hunt,
  label,
  showProbeList = true,
}: {
  hunt: Hunt;
  /** e.g. "recorded run, 2026-08-29" — rendered above the timeline. Never omitted for replays. */
  label?: React.ReactNode;
  showProbeList?: boolean;
}) {
  const showReport = hunt.report !== null;
  const showInconclusive = hunt.inconclusive !== null;

  return (
    <div className="flex flex-col gap-8">
      <section
        aria-labelledby="hunt-timeline"
        className="rounded-card border border-line bg-surface px-6 py-6"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="hunt-timeline" className="sr-only">
              Commit timeline and search status
            </h2>
            <p className="truncate font-mono text-[13px] text-muted">
              {hunt.repoUrl.replace("https://github.com/", "")} · {hunt.testCommand}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {label}
            <StatusBadge hunt={hunt} />
          </div>
        </div>

        <div className="mt-5">
          <StatusLine hunt={hunt} />
        </div>

        <div className="mt-6">
          <Timeline hunt={hunt} />
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-4 border-t border-line pt-4">
          <TimelineLegend />
          <p className="font-mono text-[13px] text-muted">
            {hunt.commits.length} commits · wall clock {formatDuration(hunt.wallClockMs)}
          </p>
        </div>
      </section>

      {showInconclusive ? <InconclusiveView hunt={hunt} /> : null}
      {showReport ? <FaultReportView hunt={hunt} /> : null}

      {showProbeList && !showReport && !showInconclusive ? (
        <section
          aria-labelledby="probe-list"
          className="rounded-card border border-line bg-surface px-6 py-6"
        >
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
            <h2 id="probe-list" className="text-[15px] font-semibold">
              Probes
            </h2>
            <p className="text-[13px] text-muted">
              The Nebius job ID is on screen because it is the proof each probe was a cloud
              container.
            </p>
          </div>
          <ProbeList hunt={hunt} />
        </section>
      ) : null}
    </div>
  );
}
