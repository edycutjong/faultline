/**
 * Coverage top-up for src/lib/nebius/storage.ts: error paths, default fetch, conditional
 * writes, listing edge cases and presigning.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
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
  putJsonConditional,
  putObject,
  putObjectConditional,
  decodeXmlEntities,
} from "@/lib/nebius/storage";
import type { NebiusConfig } from "@/lib/nebius/config";

const CONFIG = {
  s3Endpoint: "https://storage.eu-west1.nebius.cloud///",
  bucket: "bkt",
  region: "eu-west1",
  s3AccessKeyId: "AKIAIOSFODNN7EXAMPLE",
  s3SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
} as unknown as NebiusConfig;

function res(status: number, body = "", headers: Record<string, string> = {}): Response {
  return new Response(status === 204 || status === 304 ? null : body, {
    status,
    statusText: `S${status}`,
    headers,
  });
}

function mockFetch(...responses: Response[]) {
  const fn = vi.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("default fetch", () => {
  it("uses global fetch when none is injected", async () => {
    const f = vi.fn(async () => res(200, '{"a":1}', { etag: '"e1"' }));
    vi.stubGlobal("fetch", f);
    expect(await getObject(CONFIG, "k")).toBe('{"a":1}');
    expect(await getJson(CONFIG, "k")).toEqual({ a: 1 });
    await putObject(CONFIG, "k", "x");
    await putJson(CONFIG, "k", { a: 1 });
    expect(await headObject(CONFIG, "k")).toBe(true);
    expect(await listObjects(CONFIG, "p")).toEqual([]);
    expect(await getObjectVersioned(CONFIG, "k")).toEqual({ value: '{"a":1}', etag: '"e1"' });
    expect(await getJsonVersioned(CONFIG, "k")).toEqual({ value: { a: 1 }, etag: '"e1"' });
    expect(await putObjectConditional(CONFIG, "k", "x", { ifNoneMatch: "*" })).toEqual({
      ok: true,
      etag: '"e1"',
    });
    expect(await putJsonConditional(CONFIG, "k", { a: 1 }, { ifMatch: '"e1"' })).toEqual({
      ok: true,
      etag: '"e1"',
    });
    expect(f).toHaveBeenCalledTimes(10);
  });
});

describe("request shaping", () => {
  it("normalises slashes, omits Host and body on GET/HEAD, sends body on PUT", async () => {
    const f = mockFetch(res(200, "ok"), res(200), res(200));
    await getObject(CONFIG, "//a/b.json", f as unknown as typeof fetch);
    await headObject(CONFIG, "a", f as unknown as typeof fetch);
    await putObject(CONFIG, "a", "payload", f as unknown as typeof fetch);
    const [getUrl, getInit] = f.mock.calls[0];
    expect(getUrl).toBe("https://storage.eu-west1.nebius.cloud/bkt/a/b.json");
    expect(getInit.method).toBe("GET");
    expect("body" in getInit).toBe(false);
    expect(getInit.headers.Host).toBeUndefined();
    expect(JSON.stringify(getInit.headers)).toContain("AKIAIOSFODNN7EXAMPLE");
    expect("body" in f.mock.calls[1][1]).toBe(false);
    expect(f.mock.calls[2][1]).toMatchObject({ method: "PUT", body: "payload" });
  });
});

describe("errors", () => {
  it("getObject: null on 404, StorageError otherwise", async () => {
    expect(await getObject(CONFIG, "k", mockFetch(res(404)) as unknown as typeof fetch)).toBeNull();
    const err = await getObject(CONFIG, "k", mockFetch(res(500)) as unknown as typeof fetch).catch((e) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect(err.status).toBe(500);
    expect(err.name).toBe("StorageError");
    expect(err.message).toBe("GET k failed: 500 S500");
  });

  it("getJson: null when absent or unparseable", async () => {
    expect(await getJson(CONFIG, "k", mockFetch(res(404)) as unknown as typeof fetch)).toBeNull();
    expect(await getJson(CONFIG, "k", mockFetch(res(200, "{torn")) as unknown as typeof fetch)).toBeNull();
  });

  it("putObject throws on failure", async () => {
    await expect(
      putObject(CONFIG, "k", "x", mockFetch(res(403)) as unknown as typeof fetch),
    ).rejects.toMatchObject({ status: 403, message: "PUT k failed: 403 S403" });
  });

  it("headObject is false for a missing key", async () => {
    expect(await headObject(CONFIG, "k", mockFetch(res(404)) as unknown as typeof fetch)).toBe(false);
  });

  it("getObjectVersioned: null on 404, throws otherwise", async () => {
    expect(await getObjectVersioned(CONFIG, "k", mockFetch(res(404)) as unknown as typeof fetch)).toBeNull();
    await expect(
      getObjectVersioned(CONFIG, "k", mockFetch(res(503)) as unknown as typeof fetch),
    ).rejects.toMatchObject({ status: 503, message: "GET k failed: 503 S503" });
  });

  it("getObjectVersioned reports a missing etag as null", async () => {
    const r = await getObjectVersioned(CONFIG, "k", mockFetch(res(200, "v")) as unknown as typeof fetch);
    expect(r).toEqual({ value: "v", etag: null });
  });

  it("getJsonVersioned: null when absent, throws 500 on corrupt JSON", async () => {
    expect(await getJsonVersioned(CONFIG, "k", mockFetch(res(404)) as unknown as typeof fetch)).toBeNull();
    await expect(
      getJsonVersioned(CONFIG, "k", mockFetch(res(200, "nope")) as unknown as typeof fetch),
    ).rejects.toMatchObject({ status: 500, message: "GET k returned a document that is not JSON" });
  });
});

describe("listObjects", () => {
  it("follows continuation tokens, decodes entities, skips empty keys", async () => {
    const f = mockFetch(
      res(
        200,
        "<IsTruncated>true</IsTruncated><NextContinuationToken>tok1</NextContinuationToken>" +
          "<Key>a&amp;b&lt;c&gt;&quot;d&apos;</Key><Key></Key>",
      ),
      res(200, "<IsTruncated>false</IsTruncated><Key>z</Key>"),
    );
    const out = await listObjects(CONFIG, "pre/", f as unknown as typeof fetch);
    expect(out).toEqual([`a&b<c>"d'`, "z"]);
    expect(f.mock.calls[0][0]).toContain("list-type=2");
    expect(f.mock.calls[0][0]).toContain("prefix=pre%2F");
    expect(f.mock.calls[1][0]).toContain("continuation-token=tok1");
  });

  it("stops when truncated but no token is given", async () => {
    const f = mockFetch(res(200, "<IsTruncated>true</IsTruncated><Key>a</Key>"));
    expect(await listObjects(CONFIG, "", f as unknown as typeof fetch)).toEqual(["a"]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("throws on a failed list", async () => {
    await expect(
      listObjects(CONFIG, "p", mockFetch(res(500)) as unknown as typeof fetch),
    ).rejects.toMatchObject({ status: 500, message: "LIST p failed: 500 S500" });
  });
});

describe("conditional writes", () => {
  it("sends If-None-Match and returns the etag", async () => {
    const f = mockFetch(res(200, "", { etag: '"abc"' }));
    const r = await putObjectConditional(CONFIG, "k", "b", { ifNoneMatch: "*" }, f as unknown as typeof fetch);
    expect(r).toEqual({ ok: true, etag: '"abc"' });
    expect(f.mock.calls[0][1].headers["If-None-Match"]).toBe("*");
  });

  it("sends If-Match; 412 and 409 are lost races, not errors", async () => {
    const f = mockFetch(res(412), res(409));
    expect(await putObjectConditional(CONFIG, "k", "b", { ifMatch: '"e"' }, f as unknown as typeof fetch)).toEqual({
      ok: false,
      status: 412,
    });
    expect(f.mock.calls[0][1].headers["If-Match"]).toBe('"e"');
    expect(await putObjectConditional(CONFIG, "k", "b", { ifMatch: '"e"' }, f as unknown as typeof fetch)).toEqual({
      ok: false,
      status: 409,
    });
  });

  it("throws on other failures", async () => {
    await expect(
      putObjectConditional(CONFIG, "k", "b", { ifNoneMatch: "*" }, mockFetch(res(500)) as unknown as typeof fetch),
    ).rejects.toMatchObject({ status: 500, message: "PUT k failed: 500 S500" });
  });

  it("putJsonConditional serialises the value with 2-space indent", async () => {
    const f = mockFetch(res(200));
    const r = await putJsonConditional(CONFIG, "k", { a: 1 }, { ifNoneMatch: "*" }, f as unknown as typeof fetch);
    expect(r).toEqual({ ok: true, etag: null });
    expect(f.mock.calls[0][1].body).toBe('{\n  "a": 1\n}');
  });
});

describe("presignPut and keys", () => {
  it("presigns a PUT URL for one key, deterministic for a fixed date", () => {
    const date = new Date("2026-01-02T03:04:05Z");
    const a = presignPut(CONFIG, "hunts/x.json", 900, date);
    expect(a).toBe(presignPut(CONFIG, "hunts/x.json", 900, date));
    const u = new URL(a);
    expect(u.origin).toBe("https://storage.eu-west1.nebius.cloud");
    expect(u.pathname).toBe("/bkt/hunts/x.json");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(u.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(presignPut(CONFIG, "k", 60)).toContain("X-Amz-Signature=");
  });

  it("lays out keys", () => {
    expect(keys.hunt("h")).toBe("hunts/h.json");
    expect(keys.probeVerdict("h", "p")).toBe("hunts/h/verdicts/p.json");
    expect(keys.dispatchClaim("h", "p")).toBe("hunts/h/claims/p.json");
    expect(keys.narrationClaim("h", 2)).toBe("hunts/h/claims/narration-a2.json");
    expect(keys.liveLock()).toBe("locks/live-hunt.json");
    expect(keys.dailyCounter("2026-01-01")).toBe("counters/2026-01-01.json");
  });
});

describe("decodeXmlEntities", () => {
  it("decodes each entity once, so an escaped entity stays literal", () => {
    expect(decodeXmlEntities("a&amp;lt;b")).toBe("a&lt;b");
    expect(decodeXmlEntities("&lt;&gt;&quot;&apos;&amp;")).toBe(`<>"'&`);
    expect(decodeXmlEntities("plain/key.json")).toBe("plain/key.json");
  });
});
