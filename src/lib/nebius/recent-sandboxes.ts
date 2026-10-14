/**
 * The latest probe sandboxes, read live from Token Factory Sandboxes for
 * `GET /api/integrations/verify` — the Sandboxes twin of `recent-jobs.ts`.
 *
 * Only the list endpoint is read, and it carries no metadata: no environment, so no presigned
 * verdict URL, can leave this module.
 */

import type { SandboxesConfig } from "@/lib/nebius/config";
import { listOperations } from "@/lib/nebius/sandboxes";

export interface PublicSandbox {
  id: string;
  state: string;
  createdAt: string | null;
  /** Seconds the operation ran, as the API reports it. */
  durationSeconds: number | null;
}

export interface RecentSandboxes {
  operations: PublicSandbox[];
  /** True when the list read failed or timed out: the operations are missing, not absent. */
  unavailable: boolean;
  readAt: string;
}

const LOOKBACK_MS = 24 * 60 * 60_000;
const LIST_TIMEOUT_MS = 4_000;
const CACHE_MS = 60_000;

let cache: { at: number; value: RecentSandboxes } | null = null;

export function clearRecentSandboxesCache(): void {
  cache = null;
}

export interface RecentSandboxesOptions {
  limit?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/** Newest first. Never throws: a failed read says so instead. */
export async function recentSandboxes(config: SandboxesConfig, options: RecentSandboxesOptions = {}): Promise<RecentSandboxes> {
  const { limit = 8, fetchImpl = fetch, now = Date.now, timeoutMs = LIST_TIMEOUT_MS } = options;
  if (cache && now() - cache.at < CACHE_MS) return cache.value;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    const list = await Promise.race([listOperations(config, new Date(now() - LOOKBACK_MS), fetchImpl), timeout]);
    const operations = list
      .map((op) => ({
        id: op.uuid,
        state: op.status,
        createdAt: op.created_at ?? null,
        durationSeconds: typeof op.duration === "number" ? op.duration : null,
      }))
      .sort((a, b) => epoch(b.createdAt) - epoch(a.createdAt))
      .slice(0, limit);
    const value = { operations, unavailable: false, readAt: new Date(now()).toISOString() };
    cache = { at: now(), value };
    return value;
  } catch {
    return { operations: [], unavailable: true, readAt: new Date(now()).toISOString() };
  } finally {
    clearTimeout(timer);
  }
}

function epoch(iso: string | null): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
}
