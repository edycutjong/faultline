/**
 * Root-cause narration by an NVIDIA model.
 *
 * One call per hunt, run as a *terminating* Serverless Job on GPU rather than a Serverless
 * Endpoint. An endpoint in `RUNNING` bills continuously and needs a human to stop and start
 * it across a 46-day judging window; narration is a single latency-insensitive call, so a job
 * that exits is the correct shape.
 *
 * The model explains; it never decides. The guilty commit is produced by test execution, so
 * a bad completion degrades the report's prose without touching the claim it defends.
 */

import type { Hunt } from "@/lib/types";
import { createJob, getJob } from "@/lib/nebius/jobs";
import { getJson } from "@/lib/nebius/storage";
import { isTerminal } from "@/lib/types";
import {
  NARRATION_PLATFORM,
  NARRATION_PRESET,
  PROBE_MOUNT_PATH,
  type NebiusConfig,
} from "@/lib/nebius/config";

export const NARRATION_MODEL = "nvidia/OpenCodeReasoning-Nemotron-14B";

/** What the narration container writes to the bucket. */
export interface NarrationResult {
  schema: "faultline.narration.v1";
  huntId: string;
  commitSha: string;
  modelId: string;
  rootCauseMd: string;
  promptTokens: number | null;
  completionTokens: number | null;
  durationMs: number;
}

export function narrationKey(huntId: string): string {
  return `${huntId}/narration.json`;
}

/**
 * The prompt.
 *
 * Kept here rather than baked into the image so it is reviewable in the repo, and so the
 * single-paragraph constraint is visible next to the UI that renders it. A second generated
 * block would be a second way to be visibly wrong on the payoff screen.
 */
export function buildPrompt(hunt: Hunt, diff: string, failureOutput: string): string {
  const report = hunt.report;
  return [
    "You are explaining a software regression to the maintainer who will fix it.",
    "",
    `Repository: ${hunt.repoUrl}`,
    `Failing test: ${hunt.testCommand}`,
    `Guilty commit: ${report?.culpritSha ?? "unknown"} — ${report?.culpritSubject ?? ""}`,
    "",
    "This commit was identified by running the failing test across the commit range in",
    "isolated containers. The identification is established fact; do not question it or",
    "suggest the cause may lie elsewhere.",
    "",
    "The diff:",
    "```diff",
    diff,
    "```",
    "",
    "The failing test output:",
    "```",
    failureOutput || "(no output captured)",
    "```",
    "",
    "Write ONE paragraph, at most 120 words, in plain English, explaining exactly how this",
    "change causes that test to fail. Name the specific lines responsible. If there is an",
    "obvious fix, state it in the same paragraph. Do not use headings, bullet points, or a",
    "preamble. Begin with the mechanism, not with a restatement of the question.",
  ].join("\n");
}

/**
 * Dispatch the narration job.
 *
 * The image serves the model with vLLM and runs one completion; the prompt is passed as an
 * environment variable and the answer is written to the bucket, mirroring the probe contract
 * so there is exactly one way a result comes back from a job.
 */
export async function dispatchNarration(
  config: NebiusConfig,
  hunt: Hunt,
  prompt: string,
): Promise<string> {
  return createJob(config, {
    name: `faultline-narrate-${hunt.id.slice(0, 8)}`,
    image: config.narrationImage,
    platform: NARRATION_PLATFORM,
    preset: NARRATION_PRESET,
    mountBucketAt: PROBE_MOUNT_PATH,
    // The weights are large; the default 64Gi probe disk is not enough.
    diskSizeBytes: 250 * 1024 * 1024 * 1024,
    env: {
      FAULTLINE_HUNT_ID: hunt.id,
      FAULTLINE_COMMIT_SHA: hunt.report?.culpritSha ?? "",
      FAULTLINE_MODEL_ID: NARRATION_MODEL,
      FAULTLINE_PROMPT: prompt,
      FAULTLINE_OUTPUT_PATH: PROBE_MOUNT_PATH,
    },
  });
}

export type NarrationStatus =
  | { state: "pending" }
  | { state: "ready"; result: NarrationResult }
  | { state: "failed"; reason: string };

/** Poll for the narration result, exactly as a probe verdict is polled. */
export async function pollNarration(
  config: NebiusConfig,
  hunt: Hunt,
  jobId: string,
): Promise<NarrationStatus> {
  const result = await getJson<NarrationResult>(config, narrationKey(hunt.id)).catch(() => null);
  if (result?.rootCauseMd) return { state: "ready", result };

  try {
    const job = await getJob(config, jobId);
    if (isTerminal(job.status.state)) {
      return {
        state: "failed",
        reason:
          job.status.stateDetails?.message ??
          `The narration job finished in state ${job.status.state} without producing an explanation.`,
      };
    }
  } catch (error) {
    return {
      state: "failed",
      reason: error instanceof Error ? error.message : "Could not poll the narration job.",
    };
  }

  return { state: "pending" };
}
