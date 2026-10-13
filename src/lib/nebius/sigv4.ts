/**
 * AWS Signature Version 4 for the S3-compatible Object Storage API.
 *
 * Written against the published SigV4 specification rather than pulled in with the AWS SDK:
 * Faultline needs a handful of S3 operations (GET, PUT, conditional PUT, HEAD, LIST) and one
 * presigned URL per probe, and the SDK would add a large dependency tree to the credential
 * path for them. Correctness is not taken on trust — the canonicalisation and signing steps
 * here are verified against AWS's own published vectors (the `aws-sig-v4-test-suite`, the S3
 * header examples and the S3 query-string example) in `tests/sigv4.test.ts`.
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

  const signature = createHmac("sha256", signingKey(input.secretAccessKey, short, input.region, input.service))
    .update(stringToSign, "utf8")
    .digest("hex");

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

function signingKey(secretAccessKey: string, short: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, short), region), service), "aws4_request");
}

export interface PresignInput {
  method: string;
  /** `https://host` — no path. */
  origin: string;
  /** Already-decoded path, e.g. `/bucket/hunts/abc/probes/r1.json`. */
  path: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Lifetime of the URL. S3 caps query-string auth at seven days. */
  expiresSeconds: number;
  /** Test seam. Defaults to now. */
  date?: Date;
}

export interface PresignedUrl {
  url: string;
  /** Exposed for the test vector, which asserts on the intermediate strings. */
  canonicalRequest: string;
  signature: string;
}

/**
 * SigV4 query-string authentication: a URL that carries its own signature.
 *
 * This is how a probe writes its verdict without holding a credential. The URL authorises
 * exactly one method on exactly one key until it expires — the path is inside the signature,
 * so it cannot be bent to another object. Only `host` is signed and the payload is
 * `UNSIGNED-PAYLOAD`, which is what lets a caller with nothing but `urllib` use it.
 */
export function presignUrl(input: PresignInput): PresignedUrl {
  const date = input.date ?? new Date();
  const { long, short } = amzDate(date);
  const host = new URL(input.origin).host;
  const scope = `${short}/${input.region}/${input.service}/aws4_request`;
  const expires = Math.max(1, Math.min(604_800, Math.floor(input.expiresSeconds)));

  const query: Record<string, string> = {
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": `${input.accessKeyId}/${scope}`,
    "X-Amz-Date": long,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": "host",
  };

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri(input.path),
    canonicalQueryString(query),
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [ALGORITHM, long, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(input.secretAccessKey, short, input.region, input.service))
    .update(stringToSign, "utf8")
    .digest("hex");

  const url = `${input.origin.replace(/\/+$/, "")}${canonicalUri(input.path)}?${canonicalQueryString(query)}&X-Amz-Signature=${signature}`;
  return { url, canonicalRequest, signature };
}
