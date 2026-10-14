/**
 * Smoke: two real probes on Token Factory Sandboxes, dispatched through the production
 * SandboxesBackend — the hero history's known-good commit and its culprit.
 *
 * Proves the second backend's delivery path before a hunt depends on it: the preloaded stock
 * `python:3.11` image, probe.py on stdin, no credential in the sandbox — the verdict comes back
 * only through a presigned PUT URL into the Nebius Object Storage bucket.
 *
 *   npm run test:live -- tests/live/smoke-sandboxes.live.ts
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, loadSandboxesConfig } from "@/lib/nebius/config";
import { getOperation } from "@/lib/nebius/sandboxes";
import { getObjectVersioned, presignPut } from "@/lib/nebius/storage";
import { SANDBOXES_REGION, SandboxesBackend } from "@/lib/backend/sandboxes-backend";
import { PROBE_SHA256 } from "@/lib/probe-source";

const REPO = "https://github.com/edycutjong/faultbench-tzdata-pipeline";
const TEST = "python -m pytest -q tests/test_normalize.py::test_naive_local_midnight_is_interpreted_in_zone";
const INSTALL = "pip install -e .[test]";
const CASES = [
  { label: "good v0.1.0", sha: "0260b672a5da9536b4e661a9ebae19d8fcc6a551", expect: "pass" },
  { label: "culprit", sha: "4e133d6c856c2e756fce5a328896f20fecfc62eb", expect: "fail" },
];

describe("smoke: probe.py on Token Factory Sandboxes, verdict via presigned PUT", () => {
  it("delivers a pass for the good commit and a fail for the culprit", async () => {
    const cloud = loadConfig();
    if (!cloud.configured) throw new Error(`not configured: ${cloud.missing.join(", ")}`);
    const sandboxes = loadSandboxesConfig();
    if (!sandboxes) throw new Error("Sandboxes not configured: TOKENFACTORY_API_KEY + TOKENFACTORY_PROJECT_ID");
    const backend = new SandboxesBackend(sandboxes);
    const run = randomUUID().slice(0, 8);

    const results = await Promise.all(
      CASES.map(async (c, i) => {
        const probeKey = `smoke-sb-${i}`;
        const key = `smoke/${run}/${probeKey}.json`;
        const dispatchedAt = Date.now();
        const { runId } = await backend.dispatch({
          name: `faultline-smoke-${run}-${i}`,
          region: SANDBOXES_REGION,
          huntId: `smoke-${run}`,
          probeKey,
          repoUrl: REPO,
          commitSha: c.sha,
          testCommand: TEST,
          installCommand: INSTALL,
          verdictUrl: presignPut(cloud.config, key, 3600),
          tickUrl: null,
          timeoutSeconds: 600,
        });
        let status = await backend.status(runId);
        while (!status?.terminal && Date.now() - dispatchedAt < 15 * 60_000) {
          await new Promise((r) => setTimeout(r, 2000));
          status = await backend.status(runId);
        }
        const terminalAt = Date.now();
        const op = await getOperation(sandboxes, runId);
        const verdict = await getObjectVersioned(cloud.config, key);
        const parsed = verdict ? (JSON.parse(verdict.value) as Record<string, unknown>) : null;
        return {
          label: c.label,
          commitSha: c.sha,
          expected: c.expect,
          operationId: runId,
          operationStatus: op?.status ?? null,
          operationDurationSeconds: op?.duration ?? null,
          apiReportedCost: op?.metadata?.result?.resources?.cost ?? null,
          dispatchToTerminalMs: terminalAt - dispatchedAt,
          verdict: parsed?.verdict ?? null,
          detail: parsed?.detail ?? null,
          probeDurationMs: parsed?.durationMs ?? null,
          timings: parsed?.timings ?? null,
        };
      }),
    );

    writeFileSync(
      path.join(__dirname, "../../evidence/smoke-sandboxes.json"),
      `${JSON.stringify(
        {
          check: "Two probes via SandboxesBackend (POST /sandboxes/v1/instances, probe.py on stdin, stock python:3.11, disposable) — verdicts read back from the presigned-PUT objects",
          ranAt: new Date().toISOString(),
          image: sandboxes.image,
          probeSha256: PROBE_SHA256,
          repo: REPO,
          testCommand: TEST,
          installCommand: INSTALL,
          results,
        },
        null,
        2,
      )}\n`,
    );

    for (const r of results) expect(r.verdict).toBe(r.expected);
  });
});
