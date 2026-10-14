/**
 * ProbeBackend on Token Factory Sandboxes — the second backend, beside Serverless AI Jobs.
 *
 * One probe = one disposable sandbox on the preloaded stock `python:3.11` image, running
 * `python3 -u -` with probe.py on stdin: nothing is built, pushed or uploaded first. It gets
 * the same environment a probe job gets — the presigned verdict URL and nothing that can write
 * anywhere else; the Token Factory key that spawned it never enters it.
 *
 * Sandboxes have no regions and no names. The whole backend is one pseudo-region,
 * `sandboxes`, with a configurable slot count under the beta's 50-operation cap; the probe's
 * deterministic name rides as the sandbox's hostname, which is how `find` recovers a lost
 * dispatch.
 */

import {
  SANDBOXES_MAX_CONCURRENCY,
  SANDBOXES_MAX_TIMEOUT_SECONDS,
  type SandboxesConfig,
} from "@/lib/nebius/config";
import {
  cancelOperation,
  getOperation,
  listOperations,
  spawnInstance,
  type SandboxOperation,
} from "@/lib/nebius/sandboxes";
import { PROBE_SOURCE } from "@/lib/probe-source";
import type { NebiusJobState } from "@/lib/types";
import type { ProbeBackend, ProbeLaunch, ProbeRunStatus } from "./types";

export const SANDBOXES_BACKEND_ID = "nebius-tokenfactory-sandboxes";
export const SANDBOXES_REGION = "sandboxes";
/** Past the probe's own deadline: room to store the verdict and exit, under the API's ceiling. */
const SANDBOX_TIMEOUT_MARGIN_SECONDS = 300;
/** How far back `find` looks; a lost dispatch is recovered within minutes, never hours. */
const FIND_LOOKBACK_MS = 3 * 60 * 60_000;
/** Detail reads `find` may spend; the list itself carries no hostname. */
const FIND_MAX_READS = 60;
const PROBE_STDIN = Buffer.from(PROBE_SOURCE, "utf8").toString("base64");

/** Sandbox operation status → the job-state vocabulary the engine and UI already speak. */
const STATE: Record<string, NebiusJobState> = {
  ASSIGNED: "PROVISIONING",
  PENDING: "PROVISIONING",
  EXECUTING: "RUNNING",
  SUCCESS: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
};

export class SandboxesBackend implements ProbeBackend {
  readonly id = SANDBOXES_BACKEND_ID;
  readonly regions: readonly string[] = [SANDBOXES_REGION];
  readonly slotsPerRegion: number;

  constructor(
    private readonly config: SandboxesConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.slotsPerRegion = Math.max(1, Math.min(SANDBOXES_MAX_CONCURRENCY, Math.floor(config.slots)));
  }

  capacity(): number {
    return this.slotsPerRegion;
  }

  async dispatch(launch: ProbeLaunch): Promise<{ runId: string }> {
    if (launch.region !== SANDBOXES_REGION) throw new Error(`region ${launch.region} is not a Sandboxes region`);
    const env: Record<string, string> = {
      FAULTLINE_HUNT_ID: launch.huntId,
      FAULTLINE_PROBE_KEY: launch.probeKey,
      FAULTLINE_REPO_URL: launch.repoUrl,
      FAULTLINE_COMMIT_SHA: launch.commitSha,
      FAULTLINE_TEST_COMMAND: launch.testCommand,
      FAULTLINE_INSTALL_COMMAND: launch.installCommand,
      FAULTLINE_VERDICT_URL: launch.verdictUrl,
      FAULTLINE_TIMEOUT_SECONDS: String(launch.timeoutSeconds),
    };
    if (launch.tickUrl) env.FAULTLINE_TICK_URL = launch.tickUrl;

    const runId = await spawnInstance(
      this.config,
      {
        command: "python3",
        args: ["-u", "-"],
        image: `tag:${this.config.image}`,
        hostname: launch.name,
        env,
        shell: false,
        cwd: "/",
        disposable: true,
        timeout: Math.min(SANDBOXES_MAX_TIMEOUT_SECONDS, launch.timeoutSeconds + SANDBOX_TIMEOUT_MARGIN_SECONDS),
        stdin: { value: PROBE_STDIN, encoding: "base64" },
        truncate_output_at: 65535,
        files: {},
      },
      this.fetchImpl,
    );
    return { runId };
  }

  async status(runId: string): Promise<ProbeRunStatus | null> {
    const op = await getOperation(this.config, runId, this.fetchImpl);
    return op ? toStatus(op) : null;
  }

  async find(name: string, region: string): Promise<{ runId: string } | null> {
    if (region !== SANDBOXES_REGION) throw new Error(`region ${region} is not a Sandboxes region`);
    const recent = await listOperations(this.config, new Date(this.now() - FIND_LOOKBACK_MS), this.fetchImpl);
    for (const op of recent.slice(0, FIND_MAX_READS)) {
      const detail = await getOperation(this.config, op.uuid, this.fetchImpl);
      if (detail?.metadata?.hostname === name) return { runId: op.uuid };
    }
    return null;
  }

  async cancel(runId: string): Promise<void> {
    await cancelOperation(this.config, runId, this.fetchImpl);
  }
}

export function toStatus(op: SandboxOperation): ProbeRunStatus {
  const state = STATE[op.status] ?? "STATE_UNSPECIFIED";
  const terminal = state === "COMPLETED" || state === "FAILED" || state === "CANCELLED";
  const created = op.created_at ? Date.parse(op.created_at) : NaN;
  const finishedAt =
    terminal && !Number.isNaN(created) && typeof op.duration === "number"
      ? new Date(created + Math.round(op.duration * 1000)).toISOString()
      : null;
  const processState = op.metadata?.result?.state;
  const code = processState?.timed_out
    ? "TimedOut"
    : typeof processState?.exit_code === "number" && processState.exit_code !== 0
      ? `ExitCode${processState.exit_code}`
      : null;
  return {
    state,
    terminal,
    createdAt: op.created_at ?? null,
    startedAt: null,
    finishedAt,
    code,
    message: op.error ?? null,
  };
}
