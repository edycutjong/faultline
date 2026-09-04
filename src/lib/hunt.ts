/**
 * The hunt control loop.
 *
 * There is no daemon and no worker. Every `GET /api/hunts/{id}` performs one *reconcile
 * tick*: read the hunt, collect whatever verdicts have landed, narrow the range, and if the
 * round is complete dispatch the next band. The client polling every two seconds is what
 * drives the search forward, which means nothing has to stay alive between requests — the
 * property that lets a hunt survive a 46-day judging window on serverless hosting.
 */

import { randomUUID } from "node:crypto";
import type { Commit, Hunt, Probe, Verdict } from "@/lib/types";
import { isTerminal } from "@/lib/types";
import { DEFAULT_BAND_SIZE, culpritIndex, isSettled, narrow, planBand, estimateRounds } from "@/lib/planner";
import { classifyInconclusive } from "@/lib/verdicts";
import { readProbeResult, writeHunt, type StoreContext } from "@/lib/store";
import { createJob, getJob, cancelJob, NebiusApiError } from "@/lib/nebius/jobs";
import { buildPrompt, dispatchNarration, pollNarration } from "@/lib/narrate";
import { fetchCommitDiff, parseRepoUrl } from "@/lib/git";
import { probeCostUsd, PROBE_MOUNT_PATH } from "@/lib/nebius/config";

export { PROBE_MOUNT_PATH };

export interface CreateHuntInput {
  repoUrl: string;
  testCommand: string;
  goodRef: string;
  badRef: string;
  commits: Commit[];
}

export function newHunt(input: CreateHuntInput): Hunt {
  return {
    id: randomUUID(),
    repoUrl: input.repoUrl,
    testCommand: input.testCommand,
    goodRef: input.goodRef,
    badRef: input.badRef,
    status: "planning",
    commits: input.commits,
    probes: [],
    round: 0,
    lowIndex: 0,
    highIndex: input.commits.length,
    report: null,
    inconclusive: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    wallClockMs: null,
    costUsd: null,
    recorded: false,
    recordedAt: null,
  };
}

/** Total rounds this hunt is expected to need, for the "Round 2 of ~3" status line. */
export function expectedRounds(hunt: Hunt): number {
  return estimateRounds(hunt.commits.length, DEFAULT_BAND_SIZE);
}

function commitAt(hunt: Hunt, index: number): Commit | null {
  return hunt.commits.find((c) => c.index === index) ?? null;
}

/**
 * Dispatch one band as concurrent Serverless Jobs.
 *
 * Dispatch is deliberately all-or-nothing per probe rather than per band: if one job fails
 * to create, the others still run and the failed probe is recorded as an `error`, which the
 * planner ignores for narrowing. A whole band failing to dispatch surfaces as a hunt error.
 */
export async function dispatchBand(
  ctx: StoreContext,
  hunt: Hunt,
  indices: number[],
): Promise<Hunt> {
  const round = hunt.round + 1;
  const dispatchedAt = new Date().toISOString();

  const probes = await Promise.all(
    indices.map(async (index): Promise<Probe> => {
      const commit = commitAt(hunt, index);
      const sha = commit?.sha ?? "";
      const base: Probe = {
        commitSha: sha,
        commitIndex: index,
        round,
        jobId: null,
        jobState: "PROVISIONING",
        verdict: null,
        detail: null,
        dispatchedAt,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        verdictKey: `${hunt.id}/probes/${sha}.json`,
      };

      if (!ctx.config || !commit) {
        return {
          ...base,
          jobState: "FAILED",
          verdict: "error",
          detail: ctx.config
            ? `No commit at index ${index}.`
            : "Nebius is not configured, so no probe job could be dispatched.",
        };
      }

      try {
        const jobId = await createJob(ctx.config, {
          name: `faultline-${hunt.id.slice(0, 8)}-r${round}-${sha.slice(0, 7)}`,
          image: ctx.config.probeImage,
          mountBucketAt: PROBE_MOUNT_PATH,
          env: {
            FAULTLINE_HUNT_ID: hunt.id,
            FAULTLINE_REPO_URL: hunt.repoUrl,
            FAULTLINE_COMMIT_SHA: sha,
            FAULTLINE_TEST_COMMAND: hunt.testCommand,
            FAULTLINE_OUTPUT_PATH: PROBE_MOUNT_PATH,
          },
        });
        return { ...base, jobId };
      } catch (error) {
        return {
          ...base,
          jobState: "FAILED",
          verdict: "error",
          detail: describeError(error),
        };
      }
    }),
  );

  const next: Hunt = {
    ...hunt,
    round,
    status: "running",
    probes: [...hunt.probes, ...probes],
  };
  await writeHunt(ctx, next);
  return next;
}

/**
 * One reconcile tick.
 *
 * Idempotent by construction: it only ever reads verdicts that already exist and advances
 * the round when the current one is complete, so two concurrent polls converge rather than
 * double-dispatching.
 */
export async function reconcile(ctx: StoreContext, hunt: Hunt): Promise<Hunt> {
  if (hunt.status === "done" || hunt.status === "inconclusive" || hunt.status === "error") {
    return hunt;
  }
  if (hunt.recorded) return hunt;
  if (hunt.status === "narrating") return advanceNarration(ctx, hunt);

  const probes = await Promise.all(hunt.probes.map((probe) => refreshProbe(ctx, hunt, probe)));
  let next: Hunt = { ...hunt, probes, costUsd: totalCost(probes) };

  const currentRound = probes.filter((p) => p.round === next.round);
  const pending = currentRound.filter((p) => p.verdict === null);
  if (pending.length > 0) {
    await writeHunt(ctx, next);
    return next;
  }

  // The round is complete. Refuse before narrowing: a contradiction means the verdicts
  // cannot all be explained by one culprit, so narrowing them would blame someone.
  const inconclusive = classifyInconclusive(probes);
  if (inconclusive) {
    next = {
      ...next,
      status: "inconclusive",
      inconclusive,
      finishedAt: new Date().toISOString(),
      wallClockMs: elapsed(next),
    };
    await cancelOutstanding(ctx, next);
    await writeHunt(ctx, next);
    return next;
  }

  const bounds = narrow(
    next.lowIndex,
    next.highIndex,
    currentRound
      .filter((p): p is Probe & { verdict: Verdict } => p.verdict !== null)
      .map((p) => ({ index: p.commitIndex, verdict: p.verdict })),
  );
  next = { ...next, lowIndex: bounds.lowIndex, highIndex: bounds.highIndex };

  if (isSettled(next.lowIndex, next.highIndex)) {
    return settle(ctx, next);
  }

  const band = planBand(next.lowIndex, next.highIndex, DEFAULT_BAND_SIZE);
  if (band.length === 0) {
    // Unreachable while `isSettled` is false, but a stalled planner must not spin forever.
    return settle(ctx, next);
  }
  return dispatchBand(ctx, next, band);
}

/** Pull a probe's verdict file, and its job state for the evidence trail. */
async function refreshProbe(ctx: StoreContext, hunt: Hunt, probe: Probe): Promise<Probe> {
  if (probe.verdict !== null) return probe;

  let updated = probe;

  // The verdict file is the authority. Read it first: a job can report COMPLETED a moment
  // before the object is visible, and a job that is still RUNNING may already have written.
  const result = await readProbeResult(ctx, hunt.id, probe.commitSha).catch(() => null);
  if (result) {
    updated = {
      ...updated,
      verdict: result.verdict,
      detail: result.detail,
      durationMs: result.durationMs,
      finishedAt: new Date().toISOString(),
    };
  }

  if (ctx.config && probe.jobId) {
    try {
      const job = await getJob(ctx.config, probe.jobId);
      updated = {
        ...updated,
        jobState: job.status.state,
        startedAt: job.status.startedAt ?? updated.startedAt,
      };

      // A terminal job with no verdict file wrote nothing — the container died before it
      // could report. That is an `error`, never a `fail`: treating it as a failure would
      // narrow the search onto a commit whose test never ran.
      if (updated.verdict === null && isTerminal(job.status.state)) {
        updated = {
          ...updated,
          verdict: "error",
          detail:
            job.status.stateDetails?.message ??
            `Job finished in state ${job.status.state} without writing a verdict.`,
          finishedAt: job.status.finishedAt ?? new Date().toISOString(),
        };
      }
    } catch (error) {
      // A transient polling failure must not decide a verdict. Leave the probe pending and
      // let the next tick retry.
      if (error instanceof NebiusApiError && error.status === 404) {
        updated = {
          ...updated,
          verdict: "error",
          detail: "The Nebius job for this probe no longer exists.",
        };
      }
    }
  }

  return updated;
}

/** The range is down to one commit. Record the culprit and hand off to narration. */
async function settle(ctx: StoreContext, hunt: Hunt): Promise<Hunt> {
  const index = culpritIndex(hunt.lowIndex, hunt.highIndex);
  const culprit = index === null ? null : commitAt(hunt, index);

  if (!culprit) {
    const next: Hunt = {
      ...hunt,
      status: "error",
      finishedAt: new Date().toISOString(),
      wallClockMs: elapsed(hunt),
    };
    await writeHunt(ctx, next);
    return next;
  }

  const next: Hunt = {
    ...hunt,
    status: "narrating",
    report: {
      culpritSha: culprit.sha,
      culpritSubject: culprit.subject,
      culpritAuthor: culprit.author,
      culpritDate: culprit.date,
      diffText: "",
      rootCauseMd: null,
      modelId: "nvidia/OpenCodeReasoning-Nemotron-14B",
      narrationJobId: null,
      narrationError: null,
    },
    finishedAt: new Date().toISOString(),
    wallClockMs: elapsed(hunt),
  };

  await cancelOutstanding(ctx, next);
  await writeHunt(ctx, next);
  return next;
}

/**
 * Release VMs for probes still in flight once the answer is known.
 *
 * Jobs bill per second, so an abandoned probe is money spent on an answer nobody will read.
 */
async function cancelOutstanding(ctx: StoreContext, hunt: Hunt): Promise<void> {
  if (!ctx.config) return;
  const outstanding = hunt.probes.filter((p) => p.verdict === null && p.jobId);
  await Promise.all(
    outstanding.map(async (probe) => {
      if (!ctx.config || !probe.jobId) return;
      await cancelJob(ctx.config, probe.jobId).catch(() => undefined);
    }),
  );
}

function totalCost(probes: readonly Probe[]): number | null {
  const measured = probes.filter((p) => p.durationMs !== null);
  if (measured.length === 0) return null;
  return measured.reduce((sum, p) => sum + probeCostUsd(p.durationMs ?? 0), 0);
}

function elapsed(hunt: Hunt): number {
  return Date.now() - new Date(hunt.createdAt).getTime();
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Drive the narration stage.
 *
 * Narration is strictly a decoration on an answer that already exists, so every failure path
 * here lands on `done` with an explanation of what went wrong — never on `error`. A hunt that
 * found its culprit has succeeded even if the model never speaks.
 */
async function advanceNarration(ctx: StoreContext, hunt: Hunt): Promise<Hunt> {
  const report = hunt.report;
  if (!ctx.config || !report) {
    return finishNarration(ctx, hunt, {
      narrationError: ctx.config
        ? "No report to narrate."
        : "Nebius is not configured, so the root-cause explanation was not generated.",
    });
  }

  if (!report.narrationJobId) {
    try {
      const ref = parseRepoUrl(hunt.repoUrl);
      const diff = await fetchCommitDiff(ref, report.culpritSha);
      const failureOutput =
        hunt.probes.find((p) => p.commitSha === report.culpritSha && p.verdict === "fail")
          ?.detail ?? "";

      const jobId = await dispatchNarration(
        ctx.config,
        { ...hunt, report: { ...report, diffText: diff } },
        buildPrompt({ ...hunt, report }, diff, failureOutput),
      );

      const next: Hunt = {
        ...hunt,
        report: { ...report, diffText: diff, narrationJobId: jobId },
      };
      await writeHunt(ctx, next);
      return next;
    } catch (error) {
      return finishNarration(ctx, hunt, { narrationError: describeError(error) });
    }
  }

  const status = await pollNarration(ctx.config, hunt, report.narrationJobId);
  if (status.state === "pending") return hunt;
  if (status.state === "failed") {
    return finishNarration(ctx, hunt, { narrationError: status.reason });
  }
  return finishNarration(ctx, hunt, { rootCauseMd: status.result.rootCauseMd });
}

async function finishNarration(
  ctx: StoreContext,
  hunt: Hunt,
  patch: { rootCauseMd?: string; narrationError?: string },
): Promise<Hunt> {
  const next: Hunt = {
    ...hunt,
    status: "done",
    report: hunt.report
      ? {
          ...hunt.report,
          rootCauseMd: patch.rootCauseMd ?? hunt.report.rootCauseMd,
          narrationError: patch.narrationError ?? hunt.report.narrationError,
        }
      : null,
  };
  await writeHunt(ctx, next);
  return next;
}
