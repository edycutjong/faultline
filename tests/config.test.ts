/**
 * Configuration: where probes may run, and how many at once.
 *
 * The per-region slot count is a measured quota (2), and the region list is what turns it
 * into a band. A malformed region entry must cost parallelism, never a broken dispatch.
 */

import { describe, it, expect } from "vitest";
import { loadConfig, parseExtraRegions, probeCapacity, PROBE_PLATFORM, PROBE_PRESET, probeCostUsd } from "@/lib/nebius/config";

const BASE = {
  NEBIUS_SERVICE_ACCOUNT_ID: "serviceaccount-e00test",
  NEBIUS_AUTH_KEY_ID: "publickey-e00test",
  NEBIUS_AUTH_PRIVATE_KEY: "line-one\\nline-two\\n",
  NEBIUS_PROJECT_ID: "project-e01home",
  NEBIUS_SUBNET_ID: "vpcsubnet-e01home",
  NEBIUS_BUCKET: "faultline-test",
  NEBIUS_S3_ACCESS_KEY_ID: "k",
  NEBIUS_S3_SECRET_ACCESS_KEY: "s",
} as unknown as NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("defaults to eu-west1, two slots, the stock python image and its own storage endpoint", () => {
    const result = loadConfig(BASE);
    if (!result.configured) throw new Error("expected configured");
    expect(result.config.region).toBe("eu-west1");
    expect(result.config.slotsPerRegion).toBe(2);
    expect(result.config.probeImage).toBe("python:3.11");
    expect(result.config.s3Endpoint).toBe("https://storage.eu-west1.nebius.cloud");
    expect(result.config.probeRegions).toEqual([
      { region: "eu-west1", projectId: "project-e01home", subnetId: "vpcsubnet-e01home" },
    ]);
    expect(result.config.privateKeyPem).toBe("line-one\nline-two\n");
  });

  it("lists what is missing instead of throwing", () => {
    const result = loadConfig({} as NodeJS.ProcessEnv);
    expect(result.configured).toBe(false);
    if (!result.configured) expect(result.missing).toContain("NEBIUS_BUCKET");
  });

  it("adds extra regions after the home region, and multiplies capacity by them", () => {
    const result = loadConfig({
      ...BASE,
      FAULTLINE_EXTRA_REGIONS: "uk-south1:project-e03a:vpcsubnet-e03a, me-west1:project-i00b:vpcsubnet-i00b",
    } as unknown as NodeJS.ProcessEnv);
    if (!result.configured) throw new Error("expected configured");
    expect(result.config.probeRegions.map((r) => r.region)).toEqual(["eu-west1", "uk-south1", "me-west1"]);
    expect(probeCapacity(result.config)).toBe(6);
  });

  it("accepts a raised quota through FAULTLINE_SLOTS_PER_REGION, within reason", () => {
    const raised = loadConfig({ ...BASE, FAULTLINE_SLOTS_PER_REGION: "8" } as unknown as NodeJS.ProcessEnv);
    if (!raised.configured) throw new Error("expected configured");
    expect(raised.config.slotsPerRegion).toBe(8);
    const silly = loadConfig({ ...BASE, FAULTLINE_SLOTS_PER_REGION: "500" } as unknown as NodeJS.ProcessEnv);
    if (!silly.configured) throw new Error("expected configured");
    expect(silly.config.slotsPerRegion).toBe(2);
  });
});

describe("parseExtraRegions", () => {
  it("drops malformed entries and duplicates rather than guessing", () => {
    expect(
      parseExtraRegions("uk-south1:project-a:vpcsubnet-a,bad,uk-south1:project-b:vpcsubnet-b,x:y:z,me-west1:project-c:vpcsubnet-c:extra"),
    ).toEqual([{ region: "uk-south1", projectId: "project-a", subnetId: "vpcsubnet-a" }]);
    expect(parseExtraRegions(undefined)).toEqual([]);
    expect(parseExtraRegions("  ")).toEqual([]);
  });
});

describe("pricing", () => {
  it("prices cpu-d3 / 2vcpu-8gb at Nebius list price per measured second", () => {
    expect(PROBE_PLATFORM).toBe("cpu-d3");
    expect(PROBE_PRESET).toBe("2vcpu-8gb");
    // One hour = 2 vCPU × $0.012 + 8 GiB × $0.0032.
    expect(probeCostUsd(3_600_000)).toBeCloseTo(0.0496, 10);
    expect(probeCostUsd(0)).toBe(0);
  });
});
