/**
 * Service-account authentication for the Nebius REST API.
 *
 * The Jobs API accepts only a Bearer access token, and there is no long-lived API key that
 * works for it: the documented path is to sign a short-lived RS256 JWT with the service
 * account's authorized key and exchange it for an access token (TTL 12h). No refresh-token
 * grant is documented, so we re-mint rather than refresh.
 *
 * Implemented with node:crypto rather than a JWT library — the payload is five claims and a
 * signature, and a dependency here would be a supply-chain surface on the credential path.
 */

import { createSign } from "node:crypto";
import type { NebiusConfig } from "./config";
import { NEBIUS_TOKEN_EXCHANGE_URL } from "./config";

/** The JWT is only ever used to obtain an access token, so it lives for five minutes. */
const JWT_TTL_SECONDS = 300;

/**
 * Re-mint this long before the 12h access-token expiry. A token that expires mid-hunt would
 * strand dispatched jobs with no way to poll them, so the margin is generous on purpose.
 */
const TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000;

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/**
 * Module-level cache. On Vercel each warm lambda reuses it and a cold one simply re-mints;
 * both are correct, and the alternative (a shared token store) would add a dependency to save
 * one HTTPS round trip per cold start.
 */
let cache: CachedToken | null = null;

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Sign the RS256 JWT that the token-exchange endpoint accepts as a subject token. */
export function signJwt(config: NebiusConfig, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = { alg: "RS256", typ: "JWT", kid: config.authKeyId };
  const payload = {
    iss: config.serviceAccountId,
    sub: config.serviceAccountId,
    iat: nowSeconds,
    exp: nowSeconds + JWT_TTL_SECONDS,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload),
  )}`;

  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = base64url(signer.sign(config.privateKeyPem));

  return `${signingInput}.${signature}`;
}

interface TokenExchangeResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

/** Exchange a signed JWT for a Bearer access token. */
export async function exchangeToken(
  config: NebiusConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<CachedToken> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    subject_token: signJwt(config),
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
  });

  const res = await fetchImpl(NEBIUS_TOKEN_EXCHANGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    // The response body of a failed exchange names the reason (bad kid, revoked key,
    // suspended tenant), and that is exactly what an operator needs to see.
    const detail = await safeText(res);
    throw new NebiusAuthError(
      `token exchange failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`,
      res.status,
    );
  }

  const json = (await res.json()) as TokenExchangeResponse;
  if (!json.access_token) {
    throw new NebiusAuthError("token exchange returned no access_token", 502);
  }

  return {
    token: json.access_token,
    expiresAtMs: Date.now() + json.expires_in * 1000,
  };
}

/** Get a valid access token, minting a new one when the cached one is near expiry. */
export async function getAccessToken(
  config: NebiusConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (cache && cache.expiresAtMs - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
    return cache.token;
  }
  cache = await exchangeToken(config, fetchImpl);
  return cache.token;
}

/** Test seam: drop the cached token so a test can observe a fresh exchange. */
export function resetTokenCache(): void {
  cache = null;
}

export class NebiusAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "NebiusAuthError";
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
