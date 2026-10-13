/**
 * The Nebius Serverless Jobs backend: what a dispatch sends, and how a job reads back.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { JobsBackend, PROBE_PATH } from "@/lib/backend/jobs-backend";
import { loadConfig, type NebiusConfig } from "@/lib/nebius/config";
import { resetTokenCache } from "@/lib/nebius/auth";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function config(): NebiusConfig {
  const result = loadConfig({
    NEBIUS_SERVICE_ACCOUNT_ID: "serviceaccount-e00test",
    NEBIUS_AUTH_KEY_ID: "publickey-e00test",
    NEBIUS_AUTH_PRIVATE_KEY: privateKey,
    NEBIUS_PROJECT_ID: "project-e01home",
    NEBIUS_SUBNET_ID: "vpcsubnet-e01home",
    NEBIUS_BUCKET: "faultline-test",
    NEBIUS_S3_ACCESS_KEY_ID: "k",
    NEBIUS_S3_SECRET_ACCESS_KEY: "s",
    FAULTLINE_EXTRA_REGIONS: "uk-south1:project-e03uk:vpcsubnet-e03uk",
  } as unknown as NodeJS.ProcessEnv);
  if (!result.configured) throw new Error("expected configured");
  return result.config;
}

function api(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/oauth2/token/exchange")) {
      return new Response(JSON.stringify({ access_token: "t", expires_in: 43200, token_type: "Bearer" }));
    }
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return handler(url, init);
  };
  return { impl, calls };
}

const LAUNCH = {
  name: "faultline-abcd1234-r1-i7-c0ffee-a1",
  region: "uk-south1",
  huntId: "abcd1234-0000-0000-0000-000000000000",
  probeKey: "r1-i7-c0ffee-a1",
  repoUrl: "https://github.com/a/b",
  commitSha: "c0ffee",
  testCommand: "pytest -q",
  installCommand: "pip install -e .[test]",
  verdictUrl: "https://storage.eu-west1.nebius.cloud/faultline-test/hunts/h/verdicts/k.json?X-Amz-Signature=abc",
  tickUrl: null,
  timeoutSeconds: 900,
};

beforeEach(() => resetTokenCache());

describe("JobsBackend", () => {
  it("dispatches into the chosen region's project and subnet, with the probe injected", async () => {
    const net = api(() => new Response(JSON.stringify({ resourceId: "aijob-e03x" })));
    const backend = new JobsBackend(config(), net.impl);
    expect(backend.capacity()).toBe(4);
    expect(await backend.dispatch(LAUNCH)).toEqual({ runId: "aijob-e03x" });

    const body = net.calls[0]?.body as { metadata: { parentId: string; name: string }; spec: Record<string, unknown> };
    expect(body.metadata).toEqual({ parentId: "project-e03uk", name: LAUNCH.name });
    expect(body.spec.subnetId).toBe("vpcsubnet-e03uk");
    expect(body.spec.args).toBe(`-u ${PROBE_PATH}`);
    const env = Object.fromEntries((body.spec.environmentVariables as Array<{ name: string; value: string }>).map((e) => [e.name, e.value]));
    expect(env.FAULTLINE_INSTALL_COMMAND).toBe("pip install -e .[test]");
    expect(env.FAULTLINE_TIMEOUT_SECONDS).toBe("900");
    // No tick URL configured, so none is sent.
    expect(env.FAULTLINE_TICK_URL).toBeUndefined();
  });

  it("refuses to dispatch to a region it was not configured with", async () => {
    const backend = new JobsBackend(config(), api(() => new Response("{}")).impl);
    await expect(backend.dispatch({ ...LAUNCH, region: "us-central1" })).rejects.toThrow(/not configured/);
  });

  it("reads a job's state and timestamps, created time from the metadata", async () => {
    const net = api(() =>
      new Response(
        JSON.stringify({
          metadata: { id: "aijob-e03x", parentId: "p", name: "n", createdAt: "2026-10-13T15:06:39Z" },
          status: { state: "ERROR", stateDetails: { code: "QuotaExceeded", message: "limit 2 requested 3" } },
        }),
      ),
    );
    const status = await new JobsBackend(config(), net.impl).status("aijob-e03x");
    expect(status).toEqual({
      state: "ERROR",
      terminal: true,
      createdAt: "2026-10-13T15:06:39Z",
      startedAt: null,
      finishedAt: null,
      code: "QuotaExceeded",
      message: "limit 2 requested 3",
    });
  });

  it("reports a vanished job as null rather than throwing", async () => {
    const net = api(() => new Response("not found", { status: 404 }));
    expect(await new JobsBackend(config(), net.impl).status("aijob-gone")).toBeNull();
  });

  it("finds a job by its deterministic name in that region's project", async () => {
    const net = api(() => new Response(JSON.stringify({ metadata: { id: "aijob-e03found" }, status: { state: "RUNNING" } })));
    const found = await new JobsBackend(config(), net.impl).find(LAUNCH.name, "uk-south1");
    expect(found).toEqual({ runId: "aijob-e03found" });
    expect(net.calls[0]?.url).toContain("/ai/v1/jobs/get-by-name?parentId=project-e03uk&name=faultline-abcd1234-r1-i7-c0ffee-a1");
  });

  it("cancels through the documented cancel endpoint", async () => {
    const net = api(() => new Response(JSON.stringify({ resourceId: "aijob-e03x" })));
    await new JobsBackend(config(), net.impl).cancel("aijob-e03x");
    expect(net.calls[0]?.url).toBe("https://api.nebius.cloud/ai/v1/jobs/cancel");
    expect(net.calls[0]?.body).toEqual({ id: "aijob-e03x" });
  });
});
