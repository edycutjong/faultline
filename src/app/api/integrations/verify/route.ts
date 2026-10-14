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
import {
  loadSandboxesConfig,
  NARRATION_MODEL,
  PROBE_PLATFORM,
  PROBE_PRESET,
  probeBackendKind,
  SANDBOXES_MAX_CONCURRENCY,
} from "@/lib/nebius/config";
import { recentProbeJobs } from "@/lib/nebius/recent-jobs";
import { recentSandboxes } from "@/lib/nebius/recent-sandboxes";
import { SANDBOXES_BACKEND_ID } from "@/lib/backend/sandboxes-backend";
import { storeContext } from "@/lib/store";
import { PROBE_SHA256 } from "@/lib/probe-source";

export const dynamic = "force-dynamic";

export async function GET() {
  const ctx = storeContext();
  const onSandboxes = ctx.backend?.id === SANDBOXES_BACKEND_ID;
  const sandboxes = loadSandboxesConfig();
  const regions = ctx.backend ? [...ctx.backend.regions] : (ctx.config?.probeRegions.map((r) => r.region) ?? []);
  const [latest, latestSandboxes] = await Promise.all([
    ctx.config ? recentProbeJobs(ctx.config) : null,
    onSandboxes && sandboxes ? recentSandboxes(sandboxes) : null,
  ]);
  const model = ctx.tokenFactory?.model ?? NARRATION_MODEL;

  const jobsSurface = {
    surface: onSandboxes ? "Serverless AI Jobs (CPU) — fallback backend" : "Serverless AI Jobs (CPU)",
    api: "POST /ai/v1/jobs, GET /ai/v1/jobs/{id}, GET /ai/v1/jobs/get-by-name, POST /ai/v1/jobs/cancel, GET /ai/v1/jobs (this view)",
    usedFor: onSandboxes
      ? "the selectable fallback probe backend (FAULTLINE_PROBE_BACKEND=jobs) — one terminating container per commit, at most two per region"
      : "every probe — one terminating container per commit, probe.py injected as a file into a stock image, at most two per region",
    platform: `${PROBE_PLATFORM} / ${PROBE_PRESET}`,
  };
  const sandboxesSurface = {
    surface: "Token Factory Sandboxes",
    api: "POST /sandboxes/v1/instances, GET /sandboxes/v1/operations/{id}, GET /sandboxes/v1/operations, DELETE /sandboxes/v1/operations/{id}",
    usedFor: `every probe — one disposable sandbox per commit on the preloaded ${sandboxes?.image ?? "python:3.11"} image, probe.py on stdin, at most ${ctx.backend?.capacity() ?? 0} at once (beta cap ${SANDBOXES_MAX_CONCURRENCY} operations)`,
    platform: null,
  };

  return NextResponse.json({
    nebiusConfigured: ctx.config !== null,
    tokenFactoryConfigured: ctx.tokenFactory !== null,
    probeBackend: {
      active: ctx.backend?.id ?? null,
      requested: probeBackendKind(),
      sandboxesConfigured: sandboxes !== null,
      selectable: ["jobs", "sandboxes"],
    },
    region: ctx.config?.region ?? null,
    probeRegions: regions,
    slotsPerRegion: ctx.backend?.slotsPerRegion ?? ctx.config?.slotsPerRegion ?? null,
    probeCapacity: ctx.backend?.capacity() ?? 0,
    probeImage: (onSandboxes ? sandboxes?.image : ctx.config?.probeImage) ?? null,
    probeSha256: PROBE_SHA256,
    surfaces: [
      ...(onSandboxes ? [sandboxesSurface, jobsSurface] : [jobsSurface]),
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
    latestSandboxes: latestSandboxes
      ? {
          source: "GET /sandboxes/v1/operations, read live (cached for up to 60 s)",
          readAt: latestSandboxes.readAt,
          operations: latestSandboxes.operations,
          unavailable: latestSandboxes.unavailable,
        }
      : null,
    latestJobs: {
      source: latest ? "GET /ai/v1/jobs in every probe region, read live (cached for up to 60 s)" : null,
      readAt: latest?.readAt ?? null,
      jobs: latest?.jobs ?? [],
      unavailableRegions: latest?.unavailable ?? [],
    },
    recentCalls: recentCalls().map((call) => ({ ...call, path: call.path.split("?")[0] })),
  });
}
