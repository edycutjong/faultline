/**
 * GET /api/hunts/{id} — the reconcile tick.
 *
 * This is the only moving part of the control loop. The client polls it every two seconds;
 * each call collects landed verdicts, narrows the range, and dispatches the next band when a
 * round completes. There is no worker to keep alive between calls.
 */

import { NextResponse } from "next/server";
import { reconcile } from "@/lib/hunt";
import { readHunt, storeContext } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ctx = storeContext();

  const hunt = await readHunt(ctx, id);
  if (!hunt) {
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

  try {
    const reconciled = await reconcile(ctx, hunt);
    return NextResponse.json({ hunt: reconciled });
  } catch (error) {
    // A failed tick must not lose the hunt. Return the last known state and let the next
    // poll retry, rather than turning a transient API error into a dead page.
    return NextResponse.json(
      {
        hunt,
        warning: error instanceof Error ? error.message : "Reconcile failed; retrying.",
      },
      { status: 200 },
    );
  }
}
