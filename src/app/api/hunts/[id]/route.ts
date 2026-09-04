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
    return NextResponse.json({ error: "No such hunt." }, { status: 404 });
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
