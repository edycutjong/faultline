/**
 * SigV4 verified against AWS's own published signing examples.
 *
 * These are not hand-rolled expectations: every signature below is the value AWS publishes
 * for that exact request. If the signer drifts, these fail — which is the only way to have
 * confidence in a signature implementation without live credentials to try it against.
 */

import { describe, it, expect } from "vitest";
import {
  signRequest,
  canonicalUri,
  canonicalQueryString,
  uriEncode,
  sha256Hex,
} from "@/lib/nebius/sigv4";

// Credentials from AWS's `aws-sig-v4-test-suite`.
const SUITE_KEY = "AKIDEXAMPLE";
const SUITE_SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const SUITE_DATE = new Date("2015-08-30T12:36:00Z");

// Credentials from the AWS S3 "Authorization Header" worked examples.
const S3_KEY = "AKIAIOSFODNN7EXAMPLE";
const S3_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const S3_DATE = new Date("2013-05-24T00:00:00Z");

describe("SigV4 — AWS aws-sig-v4-test-suite vectors", () => {
  it("get-vanilla produces AWS's published canonical request, string-to-sign and signature", () => {
    const signed = signRequest({
      method: "GET",
      path: "/",
      headers: { Host: "example.amazonaws.com" },
      payload: "",
      region: "us-east-1",
      service: "service",
      accessKeyId: SUITE_KEY,
      secretAccessKey: SUITE_SECRET,
      date: SUITE_DATE,
    });

    expect(signed.canonicalRequest).toBe(
      [
        "GET",
        "/",
        "",
        "host:example.amazonaws.com",
        "x-amz-date:20150830T123600Z",
        "",
        "host;x-amz-date",
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ].join("\n"),
    );

    // The first three lines are fixed by the spec; the fourth is by definition the hash of
    // the canonical request asserted above, so it is checked for consistency rather than
    // against a copied constant. The external ground truth is the signature itself.
    const [algorithm, timestamp, scope, hashedRequest] = signed.stringToSign.split("\n");
    expect(algorithm).toBe("AWS4-HMAC-SHA256");
    expect(timestamp).toBe("20150830T123600Z");
    expect(scope).toBe("20150830/us-east-1/service/aws4_request");
    expect(hashedRequest).toBe(sha256Hex(signed.canonicalRequest));

    expect(signed.signature).toBe(
      "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("orders query parameters by key before signing", () => {
    const signed = signRequest({
      method: "GET",
      path: "/",
      query: { Param2: "value2", Param1: "value1" },
      headers: { Host: "example.amazonaws.com" },
      payload: "",
      region: "us-east-1",
      service: "service",
      accessKeyId: SUITE_KEY,
      secretAccessKey: SUITE_SECRET,
      date: SUITE_DATE,
    });

    expect(signed.canonicalRequest.split("\n")[2]).toBe("Param1=value1&Param2=value2");
    expect(signed.signature).toBe(
      "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
    );
  });

  it("trims and collapses whitespace in header values before signing", () => {
    const signed = signRequest({
      method: "GET",
      path: "/",
      headers: { Host: "example.amazonaws.com", "My-Header1": "  value1  " },
      payload: "",
      region: "us-east-1",
      service: "service",
      accessKeyId: SUITE_KEY,
      secretAccessKey: SUITE_SECRET,
      date: SUITE_DATE,
    });

    expect(signed.canonicalRequest).toContain("my-header1:value1\n");
  });

  it("omits x-amz-content-sha256 for non-S3 services", () => {
    const signed = signRequest({
      method: "GET",
      path: "/",
      headers: { Host: "example.amazonaws.com" },
      payload: "",
      region: "us-east-1",
      service: "service",
      accessKeyId: SUITE_KEY,
      secretAccessKey: SUITE_SECRET,
      date: SUITE_DATE,
    });

    expect(signed.headers["x-amz-content-sha256"]).toBeUndefined();
  });
});

describe("SigV4 — AWS S3 authorization-header examples", () => {
  it("GET Object matches AWS's published signature", () => {
    const signed = signRequest({
      method: "GET",
      path: "/test.txt",
      headers: { Host: "examplebucket.s3.amazonaws.com", Range: "bytes=0-9" },
      payload: "",
      region: "us-east-1",
      service: "s3",
      accessKeyId: S3_KEY,
      secretAccessKey: S3_SECRET,
      date: S3_DATE,
    });

    expect(signed.signature).toBe(
      "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(signed.headers["x-amz-content-sha256"]).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("PUT Object with a $ in the key matches AWS's published signature", () => {
    const signed = signRequest({
      method: "PUT",
      path: "/test$file.text",
      headers: {
        Host: "examplebucket.s3.amazonaws.com",
        Date: "Fri, 24 May 2013 00:00:00 GMT",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
      },
      payload: "Welcome to Amazon S3.",
      region: "us-east-1",
      service: "s3",
      accessKeyId: S3_KEY,
      secretAccessKey: S3_SECRET,
      date: S3_DATE,
    });

    expect(signed.signature).toBe(
      "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    );
  });

  it("LIST with query parameters matches AWS's published signature", () => {
    const signed = signRequest({
      method: "GET",
      path: "/",
      query: { "max-keys": "2", prefix: "J" },
      headers: { Host: "examplebucket.s3.amazonaws.com" },
      payload: "",
      region: "us-east-1",
      service: "s3",
      accessKeyId: S3_KEY,
      secretAccessKey: S3_SECRET,
      date: S3_DATE,
    });

    expect(signed.signature).toBe(
      "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
    );
  });
});

describe("SigV4 — canonicalisation helpers", () => {
  it("escapes the five characters encodeURIComponent leaves alone", () => {
    expect(uriEncode("a!b'c(d)e*f", true)).toBe("a%21b%27c%28d%29e%2Af");
  });

  it("encodes each path segment but preserves separators", () => {
    expect(canonicalUri("/hunts/a b/c$d.json")).toBe("/hunts/a%20b/c%24d.json");
  });

  it("treats a root or empty path as a single slash", () => {
    expect(canonicalUri("/")).toBe("/");
    expect(canonicalUri("")).toBe("/");
  });

  it("sorts query keys and encodes values", () => {
    expect(canonicalQueryString({ b: "2", a: "x y" })).toBe("a=x%20y&b=2");
  });

  it("returns an empty string for no query parameters", () => {
    expect(canonicalQueryString({})).toBe("");
  });

  it("hashes the empty payload to the well-known SHA-256 of the empty string", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
