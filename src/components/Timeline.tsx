"use client";

/**
 * The commit timeline — the hero surface.
 *
 * One tick per commit, oldest left. The whole product is the story of ticks changing state,
 * so this component holds exactly three ideas and nothing else:
 *   1. a band dispatches and its ticks scale in UNISON (never staggered),
 *   2. a verdict lands and colour fills from the tick's centre,
 *   3. the eliminated span dims to 20% while the live range keeps full contrast.
 */

import type { Hunt, Probe, ProbeRole } from "@/lib/types";
import {
  isLive,
  probesByIndex,
  shortSha,
  tickColor,
  tickState,
  VERDICT_LABEL,
  type TickState,
} from "./format";

const STATE_TEXT: Record<TickState, string> = {
  unknown: "not probed",
  pending: "probe running",
  innocent: "innocent — test passed",
  guilty: "implicated — test failed",
  error: "skipped — could not be built or run, proves nothing",
};

/**
 * One end of the range, with what its own probe said. The ends are tested in round 1, not
 * assumed, so the label carries the result once it lands.
 */
function Endpoint({ hunt, role, label }: { hunt: Hunt; role: ProbeRole; label: string }) {
  const probe: Probe | undefined = hunt.probes.filter((p) => p.role === role).at(-1);
  const state = tickState(probe);
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className={`inline-block h-2.5 w-2.5 rounded-full ${state === "pending" ? "animate-pulse" : ""}`}
        style={{ background: tickColor(state) }}
      />
      {label}
      <span className="text-unknown">
        {probe?.verdict ? `tested: ${VERDICT_LABEL[probe.verdict]}` : probe ? "testing…" : ""}
      </span>
    </span>
  );
}

export function Timeline({ hunt }: { hunt: Hunt }) {
  const byIndex = probesByIndex(hunt.probes);
  const count = hunt.commits.length;
  const culpritSha = hunt.report?.culpritSha ?? null;

  // Ticks shrink to fit. Past ~120 commits they go to hairlines with a 1px gap so a
  // 256-commit range still reads as one band; past that the container scrolls.
  const tickWidth = count > 160 ? 3 : count > 80 ? 5 : count > 32 ? 9 : 14;
  const gap = count > 120 ? 1 : count > 48 ? 2 : 3;

  const stopped = hunt.status === "inconclusive" || hunt.status === "error";
  const live = hunt.commits.filter((c) => isLive(hunt, c.index)).length;
  const eliminated = count - live;

  return (
    <div>
      <div className="overflow-x-auto pb-1">
        <ol
          className="timeline"
          style={
            {
              "--tick-w": `${tickWidth}px`,
              "--tick-gap": `${gap}px`,
            } as React.CSSProperties
          }
          aria-label={`Commit timeline: ${count} commits, oldest first`}
        >
          {hunt.commits.map((commit) => {
            const probe = byIndex.get(commit.index);
            const state = tickState(probe);
            const liveTick = isLive(hunt, commit.index);
            const isCulprit = culpritSha !== null && commit.sha === culpritSha;
            const dispatching = state === "pending";

            // A commit can be named without ever being probed: narrowing settles the range
            // to one index, and that index is guilty whether or not a probe landed on it.
            const painted = isCulprit ? "guilty" : state;
            const filled = painted === "innocent" || painted === "guilty" || painted === "error";

            return (
              <li
                key={commit.sha}
                className="tick"
                data-live={liveTick ? "true" : "false"}
                data-dispatch={dispatching ? "true" : "false"}
                data-culprit={isCulprit ? "true" : "false"}
                data-probed={filled || dispatching ? "true" : "false"}
                title={`${shortSha(commit.sha)} · ${commit.subject} · ${
                  isCulprit ? "the culprit" : STATE_TEXT[state]
                }`}
              >
                <span className="tick-body">
                  {filled ? (
                    <span
                      className="tick-fill"
                      data-verdict={isCulprit ? "culprit" : painted}
                      style={{ background: isCulprit ? "var(--culprit)" : tickColor(painted) }}
                    />
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 font-mono text-[13px] text-muted">
        <Endpoint hunt={hunt} role="good" label={`${hunt.goodRef} (known good)`} />
        <span className="text-text">
          {culpritSha
            ? `commit ${hunt.highIndex} named`
            : hunt.inconclusive?.range
              ? `culprit is one of commits ${hunt.inconclusive.range.fromIndex}\u2013${hunt.inconclusive.range.toIndex}`
              : stopped
                ? `search stopped · commits ${Math.min(hunt.lowIndex + 1, count)}\u2013${hunt.highIndex} unresolved`
                : `commits ${Math.min(hunt.lowIndex + 1, count)}\u2013${hunt.highIndex} still suspect`}
        </span>
        <Endpoint hunt={hunt} role="bad" label={`${hunt.badRef} (failing)`} />
      </div>

      {/* The same facts, in text, for anyone who cannot see 256 coloured rectangles. */}
      <p className="sr-only" aria-live="polite">
        {live} of {count} commits still under suspicion; {eliminated} eliminated.
        {culpritSha ? ` Culprit: ${shortSha(culpritSha)}.` : ""}
      </p>
    </div>
  );
}

export function TimelineLegend() {
  const items: Array<[TickState, string]> = [
    ["unknown", "unknown"],
    ["innocent", "innocent"],
    ["guilty", "guilty"],
    ["error", "skipped (untestable)"],
  ];
  return (
    <ul className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-muted">
      {items.map(([state, label]) => (
        <li key={state} className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block h-3 w-3 rounded-[3px]"
            style={{ background: tickColor(state) }}
          />
          {label}
        </li>
      ))}
      <li className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="inline-block h-3 w-3 rounded-[3px] bg-unknown"
          style={{ opacity: "var(--op-eliminated)" }}
        />
        eliminated range
      </li>
    </ul>
  );
}
