/**
 * POST /api/hunts — create a hunt and dispatch round 1.
 *
 * The range is resolved here, before anything is spent, so a bad ref or a private repo
 * costs zero jobs. One live hunt at a time: the backend's slots are shared, and a second
 * hunt would only starve the first into quota rejections.
 */

import { NextResponse } from "next/server";
import {
  parseRepoUrl,
  resolveHuntRange,
  validateInstallCommand,
  validateTestCommand,
  GitRangeError,
} from "@/lib/git";
import { newHunt, startHunt, tick } from "@/lib/hunt";
import { DEFAULT_BAND_SIZE } from "@/lib/planner";
import { dailyCap, readDailyCount, readHunt, readLiveLock, storeContext } from "@/lib/store";
import { bypassCodeMatches, publicBaseUrl, tickDue } from "@/lib/runtime";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const { repoUrl, testCommand, installCommand, goodRef, badRef, bandSize, accessCode } = (body ?? {}) as Record<string, unknown>;
  if (typeof repoUrl !== "string" || typeof testCommand !== "string" || typeof goodRef !== "string") {
    return NextResponse.json(
      { error: "repoUrl, testCommand and goodRef are required." },
      { status: 400 },
    );
  }

  const ctx = storeContext();
  if (!ctx.backend) {
    return NextResponse.json(
      {
        error:
          "Live hunts need Nebius credentials, and none are configured on this deployment. The recorded example hunt works without them.",
      },
      { status: 503 },
    );
  }

  // The cap is visible in the UI on purpose. A demo that quietly burns its credit balance
  // is a dead link by the time judges arrive. A judge code lifts it; nothing lifts the lock.
  const cap = dailyCap();
  const bypass = bypassCodeMatches(accessCode);
  if (!bypass) {
    const counter = await readDailyCount(ctx).catch(() => ({ day: "", count: 0 }));
    if (counter.count >= cap) {
      return NextResponse.json(
        {
          error: `Today's ${cap} live hunts have been used. The recorded example hunt is always available and costs nothing to view.`,
          capReached: true,
        },
        { status: 429 },
      );
    }
  }

  try {
    const ref = parseRepoUrl(repoUrl);
    const command = validateTestCommand(testCommand);
    const install = validateInstallCommand(typeof installCommand === "string" ? installCommand : "");
    const head = typeof badRef === "string" && badRef.trim() ? badRef.trim() : "HEAD";

    let band = DEFAULT_BAND_SIZE;
    if (bandSize !== undefined) {
      if (typeof bandSize !== "number" || !Number.isInteger(bandSize) || bandSize < 1 || bandSize > DEFAULT_BAND_SIZE) {
        return NextResponse.json(
          { error: `bandSize must be an integer between 1 and ${DEFAULT_BAND_SIZE}.` },
          { status: 400 },
        );
      }
      band = bandSize;
    }

    const range = await resolveHuntRange(ref, goodRef.trim(), head, ctx.fetchImpl);
    if (range.commits.length === 0) {
      return NextResponse.json({ error: "There are no commits between those two refs." }, { status: 400 });
    }

    const hunt = newHunt({
      repoUrl: `https://github.com/${ref.owner}/${ref.repo}`,
      testCommand: command,
      installCommand: install,
      goodRef: goodRef.trim(),
      goodSha: range.goodSha,
      badRef: head,
      commits: range.commits,
      bandSize: band,
      slots: ctx.backend.capacity(),
      backend: ctx.backend.id,
      regions: [...ctx.backend.regions],
      tickBaseUrl: publicBaseUrl(request),
      now: ctx.now(),
    });

    const started = await startHunt(ctx, hunt);
    if (!started.ok) {
      return NextResponse.json(
        { error: started.error, ...(started.holder ? { liveHuntId: started.holder } : {}) },
        { status: started.status },
      );
    }
    return NextResponse.json({ hunt: started.hunt }, { status: 201 });
  } catch (error) {
    if (error instanceof GitRangeError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not start the hunt." },
      { status: 500 },
    );
  }
}

/**
 * GET /api/hunts — the live-hunt budget and the hunt currently holding the slots, for the
 * landing page. It also nudges that hunt forward: every visit is a free reconcile tick, so a
 * hunt whose last probe tick was lost still finishes when anyone looks.
 */
export async function GET() {
  const ctx = storeContext();
  const counter = await readDailyCount(ctx).catch(() => ({ day: "", count: 0 }));
  const lock = ctx.config ? await readLiveLock(ctx).catch(() => null) : null;
  let liveHuntId: string | null = null;
  if (lock && !lock.released && new Date(lock.expiresAt).getTime() > Date.now()) {
    const hunt = await (tickDue(lock.huntId) ? tick(ctx, lock.huntId) : readHunt(ctx, lock.huntId)).catch(() => null);
    if (hunt && (hunt.status === "running" || hunt.status === "planning")) liveHuntId = hunt.id;
  }

  return NextResponse.json({
    liveHuntsToday: counter.count,
    dailyCap: dailyCap(),
    nebiusConfigured: ctx.config !== null,
    slots: ctx.backend?.capacity() ?? 0,
    liveHuntId,
  });
}
