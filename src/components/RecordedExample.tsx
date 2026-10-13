"use client";

/**
 * The recorded example hunt, above the fold on the landing page.
 *
 * Two rules govern this component.
 *
 * 1. A replay is never presented as live. It carries a "recorded run, <date>" label wherever
 *    it appears.
 * 2. When no recording exists, this says so in the recording's own words and shows nothing
 *    else. A synthesised hunt dropped in to fill the space would be a fabricated run on the
 *    most heavily inspected screen in the product, so the empty state is the honest state and
 *    is designed to look deliberate rather than broken.
 */

import { useEffect, useMemo, useState } from "react";
import type { Hunt } from "@/lib/types";
import { formatElapsed, replayFrames } from "@/lib/replay";
import { HuntView } from "./HuntView";
import { formatDay } from "./format";

const FRAME_MS = 1600;

type RecordedResponse =
  | { available: true; hunt: Hunt }
  | { available: false; reason: string };

type State =
  | { phase: "loading" }
  | { phase: "ready"; hunt: Hunt }
  | { phase: "absent"; reason: string };

export function RecordedRunLabel({ recordedAt }: { recordedAt: string | null }) {
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-[12px]"
      style={{
        borderColor: "color-mix(in srgb, var(--accent) 55%, transparent)",
        color: "var(--text)",
        background: "color-mix(in srgb, var(--accent) 12%, transparent)",
      }}
    >
      <span
        aria-hidden="true"
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: "var(--accent)" }}
      />
      recorded run, {formatDay(recordedAt)}
    </span>
  );
}

export function RecordedExample() {
  const [state, setState] = useState<State>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/examples/recorded")
      .then((r) => r.json() as Promise<RecordedResponse>)
      .then((payload) => {
        if (cancelled) return;
        setState(
          payload.available
            ? { phase: "ready", hunt: payload.hunt }
            : { phase: "absent", reason: payload.reason },
        );
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setState({
          phase: "absent",
          reason:
            cause instanceof Error
              ? `The recorded run could not be loaded: ${cause.message}`
              : "The recorded run could not be loaded.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.phase === "loading") {
    return (
      <div
        className="rounded-card border border-line bg-surface px-6 py-10"
        aria-busy="true"
        aria-live="polite"
      >
        <p className="text-[14px] text-muted">Loading the recorded run…</p>
      </div>
    );
  }

  if (state.phase === "absent") {
    return <NoRecording reason={state.reason} />;
  }

  return <RecordedReplay hunt={state.hunt} />;
}

/**
 * The recording, final state first, with a round-by-round replay. Every frame is a moment the
 * recording really contains, labelled with the real time it happened — a replay compresses
 * minutes of cold start into seconds, so it says so on screen rather than implying speed.
 */
function RecordedReplay({ hunt }: { hunt: Hunt }) {
  const frames = useMemo(() => replayFrames(hunt), [hunt]);
  const [frame, setFrame] = useState<number | null>(null);

  useEffect(() => {
    if (frame === null) return;
    if (frame >= frames.length - 1) {
      const done = setTimeout(() => setFrame(null), FRAME_MS * 2);
      return () => clearTimeout(done);
    }
    const next = setTimeout(() => setFrame(frame + 1), FRAME_MS);
    return () => clearTimeout(next);
  }, [frame, frames.length]);

  const current = frame === null ? null : frames[frame];
  const shown = current?.hunt ?? hunt;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {frame === null ? (
          <button
            type="button"
            onClick={() => setFrame(0)}
            className="btn-quiet rounded-lg border border-line px-4 py-2 text-[14px] text-text"
          >
            ▶ Replay it round by round
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setFrame(null)}
            className="btn-quiet rounded-lg border border-line px-4 py-2 text-[14px] text-text"
          >
            Skip to the result
          </button>
        )}
        <p className="font-mono text-[13px] text-muted" aria-live="polite">
          {current
            ? `replay · ${current.caption}${current.elapsedMs !== null ? ` · real time ${formatElapsed(current.elapsedMs)}` : ""}`
            : `${hunt.round} rounds · ${hunt.probes.length} probes · real time ${formatElapsed(hunt.wallClockMs)} to the culprit`}
        </p>
      </div>
      <HuntView hunt={shown} label={<RecordedRunLabel recordedAt={hunt.recordedAt} />} />
    </div>
  );
}

/**
 * The honest empty state. Deliberate, not broken: it names what is missing, quotes the
 * route's own reason, and points at the two things that *are* available.
 */
function NoRecording({ reason }: { reason: string }) {
  return (
    <section
      aria-labelledby="no-recording"
      className="rounded-card border border-line bg-surface"
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-4">
        <span
          aria-hidden="true"
          className="inline-block h-3 w-3 rounded-[3px] bg-unknown"
        />
        <p className="text-[12px] uppercase tracking-[0.14em] text-muted">
          Recorded run — not captured yet
        </p>
      </header>

      <div className="px-6 py-8">
        <h2
          id="no-recording"
          className="max-w-[40ch] text-[24px] font-semibold leading-tight tracking-tight"
        >
          There is no recorded hunt to replay yet.
        </h2>
        <p className="mt-4 max-w-[68ch] text-[16px] leading-relaxed text-muted">{reason}</p>
        <p className="mt-4 max-w-[68ch] text-[15px] leading-relaxed text-muted">
          The alternative would be to synthesise one. Faultline will not: a fabricated run
          shown where a recording is promised is the exact failure this product exists to
          refuse. This space stays empty until a real run fills it.
        </p>

        {/* The recorded run is missing; the mechanism is not. Say what happens instead. */}
        <ol className="mt-8 grid gap-4 sm:grid-cols-3">
          {[
            [
              "1 · Dispatch",
              "Round 1 tests the known-good ref, the failing ref and a band of suspects, each in a fresh Nebius Serverless AI Job.",
            ],
            [
              "2 · Narrow",
              "N probes cut the range into N+1 segments, and the next round goes out by itself as verdicts land.",
            ],
            [
              "3 · Explain",
              "One commit is named, and NVIDIA Nemotron 3 Super on Nebius Token Factory writes one paragraph on why it breaks.",
            ],
          ].map(([title, body]) => (
            <li key={title} className="rounded-lg border border-line bg-bg px-4 py-4">
              <p className="font-mono text-[12px] text-muted">{title}</p>
              <p className="mt-2 text-[14px] leading-relaxed text-text">{body}</p>
            </li>
          ))}
        </ol>

        <div className="mt-8 flex flex-wrap gap-4">
          <a
            href="#start"
            className="rounded-lg px-4 py-2.5 text-[14px] font-medium cta-accent"
          >
            Run a live hunt instead
          </a>
          <a
            href="/api/integrations/verify"
            className="btn-quiet rounded-lg border border-line px-4 py-2.5 text-[14px] text-text"
          >
            Inspect the Nebius integration
          </a>
        </div>
      </div>
    </section>
  );
}
