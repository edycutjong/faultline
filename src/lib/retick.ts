/**
 * Waking a hunt that is waiting out a backoff.
 *
 * Probes tick a hunt when they report — but a probe whose create was throttled never ran,
 * so nothing will tick for it. A route that ends with such a probe queued keeps its function
 * alive after the response (`after`), sleeps until the backoff ends (at most 90 s, inside
 * the route's 120 s budget), then POSTs the hunt's own tick URL. That request is a fresh
 * invocation which does the same if it still has to wait, so the chain lasts exactly as
 * long as the backoff does and ends when the probe dispatches or the hunt pauses.
 */

import { after } from "next/server";
import type { Hunt } from "@/lib/types";
import { nextWakeAt, tick } from "@/lib/hunt";
import { storeContext } from "@/lib/store";

const MAX_WAIT_MS = 90_000;

export function retickAfterBackoff(hunt: Hunt | null): void {
  if (!hunt) return;
  const wake = nextWakeAt(hunt);
  if (!wake) return;
  const waitMs = Math.max(1_000, Math.min(MAX_WAIT_MS, wake.getTime() - Date.now() + 1_000));
  const tickUrl = hunt.tickUrl;
  const id = hunt.id;
  after(async () => {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    if (tickUrl) {
      await fetch(tickUrl, { method: "POST", signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
    } else {
      await tick(storeContext(), id).catch(() => undefined);
    }
  });
}
