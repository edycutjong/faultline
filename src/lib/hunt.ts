/**
 * The hunt control loop.
 *
 * There is no daemon and no worker. A *tick* reads the hunt, collects whatever verdicts have
 * landed, narrows the range, and dispatches whatever the next step needs. Three things call
 * it: the page polling every two seconds, each probe's empty "reconcile now" request when its
 * verdict is stored, and the uptime sweep. So a hunt advances with nobody watching, and
 * nothing has to stay alive between requests.
 *
 * Ticks race, by design. Two rules make that safe:
 *   1. the hunt record is only replaced with `If-Match: <etag>` — a tick that loses re-reads
 *      and re-applies its (pure) reasoning to the newer record;
 *   2. every side effect is claimed first with `If-None-Match: "*"` — one claim per
 *      (round, commit, attempt) for a dispatch, one per attempt for narration — and the
 *      claim records the outcome, so a tick that loses the record race loses nothing.
 */

import { randomUUID } from "node:crypto";
import type { Commit, FaultReport, Hunt, Inconclusive, Pause, Probe, ProbeResult, ProbeRole } from "@/lib/types";
import type { ProbeBackend } from "@/lib/backend/types";
import {
  DEFAULT_BAND_SIZE,
  effectiveBand,
  expectedRounds,
  firstRoundInterior,
  huntBandSize,
  huntSlots,
  isHemmedBySkips,
  isSettled,
  narrow,
  planBand,
} from "@/lib/planner";
import { classifyInconclusive, skippedRange } from "@/lib/verdicts";
import {
  claimDispatch, claimSlot,
  claimNarration,
  createHunt,
  incrementDailyCount,
  readClaim,
  readHunt,
  readHuntVersioned,
  readNarrationClaim,
  readVerdict,
  recordDispatch,
  recordNarration,
  releaseLiveLock,
  acquireLiveLock,
  replaceHunt,
  verdictUrl,
  type DispatchClaim,
  type SlotOutcome,
  type StoreContext,
} from "@/lib/store";
import { keys } from "@/lib/nebius/storage";
import { NARRATION_MODEL } from "@/lib/nebius/config";
import { billedMs, huntCostUsd } from "@/lib/pricing";
import { buildPrompt, narrate, NARRATION_PROVIDER } from "@/lib/narrate";
import { fetchCommitDiff, parseRepoUrl } from "@/lib/git";
import { PROBE_SHA256 } from "@/lib/probe-source";

/** First attempt plus two retries. A third silent attempt pauses the hunt. */
export const MAX_ATTEMPTS = 3;
/** The probe's own deadline for clone + install + test — far inside the 3600 s job floor. */
export const PROBE_TIMEOUT_SECONDS = 900;
/** VM provisioning + image pull, measured at ~4m20s; the platform itself gives up at 30 min. */
const COLD_START_ALLOWANCE_MS = 25 * 60_000;
const DEADLINE_MARGIN_MS = 5 * 60_000;
/**
 * Throttling — HTTP 429 on job create, or a job ending in QuotaExceeded — is waited out:
 * 30 s, doubling to a 4 min ceiling. The Jobs API documents no rate limit; on 2026-10-13 a
 * round's creates were refused with 429 for ~1.5 min after an 8-job burst, then accepted.
 */
const THROTTLE_BACKOFF_MS = 30_000;
const THROTTLE_BACKOFF_MAX_MS = 4 * 60_000;
/** Consecutive throttled attempts (~25 min of backoff) before the hunt pauses and says so. */
export const MAX_THROTTLED = 8;
/** A probe younger than this has nothing to report; polling its job only spends rate limit. */
const STATUS_POLL_AFTER_MS = 90_000;
/** A claim with no job ID this old means its owner died mid-dispatch. */
const DISPATCH_RECOVERY_MS = 3 * 60_000;
/** A narration claim with no result this old is abandoned; the next attempt may run. */
const NARRATION_STALE_MS = 3 * 60_000;
const NARRATION_ATTEMPTS = 2;
/** A first narration failure faster than this is retried once, inside the same claim. */
const NARRATION_RETRY_IF_UNDER_MS = 20_000;
const NARRATION_RETRY_DELAY_MS = 3_000;
/** A finished probe's job is read this long after its verdict; before that it is still exiting. */
const JOB_EXIT_GRACE_MS = 15_000;
/** Stop waking for a job that never reads as ended; viewers and the sweep still tick. */
const JOB_EXIT_WAIT_MAX_MS = 5 * 60_000;
/** A wake-up already due while its probe is still queued waits at least this long again. */
const REWAKE_MIN_MS = 10_000;
/** The presigned verdict URL outlives every deadline above. */
const VERDICT_URL_TTL_SECONDS = 2 * 60 * 60;

const FINAL = new Set<Hunt["status"]>(["done", "inconclusive", "error"]);

export function isFinal(status: Hunt["status"]): boolean {
  return FINAL.has(status);
}

/** Statuses that hold the backend's capacity — and therefore the live-hunt lock. */
function holdsCapacity(status: Hunt["status"]): boolean {
  return status === "planning" || status === "running";
}

// ---------------------------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------------------------

export interface CreateHuntInput {
  repoUrl: string;
  testCommand: string;
  installCommand?: string;
  goodRef: string;
  goodSha: string;
  badRef: string;
  commits: Commit[];
  /** Interior probes per round before capacity caps it. Omitted means DEFAULT_BAND_SIZE. */
  bandSize?: number;
  /** Concurrent probes the backend can hold. */
  slots: number;
  backend: string;
  regions: string[];
  tickBaseUrl?: string | null;
  now?: Date;
}

export function newHunt(input: CreateHuntInput): Hunt {
  const id = randomUUID();
  const now = input.now ?? new Date();
  const base = input.tickBaseUrl?.replace(/\/+$/, "") ?? null;
  return {
    id,
    repoUrl: input.repoUrl,
    testCommand: input.testCommand,
    installCommand: input.installCommand ?? "",
    goodRef: input.goodRef,
    goodSha: input.goodSha,
    badRef: input.badRef,
    status: "planning",
    commits: input.commits,
    probes: [],
    round: 0,
    lowIndex: 0,
    highIndex: input.commits.length,
    report: null,
    inconclusive: null,
    pause: null,
    createdAt: now.toISOString(),
    finishedAt: null,
    bandSize: input.bandSize ?? DEFAULT_BAND_SIZE,
    slots: Math.max(1, Math.floor(input.slots)),
    backend: input.backend,
    regions: input.regions,
    probeTimeoutSeconds: PROBE_TIMEOUT_SECONDS,
    probeSha256: PROBE_SHA256,
    tickUrl: base ? `${base}/api/hunts/${id}/tick` : null,
    wallClockMs: null,
    costUsd: null,
    recorded: false,
    recordedAt: null,
  };
}

export { expectedRounds, huntBandSize, huntSlots };

/**
 * Names one attempt at one commit in one round — its claim, its verdict object and its job.
 * The commit index makes it unique by construction; the SHA prefix makes it readable.
 */
export function probeKey(round: number, index: number, sha: string, attempt: number): string {
  return `r${round}-i${index}-${sha.slice(0, 12)}-a${attempt}`;
}

function commitAt(hunt: Hunt, index: number): Commit | null {
  return hunt.commits.find((c) => c.index === index) ?? null;
}

function shaAt(hunt: Hunt, index: number): string | null {
  return index === 0 ? hunt.goodSha : (commitAt(hunt, index)?.sha ?? null);
}

function plannedProbe(hunt: Hunt, index: number, role: ProbeRole, round: number): Probe {
  const sha = shaAt(hunt, index) ?? "";
  const key = probeKey(round, index, sha, 1);
  return {
    commitSha: sha,
    commitIndex: index,
    round,
    role,
    attempt: 1,
    key,
    phase: "queued",
    region: null,
    jobId: null,
    jobState: null,
    verdict: null,
    detail: null,
    exitCode: null,
    tail: null,
    installCommand: null,
    dispatchedAt: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    vmMs: null,
    verdictKey: keys.probeVerdict(hunt.id, key),
    notBefore: null,
    infraFailures: [],
    budgetFrom: 1,
  };
}

/**
 * Round 1: the two endpoints — tested in their own clean environments rather than assumed —
 * plus as many interior probes as the backend has room for beside them.
 */
export function planFirstRound(hunt: Hunt): Probe[] {
  const m = hunt.commits.length;
  const interior = firstRoundInterior(huntSlots(hunt), huntBandSize(hunt));
  const band = interior > 0 ? planBand(0, m, interior) : [];
  return [
    plannedProbe(hunt, 0, "good", 1),
    ...band.map((index) => plannedProbe(hunt, index, "interior", 1)),
    plannedProbe(hunt, m, "bad", 1),
  ];
}

export type StartResult =
  | { ok: true; hunt: Hunt }
  | { ok: false; status: number; error: string; holder?: string };

/**
 * Create a live hunt: take the one-live-hunt lock, write the record with round 1 planned,
 * count it against today's budget, and run the first tick, which dispatches round 1.
 */
export async function startHunt(ctx: StoreContext, hunt: Hunt): Promise<StartResult> {
  if (!ctx.backend) {
    return {
      ok: false,
      status: 503,
      error: "Live hunts need Nebius credentials, and none are configured here. The recorded example hunt works without them.",
    };
  }

  const lock = await acquireLiveLock(ctx, hunt.id, async (holder) => {
    const other = await readHunt(ctx, holder);
    return !other || !holdsCapacity(other.status);
  });
  if (!lock.acquired) {
    return {
      ok: false,
      status: 409,
      error:
        "A live hunt is already running, and it is using every probe slot this deployment has. Watch it, or try again when it finishes.",
      holder: lock.holder,
    };
  }

  const planned: Hunt = { ...hunt, status: "running", round: 1, probes: planFirstRound(hunt) };
  if (!(await createHunt(ctx, planned))) {
    await releaseLiveLock(ctx, hunt.id);
    return { ok: false, status: 409, error: "A hunt with that ID already exists." };
  }
  await incrementDailyCount(ctx).catch(() => undefined);

  const ticked = await tick(ctx, hunt.id);
  return { ok: true, hunt: ticked ?? planned };
}

// ---------------------------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------------------------

/**
 * One reconcile. Returns the hunt as it now stands, or null if there is no such hunt.
 *
 * Compare-and-swap loop: read with ETag, reason, write with If-Match. Losing the write means
 * another tick moved the hunt first; the reasoning is re-run against what it wrote. Side
 * effects performed on the way (dispatches, narration) are recorded in their claims, so the
 * re-run adopts them instead of repeating them.
 */
export async function tick(ctx: StoreContext, huntId: string): Promise<Hunt | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const read = await readHuntVersioned(ctx, huntId);
    if (!read) return null;
    const hunt = read.value;
    if (hunt.recorded) return hunt;
    const next = isFinal(hunt.status) ? await settleBill(ctx, hunt) : await advance(ctx, hunt);
    if (JSON.stringify(next) === JSON.stringify(hunt)) return hunt;

    const written = await replaceHunt(ctx, next, read.etag);
    if (written.ok) {
      if (holdsCapacity(hunt.status) && !holdsCapacity(next.status)) {
        await releaseLiveLock(ctx, hunt.id).catch(() => undefined);
      }
      // The tick that names the culprit goes straight on to narration. It is usually the
      // last probe's own tick, and no further tick may ever come to do it otherwise.
      if (next.status === "narrating" && hunt.status !== "narrating") continue;
      return next;
    }
  }
  return readHunt(ctx, huntId);
}

/** The pure-ish heart of a tick: everything a tick decides, given one snapshot. */
async function advance(ctx: StoreContext, hunt: Hunt): Promise<Hunt> {
  if (!ctx.backend) return hunt.status === "narrating" ? advanceNarration(ctx, hunt) : hunt;

  const now = ctx.now();
  let probes = await Promise.all(hunt.probes.map((probe) => refreshProbe(ctx, hunt, probe, now)));
  let next: Hunt = { ...hunt, probes, costUsd: totalCost(probes) };

  // Jobs of the last round are still exiting when the culprit is named; keep reading them
  // through narration so their VM time reaches the cost.
  if (hunt.status === "narrating") return advanceNarration(ctx, next);
  if (hunt.status === "paused") return next;

  // #7: a probe that failed to report on every attempt. Nothing was learned, so nothing is
  // concluded — the hunt stops and says so, and can be resumed.
  const stuck = probes.find(exhausted);
  if (stuck) {
    return { ...next, status: "paused", pause: pauseFor(stuck, now) };
  }

  probes = await dispatchQueued(ctx, next, probes, now);
  next = { ...next, probes };

  const current = probes.filter((p) => p.round === next.round);
  if (current.some((p) => p.phase !== "done")) return next;

  // The round is complete. Refuse before narrowing: a misbehaving endpoint or a
  // contradiction means the verdicts cannot all be explained by one culprit.
  const inconclusive = classifyInconclusive(probes);
  if (inconclusive) return finish(next, "inconclusive", inconclusive, now);

  const decided = probes
    .filter((p) => p.verdict === "pass" || p.verdict === "fail")
    .map((p) => ({ index: p.commitIndex, verdict: p.verdict as "pass" | "fail" }));
  const bounds = narrow(next.lowIndex, next.highIndex, decided);
  next = { ...next, lowIndex: bounds.lowIndex, highIndex: bounds.highIndex };

  if (isSettled(next.lowIndex, next.highIndex)) return settle(next, now);

  // #2: `error` verdicts are skips. Plan around them; if they are all that is left
  // between the bounds, the answer is the range, not a guess inside it.
  const skipped = new Set(probes.filter((p) => p.verdict === "error" && p.role === "interior").map((p) => p.commitIndex));
  const band = planBand(next.lowIndex, next.highIndex, effectiveBand(huntSlots(next), huntBandSize(next)), skipped);
  if (band.length === 0 || isHemmedBySkips(next.lowIndex, next.highIndex, skipped)) {
    return finish(next, "inconclusive", skippedRange(next.commits, next.lowIndex, next.highIndex), now);
  }

  const round = next.round + 1;
  const planned = band.map((index) => plannedProbe(next, index, "interior", round));
  next = { ...next, round, probes: [...probes, ...planned] };
  const dispatched = await dispatchQueued(ctx, next, next.probes, now);
  return { ...next, probes: dispatched };
}

/** Silent attempts in the current retry budget. Throttling is counted separately. */
export function attemptsUsed(probe: Pick<Probe, "infraFailures" | "budgetFrom">): number {
  const from = Number.isInteger(probe.budgetFrom) ? probe.budgetFrom : 1;
  return probe.infraFailures.filter((f) => f.attempt >= from && !f.throttled).length;
}

/** Throttled attempts in a row, most recent first — the backoff exponent. */
export function throttledStreak(probe: Pick<Probe, "infraFailures" | "budgetFrom">): number {
  const from = Number.isInteger(probe.budgetFrom) ? probe.budgetFrom : 1;
  let streak = 0;
  for (let i = probe.infraFailures.length - 1; i >= 0; i -= 1) {
    const failure = probe.infraFailures[i];
    if (!failure || failure.attempt < from || !failure.throttled) break;
    streak += 1;
  }
  return streak;
}

function exhausted(probe: Probe): boolean {
  return (
    probe.phase === "queued" &&
    probe.infraFailures.length > 0 &&
    (attemptsUsed(probe) >= MAX_ATTEMPTS || throttledStreak(probe) >= MAX_THROTTLED)
  );
}

/** Is this failure the platform saying "not now"? */
export function isThrottle(text: string): boolean {
  return /\b429\b|too many requests|quotaexceeded|quota exceeded|resource_exhausted|resourceexhausted/i.test(text);
}

function pauseFor(probe: Probe, now: Date): Pause {
  // unreachable fallback: pauseFor is only called for an exhausted probe, which has at least one infraFailure
  /* v8 ignore next -- @preserve */
  const lastReason = probe.infraFailures.at(-1)?.reason ?? "unknown";
  const throttled = throttledStreak(probe) >= MAX_THROTTLED;
  const attempts = throttled ? throttledStreak(probe) : attemptsUsed(probe);
  return {
    commitSha: probe.commitSha,
    commitIndex: probe.commitIndex,
    round: probe.round,
    attempts,
    message: throttled
      ? `Nebius refused to start the probe for ${probe.commitSha.slice(0, 7)} ${attempts} times in a row ` +
        `(last: ${lastReason}), backing off each time. That is capacity, not the code, so ` +
        `nothing is concluded from it. Resume to try again.`
      : `The probe for ${probe.commitSha.slice(0, 7)} never reported, ${attempts} times running ` +
        `(last: ${lastReason}). That is the infrastructure, not the code, so nothing is ` +
        `concluded from it. Resume to try again.`,
    at: now.toISOString(),
  };
}

function finish(hunt: Hunt, status: "inconclusive", inconclusive: Inconclusive, now: Date): Hunt {
  return {
    ...hunt,
    status,
    inconclusive,
    finishedAt: now.toISOString(),
    wallClockMs: now.getTime() - new Date(hunt.createdAt).getTime(),
  };
}

/** The range is down to one commit. Record the culprit; narration happens next. */
function settle(hunt: Hunt, now: Date): Hunt {
  const culprit = commitAt(hunt, hunt.highIndex);
  if (!culprit) {
    return { ...hunt, status: "error", finishedAt: now.toISOString(), wallClockMs: now.getTime() - new Date(hunt.createdAt).getTime() };
  }
  return {
    ...hunt,
    status: "narrating",
    report: {
      culpritSha: culprit.sha,
      culpritSubject: culprit.subject,
      culpritAuthor: culprit.author,
      culpritDate: culprit.date,
      diffText: "",
      rootCauseMd: null,
      modelId: NARRATION_MODEL,
      narrationProvider: NARRATION_PROVIDER,
      narrationRequestId: null,
      narrationError: null,
    },
    finishedAt: now.toISOString(),
    wallClockMs: now.getTime() - new Date(hunt.createdAt).getTime(),
  };
}

// ---------------------------------------------------------------------------------------------
// Probes: refresh and dispatch
// ---------------------------------------------------------------------------------------------

/**
 * Mark this attempt as having produced no verdict, and queue the next one. Throttling is
 * recognised from the reason itself and waited out with exponential backoff.
 */
function failAttempt(probe: Probe, hunt: Hunt, reason: string, now: Date): Probe {
  const throttled = isThrottle(reason);
  const failure = {
    attempt: probe.attempt,
    jobId: probe.jobId,
    region: probe.region,
    reason,
    at: now.toISOString(),
    ...(throttled ? { throttled: true } : {}),
  };
  const backoffMs = throttled
    ? Math.min(THROTTLE_BACKOFF_MAX_MS, THROTTLE_BACKOFF_MS * 2 ** throttledStreak(probe))
    : 0;
  const attempt = probe.attempt + 1;
  const key = probeKey(probe.round, probe.commitIndex, probe.commitSha, attempt);
  return {
    ...probe,
    attempt,
    key,
    phase: "queued",
    region: null,
    jobId: null,
    jobState: null,
    dispatchedAt: null,
    startedAt: null,
    verdictKey: keys.probeVerdict(hunt.id, key),
    notBefore: backoffMs > 0 ? new Date(now.getTime() + backoffMs).toISOString() : null,
    infraFailures: [...probe.infraFailures, failure],
  };
}

function applyVerdict(probe: Probe, result: ProbeResult, now: Date): Probe {
  return {
    ...probe,
    phase: "done",
    verdict: result.verdict,
    detail: result.detail,
    exitCode: result.exitCode,
    tail: result.tail,
    installCommand: result.installCommand,
    durationMs: result.durationMs,
    finishedAt: now.toISOString(),
  };
}

function probeDeadlineMs(hunt: Hunt): number {
  return COLD_START_ALLOWANCE_MS + hunt.probeTimeoutSeconds * 1000 + DEADLINE_MARGIN_MS;
}

/** Learn what happened to one probe since the last tick. Never throws. */
async function refreshProbe(ctx: StoreContext, hunt: Hunt, probe: Probe, now: Date): Promise<Probe> {
  const backend = ctx.backend;
  /* v8 ignore next -- @preserve */
  if (!backend) return probe; // unreachable: advance() only refreshes probes after checking ctx.backend
  try {
    if (probe.phase === "dispatching") return await adoptClaim(ctx, hunt, probe, now);

    if (probe.phase === "done" && probe.jobId && !(probe.jobState && isJobFinal(probe.jobState))) {
      // The verdict is in; read the job once it has had time to exit, for its billed VM time.
      const since = probe.finishedAt ? now.getTime() - new Date(probe.finishedAt).getTime() : Infinity;
      return since < JOB_EXIT_GRACE_MS ? probe : withRunStatus(probe, await backend.status(probe.jobId));
    }

    if (probe.phase !== "running" || !probe.jobId) return probe;

    const first = await readVerdict(ctx, hunt.id, probe.key, probe.commitSha);
    if (first.kind === "valid") return applyVerdict(probe, first.result, now);

    // Nothing can have happened yet: a cold start alone is minutes. Asking anyway only spends
    // the API's (undocumented) rate limit — which a whole round of ticks can exhaust.
    const age = probe.dispatchedAt ? now.getTime() - new Date(probe.dispatchedAt).getTime() : Infinity;
    if (age < STATUS_POLL_AFTER_MS) return probe;

    const status = await backend.status(probe.jobId);
    if (status === null) return failAttempt(probe, hunt, "the job no longer exists", now);
    const updated = withRunStatus(probe, status);

    if (status.terminal) {
      // The probe stores its verdict before it exits, so after a terminal state the read
      // is authoritative — read once more to close the race with the first read.
      const second = await readVerdict(ctx, hunt.id, probe.key, probe.commitSha);
      if (second.kind === "valid") return applyVerdict(updated, second.result, now);
      const reason =
        second.kind === "invalid"
          ? `the verdict was not a complete document (${second.reason})`
          : `the job ended ${status.state}${status.code ? ` (${status.code})` : ""} without reporting${status.message ? `: ${status.message}` : ""}`;
      return failAttempt(updated, hunt, reason, now);
    }

    if (age > probeDeadlineMs(hunt)) {
      await backend.cancel(probe.jobId).catch(() => undefined);
      return failAttempt(updated, hunt, `no verdict within ${Math.round(probeDeadlineMs(hunt) / 60_000)} minutes`, now);
    }
    return updated;
  } catch {
    // A transient read failure must not decide anything. Try again next tick.
    return probe;
  }
}

function isJobFinal(state: NonNullable<Probe["jobState"]>): boolean {
  return state === "COMPLETED" || state === "FAILED" || state === "CANCELLED" || state === "ERROR";
}

function withRunStatus(probe: Probe, status: Awaited<ReturnType<NonNullable<StoreContext["backend"]>["status"]>> | null): Probe {
  if (!status) return probe;
  const created = status.createdAt ?? probe.dispatchedAt;
  const vmMs = status.finishedAt && created ? Math.max(0, new Date(status.finishedAt).getTime() - new Date(created).getTime()) : probe.vmMs;
  return {
    ...probe,
    jobState: status.state,
    startedAt: status.startedAt ?? probe.startedAt,
    vmMs,
  };
}

/** A `dispatching` probe: its claim exists; find out what the claim's owner did. */
async function adoptClaim(ctx: StoreContext, hunt: Hunt, probe: Probe, now: Date): Promise<Probe> {
  const claim = await readClaim(ctx, hunt.id, probe.key);
  if (!claim) return { ...probe, phase: "queued" };
  if (claim.runId) {
    return { ...probe, phase: "running", region: claim.region, jobId: claim.runId, dispatchedAt: claim.claimedAt };
  }
  if (claim.error) return failAttempt({ ...probe, region: claim.region }, hunt, `dispatch failed: ${claim.error}`, now);

  if (now.getTime() - new Date(claim.claimedAt).getTime() < DISPATCH_RECOVERY_MS) return probe;
  // The owner died between claiming and recording. The job name is deterministic, so the
  // job — if it was ever created — can be found without creating a second one.
  const found = await ctx.backend?.find(jobName(hunt, probe.key), claim.region);
  if (found) {
    await recordDispatch(ctx, hunt.id, { ...claim, runId: found.runId });
    return { ...probe, phase: "running", region: claim.region, jobId: found.runId, dispatchedAt: claim.claimedAt };
  }
  return failAttempt({ ...probe, region: claim.region }, hunt, "dispatch never completed", now);
}

export function jobName(hunt: Pick<Hunt, "id">, key: string): string {
  return `faultline-${hunt.id.slice(0, 8)}-${key}`;
}

/**
 * Put queued probes into free slots. Never more than `slotsPerRegion` live jobs in a region:
 * past the quota a job is rejected, not queued, and a rejected probe is a wasted attempt.
 */
async function dispatchQueued(ctx: StoreContext, hunt: Hunt, probes: Probe[], now: Date): Promise<Probe[]> {
  const backend = ctx.backend;
  /* v8 ignore next -- @preserve */
  if (!backend) return probes; // unreachable: advance() only dispatches after checking ctx.backend

  const busy = new Map<string, number>(backend.regions.map((r) => [r, 0]));
  for (const probe of probes) {
    const holding =
      probe.phase === "dispatching" ||
      probe.phase === "running" ||
      (probe.phase === "done" && probe.jobId !== null && !(probe.jobState && isJobFinal(probe.jobState)));
    if (holding && probe.region) busy.set(probe.region, (busy.get(probe.region) ?? 0) + 1);
  }

  // Launches so far into each region (every attempt, failed or not): the number the next
  // launch claims, so a tick working from a stale record collides instead of over-filling.
  const launches = new Map<string, number>();
  for (const probe of probes) {
    const regions = probe.infraFailures.map((f) => f.region);
    if (probe.phase !== "queued") regions.push(probe.region);
    for (const r of regions) {
      /* v8 ignore next -- @preserve */
      if (r) launches.set(r, (launches.get(r) ?? 0) + 1); // a failure before any region was chosen has none
    }
  }

  // Attempts this record counts as launched. A slot claim naming one of them is a number spent.
  const launched = new Set<string>();
  for (const probe of probes) {
    if (probe.phase !== "queued") launched.add(probe.key);
    for (const f of probe.infraFailures) launched.add(probeKey(probe.round, probe.commitIndex, probe.commitSha, f.attempt));
  }

  const assignments: Array<{ position: number; region: string; launch: number }> = [];
  probes.forEach((probe, position) => {
    if (probe.phase !== "queued") return;
    if (probe.notBefore && new Date(probe.notBefore).getTime() > now.getTime()) return;
    const avoid = new Set(probe.infraFailures.map((f) => f.region).filter((r): r is string => r !== null));
    /* v8 ignore next -- @preserve */
    const free = backend.regions.filter((r) => (busy.get(r) ?? 0) < backend.slotsPerRegion); // unreachable: busy is seeded with every backend region
    const region = free.find((r) => !avoid.has(r)) ?? free[0];
    if (!region) return;
    /* v8 ignore next -- @preserve */
    busy.set(region, (busy.get(region) ?? 0) + 1); // unreachable: region comes from the seeded busy map
    const launch = (launches.get(region) ?? 0) + 1;
    launches.set(region, launch);
    assignments.push({ position, region, launch });
  });

  // Creates go out four at a time: a create takes ~11 s server-side, and a burst of them is
  // what the API throttles. Four keeps a round's dispatch under half a minute.
  const out = [...probes];
  for (let i = 0; i < assignments.length; i += DISPATCH_CONCURRENCY) {
    await Promise.all(
      assignments.slice(i, i + DISPATCH_CONCURRENCY).map(async ({ position, region, launch }) => {
        // unreachable: position always comes from probes.forEach, so the entry exists
        const probe = out[position] as Probe;
        // A probe that already holds its own dispatch claim (a tick that lost the hunt write) is adopted, not re-slotted.
        const held = await readClaim(ctx, hunt.id, probe.key);
        if (held === null) {
          // An orphaned claim leaves this region's numbering one behind its claims: walk past spent numbers.
          let outcome: SlotOutcome = "spent";
          for (let n = launch; outcome === "spent" && n < launch + MAX_SLOT_SKIPS; n += 1) {
            outcome = await claimSlot(ctx, hunt.id, region, n, probe.key, launched, now);
          }
          if (outcome !== "won") return; // a live rival holds this slot (or the skips ran out): stay queued
        }
        out[position] = await dispatchOne(ctx, backend, hunt, probe, region, now);
      }),
    );
  }
  return out;
}

const DISPATCH_CONCURRENCY = 4;
/** Bound on spent slot numbers one dispatch walks past; more than this waits for the next tick. */
const MAX_SLOT_SKIPS = 8;

/**
 * When the hunt next has something to do that no probe will tick it for, or null.
 *
 * Two things wait without a tick of their own: a queued probe's throttle backoff, and — at a
 * round boundary — a queued probe that needs a slot still held by a job whose verdict is in but
 * which is still exiting (`dispatchQueued` counts it as holding its region). That job's probe has
 * already ticked, so nothing would wake the hunt until the next viewer, probe or sweep: wake when
 * `refreshProbe` will next read the job. Pure; `now` is passed in.
 */
export function nextWakeAt(hunt: Hunt, now: Date = new Date()): Date | null {
  if (hunt.status !== "running" || !hunt.probes.some((p) => p.phase === "queued")) return null;
  const t = now.getTime();
  const times: number[] = [];
  for (const probe of hunt.probes) {
    if (probe.phase === "queued" && probe.notBefore) times.push(new Date(probe.notBefore).getTime());
    if (probe.phase === "done" && probe.jobId && probe.finishedAt && !(probe.jobState && isJobFinal(probe.jobState))) {
      const due = new Date(probe.finishedAt).getTime() + JOB_EXIT_GRACE_MS;
      if (t - due < JOB_EXIT_WAIT_MAX_MS) times.push(due);
    }
  }
  if (times.length === 0) return null;
  // A time already passed means the probe is still queued for want of a slot: wait, don't spin.
  return new Date(Math.min(...times.map((at) => (at > t ? at : t + REWAKE_MIN_MS))));
}

async function dispatchOne(
  ctx: StoreContext,
  backend: ProbeBackend,
  hunt: Hunt,
  probe: Probe,
  region: string,
  now: Date,
): Promise<Probe> {
  const claim: DispatchClaim = { probeKey: probe.key, claimedAt: now.toISOString(), region, runId: null, error: null };
  try {
    const { won } = await claimDispatch(ctx, hunt.id, claim);
    if (!won) return await adoptClaim(ctx, hunt, { ...probe, phase: "dispatching", region }, now);
  } catch {
    return probe; // storage hiccup: no job was created; the slot claim names this probe, so it is reused by it or, once settled, skipped
  }

  try {
    const { runId } = await backend.dispatch({
      name: jobName(hunt, probe.key),
      region,
      huntId: hunt.id,
      probeKey: probe.key,
      repoUrl: hunt.repoUrl,
      commitSha: probe.commitSha,
      testCommand: hunt.testCommand,
      installCommand: hunt.installCommand,
      verdictUrl: verdictUrl(ctx, hunt.id, probe.key, VERDICT_URL_TTL_SECONDS),
      tickUrl: hunt.tickUrl,
      timeoutSeconds: hunt.probeTimeoutSeconds,
    });
    await recordDispatch(ctx, hunt.id, { ...claim, runId }).catch(() => undefined);
    return { ...probe, phase: "running", region, jobId: runId, jobState: "PROVISIONING", dispatchedAt: claim.claimedAt, notBefore: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordDispatch(ctx, hunt.id, { ...claim, error: message }).catch(() => undefined);
    return failAttempt({ ...probe, region }, hunt, `dispatch failed: ${message}`, now);
  }
}

export { billedMs };

function totalCost(probes: readonly Probe[]): number | null {
  return huntCostUsd({ probes });
}

/** Probes whose jobs had not ended when the hunt did; their VM time is still provisional. */
function unsettled(hunt: Hunt, now: Date): Probe[] {
  return hunt.probes.filter(
    (p) =>
      p.phase === "done" &&
      p.jobId !== null &&
      !(p.jobState && isJobFinal(p.jobState)) &&
      p.finishedAt !== null &&
      now.getTime() - new Date(p.finishedAt).getTime() < 60 * 60_000,
  );
}

/**
 * After the answer: read the last round's jobs once more so the hunt's cost uses Nebius's own
 * VM times. Touches nothing but job state, VM time and cost.
 */
async function settleBill(ctx: StoreContext, hunt: Hunt): Promise<Hunt> {
  const backend = ctx.backend;
  const now = ctx.now();
  if (!backend || unsettled(hunt, now).length === 0) return hunt;
  const probes = await Promise.all(
    hunt.probes.map(async (p) =>
      unsettled({ ...hunt, probes: [p] }, now).length === 0 || !p.jobId
        ? p
        : withRunStatus(p, await backend.status(p.jobId).catch(() => null)),
    ),
  );
  return { ...hunt, probes, costUsd: totalCost(probes) };
}

// ---------------------------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------------------------

export type ResumeResult = { ok: true; hunt: Hunt } | { ok: false; status: number; error: string; holder?: string };

/** Give a paused hunt a fresh retry budget, if the live-hunt lock is free. */
export async function resumeHunt(ctx: StoreContext, huntId: string): Promise<ResumeResult> {
  const current = await readHuntVersioned(ctx, huntId);
  if (!current) return { ok: false, status: 404, error: "No such hunt." };
  if (current.value.status !== "paused") return { ok: true, hunt: current.value };

  const lock = await acquireLiveLock(ctx, huntId, async (holder) => {
    const other = await readHunt(ctx, holder);
    return !other || !holdsCapacity(other.status);
  });
  if (!lock.acquired) {
    return { ok: false, status: 409, error: "Another live hunt is running. Resume this one when it finishes.", holder: lock.holder };
  }

  const hunt = current.value;
  // Exhausted either way — silent attempts or throttling — or the next tick pauses it again.
  const probes = hunt.probes.map((probe) =>
    exhausted(probe) ? { ...probe, notBefore: null, budgetFrom: probe.attempt } : probe,
  );
  const resumed: Hunt = { ...hunt, status: "running", pause: null, probes };
  const written = await replaceHunt(ctx, resumed, current.etag);
  if (!written.ok) return { ok: false, status: 409, error: "The hunt changed while resuming; try again." };
  return { ok: true, hunt: (await tick(ctx, huntId)) ?? resumed };
}

// ---------------------------------------------------------------------------------------------
// Narration
// ---------------------------------------------------------------------------------------------

/**
 * Drive the narration stage: one Token Factory call, claimed so racing ticks make it once.
 *
 * Narration is strictly a decoration on an answer that already exists, so every failure path
 * here lands on `done` with an explanation of what went wrong — never on `error`. A hunt that
 * found its culprit has succeeded even if the model never speaks.
 */
async function advanceNarration(ctx: StoreContext, hunt: Hunt): Promise<Hunt> {
  const report = hunt.report;
  if (!report) return { ...hunt, status: "error" };
  const now = ctx.now();

  for (let attempt = 1; attempt <= NARRATION_ATTEMPTS; attempt += 1) {
    const existing = await readNarrationClaim(ctx, hunt.id, attempt);
    if (existing?.result) return applyNarration(hunt, existing.result);
    if (existing) {
      const age = now.getTime() - new Date(existing.claimedAt).getTime();
      if (age < NARRATION_STALE_MS) return hunt; // another tick is talking to the model
      continue; // abandoned; the next attempt may run
    }
    if (!(await claimNarration(ctx, hunt.id, attempt, now))) return hunt;

    const result = await runNarration(ctx, hunt, report);
    await recordNarration(ctx, hunt.id, { attempt, claimedAt: now.toISOString(), result }).catch(() => undefined);
    return applyNarration(hunt, result);
  }

  return applyNarration(hunt, {
    rootCauseMd: null,
    error: "The explanation was started but never finished.",
    requestId: null,
    diffText: report.diffText,
  });
}

async function runNarration(
  ctx: StoreContext,
  hunt: Hunt,
  report: FaultReport,
): Promise<{ rootCauseMd: string | null; error: string | null; requestId: string | null; diffText: string }> {
  let diffText = "";
  try {
    diffText = await fetchCommitDiff(parseRepoUrl(hunt.repoUrl), report.culpritSha, 24_000, ctx.fetchImpl);
  } catch (error) {
    return { rootCauseMd: null, error: `Could not fetch the culprit's diff: ${error instanceof Error ? error.message : String(error)}`, requestId: null, diffText };
  }
  if (!ctx.tokenFactory) {
    return { rootCauseMd: null, error: "Token Factory is not configured, so no explanation was generated.", requestId: null, diffText };
  }
  const failing = hunt.probes.find((p) => p.commitSha === report.culpritSha && p.verdict === "fail");
  const prompt = buildPrompt({ ...hunt, report: { ...report, diffText } }, diffText, failing?.tail ?? failing?.detail ?? "");
  let outcome = await narrate(ctx.tokenFactory, prompt, ctx.fetchImpl);
  // One transient failure must not erase the only paragraph the model writes. A fast failure
  // leaves room in the route's 120 s for one more try (the request itself times out at 90 s).
  if (outcome.error && outcome.retryable && outcome.durationMs < NARRATION_RETRY_IF_UNDER_MS) {
    await new Promise((resolve) => setTimeout(resolve, NARRATION_RETRY_DELAY_MS));
    outcome = await narrate(ctx.tokenFactory, prompt, ctx.fetchImpl);
  }
  return { rootCauseMd: outcome.rootCauseMd, error: outcome.error, requestId: outcome.requestId, diffText };
}

function applyNarration(
  hunt: Hunt,
  result: { rootCauseMd: string | null; error: string | null; requestId: string | null; diffText: string },
): Hunt {
  return {
    ...hunt,
    status: "done",
    report: hunt.report
      ? {
          ...hunt.report,
          diffText: result.diffText || hunt.report.diffText,
          rootCauseMd: result.rootCauseMd,
          narrationRequestId: result.requestId,
          narrationError: result.error,
        }
      : /* v8 ignore next -- @preserve */ null, // unreachable: advanceNarration returns early when hunt.report is null
  };
}
