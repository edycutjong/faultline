/**
 * Smoke: one real probe job per region, dispatched through the production Jobs client.
 *
 * Proves the delivery path the engine is built on, before the engine exists: a stock
 * `python:3.11` image, probe.py arriving as an injected file, no bucket mount and no
 * credential in the job — the verdict comes back only through a presigned PUT URL. Running
 * one job in a second region at the same time answers the open question from 2026-10-13:
 * can a probe outside the bucket's region deliver its verdict? (It needs only HTTPS.)
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, parseExtraRegions, type ProbeRegion } from "@/lib/nebius/config";
import { createJob, getJob } from "@/lib/nebius/jobs";
import { getObjectVersioned, presignPut } from "@/lib/nebius/storage";
import { PROBE_SHA256, PROBE_SOURCE } from "@/lib/probe-source";
import { isTerminal } from "@/lib/types";

const REPO = "https://github.com/pallets/itsdangerous";
const SHA = "672971d66a2ef9f85151e53283113f33d642dabd";

describe("smoke: injected probe on a stock image, verdict via presigned PUT", () => {
  it("delivers a verdict from the home region and from a second region", async () => {
    const result = loadConfig();
    if (!result.configured) throw new Error(`not configured: ${result.missing.join(", ")}`);
    const config = result.config;
    const extra = parseExtraRegions(process.env.SMOKE_EXTRA_REGION);
    const home = process.env.SMOKE_SKIP_HOME === "1" || !config.probeRegions[0] ? [] : [config.probeRegions[0]];
    const targets: Array<{ target: ProbeRegion; test: string; expect: string }> = [
      ...home.map((target) => ({ target, test: "python -m pytest -q", expect: "pass" })),
      // Selects nothing: pytest exits 5, which the probe records as `error` (it tested nothing).
      // The committed evidence predates that rule and shows `fail`.
      ...extra.map((target) => ({ target, test: "python -m pytest -q -k no_such_test_anywhere", expect: "error" })),
    ];
    const run = randomUUID().slice(0, 8);

    const jobs = await Promise.all(
      targets.map(async ({ target, test, expect: expected }) => {
        const probeKey = `smoke-${target.region}`;
        const key = `smoke/${run}/${probeKey}.json`;
        const createdAt = new Date().toISOString();
        const jobId = await createJob(config, {
          name: `faultline-smoke-${run}-${target.region}`,
          image: config.probeImage,
          target,
          containerCommand: "python3",
          args: "-u /opt/faultline/probe.py",
          files: [{ containerPath: "/opt/faultline/probe.py", content: PROBE_SOURCE }],
          env: {
            FAULTLINE_HUNT_ID: `smoke-${run}`,
            FAULTLINE_PROBE_KEY: probeKey,
            FAULTLINE_REPO_URL: REPO,
            FAULTLINE_COMMIT_SHA: SHA,
            FAULTLINE_TEST_COMMAND: test,
            FAULTLINE_INSTALL_COMMAND: "pip install -e . pytest freezegun",
            FAULTLINE_VERDICT_URL: presignPut(config, key, 2 * 3600),
            FAULTLINE_TIMEOUT_SECONDS: "600",
          },
        });
        return { target, key, jobId, createdAt, expected, states: [] as Array<{ at: string; state: string }> };
      }),
    );

    // Poll until every job is terminal (cold start was ~4m17s on 2026-10-13).
    const deadline = Date.now() + 25 * 60 * 1000;
    const finals = new Map<string, Awaited<ReturnType<typeof getJob>>>();
    while (finals.size < jobs.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15_000));
      for (const job of jobs) {
        if (finals.has(job.jobId)) continue;
        const status = await getJob(config, job.jobId);
        const last = job.states.at(-1)?.state;
        if (last !== status.status.state) job.states.push({ at: new Date().toISOString(), state: status.status.state });
        if (isTerminal(status.status.state)) finals.set(job.jobId, status);
      }
    }

    const records = [];
    for (const job of jobs) {
      const final = finals.get(job.jobId);
      const verdict = await getObjectVersioned(config, job.key);
      const doc = verdict ? JSON.parse(verdict.value) : null;
      records.push({
        region: job.target.region,
        jobId: job.jobId,
        createdAt: job.createdAt,
        states: job.states,
        finalState: final?.status.state ?? "TIMEOUT",
        startedAt: final?.status.startedAt ?? null,
        finishedAt: final?.status.finishedAt ?? null,
        stateDetails: final?.status.stateDetails ?? null,
        rawStatusKeys: final ? Object.keys(final.status) : [],
        verdictDelivered: doc !== null,
        verdict: doc ? { ...doc, tail: doc.tail ? `${String(doc.tail).slice(-300)}` : null } : null,
        expected: job.expected,
      });
    }

    writeFileSync(
      path.join(__dirname, "..", "..", "evidence", process.env.SMOKE_EVIDENCE ?? "smoke-jobs.json"),
      `${JSON.stringify({ check: "smoke: injected probe + presigned verdict", ranAt: new Date().toISOString(), probeSha256: PROBE_SHA256, image: config.probeImage, repo: REPO, sha: SHA, records }, null, 2)}\n`,
    );

    for (const record of records) {
      expect(record.verdictDelivered, record.region).toBe(true);
      expect(record.verdict?.verdict, record.region).toBe(record.expected);
    }
  });
});
