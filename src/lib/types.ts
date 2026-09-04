/**
 * Faultline — shared domain contract.
 *
 * Everything in `src/lib` and `src/app/api` speaks these types. They are the reason the
 * pure search logic (planner, verdicts) can be unit-tested with zero infrastructure: no
 * type in this file references Nebius, HTTP, or storage.
 */

/** A probe's answer about one commit. `error` means the probe itself broke, not the test. */
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
 * One dispatched test of one commit.
 *
 * `jobId` is the real Nebius job ID and is rendered in the UI on purpose: it is the evidence
 * that a probe was a cloud container and not a local shell-out.
 */
export interface Probe {
  commitSha: string;
  commitIndex: number;
  round: number;
  jobId: string | null;
  jobState: NebiusJobState;
  verdict: Verdict | null;
  /** Populated for `error` verdicts and FAILED/ERROR job states. */
  detail: string | null;
  dispatchedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  /** Object Storage key the probe container wrote its verdict JSON to. */
  verdictKey: string;
}

export type HuntStatus =
  | "planning"
  | "running"
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
  /** One paragraph. Null while the narration job is still running. */
  rootCauseMd: string | null;
  modelId: string;
  narrationJobId: string | null;
  /** Set when narration failed; the culprit is still valid without it. */
  narrationError: string | null;
}

/**
 * Why a hunt stopped without naming a commit. `contradiction` is the honest-refusal case:
 * a `pass` verdict at a higher commit index than a `fail`, which no single culprit explains.
 */
export interface Inconclusive {
  reason: "contradiction" | "all_fail" | "all_pass" | "probe_errors";
  headline: string;
  explanation: string;
  /** The specific commit pair that contradicts, when reason is `contradiction`. */
  evidence: { passSha: string; failSha: string } | null;
}

export interface Hunt {
  id: string;
  repoUrl: string;
  testCommand: string;
  goodRef: string;
  badRef: string;
  status: HuntStatus;
  /** The full suspect range, resolved once at creation. Never re-fetched. */
  commits: Commit[];
  probes: Probe[];
  round: number;
  /** Inclusive index bounds of the range still under suspicion. */
  lowIndex: number;
  highIndex: number;
  report: FaultReport | null;
  inconclusive: Inconclusive | null;
  createdAt: string;
  finishedAt: string | null;
  /** Wall-clock across all rounds. Populated at terminal state. */
  wallClockMs: number | null;
  /** Sum of measured job seconds x preset price. Null until a probe reports duration. */
  costUsd: number | null;
  /** True for the committed recorded run, which must never be presented as live. */
  recorded: boolean;
  /** Date the recorded run was captured, for the "recorded run, <date>" label. */
  recordedAt: string | null;
}

/** What the probe container writes to Object Storage. The verdict contract, frozen. */
export interface ProbeResult {
  schema: "faultline.probe.v1";
  huntId: string;
  commitSha: string;
  verdict: Verdict;
  /** Process exit code of the test command. The Jobs API exposes no exit code, so we carry it. */
  exitCode: number | null;
  durationMs: number;
  detail: string | null;
  /** Last lines of test output, capped. The evidence a maintainer actually reads. */
  tail: string | null;
}
