import { describe, it, expect, vi, afterEach } from "vitest";
import {
  signRequest,
  presignUrl,
  canonicalUri,
  canonicalQueryString,
  uriEncode,
  sha256Hex,
} from "@/lib/nebius/sigv4";

const KEY = "AKIAIOSFODNN7EXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const DATE = new Date("2013-05-24T00:00:00Z");

afterEach(() => vi.useRealTimers());

describe("sigv4 coverage", () => {
  it("sha256Hex hashes strings and buffers identically", () => {
    const h = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(sha256Hex("abc")).toBe(h);
    expect(sha256Hex(Buffer.from("abc"))).toBe(h);
  });

  it("uriEncode escapes !'()* and optionally keeps slashes", () => {
    expect(uriEncode("a b!'()*", true)).toBe("a%20b%21%27%28%29%2A");
    expect(uriEncode("a/b", true)).toBe("a%2Fb");
    expect(uriEncode("a/b", false)).toBe("a/b");
  });

  it("canonicalUri handles empty, root and nested paths", () => {
    expect(canonicalUri("")).toBe("/");
    expect(canonicalUri("/")).toBe("/");
    expect(canonicalUri("/b/a b.json")).toBe("/b/a%20b.json");
  });

  it("canonicalQueryString sorts keys, encodes, and treats undefined values as empty", () => {
    expect(canonicalQueryString({})).toBe("");
    expect(canonicalQueryString({ b: "2 3", a: "1" })).toBe("a=1&b=2%203");
    expect(canonicalQueryString({ a: undefined as unknown as string })).toBe("a=");
  });

  it("signRequest adds x-amz-content-sha256 for s3, sorts headers both ways, and defaults date/query", () => {
    const r = signRequest({
      method: "put",
      path: "/bucket/k",
      headers: { Host: "h", "B-Header": "  x   y ", "a-header": "1", "b-header": "2" },
      payload: "body",
      region: "us-east-1",
      service: "s3",
      accessKeyId: KEY,
      secretAccessKey: SECRET,
      date: DATE,
    });
    expect(r.headers["x-amz-content-sha256"]).toBe(sha256Hex("body"));
    expect(r.headers["x-amz-date"]).toBe("20130524T000000Z");
    expect(r.canonicalRequest.startsWith("PUT\n/bucket/k\n\n")).toBe(true);
    expect(r.canonicalRequest).toContain("b-header:x y\n");
    const signed = r.canonicalRequest.split("\n").slice(-2)[0];
    expect(signed).toBe("a-header;b-header;b-header;host;x-amz-content-sha256;x-amz-date");
    expect(r.headers.Authorization).toBe(
      `AWS4-HMAC-SHA256 Credential=${KEY}/20130524/us-east-1/s3/aws4_request, SignedHeaders=${signed}, Signature=${r.signature}`,
    );
    expect(r.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("signRequest omits content hash for non-s3 services and uses the current time by default", () => {
    vi.useFakeTimers();
    vi.setSystemTime(DATE);
    const r = signRequest({
      method: "GET",
      path: "/",
      query: { z: "1", a: "2" },
      headers: { host: "example.amazonaws.com" },
      payload: Buffer.from(""),
      region: "us-east-1",
      service: "service",
      accessKeyId: KEY,
      secretAccessKey: SECRET,
    });
    expect(r.headers["x-amz-content-sha256"]).toBeUndefined();
    expect(r.headers["x-amz-date"]).toBe("20130524T000000Z");
    expect(r.canonicalRequest.split("\n")[2]).toBe("a=2&z=1");
  });

  it("presignUrl builds a signed URL with clamped expiry", () => {
    const base = {
      method: "put",
      origin: "https://storage.example.com//",
      path: "/bucket/a b.json",
      region: "eu-north1",
      service: "s3",
      accessKeyId: KEY,
      secretAccessKey: SECRET,
      date: DATE,
    };
    const p = presignUrl({ ...base, expiresSeconds: 3600.9 });
    expect(p.url.startsWith("https://storage.example.com/bucket/a%20b.json?")).toBe(true);
    expect(p.url).toContain("X-Amz-Expires=3600");
    expect(p.url.endsWith(`X-Amz-Signature=${p.signature}`)).toBe(true);
    expect(p.canonicalRequest.startsWith("PUT\n/bucket/a%20b.json\n")).toBe(true);
    expect(p.canonicalRequest.endsWith("host:storage.example.com\n\nhost\nUNSIGNED-PAYLOAD")).toBe(true);
    expect(presignUrl({ ...base, expiresSeconds: 0 }).url).toContain("X-Amz-Expires=1&");
    expect(presignUrl({ ...base, expiresSeconds: 99_999_999 }).url).toContain("X-Amz-Expires=604800&");
  });

  it("presignUrl defaults date to now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(DATE);
    const p = presignUrl({
      method: "GET",
      origin: "https://h.example.com",
      path: "/b/k",
      region: "r",
      service: "s3",
      accessKeyId: KEY,
      secretAccessKey: SECRET,
      expiresSeconds: 60,
    });
    expect(p.url).toContain("X-Amz-Date=20130524T000000Z");
  });
});
