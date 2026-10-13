/**
 * G5 — does Nebius Object Storage honour conditional writes under a real race?
 *
 * The whole control loop rests on this: a dispatch claim is a PUT with `If-None-Match: "*"`,
 * and a hunt record is replaced with `If-Match: <etag>`. If two concurrent creates could
 * both succeed, two reconcile ticks could both dispatch the same probe. So this fires
 * concurrent creates at one fresh key, many times over, and requires exactly one winner
 * every time — then checks that a stale ETag is refused and a fresh one accepted.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "@/lib/nebius/config";
import { getObjectVersioned, putObjectConditional } from "@/lib/nebius/storage";

const TRIALS = 20;
const WRITERS = [2, 2, 2, 2, 2, 5, 5, 5, 8, 8];

describe("G5: conditional writes on the real bucket", () => {
  it("lets exactly one concurrent If-None-Match create win, and enforces If-Match", async () => {
    const result = loadConfig();
    if (!result.configured) throw new Error(`not configured: ${result.missing.join(", ")}`);
    const config = result.config;
    const run = randomUUID();

    const trials: Array<{ key: string; writers: number; winners: number; statuses: string[]; winnerBody: string | null }> = [];
    for (let t = 0; t < TRIALS; t += 1) {
      const writers = WRITERS[t % WRITERS.length] ?? 2;
      const key = `g5/${run}/claim-${t}.json`;
      const outcomes = await Promise.all(
        Array.from({ length: writers }, (_, w) =>
          putObjectConditional(config, key, JSON.stringify({ writer: w }), { ifNoneMatch: "*" }),
        ),
      );
      const stored = await getObjectVersioned(config, key);
      const winners = outcomes.filter((o) => o.ok).length;
      trials.push({
        key,
        writers,
        winners,
        statuses: outcomes.map((o) => (o.ok ? "2xx" : String(o.status))),
        winnerBody: stored?.value ?? null,
      });
    }

    // Compare-and-swap on one record: fresh ETag replaces, stale ETag is refused.
    const casKey = `g5/${run}/record.json`;
    const created = await putObjectConditional(config, casKey, '{"v":1}', { ifNoneMatch: "*" });
    const v1 = await getObjectVersioned(config, casKey);
    const replace = await putObjectConditional(config, casKey, '{"v":2}', { ifMatch: v1?.etag ?? "" });
    const stale = await putObjectConditional(config, casKey, '{"v":3}', { ifMatch: v1?.etag ?? "" });
    const final = await getObjectVersioned(config, casKey);

    const evidence = {
      check: "G5 conditional writes",
      bucket: config.bucket,
      region: config.region,
      endpoint: config.s3Endpoint,
      ranAt: new Date().toISOString(),
      runId: run,
      createRace: {
        trials: trials.length,
        trialsWithExactlyOneWinner: trials.filter((t) => t.winners === 1).length,
        detail: trials,
      },
      compareAndSwap: {
        createdOk: created.ok,
        createEtagReturned: created.ok ? created.etag !== null : null,
        readEtag: v1?.etag ?? null,
        replaceWithFreshEtag: replace.ok ? "2xx" : String(replace.status),
        replaceWithStaleEtag: stale.ok ? "2xx" : String(stale.status),
        finalBody: final?.value ?? null,
      },
    };
    writeFileSync(path.join(__dirname, "..", "..", "evidence", "g5-conditional-writes.json"), `${JSON.stringify(evidence, null, 2)}\n`);

    for (const trial of trials) expect(trial.winners, trial.key).toBe(1);
    expect(created.ok).toBe(true);
    expect(replace.ok).toBe(true);
    expect(stale.ok).toBe(false);
    expect(final?.value).toBe('{"v":2}');
  });
});
