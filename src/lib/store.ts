/**
 * Hunt persistence and coordination.
 *
 * One JSON object per hunt in the Object Storage bucket, plus three kinds of small object
 * that make a daemon-less control loop safe:
 *
 *   - a hunt record is only ever REPLACED with `If-Match: <etag>`, so two concurrent ticks
 *     cannot overwrite each other's progress — the loser re-reads and re-applies;
 *   - a probe is only ever DISPATCHED by whoever creates its claim with `If-None-Match: "*"`,
 *     so dispatch happens once per (hunt, round, commit, attempt), however many ticks race;
 *   - the one-live-hunt lock and the daily counter use the same two primitives.
 *
 * Measured on the real bucket (evidence/g5-conditional-writes.json): 20/20 races with up to
 * eight concurrent creators had exactly one winner, and a stale ETag was refused with 412.
 *
 * Nothing a probe can reach is in here: probes hold one presigned URL for their own verdict
 * object, and these records live under keys no probe is ever granted.
 *
 * Without Nebius credentials the same operations run against process memory, so local
 * development and the recorded example still work. That fallback is not a database: a hunt
 * held in memory has no jobs behind it.
 */

import type { Hunt, ProbeResult, Verdict } from "@/lib/types";
import {
  loadConfig,
  loadTokenFactoryConfig,
  type NebiusConfig,
  type TokenFactoryConfig,
} from "@/lib/nebius/config";
import {
  getObjectVersioned,
  keys,
  presignPut,
  putObjectConditional,
  putObject,
  type ConditionalResult,
  type Versioned,
  type WriteCondition,
} from "@/lib/nebius/storage";
import type { ProbeBackend } from "@/lib/backend/types";
import { JobsBackend } from "@/lib/backend/jobs-backend";

// ---------------------------------------------------------------------------------------------
// The key-value seam
// ---------------------------------------------------------------------------------------------

export interface Kv {
  get(key: string): Promise<Versioned<string> | null>;
  /** Unconditional when `condition` is omitted. */
  put(key: string, body: string, condition?: WriteCondition): Promise<ConditionalResult>;
  /** A URL that can PUT exactly `key` until it expires. */
  presignPut(key: string, expiresSeconds: number): string;
}

export class S3Kv implements Kv {
  constructor(
    private readonly config: NebiusConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get(key: string) {
    return getObjectVersioned(this.config, key, this.fetchImpl);
  }

  async put(key: string, body: string, condition?: WriteCondition): Promise<ConditionalResult> {
    if (condition) return putObjectConditional(this.config, key, body, condition, this.fetchImpl);
    await putObject(this.config, key, body, this.fetchImpl);
    return { ok: true, etag: null };
  }

  presignPut(key: string, expiresSeconds: number): string {
    return presignPut(this.config, key, expiresSeconds);
  }
}

/** Same semantics as the bucket — including 412 on a lost condition — held in memory. */
export class MemoryKv implements Kv {
  private readonly objects = new Map<string, Versioned<string> & { etag: string }>();
  private version = 0;

  async get(key: string) {
    const found = this.objects.get(key);
    return found ? { value: found.value, etag: found.etag } : null;
  }

  async put(key: string, body: string, condition?: WriteCondition): Promise<ConditionalResult> {
    const existing = this.objects.get(key);
    if (condition && "ifNoneMatch" in condition && existing) return { ok: false, status: 412 };
    if (condition && "ifMatch" in condition && existing?.etag !== condition.ifMatch) {
      return { ok: false, status: 412 };
    }
    this.version += 1;
    const etag = `"m${this.version}"`;
    this.objects.set(key, { value: body, etag });
    return { ok: true, etag };
  }

  presignPut(key: string): string {
    return `memory://${key}`;
  }

  /** Test seam: write as a probe would, through its URL. */
  async putPresigned(url: string, body: string): Promise<void> {
    await this.put(url.replace(/^memory:\/\//, ""), body);
  }

  clear(): void {
    this.objects.clear();
  }

  keys(): string[] {
    return [...this.objects.keys()];
  }
}

// ---------------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------------

export interface StoreContext {
  kv: Kv;
  config: NebiusConfig | null;
  backend: ProbeBackend | null;
  tokenFactory: TokenFactoryConfig | null;
  /** Used for GitHub and Token Factory calls. A seam for tests. */
  fetchImpl: typeof fetch;
  now: () => Date;
}

const memoryKv = new MemoryKv();

export function storeContext(env: NodeJS.ProcessEnv = process.env): StoreContext {
  const result = loadConfig(env);
  const config = result.configured ? result.config : null;
  return {
    kv: config ? new S3Kv(config) : memoryKv,
    config,
    backend: config ? new JobsBackend(config) : null,
    tokenFactory: loadTokenFactoryConfig(env),
    fetchImpl: (...args) => fetch(...args),
    now: () => new Date(),
  };
}

/** Test seam: clear in-memory state between cases. */
export function resetMemoryStore(): void {
  memoryKv.clear();
}

async function getJsonVersioned<T>(kv: Kv, key: string): Promise<Versioned<T> | null> {
  const found = await kv.get(key);
  if (!found) return null;
  return { value: JSON.parse(found.value) as T, etag: found.etag };
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// ---------------------------------------------------------------------------------------------
// Hunts
// ---------------------------------------------------------------------------------------------

export async function readHunt(ctx: StoreContext, huntId: string): Promise<Hunt | null> {
  return (await readHuntVersioned(ctx, huntId))?.value ?? null;
}

export async function readHuntVersioned(ctx: StoreContext, huntId: string): Promise<Versioned<Hunt> | null> {
  if (!/^[0-9a-f-]{8,64}$/i.test(huntId)) return null;
  return getJsonVersioned<Hunt>(ctx.kv, keys.hunt(huntId));
}

/** Create a hunt record. False if one already exists under that ID. */
export async function createHunt(ctx: StoreContext, hunt: Hunt): Promise<boolean> {
  return (await ctx.kv.put(keys.hunt(hunt.id), json(hunt), { ifNoneMatch: "*" })).ok;
}

/** Replace a hunt record only if nobody has written it since `etag` was read. */
export async function replaceHunt(ctx: StoreContext, hunt: Hunt, etag: string | null): Promise<ConditionalResult> {
  if (etag === null) {
    // A backend that returns no ETag cannot do compare-and-swap. Refuse rather than race.
    throw new Error("hunt record has no ETag; refusing an unconditional overwrite");
  }
  return ctx.kv.put(keys.hunt(hunt.id), json(hunt), { ifMatch: etag });
}

// ---------------------------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------------------------

export type VerdictRead =
  | { kind: "absent" }
  | { kind: "valid"; result: ProbeResult }
  | { kind: "invalid"; reason: string };

const VERDICTS: readonly Verdict[] = ["pass", "fail", "error"];

/**
 * Read one probe's self-reported verdict, and decide whether it IS one.
 *
 * A verdict exists only if the probe's complete document is present and names this exact
 * probe. Anything else — torn, foreign, malformed — is not evidence about the commit, and
 * the engine treats it like silence: retried, never narrowed on.
 */
export async function readVerdict(
  ctx: StoreContext,
  huntId: string,
  probeKey: string,
  commitSha: string,
): Promise<VerdictRead> {
  const found = await ctx.kv.get(keys.probeVerdict(huntId, probeKey));
  if (!found) return { kind: "absent" };
  return parseVerdict(found.value, huntId, probeKey, commitSha);
}

export function parseVerdict(text: string, huntId: string, probeKey: string, commitSha: string): VerdictRead {
  let doc: Partial<ProbeResult>;
  try {
    doc = JSON.parse(text) as Partial<ProbeResult>;
  } catch {
    return { kind: "invalid", reason: "verdict document is not complete JSON" };
  }
  if (doc.schema !== "faultline.probe.v2") return { kind: "invalid", reason: "unknown verdict schema" };
  if (doc.huntId !== huntId || doc.probeKey !== probeKey || doc.commitSha !== commitSha) {
    return { kind: "invalid", reason: "verdict names a different probe" };
  }
  if (!doc.verdict || !VERDICTS.includes(doc.verdict)) return { kind: "invalid", reason: "verdict value missing" };
  if (typeof doc.durationMs !== "number") return { kind: "invalid", reason: "verdict has no duration" };
  return { kind: "valid", result: doc as ProbeResult };
}

export function verdictUrl(ctx: StoreContext, huntId: string, probeKey: string, expiresSeconds: number): string {
  return ctx.kv.presignPut(keys.probeVerdict(huntId, probeKey), expiresSeconds);
}

// ---------------------------------------------------------------------------------------------
// Dispatch claims
// ---------------------------------------------------------------------------------------------

/** Who dispatched one probe attempt, and what came of it. */
export interface DispatchClaim {
  probeKey: string;
  claimedAt: string;
  region: string;
  /** Null until the claim's owner has created the job. */
  runId: string | null;
  /** Set when creating the job itself failed. */
  error: string | null;
}

/** Create the claim. Exactly one caller per key gets `true`. */
export async function claimDispatch(ctx: StoreContext, huntId: string, claim: DispatchClaim): Promise<{ won: boolean; etag: string | null }> {
  const result = await ctx.kv.put(keys.dispatchClaim(huntId, claim.probeKey), json(claim), { ifNoneMatch: "*" });
  return { won: result.ok, etag: result.ok ? result.etag : null };
}

/**
 * Claim the n-th launch into a region. Region capacity is counted from the hunt record a tick
 * read, which a concurrent tick may have outdated; both would then fill the same last slot and
 * Nebius would reject the second job (QuotaExceeded). Numbering the launches and claiming each
 * number with `If-None-Match` lets exactly one of them go; the loser stays queued for the next tick.
 */
export async function claimSlot(ctx: StoreContext, huntId: string, region: string, launch: number, now: Date): Promise<boolean> {
  return (await ctx.kv.put(keys.slotClaim(huntId, region, launch), json({ region, launch, claimedAt: now.toISOString() }), { ifNoneMatch: "*" })).ok;
}

/** The owner records the outcome of its dispatch. Nobody else ever writes a claim. */
export async function recordDispatch(ctx: StoreContext, huntId: string, claim: DispatchClaim): Promise<void> {
  await ctx.kv.put(keys.dispatchClaim(huntId, claim.probeKey), json(claim));
}

export async function readClaim(ctx: StoreContext, huntId: string, probeKey: string): Promise<DispatchClaim | null> {
  return (await getJsonVersioned<DispatchClaim>(ctx.kv, keys.dispatchClaim(huntId, probeKey)))?.value ?? null;
}

// ---------------------------------------------------------------------------------------------
// Narration claims
// ---------------------------------------------------------------------------------------------

export interface NarrationClaim {
  attempt: number;
  claimedAt: string;
  /** Written by the owner when the call returns, so a lost hunt write cannot lose it. */
  result: { rootCauseMd: string | null; error: string | null; requestId: string | null; diffText: string } | null;
}

export async function claimNarration(ctx: StoreContext, huntId: string, attempt: number, now: Date): Promise<boolean> {
  const claim: NarrationClaim = { attempt, claimedAt: now.toISOString(), result: null };
  return (await ctx.kv.put(keys.narrationClaim(huntId, attempt), json(claim), { ifNoneMatch: "*" })).ok;
}

export async function recordNarration(ctx: StoreContext, huntId: string, claim: NarrationClaim): Promise<void> {
  await ctx.kv.put(keys.narrationClaim(huntId, claim.attempt), json(claim));
}

export async function readNarrationClaim(ctx: StoreContext, huntId: string, attempt: number): Promise<NarrationClaim | null> {
  return (await getJsonVersioned<NarrationClaim>(ctx.kv, keys.narrationClaim(huntId, attempt)))?.value ?? null;
}

// ---------------------------------------------------------------------------------------------
// One live hunt at a time
// ---------------------------------------------------------------------------------------------

export interface LiveLock {
  huntId: string;
  acquiredAt: string;
  expiresAt: string;
  released: boolean;
}

/** A hunt that outlives this is presumed dead; its lock can be taken over. */
export const LIVE_LOCK_TTL_MS = 3 * 60 * 60 * 1000;

export type LockResult = { acquired: true } | { acquired: false; holder: string };

/**
 * Take the live-hunt lock for `huntId`.
 *
 * The backend's capacity is shared by every hunt: two live hunts at two VMs per region would
 * starve each other into quota rejections. So a second hunt is refused, and pointed at the
 * one already running, until the first finishes, releases, or outlives LIVE_LOCK_TTL_MS.
 */
export async function acquireLiveLock(
  ctx: StoreContext,
  huntId: string,
  isFinished: (holder: string) => Promise<boolean>,
): Promise<LockResult> {
  const now = ctx.now();
  const lock: LiveLock = {
    huntId,
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + LIVE_LOCK_TTL_MS).toISOString(),
    released: false,
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const created = await ctx.kv.put(keys.liveLock(), json(lock), { ifNoneMatch: "*" });
    if (created.ok) return { acquired: true };

    const current = await getJsonVersioned<LiveLock>(ctx.kv, keys.liveLock());
    if (!current) continue; // vanished between the two calls; try to create again
    const held = current.value;
    const free =
      held.released ||
      new Date(held.expiresAt).getTime() <= now.getTime() ||
      (await isFinished(held.huntId));
    if (!free) return { acquired: false, holder: held.huntId };
    if (current.etag === null) return { acquired: false, holder: held.huntId };

    const taken = await ctx.kv.put(keys.liveLock(), json(lock), { ifMatch: current.etag });
    if (taken.ok) return { acquired: true };
  }
  const holder = (await getJsonVersioned<LiveLock>(ctx.kv, keys.liveLock()))?.value.huntId ?? "unknown";
  return { acquired: false, holder };
}

/** Release the lock if — and only if — `huntId` still holds it. */
export async function releaseLiveLock(ctx: StoreContext, huntId: string): Promise<void> {
  const current = await getJsonVersioned<LiveLock>(ctx.kv, keys.liveLock());
  if (!current || current.value.huntId !== huntId || current.value.released || current.etag === null) return;
  await ctx.kv.put(keys.liveLock(), json({ ...current.value, released: true }), { ifMatch: current.etag });
}

export async function readLiveLock(ctx: StoreContext): Promise<LiveLock | null> {
  return (await getJsonVersioned<LiveLock>(ctx.kv, keys.liveLock()))?.value ?? null;
}

// ---------------------------------------------------------------------------------------------
// The daily live-hunt counter
// ---------------------------------------------------------------------------------------------

/** Live hunts per UTC day, so judge traffic cannot silently drain the credit balance. */
export interface DailyCounter {
  day: string;
  count: number;
}

/** Default cap; FAULTLINE_DAILY_CAP overrides it, never below a floor of 1 per day. */
export const DAILY_LIVE_HUNT_CAP = 10;

export function dailyCap(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.FAULTLINE_DAILY_CAP);
  return Number.isInteger(n) && n >= 1 ? n : DAILY_LIVE_HUNT_CAP;
}

function day(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export async function readDailyCount(ctx: StoreContext): Promise<DailyCounter> {
  const today = day(ctx.now());
  const stored = await getJsonVersioned<DailyCounter>(ctx.kv, keys.dailyCounter(today));
  return stored?.value.day === today ? stored.value : { day: today, count: 0 };
}

/** Atomic increment: compare-and-swap, retried, so concurrent hunts each count once. */
export async function incrementDailyCount(ctx: StoreContext): Promise<DailyCounter> {
  const today = day(ctx.now());
  const key = keys.dailyCounter(today);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const current = await getJsonVersioned<DailyCounter>(ctx.kv, key);
    const next: DailyCounter = { day: today, count: (current?.value.count ?? 0) + 1 };
    const result = current
      ? current.etag === null
        ? await ctx.kv.put(key, json(next))
        : await ctx.kv.put(key, json(next), { ifMatch: current.etag })
      : await ctx.kv.put(key, json(next), { ifNoneMatch: "*" });
    if (result.ok) return next;
  }
  throw new Error("could not increment the daily counter after 6 attempts");
}
