/**
 * Nebius Object Storage (S3-compatible) client.
 *
 * This is not a convenience layer — it is the verdict channel. The Jobs API reports no exit
 * code and serves no logs over REST, so the only way a probe's pass/fail reaches the app is
 * the JSON file it writes into the bucket mounted at `/out`. Everything here exists to make
 * that read reliable.
 */

import { signRequest } from "./sigv4";
import type { NebiusConfig } from "./config";

export class StorageError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

function endpointHost(endpoint: string): string {
  return new URL(endpoint).host;
}

/**
 * Path-style addressing (`https://storage.<region>.nebius.cloud/<bucket>/<key>`) is what the
 * Nebius docs document, and it avoids the DNS propagation delay a new virtual-hosted bucket
 * would hit.
 */
function objectUrl(config: NebiusConfig, key: string): string {
  const base = config.s3Endpoint.replace(/\/+$/, "");
  return `${base}/${config.bucket}/${key.replace(/^\/+/, "")}`;
}

async function s3Request(
  config: NebiusConfig,
  method: string,
  key: string,
  body: string,
  query: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const url = objectUrl(config, key);
  const path = new URL(url).pathname;

  const signed = signRequest({
    method,
    path: decodeURIComponent(path),
    query,
    headers: { Host: endpointHost(config.s3Endpoint) },
    payload: body,
    region: config.region,
    service: "s3",
    accessKeyId: config.s3AccessKeyId,
    secretAccessKey: config.s3SecretAccessKey,
  });

  // `Host` is signed but must not be sent explicitly — fetch sets it, and a duplicate is a
  // protocol error in undici.
  const headers = { ...signed.headers };
  delete headers.Host;

  const qs = new URLSearchParams(query).toString();
  return fetchImpl(qs ? `${url}?${qs}` : url, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body }),
  });
}

/** Read an object. Returns null for a missing key — a probe that has not finished yet. */
export async function getObject(
  config: NebiusConfig,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const res = await s3Request(config, "GET", key, "", {}, fetchImpl);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new StorageError(`GET ${key} failed: ${res.status} ${res.statusText}`, res.status);
  }
  return res.text();
}

/** Read and parse a JSON object, returning null when absent or unparseable. */
export async function getJson<T>(
  config: NebiusConfig,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<T | null> {
  const text = await getObject(config, key, fetchImpl);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    // A probe writes its verdict atomically, so a torn read should be impossible. If one
    // happens anyway, treating it as "not there yet" lets the next poll recover, whereas
    // throwing would fail the whole reconcile tick.
    return null;
  }
}

export async function putObject(
  config: NebiusConfig,
  key: string,
  body: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await s3Request(config, "PUT", key, body, {}, fetchImpl);
  if (!res.ok) {
    throw new StorageError(`PUT ${key} failed: ${res.status} ${res.statusText}`, res.status);
  }
}

export async function putJson(
  config: NebiusConfig,
  key: string,
  value: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await putObject(config, key, JSON.stringify(value, null, 2), fetchImpl);
}

export async function headObject(
  config: NebiusConfig,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const res = await s3Request(config, "HEAD", key, "", {}, fetchImpl);
  return res.ok;
}

/** List object keys under a prefix. Follows continuation tokens to completion. */
export async function listObjects(
  config: NebiusConfig,
  prefix: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const query: Record<string, string> = { "list-type": "2", prefix };
    if (continuationToken) query["continuation-token"] = continuationToken;

    const res = await s3Request(config, "GET", "", "", query, fetchImpl);
    if (!res.ok) {
      throw new StorageError(
        `LIST ${prefix} failed: ${res.status} ${res.statusText}`,
        res.status,
      );
    }

    const xml = await res.text();
    for (const match of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) {
      const key = match[1];
      if (key) keys.push(decodeXmlEntities(key));
    }

    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    continuationToken = truncated
      ? (xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/)?.[1] ?? undefined)
      : undefined;
  } while (continuationToken);

  return keys;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Object key layout. Centralised so the probe container and the app cannot drift apart. */
export const keys = {
  hunt: (huntId: string) => `hunts/${huntId}.json`,
  probeVerdict: (huntId: string, sha: string) => `${huntId}/probes/${sha}.json`,
  dailyCounter: (day: string) => `counters/${day}.json`,
} as const;
