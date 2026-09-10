/**
 * POST /api/hunts — create a hunt and dispatch the first band.
 *
 * The range is resolved here, before anything is spent, so a bad ref or a private repo
 * costs zero jobs.
 */

import { NextResponse } from "next/server";
import { parseRepoUrl, resolveRange, validateTestCommand, GitRangeError } from "@/lib/git";
import { newHunt, dispatchBand } from "@/lib/hunt";
import { DEFAULT_BAND_SIZE, planBand } from "@/lib/planner";
import {
  DAILY_LIVE_HUNT_CAP,
  incrementDailyCount,
  readDailyCount,
  storeContext,
  writeHunt,
} from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const { repoUrl, testCommand, goodRef, badRef, bandSize } = (body ?? {}) as Record<string, unknown>;
  if (typeof repoUrl !== "string" || typeof testCommand !== "string" || typeof goodRef !== "string") {
    return NextResponse.json(
      { error: "repoUrl, testCommand and goodRef are required." },
      { status: 400 },
    );
  }

  const ctx = storeContext();

  // The cap is visible in the UI on purpose. A demo that quietly burns its credit balance
  // is a dead link by the time judges arrive.
  const counter = await readDailyCount(ctx).catch(() => ({ day: "", count: 0 }));
  if (counter.count >= DAILY_LIVE_HUNT_CAP) {
    return NextResponse.json(
      {
        error: `The daily limit of ${DAILY_LIVE_HUNT_CAP} live hunts has been reached. The recorded example hunt is always available and costs nothing to view.`,
        capReached: true,
      },
      { status: 429 },
    );
  }

  try {
    const ref = parseRepoUrl(repoUrl);
    const command = validateTestCommand(testCommand);
    const head = typeof badRef === "string" && badRef.trim() ? badRef.trim() : "HEAD";
    // The eu-north1 default quota is 12 concurrent non-GPU VMs, so a band above that would
    // queue rather than fan out and the measurement would silently stop meaning what it says.
    let band_n = DEFAULT_BAND_SIZE;
    if (bandSize !== undefined) {
      if (typeof bandSize !== "number" || !Number.isInteger(bandSize) || bandSize < 1 || bandSize > 12) {
        return NextResponse.json(
          { error: "bandSize must be an integer between 1 and 12 (the eu-north1 concurrent-VM quota)." },
          { status: 400 },
        );
      }
      band_n = bandSize;
    }
    const commits = await resolveRange(ref, goodRef.trim(), head);

    if (commits.length === 0) {
      return NextResponse.json(
        { error: "There are no commits between those two refs." },
        { status: 400 },
      );
    }

    const hunt = newHunt({
      repoUrl: `https://github.com/${ref.owner}/${ref.repo}`,
      testCommand: command,
      goodRef: goodRef.trim(),
      badRef: head,
      commits,
      bandSize: band_n,
    });
    await writeHunt(ctx, hunt);

    const band = planBand(hunt.lowIndex, hunt.highIndex, band_n);
    const dispatched = await dispatchBand(ctx, hunt, band);
    await incrementDailyCount(ctx).catch(() => undefined);

    return NextResponse.json({ hunt: dispatched }, { status: 201 });
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

/** GET /api/hunts — the live-hunt budget, for the visible counter on the landing page. */
export async function GET() {
  const ctx = storeContext();
  const counter = await readDailyCount(ctx).catch(() => ({ day: "", count: 0 }));
  return NextResponse.json({
    liveHuntsToday: counter.count,
    dailyCap: DAILY_LIVE_HUNT_CAP,
    nebiusConfigured: ctx.config !== null,
  });
}
