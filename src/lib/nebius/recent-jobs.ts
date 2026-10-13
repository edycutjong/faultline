/**
 * The latest probe jobs, read live from the Nebius Jobs API for `GET /api/integrations/verify`.
 *
 * The verify view used to show this instance's own call log, which is empty on almost every
 * request a judge makes: a serverless instance that has not run a hunt has made no calls. A
 * list read of the probe projects shows the jobs themselves, whichever instance answers.
 *
 * Only identifying fields leave this module. A job's spec carries its presigned verdict URL,
 * and a published URL could overwrite that probe's verdict until it expires.
 */

import type { NebiusConfig } from "@/lib/nebius/config";
import { listJobs, type NebiusJob } from "@/lib/nebius/jobs";

export interface PublicJob {
  id: string;
  name: string;
  region: string;
  state: string;
  createdAt: string | null;
  finishedAt: string | null;
}

export interface RecentJobs {
  jobs: PublicJob[];
  /** Regions whose list call failed or timed out: their jobs are missing here, not absent. */
  unavailable: string[];
  readAt: string;
}

/** Every probe job is named `faultline-<hunt>-<probe key>` (`jobName` in src/lib/hunt.ts). */
const PROBE_JOB_PREFIX = "faultline-";
const LIST_TIMEOUT_MS = 4_000;
/** One read per minute per instance at most: the landing page asks on every visit. */
const CACHE_MS = 60_000;

let cache: { key: string; at: number; value: RecentJobs } | null = null;

export function clearRecentJobsCache(): void {
  cache = null;
}

export interface RecentJobsOptions {
  limit?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/** Newest first across every probe region. Never throws: a failed region is listed instead. */
export async function recentProbeJobs(config: NebiusConfig, options: RecentJobsOptions = {}): Promise<RecentJobs> {
  const { limit = 8, fetchImpl = fetch, now = Date.now, timeoutMs = LIST_TIMEOUT_MS } = options;
  const key = `${config.probeRegions.map((r) => r.projectId).join(",")}|${limit}`;
  if (cache && cache.key === key && now() - cache.at < CACHE_MS) return cache.value;

  const lists = await Promise.allSettled(
    config.probeRegions.map((r) => withTimeout(listJobs(config, r.projectId, fetchImpl), timeoutMs)),
  );

  const jobs: PublicJob[] = [];
  const unavailable: string[] = [];
  lists.forEach((list, i) => {
    const region = config.probeRegions[i].region;
    if (list.status === "rejected") {
      unavailable.push(region);
      return;
    }
    for (const job of list.value) {
      if (job.metadata?.name?.startsWith(PROBE_JOB_PREFIX)) jobs.push(toPublic(job, region));
    }
  });
  jobs.sort((a, b) => epoch(b.createdAt) - epoch(a.createdAt));

  const value: RecentJobs = { jobs: jobs.slice(0, limit), unavailable, readAt: new Date(now()).toISOString() };
  // A read that reached no region is not worth keeping for a minute.
  if (unavailable.length < config.probeRegions.length) cache = { key, at: now(), value };
  return value;
}

function toPublic(job: NebiusJob, region: string): PublicJob {
  return {
    id: job.metadata.id,
    name: job.metadata.name,
    region,
    state: job.status?.state ?? "STATE_UNSPECIFIED",
    createdAt: job.metadata.createdAt ?? null,
    finishedAt: job.status?.finishedAt ?? null,
  };
}

/** Milliseconds, whatever the fractional precision (`…40Z` and `…40.169806Z` both parse). */
function epoch(iso: string | null): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
