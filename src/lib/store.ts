/**
 * Hunt persistence.
 *
 * One JSON object per hunt. When Nebius is configured that object lives in the same Object
 * Storage bucket the probe jobs mount, so there is exactly one datastore in the system and
 * no schema to migrate. When it is not configured — local development, or a cold judge visit
 * to a deploy with no credentials — hunts fall back to process memory so the recorded example
 * and the UI still work.
 *
 * The fallback is deliberately not a database. A hunt that outlives a process restart is
 * worth nothing if the jobs backing it were never dispatched.
 */

import type { Hunt, ProbeResult } from "@/lib/types";
import { loadConfig, type NebiusConfig } from "@/lib/nebius/config";
import { getJson, putJson, keys } from "@/lib/nebius/storage";

const memory = new Map<string, Hunt>();

export interface StoreContext {
  config: NebiusConfig | null;
}

export function storeContext(): StoreContext {
  const result = loadConfig();
  return { config: result.configured ? result.config : null };
}

export async function readHunt(ctx: StoreContext, huntId: string): Promise<Hunt | null> {
  if (!ctx.config) return memory.get(huntId) ?? null;
  return getJson<Hunt>(ctx.config, keys.hunt(huntId));
}

export async function writeHunt(ctx: StoreContext, hunt: Hunt): Promise<void> {
  if (!ctx.config) {
    memory.set(hunt.id, hunt);
    return;
  }
  await putJson(ctx.config, keys.hunt(hunt.id), hunt);
}

/**
 * Read one probe's self-reported verdict.
 *
 * Returns null when the file is not there yet, which is the normal state of a probe that is
 * still running — the Jobs API cannot tell us a verdict, so absence is the only "not yet".
 */
export async function readProbeResult(
  ctx: StoreContext,
  huntId: string,
  sha: string,
): Promise<ProbeResult | null> {
  if (!ctx.config) return null;
  return getJson<ProbeResult>(ctx.config, keys.probeVerdict(huntId, sha));
}

/** Live hunts per UTC day, so judge traffic cannot silently drain the credit balance. */
export interface DailyCounter {
  day: string;
  count: number;
}

export const DAILY_LIVE_HUNT_CAP = 10;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function readDailyCount(ctx: StoreContext): Promise<DailyCounter> {
  const day = today();
  if (!ctx.config) return { day, count: memoryCounter.day === day ? memoryCounter.count : 0 };
  const stored = await getJson<DailyCounter>(ctx.config, keys.dailyCounter(day));
  return stored?.day === day ? stored : { day, count: 0 };
}

let memoryCounter: DailyCounter = { day: today(), count: 0 };

export async function incrementDailyCount(ctx: StoreContext): Promise<DailyCounter> {
  const current = await readDailyCount(ctx);
  const next: DailyCounter = { day: current.day, count: current.count + 1 };
  if (!ctx.config) {
    memoryCounter = next;
    return next;
  }
  await putJson(ctx.config, keys.dailyCounter(next.day), next);
  return next;
}

/** Test seam: clear in-memory state between cases. */
export function resetMemoryStore(): void {
  memory.clear();
  memoryCounter = { day: today(), count: 0 };
}
