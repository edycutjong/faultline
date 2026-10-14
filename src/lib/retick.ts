/**
 * Waking a hunt that is waiting out a backoff.
 *
 * Probes tick a hunt when they report — but a probe whose create was throttled never ran,
 * so nothing will tick for it; nor for a probe queued at a round boundary behind a slot whose
 * job has reported but is still exiting (`nextWakeAt`). A route that ends with such a probe queued keeps its function
 * alive after the response (`after`), sleeps until the backoff ends — at most 60 s, so the
 * wait, the request and the tick before it all fit the route's 120 s budget — then POSTs the
 * hunt's own tick URL. That request is a fresh invocation which does the same if it still has
 * to wait, so the chain lasts exactly as long as the backoff does and ends when the probe
 * dispatches or the hunt pauses. If the request itself fails, the tick runs here instead.
 */

import { after } from "next/server";
import type { Hunt } from "@/lib/types";
import { nextWakeAt, tick } from "@/lib/hunt";
import { storeContext } from "@/lib/store";

const MAX_WAIT_MS = 60_000;
const TICK_REQUEST_TIMEOUT_MS = 30_000;

/** How long to sleep before re-ticking `hunt`, or null when nothing is waiting on a backoff. */
export function retickDelayMs(hunt: Hunt | null, now = Date.now()): number | null {
  if (!hunt) return null;
  const wake = nextWakeAt(hunt, new Date(now));
  if (!wake) return null;
  return Math.max(1_000, Math.min(MAX_WAIT_MS, wake.getTime() - now + 1_000));
}

/** Wake-ups pending on this instance, by hunt: every route that saw a backoff used to start its own chain. */
const pending = new Map<string, number>();
/** A pending entry this far past its time belongs to a chain that died without clearing it. */
const PENDING_STALE_MS = 5_000;

export function retickAfterBackoff(hunt: Hunt | null, now = Date.now()): void {
  const waitMs = retickDelayMs(hunt, now);
  if (!hunt || waitMs === null) return;
  const { tickUrl, id } = hunt;
  const wakeAt = now + waitMs;
  const existing = pending.get(id);
  // An earlier wake-up here will tick, and that tick re-arms if it still has to wait.
  if (existing !== undefined && existing <= wakeAt && existing > now - PENDING_STALE_MS) return;
  pending.set(id, wakeAt);
  after(async () => {
    try {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    } finally {
      if (pending.get(id) === wakeAt) pending.delete(id); // hand over first, so the tick below may re-arm
    }
    if (tickUrl) {
      const res = await fetch(tickUrl, { method: "POST", signal: AbortSignal.timeout(TICK_REQUEST_TIMEOUT_MS) }).catch(() => null);
      // 404: the hunt is gone, there is nothing to wake. Anything else that is not a success
      // (network error, timeout, 5xx) must not drop the wake-up: tick here instead. Racing a
      // tick that did get through is safe — every write is a compare-and-swap.
      if (res && (res.ok || res.status === 404)) return;
    }
    await tick(storeContext(), id).catch(() => undefined);
  });
}

/** Test seam: forget every pending wake-up on this instance. */
export function resetRetick(): void {
  pending.clear();
}
