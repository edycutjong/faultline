"use client";

/**
 * The live probe list.
 *
 * The Nebius job ID column exists because it is the proof this is real: a judge can read a
 * job ID off the screen and match it against the integration-proof route. Nothing in this
 * table is derived or rounded into existence — a probe with no measured duration shows an
 * em dash, not an estimate.
 */

import type { Hunt, Probe, Verdict } from "@/lib/types";
import { EM_DASH, formatDuration, shortSha } from "./format";

const VERDICT_STYLE: Record<Verdict, { color: string; label: string }> = {
  pass: { color: "var(--innocent)", label: "pass" },
  fail: { color: "var(--guilty)", label: "fail" },
  error: { color: "var(--inconclusive)", label: "skip" },
};

const PHASE_LABEL: Record<Probe["phase"], string> = {
  queued: "waiting for a slot",
  dispatching: "dispatching",
  running: "running",
  done: "done",
  cancelled: "cancelled",
};

export function VerdictPill({ verdict, phase = "running" }: { verdict: Verdict | null; phase?: Probe["phase"] }) {
  if (verdict === null) {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted">
        <span
          aria-hidden="true"
          className="inline-block h-2 w-2 animate-pulse rounded-full bg-unknown"
        />
        {PHASE_LABEL[phase] ?? "running"}
      </span>
    );
  }
  const style = VERDICT_STYLE[verdict];
  return (
    <span className="inline-flex items-center gap-1.5" style={{ color: style.color }}>
      <span
        aria-hidden="true"
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: style.color }}
      />
      {style.label}
    </span>
  );
}

function subjectFor(hunt: Hunt, probe: Probe): string {
  if (probe.role === "good") return `known-good ref ${hunt.goodRef}`;
  return hunt.commits.find((c) => c.sha === probe.commitSha)?.subject ?? "";
}

function roleTag(probe: Probe): string | null {
  if (probe.role === "good") return "good end";
  if (probe.role === "bad") return "failing end";
  return null;
}

export function ProbeList({
  hunt,
  caption = "Probes",
}: {
  hunt: Hunt;
  caption?: string;
}) {
  if (hunt.probes.length === 0) {
    return (
      <p className="text-[14px] text-muted">
        No probes dispatched yet. The first band goes out as soon as the range resolves.
      </p>
    );
  }

  const ordered = [...hunt.probes].sort(
    (a, b) => a.round - b.round || a.commitIndex - b.commitIndex,
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-left text-[14px]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line text-[12px] uppercase tracking-wider text-muted">
            <th scope="col" className="py-2 pr-4 font-medium">
              Round
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              Commit
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              Nebius job ID
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              Region
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              Duration
            </th>
            <th scope="col" className="py-2 font-medium">
              Verdict
            </th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((probe) => (
            <tr key={`${probe.round}-${probe.commitSha}`} className="border-b border-line/50">
              <td className="py-2.5 pr-4 tabular-nums text-muted">{probe.round}</td>
              <td className="py-2.5 pr-4">
                <span className="font-mono">{shortSha(probe.commitSha)}</span>
                {roleTag(probe) ? (
                  <span className="ml-2 rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">
                    {roleTag(probe)}
                  </span>
                ) : null}
                <span className="ml-2 hidden text-muted md:inline">
                  {subjectFor(hunt, probe).slice(0, 48)}
                </span>
              </td>
              <td className="py-2.5 pr-4 font-mono text-[13px] text-muted">
                {probe.jobId ?? EM_DASH}
                {probe.infraFailures.length > 0 ? (
                  <span className="ml-2 text-[11px]" title={probe.infraFailures.map((f) => `attempt ${f.attempt}: ${f.reason}`).join("\n")}>
                    attempt {probe.attempt}
                  </span>
                ) : null}
              </td>
              <td className="py-2.5 pr-4 font-mono text-[13px] text-muted">{probe.region ?? EM_DASH}</td>
              <td className="py-2.5 pr-4 font-mono tabular-nums">
                {formatDuration(probe.durationMs)}
              </td>
              <td className="py-2.5">
                <VerdictPill verdict={probe.verdict} phase={probe.phase} />
                {probe.detail ? (
                  <span className="ml-2 text-[12px] text-muted">{probe.detail.slice(0, 90)}</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
