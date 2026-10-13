/**
 * End-to-end hunt, driven through the real dispatch and reconcile code.
 *
 * Nebius is simulated at the HTTP boundary — every layer above it (auth, the Jobs REST
 * client, SigV4-signed storage with conditional writes, presigned verdict URLs, the store,
 * the planner, the tick, Token Factory narration) is the production code path. A simulated
 * job "runs" its probe by PUTting a verdict to the presigned URL in its environment, exactly
 * as probe.py does — so these tests also check what a job is given: probe.py as an injected
 * file, and no credential and no bucket mount, ever.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import type { Hunt, ProbeResult, Verdict } from "@/lib/types";
import { newHunt, startHunt, tick } from "@/lib/hunt";
import { readHunt, resetMemoryStore, storeContext } from "@/lib/store";
import { resetTokenCache } from "@/lib/nebius/auth";
import { PROBE_SOURCE } from "@/lib/probe-source";
import { probeCostUsd } from "@/lib/nebius/config";
import { indexOf, must, shaFor, syntheticCommits } from "./helpers";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const S3_SECRET = "test-secret-key-never-in-a-job";
const EXTRA_REGIONS =
  "uk-south1:project-uk1:vpcsubnet-uk1,uk-south2:project-uk2:vpcsubnet-uk2,me-west1:project-me1:vpcsubnet-me1";

type Oracle = (sha: string) => Verdict | "silent";

interface FakeJob {
  state: string;
  env: Record<string, string>;
  parentId: string;
  name: string;
  createdAt: string;
  finishedAt: string | null;
}

/** A simulated Nebius: token exchange, Jobs REST, and an S3 bucket with real ETag semantics. */
function fakeNebius(oracle: Oracle) {
  const objects = new Map<string, { body: string; etag: string }>();
  const jobs = new Map<string, FakeJob>();
  const jobBodies: string[] = [];
  let version = 0;
  let jobCounter = 0;
  let cancelCalls = 0;
  let tfCalls = 0;

  function put(key: string, body: string): string {
    version += 1;
    const etag = `"v${version}"`;
    objects.set(key, { body, etag });
    return etag;
  }

  /** The probe, as the container runs it: one PUT to its presigned URL. */
  function runProbe(job: FakeJob): void {
    const sha = job.env.FAULTLINE_COMMIT_SHA ?? "";
    const verdict = oracle(sha);
    if (verdict === "silent") {
      job.state = "FAILED";
    } else {
      const url = new URL(job.env.FAULTLINE_VERDICT_URL ?? "");
      if (!url.searchParams.get("X-Amz-Signature")) throw new Error("verdict URL is not presigned");
      const key = decodeURIComponent(url.pathname.replace(/^\/faultline-test\//, ""));
      const result: ProbeResult = {
        schema: "faultline.probe.v2",
        huntId: job.env.FAULTLINE_HUNT_ID ?? "",
        probeKey: job.env.FAULTLINE_PROBE_KEY ?? "",
        commitSha: sha,
        verdict,
        exitCode: verdict === "pass" ? 0 : verdict === "fail" ? 1 : null,
        durationMs: 4_800,
        installCommand: job.env.FAULTLINE_INSTALL_COMMAND || "pip install -e . (detected)",
        timings: { cloneMs: 700, installMs: 3_100, testMs: 1_000 },
        detail: null,
        tail: verdict === "fail" ? "E   AssertionError" : null,
      };
      put(key, JSON.stringify(result));
      job.state = "COMPLETED";
    }
    // Measured cold start on 2026-10-13: ~4m20s from create to workload start.
    job.finishedAt = new Date(Date.parse(job.createdAt) + 265_000).toISOString();
  }

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);

    if (url.includes("/oauth2/token/exchange")) {
      return json({ access_token: "test-token", expires_in: 43200, token_type: "Bearer" });
    }

    if (url.endsWith("/ai/v1/jobs/cancel") && method === "POST") {
      cancelCalls += 1;
      const { id } = JSON.parse(String(init?.body ?? "{}")) as { id: string };
      const job = jobs.get(id);
      if (job) job.state = "CANCELLED";
      return json({ resourceId: id });
    }

    if (url.endsWith("/ai/v1/jobs") && method === "POST") {
      const raw = String(init?.body ?? "{}");
      jobBodies.push(raw);
      const body = JSON.parse(raw);
      const env: Record<string, string> = {};
      for (const pair of body.spec?.environmentVariables ?? []) env[pair.name] = pair.value;
      jobCounter += 1;
      const jobId = `aijob-e01${String(jobCounter).padStart(6, "0")}`;
      const job: FakeJob = {
        state: "PROVISIONING",
        env,
        parentId: body.metadata.parentId,
        name: body.metadata.name,
        createdAt: new Date(Date.now()).toISOString(),
        finishedAt: null,
      };
      jobs.set(jobId, job);
      // The container runs and reports at once; the engine sees it on its next tick.
      runProbe(job);
      return json({ resourceId: jobId, status: { code: "OK" } });
    }

    const byName = url.match(/\/ai\/v1\/jobs\/get-by-name\?parentId=([^&]+)&name=([^&]+)/);
    if (byName && method === "GET") {
      for (const [id, job] of jobs) {
        if (job.name === decodeURIComponent(byName[2] ?? "")) return json({ metadata: { id }, status: { state: job.state } });
      }
      return new Response("not found", { status: 404 });
    }

    const jobMatch = url.match(/\/ai\/v1\/jobs\/(aijob-[^/?]+)$/);
    if (jobMatch && method === "GET") {
      const id = jobMatch[1] ?? "";
      const job = jobs.get(id);
      if (!job) return new Response("not found", { status: 404 });
      return json({
        metadata: { id, parentId: job.parentId, name: job.name, createdAt: job.createdAt },
        status: {
          state: job.state,
          startedAt: new Date(Date.parse(job.createdAt) + 260_000).toISOString(),
          finishedAt: job.finishedAt ?? undefined,
        },
      });
    }

    if (url.startsWith("https://api.github.com/") && url.includes("/commits/")) {
      return new Response("diff --git a/pipeline/normalize.py b/pipeline/normalize.py\n-    return aware\n+    return naive\n");
    }

    if (url.includes("tokenfactory") && url.endsWith("/chat/completions")) {
      tfCalls += 1;
      return json({ id: "chatcmpl-int", model: "nvidia/nemotron-3-super-120b-a12b", choices: [{ finish_reason: "stop", message: { content: "The change returns the naive value." } }] });
    }

    // Object Storage, with conditional-write semantics.
    if (url.includes("storage.")) {
      const key = decodeURIComponent(new URL(url).pathname.replace(/^\/faultline-test\//, ""));
      const existing = objects.get(key);
      if (method === "PUT") {
        if (headers.get("if-none-match") === "*" && existing) return new Response("", { status: 412 });
        const ifMatch = headers.get("if-match");
        if (ifMatch && existing?.etag !== ifMatch) return new Response("", { status: 412 });
        const etag = put(key, String(init?.body ?? ""));
        return new Response("", { status: 200, headers: { ETag: etag } });
      }
      if (method === "GET") {
        if (!existing) return new Response("no such key", { status: 404 });
        return new Response(existing.body, { status: 200, headers: { ETag: existing.etag } });
      }
    }

    throw new Error(`unexpected request in test: ${method} ${url}`);
  };

  return {
    impl,
    jobs,
    jobBodies,
    objects,
    stats: () => ({ createCalls: jobBodies.length, cancelCalls, tfCalls }),
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function startLive(commitCount: number): Promise<Hunt> {
  const ctx = storeContext();
  const hunt = newHunt({
    repoUrl: "https://github.com/faultline-bench/tzdata-pipeline",
    testCommand: "pytest tests/test_window.py::test_daily_boundary",
    installCommand: "pip install -e .[test]",
    goodRef: "v1.4.0",
    goodSha: shaFor(0),
    badRef: "HEAD",
    commits: syntheticCommits(commitCount),
    slots: must(ctx.backend).capacity(),
    backend: must(ctx.backend).id,
    regions: [...must(ctx.backend).regions],
    tickBaseUrl: "https://faultline.example",
  });
  const started = await startHunt(ctx, hunt);
  if (!started.ok) throw new Error(started.error);
  return started.hunt;
}

/**
 * Tick until the hunt stops, as the probes' own ticks and the page's poll would — a minute
 * of simulated time apart, because the engine does not poll a job younger than 90 s.
 */
async function runToCompletion(huntId: string, maxTicks = 60): Promise<Hunt> {
  const ctx = storeContext();
  let current = must(await readHunt(ctx, huntId));
  for (let i = 0; i < maxTicks; i += 1) {
    if (["done", "inconclusive", "error", "paused"].includes(current.status)) return current;
    vi.setSystemTime(Date.now() + 60_000);
    current = must(await tick(ctx, huntId));
  }
  throw new Error(`hunt did not settle within ${maxTicks} ticks (status ${current.status})`);
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  resetMemoryStore();
  resetTokenCache();
  process.env.NEBIUS_SERVICE_ACCOUNT_ID = "serviceaccount-e00test";
  process.env.NEBIUS_AUTH_KEY_ID = "publickey-e00test";
  process.env.NEBIUS_AUTH_PRIVATE_KEY = privateKey;
  process.env.NEBIUS_PROJECT_ID = "project-test";
  process.env.NEBIUS_SUBNET_ID = "vpcsubnet-test";
  process.env.NEBIUS_BUCKET = "faultline-test";
  process.env.NEBIUS_S3_ACCESS_KEY_ID = "test-access-key";
  process.env.NEBIUS_S3_SECRET_ACCESS_KEY = S3_SECRET;
  process.env.FAULTLINE_EXTRA_REGIONS = EXTRA_REGIONS;
  process.env.TOKENFACTORY_API_KEY = "tf-test-key";
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  delete process.env.FAULTLINE_EXTRA_REGIONS;
  delete process.env.TOKENFACTORY_API_KEY;
  vi.restoreAllMocks();
});

describe("a full hunt against a simulated Nebius", () => {
  it("settles a 256-commit range in 3 rounds and at most 24 job-runs on 4 regions × 2 slots", async () => {
    const nebius = fakeNebius((sha) => (indexOf(sha) >= 137 ? "fail" : "pass"));
    globalThis.fetch = nebius.impl as typeof fetch;

    const settled = await runToCompletion((await startLive(256)).id);

    expect(settled.status).toBe("done");
    expect(settled.report?.culpritSha).toBe(shaFor(137));
    expect(settled.round).toBe(3);
    expect(settled.probes.length).toBeLessThanOrEqual(24);
    expect(nebius.stats().createCalls).toBe(settled.probes.length);
  });

  it("spreads each round across the configured regions, never more than 2 jobs in one", async () => {
    const nebius = fakeNebius((sha) => (indexOf(sha) >= 137 ? "fail" : "pass"));
    globalThis.fetch = nebius.impl as typeof fetch;

    const settled = await runToCompletion((await startLive(256)).id);
    for (let round = 1; round <= settled.round; round += 1) {
      const perRegion = new Map<string, number>();
      for (const p of settled.probes.filter((x) => x.round === round)) {
        perRegion.set(p.region ?? "?", (perRegion.get(p.region ?? "?") ?? 0) + 1);
      }
      for (const count of perRegion.values()) expect(count).toBeLessThanOrEqual(2);
    }
    const parents = new Set([...nebius.jobs.values()].map((j) => j.parentId));
    expect(parents).toEqual(new Set(["project-test", "project-uk1", "project-uk2", "project-me1"]));
  });

  it("records a real Nebius job id on every probe", async () => {
    const nebius = fakeNebius((sha) => (indexOf(sha) >= 40 ? "fail" : "pass"));
    globalThis.fetch = nebius.impl as typeof fetch;

    const settled = await runToCompletion((await startLive(64)).id);
    expect(settled.probes.length).toBeGreaterThan(0);
    for (const probe of settled.probes) expect(probe.jobId).toMatch(/^aijob-e01\d{6}$/);
  });

  it("finds the culprit at every position in a 64-commit range", async () => {
    for (const culprit of [1, 2, 17, 33, 63, 64]) {
      resetMemoryStore();
      const nebius = fakeNebius((sha) => (indexOf(sha) >= culprit ? "fail" : "pass"));
      globalThis.fetch = nebius.impl as typeof fetch;

      const settled = await runToCompletion((await startLive(64)).id);
      expect(settled.report?.culpritSha, `culprit ${culprit}`).toBe(shaFor(culprit));
    }
  });

  it("prices the hunt from the VM time Nebius reports, never from a constant", async () => {
    const nebius = fakeNebius((sha) => (indexOf(sha) >= 10 ? "fail" : "pass"));
    globalThis.fetch = nebius.impl as typeof fetch;

    const id = (await startLive(64)).id;
    await runToCompletion(id);
    // The last round's jobs were still exiting when the culprit was named; one more read of
    // the finished hunt settles their VM time from the job records.
    vi.setSystemTime(Date.now() + 60_000);
    const settled = must(await tick(storeContext(), id));
    // Every simulated job lived 265 s (create → finish). The pricing constants stay the
    // single source of truth; this asserts the cost scales with the probes that ran.
    expect(settled.probes.every((p) => p.vmMs === 265_000)).toBe(true);
    expect(settled.costUsd).toBeCloseTo(settled.probes.length * probeCostUsd(265_000), 10);
  });

  it("refuses to name a culprit when the verdicts contradict", async () => {
    // Round 1 on 8 slots probes 0, 9, 18, 27, 37, 46, 55 and 64. Everything fails except the
    // good end and one late commit — a pass above a fail, which no single culprit explains.
    const nebius = fakeNebius((sha) => (indexOf(sha) === 0 || indexOf(sha) === 46 ? "pass" : "fail"));
    globalThis.fetch = nebius.impl as typeof fetch;

    const settled = await runToCompletion((await startLive(64)).id);
    expect(settled.status).toBe("inconclusive");
    expect(settled.report).toBeNull();
    expect(settled.inconclusive?.reason).toBe("contradiction");
    expect(settled.inconclusive?.evidence).not.toBeNull();
  });

  it("retries — never records a verdict — when a job ends without reporting", async () => {
    let silent = true;
    const nebius = fakeNebius((sha) => {
      if (silent && indexOf(sha) === 64) {
        silent = false;
        return "silent";
      }
      return indexOf(sha) >= 30 ? "fail" : "pass";
    });
    globalThis.fetch = nebius.impl as typeof fetch;

    const settled = await runToCompletion((await startLive(64)).id);
    const bad = must(settled.probes.find((p) => p.role === "bad"));
    expect(bad.infraFailures).toHaveLength(1);
    expect(bad.attempt).toBe(2);
    expect(bad.verdict).toBe("fail");
    expect(settled.report?.culpritSha).toBe(shaFor(30));
  });

  it("narrates the culprit with one Token Factory call and keeps the diff", async () => {
    const nebius = fakeNebius((sha) => (indexOf(sha) >= 12 ? "fail" : "pass"));
    globalThis.fetch = nebius.impl as typeof fetch;

    const settled = await runToCompletion((await startLive(64)).id);
    expect(settled.report?.rootCauseMd).toBe("The change returns the naive value.");
    expect(settled.report?.modelId).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(settled.report?.diffText).toContain("pipeline/normalize.py");
    expect(nebius.stats().tfCalls).toBe(1);
  });
});

describe("what a probe job is given", () => {
  it("receives probe.py as an injected file, and no credential and no bucket mount", async () => {
    const nebius = fakeNebius((sha) => (indexOf(sha) >= 20 ? "fail" : "pass"));
    globalThis.fetch = nebius.impl as typeof fetch;
    await runToCompletion((await startLive(64)).id);

    expect(nebius.jobBodies.length).toBeGreaterThan(0);
    for (const raw of nebius.jobBodies) {
      const body = JSON.parse(raw);
      expect(body.spec.volumes).toBeUndefined();
      expect(body.spec.image).toBe("python:3.11");
      expect(body.spec.platform).toBe("cpu-d3");
      expect(body.spec.preset).toBe("2vcpu-8gb");
      expect(body.spec.containerCommand).toBe("python3");
      const [file] = body.spec.injectedFiles;
      expect(file.containerPath).toBe("/opt/faultline/probe.py");
      expect(Buffer.from(file.content, "base64").toString("utf8")).toBe(PROBE_SOURCE);
      // The S3 secret, the service-account key and the TF key never leave the app.
      expect(raw).not.toContain(S3_SECRET);
      expect(raw).not.toContain("PRIVATE KEY");
      expect(raw).not.toContain("tf-test-key");
      const names = body.spec.environmentVariables.map((e: { name: string }) => e.name);
      expect(names).toEqual(expect.arrayContaining(["FAULTLINE_VERDICT_URL", "FAULTLINE_TICK_URL"]));
      for (const name of names) expect(name).not.toMatch(/SECRET|ACCESS_KEY|PRIVATE|TOKENFACTORY/);
    }
  });
});

describe("a hunt with no Nebius configuration", () => {
  it("dispatches nothing and says why, rather than crashing", async () => {
    for (const key of [
      "NEBIUS_SERVICE_ACCOUNT_ID",
      "NEBIUS_AUTH_KEY_ID",
      "NEBIUS_AUTH_PRIVATE_KEY",
      "NEBIUS_PROJECT_ID",
      "NEBIUS_SUBNET_ID",
      "NEBIUS_BUCKET",
      "NEBIUS_S3_ACCESS_KEY_ID",
      "NEBIUS_S3_SECRET_ACCESS_KEY",
    ]) {
      delete process.env[key];
    }
    globalThis.fetch = (async () => {
      throw new Error("no network call may happen without credentials");
    }) as typeof fetch;

    const ctx = storeContext();
    expect(ctx.backend).toBeNull();
    const result = await startHunt(
      ctx,
      newHunt({
        repoUrl: "https://github.com/a/b", testCommand: "pytest", goodRef: "v1", goodSha: shaFor(0),
        badRef: "HEAD", commits: syntheticCommits(8), slots: 2, backend: "none", regions: [],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.error).toContain("Nebius credentials");
    }
  });
});
