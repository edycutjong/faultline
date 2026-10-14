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

interface LatestSandbox {
  id: string;
  state: string;
  createdAt: string | null;
  durationSeconds: number | null;
}

interface VerifyResponse {
  nebiusConfigured: boolean;
  probeBackend?: { active: string | null; requested: string };
  latestSandboxes?: { readAt: string | null; operations: LatestSandbox[]; unavailable: boolean } | null;
  tokenFactoryConfigured?: boolean;
  region: string | null;
  probeRegions?: string[];
  probeCapacity?: number;
  surfaces: Surface[];
  latestJobs?: { readAt: string | null; jobs: LatestJob[]; unavailableRegions?: string[] };
}

/** The active probe backend, named the way the surfaces below name it. */
function backendLabel(data: VerifyResponse): string {
  if (data.probeBackend?.active === "nebius-tokenfactory-sandboxes") return "probes on Token Factory Sandboxes";
  return `probes on Serverless AI Jobs in ${(data.probeRegions ?? [data.region ?? "—"]).join(", ")}`;
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
              ? `credentials configured · ${backendLabel(data)} · ${data.probeCapacity ?? "—"} slots`
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
        {data?.latestSandboxes && data.latestSandboxes.operations.length > 0 ? (
          <div className="mb-3">
            <p className="text-[13px] text-muted">
              Latest probe sandboxes, read from Token Factory Sandboxes at {utcMinute(data.latestSandboxes.readAt)}:
            </p>
            <ul className="mt-2 grid gap-y-2 font-mono text-[12px] text-muted md:grid-cols-[max-content_max-content_max-content_1fr] md:gap-x-6 md:gap-y-1">
              {data.latestSandboxes.operations.slice(0, 4).map((op) => (
                <li key={op.id} className="flex flex-wrap gap-x-3 md:contents">
                  <span className="whitespace-nowrap text-text">{op.id}</span>
                  <span className="whitespace-nowrap">{op.state.toLowerCase()}</span>
                  <span className="whitespace-nowrap">{op.durationSeconds === null ? "—" : `${op.durationSeconds.toFixed(1)} s`}</span>
                  <span className="whitespace-nowrap">{utcMinute(op.createdAt)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {data?.latestJobs && data.latestJobs.jobs.length > 0 ? (
          <>
            <p className="text-[13px] text-muted">
              Latest probe jobs, read from the Nebius Jobs API at {utcMinute(data.latestJobs.readAt)}:
            </p>
            {/* One grid for every row on wide screens, so the columns line up; a phone stacks each row. */}
            <ul className="mt-2 grid gap-y-2 font-mono text-[12px] text-muted md:grid-cols-[max-content_max-content_max-content_1fr] md:gap-x-6 md:gap-y-1">
              {data.latestJobs.jobs.slice(0, 4).map((job) => (
                <li key={job.id} className="flex flex-wrap gap-x-3 md:contents">
                  <span className="whitespace-nowrap text-text">{job.id}</span>
                  <span className="whitespace-nowrap">{job.region}</span>
                  <span className="whitespace-nowrap">{job.state.toLowerCase()}</span>
                  <span className="whitespace-nowrap">{utcMinute(job.createdAt)}</span>
                </li>
              ))}
            </ul>
            {data.latestJobs.unavailableRegions && data.latestJobs.unavailableRegions.length > 0 ? (
              <p className="mt-2 text-[13px] text-muted">
                Not answering just now, so their newest jobs may be missing:{" "}
                {data.latestJobs.unavailableRegions.join(", ")}.
              </p>
            ) : null}
          </>
        ) : null}
        <p className={`text-[13px] text-muted${data?.latestJobs && data.latestJobs.jobs.length > 0 ? " mt-1" : ""}`}>
          The full report:{" "}
          {/* 40px tall like every other tap target on the page, though it sits in a sentence. */}
          <a
            href="/api/integrations/verify"
            className="link-quiet inline-flex min-h-[40px] items-center font-mono text-[12px] underline underline-offset-2 hover:text-text"
          >
            /api/integrations/verify
          </a>
        </p>
      </footer>
    </section>
  );
}
