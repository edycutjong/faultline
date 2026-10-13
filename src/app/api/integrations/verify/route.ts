/**
 * GET /api/integrations/verify — judge-facing proof that the Nebius integration is real.
 *
 * A *view*, not a subsystem: the surfaces Faultline calls, where each is configured, and the
 * latest probe jobs read live from the Nebius Jobs API (`latestJobs`). A judge can confirm in
 * thirty seconds that jobs were really created, without reading code. `recentCalls` is only this
 * instance's own Nebius calls — this view's list reads included — with query strings dropped.
 * No credential or credential-shaped value is returned.
 */

import { NextResponse } from "next/server";
import { recentCalls } from "@/lib/nebius/jobs";
import { NARRATION_MODEL, PROBE_PLATFORM, PROBE_PRESET } from "@/lib/nebius/config";
import { recentProbeJobs } from "@/lib/nebius/recent-jobs";
import { storeContext } from "@/lib/store";
import { PROBE_SHA256 } from "@/lib/probe-source";

export const dynamic = "force-dynamic";

export async function GET() {
  const ctx = storeContext();
  const regions = ctx.config?.probeRegions.map((r) => r.region) ?? [];
  const latest = ctx.config ? await recentProbeJobs(ctx.config) : null;
  const model = ctx.tokenFactory?.model ?? NARRATION_MODEL;

  return NextResponse.json({
    nebiusConfigured: ctx.config !== null,
    tokenFactoryConfigured: ctx.tokenFactory !== null,
    region: ctx.config?.region ?? null,
    probeRegions: regions,
    slotsPerRegion: ctx.config?.slotsPerRegion ?? null,
    probeCapacity: ctx.backend?.capacity() ?? 0,
    probeImage: ctx.config?.probeImage ?? null,
    probeSha256: PROBE_SHA256,
    surfaces: [
      {
        surface: "Serverless AI Jobs (CPU)",
        api: "POST /ai/v1/jobs, GET /ai/v1/jobs/{id}, GET /ai/v1/jobs/get-by-name, POST /ai/v1/jobs/cancel, GET /ai/v1/jobs (this view)",
        usedFor:
          "every probe — one terminating container per commit, probe.py injected as a file into a stock image, at most two per region",
        platform: `${PROBE_PLATFORM} / ${PROBE_PRESET}`,
      },
      {
        surface: "Object Storage (S3 API)",
        api: "SigV4 GET/PUT, conditional PUT (If-None-Match / If-Match), presigned PUT URLs",
        usedFor:
          "hunt records and every coordination decision (compare-and-swap). Each probe gets one presigned URL for its own verdict object — no credential and no bucket mount ever enters a job.",
        platform: null,
      },
      {
        surface: "Token Factory inference",
        api: "POST /v1/chat/completions",
        usedFor: `one root-cause paragraph per hunt from ${model}, after the culprit is found`,
        platform: null,
      },
      {
        surface: "IAM token exchange",
        api: "POST /oauth2/token/exchange",
        usedFor: "service-account RS256 JWT exchanged for a Bearer token",
        platform: null,
      },
    ],
    latestJobs: {
      source: latest ? "GET /ai/v1/jobs in every probe region, read live (cached for up to 60 s)" : null,
      readAt: latest?.readAt ?? null,
      jobs: latest?.jobs ?? [],
      unavailableRegions: latest?.unavailable ?? [],
    },
    recentCalls: recentCalls().map((call) => ({ ...call, path: call.path.split("?")[0] })),
  });
}
