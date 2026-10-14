/**
 * The Token Factory Sandboxes backend: configuration, the REST client, the four verbs, backend
 * selection, pricing, and the verify view's live list.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  DEFAULT_SANDBOX_SLOTS,
  loadConfig,
  loadSandboxesConfig,
  probeBackendKind,
  SANDBOXES_BASE_URL,
  type NebiusConfig,
  type SandboxesConfig,
} from "@/lib/nebius/config";
import { cancelOperation, getOperation, listOperations, spawnInstance } from "@/lib/nebius/sandboxes";
import { NebiusApiError, recentCalls } from "@/lib/nebius/jobs";
import { SANDBOXES_BACKEND_ID, SANDBOXES_REGION, SandboxesBackend, toStatus } from "@/lib/backend/sandboxes-backend";
import { JobsBackend } from "@/lib/backend/jobs-backend";
import { selectBackend } from "@/lib/store";
import { huntCostUsd } from "@/lib/pricing";
import { clearRecentSandboxesCache, recentSandboxes } from "@/lib/nebius/recent-sandboxes";
import { PROBE_SOURCE } from "@/lib/probe-source";
import type { Probe } from "@/lib/types";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const CLOUD_ENV = {
  NEBIUS_SERVICE_ACCOUNT_ID: "serviceaccount-e00test",
  NEBIUS_AUTH_KEY_ID: "publickey-e00test",
  NEBIUS_AUTH_PRIVATE_KEY: privateKey,
  NEBIUS_PROJECT_ID: "project-e01home",
  NEBIUS_SUBNET_ID: "vpcsubnet-e01home",
  NEBIUS_BUCKET: "faultline-test",
  NEBIUS_S3_ACCESS_KEY_ID: "k",
  NEBIUS_S3_SECRET_ACCESS_KEY: "s",
};

function cloud(): NebiusConfig {
  const result = loadConfig(CLOUD_ENV as unknown as NodeJS.ProcessEnv);
  if (!result.configured) throw new Error("expected configured");
  return result.config;
}

const SB: SandboxesConfig = {
  apiKey: "tf-key",
  projectId: "aiproject-test",
  baseUrl: "https://sb.example/sandboxes",
  image: "python:3.11",
  slots: 12,
};

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function api(handler: Handler) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return handler(url, init);
  };
  return { impl, calls };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

const LAUNCH = {
  name: "faultline-abcd1234-r1-i7-c0ffee-a1",
  region: SANDBOXES_REGION,
  huntId: "abcd1234-0000-0000-0000-000000000000",
  probeKey: "r1-i7-c0ffee-a1",
  repoUrl: "https://github.com/a/b",
  commitSha: "c0ffee",
  testCommand: "pytest -q",
  installCommand: "",
  verdictUrl: "https://storage.eu-west1.nebius.cloud/b/hunts/h/verdicts/k.json?X-Amz-Signature=abc",
  tickUrl: null as string | null,
  timeoutSeconds: 900,
};

describe("Sandboxes configuration", () => {
  it("defaults to Jobs and selects Sandboxes only by name", () => {
    expect(probeBackendKind({} as NodeJS.ProcessEnv)).toBe("jobs");
    expect(probeBackendKind({ FAULTLINE_PROBE_BACKEND: "jobs" } as unknown as NodeJS.ProcessEnv)).toBe("jobs");
    expect(probeBackendKind({ FAULTLINE_PROBE_BACKEND: " Sandboxes " } as unknown as NodeJS.ProcessEnv)).toBe("sandboxes");
    expect(probeBackendKind({ FAULTLINE_PROBE_BACKEND: "contree" } as unknown as NodeJS.ProcessEnv)).toBe("jobs");
    expect(probeBackendKind()).toBe(probeBackendKind(process.env));
  });

  it("needs a key and a Token Factory project", () => {
    expect(loadSandboxesConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(loadSandboxesConfig({ TOKENFACTORY_API_KEY: "k" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(loadSandboxesConfig({ TOKENFACTORY_PROJECT_ID: "aiproject-x" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(loadSandboxesConfig({ TOKENFACTORY_API_KEY: "k", TOKENFACTORY_PROJECT_ID: "aiproject-x" } as unknown as NodeJS.ProcessEnv)).toEqual({
      apiKey: "k",
      projectId: "aiproject-x",
      baseUrl: SANDBOXES_BASE_URL,
      image: "python:3.11",
      slots: DEFAULT_SANDBOX_SLOTS,
    });
    expect(loadSandboxesConfig()).toEqual(loadSandboxesConfig(process.env));
  });

  it("takes overrides, and clamps slots to the beta's 50-operation cap", () => {
    const base = { TOKENFACTORY_API_KEY: "k", TOKENFACTORY_PROJECT_ID: "aiproject-x" };
    const c = loadSandboxesConfig({
      ...base,
      FAULTLINE_SANDBOXES_API_KEY: "dedicated",
      FAULTLINE_SANDBOXES_URL: "https://other.example/sb//",
      FAULTLINE_PROBE_IMAGE: "python:3.12",
      FAULTLINE_SANDBOX_SLOTS: "50",
    } as unknown as NodeJS.ProcessEnv);
    expect(c).toMatchObject({ apiKey: "dedicated", baseUrl: "https://other.example/sb", image: "python:3.12", slots: 50 });
    for (const bad of ["51", "0", "2.5", "many"]) {
      expect(loadSandboxesConfig({ ...base, FAULTLINE_SANDBOX_SLOTS: bad } as unknown as NodeJS.ProcessEnv)?.slots).toBe(DEFAULT_SANDBOX_SLOTS);
    }
  });
});

describe("Sandboxes REST client", () => {
  it("spawns with the key and the Project header, and logs the call", async () => {
    const net = api(() => json({ uuid: "op-1" }, 201));
    expect(await spawnInstance(SB, { image: "tag:python:3.11" } as never, net.impl)).toBe("op-1");
    expect(net.calls[0]).toMatchObject({
      url: "https://sb.example/sandboxes/v1/instances",
      method: "POST",
      headers: { Authorization: "Bearer tf-key", Project: "aiproject-test", "Content-Type": "application/json" },
    });
    expect(recentCalls().at(-1)).toMatchObject({ method: "POST", path: "/sandboxes/v1/instances", status: 201 });
  });

  it("refuses a spawn answer with no operation uuid", async () => {
    await expect(spawnInstance(SB, {} as never, api(() => json({})).impl)).rejects.toThrow(/no operation uuid/);
    await expect(spawnInstance(SB, {} as never, api(() => new Response("", { status: 201 })).impl)).rejects.toThrow(/no operation uuid/);
  });

  it("turns a non-2xx into a NebiusApiError, even when the body cannot be read", async () => {
    const err = await spawnInstance(SB, {} as never, api(() => new Response("slow down", { status: 429, statusText: "Too Many Requests" })).impl).catch((e) => e);
    expect(err).toBeInstanceOf(NebiusApiError);
    expect(err.message).toMatch(/429/);
    expect(err.body).toBe("slow down");

    const broken = new Response("x", { status: 500 });
    Object.defineProperty(broken, "text", { value: () => Promise.reject(new Error("gone")) });
    const err2 = await spawnInstance(SB, {} as never, api(() => broken).impl).catch((e) => e);
    expect(err2).toBeInstanceOf(NebiusApiError);
    expect(err2.body).toBe("");
  });

  it("reads an operation, and a 404 as gone", async () => {
    const op = { uuid: "op-1", kind: "instance", status: "SUCCESS", error: null, created_at: null, duration: 1 };
    expect(await getOperation(SB, "op-1", api(() => json(op)).impl)).toEqual(op);
    expect(await getOperation(SB, "op-1", api(() => json({ error: "nf" }, 404)).impl)).toBeNull();
    await expect(getOperation(SB, "op-1", api(() => json({}, 503)).impl)).rejects.toThrow(/503/);
  });

  it("lists instance operations since a time; anything but an array is empty", async () => {
    const net = api(() => json([{ uuid: "a" }]));
    expect(await listOperations(SB, new Date("2026-10-14T10:00:00Z"), net.impl)).toEqual([{ uuid: "a" }]);
    expect(net.calls[0]?.url).toBe("https://sb.example/sandboxes/v1/operations?kind=instance&since=2026-10-14T10%3A00%3A00.000Z");
    expect(await listOperations(SB, new Date(), api(() => json({ items: [] })).impl)).toEqual([]);
  });

  it("cancels with DELETE, accepting an empty answer", async () => {
    const net = api(() => new Response(null, { status: 204 }));
    await cancelOperation(SB, "op-1", net.impl);
    expect(net.calls[0]).toMatchObject({ url: "https://sb.example/sandboxes/v1/operations/op-1", method: "DELETE" });
  });
});

describe("SandboxesBackend", () => {
  it("is one pseudo-region whose capacity is the configured slot count", () => {
    const backend = new SandboxesBackend(SB);
    expect(backend.id).toBe(SANDBOXES_BACKEND_ID);
    expect(backend.regions).toEqual([SANDBOXES_REGION]);
    expect(backend.capacity()).toBe(12);
    expect(new SandboxesBackend({ ...SB, slots: 500 }).capacity()).toBe(50);
    expect(new SandboxesBackend({ ...SB, slots: 0 }).capacity()).toBe(1);
  });

  it("dispatches probe.py on stdin to a disposable sandbox, with no credential in its environment", async () => {
    const net = api(() => json({ uuid: "op-9" }, 201));
    const backend = new SandboxesBackend(SB, net.impl);
    expect(await backend.dispatch({ ...LAUNCH, tickUrl: "https://app/api/hunts/h/tick" })).toEqual({ runId: "op-9" });

    const body = net.calls[0]?.body as Record<string, unknown> & { env: Record<string, string>; stdin: { value: string; encoding: string } };
    expect(body).toMatchObject({
      command: "python3",
      args: ["-u", "-"],
      image: "tag:python:3.11",
      hostname: LAUNCH.name,
      shell: false,
      disposable: true,
      timeout: 1200,
      files: {},
    });
    expect(Buffer.from(body.stdin.value, "base64").toString("utf8")).toBe(PROBE_SOURCE);
    expect(body.stdin.encoding).toBe("base64");
    expect(body.env.FAULTLINE_TICK_URL).toBe("https://app/api/hunts/h/tick");
    expect(body.env.FAULTLINE_VERDICT_URL).toBe(LAUNCH.verdictUrl);
    expect(Object.keys(body.env).sort()).toEqual([
      "FAULTLINE_COMMIT_SHA", "FAULTLINE_HUNT_ID", "FAULTLINE_INSTALL_COMMAND", "FAULTLINE_PROBE_KEY",
      "FAULTLINE_REPO_URL", "FAULTLINE_TEST_COMMAND", "FAULTLINE_TICK_URL", "FAULTLINE_TIMEOUT_SECONDS", "FAULTLINE_VERDICT_URL",
    ]);
    expect(JSON.stringify(body)).not.toContain("tf-key");
  });

  it("omits the tick URL when there is none, and caps the timeout at the API's 3600 s", async () => {
    const net = api(() => json({ uuid: "op-9" }, 201));
    await new SandboxesBackend(SB, net.impl).dispatch({ ...LAUNCH, timeoutSeconds: 3500 });
    const body = net.calls[0]?.body as { env: Record<string, string>; timeout: number };
    expect(body.env.FAULTLINE_TICK_URL).toBeUndefined();
    expect(body.timeout).toBe(3600);
  });

  it("refuses a region that is not its own", async () => {
    const backend = new SandboxesBackend(SB, api(() => json({})).impl);
    await expect(backend.dispatch({ ...LAUNCH, region: "eu-west1" })).rejects.toThrow(/not a Sandboxes region/);
    await expect(backend.find("x", "eu-west1")).rejects.toThrow(/not a Sandboxes region/);
  });

  it("reports status in the engine's job-state words, and a vanished operation as null", async () => {
    const op = { uuid: "op-1", kind: "instance", status: "SUCCESS", error: null, created_at: "2026-10-14T12:41:04.075263+00:00", duration: 1.077 };
    const backend = new SandboxesBackend(SB, api((url) => (url.endsWith("/op-1") ? json(op) : json({}, 404))).impl);
    expect(await backend.status("op-1")).toEqual({
      state: "COMPLETED",
      terminal: true,
      createdAt: op.created_at,
      startedAt: null,
      finishedAt: "2026-10-14T12:41:05.152Z",
      code: null,
      message: null,
    });
    expect(await backend.status("op-2")).toBeNull();
  });

  it("maps every operation status, timeouts and exit codes", () => {
    const base = { uuid: "u", kind: "instance", error: null, created_at: "2026-10-14T00:00:00Z", duration: 2 };
    expect(toStatus({ ...base, status: "ASSIGNED" })).toMatchObject({ state: "PROVISIONING", terminal: false, finishedAt: null });
    expect(toStatus({ ...base, status: "PENDING" }).state).toBe("PROVISIONING");
    expect(toStatus({ ...base, status: "EXECUTING" })).toMatchObject({ state: "RUNNING", terminal: false });
    expect(toStatus({ ...base, status: "CANCELLED" })).toMatchObject({ state: "CANCELLED", terminal: true });
    expect(toStatus({ ...base, status: "SOMETHING_NEW" })).toMatchObject({ state: "STATE_UNSPECIFIED", terminal: false });
    expect(
      toStatus({ ...base, status: "FAILED", error: "boom", metadata: { result: { state: { exit_code: 0, timed_out: true } } } }),
    ).toMatchObject({ state: "FAILED", terminal: true, code: "TimedOut", message: "boom", finishedAt: "2026-10-14T00:00:02.000Z" });
    expect(toStatus({ ...base, status: "SUCCESS", metadata: { result: { state: { exit_code: 3 } } } }).code).toBe("ExitCode3");
    expect(toStatus({ ...base, status: "SUCCESS", metadata: { result: null } }).code).toBeNull();
    expect(toStatus({ ...base, status: "SUCCESS", created_at: null })).toMatchObject({ createdAt: null, finishedAt: null });
    expect(toStatus({ ...base, status: "SUCCESS", duration: null }).finishedAt).toBeNull();
    expect(toStatus({ ...base, status: "SUCCESS", created_at: "not a date" }).finishedAt).toBeNull();
    expect(toStatus({ ...base, status: "SUCCESS", error: undefined as never, created_at: undefined as never })).toMatchObject({ message: null, createdAt: null });
  });

  it("finds a lost dispatch by the hostname it was given, reading only recent operations", async () => {
    const detail: Record<string, unknown> = {
      a: { uuid: "a", metadata: { hostname: "faultline-other" } },
      b: { uuid: "b", metadata: { hostname: LAUNCH.name } },
      c: { uuid: "c" },
    };
    const net = api((url) => {
      if (url.includes("/v1/operations?")) return json([{ uuid: "c" }, { uuid: "a" }, { uuid: "b" }]);
      const id = url.split("/").pop() as string;
      return detail[id] ? json(detail[id]) : json({}, 404);
    });
    const now = Date.parse("2026-10-14T12:00:00Z");
    const backend = new SandboxesBackend(SB, net.impl, () => now);
    expect(await backend.find(LAUNCH.name, SANDBOXES_REGION)).toEqual({ runId: "b" });
    expect(net.calls[0]?.url).toContain(`since=${encodeURIComponent("2026-10-14T09:00:00.000Z")}`);
    expect(await backend.find("faultline-nobody", SANDBOXES_REGION)).toBeNull();
    // A detail that has vanished is skipped.
    expect(await new SandboxesBackend(SB, api((url) => (url.includes("?") ? json([{ uuid: "zz" }]) : json({}, 404))).impl).find("x", SANDBOXES_REGION)).toBeNull();
  });

  it("cancels the operation", async () => {
    const net = api(() => new Response(null, { status: 204 }));
    await new SandboxesBackend(SB, net.impl).cancel("op-3");
    expect(net.calls[0]).toMatchObject({ method: "DELETE", url: "https://sb.example/sandboxes/v1/operations/op-3" });
  });
});

describe("selectBackend", () => {
  const SANDBOX_ENV = { TOKENFACTORY_API_KEY: "k", TOKENFACTORY_PROJECT_ID: "aiproject-x" };

  it("runs on Jobs unless Sandboxes is asked for and configured", () => {
    expect(selectBackend(cloud(), { ...CLOUD_ENV } as unknown as NodeJS.ProcessEnv)).toBeInstanceOf(JobsBackend);
    expect(selectBackend(cloud(), { ...SANDBOX_ENV } as unknown as NodeJS.ProcessEnv)).toBeInstanceOf(JobsBackend);
    // Asked for but missing its project: Jobs is the fallback.
    expect(selectBackend(cloud(), { FAULTLINE_PROBE_BACKEND: "sandboxes", TOKENFACTORY_API_KEY: "k" } as unknown as NodeJS.ProcessEnv)).toBeInstanceOf(JobsBackend);
    const chosen = selectBackend(cloud(), { FAULTLINE_PROBE_BACKEND: "sandboxes", ...SANDBOX_ENV } as unknown as NodeJS.ProcessEnv);
    expect(chosen).toBeInstanceOf(SandboxesBackend);
    expect(chosen.capacity()).toBe(DEFAULT_SANDBOX_SLOTS);
    expect(selectBackend(cloud())).toBeInstanceOf(process.env.FAULTLINE_PROBE_BACKEND === "sandboxes" && process.env.TOKENFACTORY_PROJECT_ID ? SandboxesBackend : JobsBackend);
  });
});

describe("pricing on Sandboxes", () => {
  it("derives no cost for a backend with no published list price", () => {
    const probe = { vmMs: 60_000, phase: "done" } as unknown as Probe;
    expect(huntCostUsd({ probes: [probe], backend: SANDBOXES_BACKEND_ID })).toBeNull();
    expect(huntCostUsd({ probes: [probe], backend: "nebius-serverless-jobs" })).toBeGreaterThan(0);
    expect(huntCostUsd({ probes: [probe] })).toBeGreaterThan(0);
  });
});

describe("recentSandboxes", () => {
  beforeEach(() => clearRecentSandboxesCache());

  it("lists the newest operations with identifying fields only, and caches for a minute", async () => {
    let reads = 0;
    const net = api(() => {
      reads += 1;
      return json([
        { uuid: "old", status: "SUCCESS", created_at: "2026-10-14T10:00:00Z", duration: 30.5, metadata: { env: { FAULTLINE_VERDICT_URL: "secret" } } },
        { uuid: "new", status: "EXECUTING", created_at: "2026-10-14T11:00:00Z", duration: null },
        { uuid: "undated", status: "PENDING" },
      ]);
    });
    let t = Date.parse("2026-10-14T12:00:00Z");
    const first = await recentSandboxes(SB, { fetchImpl: net.impl, now: () => t, limit: 2 });
    expect(first).toEqual({
      operations: [
        { id: "new", state: "EXECUTING", createdAt: "2026-10-14T11:00:00Z", durationSeconds: null },
        { id: "old", state: "SUCCESS", createdAt: "2026-10-14T10:00:00Z", durationSeconds: 30.5 },
      ],
      unavailable: false,
      readAt: "2026-10-14T12:00:00.000Z",
    });
    expect(JSON.stringify(first)).not.toContain("secret");
    t += 30_000;
    await recentSandboxes(SB, { fetchImpl: net.impl, now: () => t });
    expect(reads).toBe(1);
    t += 60_000;
    const third = await recentSandboxes(SB, { fetchImpl: net.impl, now: () => t });
    expect(reads).toBe(2);
    expect(third.operations.at(-1)?.id).toBe("undated");
  });

  it("says unavailable on a failed or slow read, and never throws", async () => {
    const failed = await recentSandboxes(SB, { fetchImpl: api(() => json({}, 500)).impl });
    expect(failed).toMatchObject({ operations: [], unavailable: true });
    const slow = await recentSandboxes(SB, {
      fetchImpl: () => new Promise<Response>(() => undefined),
      timeoutMs: 5,
    });
    expect(slow.unavailable).toBe(true);
    // Defaults: the real clock and fetch are only named, never reached in this case.
    clearRecentSandboxesCache();
    const viaDefaults = await recentSandboxes({ ...SB, baseUrl: "http://127.0.0.1:9" }, { timeoutMs: 2000 });
    expect(viaDefaults.unavailable).toBe(true);
  });
});
