/**
 * Nebius Serverless AI Jobs client.
 *
 * Two API shapes matter here and they differ, which is the usual source of bugs:
 *   - POST /ai/v1/jobs returns an Operation, and the new job ID is at `resourceId`.
 *   - GET  /ai/v1/jobs/{id} returns a Job, whose ID is at `metadata.id`.
 *
 * The API exposes no exit code and no logs over REST, so a job's *state* tells us only
 * whether the container ran — never whether the test passed. The verdict comes from the
 * file the probe writes to the mounted bucket. See `src/lib/store.ts`.
 */

import type { NebiusJobState } from "@/lib/types";
import { getAccessToken } from "./auth";
import {
  NEBIUS_API_BASE,
  PROBE_PLATFORM,
  PROBE_PRESET,
  type NebiusConfig,
} from "./config";

export interface JobStateDetails {
  code?: string;
  message?: string;
}

export interface NebiusJob {
  metadata: { id: string; parentId: string; name: string; createdAt?: string };
  status: {
    state: NebiusJobState;
    startedAt?: string;
    finishedAt?: string;
    stateDetails?: JobStateDetails;
  };
}

export interface CreateJobOptions {
  name: string;
  image: string;
  containerCommand?: string;
  args?: string;
  env?: Record<string, string>;
  platform?: string;
  preset?: string;
  /** Job timeout. The API floor is 3600s; a job still terminates when its container exits. */
  timeoutSeconds?: number;
  diskSizeBytes?: number;
  /** Mount the hunt bucket read-write so the probe can write its verdict. */
  mountBucketAt?: string;
}

interface OperationResponse {
  resourceId?: string;
  status?: { code?: number | string; message?: string };
}

export class NebiusApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "NebiusApiError";
  }
}

/**
 * Records every Nebius call made while serving a request, so `/api/integrations/verify` can
 * show a judge the real API traffic rather than a claim that it happened.
 */
export interface CallRecord {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  at: string;
}

const callLog: CallRecord[] = [];
const CALL_LOG_LIMIT = 200;

export function recentCalls(): readonly CallRecord[] {
  return callLog;
}

async function api<T>(
  config: NebiusConfig,
  method: string,
  path: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<T> {
  const token = await getAccessToken(config, fetchImpl);
  const startedAt = Date.now();

  const res = await fetchImpl(`${NEBIUS_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  callLog.push({
    method,
    path,
    status: res.status,
    durationMs: Date.now() - startedAt,
    at: new Date().toISOString(),
  });
  if (callLog.length > CALL_LOG_LIMIT) callLog.splice(0, callLog.length - CALL_LOG_LIMIT);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new NebiusApiError(
      `${method} ${path} failed: ${res.status} ${res.statusText}`,
      res.status,
      text.slice(0, 1000),
    );
  }

  return (await res.json()) as T;
}

/**
 * Create a job and return its ID.
 *
 * Note the response handling: this endpoint answers with an Operation, so reading
 * `metadata.id` here — the field that works on every other jobs endpoint — silently yields
 * undefined and strands the probe.
 */
export async function createJob(
  config: NebiusConfig,
  options: CreateJobOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const spec: Record<string, unknown> = {
    image: options.image,
    platform: options.platform ?? PROBE_PLATFORM,
    preset: options.preset ?? PROBE_PRESET,
    subnetId: config.subnetId,
    // The documented minimum is 3600s. A probe exits long before this; the timeout is a
    // backstop against a hung test holding a VM open and billing per second.
    timeout: `${Math.max(3600, options.timeoutSeconds ?? 3600)}s`,
    disk: {
      type: "NETWORK_SSD",
      sizeBytes: String(options.diskSizeBytes ?? 64 * 1024 * 1024 * 1024),
    },
  };

  if (options.containerCommand) spec.containerCommand = options.containerCommand;
  if (options.args) spec.args = options.args;

  if (options.env) {
    spec.environmentVariables = Object.entries(options.env).map(([name, value]) => ({
      name,
      value,
    }));
  }

  if (options.mountBucketAt) {
    // The CLI's `--volume s3://bucket:/path:rw:profile` shorthand relies on an AWS profile
    // inside the container, which is undocumented. The REST shape takes inline credentials,
    // which is fully specified, so that is what we send.
    spec.volumes = [
      {
        source: `s3://${config.bucket}`,
        containerPath: options.mountBucketAt,
        mode: "READ_WRITE",
        s3Config: {
          endpoint: config.s3Endpoint,
          region: config.region,
          credentials: {
            accessKeyId: config.s3AccessKeyId,
            secretAccessKey: config.s3SecretAccessKey,
          },
        },
      },
    ];
  }

  const op = await api<OperationResponse>(
    config,
    "POST",
    "/ai/v1/jobs",
    { metadata: { parentId: config.projectId, name: options.name }, spec },
    fetchImpl,
  );

  if (!op.resourceId) {
    throw new NebiusApiError(
      "job create returned an operation with no resourceId",
      502,
      JSON.stringify(op).slice(0, 1000),
    );
  }
  return op.resourceId;
}

export async function getJob(
  config: NebiusConfig,
  jobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NebiusJob> {
  return api<NebiusJob>(
    config,
    "GET",
    `/ai/v1/jobs/${encodeURIComponent(jobId)}`,
    undefined,
    fetchImpl,
  );
}

export async function listJobs(
  config: NebiusConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<NebiusJob[]> {
  const res = await api<{ items?: NebiusJob[] }>(
    config,
    "GET",
    `/ai/v1/jobs?parentId=${encodeURIComponent(config.projectId)}`,
    undefined,
    fetchImpl,
  );
  return res.items ?? [];
}

/** Cancel a job. Used to release VMs when a hunt settles while probes are still in flight. */
export async function cancelJob(
  config: NebiusConfig,
  jobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await api<OperationResponse>(config, "POST", "/ai/v1/jobs/cancel", { id: jobId }, fetchImpl);
}
