/**
 * GET /api/resolve?repoUrl=&goodRef=&badRef= — what a hunt would cost, before it runs.
 *
 * Resolves the commit range and suggests the install command from the repository's own
 * declarations at the failing ref. The form shows both before the button is pressed: the
 * user learns how many commits are in play, and edits the install command if the guess is
 * wrong — which is the commonest way for every probe of a hunt to be a skip.
 */

import { NextResponse } from "next/server";
import { parseRepoUrl, resolveHuntRange, suggestInstallCommand, GitRangeError } from "@/lib/git";
import { expectedRounds, newHunt } from "@/lib/hunt";
import { DEFAULT_BAND_SIZE } from "@/lib/planner";
import { storeContext } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const repoUrl = params.get("repoUrl") ?? "";
  const goodRef = (params.get("goodRef") ?? "").trim();
  const badRef = (params.get("badRef") ?? "").trim() || "HEAD";
  if (!repoUrl || !goodRef) {
    return NextResponse.json({ error: "repoUrl and goodRef are required." }, { status: 400 });
  }

  const ctx = storeContext();
  try {
    const ref = parseRepoUrl(repoUrl);
    const range = await resolveHuntRange(ref, goodRef, badRef, ctx.fetchImpl);
    const badSha = range.badSha;
    const install = await suggestInstallCommand(ref, badSha, ctx.fetchImpl).catch(() => null);
    const slots = ctx.backend?.capacity() ?? 0;
    const rounds = slots > 0
      ? expectedRounds(
          newHunt({
            repoUrl, testCommand: "", goodRef, goodSha: range.goodSha, badRef, commits: range.commits,
            bandSize: DEFAULT_BAND_SIZE, slots, backend: "", regions: [],
          }),
        )
      : null;

    return NextResponse.json({
      commits: range.commits.length,
      goodSha: range.goodSha,
      badSha,
      installCommand: install?.command ?? "",
      installReason: install?.reason ?? "could not read the repository's packaging files",
      slots,
      expectedRounds: rounds,
    });
  } catch (error) {
    if (error instanceof GitRangeError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not resolve." }, { status: 500 });
  }
}
