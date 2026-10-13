/**
 * GET /api/hunts/{id} — the hunt, after a reconcile tick.
 *
 * The page polls this every two seconds, and each call that is due runs one tick: collect
 * landed verdicts, narrow the range, dispatch the next band. Probes also tick the hunt
 * themselves (POST /tick), so this is what keeps the view fresh — not what keeps the hunt
 * alive.
 */

import { NextResponse } from "next/server";
import { tick } from "@/lib/hunt";
import { readHunt, storeContext } from "@/lib/store";
import { tickDue } from "@/lib/runtime";
import { retickAfterBackoff } from "@/lib/retick";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ctx = storeContext();

  const stored = await readHunt(ctx, id).catch(() => null);
  if (!stored) {
    // Without Nebius credentials hunts live in process memory, which is not shared between
    // serverless instances or across a dev-server reload. Say that, rather than implying the
    // hunt never existed — the distinction is the difference between a bug and a boundary.
    return NextResponse.json(
      ctx.config
        ? { error: "No such hunt." }
        : {
            error:
              "This hunt is no longer readable. Without Nebius credentials hunts are held in memory rather than in Object Storage, so they do not survive being read by a different server instance. Live hunts need the credentials configured.",
            ephemeral: true,
          },
      { status: 404 },
    );
  }

  if (!tickDue(id)) return NextResponse.json({ hunt: stored });

  try {
    const reconciled = await tick(ctx, id);
    retickAfterBackoff(reconciled);
    return NextResponse.json({ hunt: reconciled ?? stored });
  } catch (error) {
    // A failed tick must not lose the hunt. Return the last known state and let the next
    // poll retry, rather than turning a transient API error into a dead page.
    return NextResponse.json({
      hunt: stored,
      warning: error instanceof Error ? error.message : "Reconcile failed; retrying.",
    });
  }
}
