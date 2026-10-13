/**
 * Nebius Serverless AI Jobs client.
 *
 * Two API shapes matter here and they differ, which is the usual source of bugs:
 *   - POST /ai/v1/jobs returns an Operation, and the new job ID is at `resourceId`.
 *   - GET  /ai/v1/jobs/{id} returns a Job, whose ID is at `metadata.id`.
 *
 * The API exposes no exit code and no logs over REST, so a job's *state* tells us only
 * whether the container ran — never whether the test passed. The verdict comes from the
 * document the probe PUTs to its presigned URL. See `src/lib/store.ts`.
 *
 * No job is ever given a bucket mount. A probe runs a visitor's repository, so anything
 * mounted into it — and any credential in its environment — belongs to the visitor.
 */

import type { NebiusJobState } from "@/lib/types";
import { getAccessToken } from "./auth";
import {
  NEBIUS_API_BASE,
  PROBE_PLATFORM,
  PROBE_PRESET,
  type NebiusConfig,
  type ProbeRegion,
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

/** A small file materialised in the container before the entrypoint runs (≤ 64 KiB). */
export interface InjectedFile {
  containerPath: string;
  content: string;
}

export interface CreateJobOptions {
  name: string;
  image: string;
  /** Where the job runs. Omitted means the home region's project and subnet. */
  target?: ProbeRegion;
  containerCommand?: string;
  args?: string;
  env?: Record<string, string>;
  /** Files written into the container at launch — how probe.py reaches a stock image. */
  files?: InjectedFile[];
  platform?: string;
  preset?: string;
  /** Job timeout. The API floor is 3600s; a job still terminates when its container exits. */
  timeoutSeconds?: number;
  diskSizeBytes?: number;
}

/** The API's documented ceiling for one injected file. */
export const INJECTED_FILE_MAX_BYTES = 64 * 1024;

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
  const target = options.target ?? {
    region: config.region,
    projectId: config.projectId,
    subnetId: config.subnetId,
  };

  const spec: Record<string, unknown> = {
    image: options.image,
    platform: options.platform ?? PROBE_PLATFORM,
    preset: options.preset ?? PROBE_PRESET,
    subnetId: target.subnetId,
    // The documented minimum is 3600s. A probe exits long before this — it enforces its own,
    // shorter timeout so it always lives to report — and this is the backstop behind it.
    timeout: `${Math.max(3600, options.timeoutSeconds ?? 3600)}s`,
    disk: {
      type: "NETWORK_SSD",
      sizeBytes: String(options.diskSizeBytes ?? 32 * 1024 * 1024 * 1024),
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

  if (options.files?.length) {
    spec.injectedFiles = options.files.map((file) => {
      const bytes = Buffer.from(file.content, "utf8");
      if (bytes.length === 0 || bytes.length > INJECTED_FILE_MAX_BYTES) {
        throw new NebiusApiError(
          `injected file ${file.containerPath} is ${bytes.length} bytes; the API accepts 1 B – 64 KiB`,
          400,
          "",
        );
      }
      return { containerPath: file.containerPath, content: bytes.toString("base64") };
    });
  }

  const op = await api<OperationResponse>(
    config,
    "POST",
    "/ai/v1/jobs",
    { metadata: { parentId: target.projectId, name: options.name }, spec },
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

/**
 * Find a job by its (deterministic) name. Used to recover a dispatch whose creator died
 * between creating the job and recording its ID: the name is derived from (hunt, round,
 * commit, attempt), so the job can always be found again without a second create.
 */
export async function getJobByName(
  config: NebiusConfig,
  projectId: string,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NebiusJob | null> {
  try {
    return await api<NebiusJob>(
      config,
      "GET",
      `/ai/v1/jobs/get-by-name?parentId=${encodeURIComponent(projectId)}&name=${encodeURIComponent(name)}`,
      undefined,
      fetchImpl,
    );
  } catch (error) {
    if (error instanceof NebiusApiError && error.status === 404) return null;
    throw error;
  }
}

export async function listJobs(
  config: NebiusConfig,
  projectId: string = config.projectId,
  fetchImpl: typeof fetch = fetch,
): Promise<NebiusJob[]> {
  const res = await api<{ items?: NebiusJob[] }>(
    config,
    "GET",
    `/ai/v1/jobs?parentId=${encodeURIComponent(projectId)}`,
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
