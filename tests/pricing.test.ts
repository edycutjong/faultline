/**
 * Cost is derived from measured VM time at the current list price — never a stored figure.
 */

import { describe, it, expect } from "vitest";
import { billedMs, huntCostUsd, PRICING, probeCostUsd, totalVmMs } from "@/lib/pricing";
import { GET as recordedExample } from "@/app/api/examples/recorded/route";
import type { Hunt } from "@/lib/types";
import { probe } from "./helpers";

describe("pricing", () => {
  it("uses the cpu-d3 list price in force since 1 October 2026", () => {
    expect(PRICING).toEqual({ cpuPerCoreHourUsd: 0.015, ramPerGibHourUsd: 0.0045, effectiveFrom: "2026-10-01" });
  });

  it("prefers Nebius's own VM time, and falls back to dispatch→verdict for a job still exiting", () => {
    expect(billedMs(probe(1, "pass", { vmMs: 270_000 }))).toBe(270_000);
    expect(
      billedMs(probe(1, "pass", { vmMs: null, dispatchedAt: "2026-10-13T10:00:00Z", finishedAt: "2026-10-13T10:04:30Z" })),
    ).toBe(270_000);
    expect(billedMs(probe(1, null, { vmMs: null }))).toBeNull();
  });

  it("prices a hunt from its probes, so a recorded hunt is always priced at today's list price", async () => {
    const probes = [probe(1, "pass", { vmMs: 260_000 }), probe(2, "fail", { vmMs: 280_000 })];
    expect(totalVmMs(probes)).toBe(540_000);
    expect(huntCostUsd({ probes })).toBeCloseTo(probeCostUsd(540_000), 12);
    expect(huntCostUsd({ probes: [] })).toBeNull();

    // The recorded example's JSON is served at that same price, not the one stored in the file.
    const served = ((await (await recordedExample()).json()) as { hunt: Hunt }).hunt;
    expect(served.costUsd).toBeCloseTo(huntCostUsd(served) as number, 10);
    expect(served.costUsd).toBeCloseTo(0.0948, 4);
  });
});
