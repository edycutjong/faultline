/**
 * Coverage for the corners of the hunt state machine the behavioural suites do not reach:
 * storage hiccups, abandoned claims, throttled/stale probes, resume edge cases and every
 * narration failure path. Store, git and narrate are wrapped as pass-through spies so a case
 * can make exactly one collaborator misbehave while everything else stays real.
 */

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  const wrap = <K extends keyof typeof actual>(name: K) => vi.fn(actual[name] as never) as never;
  return {
    ...actual,
    claimDispatch: wrap("claimDispatch"),
    claimNarration: wrap("claimNarration"),
    createHunt: wrap("createHunt"),
    incrementDailyCount: wrap("incrementDailyCount"),
    readClaim: wrap("readClaim"),
    readHuntVersioned: wrap("readHuntVersioned"),
    readNarrationClaim: wrap("readNarrationClaim"),
    readVerdict: wrap("readVerdict"),
    recordDispatch: wrap("recordDispatch"),
    recordNarration: wrap("recordNarration"),
    releaseLiveLock: wrap("releaseLiveLock"),
    replaceHunt: wrap("replaceHunt"),
  };
});
vi.mock("@/lib/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/git")>();
  return { ...actual, fetchCommitDiff: vi.fn(actual.fetchCommitDiff) };
});
vi.mock("@/lib/narrate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/narrate")>();
  return { ...actual, buildPrompt: vi.fn(actual.buildPrompt), narrate: vi.fn(actual.narrate) };
});

import * as store from "@/lib/store";
import * as git from "@/lib/git";
import * as narration from "@/lib/narrate";
import {
  attemptsUsed,
  newHunt,
  planFirstRound,
  resumeHunt,
  startHunt,
  throttledStreak,
  tick,
} from "@/lib/hunt";
import type { ProbeBackend, ProbeRunStatus } from "@/lib/backend/types";
import type { Hunt, Probe } from "@/lib/types";
import { memoryContext, must, probe, shaFor, syntheticCommits } from "./helpers";

const actualStore = await vi.importActual<typeof import("@/lib/store")>("@/lib/store");
const actualGit = await vi.importActual<typeof import("@/lib/git")>("@/lib/git");
const actualNarrate = await vi.importActual<typeof import("@/lib/narrate")>("@/lib/narrate");

const NOW = "2026-10-13T10:00:00.000Z";
const mocked = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  for (const name of [
    "claimDispatch",
    "claimNarration",
    "createHunt",
    "incrementDailyCount",
    "readClaim",
    "readHuntVersioned",
    "readNarrationClaim",
    "readVerdict",
    "recordDispatch",
    "recordNarration",
    "releaseLiveLock",
    "replaceHunt",
  ] as const) {
    mocked(store[name]).mockReset().mockImplementation(actualStore[name] as never);
  }
  mocked(git.fetchCommitDiff).mockReset().mockImplementation(actualGit.fetchCommitDiff as never);
  mocked(narration.buildPrompt).mockReset().mockImplementation(actualNarrate.buildPrompt as never);
  mocked(narration.narrate).mockReset().mockImplementation(actualNarrate.narrate as never);
});

type Env = ReturnType<typeof memoryContext>;
const fresh = (): Env => memoryContext(() => "pass");

function stubBackend(over: Partial<ProbeBackend> = {}): ProbeBackend {
  return {
    id: "stub",
    regions: ["r1"],
    slotsPerRegion: 2,
    capacity: () => 2,
    dispatch: vi.fn(async () => ({ runId: "job-new" })),
    status: vi.fn(async () => null),
    find: vi.fn(async () => null),
    cancel: vi.fn(async () => undefined),
    ...over,
  };
}

function runStatus(over: Partial<ProbeRunStatus> = {}): ProbeRunStatus {
  return { state: "RUNNING", terminal: false, createdAt: NOW, startedAt: null, finishedAt: null, code: null, message: null, ...over };
}

async function seed(env: Env, over: Partial<Hunt> = {}): Promise<Hunt> {
  const base = newHunt({
    repoUrl: "https://github.com/faultline-bench/tzdata-pipeline",
    testCommand: "pytest",
    goodRef: "v1",
    goodSha: shaFor(0),
    badRef: "HEAD",
    commits: syntheticCommits(8),
    slots: 2,
    backend: "stub",
    regions: ["r1"],
    now: env.ctx.now(),
  });
  const h: Hunt = { ...base, status: "running", round: 1, ...over };
  expect(await actualStore.createHunt(env.ctx, h)).toBe(true);
  return h;
}

/** A probe that keeps the round open, so a case can look at the probe under test alone. */
const filler = (): Probe => probe(7, null);

const valid = (verdict: "pass" | "fail" | "error" = "pass") => ({
  kind: "valid" as const,
  result: {
    schema: "faultline.probe.v2",
    huntId: "h",
    probeKey: "k",
    commitSha: "s",
    verdict,
    exitCode: 0,
    durationMs: 5,
    installCommand: "pip install .",
    timings: { cloneMs: 1, installMs: 1, testMs: 1 },
    detail: "d",
    tail: null,
  },
});

/** Answer successive verdict reads for one probe (by key); every other probe reads as absent. */
function verdictsFor(p: Probe, reads: unknown[]): void {
  let n = 0;
  mocked(store.readVerdict).mockImplementation(async (_ctx: unknown, _hunt: unknown, key: string) =>
    key === p.key ? (reads[Math.min(n++, reads.length - 1)] as never) : { kind: "absent" },
  );
}

async function tickProbe(env: Env, p: Probe, backend: ProbeBackend, extra: Partial<Hunt> = {}) {
  const h = await seed(env, { probes: [p, filler()], ...extra });
  const ctx = { ...env.ctx, backend };
  const after = must(await tick(ctx, h.id));
  return { hunt: after, probe: must(after.probes.find((x) => x.commitIndex === p.commitIndex)) };
}

const claimOf = (p: Probe, over: Partial<store.DispatchClaim> = {}): store.DispatchClaim => ({
  probeKey: p.key,
  claimedAt: NOW,
  region: "r1",
  runId: null,
  error: null,
  ...over,
});

describe("planning", () => {
  it("falls back to an empty SHA when a commit index is not in the list", () => {
    const h = newHunt({
      repoUrl: "https://github.com/a/b",
      testCommand: "t",
      goodRef: "g",
      goodSha: shaFor(0),
      badRef: "b",
      commits: [{ sha: shaFor(7), index: 7, subject: "s", author: "a", date: "d" }],
      slots: 2,
      backend: "x",
      regions: ["r1"],
    });
    const round = planFirstRound(h);
    expect(round.find((p) => p.role === "good")?.commitSha).toBe(shaFor(0));
    expect(round.find((p) => p.role === "bad")?.commitSha).toBe("");
  });

  it("treats a non-integer budgetFrom as 1 when counting attempts and throttles", () => {
    const failures = [
      { attempt: 1, jobId: null, region: null, reason: "x", at: NOW },
      { attempt: 2, jobId: null, region: null, reason: "429", at: NOW, throttled: true },
      { attempt: 3, jobId: null, region: null, reason: "429", at: NOW, throttled: true },
    ];
    const bad = undefined as unknown as number;
    expect(attemptsUsed({ infraFailures: failures, budgetFrom: bad })).toBe(1);
    expect(throttledStreak({ infraFailures: failures, budgetFrom: bad })).toBe(2);
  });
});

describe("startHunt", () => {
  it("releases the lock and refuses when the hunt ID already exists", async () => {
    const env = fresh();
    mocked(store.createHunt).mockResolvedValue(false);
    const h = newHunt({
      repoUrl: "https://github.com/a/b", testCommand: "t", goodRef: "g", goodSha: shaFor(0), badRef: "b",
      commits: syntheticCommits(8), slots: 2, backend: "stub", regions: ["r1"], now: env.ctx.now(),
    });
    const result = await startHunt(env.ctx, h);
    expect(result).toMatchObject({ ok: false, status: 409, error: "A hunt with that ID already exists." });
    expect(store.releaseLiveLock).toHaveBeenCalledWith(env.ctx, h.id);
  });

  it("still starts when the daily counter fails, and returns the planned hunt if the first tick finds nothing", async () => {
    const env = fresh();
    mocked(store.incrementDailyCount).mockRejectedValue(new Error("kv down"));
    mocked(store.readHuntVersioned).mockResolvedValue(null);
    const h = newHunt({
      repoUrl: "https://github.com/a/b", testCommand: "t", goodRef: "g", goodSha: shaFor(0), badRef: "b",
      commits: syntheticCommits(8), slots: 2, backend: "stub", regions: ["r1"], now: env.ctx.now(),
    });
    const result = await startHunt(env.ctx, h);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hunt.status).toBe("running");
      expect(result.hunt.round).toBe(1);
      expect(result.hunt.probes.length).toBeGreaterThan(0);
    }
  });
});

describe("tick envelope", () => {
  it("returns null for an unknown hunt and the record untouched once recorded", async () => {
    const env = fresh();
    expect(await tick(env.ctx, randomUUID())).toBeNull();
    const h = await seed(env, { status: "done", recorded: true });
    expect(await tick(env.ctx, h.id)).toMatchObject({ id: h.id, recorded: true, status: "done" });
    expect(store.replaceHunt).not.toHaveBeenCalled();
  });

  it("does nothing without a backend, but still narrates a named culprit", async () => {
    const env = fresh();
    const ctx = { ...env.ctx, backend: null };
    const running = await seed(env, { probes: [filler()] });
    expect((await tick(ctx, running.id))?.status).toBe("running");

    const report = {
      culpritSha: shaFor(3), culpritSubject: "s", culpritAuthor: "a", culpritDate: "d",
      diffText: "", rootCauseMd: null, modelId: "m", narrationProvider: "p", narrationRequestId: null, narrationError: null,
    };
    const narrating = await seed(env, { status: "narrating", report });
    const done = must(await tick(ctx, narrating.id));
    expect(done.status).toBe("done");
    expect(done.report?.narrationError).toMatch(/Token Factory is not configured/);
  });

  it("keeps a paused hunt paused while still reading its probes", async () => {
    const env = fresh();
    const h = await seed(env, {
      status: "paused",
      pause: { commitSha: "s", commitIndex: 3, round: 1, attempts: 3, message: "m", at: NOW },
      probes: [filler()],
    });
    const after = must(await tick(env.ctx, h.id));
    expect(after.status).toBe("paused");
    expect(after.pause?.attempts).toBe(3);
  });

  it("survives a failing lock release when the hunt stops holding capacity", async () => {
    const env = fresh();
    mocked(store.releaseLiveLock).mockRejectedValue(new Error("kv down"));
    const h = await seed(env, {
      commits: syntheticCommits(1),
      highIndex: 1,
      probes: [probe(0, "pass", { role: "good" }), probe(1, "fail", { role: "bad" })],
    });
    const after = must(await tick(env.ctx, h.id));
    expect(store.releaseLiveLock).toHaveBeenCalled();
    expect(after.status).toBe("done");
    expect(after.report?.culpritSha).toBe(shaFor(1));
  });

  it("ends in error when the settled culprit is not in the commit list", async () => {
    const env = fresh();
    const h = await seed(env, {
      commits: [{ sha: shaFor(5), index: 5, subject: "s", author: "a", date: "d" }],
      highIndex: 1,
      probes: [probe(0, "pass", { role: "good" }), probe(1, "fail", { role: "bad" })],
    });
    const after = must(await tick(env.ctx, h.id));
    expect(after.status).toBe("error");
    expect(after.finishedAt).not.toBeNull();
    expect(after.wallClockMs).not.toBeNull();
  });

  it("falls back to a plain read after five lost compare-and-swap races", async () => {
    const env = fresh();
    const h = await seed(env, { probes: [probe(2, "pass"), filler()] }); // costUsd changes, so a write is attempted
    mocked(store.replaceHunt).mockResolvedValue({ ok: false } as never);
    const after = must(await tick(env.ctx, h.id));
    expect(store.replaceHunt).toHaveBeenCalledTimes(5);
    expect(after.id).toBe(h.id);
  });
});

describe("refreshing probes", () => {
  it("re-reads the job of a finished probe that has no finishedAt, and tolerates a status without createdAt", async () => {
    const env = fresh();
    const p = probe(3, "pass", { jobState: "PROVISIONING", finishedAt: null, dispatchedAt: null, vmMs: 7 });
    const backend = stubBackend({
      status: vi.fn(async () => runStatus({ state: "COMPLETED", terminal: true, createdAt: null, finishedAt: NOW })),
    });
    const { probe: after } = await tickProbe(env, p, backend);
    expect(backend.status).toHaveBeenCalledWith(p.jobId);
    expect(after.jobState).toBe("COMPLETED");
    expect(after.vmMs).toBe(7); // no creation time to measure from: the old figure stands
  });

  it("measures VM time from the dispatch time when the job reports no createdAt", async () => {
    const env = fresh();
    const p = probe(3, "pass", {
      jobState: "PROVISIONING",
      finishedAt: "2026-10-13T09:50:00.000Z",
      dispatchedAt: "2026-10-13T09:50:00.000Z",
    });
    const backend = stubBackend({
      status: vi.fn(async () => runStatus({ state: "COMPLETED", terminal: true, createdAt: null, finishedAt: "2026-10-13T09:55:00.000Z" })),
    });
    const { probe: after } = await tickProbe(env, p, backend);
    expect(after.vmMs).toBe(300_000);
  });

  it("leaves a finished probe alone when its job has vanished", async () => {
    const env = fresh();
    const p = probe(3, "pass", { jobState: "PROVISIONING", finishedAt: "2026-10-13T09:50:00.000Z" });
    const backend = stubBackend({ status: vi.fn(async () => null) });
    const { probe: after } = await tickProbe(env, p, backend);
    expect(after.jobState).toBe("PROVISIONING");
  });

  it("queries a running probe with no dispatch time, and re-queues it when the job no longer exists", async () => {
    const env = fresh();
    const p = probe(3, null, { dispatchedAt: null });
    const backend = stubBackend({ status: vi.fn(async () => null) });
    const { probe: after } = await tickProbe(env, p, backend);
    expect(after.attempt).toBe(2);
    expect(after.infraFailures.at(-1)?.reason).toBe("the job no longer exists");
  });

  it("keeps a still-running, not-yet-overdue probe running with its fresh job state", async () => {
    const env = fresh();
    const p = probe(3, null, { dispatchedAt: "2026-10-13T09:50:00.000Z", jobState: "PROVISIONING" });
    const backend = stubBackend({ status: vi.fn(async () => runStatus({ state: "RUNNING" })) });
    const { probe: after } = await tickProbe(env, p, backend);
    expect(after.phase).toBe("running");
    expect(after.jobState).toBe("RUNNING");
    expect(backend.cancel).not.toHaveBeenCalled();
  });

  it("adopts a verdict that lands between the first read and the terminal status", async () => {
    const env = fresh();
    const p = probe(3, null, { dispatchedAt: "2026-10-13T09:50:00.000Z" });
    verdictsFor(p, [{ kind: "absent" }, valid("fail")]);
    const backend = stubBackend({ status: vi.fn(async () => runStatus({ state: "COMPLETED", terminal: true })) });
    const { probe: after } = await tickProbe(env, p, backend);
    expect(after.phase).toBe("done");
    expect(after.verdict).toBe("fail");
    expect(after.jobState).toBe("COMPLETED");
  });

  it("retries when the terminal job's verdict is incomplete", async () => {
    const env = fresh();
    const p = probe(3, null, { dispatchedAt: "2026-10-13T09:50:00.000Z" });
    verdictsFor(p, [{ kind: "absent" }, { kind: "invalid", reason: "unknown verdict schema" }]);
    const backend = stubBackend({ status: vi.fn(async () => runStatus({ state: "FAILED", terminal: true })) });
    const { probe: after } = await tickProbe(env, p, backend);
    expect(after.attempt).toBe(2);
    expect(after.infraFailures.at(-1)?.reason).toBe("the verdict was not a complete document (unknown verdict schema)");
  });

  it("explains a silent terminal job with and without a code and message", async () => {
    const env = fresh();
    const p = probe(3, null, { dispatchedAt: "2026-10-13T09:50:00.000Z" });
    const withDetail = stubBackend({
      status: vi.fn(async () => runStatus({ state: "ERROR", terminal: true, code: "Boom", message: "bad things" })),
    });
    const a = await tickProbe(env, p, withDetail);
    expect(a.probe.infraFailures.at(-1)?.reason).toBe("the job ended ERROR (Boom) without reporting: bad things");

    const env2 = fresh();
    const bare = stubBackend({ status: vi.fn(async () => runStatus({ state: "FAILED", terminal: true })) });
    const b = await tickProbe(env2, p, bare);
    expect(b.probe.infraFailures.at(-1)?.reason).toBe("the job ended FAILED without reporting");
  });

  it("cancels and retries a probe past its deadline, even when the cancel itself fails", async () => {
    const env = fresh();
    const p = probe(3, null, { dispatchedAt: "2026-10-13T09:00:00.000Z" });
    const backend = stubBackend({
      status: vi.fn(async () => runStatus({ state: "RUNNING" })),
      cancel: vi.fn(async () => {
        throw new Error("cancel refused");
      }),
    });
    const { probe: after } = await tickProbe(env, p, backend);
    expect(backend.cancel).toHaveBeenCalledWith(p.jobId);
    expect(after.attempt).toBe(2);
    expect(after.infraFailures.at(-1)?.reason).toBe("no verdict within 45 minutes");
  });

  it("changes nothing when polling the job throws", async () => {
    const env = fresh();
    const p = probe(3, null, { dispatchedAt: "2026-10-13T09:50:00.000Z" });
    const backend = stubBackend({
      status: vi.fn(async () => {
        throw new Error("transient");
      }),
    });
    const { probe: after } = await tickProbe(env, p, backend);
    expect(after.phase).toBe("running");
    expect(after.attempt).toBe(1);
    expect(after.infraFailures).toEqual([]);
  });
});

describe("adopting dispatch claims", () => {
  const dispatching = () => probe(3, null, { phase: "dispatching", jobId: null, jobState: null, dispatchedAt: null, notBefore: "2026-10-13T11:00:00.000Z" });

  it("re-queues a dispatching probe whose claim has vanished", async () => {
    const env = fresh();
    mocked(store.readClaim).mockResolvedValue(null);
    const { probe: after } = await tickProbe(env, dispatching(), stubBackend());
    expect(after.phase).toBe("queued");
  });

  it("runs the probe when the claim's owner recorded a job", async () => {
    const env = fresh();
    const p = dispatching();
    mocked(store.readClaim).mockResolvedValue(claimOf(p, { runId: "job-9" }));
    const { probe: after } = await tickProbe(env, p, stubBackend());
    expect(after).toMatchObject({ phase: "running", jobId: "job-9", region: "r1", dispatchedAt: NOW });
  });

  it("fails the attempt when the claim recorded a dispatch error", async () => {
    const env = fresh();
    const p = dispatching();
    mocked(store.readClaim).mockResolvedValue(claimOf(p, { error: "boom" }));
    const { probe: after } = await tickProbe(env, p, stubBackend());
    expect(after.attempt).toBe(2);
    expect(after.infraFailures.at(-1)).toMatchObject({ reason: "dispatch failed: boom", region: "r1" });
  });

  it("waits while the claim is young", async () => {
    const env = fresh();
    const p = dispatching();
    mocked(store.readClaim).mockResolvedValue(claimOf(p));
    const backend = stubBackend();
    const { probe: after } = await tickProbe(env, p, backend);
    expect(after.phase).toBe("dispatching");
    expect(backend.find).not.toHaveBeenCalled();
  });

  it("finds the orphaned job of a dead owner by name and records it", async () => {
    const env = fresh();
    const p = dispatching();
    mocked(store.readClaim).mockResolvedValue(claimOf(p, { claimedAt: "2026-10-13T09:50:00.000Z" }));
    mocked(store.recordDispatch).mockResolvedValue(undefined);
    const backend = stubBackend({ find: vi.fn(async () => ({ runId: "job-found" })) });
    const { probe: after } = await tickProbe(env, p, backend);
    expect(backend.find).toHaveBeenCalledWith(expect.stringMatching(/^faultline-[0-9a-f]{8}-r1-i3-/), "r1");
    expect(store.recordDispatch).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.objectContaining({ runId: "job-found" }));
    expect(after).toMatchObject({ phase: "running", jobId: "job-found" });
  });

  it("gives up on a dead owner whose job was never created", async () => {
    const env = fresh();
    const p = dispatching();
    mocked(store.readClaim).mockResolvedValue(claimOf(p, { claimedAt: "2026-10-13T09:50:00.000Z" }));
    const { probe: after } = await tickProbe(env, p, stubBackend());
    expect(after.attempt).toBe(2);
    expect(after.infraFailures.at(-1)?.reason).toBe("dispatch never completed");
  });
});

describe("dispatching", () => {
  const queued = (i: number, over: Partial<Probe> = {}) =>
    probe(i, null, { phase: "queued", region: null, jobId: null, jobState: null, dispatchedAt: null, startedAt: null, ...over });

  it("counts slots held by finished-but-live jobs and by regions outside the backend's list", async () => {
    const env = fresh();
    const backend = stubBackend({ slotsPerRegion: 1 });
    const h = await seed(env, {
      probes: [
        probe(1, null, { region: "elsewhere" }),
        probe(2, "pass", { region: "r1", jobState: "PROVISIONING", finishedAt: NOW }),
        queued(3),
        filler(),
      ],
    });
    const after = must(await tick({ ...env.ctx, backend }, h.id));
    expect(backend.dispatch).not.toHaveBeenCalled();
    expect(after.probes.find((p) => p.commitIndex === 3)?.phase).toBe("queued");
  });

  it("reuses an avoided region when it is the only one free", async () => {
    const env = fresh();
    const backend = stubBackend();
    const failure = { attempt: 1, jobId: null, region: "r1", reason: "x", at: NOW };
    const h = await seed(env, { probes: [queued(3, { attempt: 2, infraFailures: [failure] }), filler()] });
    const after = must(await tick({ ...env.ctx, backend }, h.id));
    expect(backend.dispatch).toHaveBeenCalledTimes(1);
    expect(after.probes.find((p) => p.commitIndex === 3)).toMatchObject({ phase: "running", region: "r1", jobId: "job-new" });
  });

  it("leaves the probe queued when the claim cannot be written", async () => {
    const env = fresh();
    mocked(store.claimDispatch).mockRejectedValue(new Error("kv down"));
    const backend = stubBackend();
    const h = await seed(env, { probes: [queued(3), filler()] });
    const after = must(await tick({ ...env.ctx, backend }, h.id));
    expect(backend.dispatch).not.toHaveBeenCalled();
    expect(after.probes.find((p) => p.commitIndex === 3)?.phase).toBe("queued");
  });

  it("still runs the probe when recording the job ID fails", async () => {
    const env = fresh();
    mocked(store.recordDispatch).mockRejectedValue(new Error("kv down"));
    const backend = stubBackend();
    const h = await seed(env, { probes: [queued(3), filler()] });
    const after = must(await tick({ ...env.ctx, backend }, h.id));
    expect(after.probes.find((p) => p.commitIndex === 3)).toMatchObject({ phase: "running", jobId: "job-new" });
  });

  it("fails the attempt on a thrown Error, even when recording the failure fails too", async () => {
    const env = fresh();
    mocked(store.recordDispatch).mockRejectedValue(new Error("kv down"));
    const backend = stubBackend({
      dispatch: vi.fn(async () => {
        throw new Error("503 Service Unavailable");
      }),
    });
    const h = await seed(env, { probes: [queued(3), filler()] });
    const after = must(await tick({ ...env.ctx, backend }, h.id));
    expect(after.probes.find((p) => p.commitIndex === 3)?.infraFailures.at(-1)?.reason).toBe(
      "dispatch failed: 503 Service Unavailable",
    );
  });

  it("stringifies a non-Error rejection", async () => {
    const env = fresh();
    const backend = stubBackend({
      dispatch: vi.fn(async () => {
        throw "plain string";
      }),
    });
    const h = await seed(env, { probes: [queued(3), filler()] });
    const after = must(await tick({ ...env.ctx, backend }, h.id));
    expect(after.probes.find((p) => p.commitIndex === 3)?.infraFailures.at(-1)?.reason).toBe("dispatch failed: plain string");
  });
});

describe("resumeHunt", () => {
  const paused = (env: Env, probes: Probe[]) =>
    seed(env, {
      status: "paused",
      pause: { commitSha: "s", commitIndex: 3, round: 1, attempts: 3, message: "m", at: NOW },
      probes,
    });

  it("404s an unknown hunt and passes a non-paused hunt straight through", async () => {
    const env = fresh();
    expect(await resumeHunt(env.ctx, randomUUID())).toMatchObject({ ok: false, status: 404, error: "No such hunt." });
    const running = await seed(env, { probes: [filler()] });
    const result = await resumeHunt(env.ctx, running.id);
    expect(result).toMatchObject({ ok: true, hunt: { id: running.id, status: "running" } });
    expect(store.replaceHunt).not.toHaveBeenCalled();
  });

  it("refuses while another live hunt holds the lock, naming it", async () => {
    const env = fresh();
    const holder = await seed(env, { probes: [filler()] });
    await actualStore.acquireLiveLock(env.ctx, holder.id, async () => false);
    const h = await paused(env, [filler()]);
    const result = await resumeHunt(env.ctx, h.id);
    expect(result).toMatchObject({ ok: false, status: 409, holder: holder.id });
  });

  it("takes over a lock whose holder hunt no longer exists, and refreshes only exhausted budgets", async () => {
    const env = fresh();
    await actualStore.acquireLiveLock(env.ctx, randomUUID(), async () => false);
    const spent = [1, 2, 3].map((attempt) => ({ attempt, jobId: null, region: "eu-west1", reason: "x", at: NOW }));
    const exhaustedProbe = probe(3, null, {
      phase: "queued", attempt: 4, jobId: null, jobState: null, region: null,
      notBefore: "2026-10-13T12:00:00.000Z", infraFailures: spent,
    });
    const h = await paused(env, [exhaustedProbe, filler()]);
    const result = await resumeHunt(env.ctx, h.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hunt.status).toBe("running");
    expect(result.hunt.pause).toBeNull();
    const revived = must(result.hunt.probes.find((p) => p.commitIndex === 3));
    expect(revived.budgetFrom).toBe(4);
    expect(revived.notBefore).toBeNull();
    expect(result.hunt.probes.find((p) => p.commitIndex === 7)?.budgetFrom).toBe(1);
  });

  it("reports a lost race when the record changed while resuming", async () => {
    const env = fresh();
    const h = await paused(env, [filler()]);
    mocked(store.replaceHunt).mockResolvedValue({ ok: false } as never);
    expect(await resumeHunt(env.ctx, h.id)).toMatchObject({ ok: false, status: 409, error: "The hunt changed while resuming; try again." });
  });

  it("returns the resumed record if the follow-up tick finds nothing", async () => {
    const env = fresh();
    const h = await paused(env, [filler()]);
    mocked(store.readHuntVersioned).mockResolvedValueOnce(await actualStore.readHuntVersioned(env.ctx, h.id)).mockResolvedValue(null);
    const result = await resumeHunt(env.ctx, h.id);
    expect(result).toMatchObject({ ok: true, hunt: { status: "running", pause: null } });
  });
});

describe("settling the bill", () => {
  it("tolerates a status failure for one job and keeps the figures", async () => {
    const env = fresh();
    const p = probe(3, "pass", { jobState: "PROVISIONING", finishedAt: "2026-10-13T09:50:00.000Z" });
    const done = probe(2, "pass", { jobState: "COMPLETED" });
    const h = await seed(env, { status: "done", probes: [p, done] });
    const backend = stubBackend({
      status: vi.fn(async () => {
        throw new Error("transient");
      }),
    });
    const after = must(await tick({ ...env.ctx, backend }, h.id));
    expect(backend.status).toHaveBeenCalledTimes(1);
    expect(after.status).toBe("done");
    expect(after.probes.find((x) => x.commitIndex === 3)?.jobState).toBe("PROVISIONING");
  });
});

describe("narration", () => {
  const report = (over: Record<string, unknown> = {}) => ({
    culpritSha: shaFor(3), culpritSubject: "s", culpritAuthor: "a", culpritDate: "d",
    diffText: "", rootCauseMd: null, modelId: "m", narrationProvider: "p", narrationRequestId: null, narrationError: null,
    ...over,
  });
  const narrating = (env: Env, over: Partial<Hunt> = {}) =>
    seed(env, { status: "narrating", report: report(), probes: [probe(3, "fail", { tail: "E   boom" })], ...over });
  const claim = (claimedAt: string, result: unknown = null) => ({ attempt: 1, claimedAt, result }) as never;
  const outcome = (over = {}) => ({
    rootCauseMd: "because", error: null, requestId: "req-1", model: "m", durationMs: 1,
    usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0 }, retryable: false, ...over,
  });
  const tf = (env: Env) => ({ ...env.ctx, tokenFactory: { apiKey: "k" } as never });

  it("errors a narrating hunt that has no report", async () => {
    const env = fresh();
    const h = await narrating(env, { report: null });
    expect(must(await tick(env.ctx, h.id)).status).toBe("error");
  });

  it("adopts the result of an earlier claim", async () => {
    const env = fresh();
    mocked(store.readNarrationClaim).mockResolvedValue(
      claim(NOW, { rootCauseMd: "earlier", error: null, requestId: "r0", diffText: "+x" }),
    );
    const h = await narrating(env);
    const after = must(await tick(env.ctx, h.id));
    expect(after.status).toBe("done");
    expect(after.report).toMatchObject({ rootCauseMd: "earlier", narrationRequestId: "r0", diffText: "+x" });
    expect(store.claimNarration).not.toHaveBeenCalled();
  });

  it("waits while another tick holds a fresh claim", async () => {
    const env = fresh();
    mocked(store.readNarrationClaim).mockResolvedValue(claim(NOW));
    const h = await narrating(env);
    expect(must(await tick(env.ctx, h.id)).status).toBe("narrating");
    expect(store.claimNarration).not.toHaveBeenCalled();
  });

  it("gives up with an explanation when every attempt was abandoned", async () => {
    const env = fresh();
    mocked(store.readNarrationClaim).mockResolvedValue(claim("2026-10-13T09:00:00.000Z"));
    const h = await narrating(env, { report: report({ diffText: "kept diff" }) });
    const after = must(await tick(env.ctx, h.id));
    expect(after.status).toBe("done");
    expect(after.report).toMatchObject({
      rootCauseMd: null,
      narrationError: "The explanation was started but never finished.",
      diffText: "kept diff",
    });
  });

  it("runs the next attempt when the first was abandoned, and loses quietly if someone else claims", async () => {
    const env = fresh();
    mocked(store.readNarrationClaim)
      .mockResolvedValueOnce(claim("2026-10-13T09:00:00.000Z"))
      .mockResolvedValueOnce(null);
    mocked(store.claimNarration).mockResolvedValue(false);
    const h = await narrating(env);
    expect(must(await tick(env.ctx, h.id)).status).toBe("narrating");
    expect(store.claimNarration).toHaveBeenCalledWith(expect.anything(), h.id, 2, expect.any(Date));
  });

  it("explains a model that cannot be reached because Token Factory is not configured", async () => {
    const env = fresh();
    const h = await narrating(env);
    const after = must(await tick(env.ctx, h.id));
    expect(after.status).toBe("done");
    expect(after.report?.narrationError).toBe("Token Factory is not configured, so no explanation was generated.");
    expect(after.report?.diffText).toContain("+changed");
  });

  it("explains a diff that cannot be fetched, for Error and non-Error rejections", async () => {
    const env = fresh();
    mocked(git.fetchCommitDiff).mockRejectedValueOnce(new Error("404 nope"));
    const a = must(await tick(env.ctx, (await narrating(env)).id));
    expect(a.report?.narrationError).toBe("Could not fetch the culprit's diff: 404 nope");
    expect(a.status).toBe("done");

    mocked(git.fetchCommitDiff).mockRejectedValueOnce("string failure");
    const b = must(await tick(env.ctx, (await narrating(env)).id));
    expect(b.report?.narrationError).toBe("Could not fetch the culprit's diff: string failure");
  });

  it("narrates with the failing probe's tail, falling back to its detail, then to nothing", async () => {
    const env = fresh();
    mocked(narration.narrate).mockResolvedValue(outcome());
    const withTail = must(await tick(tf(env), (await narrating(env)).id));
    expect(withTail.report).toMatchObject({ rootCauseMd: "because", narrationRequestId: "req-1", narrationError: null });
    expect(mocked(narration.buildPrompt).mock.calls[0]?.[2]).toBe("E   boom");

    const detailOnly = await narrating(env, { probes: [probe(3, "fail", { tail: null, detail: "exit 1" })] });
    await tick(tf(env), detailOnly.id);
    expect(mocked(narration.buildPrompt).mock.calls[1]?.[2]).toBe("exit 1");

    const neither = await narrating(env, { probes: [probe(3, "fail", { tail: null, detail: null })] });
    await tick(tf(env), neither.id);
    expect(mocked(narration.buildPrompt).mock.calls[2]?.[2]).toBe("");

    const noFailing = await narrating(env, { probes: [probe(2, "pass")] });
    await tick(tf(env), noFailing.id);
    expect(mocked(narration.buildPrompt).mock.calls[3]?.[2]).toBe("");
  });

  it("retries one fast transient narration failure, but not a slow one or a refusal (a2a r06)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const env = fresh();
      mocked(narration.narrate)
        .mockResolvedValueOnce(outcome({ rootCauseMd: null, error: "Token Factory returned 503", requestId: null, retryable: true, durationMs: 400 }))
        .mockResolvedValueOnce(outcome());
      const pending = tick(tf(env), (await narrating(env)).id);
      await vi.advanceTimersByTimeAsync(3_000);
      const retried = must(await pending);
      expect(mocked(narration.narrate)).toHaveBeenCalledTimes(2);
      expect(retried.report).toMatchObject({ rootCauseMd: "because", narrationError: null });

      mocked(narration.narrate).mockClear();
      mocked(narration.narrate).mockResolvedValueOnce(outcome({ rootCauseMd: null, error: "Token Factory returned 400", requestId: null }));
      const refused = must(await tick(tf(env), (await narrating(env)).id));
      expect(mocked(narration.narrate)).toHaveBeenCalledTimes(1);
      expect(refused.report?.narrationError).toBe("Token Factory returned 400");

      mocked(narration.narrate).mockClear();
      mocked(narration.narrate).mockResolvedValueOnce(outcome({ rootCauseMd: null, error: "timeout", requestId: null, retryable: true, durationMs: 90_000 }));
      const slow = must(await tick(tf(env), (await narrating(env)).id));
      expect(mocked(narration.narrate)).toHaveBeenCalledTimes(1);
      expect(slow.report?.narrationError).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still finishes when the narration result cannot be recorded, keeping the old diff if the new one is empty", async () => {
    const env = fresh();
    mocked(git.fetchCommitDiff).mockResolvedValue("");
    mocked(narration.narrate).mockResolvedValue(outcome({ rootCauseMd: null, error: "model down", requestId: null }));
    mocked(store.recordNarration).mockRejectedValue(new Error("kv down"));
    const h = await narrating(env, { report: report({ diffText: "old diff" }) });
    const after = must(await tick(tf(env), h.id));
    expect(after.status).toBe("done");
    expect(after.report).toMatchObject({ diffText: "old diff", narrationError: "model down", rootCauseMd: null });
  });
});
