/**
 * Shared test fixtures: commits, probes, and a simulated probe backend.
 *
 * The fake backend behaves like Nebius Serverless Jobs where it matters to the engine: a
 * dispatched run goes PROVISIONING → COMPLETED (or ERROR), and a probe that reports does so
 * by PUTting its verdict document to the presigned URL it was given — never by touching any
 * other key. It also enforces the per-region quota the way Nebius does: over the limit, a run
 * is created and immediately ends in ERROR / QuotaExceeded.
 */

import type { Commit, Probe, ProbeResult, Verdict } from "@/lib/types";
import type { ProbeBackend, ProbeLaunch, ProbeRunStatus } from "@/lib/backend/types";
import { MemoryKv, type StoreContext } from "@/lib/store";

/** Narrow away null/undefined in a test, failing loudly instead of with a TypeError later. */
export function must<T>(value: T | null | undefined, what = "value"): T {
  if (value === null || value === undefined) throw new Error(`expected ${what} to be present`);
  return value;
}

export function syntheticCommits(count: number): Commit[] {
  return Array.from({ length: count }, (_, i) => ({
    sha: shaFor(i + 1),
    index: i + 1,
    subject: `change number ${i + 1}`,
    author: "Test Author",
    date: "2026-08-01T00:00:00Z",
  }));
}

/** 40-hex-ish SHA whose numeric suffix is the commit index; index 0 is the good ref. */
export function shaFor(index: number): string {
  return `c${String(index).padStart(39, "0")}`;
}

export function indexOf(sha: string): number {
  return Number(sha.slice(1));
}

export function probe(index: number, verdict: Verdict | null, overrides: Partial<Probe> = {}): Probe {
  const sha = shaFor(index);
  return {
    commitSha: sha,
    commitIndex: index,
    round: 1,
    role: "interior",
    attempt: 1,
    key: `r1-i${index}-${sha.slice(0, 12)}-a1`,
    phase: verdict === null ? "running" : "done",
    region: "eu-west1",
    jobId: `aijob-${index}`,
    jobState: verdict === null ? "RUNNING" : "COMPLETED",
    verdict,
    detail: verdict === "error" ? "dependency install failed (exit 1)" : null,
    exitCode: verdict === "pass" ? 0 : verdict === "fail" ? 1 : null,
    tail: null,
    installCommand: "pip install -e .",
    dispatchedAt: "2026-10-13T10:00:00.000Z",
    startedAt: "2026-10-13T10:04:20.000Z",
    finishedAt: verdict === null ? null : "2026-10-13T10:04:30.000Z",
    durationMs: verdict === null ? null : 4800,
    vmMs: verdict === null ? null : 270_000,
    verdictKey: `hunts/h/verdicts/r1-i${index}-${sha.slice(0, 12)}-a1.json`,
    notBefore: null,
    infraFailures: [],
    budgetFrom: 1,
    ...overrides,
  };
}

/** What a probe does with a launch. `silent` = the job ends without reporting. */
export type Behaviour = Verdict | "silent" | "malformed" | "hang";

interface Run {
  runId: string;
  launch: ProbeLaunch;
  state: ProbeRunStatus["state"];
  code: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export class FakeBackend implements ProbeBackend {
  readonly id = "fake-jobs";
  readonly runs = new Map<string, Run>();
  readonly launches: ProbeLaunch[] = [];
  readonly cancelled: string[] = [];
  /** Highest number of live runs ever seen in one region at once. */
  readonly peakPerRegion = new Map<string, number>();
  dispatchFailures = 0;
  private counter = 0;

  constructor(
    private readonly kv: MemoryKv,
    private readonly behaviour: (sha: string, launch: ProbeLaunch) => Behaviour,
    readonly regions: readonly string[] = ["eu-west1"],
    readonly slotsPerRegion = 2,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  capacity(): number {
    return this.regions.length * this.slotsPerRegion;
  }

  private live(region: string): number {
    let n = 0;
    for (const run of this.runs.values()) {
      if (run.launch.region === region && !["COMPLETED", "FAILED", "CANCELLED", "ERROR"].includes(run.state)) n += 1;
    }
    return n;
  }

  async dispatch(launch: ProbeLaunch): Promise<{ runId: string }> {
    if (this.dispatchFailures > 0) {
      this.dispatchFailures -= 1;
      throw new Error("POST /ai/v1/jobs failed: 503 Service Unavailable");
    }
    this.counter += 1;
    const runId = `aijob-e01${String(this.counter).padStart(6, "0")}`;
    this.launches.push(launch);
    // Nebius: past compute.instance.count the job is created and immediately errors.
    const overQuota = this.live(launch.region) >= this.slotsPerRegion;
    this.runs.set(runId, {
      runId,
      launch,
      state: overQuota ? "ERROR" : "PROVISIONING",
      code: overQuota ? "QuotaExceeded" : null,
      createdAt: this.clock().toISOString(),
      finishedAt: overQuota ? this.clock().toISOString() : null,
    });
    const live = this.live(launch.region);
    this.peakPerRegion.set(launch.region, Math.max(this.peakPerRegion.get(launch.region) ?? 0, live));
    return { runId };
  }

  /** Every live run finishes: its probe reports (or does not) per the behaviour. */
  async completeAll(): Promise<number> {
    let completed = 0;
    for (const run of this.runs.values()) {
      if (run.state !== "PROVISIONING") continue;
      const what = this.behaviour(run.launch.commitSha, run.launch);
      if (what === "hang") continue;
      completed += 1;
      run.finishedAt = this.clock().toISOString();
      if (what === "silent") {
        run.state = "FAILED";
        run.code = "ContainerFailed";
        continue;
      }
      const doc: ProbeResult | Record<string, unknown> =
        what === "malformed"
          ? { schema: "faultline.probe.v2", huntId: run.launch.huntId, verdict: "pass" }
          : {
              schema: "faultline.probe.v2",
              huntId: run.launch.huntId,
              probeKey: run.launch.probeKey,
              commitSha: run.launch.commitSha,
              verdict: what,
              exitCode: what === "pass" ? 0 : what === "fail" ? 1 : null,
              durationMs: 4800,
              installCommand: run.launch.installCommand || "pip install -e . (detected)",
              timings: { cloneMs: 600, installMs: 3200, testMs: 1000 },
              detail: what === "error" ? "dependency install failed (exit 1)" : `test exited ${what === "pass" ? 0 : 1}`,
              tail: what === "fail" ? "E   AssertionError: boundary shifted" : null,
            };
      await this.kv.putPresigned(run.launch.verdictUrl, JSON.stringify(doc));
      run.state = "COMPLETED";
    }
    return completed;
  }

  async status(runId: string): Promise<ProbeRunStatus | null> {
    const run = this.runs.get(runId);
    if (!run) return null;
    const terminal = ["COMPLETED", "FAILED", "CANCELLED", "ERROR"].includes(run.state);
    return {
      state: run.state,
      terminal,
      createdAt: run.createdAt,
      startedAt: terminal ? run.createdAt : null,
      finishedAt: run.finishedAt,
      code: run.code,
      message: run.code === "QuotaExceeded" ? "compute.instance.count limit 2 requested 3" : null,
    };
  }

  async find(name: string): Promise<{ runId: string } | null> {
    for (const run of this.runs.values()) if (run.launch.name === name) return { runId: run.runId };
    return null;
  }

  async cancel(runId: string): Promise<void> {
    this.cancelled.push(runId);
    const run = this.runs.get(runId);
    if (run) run.state = "CANCELLED";
  }
}

/** A context wired to memory and a fake backend, with a controllable clock. */
export function memoryContext(
  behaviour: (sha: string, launch: ProbeLaunch) => Behaviour,
  options: { regions?: string[]; slotsPerRegion?: number; tokenFactory?: StoreContext["tokenFactory"]; fetchImpl?: typeof fetch } = {},
) {
  const kv = new MemoryKv();
  let now = new Date("2026-10-13T10:00:00.000Z");
  const clock = () => now;
  const backend = new FakeBackend(kv, behaviour, options.regions ?? ["eu-west1"], options.slotsPerRegion ?? 2, clock);
  const ctx: StoreContext = {
    kv,
    config: null,
    backend,
    tokenFactory: options.tokenFactory ?? null,
    fetchImpl: options.fetchImpl ?? (async () => new Response("diff --git a/x b/x\n+changed\n", { status: 200 })),
    now: clock,
  };
  return {
    kv,
    backend,
    ctx,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}
