/**
 * The probe backend: where a probe runs, behind four verbs.
 *
 * The hunt engine never names a cloud API. It asks a backend to dispatch a probe, to report
 * on it, to find one by name after its dispatcher died, and to cancel it — and it asks how many
 * probes the backend can hold at once, which is the number the whole search is planned around.
 * Two implementations: Nebius Serverless AI Jobs (`jobs-backend.ts`) and Token Factory Sandboxes
 * (`sandboxes-backend.ts`), chosen per deploy by `FAULTLINE_PROBE_BACKEND` (`selectBackend` in
 * `src/lib/store.ts`).
 */

import type { NebiusJobState } from "@/lib/types";

/** Everything a probe needs, and nothing else — in particular, no credential. */
export interface ProbeLaunch {
  /** Deterministic: the same probe always gets the same name, so a lost dispatch can be found. */
  name: string;
  region: string;
  huntId: string;
  probeKey: string;
  repoUrl: string;
  commitSha: string;
  testCommand: string;
  /** Empty means "detect from the commit's own declarations". */
  installCommand: string;
  /** Presigned PUT for this probe's verdict object — the only write it is granted. */
  verdictUrl: string;
  /** Empty "reconcile now" POST target, or null. */
  tickUrl: string | null;
  /** The probe's own deadline for clone + install + test. */
  timeoutSeconds: number;
}

export interface ProbeRunStatus {
  state: NebiusJobState;
  terminal: boolean;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** The backend's own reason code, e.g. `QuotaExceeded`. */
  code: string | null;
  message: string | null;
}

export interface ProbeBackend {
  /** Stable identifier recorded on every hunt, e.g. `nebius-serverless-jobs`. */
  readonly id: string;
  /** Regions in dispatch-preference order. */
  readonly regions: readonly string[];
  /** Concurrent probes allowed in each region. Enforced by the engine, never exceeded. */
  readonly slotsPerRegion: number;
  /** Total concurrent probes: regions × slots. */
  capacity(): number;
  dispatch(launch: ProbeLaunch): Promise<{ runId: string }>;
  /** Null when the run no longer exists. Throws on a transient error. */
  status(runId: string): Promise<ProbeRunStatus | null>;
  /** Recover a run by its deterministic name after a dispatcher died mid-dispatch. */
  find(name: string, region: string): Promise<{ runId: string } | null>;
  cancel(runId: string): Promise<void>;
}
