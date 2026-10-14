import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryKv,
  S3Kv,
  acquireLiveLock,
  claimDispatch,
  claimNarration,
  createHunt,
  dailyCap,
  incrementDailyCount,
  parseVerdict,
  readClaim,
  readDailyCount,
  readHunt,
  readHuntVersioned,
  readLiveLock,
  readNarrationClaim,
  readVerdict,
  recordDispatch,
  recordNarration,
  releaseLiveLock,
  replaceHunt,
  resetMemoryStore,
  storeContext,
  verdictUrl,
  DAILY_LIVE_HUNT_CAP,
  type DispatchClaim,
  type Kv,
  type NarrationClaim,
  type StoreContext,
} from "@/lib/store";
import type { NebiusConfig } from "@/lib/nebius/config";
import type { Hunt } from "@/lib/types";
import type { ConditionalResult, Versioned, WriteCondition } from "@/lib/nebius/storage";

const NOW = new Date("2026-10-13T10:00:00Z");

function ctxOf(kv: Kv, now = NOW): StoreContext {
  return { kv, config: null, backend: null, tokenFactory: null, fetchImpl: fetch, now: () => now };
}

const hunt = { id: "abcdef12-3456" } as unknown as Hunt;

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

const ENV = {
  NEBIUS_SERVICE_ACCOUNT_ID: "sa",
  NEBIUS_AUTH_KEY_ID: "kid",
  NEBIUS_AUTH_PRIVATE_KEY: "pem",
  NEBIUS_PROJECT_ID: "proj",
  NEBIUS_SUBNET_ID: "subnet",
  NEBIUS_BUCKET: "bucket",
  NEBIUS_S3_ACCESS_KEY_ID: "ak",
  NEBIUS_S3_SECRET_ACCESS_KEY: "sk",
};

afterEach(() => {
  vi.unstubAllGlobals();
  resetMemoryStore();
});

/** A Kv whose behaviour is scripted per call. */
function scripted(opts: {
  get?: Array<Versioned<string> | null>;
  put?: ConditionalResult[];
}): Kv & { puts: Array<{ key: string; condition?: WriteCondition }> } {
  const gets = [...(opts.get ?? [])];
  const puts = [...(opts.put ?? [])];
  const log: Array<{ key: string; condition?: WriteCondition }> = [];
  return {
    puts: log,
    get: async () => (gets.length > 1 ? (gets.shift() ?? null) : (gets[0] ?? null)),
    put: async (key, _body, condition) => {
      log.push({ key, condition });
      return puts.length > 1 ? (puts.shift() ?? { ok: true, etag: null }) : (puts[0] ?? { ok: true, etag: null });
    },
    presignPut: (key) => `scripted://${key}`,
  };
}

const lockDoc = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    huntId: "other-hunt",
    acquiredAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    released: false,
    ...over,
  });

describe("S3Kv", () => {
  const config = { region: "eu-west1", bucket: "b", s3Endpoint: "https://s3.example", s3AccessKeyId: "ak", s3SecretAccessKey: "sk" } as unknown as NebiusConfig;

  it("gets, puts unconditionally, puts conditionally and presigns", async () => {
    const calls: Array<{ method?: string; headers: Headers }> = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls.push({ method: init?.method, headers: new Headers(init?.headers) });
      if (init?.method === "GET") return new Response("body", { status: 200, headers: { etag: '"e1"' } });
      return new Response("", { status: 200, headers: { etag: '"e2"' } });
    }) as unknown as typeof fetch;
    const kv = new S3Kv(config, fetchImpl);

    expect(await kv.get("k")).toEqual({ value: "body", etag: '"e1"' });
    expect(await kv.put("k", "x")).toEqual({ ok: true, etag: null });
    expect(await kv.put("k", "x", { ifMatch: '"e1"' })).toEqual({ ok: true, etag: '"e2"' });
    expect(calls[2]?.headers.get("if-match")).toBe('"e1"');
    expect(kv.presignPut("hunts/a.json", 60)).toContain("hunts/a.json");
  });

  it("defaults fetchImpl to global fetch", async () => {
    const spy = vi.fn(async () => new Response("", { status: 404 }));
    vi.stubGlobal("fetch", spy);
    expect(await new S3Kv(config).get("k")).toBeNull();
    expect(spy).toHaveBeenCalled();
  });
});

describe("MemoryKv", () => {
  it("returns null for missing, presigns, putPresigned, keys", async () => {
    const kv = new MemoryKv();
    expect(await kv.get("a")).toBeNull();
    expect(kv.presignPut("a/b")).toBe("memory://a/b");
    await kv.putPresigned("memory://a/b", "v");
    expect(kv.keys()).toEqual(["a/b"]);
    expect((await kv.get("a/b"))?.value).toBe("v");
    kv.clear();
    expect(kv.keys()).toEqual([]);
  });

  it("ifNoneMatch on a missing key succeeds; ifMatch on a missing key fails; ifNoneMatch on existing fails", async () => {
    const kv = new MemoryKv();
    expect((await kv.put("k", "1", { ifMatch: '"m1"' })).ok).toBe(false);
    expect((await kv.put("k", "1", { ifNoneMatch: "*" })).ok).toBe(true);
    expect(await kv.put("k", "2", { ifNoneMatch: "*" })).toEqual({ ok: false, status: 412 });
  });
});

describe("storeContext", () => {
  it("uses memory when unconfigured", async () => {
    const c = storeContext(env({}));
    expect(c.config).toBeNull();
    expect(c.backend).toBeNull();
    expect(c.tokenFactory).toBeNull();
    expect(c.kv).toBeInstanceOf(MemoryKv);
    expect(c.now()).toBeInstanceOf(Date);
    await c.kv.put("shared", "1");
    expect(storeContext(env({})).kv).toBe(c.kv);
    resetMemoryStore();
    expect(await c.kv.get("shared")).toBeNull();
  });

  it("uses S3 and the jobs backend when configured, and forwards fetch", async () => {
    const c = storeContext(env({ ...ENV, TOKENFACTORY_API_KEY: "tf" }));
    expect(c.config?.bucket).toBe("bucket");
    expect(c.kv).toBeInstanceOf(S3Kv);
    expect(c.backend).not.toBeNull();
    expect(c.tokenFactory?.apiKey).toBe("tf");
    const spy = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", spy);
    await c.fetchImpl("https://example.test/");
    expect(spy).toHaveBeenCalledWith("https://example.test/");
  });

  it("defaults env to process.env", () => {
    expect(storeContext().config).toBeNull();
  });
});

describe("hunts", () => {
  it("rejects malformed ids, reads missing, round-trips", async () => {
    const ctx = ctxOf(new MemoryKv());
    expect(await readHuntVersioned(ctx, "../x")).toBeNull();
    expect(await readHunt(ctx, "abcdef12-3456")).toBeNull();
    expect(await createHunt(ctx, hunt)).toBe(true);
    expect(await createHunt(ctx, hunt)).toBe(false);
    const v = await readHuntVersioned(ctx, hunt.id);
    expect(v?.value.id).toBe(hunt.id);
    expect((await readHunt(ctx, hunt.id))?.id).toBe(hunt.id);
    expect((await replaceHunt(ctx, hunt, (v as NonNullable<typeof v>).etag)).ok).toBe(true);
    expect((await replaceHunt(ctx, hunt, (v as NonNullable<typeof v>).etag)).ok).toBe(false);
  });

  it("refuses to replace without an etag", async () => {
    await expect(replaceHunt(ctxOf(new MemoryKv()), hunt, null)).rejects.toThrow(/no ETag/);
  });
});

describe("verdicts", () => {
  const good = { schema: "faultline.probe.v2", huntId: "h", probeKey: "p", commitSha: "c", verdict: "pass", durationMs: 5 };

  it("reads absent, valid and gives a presigned url", async () => {
    const kv = new MemoryKv();
    const ctx = ctxOf(kv);
    expect(await readVerdict(ctx, "h", "p", "c")).toEqual({ kind: "absent" });
    const url = verdictUrl(ctx, "h", "p", 60);
    expect(url).toBe("memory://hunts/h/verdicts/p.json");
    await kv.putPresigned(url, JSON.stringify(good));
    expect(await readVerdict(ctx, "h", "p", "c")).toEqual({
      kind: "valid",
      result: { ...good, exitCode: null, installCommand: null, timings: {}, detail: null, tail: null },
    });
  });

  it("refuses a verdict document over 256 KiB before parsing it (a2a r06)", async () => {
    const kv = new MemoryKv();
    const ctx = ctxOf(kv);
    await kv.putPresigned(verdictUrl(ctx, "h", "p", 60), JSON.stringify({ ...good, tail: "x".repeat(300 * 1024) }));
    expect(await readVerdict(ctx, "h", "p", "c")).toEqual({ kind: "invalid", reason: "verdict document is too large" });
  });

  it("rebuilds a valid verdict from checked fields only — hostile shapes never reach the record (a2a r06)", () => {
    const parse = (extra: Record<string, unknown>) => {
      const r = parseVerdict(JSON.stringify({ ...good, ...extra }), "h", "p", "c");
      if (r.kind !== "valid") throw new Error(r.kind);
      return r.result;
    };
    const hostile = parse({
      tail: { html: "<script>" },
      detail: 42,
      installCommand: ["pip"],
      exitCode: 1.5,
      timings: { cloneMs: 10, installMs: "slow", testMs: Number.MAX_VALUE, extra: 1 },
      injected: "dropped",
    });
    expect(hostile.tail).toBeNull();
    expect(hostile.detail).toBeNull();
    expect(hostile.installCommand).toBeNull();
    expect(hostile.exitCode).toBeNull();
    expect(hostile.timings).toEqual({ cloneMs: 10, testMs: Number.MAX_VALUE });
    expect(hostile).not.toHaveProperty("injected");
    const long = parse({ tail: "y".repeat(1_000_000), detail: "d", exitCode: 3, timings: null });
    expect(long.tail).toHaveLength(8_000);
    expect(long.detail).toBe("d");
    expect(long.exitCode).toBe(3);
    expect(long.timings).toEqual({});
  });

  it("classifies invalid documents", () => {
    const reason = (t: string, sha = "c") => {
      const r = parseVerdict(t, "h", "p", sha);
      return r.kind === "invalid" ? r.reason : r.kind;
    };
    expect(reason("{nope")).toMatch(/not complete JSON/);
    expect(reason(JSON.stringify({ ...good, schema: "x" }))).toMatch(/schema/);
    expect(reason(JSON.stringify(good), "other")).toMatch(/different probe/);
    expect(reason(JSON.stringify({ ...good, huntId: "z" }))).toMatch(/different probe/);
    expect(reason(JSON.stringify({ ...good, probeKey: "z" }))).toMatch(/different probe/);
    expect(reason(JSON.stringify({ ...good, verdict: undefined }))).toMatch(/value missing/);
    expect(reason(JSON.stringify({ ...good, verdict: "maybe" }))).toMatch(/value missing/);
    expect(reason(JSON.stringify({ ...good, durationMs: "5" }))).toMatch(/no duration/);
    expect(reason(JSON.stringify({ ...good, durationMs: null }))).toMatch(/no duration/);
    // Valid JSON that is not an object used to throw, which refreshProbe swallows and retries
    // forever: a probe that wrote `null` here would have wedged its hunt (a2a r06).
    for (const t of ["null", "5", '"pass"', "[]"]) expect(reason(t)).toMatch(/not an object/);
    expect(parseVerdict(JSON.stringify(good), "h", "p", "c").kind).toBe("valid");
  });
});

describe("claims", () => {
  const claim: DispatchClaim = { probeKey: "p", claimedAt: NOW.toISOString(), region: "r", runId: null, error: null };

  it("claims dispatch once, records and reads back", async () => {
    const ctx = ctxOf(new MemoryKv());
    expect(await readClaim(ctx, "h", "p")).toBeNull();
    const first = await claimDispatch(ctx, "h", claim);
    expect(first.won).toBe(true);
    expect(first.etag).toMatch(/^"m/);
    expect(await claimDispatch(ctx, "h", claim)).toEqual({ won: false, etag: null });
    await recordDispatch(ctx, "h", { ...claim, runId: "run-1" });
    expect((await readClaim(ctx, "h", "p"))?.runId).toBe("run-1");
  });

  it("claims narration once, records and reads back", async () => {
    const ctx = ctxOf(new MemoryKv());
    expect(await readNarrationClaim(ctx, "h", 1)).toBeNull();
    expect(await claimNarration(ctx, "h", 1, NOW)).toBe(true);
    expect(await claimNarration(ctx, "h", 1, NOW)).toBe(false);
    const stored = await readNarrationClaim(ctx, "h", 1);
    expect(stored).toEqual({ attempt: 1, claimedAt: NOW.toISOString(), result: null });
    const done: NarrationClaim = { ...(stored as NarrationClaim), result: { rootCauseMd: "x", error: null, requestId: "r", diffText: "d" } };
    await recordNarration(ctx, "h", done);
    expect((await readNarrationClaim(ctx, "h", 1))?.result?.rootCauseMd).toBe("x");
  });
});

describe("live lock", () => {
  it("acquires, then refuses a second hunt, then releases", async () => {
    const ctx = ctxOf(new MemoryKv());
    expect(await readLiveLock(ctx)).toBeNull();
    const never = async () => false;
    expect(await acquireLiveLock(ctx, "a", never)).toEqual({ acquired: true });
    expect(await acquireLiveLock(ctx, "b", never)).toEqual({ acquired: false, holder: "a" });
    await releaseLiveLock(ctx, "b"); // not the holder: no-op
    expect((await readLiveLock(ctx))?.released).toBe(false);
    await releaseLiveLock(ctx, "a");
    expect((await readLiveLock(ctx))?.released).toBe(true);
    await releaseLiveLock(ctx, "a"); // already released: no-op
    expect(await acquireLiveLock(ctx, "b", never)).toEqual({ acquired: true });
    expect((await readLiveLock(ctx))?.huntId).toBe("b");
  });

  it("releaseLiveLock does nothing when there is no lock", async () => {
    const kv = new MemoryKv();
    await releaseLiveLock(ctxOf(kv), "a");
    expect(kv.keys()).toEqual([]);
  });

  it("takes over an expired lock and a finished holder's lock", async () => {
    const kv = new MemoryKv();
    const ctx = ctxOf(kv);
    await kv.put("locks/live-hunt.json", lockDoc({ expiresAt: NOW.toISOString() }));
    const isFinished = vi.fn(async () => false);
    expect(await acquireLiveLock(ctx, "n", isFinished)).toEqual({ acquired: true });
    expect(isFinished).not.toHaveBeenCalled();

    await kv.put("locks/live-hunt.json", lockDoc());
    expect(await acquireLiveLock(ctx, "m", async (h) => h === "other-hunt")).toEqual({ acquired: true });
    expect((await readLiveLock(ctx))?.huntId).toBe("m");
  });

  it("takes over a released lock without asking whether the holder finished", async () => {
    const kv = new MemoryKv();
    await kv.put("locks/live-hunt.json", lockDoc({ released: true }));
    const isFinished = vi.fn(async () => false);
    expect(await acquireLiveLock(ctxOf(kv), "n", isFinished)).toEqual({ acquired: true });
    expect(isFinished).not.toHaveBeenCalled();
  });

  it("retries when the lock vanishes between create and read", async () => {
    const kv = scripted({ get: [null], put: [{ ok: false, status: 412 }, { ok: true, etag: "e" }] });
    expect(await acquireLiveLock(ctxOf(kv), "a", async () => false)).toEqual({ acquired: true });
    expect(kv.puts).toHaveLength(2);
  });

  it("refuses to take over a free lock whose etag is null", async () => {
    const kv = scripted({ get: [{ value: lockDoc({ released: true }), etag: null }], put: [{ ok: false, status: 412 }] });
    expect(await acquireLiveLock(ctxOf(kv), "a", async () => false)).toEqual({ acquired: false, holder: "other-hunt" });
    expect(kv.puts).toHaveLength(1);
  });

  it("gives up after three lost races and names the holder (or unknown)", async () => {
    const lost: ConditionalResult = { ok: false, status: 412 };
    const kv = scripted({ get: [{ value: lockDoc({ released: true }), etag: '"e"' }], put: [lost] });
    expect(await acquireLiveLock(ctxOf(kv), "a", async () => false)).toEqual({ acquired: false, holder: "other-hunt" });
    expect(kv.puts).toHaveLength(6);

    const vanishing = scripted({ get: [null], put: [lost] });
    expect(await acquireLiveLock(ctxOf(vanishing), "a", async () => false)).toEqual({ acquired: false, holder: "unknown" });
    expect(vanishing.puts).toHaveLength(3);
  });

  it("does not release a lock whose etag is null", async () => {
    const kv = scripted({ get: [{ value: lockDoc({ huntId: "a" }), etag: null }] });
    await releaseLiveLock(ctxOf(kv), "a");
    expect(kv.puts).toHaveLength(0);
  });
});

describe("daily counter", () => {
  it("dailyCap honours a valid override and falls back otherwise", () => {
    expect(dailyCap(env({ FAULTLINE_DAILY_CAP: "3" }))).toBe(3);
    expect(dailyCap(env({ FAULTLINE_DAILY_CAP: "0" }))).toBe(DAILY_LIVE_HUNT_CAP);
    expect(dailyCap(env({ FAULTLINE_DAILY_CAP: "2.5" }))).toBe(DAILY_LIVE_HUNT_CAP);
    expect(dailyCap({} as NodeJS.ProcessEnv)).toBe(DAILY_LIVE_HUNT_CAP);
  });

  it("dailyCap defaults to process.env", () => {
    vi.stubEnv("FAULTLINE_DAILY_CAP", "7");
    expect(dailyCap()).toBe(7);
    vi.unstubAllEnvs();
  });

  it("counts per UTC day", async () => {
    const kv = new MemoryKv();
    expect(await readDailyCount(ctxOf(kv))).toEqual({ day: "2026-10-13", count: 0 });
    expect(await incrementDailyCount(ctxOf(kv))).toEqual({ day: "2026-10-13", count: 1 });
    expect(await incrementDailyCount(ctxOf(kv))).toEqual({ day: "2026-10-13", count: 2 });
    expect(await readDailyCount(ctxOf(kv))).toEqual({ day: "2026-10-13", count: 2 });
    expect(await readDailyCount(ctxOf(kv, new Date("2026-10-14T00:00:00Z")))).toEqual({ day: "2026-10-14", count: 0 });
  });

  it("ignores a stored counter for a different day", async () => {
    const kv = scripted({ get: [{ value: JSON.stringify({ day: "2020-01-01", count: 9 }), etag: '"e"' }] });
    expect(await readDailyCount(ctxOf(kv))).toEqual({ day: "2026-10-13", count: 0 });
  });

  it("overwrites unconditionally when the stored etag is null", async () => {
    const kv = scripted({ get: [{ value: JSON.stringify({ day: "2026-10-13", count: 4 }), etag: null }], put: [{ ok: true, etag: null }] });
    expect(await incrementDailyCount(ctxOf(kv))).toEqual({ day: "2026-10-13", count: 5 });
    expect(kv.puts[0]?.condition).toBeUndefined();
  });

  it("retries lost compare-and-swaps then throws after 6 attempts", async () => {
    const lost: ConditionalResult = { ok: false, status: 412 };
    const retry = scripted({ get: [null], put: [lost, lost, { ok: true, etag: "e" }] });
    expect((await incrementDailyCount(ctxOf(retry))).count).toBe(1);
    expect(retry.puts).toHaveLength(3);

    const dead = scripted({ get: [null], put: [lost] });
    await expect(incrementDailyCount(ctxOf(dead))).rejects.toThrow(/6 attempts/);
    expect(dead.puts).toHaveLength(6);
  });
});
