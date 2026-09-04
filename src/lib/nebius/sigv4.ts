/**
 * AWS Signature Version 4 for the S3-compatible Object Storage API.
 *
 * Written against the published SigV4 specification rather than pulled in with the AWS SDK:
 * Faultline needs four S3 operations (GET, PUT, HEAD, LIST) and the SDK would add a large
 * dependency tree to the credential path for them. Correctness is not taken on trust — the
 * canonicalisation and signing steps here are verified against AWS's own published
 * `aws-sig-v4-test-suite` vectors in `tests/sigv4.test.ts`.
 */

import { createHash, createHmac } from "node:crypto";

const ALGORITHM = "AWS4-HMAC-SHA256";

export interface SigV4Input {
  method: string;
  /** Already-decoded path, e.g. `/bucket/hunts/abc.json`. */
  path: string;
  query?: Record<string, string>;
  headers: Record<string, string>;
  payload: Buffer | string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Test seam. Defaults to now. */
  date?: Date;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * RFC 3986 encoding. `encodeURIComponent` leaves `!'()*` unescaped, and S3 rejects the
 * resulting signature, so those five are escaped explicitly.
 */
export function uriEncode(value: string, encodeSlash: boolean): string {
  const encoded = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return encodeSlash ? encoded : encoded.replace(/%2F/g, "/");
}

/** Normalise a path the way SigV4 requires: each segment encoded, separators preserved. */
export function canonicalUri(path: string): string {
  if (!path || path === "/") return "/";
  return path
    .split("/")
    .map((segment) => uriEncode(segment, true))
    .join("/");
}

export function canonicalQueryString(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k, true)}=${uriEncode(query[k] ?? "", true)}`)
    .join("&");
}

function amzDate(date: Date): { long: string; short: string } {
  const long = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { long, short: long.slice(0, 8) };
}

export interface SignedRequest {
  headers: Record<string, string>;
  /** Exposed for the test vectors, which assert on these intermediate strings. */
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

export function signRequest(input: SigV4Input): SignedRequest {
  const date = input.date ?? new Date();
  const { long, short } = amzDate(date);
  const payloadHash = sha256Hex(input.payload);

  // SigV4 always signs host and x-amz-date. `x-amz-content-sha256` is an S3 requirement
  // rather than a SigV4 one, so it is added only for that service — which also lets the
  // generic AWS test vectors, which sign a non-S3 service, match byte for byte.
  const headers: Record<string, string> = {
    ...input.headers,
    "x-amz-date": long,
    ...(input.service === "s3" ? { "x-amz-content-sha256": payloadHash } : {}),
  };

  // Header names lowercase, values trimmed and inner runs of whitespace collapsed, sorted.
  const normalised = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const canonicalHeaders = normalised.map(([k, v]) => `${k}:${v}\n`).join("");
  const signedHeaders = normalised.map(([k]) => k).join(";");

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri(input.path),
    canonicalQueryString(input.query ?? {}),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${short}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [ALGORITHM, long, scope, sha256Hex(canonicalRequest)].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, short), input.region), input.service),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  return {
    headers: {
      ...headers,
      Authorization: `${ALGORITHM} Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    canonicalRequest,
    stringToSign,
    signature,
  };
}
