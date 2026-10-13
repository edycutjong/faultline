/**
 * POST /api/hunts/{id}/resume — give a paused hunt a fresh retry budget.
 *
 * A hunt pauses only when a probe failed to report on every attempt — infrastructure, not
 * evidence. Resuming retries exactly that probe; nothing already learned is re-run.
 */

import { NextResponse } from "next/server";
import { resumeHunt } from "@/lib/hunt";
import { storeContext } from "@/lib/store";
import { retickAfterBackoff } from "@/lib/retick";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = await resumeHunt(storeContext(), id);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, ...(result.holder ? { liveHuntId: result.holder } : {}) },
      { status: result.status },
    );
  }
  retickAfterBackoff(result.hunt);
  return NextResponse.json({ hunt: result.hunt });
}
