/**
 * ProbeBackend on Nebius Serverless AI Jobs.
 *
 * One probe = one terminating job on a stock `python:3.11` image, in whichever configured
 * region has a free slot. probe.py is injected as a file at launch, so no image has to be
 * built or pushed; the job receives a presigned verdict URL and nothing that can write
 * anywhere else.
 */

import type { NebiusConfig } from "@/lib/nebius/config";
import { probeCapacity } from "@/lib/nebius/config";
import { cancelJob, createJob, getJob, getJobByName, NebiusApiError } from "@/lib/nebius/jobs";
import { PROBE_SOURCE } from "@/lib/probe-source";
import { isTerminal } from "@/lib/types";
import type { ProbeBackend, ProbeLaunch, ProbeRunStatus } from "./types";

/** Where the injected probe lands inside the container. */
export const PROBE_PATH = "/opt/faultline/probe.py";

export class JobsBackend implements ProbeBackend {
  readonly id = "nebius-serverless-jobs";
  readonly regions: readonly string[];
  readonly slotsPerRegion: number;

  constructor(
    private readonly config: NebiusConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.regions = config.probeRegions.map((r) => r.region);
    this.slotsPerRegion = config.slotsPerRegion;
  }

  capacity(): number {
    return probeCapacity(this.config);
  }

  private target(region: string) {
    const target = this.config.probeRegions.find((r) => r.region === region);
    if (!target) throw new Error(`region ${region} is not configured for probes`);
    return target;
  }

  async dispatch(launch: ProbeLaunch): Promise<{ runId: string }> {
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

    const runId = await createJob(
      this.config,
      {
        name: launch.name,
        image: this.config.probeImage,
        target: this.target(launch.region),
        containerCommand: "python3",
        args: `-u ${PROBE_PATH}`,
        files: [{ containerPath: PROBE_PATH, content: PROBE_SOURCE }],
        env,
      },
      this.fetchImpl,
    );
    return { runId };
  }

  async status(runId: string): Promise<ProbeRunStatus | null> {
    try {
      const job = await getJob(this.config, runId, this.fetchImpl);
      return {
        state: job.status.state,
        terminal: isTerminal(job.status.state),
        createdAt: job.metadata.createdAt ?? null,
        startedAt: job.status.startedAt ?? null,
        finishedAt: job.status.finishedAt ?? null,
        code: job.status.stateDetails?.code ?? null,
        message: job.status.stateDetails?.message ?? null,
      };
    } catch (error) {
      if (error instanceof NebiusApiError && error.status === 404) return null;
      throw error;
    }
  }

  async find(name: string, region: string): Promise<{ runId: string } | null> {
    const job = await getJobByName(this.config, this.target(region).projectId, name, this.fetchImpl);
    return job ? { runId: job.metadata.id } : null;
  }

  async cancel(runId: string): Promise<void> {
    await cancelJob(this.config, runId, this.fetchImpl);
  }
}
