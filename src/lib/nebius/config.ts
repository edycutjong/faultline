/**
 * Nebius configuration, read once from the environment.
 *
 * Faultline must serve its recorded example hunt with NO credentials configured at all — a
 * judge opening the deploy on a cold visit sees a working product, not a stack trace. So
 * config resolution never throws; it returns a discriminated result and the live-hunt path
 * is the only thing that requires `configured: true`.
 */

/** One region probes may run in: a project to own the jobs and a subnet to attach them to. */
export interface ProbeRegion {
  region: string;
  projectId: string;
  subnetId: string;
}

export interface NebiusConfig {
  /** Service account ID — the JWT `iss` and `sub`. */
  serviceAccountId: string;
  /** Authorized (public) key ID — the JWT `kid`. */
  authKeyId: string;
  /** PEM contents of the RSA private key that signs the JWT. */
  privateKeyPem: string;
  /** Project ID — `metadata.parentId` on every created resource in the home region. */
  projectId: string;
  /** Required by the Jobs API when the project has more than one subnet. */
  subnetId: string;
  /** Home region: where the bucket lives and where probes go first. */
  region: string;
  /**
   * Every region a probe may be dispatched to, home region first. Extra regions come from
   * `FAULTLINE_EXTRA_REGIONS`; they work because a probe reports through a presigned HTTPS
   * URL rather than a bucket mount, so it never needs to reach the bucket's region privately.
   */
  probeRegions: ProbeRegion[];
  /** Concurrent probe jobs allowed per region. See SLOTS_PER_REGION. */
  slotsPerRegion: number;
  /** Object Storage bucket holding hunt records, claims and probe verdicts. */
  bucket: string;
  s3Endpoint: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  /** Container image the probe jobs run. A stock image: probe.py is injected per job. */
  probeImage: string;
}

export type ConfigResult =
  | { configured: true; config: NebiusConfig }
  | { configured: false; missing: string[] };

const REQUIRED = [
  "NEBIUS_SERVICE_ACCOUNT_ID",
  "NEBIUS_AUTH_KEY_ID",
  "NEBIUS_AUTH_PRIVATE_KEY",
  "NEBIUS_PROJECT_ID",
  "NEBIUS_SUBNET_ID",
  "NEBIUS_BUCKET",
  "NEBIUS_S3_ACCESS_KEY_ID",
  "NEBIUS_S3_SECRET_ACCESS_KEY",
] as const;

/**
 * `eu-west1` carries `cpu-d3` and has CPU quota on this tenant. `eu-north1` — the only home
 * of `cpu-e2` — has a non-GPU vCPU quota of 0 there (measured 2026-10-13: ResourceExhausted).
 */
export const DEFAULT_REGION = "eu-west1";

/**
 * Concurrent probe jobs per region.
 *
 * Measured, not assumed: on this tenant `compute.instance.count` is 2 in every region, and a
 * third concurrent job is REJECTED with QuotaExceeded rather than queued (2026-10-13, jobs
 * aijob-e01t8pdpnybtndzfve / -e01yc0s0t4zment99q / -e01bt5zjj4w9eks093). Dispatching past it
 * does not buy parallelism; it buys a failed probe. Overridable only for a raised quota.
 */
export const SLOTS_PER_REGION = 2;

/** Stock image with git and pip. Measured to clone, install and run pytest as a Nebius job. */
export const DEFAULT_PROBE_IMAGE = "python:3.11";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const missing = REQUIRED.filter((k) => !env[k]?.trim());
  if (missing.length > 0) return { configured: false, missing: [...missing] };

  const region = env.NEBIUS_REGION?.trim() || DEFAULT_REGION;
  const projectId = req(env, "NEBIUS_PROJECT_ID");
  const subnetId = req(env, "NEBIUS_SUBNET_ID");

  return {
    configured: true,
    config: {
      serviceAccountId: req(env, "NEBIUS_SERVICE_ACCOUNT_ID"),
      authKeyId: req(env, "NEBIUS_AUTH_KEY_ID"),
      // A PEM pasted with `\n` escapes is unescaped; one stored with real newlines is untouched.
      privateKeyPem: req(env, "NEBIUS_AUTH_PRIVATE_KEY").replace(/\\n/g, "\n"),
      projectId,
      subnetId,
      region,
      probeRegions: [
        { region, projectId, subnetId },
        ...parseExtraRegions(env.FAULTLINE_EXTRA_REGIONS).filter((r) => r.region !== region),
      ],
      slotsPerRegion: parseSlots(env.FAULTLINE_SLOTS_PER_REGION),
      bucket: req(env, "NEBIUS_BUCKET"),
      s3Endpoint:
        env.NEBIUS_S3_ENDPOINT?.trim() || `https://storage.${region}.nebius.cloud`,
      s3AccessKeyId: req(env, "NEBIUS_S3_ACCESS_KEY_ID"),
      s3SecretAccessKey: req(env, "NEBIUS_S3_SECRET_ACCESS_KEY"),
      probeImage: env.FAULTLINE_PROBE_IMAGE?.trim() || DEFAULT_PROBE_IMAGE,
    },
  };
}

/**
 * `region:project:subnet` triples, comma-separated. Malformed entries are dropped rather than
 * guessed at: a wrong subnet is a failed probe, and a dropped region only costs parallelism.
 */
export function parseExtraRegions(raw: string | undefined): ProbeRegion[] {
  if (!raw?.trim()) return [];
  const out: ProbeRegion[] = [];
  for (const entry of raw.split(",")) {
    const [region, projectId, subnetId, ...rest] = entry.trim().split(":");
    if (rest.length > 0 || !region || !projectId?.startsWith("project-") || !subnetId?.startsWith("vpcsubnet-")) {
      continue;
    }
    if (out.some((r) => r.region === region)) continue;
    out.push({ region, projectId, subnetId });
  }
  return out;
}

function parseSlots(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 16 ? n : SLOTS_PER_REGION;
}

/** Total concurrent probes the configured regions can hold. */
export function probeCapacity(config: Pick<NebiusConfig, "probeRegions" | "slotsPerRegion">): number {
  return config.probeRegions.length * config.slotsPerRegion;
}

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  // Unreachable: `missing` is checked before this runs. Present so the type is string, not
  // string | undefined, without a non-null assertion.
  // unreachable: loadConfig rejects blank/missing keys before req() runs
  /* v8 ignore next */
  if (!v) throw new Error(`missing required env var ${key}`);
  return v.trim();
}

export const NEBIUS_API_BASE = "https://api.nebius.cloud";
export const NEBIUS_TOKEN_EXCHANGE_URL =
  "https://auth.eu.nebius.com/oauth2/token/exchange";

/** Non-GPU AMD EPYC Genoa — available in every CPU region this tenant has quota in. */
export const PROBE_PLATFORM = "cpu-d3";
/** The smallest cpu-d3 preset. */
export const PROBE_PRESET = "2vcpu-8gb";

// Pricing lives in src/lib/pricing.ts so the UI can price a hunt with the same function.
export { PRICING, probeCostUsd } from "@/lib/pricing";

/** Token Factory: where the narration model is called. Independent of the Jobs credentials. */
export interface TokenFactoryConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export const TOKEN_FACTORY_BASE_URL = "https://api.tokenfactory.nebius.com/v1";
export const NARRATION_MODEL = "nvidia/nemotron-3-super-120b-a12b";

/** Which probe backend this deploy runs probes on. Serverless AI Jobs unless told otherwise. */
export type ProbeBackendKind = "jobs" | "sandboxes";

export function probeBackendKind(env: NodeJS.ProcessEnv = process.env): ProbeBackendKind {
  return env.FAULTLINE_PROBE_BACKEND?.trim().toLowerCase() === "sandboxes" ? "sandboxes" : "jobs";
}

/**
 * Token Factory Sandboxes: the second probe backend. It authenticates with the same Token
 * Factory API key as narration plus the Token Factory project ID (`aiproject-…`, from
 * tokenfactory.nebius.com/project/api-keys) — not the Nebius Cloud project the jobs run in.
 */
export interface SandboxesConfig {
  apiKey: string;
  projectId: string;
  baseUrl: string;
  /** A preloaded image tag; probe.py is fed to it on stdin, so nothing is built or pushed. */
  image: string;
  /** Concurrent probe sandboxes. Never above the beta's 50 simultaneous operations. */
  slots: number;
}

export const SANDBOXES_BASE_URL = "https://api.tokenfactory.nebius.com/sandboxes";
/** Beta limit, from the Sandboxes overview and GET /v1/whoami (`instance_max_concurrency`). */
export const SANDBOXES_MAX_CONCURRENCY = 50;
/** Room for a full round (8 interior + 2 endpoints) with headroom, far below the beta cap. */
export const DEFAULT_SANDBOX_SLOTS = 16;
/** The longest a sandbox may run (`instance_max_timeout` from GET /v1/whoami). */
export const SANDBOXES_MAX_TIMEOUT_SECONDS = 3600;

export function loadSandboxesConfig(env: NodeJS.ProcessEnv = process.env): SandboxesConfig | null {
  const apiKey = env.FAULTLINE_SANDBOXES_API_KEY?.trim() || env.TOKENFACTORY_API_KEY?.trim();
  const projectId = env.TOKENFACTORY_PROJECT_ID?.trim();
  if (!apiKey || !projectId) return null;
  const slots = Number(env.FAULTLINE_SANDBOX_SLOTS);
  return {
    apiKey,
    projectId,
    baseUrl: (env.FAULTLINE_SANDBOXES_URL?.trim() || SANDBOXES_BASE_URL).replace(/\/+$/, ""),
    image: env.FAULTLINE_PROBE_IMAGE?.trim() || DEFAULT_PROBE_IMAGE,
    slots: Number.isInteger(slots) && slots >= 1 && slots <= SANDBOXES_MAX_CONCURRENCY ? slots : DEFAULT_SANDBOX_SLOTS,
  };
}

export function loadTokenFactoryConfig(env: NodeJS.ProcessEnv = process.env): TokenFactoryConfig | null {
  const apiKey = env.TOKENFACTORY_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: env.TOKENFACTORY_BASE_URL?.trim() || TOKEN_FACTORY_BASE_URL,
    model: env.FAULTLINE_NARRATION_MODEL?.trim() || NARRATION_MODEL,
  };
}
