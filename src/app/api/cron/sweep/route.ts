/**
 * GET /api/cron/sweep — reconcile the hunt holding the live slots.
 *
 * The backstop for a lost tick: a probe whose job died never sends one, and a hunt nobody is
 * watching would otherwise wait for the next visitor. The uptime workflow calls this on its
 * schedule; it is idempotent and safe to call from anywhere.
 */

import { NextResponse } from "next/server";
import { tick } from "@/lib/hunt";
import { readLiveLock, storeContext } from "@/lib/store";
import { retickAfterBackoff } from "@/lib/retick";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  const ctx = storeContext();
  if (!ctx.config) return NextResponse.json({ swept: null, reason: "Nebius is not configured." });

  const lock = await readLiveLock(ctx).catch(() => null);
  if (!lock || lock.released) return NextResponse.json({ swept: null });

  const hunt = await tick(ctx, lock.huntId).catch(() => null);
  retickAfterBackoff(hunt);
  return NextResponse.json({ swept: lock.huntId, status: hunt?.status ?? "unreadable" });
}
