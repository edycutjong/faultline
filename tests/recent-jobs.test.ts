/**
 * The verify view's live job list: newest probe jobs across regions, identifying fields only.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { loadConfig, type NebiusConfig } from "@/lib/nebius/config";
import { resetTokenCache } from "@/lib/nebius/auth";
import { clearRecentJobsCache, recentProbeJobs } from "@/lib/nebius/recent-jobs";

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

const VERDICT_URL = "https://storage.eu-west1.nebius.cloud/b/hunts/h/verdicts/k.json?X-Amz-Signature=secret";

function job(id: string, name: string, createdAt: string, state = "COMPLETED") {
  return {
    metadata: { id, parentId: "p", name, createdAt },
    // What a real list returns besides the fields we keep: the spec, with the verdict URL in it.
    spec: { image: "python:3.11", environmentVariables: [{ name: "FAULTLINE_VERDICT_URL", value: VERDICT_URL }] },
    status: { state, finishedAt: "2026-10-13T16:30:00Z" },
  };
}

function lists(byProject: Record<string, unknown[] | "fail" | "hang">) {
  const calls: string[] = [];
  const impl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/oauth2/token/exchange")) {
      return new Response(JSON.stringify({ access_token: "t", expires_in: 43200, token_type: "Bearer" }));
    }
    calls.push(url);
    const project = new URL(url).searchParams.get("parentId") ?? "";
    const answer = byProject[project];
    if (answer === "hang") return new Promise<Response>(() => {});
    if (answer === "fail" || answer === undefined) return new Response("{}", { status: 503 });
    return new Response(JSON.stringify({ items: answer }));
  };
  return { impl, calls };
}

beforeEach(() => {
  resetTokenCache();
  clearRecentJobsCache();
});

describe("recentProbeJobs", () => {
  it("merges the regions newest first and keeps only probe jobs", async () => {
    const { impl } = lists({
      "project-e01home": [
        job("aijob-e01old", "faultline-aaaa1111-r1-i0-abc-a1", "2026-10-13T12:00:00Z"),
        job("aijob-e01other", "someone-elses-job", "2026-10-13T17:00:00Z"),
      ],
      "project-e03uk": [job("aijob-e03new", "faultline-bbbb2222-r2-i9-def-a1", "2026-10-13T16:00:00Z", "RUNNING")],
    });
    const out = await recentProbeJobs(config(), { fetchImpl: impl });
    expect(out.jobs.map((j) => [j.id, j.region, j.state])).toEqual([
      ["aijob-e03new", "uk-south1", "RUNNING"],
      ["aijob-e01old", "eu-west1", "COMPLETED"],
    ]);
    expect(out.unavailable).toEqual([]);
  });

  it("publishes identifying fields only — never the spec and its presigned verdict URL", async () => {
    const { impl } = lists({ "project-e01home": [job("aijob-e01a", "faultline-x-r1-i0-a-a1", "2026-10-13T12:00:00Z")], "project-e03uk": [] });
    const out = await recentProbeJobs(config(), { fetchImpl: impl });
    expect(Object.keys(out.jobs[0]).sort()).toEqual(["createdAt", "finishedAt", "id", "name", "region", "state"]);
    expect(JSON.stringify(out)).not.toContain("X-Amz-Signature");
  });

  it("names a region it could not read instead of failing the view", async () => {
    const { impl } = lists({ "project-e01home": [job("aijob-e01a", "faultline-x-r1-i0-a-a1", "2026-10-13T12:00:00Z")], "project-e03uk": "fail" });
    const out = await recentProbeJobs(config(), { fetchImpl: impl });
    expect(out.jobs).toHaveLength(1);
    expect(out.unavailable).toEqual(["uk-south1"]);
  });

  it("gives up on a region that does not answer in time", async () => {
    const { impl } = lists({ "project-e01home": [], "project-e03uk": "hang" });
    const out = await recentProbeJobs(config(), { fetchImpl: impl, timeoutMs: 20 });
    expect(out.unavailable).toEqual(["uk-south1"]);
  });

  it("caps the list and reads the API at most once a minute", async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      job(`aijob-e01n${i}`, `faultline-x-r1-i${i}-a-a1`, `2026-10-13T12:${String(i).padStart(2, "0")}:00Z`),
    );
    const { impl, calls } = lists({ "project-e01home": many, "project-e03uk": [] });
    let t = 1_000_000;
    const first = await recentProbeJobs(config(), { fetchImpl: impl, now: () => t });
    expect(first.jobs).toHaveLength(8);
    expect(first.jobs[0].id).toBe("aijob-e01n11");
    t += 30_000;
    await recentProbeJobs(config(), { fetchImpl: impl, now: () => t });
    expect(calls).toHaveLength(2); // one list per region, once
    t += 31_000;
    await recentProbeJobs(config(), { fetchImpl: impl, now: () => t });
    expect(calls).toHaveLength(4);
  });

  it("does not cache a read that reached no region", async () => {
    const { impl, calls } = lists({ "project-e01home": "fail", "project-e03uk": "fail" });
    await recentProbeJobs(config(), { fetchImpl: impl });
    await recentProbeJobs(config(), { fetchImpl: impl });
    expect(calls).toHaveLength(4);
  });
});
