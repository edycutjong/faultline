import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROBE_IMAGE,
  DEFAULT_REGION,
  NARRATION_MODEL,
  SLOTS_PER_REGION,
  TOKEN_FACTORY_BASE_URL,
  loadConfig,
  loadTokenFactoryConfig,
  parseExtraRegions,
  probeCapacity,
} from "@/lib/nebius/config";

const env = (o: Record<string, string | undefined>) => o as unknown as NodeJS.ProcessEnv;

const base = env({
  NEBIUS_SERVICE_ACCOUNT_ID: " sa-1 ",
  NEBIUS_AUTH_KEY_ID: "key-1",
  NEBIUS_AUTH_PRIVATE_KEY: "-----BEGIN-----\\nabc\\n-----END-----",
  NEBIUS_PROJECT_ID: "project-home",
  NEBIUS_SUBNET_ID: "vpcsubnet-home",
  NEBIUS_BUCKET: "bkt",
  NEBIUS_S3_ACCESS_KEY_ID: "ak",
  NEBIUS_S3_SECRET_ACCESS_KEY: "sk",
});

function cfg(env: NodeJS.ProcessEnv) {
  const r = loadConfig(env);
  if (!r.configured) throw new Error("expected configured");
  return r.config;
}

describe("loadConfig", () => {
  it("lists every missing/blank var", () => {
    expect(loadConfig(env({}))).toMatchObject({ configured: false });
    const r = loadConfig({ ...base, NEBIUS_BUCKET: "  ", NEBIUS_AUTH_KEY_ID: undefined });
    expect(r).toEqual({ configured: false, missing: ["NEBIUS_AUTH_KEY_ID", "NEBIUS_BUCKET"] });
  });

  it("applies defaults and unescapes the PEM", () => {
    const c = cfg(base);
    expect(c.serviceAccountId).toBe("sa-1");
    expect(c.privateKeyPem).toBe("-----BEGIN-----\nabc\n-----END-----");
    expect(c.region).toBe(DEFAULT_REGION);
    expect(c.s3Endpoint).toBe(`https://storage.${DEFAULT_REGION}.nebius.cloud`);
    expect(c.probeImage).toBe(DEFAULT_PROBE_IMAGE);
    expect(c.slotsPerRegion).toBe(SLOTS_PER_REGION);
    expect(c.probeRegions).toEqual([
      { region: DEFAULT_REGION, projectId: "project-home", subnetId: "vpcsubnet-home" },
    ]);
  });

  it("honours overrides and merges extra regions without duplicating home", () => {
    const c = cfg({
      ...base,
      NEBIUS_REGION: " eu-north1 ",
      NEBIUS_S3_ENDPOINT: " https://s3.example ",
      FAULTLINE_PROBE_IMAGE: " img:1 ",
      FAULTLINE_SLOTS_PER_REGION: "4",
      FAULTLINE_EXTRA_REGIONS:
        "eu-north1:project-a:vpcsubnet-a,us-central1:project-b:vpcsubnet-b",
    });
    expect(c.region).toBe("eu-north1");
    expect(c.s3Endpoint).toBe("https://s3.example");
    expect(c.probeImage).toBe("img:1");
    expect(c.slotsPerRegion).toBe(4);
    expect(c.probeRegions.map((r) => r.region)).toEqual(["eu-north1", "us-central1"]);
    expect(probeCapacity(c)).toBe(8);
  });

  it.each(["0", "17", "1.5", "abc", ""])("falls back on invalid slots %j", (v) => {
    expect(cfg({ ...base, FAULTLINE_SLOTS_PER_REGION: v }).slotsPerRegion).toBe(SLOTS_PER_REGION);
  });

  it("accepts boundary slots 1 and 16", () => {
    expect(cfg({ ...base, FAULTLINE_SLOTS_PER_REGION: "1" }).slotsPerRegion).toBe(1);
    expect(cfg({ ...base, FAULTLINE_SLOTS_PER_REGION: "16" }).slotsPerRegion).toBe(16);
  });
});

describe("parseExtraRegions", () => {
  it("returns [] for empty input", () => {
    expect(parseExtraRegions(undefined)).toEqual([]);
    expect(parseExtraRegions("   ")).toEqual([]);
  });

  it("drops malformed entries and duplicate regions", () => {
    const raw = [
      "r1:project-1:vpcsubnet-1",
      "r1:project-9:vpcsubnet-9", // duplicate region
      "r2:project-2:vpcsubnet-2:extra", // too many parts
      ":project-3:vpcsubnet-3", // no region
      "r4:proj-4:vpcsubnet-4", // bad project
      "r5:project-5:sub-5", // bad subnet
      "r6:project-6", // missing subnet
      "r7",
      " r8:project-8:vpcsubnet-8 ",
    ].join(",");
    expect(parseExtraRegions(raw)).toEqual([
      { region: "r1", projectId: "project-1", subnetId: "vpcsubnet-1" },
      { region: "r8", projectId: "project-8", subnetId: "vpcsubnet-8" },
    ]);
  });
});

describe("loadTokenFactoryConfig", () => {
  it("returns null without a key", () => {
    expect(loadTokenFactoryConfig(env({}))).toBeNull();
    expect(loadTokenFactoryConfig(env({ TOKENFACTORY_API_KEY: "  " }))).toBeNull();
  });

  it("uses defaults", () => {
    expect(loadTokenFactoryConfig(env({ TOKENFACTORY_API_KEY: " k " }))).toEqual({
      apiKey: "k",
      baseUrl: TOKEN_FACTORY_BASE_URL,
      model: NARRATION_MODEL,
    });
  });

  it("uses overrides", () => {
    expect(
      loadTokenFactoryConfig(
        env({
          TOKENFACTORY_API_KEY: "k",
          TOKENFACTORY_BASE_URL: " https://tf.example ",
          FAULTLINE_NARRATION_MODEL: " m ",
        }),
      ),
    ).toEqual({ apiKey: "k", baseUrl: "https://tf.example", model: "m" });
  });
});
