/**
 * GET /api/examples/recorded — the recorded example hunt.
 *
 * This is the default landing experience and costs nothing to view, so the common judge path
 * spends no compute and survives an exhausted credit balance.
 *
 * It serves a real recorded run — real Nebius job IDs, real timestamps, real verdicts —
 * committed as JSON. If no recording exists yet the route says so plainly rather than
 * synthesising one: a fabricated run presented as a recording would be a lie on the most
 * heavily inspected screen in the product.
 */

import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Hunt } from "@/lib/types";

export const dynamic = "force-dynamic";

const RECORDING_PATH = path.join(process.cwd(), "data", "recorded-hunt.json");

export async function GET() {
  try {
    const raw = await readFile(RECORDING_PATH, "utf8");
    const hunt = JSON.parse(raw) as Hunt;
    return NextResponse.json({ available: true, hunt });
  } catch {
    return NextResponse.json({
      available: false,
      reason:
        "No recorded hunt has been captured yet. A recording is a real run against live Nebius Serverless AI Jobs, so it cannot be produced until the account can dispatch them.",
    });
  }
}
