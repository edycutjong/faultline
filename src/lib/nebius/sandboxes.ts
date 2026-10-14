/**
 * Token Factory Sandboxes REST client — the four calls a probe backend needs.
 *
 *   POST   /v1/instances          spawn one sandbox; answers with the operation (its `uuid`)
 *   GET    /v1/operations/{id}    an operation's status, timings and, once it ends, its result
 *   GET    /v1/operations         recent operations (no metadata — so no env, no stdin)
 *   DELETE /v1/operations/{id}    cancel
 *
 * Auth is the Token Factory API key as a Bearer token plus a `Project` header naming the Token
 * Factory project (`aiproject-…`). Written against the REST shapes the official `contree-sdk`
 * (0.3.6) sends, and checked against the live API on 2026-10-14.
 *
 * An operation's `metadata` carries the instance's environment — including the probe's
 * presigned verdict URL — so nothing here passes metadata on except the hostname.
 */

import type { SandboxesConfig } from "./config";
import { logCall, NebiusApiError } from "./jobs";

export type SandboxStatus = "ASSIGNED" | "PENDING" | "EXECUTING" | "SUCCESS" | "FAILED" | "CANCELLED";

export interface SandboxOperation {
  uuid: string;
  kind: string;
  status: SandboxStatus | string;
  error: string | null;
  created_at: string | null;
  /** Seconds. Grows while the operation runs; final once it ends. */
  duration: number | null;
  metadata?: {
    hostname?: string;
    result?: {
      state?: { exit_code?: number; timed_out?: boolean };
      resources?: { cost?: number; elapsed_time?: number };
    } | null;
  } | null;
}

/** A base64 stream, as the API takes stdin and returns stdout/stderr. */
export interface SandboxStream {
  value: string;
  encoding: "base64";
}

export interface SpawnRequest {
  command: string;
  args: string[];
  /** `tag:<image tag>` or an image UUID. */
  image: string;
  hostname: string;
  env: Record<string, string>;
  shell: false;
  cwd: string;
  /** True: the sandbox's filesystem is thrown away when it ends; no checkpoint image is kept. */
  disposable: true;
  timeout: number;
  stdin: SandboxStream;
  truncate_output_at: number;
  files: Record<string, never>;
}

async function api<T>(
  config: SandboxesConfig,
  method: string,
  path: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<T> {
  const startedAt = Date.now();
  const res = await fetchImpl(`${config.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      Project: config.projectId,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  logCall({
    method,
    path: `/sandboxes${path}`,
    status: res.status,
    durationMs: Date.now() - startedAt,
    at: new Date().toISOString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new NebiusApiError(`${method} /sandboxes${path} failed: ${res.status} ${res.statusText}`, res.status, text.slice(0, 1000));
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** Spawn one sandbox and return its operation ID. */
export async function spawnInstance(config: SandboxesConfig, request: SpawnRequest, fetchImpl: typeof fetch = fetch): Promise<string> {
  const op = await api<{ uuid?: string } | null>(config, "POST", "/v1/instances", request, fetchImpl);
  if (!op?.uuid) {
    throw new NebiusApiError("sandbox spawn returned no operation uuid", 502, JSON.stringify(op).slice(0, 200));
  }
  return op.uuid;
}

/** One operation, or null when the API no longer knows it. */
export async function getOperation(config: SandboxesConfig, id: string, fetchImpl: typeof fetch = fetch): Promise<SandboxOperation | null> {
  try {
    return await api<SandboxOperation>(config, "GET", `/v1/operations/${encodeURIComponent(id)}`, undefined, fetchImpl);
  } catch (error) {
    if (error instanceof NebiusApiError && error.status === 404) return null;
    throw error;
  }
}

/** Recent instance operations since `since`, as the list endpoint returns them (no metadata). */
export async function listOperations(config: SandboxesConfig, since: Date, fetchImpl: typeof fetch = fetch): Promise<SandboxOperation[]> {
  const query = `kind=instance&since=${encodeURIComponent(since.toISOString())}`;
  const list = await api<SandboxOperation[] | null>(config, "GET", `/v1/operations?${query}`, undefined, fetchImpl);
  return Array.isArray(list) ? list : [];
}

export async function cancelOperation(config: SandboxesConfig, id: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await api<unknown>(config, "DELETE", `/v1/operations/${encodeURIComponent(id)}`, undefined, fetchImpl);
}
