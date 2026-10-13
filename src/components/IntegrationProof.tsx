"use client";

/**
 * The sponsor-integration proof strip.
 *
 * A judge should be able to confirm in thirty seconds that Nebius is the engine and not a
 * badge, without reading code. Everything here is read from `GET /api/integrations/verify`,
 * which reports the surfaces actually used and the latest probe jobs, read live from the Nebius
 * Jobs API — including the case where no credentials are configured, which it states rather
 * than hides.
 */

import { useEffect, useState } from "react";

interface Surface {
  surface: string;
  api: string;
  usedFor: string;
  platform: string | null;
}

interface LatestJob {
  id: string;
  region: string;
  state: string;
  createdAt: string | null;
}

interface VerifyResponse {
  nebiusConfigured: boolean;
  tokenFactoryConfigured?: boolean;
  region: string | null;
  probeRegions?: string[];
  probeCapacity?: number;
  surfaces: Surface[];
  latestJobs?: { readAt: string | null; jobs: LatestJob[] };
}

/** `2026-10-13 16:22 UTC` — the API's own timestamp, not the visitor's clock. */
function utcMinute(iso: string | null): string {
  return iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "—";
}

export function IntegrationProof() {
  const [data, setData] = useState<VerifyResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/integrations/verify")
      .then((r) => r.json() as Promise<VerifyResponse>)
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) return null;

  return (
    <section aria-labelledby="integration" className="rounded-card border border-line bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-4">
        <h2 id="integration" className="text-[15px] font-semibold">
          What Nebius actually runs
        </h2>
        <p className="font-mono text-[12px] text-muted">
          {data === null
            ? "loading…"
            : data.nebiusConfigured
              ? `credentials configured · probes in ${(data.probeRegions ?? [data.region ?? "—"]).join(", ")} · ${data.probeCapacity ?? "—"} slots`
              : "no credentials on this deploy · surfaces listed from the code path"}
        </p>
      </header>

      <ul className="divide-y divide-[color:var(--border)]">
        {(data?.surfaces ?? []).map((surface) => (
          <li key={surface.surface} className="grid gap-2 px-6 py-4 md:grid-cols-[240px_1fr]">
            <div>
              <p className="text-[14px] font-medium">{surface.surface}</p>
              {surface.platform ? (
                <p className="mt-1 font-mono text-[12px] text-muted">{surface.platform}</p>
              ) : null}
            </div>
            <div>
              <p className="font-mono text-[12px] text-muted">{surface.api}</p>
              <p className="mt-1.5 text-[14px] leading-relaxed text-text">{surface.usedFor}</p>
            </div>
          </li>
        ))}
        {data === null ? (
          <li className="px-6 py-4 text-[14px] text-muted">Reading the integration report…</li>
        ) : null}
      </ul>

      <footer className="border-t border-line px-6 py-4">
        {data?.latestJobs && data.latestJobs.jobs.length > 0 ? (
          <>
            <p className="text-[13px] text-muted">
              Latest probe jobs, read from the Nebius Jobs API at {utcMinute(data.latestJobs.readAt)}:
            </p>
            <ul className="mt-2 grid gap-1 font-mono text-[12px] text-muted">
              {data.latestJobs.jobs.slice(0, 4).map((job) => (
                <li key={job.id} className="flex flex-wrap gap-x-3">
                  <span className="text-text">{job.id}</span>
                  <span>{job.region}</span>
                  <span>{job.state.toLowerCase()}</span>
                  <span>{utcMinute(job.createdAt)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[13px] text-muted">The full report is at /api/integrations/verify.</p>
          </>
        ) : (
          <p className="text-[13px] text-muted">The full report is at /api/integrations/verify.</p>
        )}
      </footer>
    </section>
  );
}
