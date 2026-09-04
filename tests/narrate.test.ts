/**
 * Root-cause narration.
 *
 * The model explains; it never decides. Two things therefore have to hold: the prompt must
 * hand the model the culprit as settled fact so it writes an explanation rather than a second
 * opinion, and the poll must distinguish "still running" from "finished with nothing" — a
 * narration that failed leaves the report's claim intact, so it must not be reported as
 * pending forever.
 *
 * Nebius is faked at the HTTP boundary, as in `tests/hunt.integration.test.ts`, so the jobs
 * client and the SigV4-signed storage read are the production code path.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  NARRATION_MODEL,
  buildPrompt,
  dispatchNarration,
  narrationKey,
  pollNarration,
  type NarrationResult,
} from "@/lib/narrate";
import { loadConfig, type NebiusConfig } from "@/lib/nebius/config";
import { resetTokenCache } from "@/lib/nebius/auth";
import type { Hunt } from "@/lib/types";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function testConfig(): NebiusConfig {
  const result = loadConfig({
    NODE_ENV: "test",
    NEBIUS_SERVICE_ACCOUNT_ID: "serviceaccount-e00test",
    NEBIUS_AUTH_KEY_ID: "publickey-e00test",
    NEBIUS_AUTH_PRIVATE_KEY: privateKey,
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

function hunt(overrides: Partial<Hunt> = {}): Hunt {
  const commits = Array.from({ length: 4 }, (_, i) => ({
    sha: `c${String(i + 1).padStart(39, "0")}`,
    index: i + 1,
    subject: `change ${i + 1}`,
    author: "Dana",
    date: "2026-08-01T00:00:00Z",
  }));

  return {
    id: "hunt-0f3a91c4-1",
    repoUrl: "https://github.com/faultline-bench/tzdata-pipeline",
    testCommand: "pytest tests/test_window.py::test_daily_boundary",
    goodRef: "v1.4.0",
    badRef: "HEAD",
    status: "narrating",
    commits,
    probes: [],
    round: 3,
    lowIndex: 3,
    highIndex: 3,
    report: {
      culpritSha: "c00000000000000000000000000000000000003",
      culpritSubject: "normalise the daily window boundary",
      culpritAuthor: "Dana",
      culpritDate: "2026-08-05T00:00:00Z",
      diffText: "",
      rootCauseMd: null,
      modelId: NARRATION_MODEL,
      narrationJobId: null,
      narrationError: null,
    },
    inconclusive: null,
    createdAt: "2026-09-04T10:00:00Z",
    finishedAt: null,
    wallClockMs: null,
    costUsd: 0.0011,
    recorded: false,
    recordedAt: null,
    ...overrides,
  };
}

const DIFF = "diff --git a/w.py b/w.py\n-  return dt\n+  return dt.replace(tzinfo=None)";
const FAILURE = "E   assert datetime(2026, 8, 5, 0, 0) == datetime(2026, 8, 4, 23, 0)";

describe("buildPrompt", () => {
  it("hands the model every fact the explanation has to be grounded in", () => {
    const prompt = buildPrompt(hunt(), DIFF, FAILURE);

    expect(prompt).toContain("https://github.com/faultline-bench/tzdata-pipeline");
    expect(prompt).toContain("pytest tests/test_window.py::test_daily_boundary");
    expect(prompt).toContain("c00000000000000000000000000000000000003");
    expect(prompt).toContain("normalise the daily window boundary");
    expect(prompt).toContain(DIFF);
    expect(prompt).toContain(FAILURE);
  });

  it("tells the model the culprit is established fact and not to re-litigate it", () => {
    // Load-bearing. The commit was identified by running the test in isolated containers;
    // a model that hedges ("the cause may lie elsewhere") would undercut, on the payoff
    // screen, the one claim in the product that is not generated.
    const prompt = buildPrompt(hunt(), DIFF, FAILURE);

    expect(prompt).toContain("The identification is established fact");
    expect(prompt).toContain("do not question it");
    expect(prompt).toContain("suggest the cause may lie elsewhere");
  });

  it("constrains the answer to a single unadorned paragraph", () => {
    // The UI renders exactly one block. Headings or bullets would be a second generated
    // shape the payoff screen has no place for.
    const prompt = buildPrompt(hunt(), DIFF, FAILURE);

    expect(prompt).toContain("Write ONE paragraph");
    expect(prompt).toContain("at most 120 words");
    expect(prompt).toContain("Do not use headings, bullet points, or a");
  });

  it("says the output was empty rather than leaving the block blank", () => {
    // An empty fenced block reads to the model as "no test ran", which invites invention.
    expect(buildPrompt(hunt(), DIFF, "")).toContain("(no output captured)");
  });

  it("still builds a prompt when there is no report yet", () => {
    // Narration is dispatched off the report, but the prompt must not throw if it is called
    // before one exists — a crash here would take out the whole reconcile tick.
    const prompt = buildPrompt(hunt({ report: null }), DIFF, FAILURE);

    expect(prompt).toContain("Guilty commit: unknown");
    expect(prompt).toContain(DIFF);
  });
});

describe("narrationKey", () => {
  it("namespaces the narration under its hunt, beside that hunt's probe verdicts", () => {
    expect(narrationKey("hunt-0f3a91c4-1")).toBe("hunt-0f3a91c4-1/narration.json");
  });
});

interface JobRequestBody {
  metadata?: { parentId?: string; name?: string };
  spec?: {
    image?: string;
    platform?: string;
    preset?: string;
    disk?: { sizeBytes?: string };
    volumes?: Array<{ containerPath?: string; source?: string }>;
    environmentVariables?: Array<{ name: string; value: string }>;
  };
}

function envOf(body: JobRequestBody): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of body.spec?.environmentVariables ?? []) env[pair.name] = pair.value;
  return env;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

interface FakeNebiusOptions {
  /** Object Storage contents, keyed exactly as the narration container would write them. */
  objects?: Record<string, string>;
  /** Job state returned by GET /ai/v1/jobs/{id}; omit to make that call 404. */
  job?: { state: string; message?: string };
}

function fakeNebius(options: FakeNebiusOptions = {}) {
  const created: JobRequestBody[] = [];

  const impl: typeof fetch = async (input, init) => {
    const url = urlOf(input);
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/oauth2/token/exchange")) {
      return json({ access_token: "test-token", expires_in: 43200, token_type: "Bearer" });
    }

    if (url.endsWith("/ai/v1/jobs") && method === "POST") {
      const body: JobRequestBody = JSON.parse(String(init?.body ?? "{}"));
      created.push(body);
      return json({ resourceId: "computejob-e00042042", status: { code: "OK" } });
    }

    const jobMatch = url.match(/\/ai\/v1\/jobs\/([^/?]+)$/);
    if (jobMatch && method === "GET") {
      if (!options.job) return new Response("gone", { status: 404, statusText: "Not Found" });
      return json({
        metadata: { id: jobMatch[1], parentId: "project-test", name: "narrate" },
        status: {
          state: options.job.state,
          ...(options.job.message ? { stateDetails: { message: options.job.message } } : {}),
        },
      });
    }

    if (url.includes("storage.") && method === "GET") {
      const key = decodeURIComponent(new URL(url).pathname.replace(/^\/faultline-test\//, ""));
      const value = options.objects?.[key];
      if (value === undefined) return new Response("no such key", { status: 404 });
      return new Response(value, { status: 200 });
    }

    throw new Error(`unexpected request in test: ${method} ${url}`);
  };

  return { impl, created };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  resetTokenCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("dispatchNarration", () => {
  it("returns the job id from the operation's resourceId", async () => {
    const nebius = fakeNebius();
    globalThis.fetch = nebius.impl;

    // The create endpoint answers with an Operation; reading metadata.id here would yield
    // undefined and strand the narration.
    expect(await dispatchNarration(testConfig(), hunt(), "explain this")).toBe(
      "computejob-e00042042",
    );
  });

  it("passes the prompt, the hunt and the culprit to the container as environment", async () => {
    const nebius = fakeNebius();
    globalThis.fetch = nebius.impl;

    await dispatchNarration(testConfig(), hunt(), "explain this");

    const env = envOf(nebius.created[0] ?? {});
    expect(env.FAULTLINE_PROMPT).toBe("explain this");
    expect(env.FAULTLINE_HUNT_ID).toBe("hunt-0f3a91c4-1");
    expect(env.FAULTLINE_COMMIT_SHA).toBe("c00000000000000000000000000000000000003");
    expect(env.FAULTLINE_MODEL_ID).toBe(NARRATION_MODEL);
    // The container reports the same way a probe does: by writing into the mounted bucket.
    expect(env.FAULTLINE_OUTPUT_PATH).toBe("/out");
    expect(nebius.created[0]?.spec?.volumes?.[0]?.containerPath).toBe("/out");
  });

  it("requests a GPU preset and a disk large enough for the weights", async () => {
    const nebius = fakeNebius();
    globalThis.fetch = nebius.impl;

    await dispatchNarration(testConfig(), hunt(), "explain this");

    const spec = nebius.created[0]?.spec;
    expect(spec?.platform).toBe("gpu-l40s-a");
    expect(spec?.preset).toBe("1gpu-8vcpu-32gb");
    // The default 64Gi probe disk cannot hold a 14B checkpoint; the job would die pulling it.
    expect(spec?.disk?.sizeBytes).toBe(String(250 * 1024 * 1024 * 1024));
  });

  it("dispatches with an empty commit sha rather than crashing when there is no report", async () => {
    const nebius = fakeNebius();
    globalThis.fetch = nebius.impl;

    await dispatchNarration(testConfig(), hunt({ report: null }), "explain this");

    expect(envOf(nebius.created[0] ?? {}).FAULTLINE_COMMIT_SHA).toBe("");
  });
});

describe("pollNarration", () => {
  const ready: NarrationResult = {
    schema: "faultline.narration.v1",
    huntId: "hunt-0f3a91c4-1",
    commitSha: "c00000000000000000000000000000000000003",
    modelId: NARRATION_MODEL,
    rootCauseMd: "The replace(tzinfo=) call keeps the local offset, so the boundary shifts.",
    promptTokens: 1840,
    completionTokens: 96,
    durationMs: 61_000,
  };

  it("returns the narration once the container has written it to the bucket", async () => {
    const nebius = fakeNebius({
      objects: { "hunt-0f3a91c4-1/narration.json": JSON.stringify(ready) },
      job: { state: "RUNNING" },
    });
    globalThis.fetch = nebius.impl;

    const status = await pollNarration(testConfig(), hunt(), "computejob-e00042042");

    expect(status.state).toBe("ready");
    if (status.state !== "ready") throw new Error("expected a ready narration");
    expect(status.result.rootCauseMd).toBe(ready.rootCauseMd);
    expect(status.result.modelId).toBe(NARRATION_MODEL);
  });

  it("reports pending while the job runs and the object is not there yet", async () => {
    // Absence is the only "not yet" the system has — the Jobs API exposes no output.
    const nebius = fakeNebius({ job: { state: "RUNNING" } });
    globalThis.fetch = nebius.impl;

    expect(await pollNarration(testConfig(), hunt(), "computejob-e00042042")).toEqual({
      state: "pending",
    });
  });

  it("reports failed once the job is terminal with no narration, rather than polling forever", async () => {
    for (const state of ["COMPLETED", "FAILED", "CANCELLED", "ERROR"]) {
      const nebius = fakeNebius({ job: { state } });
      globalThis.fetch = nebius.impl;

      const status = await pollNarration(testConfig(), hunt(), "computejob-e00042042");

      expect(status.state, state).toBe("failed");
      if (status.state !== "failed") throw new Error("expected a failed narration");
      expect(status.reason).toContain(state);
    }
  });

  it("surfaces the job's own explanation when the API gives one", async () => {
    const nebius = fakeNebius({ job: { state: "FAILED", message: "out of GPU quota" } });
    globalThis.fetch = nebius.impl;

    const status = await pollNarration(testConfig(), hunt(), "computejob-e00042042");

    if (status.state !== "failed") throw new Error("expected a failed narration");
    expect(status.reason).toBe("out of GPU quota");
  });

  it("fails with the transport error when the job cannot be polled at all", async () => {
    // The culprit is already established, so a dead narration channel degrades the report's
    // prose; it must never leave the hunt stuck in `narrating`.
    const nebius = fakeNebius({});
    globalThis.fetch = nebius.impl;

    const status = await pollNarration(testConfig(), hunt(), "computejob-e00042042");

    if (status.state !== "failed") throw new Error("expected a failed narration");
    expect(status.reason).toContain("404");
  });

  it("treats an unparseable narration object as not-yet-written", async () => {
    const nebius = fakeNebius({
      objects: { "hunt-0f3a91c4-1/narration.json": "{ truncated" },
      job: { state: "RUNNING" },
    });
    globalThis.fetch = nebius.impl;

    expect(await pollNarration(testConfig(), hunt(), "computejob-e00042042")).toEqual({
      state: "pending",
    });
  });
});
