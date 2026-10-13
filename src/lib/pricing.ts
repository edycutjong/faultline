/**
 * What a hunt costs: measured VM time × Nebius list price.
 *
 * VM time is the measurement (each job's create→finish, as Nebius reports it); the price is a
 * published constant that changes. So cost is always DERIVED from the VM time at the current
 * list price — never trusted from a number stored when the hunt ran. Pure and client-safe:
 * the UI prices a recorded hunt with the same function the engine uses.
 */

import type { Probe } from "@/lib/types";

/**
 * Nebius list price for `cpu-d3` (Non-GPU AMD Epyc Genoa), from 1 October 2026
 * (docs.nebius.com/compute/resources/pricing; before that date $0.012 and $0.0032).
 * Billing unit is 1 second; pricing unit is 1 hour.
 */
export const PRICING = {
  cpuPerCoreHourUsd: 0.015,
  ramPerGibHourUsd: 0.0045,
  effectiveFrom: "2026-10-01",
} as const;

/** `2vcpu-8gb`, the preset every probe runs on. */
export const PROBE_VCPUS = 2;
export const PROBE_RAM_GIB = 8;

/** List-price cost of one probe VM on cpu-d3/2vcpu-8gb for a measured duration. */
export function probeCostUsd(durationMs: number): number {
  const hours = durationMs / 3_600_000;
  return hours * (PROBE_VCPUS * PRICING.cpuPerCoreHourUsd + PROBE_RAM_GIB * PRICING.ramPerGibHourUsd);
}

/**
 * VM time a probe could bill: Nebius's own create→finish once the job has ended, otherwise
 * the time from dispatch until its verdict landed — the job is still exiting then, so this is
 * a few seconds short, and later reads of the hunt replace it with the job's own figure.
 */
export function billedMs(probe: Probe): number | null {
  if (probe.vmMs !== null) return probe.vmMs;
  if (probe.phase === "done" && probe.dispatchedAt && probe.finishedAt) {
    return Math.max(0, new Date(probe.finishedAt).getTime() - new Date(probe.dispatchedAt).getTime());
  }
  return null;
}

/** Total VM time of a set of probes, or null when none has reported one. */
export function totalVmMs(probes: readonly Probe[]): number | null {
  const measured = probes.map(billedMs).filter((ms): ms is number => ms !== null);
  return measured.length === 0 ? null : measured.reduce((sum, ms) => sum + ms, 0);
}

/** A hunt's cost at the current list price, from its probes' VM time. */
export function huntCostUsd(hunt: { probes: readonly Probe[] }): number | null {
  const ms = totalVmMs(hunt.probes);
  return ms === null ? null : probeCostUsd(ms);
}
