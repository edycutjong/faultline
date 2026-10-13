/**
 * The re-tick delay: wake a throttled hunt when its backoff ends, in hops that fit a function.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("next/server", () => ({ after: () => undefined }));

import { retickDelayMs } from "@/lib/retick";
import { newHunt } from "@/lib/hunt";
import type { Hunt } from "@/lib/types";
import { probe, shaFor, syntheticCommits } from "./helpers";

function running(notBefore: string | null): Hunt {
  const base = newHunt({
    repoUrl: "https://github.com/a/b", testCommand: "pytest", goodRef: "v1", goodSha: shaFor(0),
    badRef: "HEAD", commits: syntheticCommits(16), slots: 2, backend: "fake", regions: ["eu-west1"],
  });
  return { ...base, status: "running", round: 1, probes: [probe(8, null, { phase: "queued", jobId: null, notBefore })] };
}

describe("retickDelayMs", () => {
  const now = Date.parse("2026-10-13T16:00:00Z");

  it("wakes a second after the backoff ends", () => {
    expect(retickDelayMs(running("2026-10-13T16:00:30Z"), now)).toBe(31_000);
  });

  it("never sleeps past 60 s in one function — a longer backoff is waited out in hops", () => {
    expect(retickDelayMs(running("2026-10-13T16:04:00Z"), now)).toBe(60_000);
  });

  it("does not schedule anything when no probe is waiting on a backoff", () => {
    expect(retickDelayMs(running(null), now)).toBeNull();
    expect(retickDelayMs(null, now)).toBeNull();
    expect(retickDelayMs({ ...running("2026-10-13T16:00:30Z"), status: "paused" }, now)).toBeNull();
  });
});
