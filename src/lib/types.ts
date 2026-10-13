/**
 * Faultline — shared domain contract.
 *
 * Everything in `src/lib` and `src/app/api` speaks these types. They are the reason the
 * pure search logic (planner, verdicts) can be unit-tested with zero infrastructure: no
 * type in this file references Nebius, HTTP, or storage.
 */

/**
 * A probe's answer about one commit.
 *
 * `error` means the probe RAN but the commit could not be tested — it would not check out,
 * install or finish in time. That is `git bisect skip`: it says nothing about the commit, so
 * it never narrows the search and never counts as a contradiction.
 */
export type Verdict = "pass" | "fail" | "error";

/**
 * Job lifecycle states, verbatim from the Nebius Serverless AI enum
 * (`nebius.ai.v1.JobStatus.State`). Kept as a string union rather than a narrowed set so an
 * unrecognised state from the API is a type error at the boundary, not a silent `undefined`.
 */
export type NebiusJobState =
  | "STATE_UNSPECIFIED"
  | "PROVISIONING"
  | "STARTING"
  | "IMAGE_PULLING"
  | "RUNNING"
  | "COMPLETING"
  | "CANCELLING"
  | "CANCELLED"
  | "DELETING"
  | "COMPLETED"
  | "FAILED"
  | "ERROR";

/** States after which the job will never change again. */
export const TERMINAL_JOB_STATES: readonly NebiusJobState[] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "ERROR",
];

export function isTerminal(state: NebiusJobState): boolean {
  return TERMINAL_JOB_STATES.includes(state);
}

/** One commit in the suspect range. Index 0 is the known-good ref; higher is newer. */
export interface Commit {
  sha: string;
  /** Position in the range, oldest = 0. This is what the planner actually searches over. */
  index: number;
  subject: string;
  author: string;
  /** ISO 8601. */
  date: string;
}

/**
 * Why a probe exists. The two endpoint probes test the refs the user GAVE us: a search that
 * assumes its own premises can name an innocent commit with total confidence.
 */
export type ProbeRole = "good" | "bad" | "interior";

/**
 * Where a probe is in its life. `queued` probes wait for a free slot; `dispatching` means a
 * dispatch claim exists but the job ID has not been read back yet.
 */
export type ProbePhase = "queued" | "dispatching" | "running" | "done" | "cancelled";

/** One attempt that produced no verdict — infrastructure, never evidence about the commit. */
export interface InfraFailure {
  attempt: number;
  jobId: string | null;
  region: string | null;
  reason: string;
  at: string;
}

/**
 * One dispatched test of one commit.
 *
 * `jobId` is the real Nebius job ID and is rendered in the UI on purpose: it is the evidence
 * that a probe was a cloud container and not a local shell-out.
 */
export interface Probe {
  commitSha: string;
  commitIndex: number;
  round: number;
  role: ProbeRole;
  /** 1-based. A probe whose job dies without reporting is retried; see MAX_ATTEMPTS. */
  attempt: number;
  /** `r<round>-i<index>-<sha12>-a<attempt>` — names the dispatch claim, the verdict object and the job. */
  key: string;
  phase: ProbePhase;
  region: string | null;
  jobId: string | null;
  jobState: NebiusJobState | null;
  verdict: Verdict | null;
  /** Populated for every verdict: what was installed and how the test exited, or why not. */
  detail: string | null;
  /** The test command's exit code. The Jobs API exposes none, so the probe carries it. */
  exitCode: number | null;
  /** Last lines of the test output, capped by the probe. What a maintainer actually reads. */
  tail: string | null;
  /** The install command the probe actually ran for this commit. */
  installCommand: string | null;
  /** When the job was created. */
  dispatchedAt: string | null;
  /** When the job's workload started — after VM provisioning and the image pull. */
  startedAt: string | null;
  /** When the verdict landed, or the probe was given up on. */
  finishedAt: string | null;
  /** Time spent inside the container (clone + install + test), as the probe measured it. */
  durationMs: number | null;
  /** Job created → job finished, as Nebius reports it: the VM time this probe could bill. */
  vmMs: number | null;
  /** Object Storage key the probe PUTs its verdict to — the only key it can write. */
  verdictKey: string;
  /** Do not dispatch before this time (backoff after a quota rejection). */
  notBefore: string | null;
  infraFailures: InfraFailure[];
  /** First attempt of the current retry budget. Resuming a paused hunt starts a new one. */
  budgetFrom: number;
}

export type HuntStatus =
  | "planning"
  | "running"
  /** A probe failed to report MAX_ATTEMPTS times. Nothing was concluded; resumable. */
  | "paused"
  | "narrating"
  | "done"
  | "inconclusive"
  | "error";

/** The model's single explanation paragraph, plus the provenance that makes it auditable. */
export interface FaultReport {
  culpritSha: string;
  culpritSubject: string;
  culpritAuthor: string;
  culpritDate: string;
  diffText: string;
  /** One paragraph. Null while narration is still running, or when it failed. */
  rootCauseMd: string | null;
  modelId: string;
  /** Where the model ran — a Token Factory request, so the paragraph is traceable. */
  narrationProvider: string | null;
  narrationRequestId: string | null;
  /** Set when narration failed; the culprit is still valid without it. */
  narrationError: string | null;
}

export type InconclusiveReason =
  /** A `pass` above a `fail`: no single first-bad commit explains it. */
  | "contradiction"
  /** The known-good ref fails in its own clean environment. */
  | "good_fails"
  /** The failing ref passes in its own clean environment — the failure is environmental. */
  | "bad_passes"
  /** The known-good ref cannot be built today. */
  | "good_unbuildable"
  /** The failing ref cannot be built in a clean environment. */
  | "bad_unbuildable"
  /** Narrowed to a run of commits, but untestable commits hide which one is first-bad. */
  | "skipped_range";

/** Why a hunt stopped without naming a single commit. Every reason carries its evidence. */
export interface Inconclusive {
  reason: InconclusiveReason;
  headline: string;
  explanation: string;
  /** The specific commit pair that contradicts, when reason is `contradiction`. */
  evidence: { passSha: string; failSha: string } | null;
  /** For `skipped_range`: the culprit is one of these commits, oldest first. */
  range: { fromIndex: number; toIndex: number; shas: string[] } | null;
}

/** A hunt stopped because the infrastructure, not the code, would not answer. */
export interface Pause {
  commitSha: string;
  commitIndex: number;
  round: number;
  attempts: number;
  message: string;
  at: string;
}

export interface Hunt {
  id: string;
  repoUrl: string;
  testCommand: string;
  /**
   * The install command every probe runs before the test, editable at creation and resolved
   * from the repository's own declarations. Empty means "detect per commit".
   */
  installCommand: string;
  goodRef: string;
  /** The known-good ref, resolved. Probed in round 1 at index 0. */
  goodSha: string;
  badRef: string;
  status: HuntStatus;
  /** The suspect range, good ref excluded, resolved once at creation. Never re-fetched. */
  commits: Commit[];
  probes: Probe[];
  round: number;
  /** Bounds of the range still under suspicion: the culprit lies in (lowIndex, highIndex]. */
  lowIndex: number;
  highIndex: number;
  report: FaultReport | null;
  inconclusive: Inconclusive | null;
  pause: Pause | null;
  createdAt: string;
  finishedAt: string | null;
  /**
   * Interior probes per round, before the backend's capacity caps it. Settable so the
   * sequential baseline can be MEASURED rather than derived: a hunt at bandSize 1 is literally
   * `git bisect` on the same infrastructure, same container, same cold starts.
   */
  bandSize: number;
  /** Concurrent probes the backend could hold when this hunt was created. */
  slots: number;
  /** Which backend ran the probes, e.g. `nebius-serverless-jobs`. */
  backend: string;
  /** Regions probes could be dispatched to. */
  regions: string[];
  /** The probe's own deadline, inside the platform's job timeout. */
  probeTimeoutSeconds: number;
  /** sha256 of the probe.py every job of this hunt ran. */
  probeSha256: string;
  /** Where a probe sends its empty "reconcile now" request. Null when there is nowhere. */
  tickUrl: string | null;
  /** Wall-clock from creation to the culprit (or the refusal). Populated at terminal state. */
  wallClockMs: number | null;
  /** List-price cost of the VM time every probe job used. Null until a job reports times. */
  costUsd: number | null;
  /** True for the committed recorded run, which must never be presented as live. */
  recorded: boolean;
  /** Date the recorded run was captured, for the "recorded run, <date>" label. */
  recordedAt: string | null;
}

/** What a probe PUTs to its presigned URL. The verdict contract, frozen. */
export interface ProbeResult {
  schema: "faultline.probe.v2";
  huntId: string;
  probeKey: string;
  commitSha: string;
  verdict: Verdict;
  /** Process exit code of the test command. The Jobs API exposes no exit code, so we carry it. */
  exitCode: number | null;
  durationMs: number;
  installCommand: string | null;
  timings: { cloneMs?: number; installMs?: number; testMs?: number };
  detail: string | null;
  /** Last lines of test output, capped. The evidence a maintainer actually reads. */
  tail: string | null;
}
