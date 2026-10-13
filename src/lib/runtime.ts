/**
 * Small request-time helpers shared by the route handlers.
 */

import { timingSafeEqual } from "node:crypto";

/**
 * The origin a probe should send its "reconcile now" request to.
 *
 * Production deploys use the stable production domain, never the per-deployment URL: a
 * probe can outlive the deployment that dispatched it, and preview URLs sit behind Vercel's
 * deployment protection, which would turn every tick into a 401.
 */
export function publicBaseUrl(request: Request, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.FAULTLINE_PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const production = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (env.VERCEL_ENV === "production" && production) return `https://${production}`;
  return new URL(request.url).origin;
}

const lastTick = new Map<string, number>();

/**
 * Per-instance throttle on reconcile ticks. Every open tab polls every two seconds; one
 * tick per hunt per window does all the work any of them would have done.
 */
export function tickDue(huntId: string, windowMs = 1500, now = Date.now()): boolean {
  const last = lastTick.get(huntId);
  if (last !== undefined && now - last < windowMs) return false;
  lastTick.set(huntId, now);
  if (lastTick.size > 500) {
    for (const [id, at] of lastTick) if (now - at > 60_000) lastTick.delete(id);
  }
  return true;
}

/** Test seam. */
export function resetTickThrottle(): void {
  lastTick.clear();
}

/**
 * The judge bypass for the daily live-hunt cap. The code itself lives only in the deploy's
 * environment and in the submission's testing instructions — never in the repository.
 */
export function bypassCodeMatches(supplied: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  const expected = env.FAULTLINE_BYPASS_CODE?.trim();
  if (!expected || typeof supplied !== "string" || !supplied.trim()) return false;
  const a = Buffer.from(supplied.trim());
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
