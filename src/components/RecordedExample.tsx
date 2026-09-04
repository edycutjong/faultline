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

import { useEffect, useState } from "react";
import type { Hunt } from "@/lib/types";
import { HuntView } from "./HuntView";
import { formatDay } from "./format";

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

  return (
    <HuntView
      hunt={state.hunt}
      label={<RecordedRunLabel recordedAt={state.hunt.recordedAt} />}
    />
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
              "Eight probe containers start at once on Nebius Serverless AI Jobs, one per candidate commit.",
            ],
            [
              "2 · Narrow",
              "Eight probes cut the range into nine segments, so a 256-commit range survives at ~28 after one round.",
            ],
            [
              "3 · Explain",
              "One commit is named, and a single paragraph from OpenCodeReasoning-Nemotron-14B says why it breaks.",
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
            className="rounded-lg px-4 py-2.5 text-[14px] font-medium"
            style={{ background: "var(--accent)", color: "var(--on-accent)" }}
          >
            Run a live hunt instead
          </a>
          <a
            href="/api/integrations/verify"
            className="rounded-lg border border-line px-4 py-2.5 text-[14px] text-text hover:border-muted"
          >
            Inspect the Nebius integration
          </a>
        </div>
      </div>
    </section>
  );
}
