/**
 * GET /api/integrations/verify — judge-facing proof that the Nebius integration is real.
 *
 * Per the sponsor-defence requirement this is a *view*, not a subsystem: it renders the job
 * IDs, states and durations already stored in hunt records, plus the recent API call log.
 * A judge can confirm in thirty seconds that jobs were really created, without reading code.
 */

import { NextResponse } from "next/server";
import { recentCalls } from "@/lib/nebius/jobs";
import {
  NARRATION_PLATFORM,
  NARRATION_PRESET,
  PROBE_PLATFORM,
  PROBE_PRESET,
} from "@/lib/nebius/config";
import { storeContext } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const ctx = storeContext();

  return NextResponse.json({
    nebiusConfigured: ctx.config !== null,
    region: ctx.config?.region ?? null,
    surfaces: [
      {
        surface: "Serverless AI Jobs (CPU)",
        api: "POST /ai/v1/jobs, GET /ai/v1/jobs/{id}, POST /ai/v1/jobs/cancel",
        usedFor: "every probe — one container per commit, N concurrent, terminating",
        platform: `${PROBE_PLATFORM} / ${PROBE_PRESET}`,
      },
      {
        surface: "Serverless AI Jobs (GPU)",
        api: "POST /ai/v1/jobs",
        usedFor: "the NVIDIA narration model, one terminating job per hunt",
        platform: `${NARRATION_PLATFORM} / ${NARRATION_PRESET}`,
      },
      {
        surface: "Object Storage (mounted volume)",
        api: "S3 GET/PUT/LIST, and spec.volumes[].s3Config on every job",
        usedFor:
          "hunt state and probe verdicts. The Jobs API exposes no exit code and no logs over REST, so this mount is the only channel a verdict travels.",
        platform: null,
      },
      {
        surface: "IAM token exchange",
        api: "POST /oauth2/token/exchange",
        usedFor: "service-account RS256 JWT exchanged for a Bearer token",
        platform: null,
      },
    ],
    recentCalls: recentCalls(),
  });
}
