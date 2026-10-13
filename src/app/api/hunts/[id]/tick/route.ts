/**
 * POST /api/hunts/{id}/tick — "something landed; reconcile now".
 *
 * Sent EMPTY by each probe right after its verdict is stored, which is what lets a hunt
 * advance with nobody watching. It carries nothing and is trusted with nothing: the tick
 * reads the verdict from storage itself, so the worst a forged request can do is cause a
 * reconcile that would have happened anyway.
 */

import { NextResponse } from "next/server";
import { tick } from "@/lib/hunt";
import { storeContext } from "@/lib/store";
import { tickDue } from "@/lib/runtime";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // A probe's tick is a real event. If a viewer's tick ran a moment ago it may have missed
  // this verdict, so wait out the window rather than dropping the signal.
  if (!tickDue(id)) {
    await new Promise((resolve) => setTimeout(resolve, 1600));
    tickDue(id);
  }
  const hunt = await tick(storeContext(), id).catch(() => null);
  return new NextResponse(null, { status: hunt ? 204 : 404 });
}
