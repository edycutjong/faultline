import { generateKeyPairSync, createVerify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NebiusAuthError,
  exchangeToken,
  getAccessToken,
  resetTokenCache,
  signJwt,
} from "@/lib/nebius/auth";
import { NEBIUS_TOKEN_EXCHANGE_URL } from "@/lib/nebius/config";
import type { NebiusConfig } from "@/lib/nebius/config";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const config = {
  serviceAccountId: "sa-1",
  authKeyId: "key-1",
  privateKeyPem: privateKey,
} as NebiusConfig;

function okResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

describe("nebius auth", () => {
  beforeEach(() => resetTokenCache());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("signs a verifiable RS256 JWT with the expected claims", () => {
    const jwt = signJwt(config, 1000);
    const [h, p, s] = jwt.split(".");
    const dec = (x: string) => JSON.parse(Buffer.from(x, "base64url").toString());
    expect(dec(h)).toEqual({ alg: "RS256", typ: "JWT", kid: "key-1" });
    expect(dec(p)).toEqual({ iss: "sa-1", sub: "sa-1", iat: 1000, exp: 1300 });
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${p}`);
    expect(v.verify(publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });

  it("defaults the issue time to the current clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(5_000_000));
    const p = JSON.parse(Buffer.from(signJwt(config).split(".")[1], "base64url").toString());
    expect(p.iat).toBe(5000);
  });

  it("exchanges a token via the injected fetch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    const f = vi.fn().mockResolvedValue(okResponse({ access_token: "tok", expires_in: 60 }));
    const r = await exchangeToken(config, f as unknown as typeof fetch);
    expect(r).toEqual({ token: "tok", expiresAtMs: 1_060_000 });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(NEBIUS_TOKEN_EXCHANGE_URL);
    expect(init.method).toBe("POST");
    const params = new URLSearchParams(init.body);
    expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
    expect(params.get("subject_token")?.split(".")).toHaveLength(3);
  });

  it("throws NebiusAuthError with detail on a failed exchange", async () => {
    const f = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "bad kid",
    });
    const err = await exchangeToken(config, f as unknown as typeof fetch).catch((e) => e);
    expect(err).toBeInstanceOf(NebiusAuthError);
    expect(err.name).toBe("NebiusAuthError");
    expect(err.status).toBe(401);
    expect(err.message).toBe("token exchange failed: 401 Unauthorized — bad kid");
  });

  it("omits the detail when the error body is empty or unreadable", async () => {
    const empty = vi.fn().mockResolvedValue({
      ok: false, status: 500, statusText: "Err", text: async () => "",
    });
    await expect(exchangeToken(config, empty as unknown as typeof fetch)).rejects.toThrow(
      /^token exchange failed: 500 Err$/,
    );
    const broken = vi.fn().mockResolvedValue({
      ok: false, status: 503, statusText: "Down",
      text: async () => { throw new Error("boom"); },
    });
    await expect(exchangeToken(config, broken as unknown as typeof fetch)).rejects.toThrow(
      /^token exchange failed: 503 Down$/,
    );
  });

  it("throws 502 when no access_token is returned", async () => {
    const f = vi.fn().mockResolvedValue(okResponse({ expires_in: 1 }));
    const err = await exchangeToken(config, f as unknown as typeof fetch).catch((e) => e);
    expect(err).toBeInstanceOf(NebiusAuthError);
    expect(err.status).toBe(502);
  });

  it("caches tokens and re-mints near expiry, using global fetch by default", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const f = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ access_token: "a", expires_in: 3600 }))
      .mockResolvedValueOnce(okResponse({ access_token: "b", expires_in: 3600 }));
    vi.stubGlobal("fetch", f);
    expect(await getAccessToken(config)).toBe("a");
    expect(await getAccessToken(config)).toBe("a");
    expect(f).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(3600_000 - 5 * 60_000)); // inside 10 min margin
    expect(await getAccessToken(config)).toBe("b");
    expect(f).toHaveBeenCalledTimes(2);
  });
});
