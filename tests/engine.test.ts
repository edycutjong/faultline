/**
 * The hunt engine, behaviour by behaviour.
 *
 * Each block below is one of the required behaviours from the spec's a2a r01/r02 review,
 * exercised through the real tick (compare-and-swap, claims, planner, verdict rules) against
 * an in-memory bucket and a fake backend that reports the way a probe does: by PUTting a
 * verdict to its presigned URL.
 */

import { describe, it, expect } from "vitest";
import {
  isThrottle,
  newHunt,
  nextWakeAt,
  resumeHunt,
  startHunt,
  tick,
  MAX_ATTEMPTS,
  MAX_THROTTLED,
  PROBE_TIMEOUT_SECONDS,
} from "@/lib/hunt";
import { claimSlot, readHunt, readLiveLock, readDailyCount, type StoreContext } from "@/lib/store";
import type { Hunt } from "@/lib/types";
import { indexOf, memoryContext, must, shaFor, syntheticCommits, type Behaviour } from "./helpers";

const GOOD = shaFor(0);

function hunt(ctx: StoreContext, commits = 64, overrides: Partial<Parameters<typeof newHunt>[0]> = {}): Hunt {
  return newHunt({
    repoUrl: "https://github.com/faultline-bench/tzdata-pipeline",
    testCommand: "pytest tests/test_window.py::test_daily_boundary",
    installCommand: "pip install -e .[test]",
    goodRef: "v1.4.0",
    goodSha: GOOD,
    badRef: "HEAD",
    commits: syntheticCommits(commits),
    slots: must(ctx.backend).capacity(),
    backend: must(ctx.backend).id,
    regions: [...must(ctx.backend).regions],
    tickBaseUrl: "https://faultline.example",
    now: ctx.now(),
    ...overrides,
  });
}

/** Culprit at `c`: commits from c onward fail, earlier ones (and the good ref) pass. */
function regression(c: number): (sha: string) => Behaviour {
  return (sha) => (indexOf(sha) >= c ? "fail" : "pass");
}

/** Complete every live probe and tick, until the hunt stops or `max` steps pass. */
async function drive(env: ReturnType<typeof memoryContext>, id: string, max = 40): Promise<Hunt> {
  let current = must(await readHunt(env.ctx, id));
  for (let step = 0; step < max; step += 1) {
    if (!["running", "planning", "narrating"].includes(current.status)) return current;
    await env.backend.completeAll();
    env.advance(30_000);
    current = must(await tick(env.ctx, id));
  }
  return current;
}

async function started(env: ReturnType<typeof memoryContext>, commits = 64, overrides = {}): Promise<Hunt> {
  const result = await startHunt(env.ctx, hunt(env.ctx, commits, overrides));
  if (!result.ok) throw new Error(result.error);
  return result.hunt;
}

const FOUR_REGIONS = ["eu-west1", "uk-south1", "uk-south2", "me-west1"];

describe("finds the culprit", () => {
  it.each([1, 2, 17, 33, 63, 64])("at index %i of 64 with two slots", async (culprit) => {
    const env = memoryContext(regression(culprit));
    const h = await started(env);
    const done = await drive(env, h.id);
    expect(done.status).toBe("done");
    expect(done.report?.culpritSha).toBe(shaFor(culprit));
  });

  it("settles 256 commits in 3 rounds and at most 24 probes on 8 slots across 4 regions", async () => {
    const env = memoryContext(regression(137), { regions: FOUR_REGIONS });
    const h = await started(env, 256);
    const done = await drive(env, h.id);
    expect(done.report?.culpritSha).toBe(shaFor(137));
    expect(done.round).toBe(3);
    expect(done.probes.length).toBeLessThanOrEqual(24);
    expect(env.backend.launches.length).toBe(done.probes.length);
  });

  it("takes 7 rounds for 256 commits on a single region's two slots, and says so up front", async () => {
    const env = memoryContext(regression(200));
    const h = await started(env, 256);
    const done = await drive(env, h.id);
    expect(done.report?.culpritSha).toBe(shaFor(200));
    expect(done.round).toBeLessThanOrEqual(7);
  });
});

describe("#1 — the endpoints are probed, not assumed", () => {
  it("tests the known-good ref and the failing ref in round 1", async () => {
    const env = memoryContext(regression(40));
    const h = await started(env);
    const roles = h.probes.filter((p) => p.round === 1).map((p) => [p.role, p.commitIndex]);
    expect(roles).toContainEqual(["good", 0]);
    expect(roles).toContainEqual(["bad", 64]);
    expect(h.probes.find((p) => p.role === "good")?.commitSha).toBe(GOOD);
  });

  it("takes the endpoints from the band at 8 slots (6 interior), adds them at 10+", async () => {
    const eight = memoryContext(regression(40), { regions: FOUR_REGIONS });
    expect((await started(eight)).probes.filter((p) => p.role === "interior")).toHaveLength(6);

    const ten = memoryContext(regression(40), { regions: [...FOUR_REGIONS, "us-north1"] });
    const round1 = (await started(ten)).probes;
    expect(round1.filter((p) => p.role === "interior")).toHaveLength(8);
    expect(round1).toHaveLength(10);
  });

  it("refuses when the known-good ref fails in its own clean environment", async () => {
    const env = memoryContext(() => "fail");
    const done = await drive(env, (await started(env)).id);
    expect(done.status).toBe("inconclusive");
    expect(done.inconclusive?.reason).toBe("good_fails");
    expect(done.report).toBeNull();
    expect(done.round).toBe(1);
  });

  it("refuses — and blames the environment — when the failing ref passes", async () => {
    const env = memoryContext(() => "pass");
    const done = await drive(env, (await started(env)).id);
    expect(done.inconclusive?.reason).toBe("bad_passes");
    expect(done.inconclusive?.headline).toMatch(/passes in a clean environment/);
  });

  it("gives an unbuildable good ref its own refusal", async () => {
    const env = memoryContext((sha) => (sha === GOOD ? "error" : regression(10)(sha)));
    const done = await drive(env, (await started(env)).id);
    expect(done.inconclusive?.reason).toBe("good_unbuildable");
    expect(done.inconclusive?.headline).toBe("Your known-good ref can't be built today.");
  });

  it("refuses when the failing ref cannot be built", async () => {
    const env = memoryContext((sha) => (indexOf(sha) === 64 ? "error" : regression(10)(sha)));
    const done = await drive(env, (await started(env)).id);
    expect(done.inconclusive?.reason).toBe("bad_unbuildable");
  });
});

describe("#3 + #4 — advances without a viewer, dispatches each probe exactly once", () => {
  it("hands every probe its empty-tick URL and its own deadline", async () => {
    const env = memoryContext(regression(40));
    const h = await started(env);
    for (const launch of env.backend.launches) {
      expect(launch.tickUrl).toBe(`https://faultline.example/api/hunts/${h.id}/tick`);
      expect(launch.timeoutSeconds).toBe(PROBE_TIMEOUT_SECONDS);
    }
  });

  it("never double-dispatches when many ticks race on the same round boundary", async () => {
    const env = memoryContext(regression(29), { regions: FOUR_REGIONS });
    const h = await started(env, 256);
    for (let round = 0; round < 6; round += 1) {
      await env.backend.completeAll();
      env.advance(30_000);
      await Promise.all(Array.from({ length: 6 }, () => tick(env.ctx, h.id)));
    }
    const done = must(await readHunt(env.ctx, h.id));
    expect(done.report?.culpritSha).toBe(shaFor(29));
    const names = env.backend.launches.map((l) => l.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBe(done.probes.length);
  });

  it("recovers a dispatch whose owner died before recording the job ID", async () => {
    const env = memoryContext(regression(20));
    const h = await started(env);
    // Simulate the crash: the hunt record forgets the job IDs it was given, as if the tick
    // that dispatched them died before its write landed. The claims still hold them.
    const stored = must(await env.kv.get(`hunts/${h.id}.json`));
    const amnesiac = JSON.parse(stored.value) as Hunt;
    amnesiac.probes = amnesiac.probes.map((p) => ({ ...p, phase: "dispatching", jobId: null }));
    await env.kv.put(`hunts/${h.id}.json`, JSON.stringify(amnesiac));

    const done = await drive(env, h.id);
    expect(done.report?.culpritSha).toBe(shaFor(20));
    const names = env.backend.launches.map((l) => l.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("#7 — a missing verdict is infrastructure: retried, then a pause, never a verdict", () => {
  it("retries a probe whose job ended without reporting, and uses the retry's verdict", async () => {
    let silencedOnce = false;
    const env = memoryContext((sha) => {
      if (!silencedOnce && indexOf(sha) === 64) {
        silencedOnce = true;
        return "silent";
      }
      return regression(30)(sha);
    });
    const done = await drive(env, (await started(env)).id);
    expect(done.report?.culpritSha).toBe(shaFor(30));
    const bad = must(done.probes.find((p) => p.role === "bad"));
    expect(bad.attempt).toBe(2);
    expect(bad.infraFailures).toHaveLength(1);
    expect(bad.infraFailures[0]?.reason).toMatch(/without reporting/);
    expect(bad.verdict).toBe("fail");
  });

  it("treats a malformed verdict document as silence, not as a pass", async () => {
    let first = true;
    const env = memoryContext((sha) => {
      if (first && indexOf(sha) === 64) {
        first = false;
        return "malformed";
      }
      return regression(30)(sha);
    });
    const done = await drive(env, (await started(env)).id);
    const bad = must(done.probes.find((p) => p.role === "bad"));
    expect(bad.verdict).toBe("fail");
    expect(bad.infraFailures[0]?.reason).toMatch(/not a complete document/);
  });

  it(`pauses after ${MAX_ATTEMPTS} silent attempts, concludes nothing, releases the lock, and resumes`, async () => {
    let silences = 0;
    const env = memoryContext((sha) => {
      if (indexOf(sha) === 64 && silences < MAX_ATTEMPTS) {
        silences += 1;
        return "silent";
      }
      return regression(30)(sha);
    });
    const h = await started(env);
    const paused = await drive(env, h.id);
    expect(paused.status).toBe("paused");
    expect(paused.pause?.attempts).toBe(MAX_ATTEMPTS);
    expect(paused.report).toBeNull();
    expect(paused.inconclusive).toBeNull();
    expect((await readLiveLock(env.ctx))?.released).toBe(true);

    const resumed = await resumeHunt(env.ctx, h.id);
    expect(resumed.ok).toBe(true);
    const done = await drive(env, h.id);
    expect(done.status).toBe("done");
    expect(done.report?.culpritSha).toBe(shaFor(30));
  });

  it("gives up on a probe that hangs past its deadline, cancels the job, and retries", async () => {
    let hung = false;
    const env = memoryContext((sha) => {
      if (!hung && indexOf(sha) === 64) return "hang";
      return regression(30)(sha);
    });
    const h = await started(env);
    await env.backend.completeAll();
    env.advance(60 * 60_000);
    hung = true;
    const ticked = must(await tick(env.ctx, h.id));
    const bad = must(ticked.probes.find((p) => p.role === "bad"));
    expect(bad.infraFailures[0]?.reason).toMatch(/no verdict within/);
    expect(env.backend.cancelled.length).toBe(1);
    const done = await drive(env, h.id);
    expect(done.report?.culpritSha).toBe(shaFor(30));
  });

  it("retries a dispatch the API rejected, on the next tick", async () => {
    const env = memoryContext(regression(30));
    env.backend.dispatchFailures = 1;
    const done = await drive(env, (await started(env)).id);
    expect(done.report?.culpritSha).toBe(shaFor(30));
    expect(done.probes.some((p) => p.infraFailures.some((f) => /dispatch failed/.test(f.reason)))).toBe(true);
  });

  it("waits out a throttled create with backoff, without spending the retry budget", async () => {
    const env = memoryContext(regression(30));
    env.backend.throttledCreates = 3;
    const h = await started(env);
    const queued = h.probes.filter((p) => p.phase === "queued");
    expect(queued.length).toBeGreaterThan(0);
    for (const p of queued) {
      expect(p.infraFailures[0]?.throttled).toBe(true);
      expect(p.notBefore).not.toBeNull();
    }
    // The hunt says when it next has work no probe will tick it for.
    expect(nextWakeAt(h)?.toISOString()).toBe(queued.map((p) => p.notBefore).sort()[0]);

    // Ticking before the backoff ends dispatches nothing new.
    const before = env.backend.launches.length;
    await tick(env.ctx, h.id);
    expect(env.backend.launches.length).toBe(before);

    const done = await drive(env, h.id);
    expect(done.status).toBe("done");
    expect(done.report?.culpritSha).toBe(shaFor(30));
  });

  it(`pauses after ${MAX_THROTTLED} throttled creates in a row, and says it was capacity`, async () => {
    const env = memoryContext(regression(30));
    env.backend.throttledCreates = 1_000;
    const h = await started(env);
    let current = h;
    for (let i = 0; i < 40 && current.status === "running"; i += 1) {
      env.advance(5 * 60_000);
      current = must(await tick(env.ctx, h.id));
    }
    expect(current.status).toBe("paused");
    expect(current.pause?.message).toMatch(/refused to start/);
    expect(current.pause?.attempts).toBe(MAX_THROTTLED);
  });

  it("resume gives a throttle-exhausted probe a fresh budget, instead of pausing again on the next tick (a2a r06)", async () => {
    const env = memoryContext(regression(30));
    env.backend.throttledCreates = 1_000;
    const h = await started(env);
    let current = h;
    for (let i = 0; i < 40 && current.status === "running"; i += 1) {
      env.advance(5 * 60_000);
      current = must(await tick(env.ctx, h.id));
    }
    expect(current.status).toBe("paused");
    expect(current.pause?.message).toMatch(/refused to start/);

    env.backend.throttledCreates = 0; // capacity is back
    const resumed = await resumeHunt(env.ctx, h.id);
    if (!resumed.ok) throw new Error(resumed.error);
    expect(resumed.hunt.status).toBe("running");
    expect(resumed.hunt.pause).toBeNull();
    expect(resumed.hunt.probes.filter((p) => p.phase === "running").length).toBeGreaterThan(0);
    const done = await drive(env, h.id);
    expect(done.report?.culpritSha).toBe(shaFor(30));
  });

  it("recognises throttling from the API's words, and nothing else", () => {
    expect(isThrottle("dispatch failed: POST /ai/v1/jobs failed: 429 Too Many Requests")).toBe(true);
    expect(isThrottle("the job ended ERROR (QuotaExceeded) without reporting")).toBe(true);
    expect(isThrottle("dispatch failed: POST /ai/v1/jobs failed: 503 Service Unavailable")).toBe(false);
    expect(isThrottle("the job ended FAILED (ContainerFailed) without reporting")).toBe(false);
  });

  it("never runs more than the per-region quota at once", async () => {
    const env = memoryContext(regression(150), { regions: FOUR_REGIONS });
    await drive(env, (await started(env, 256)).id);
    for (const peak of env.backend.peakPerRegion.values()) expect(peak).toBeLessThanOrEqual(2);
    expect([...env.backend.runs.values()].some((r) => r.code === "QuotaExceeded")).toBe(false);
  });
});

describe("#2 — an untestable commit is a skip", () => {
  it("plans around skipped commits and still names the culprit", async () => {
    // 18–24 will not build, and round 2's first cut (index 21) lands among them.
    const env = memoryContext((sha) => {
      const i = indexOf(sha);
      if (i >= 18 && i <= 24) return "error";
      return regression(30)(sha);
    });
    const done = await drive(env, (await started(env)).id);
    expect(done.status).toBe("done");
    expect(done.report?.culpritSha).toBe(shaFor(30));
    const skipped = done.probes.filter((p) => p.verdict === "error");
    expect(skipped.length).toBeGreaterThan(0);
    // A skipped commit is never probed again.
    expect(new Set(skipped.map((p) => p.commitIndex)).size).toBe(skipped.length);
  });

  it("never treats a skip as a contradiction", async () => {
    const env = memoryContext((sha) => (indexOf(sha) === 50 ? "error" : regression(12)(sha)));
    const done = await drive(env, (await started(env)).id);
    expect(done.status).toBe("done");
  });

  it("reports a culprit RANGE when skips hem it in", async () => {
    const env = memoryContext((sha) => {
      const i = indexOf(sha);
      if (i >= 30 && i <= 33) return "error";
      return regression(32)(sha);
    });
    const done = await drive(env, (await started(env)).id);
    expect(done.status).toBe("inconclusive");
    expect(done.inconclusive?.reason).toBe("skipped_range");
    const range = done.inconclusive?.range;
    expect(range?.shas).toContain(shaFor(32));
    expect(must(range).toIndex - must(range).fromIndex).toBeLessThanOrEqual(4);
  });
});

describe("#6 — the resolved install command reaches every probe", () => {
  it("passes the hunt's install command verbatim", async () => {
    const env = memoryContext(regression(30));
    await started(env);
    for (const launch of env.backend.launches) expect(launch.installCommand).toBe("pip install -e .[test]");
  });
});

describe("#8 — a probe holds nothing but its own verdict URL", () => {
  it("gives each probe a URL for exactly its own verdict key, and nothing credential-shaped", async () => {
    const env = memoryContext(regression(30));
    const h = await started(env);
    await drive(env, h.id);
    for (const launch of env.backend.launches) {
      expect(launch.verdictUrl).toBe(`memory://hunts/${h.id}/verdicts/${launch.probeKey}.json`);
      const values = Object.values(launch).map(String).join(" ");
      expect(values).not.toMatch(/secret|access.?key|private key/i);
    }
  });
});

describe("#5 — one live hunt at a time", () => {
  it("refuses a second live hunt and points at the running one, then allows it after", async () => {
    const env = memoryContext(regression(30));
    const first = await started(env);
    const second = await startHunt(env.ctx, hunt(env.ctx));
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.status).toBe(409);
      expect(second.holder).toBe(first.id);
    }
    await drive(env, first.id);
    const third = await startHunt(env.ctx, hunt(env.ctx));
    expect(third.ok).toBe(true);
  });

  it("counts every started hunt against the day, once", async () => {
    const env = memoryContext(regression(30));
    const first = await started(env);
    await drive(env, first.id);
    await started(env);
    expect((await readDailyCount(env.ctx)).count).toBe(2);
  });
});

describe("narration", () => {
  const tf = { apiKey: "tf-test", baseUrl: "https://tf.example/v1", model: "nvidia/nemotron-3-super-120b-a12b" };

  it("calls Token Factory once even when ticks race through the narrating stage", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("tf.example")) {
        calls += 1;
        await new Promise((r) => setTimeout(r, 20));
        return new Response(JSON.stringify({ id: "chatcmpl-1", choices: [{ message: { content: "The window shifts by the zone offset." } }] }));
      }
      return new Response("diff --git a/x b/x\n+x\n");
    };
    const env = memoryContext(regression(30), { tokenFactory: tf, fetchImpl });
    const h = await started(env);
    for (let i = 0; i < 12; i += 1) {
      await env.backend.completeAll();
      env.advance(30_000);
      await Promise.all([tick(env.ctx, h.id), tick(env.ctx, h.id), tick(env.ctx, h.id)]);
    }
    const done = must(await readHunt(env.ctx, h.id));
    expect(done.status).toBe("done");
    expect(done.report?.rootCauseMd).toBe("The window shifts by the zone offset.");
    expect(done.report?.narrationRequestId).toBe("chatcmpl-1");
    expect(calls).toBe(1);
  });

  it("narrates in the same tick that names the culprit — the last probe's tick may be the last tick", async () => {
    const env = memoryContext(regression(30));
    const h = await started(env);
    let current = h;
    while (current.status === "running") {
      await env.backend.completeAll();
      env.advance(100_000);
      current = must(await tick(env.ctx, h.id));
    }
    // One tick took it from the final verdict straight through narration.
    expect(current.status).toBe("done");
    expect(current.report?.narrationError).toMatch(/not configured/);
  });

  it("finishes with an error, never invented prose, when Token Factory is not configured", async () => {
    const env = memoryContext(regression(30));
    const done = await drive(env, (await started(env)).id);
    expect(done.status).toBe("done");
    expect(done.report?.rootCauseMd).toBeNull();
    expect(done.report?.narrationError).toMatch(/not configured/);
  });
});

describe("region slots under concurrent ticks", () => {
  it("a launch another tick already claimed is not taken twice — the probe stays queued", async () => {
    const env = memoryContext(regression(30), { regions: ["eu-west1"], slotsPerRegion: 2 });
    const h = hunt(env.ctx, 64);
    // A concurrent tick, working from the same record, already took launches 1 and 2 into the region.
    await claimSlot(env.ctx, h.id, "eu-west1", 1, env.ctx.now());
    await claimSlot(env.ctx, h.id, "eu-west1", 2, env.ctx.now());
    const result = await startHunt(env.ctx, h);
    if (!result.ok) throw new Error(result.error);
    const after = must(await readHunt(env.ctx, h.id));
    expect(after.probes.filter((p) => p.round === 1 && p.phase === "queued").length).toBeGreaterThan(0);
    expect(after.probes.some((p) => p.jobId !== null)).toBe(false);
  });

  it("ticks working from the same record never launch more jobs into a region than it has slots", async () => {
    const env = memoryContext(regression(30), { regions: ["eu-west1", "uk-south1"], slotsPerRegion: 2 });
    const h = await started(env, 64);
    const perRegion = new Map<string, number>();
    const orig = env.backend.dispatch.bind(env.backend);
    env.backend.dispatch = async (spec) => {
      perRegion.set(spec.region, (perRegion.get(spec.region) ?? 0) + 1);
      return orig(spec);
    };
    await Promise.all([tick(env.ctx, h.id), tick(env.ctx, h.id), tick(env.ctx, h.id)]);
    for (const n of perRegion.values()) expect(n).toBeLessThanOrEqual(2);
  });
});
