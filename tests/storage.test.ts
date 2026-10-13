/**
 * Object Storage — the verdict channel.
 *
 * The Jobs API reports no exit code and serves no logs over REST, so a probe's pass/fail
 * reaches the app only as a JSON file in the mounted bucket. That makes the distinction
 * between "absent" and "broken" the load-bearing behaviour in this file: absence is a probe
 * that has not finished, and it must never surface as an error that fails a reconcile tick.
 */

import { describe, it, expect } from "vitest";
import {
  StorageError,
  getJson,
  getJsonVersioned,
  getObject,
  getObjectVersioned,
  headObject,
  keys,
  listObjects,
  presignPut,
  putJson,
  putObject,
  putObjectConditional,
} from "@/lib/nebius/storage";
import { loadConfig, type NebiusConfig } from "@/lib/nebius/config";

function testConfig(): NebiusConfig {
  const result = loadConfig({
    NODE_ENV: "test",
    NEBIUS_SERVICE_ACCOUNT_ID: "serviceaccount-e00test",
    NEBIUS_AUTH_KEY_ID: "publickey-e00test",
    NEBIUS_AUTH_PRIVATE_KEY: "not-used-by-sigv4",
    NEBIUS_PROJECT_ID: "project-test",
    NEBIUS_SUBNET_ID: "vpcsubnet-test",
    NEBIUS_BUCKET: "faultline-test",
    NEBIUS_S3_ACCESS_KEY_ID: "test-access-key",
    NEBIUS_S3_SECRET_ACCESS_KEY: "test-secret-key",
  });
  if (!result.configured) {
    throw new Error(`test config incomplete: ${result.missing.join(", ")}`);
  }
  return result.config;
}

const CONFIG = testConfig();

interface Capture {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function headerRecord(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/** Record every request and answer it from a queue of responses, one per call. */
function recorder(responses: Array<() => Response>) {
  const calls: Capture[] = [];
  let index = 0;

  const impl: typeof fetch = async (input, init) => {
    calls.push({
      url: urlOf(input),
      method: (init?.method ?? "GET").toUpperCase(),
      headers: headerRecord(init),
      body: typeof init?.body === "string" ? init.body : null,
    });
    const next = responses[index];
    index += 1;
    if (!next) throw new Error(`unexpected request ${index} in test`);
    return next();
  };

  return { impl, calls };
}

function ok(body: string): () => Response {
  return () => new Response(body, { status: 200 });
}

function status(code: number, statusText: string): () => Response {
  return () => new Response("", { status: code, statusText });
}

/** The `<Key>` entries S3 returns, wrapped in enough envelope to be realistic. */
function listXml(entries: string[], nextToken?: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<ListBucketResult>",
    `<IsTruncated>${nextToken ? "true" : "false"}</IsTruncated>`,
    ...(nextToken ? [`<NextContinuationToken>${nextToken}</NextContinuationToken>`] : []),
    ...entries.map((key) => `<Contents><Key>${key}</Key><Size>12</Size></Contents>`),
    "</ListBucketResult>",
  ].join("");
}

async function caughtAsync(fn: () => Promise<unknown>): Promise<StorageError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof StorageError) return error;
    throw error;
  }
  throw new Error("expected a StorageError, but the call resolved");
}

describe("getObject", () => {
  it("addresses the object path-style and signs the request", async () => {
    const net = recorder([ok("hello")]);

    expect(await getObject(CONFIG, "hunts/abc.json", net.impl)).toBe("hello");

    const call = net.calls[0];
    expect(call?.url).toBe("https://storage.eu-west1.nebius.cloud/faultline-test/hunts/abc.json");
    expect(call?.headers.authorization).toContain("AWS4-HMAC-SHA256");
    expect(call?.headers.authorization).toContain("Credential=test-access-key/");
    expect(call?.headers["x-amz-content-sha256"]).toBeTruthy();
    // Host is signed but must not be sent: undici sets it, and a duplicate is a protocol error.
    expect(call?.headers.host).toBeUndefined();
  });

  it("returns null for a missing key, which is a probe that has not finished yet", async () => {
    const net = recorder([status(404, "Not Found")]);

    expect(await getObject(CONFIG, "hunt-1/probes/abc.json", net.impl)).toBeNull();
  });

  it("throws on any other non-OK response, carrying the status through", async () => {
    const net = recorder([status(503, "Service Unavailable")]);

    const error = await caughtAsync(() => getObject(CONFIG, "hunts/abc.json", net.impl));
    expect(error.status).toBe(503);
    expect(error.message).toContain("GET hunts/abc.json failed: 503");
  });
});

describe("getJson", () => {
  it("parses a stored object", async () => {
    const net = recorder([ok(JSON.stringify({ verdict: "fail", exitCode: 1 }))]);

    expect(await getJson(CONFIG, "hunt-1/probes/abc.json", net.impl)).toEqual({
      verdict: "fail",
      exitCode: 1,
    });
  });

  it("returns null for an absent object", async () => {
    const net = recorder([status(404, "Not Found")]);

    expect(await getJson(CONFIG, "hunt-1/probes/abc.json", net.impl)).toBeNull();
  });

  it("returns null for unparseable JSON, so a torn read reads as not-there-yet", async () => {
    // The probe writes atomically, so this should be impossible. If it happens anyway, the
    // next poll recovers — whereas throwing would fail the whole reconcile tick and lose the
    // verdicts of every other probe in the round.
    const net = recorder([ok('{"schema":"faultline.probe.v1","verd')]);

    expect(await getJson(CONFIG, "hunt-1/probes/abc.json", net.impl)).toBeNull();
  });
});

describe("putJson", () => {
  it("PUTs the serialised value as the request body", async () => {
    const net = recorder([ok("")]);

    await putJson(CONFIG, keys.hunt("hunt-1"), { id: "hunt-1", status: "running" }, net.impl);

    const call = net.calls[0];
    expect(call?.method).toBe("PUT");
    expect(call?.url).toBe(
      "https://storage.eu-west1.nebius.cloud/faultline-test/hunts/hunt-1.json",
    );
    expect(call?.body).toBe(JSON.stringify({ id: "hunt-1", status: "running" }, null, 2));
    // The payload hash is part of the signature, so a body swapped after signing is rejected.
    expect(call?.headers["x-amz-content-sha256"]).toBeTruthy();
  });

  it("throws when the write is rejected, rather than losing the hunt silently", async () => {
    const net = recorder([status(403, "Forbidden")]);

    const error = await caughtAsync(() => putObject(CONFIG, "hunts/x.json", "{}", net.impl));
    expect(error.status).toBe(403);
    expect(error.message).toContain("PUT hunts/x.json failed: 403");
  });
});

describe("headObject", () => {
  it("answers true when the object exists and false when it does not", async () => {
    const present = recorder([ok("")]);
    expect(await headObject(CONFIG, "hunts/abc.json", present.impl)).toBe(true);
    expect(present.calls[0]?.method).toBe("HEAD");

    const absent = recorder([status(404, "Not Found")]);
    expect(await headObject(CONFIG, "hunts/abc.json", absent.impl)).toBe(false);
  });
});

describe("listObjects", () => {
  it("pulls the keys out of the S3 XML for a single page", async () => {
    const net = recorder([ok(listXml(["hunt-1/probes/a.json", "hunt-1/probes/b.json"]))]);

    expect(await listObjects(CONFIG, "hunt-1/probes/", net.impl)).toEqual([
      "hunt-1/probes/a.json",
      "hunt-1/probes/b.json",
    ]);

    const call = net.calls[0];
    expect(call?.url).toContain("list-type=2");
    expect(call?.url).toContain("prefix=hunt-1%2Fprobes%2F");
    expect(call?.url).not.toContain("continuation-token");
  });

  it("decodes XML entities, so an escaped key is not returned mangled", async () => {
    const net = recorder([ok(listXml(["a&amp;b/&lt;c&gt;/&quot;d&quot;/&apos;e&apos;.json"]))]);

    expect(await listObjects(CONFIG, "", net.impl)).toEqual(["a&b/<c>/\"d\"/'e'.json"]);
  });

  it("follows the continuation token across pages instead of stopping at the first", async () => {
    // S3 caps a page at 1000 keys. A hunt's probe verdicts can exceed that across rounds,
    // and a walk that stopped at page one would report probes as never having reported.
    const net = recorder([
      ok(listXml(["k1.json", "k2.json"], "token-page-2")),
      ok(listXml(["k3.json"], "token-page-3")),
      ok(listXml(["k4.json"])),
    ]);

    expect(await listObjects(CONFIG, "hunt-1/", net.impl)).toEqual([
      "k1.json",
      "k2.json",
      "k3.json",
      "k4.json",
    ]);

    expect(net.calls).toHaveLength(3);
    expect(net.calls[0]?.url).not.toContain("continuation-token");
    expect(net.calls[1]?.url).toContain("continuation-token=token-page-2");
    expect(net.calls[2]?.url).toContain("continuation-token=token-page-3");
  });

  it("stops when the response says it is not truncated, even if a token is present", async () => {
    const net = recorder([
      ok(
        [
          "<ListBucketResult>",
          "<IsTruncated>false</IsTruncated>",
          "<NextContinuationToken>stale-token</NextContinuationToken>",
          "<Contents><Key>only.json</Key></Contents>",
          "</ListBucketResult>",
        ].join(""),
      ),
    ]);

    expect(await listObjects(CONFIG, "hunt-1/", net.impl)).toEqual(["only.json"]);
    expect(net.calls).toHaveLength(1);
  });

  it("stops rather than looping forever when a truncated page carries no token", async () => {
    // Malformed, but the cost of getting it wrong is an infinite request loop against a
    // billed API inside a reconcile tick.
    const net = recorder([
      ok(
        [
          "<ListBucketResult>",
          "<IsTruncated>true</IsTruncated>",
          "<Contents><Key>partial.json</Key></Contents>",
          "</ListBucketResult>",
        ].join(""),
      ),
    ]);

    expect(await listObjects(CONFIG, "hunt-1/", net.impl)).toEqual(["partial.json"]);
    expect(net.calls).toHaveLength(1);
  });

  it("throws on a non-OK list response", async () => {
    const net = recorder([status(500, "Internal Server Error")]);

    const error = await caughtAsync(() => listObjects(CONFIG, "hunt-1/", net.impl));
    expect(error.status).toBe(500);
    expect(error.message).toContain("LIST hunt-1/ failed: 500");
  });
});

describe("keys", () => {
  it("lays out hunts, verdicts, claims, the lock and counters under separate prefixes", () => {
    expect(keys.hunt("hunt-1")).toBe("hunts/hunt-1.json");
    expect(keys.probeVerdict("hunt-1", "r1-i7-c0ffee-a1")).toBe("hunts/hunt-1/verdicts/r1-i7-c0ffee-a1.json");
    expect(keys.dispatchClaim("hunt-1", "r1-i7-c0ffee-a1")).toBe("hunts/hunt-1/claims/r1-i7-c0ffee-a1.json");
    expect(keys.narrationClaim("hunt-1", 2)).toBe("hunts/hunt-1/claims/narration-a2.json");
    expect(keys.liveLock()).toBe("locks/live-hunt.json");
    expect(keys.dailyCounter("2026-09-04")).toBe("counters/2026-09-04.json");
  });
});

describe("getObjectVersioned", () => {
  it("returns the body with the ETag a conditional replace must quote back", async () => {
    const net = recorder([() => new Response("{}", { status: 200, headers: { ETag: '"abc"' } })]);
    expect(await getObjectVersioned(CONFIG, "hunts/h.json", net.impl)).toEqual({ value: "{}", etag: '"abc"' });
  });

  it("returns null for a missing key", async () => {
    const net = recorder([status(404, "Not Found")]);
    expect(await getObjectVersioned(CONFIG, "hunts/h.json", net.impl)).toBeNull();
  });

  it("throws on corruption in a record the app wrote itself", async () => {
    const net = recorder([ok("{not json")]);
    const error = await caughtAsync(() => getJsonVersioned(CONFIG, "hunts/h.json", net.impl));
    expect(error.message).toContain("not JSON");
  });
});

describe("putObjectConditional", () => {
  it("signs If-None-Match into the request, so it cannot be stripped in transit", async () => {
    const net = recorder([() => new Response("", { status: 200, headers: { ETag: '"e1"' } })]);
    const result = await putObjectConditional(CONFIG, "hunts/h/claims/k.json", "{}", { ifNoneMatch: "*" }, net.impl);
    expect(result).toEqual({ ok: true, etag: '"e1"' });
    expect(net.calls[0]?.headers["if-none-match"]).toBe("*");
    expect(net.calls[0]?.headers.authorization).toContain("if-none-match");
  });

  it("sends If-Match with the ETag for a compare-and-swap", async () => {
    const net = recorder([ok("")]);
    await putObjectConditional(CONFIG, "hunts/h.json", "{}", { ifMatch: '"e1"' }, net.impl);
    expect(net.calls[0]?.headers["if-match"]).toBe('"e1"');
  });

  it.each([412, 409])("reports a lost condition (%i) as an outcome, not an error", async (code) => {
    const net = recorder([status(code, "Precondition Failed")]);
    expect(await putObjectConditional(CONFIG, "k", "{}", { ifNoneMatch: "*" }, net.impl)).toEqual({ ok: false, status: code });
  });

  it("throws on any other failure", async () => {
    const net = recorder([status(403, "Forbidden")]);
    const error = await caughtAsync(() => putObjectConditional(CONFIG, "k", "{}", { ifNoneMatch: "*" }, net.impl));
    expect(error.status).toBe(403);
  });
});

describe("presignPut", () => {
  it("produces a path-style URL for exactly the one key, signed for the bucket's region", () => {
    const url = new URL(presignPut(CONFIG, "hunts/h/verdicts/r1-i7-c0ffee-a1.json", 7200, new Date("2026-10-13T00:00:00Z")));
    expect(url.origin).toBe("https://storage.eu-west1.nebius.cloud");
    expect(url.pathname).toBe("/faultline-test/hunts/h/verdicts/r1-i7-c0ffee-a1.json");
    expect(url.searchParams.get("X-Amz-Credential")).toBe("test-access-key/20261013/eu-west1/s3/aws4_request");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("7200");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    // The secret never appears in the URL — only a signature derived from it.
    expect(url.href).not.toContain("test-secret-key");
  });
});
