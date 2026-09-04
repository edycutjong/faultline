/**
 * GET /api/hunts/{id}/report — the Fault Report as JSON, or as Markdown for `?format=md`.
 *
 * The Markdown form is what the "Copy as GitHub issue" button produces, rendered server-side
 * so the issue text a maintainer pastes is identical to the one this endpoint serves.
 */

import { NextResponse } from "next/server";
import { readHunt, storeContext } from "@/lib/store";
import { renderIssue } from "@/lib/issue";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ctx = storeContext();
  const hunt = await readHunt(ctx, id);

  if (!hunt) return NextResponse.json({ error: "No such hunt." }, { status: 404 });
  if (!hunt.report) {
    return NextResponse.json(
      { error: "This hunt has not identified a culprit.", status: hunt.status },
      { status: 409 },
    );
  }

  const format = new URL(request.url).searchParams.get("format");
  if (format === "md") {
    return new NextResponse(renderIssue(hunt), {
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  }

  return NextResponse.json({ report: hunt.report, probes: hunt.probes, status: hunt.status });
}
