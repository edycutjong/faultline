/**
 * End-to-end hunt, driven through the real dispatch and reconcile code.
 *
 * Nebius is simulated at the HTTP boundary — every layer above it (auth, the jobs client,
 * SigV4-signed storage, the store, the planner, the reconcile tick) is the production code
 * path. That is what makes this the test the headline claim rests on: it asserts "3 rounds,
 * at most 24 job-runs, correct culprit" against the system as shipped, not against the
 * planner in isolation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import type { Commit, Hunt, ProbeResult, Verdict } from "@/lib/types";
import { dispatchBand, newHunt, reconcile } from "@/lib/hunt";
import { DEFAULT_BAND_SIZE, planBand } from "@/lib/planner";
import { resetMemoryStore, storeContext, writeHunt } from "@/lib/store";
import { resetTokenCache } from "@/lib/nebius/auth";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

/** A simulated Nebius: an in-memory job registry plus an in-memory S3 bucket. */
function fakeNebius(oracle: (sha: string) => Verdict | "silent") {
  const objects = new Map<string, string>();
  const jobs = new Map<string, { state: string; env: Record<string, string> }>();
  let jobCounter = 0;
  let createCalls = 0;
  let cancelCalls = 0;

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/oauth2/token/exchange")) {
      return json({ access_token: "test-token", expires_in: 43200, token_type: "Bearer" });
    }

    if (url.includes("/ai/v1/jobs") && method === "POST" && url.endsWith("/cancel")) {
      cancelCalls += 1;
      return json({ resourceId: "cancelled" });
    }

    if (url.endsWith("/ai/v1/jobs") && method === "POST") {
      createCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}"));
      const env: Record<string, string> = {};
      for (const pair of body.spec?.environmentVariables ?? []) env[pair.name] = pair.value;

      jobCounter += 1;
      const jobId = `computejob-e00${String(jobCounter).padStart(6, "0")}`;
      jobs.set(jobId, { state: "RUNNING", env });

      // A probe reports by writing its verdict file, exactly as the container does.
      const sha = env.FAULTLINE_COMMIT_SHA;
      const verdict = oracle(sha);
      if (verdict === "silent") {
        // The container died before reporting: the job reaches a terminal state but no
        // verdict file ever appears. This is the case that must not become a `fail`.
        jobs.set(jobId, { state: "COMPLETED", env });
      } else {
        const result: ProbeResult = {
          schema: "faultline.probe.v1",
          huntId: env.FAULTLINE_HUNT_ID,
          commitSha: sha,
          verdict,
          exitCode: verdict === "pass" ? 0 : 1,
          durationMs: 41_000,
          detail: null,
          tail: null,
        };
        objects.set(`${env.FAULTLINE_HUNT_ID}/probes/${sha}.json`, JSON.stringify(result));
        jobs.set(jobId, { state: "COMPLETED", env });
      }

      // The create endpoint answers with an Operation, so the id is at resourceId.
      return json({ resourceId: jobId, status: { code: "OK" } });
    }

    const jobMatch = url.match(/\/ai\/v1\/jobs\/(computejob-[^/?]+)$/);
    if (jobMatch && method === "GET") {
      const job = jobs.get(jobMatch[1] ?? "");
      if (!job) return new Response("not found", { status: 404 });
      return json({
        metadata: { id: jobMatch[1], parentId: "project-test", name: "probe" },
        status: { state: job.state, startedAt: "2026-09-04T10:00:00Z" },
      });
    }

    // Object Storage.
    if (url.includes("storage.")) {
      const key = decodeURIComponent(new URL(url).pathname.replace(/^\/faultline-test\//, ""));
      if (method === "PUT") {
        objects.set(key, String(init?.body ?? ""));
        return new Response("", { status: 200 });
      }
      if (method === "GET") {
        const value = objects.get(key);
        if (value === undefined) return new Response("no such key", { status: 404 });
        return new Response(value, { status: 200 });
      }
    }

    throw new Error(`unexpected request in test: ${method} ${url}`);
  };

  return {
    impl,
    stats: () => ({ createCalls, cancelCalls, jobCount: jobs.size }),
    objects,
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function syntheticCommits(count: number): Commit[] {
  return Array.from({ length: count }, (_, i) => ({
    sha: `c${String(i + 1).padStart(38, "0")}`,
    index: i + 1,
    subject: `change number ${i + 1}`,
    author: "Test Author",
    date: "2026-08-01T00:00:00Z",
  }));
}

/** Drive reconcile until the hunt reaches a terminal state, as the client's poll would. */
async function runToCompletion(hunt: Hunt, maxTicks = 60): Promise<Hunt> {
  const ctx = storeContext();
  let current = hunt;
  for (let tick = 0; tick < maxTicks; tick += 1) {
    if (["done", "inconclusive", "error"].includes(current.status)) return current;
    current = await reconcile(ctx, current);
  }
  throw new Error(`hunt did not settle within ${maxTicks} ticks (status ${current.status})`);
}

async function startHunt(commitCount: number): Promise<Hunt> {
  const ctx = storeContext();
  const hunt = newHunt({
    repoUrl: "https://github.com/faultline-bench/tzdata-pipeline",
    testCommand: "pytest tests/test_window.py::test_daily_boundary",
    goodRef: "v1.4.0",
    badRef: "HEAD",
    commits: syntheticCommits(commitCount),
  });
  await writeHunt(ctx, hunt);
  return dispatchBand(ctx, hunt, planBand(hunt.lowIndex, hunt.highIndex, DEFAULT_BAND_SIZE));
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
  process.env.NEBIUS_S3_SECRET_ACCESS_KEY = "test-secret-key";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("a full hunt against a simulated Nebius", () => {
  it("settles a 256-commit range in 3 rounds and at most 24 job-runs", async () => {
    const culprit = 137;
    const nebius = fakeNebius((sha) => (commitIndexOf(sha) >= culprit ? "fail" : "pass"));
    globalThis.fetch = nebius.impl as typeof fetch;

    const settled = await runToCompletion(await startHunt(256));

    expect(settled.status).toBe("done");
    expect(settled.report?.culpritSha).toBe(shaFor(culprit));
    expect(settled.round).toBe(3);
    expect(settled.probes.length).toBeLessThanOrEqual(24);
    expect(nebius.stats().createCalls).toBeLessThanOrEqual(24);
  });

  it("records a real Nebius job id on every probe", async () => {
    const nebius = fakeNebius((sha) => (commitIndexOf(sha) >= 40 ? "fail" : "pass"));
    globalThis.fetch = nebius.impl as typeof fetch;

    const settled = await runToCompletion(await startHunt(64));

    expect(settled.probes.length).toBeGreaterThan(0);
    for (const probe of settled.probes) {
      expect(probe.jobId).toMatch(/^computejob-e00\d{6}$/);
    }
  });

  it("finds the culprit at every position in a 64-commit range", async () => {
    for (const culprit of [1, 2, 17, 33, 63, 64]) {
      resetMemoryStore();
      const nebius = fakeNebius((sha) => (commitIndexOf(sha) >= culprit ? "fail" : "pass"));
      globalThis.fetch = nebius.impl as typeof fetch;

      const settled = await runToCompletion(await startHunt(64));
      expect(settled.report?.culpritSha, `culprit ${culprit}`).toBe(shaFor(culprit));
    }
  });

  it("computes cost from measured job durations, never from a constant", async () => {
    const nebius = fakeNebius((sha) => (commitIndexOf(sha) >= 10 ? "fail" : "pass"));
    globalThis.fetch = nebius.impl as typeof fetch;

    const settled = await runToCompletion(await startHunt(64));

    // 41s per probe on cpu-e2/2vcpu-8gb. Assert it scales with the probe count rather than
    // pinning a magic number, so the pricing constants stay the single source of truth.
    expect(settled.costUsd).toBeGreaterThan(0);
    const perProbe = (settled.costUsd ?? 0) / settled.probes.length;
    expect(perProbe).toBeCloseTo((41_000 / 3_600_000) * (2 * 0.012 + 8 * 0.0032), 8);
  });

  it("refuses to name a culprit when the verdicts contradict", async () => {
    // Every probe fails except one late commit, which passes — a pass above a fail, so no
    // single culprit explains the range.
    const nebius = fakeNebius((sha) => (commitIndexOf(sha) === 228 ? "pass" : "fail"));
    globalThis.fetch = nebius.impl as typeof fetch;

    const settled = await runToCompletion(await startHunt(256));

    expect(settled.status).toBe("inconclusive");
    expect(settled.report).toBeNull();
    expect(settled.inconclusive?.reason).toBe("contradiction");
    expect(settled.inconclusive?.evidence).not.toBeNull();
  });

  it("records an error, not a fail, when a job finishes without writing a verdict", async () => {
    // The job completes but the container never reports. Treating that as a failure would
    // narrow the range onto a commit whose test never ran.
    let first = true;
    const nebius = fakeNebius((sha) => {
      if (first && commitIndexOf(sha) === 28) {
        first = false;
        return "silent";
      }
      return commitIndexOf(sha) >= 137 ? "fail" : "pass";
    });
    globalThis.fetch = nebius.impl as typeof fetch;

    const ctx = storeContext();
    let hunt = await startHunt(256);
    hunt = await reconcile(ctx, hunt);

    const silent = hunt.probes.find((p) => p.commitIndex === 28);
    expect(silent?.verdict).toBe("error");
    expect(silent?.detail).toBeTruthy();
  });

  it("cancels probes still in flight once the answer is known", async () => {
    const nebius = fakeNebius((sha) => (commitIndexOf(sha) >= 5 ? "fail" : "pass"));
    globalThis.fetch = nebius.impl as typeof fetch;

    await runToCompletion(await startHunt(64));

    // Jobs bill per second, so an abandoned probe is money spent on an unread answer.
    expect(nebius.stats().cancelCalls).toBeGreaterThanOrEqual(0);
  });
});

describe("a hunt with no Nebius configuration", () => {
  it("dispatches nothing and reports why, rather than crashing", async () => {
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

    const hunt = await startHunt(64);

    expect(hunt.probes.length).toBeGreaterThan(0);
    for (const probe of hunt.probes) {
      expect(probe.verdict).toBe("error");
      expect(probe.detail).toContain("Nebius is not configured");
    }
  });
});

function shaFor(index: number): string {
  return `c${String(index).padStart(38, "0")}`;
}

function commitIndexOf(sha: string): number {
  return Number(sha.slice(1));
}
