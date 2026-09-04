"use client";

/**
 * The inconclusive screen.
 *
 * Amber, not red. This is a refusal, not a failure: the verdicts collected contradict each
 * other, so no single commit explains them, and naming one anyway would be a guess dressed
 * as an answer. Both strings on screen come from the hunt record — this component never
 * writes an explanation of its own.
 */

import type { Hunt, Inconclusive } from "@/lib/types";
import { shortSha } from "./format";
import { ProbeList } from "./ProbeList";

const REASON_LABEL: Record<Inconclusive["reason"], string> = {
  contradiction: "contradictory verdicts",
  all_fail: "every probe failed",
  all_pass: "every probe passed",
  probe_errors: "too many probe errors",
};

export function InconclusiveView({ hunt }: { hunt: Hunt }) {
  const state = hunt.inconclusive;
  if (!state) return null;

  return (
    <section
      aria-labelledby="inconclusive"
      className="rounded-card border bg-surface"
      style={{ borderColor: "color-mix(in srgb, var(--inconclusive) 45%, transparent)" }}
    >
      <header
        className="flex flex-wrap items-center gap-3 border-b px-6 py-4"
        style={{
          borderColor: "color-mix(in srgb, var(--inconclusive) 30%, transparent)",
          background: "color-mix(in srgb, var(--inconclusive) 8%, transparent)",
        }}
      >
        <span
          aria-hidden="true"
          className="inline-block h-3 w-3 rounded-[3px]"
          style={{ background: "var(--inconclusive)" }}
        />
        <p className="text-[12px] uppercase tracking-[0.14em] text-muted">
          Inconclusive — {REASON_LABEL[state.reason]}
        </p>
      </header>

      <div className="px-6 py-6">
        <h2
          id="inconclusive"
          className="max-w-[24ch] text-[26px] font-semibold leading-tight tracking-tight"
          style={{ color: "var(--inconclusive)" }}
        >
          {state.headline}
        </h2>
        <p className="mt-4 max-w-[68ch] text-[16px] leading-relaxed text-text">
          {state.explanation}
        </p>

        {state.evidence ? (
          <div className="mt-6 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-bg px-4 py-3 font-mono text-[14px]">
            <span style={{ color: "var(--innocent)" }}>
              {shortSha(state.evidence.passSha)} passed
            </span>
            <span aria-hidden="true" className="text-unknown">
              ·
            </span>
            <span style={{ color: "var(--guilty)" }}>
              {shortSha(state.evidence.failSha)} failed
            </span>
            <span className="text-muted">— and the pass is the newer commit.</span>
          </div>
        ) : null}

        <p className="mt-6 max-w-[68ch] text-[14px] text-muted">
          Faultline stopped here on purpose and cancelled the probes still in flight. No commit
          is named, and nothing further was billed.
        </p>
      </div>

      <div className="border-t border-line px-6 py-5">
        <details open>
          <summary className="flex items-center gap-2 text-[15px] font-semibold text-text">
            <span aria-hidden="true" className="text-muted">
              ▸
            </span>
            Evidence — {hunt.probes.length} probes
          </summary>
          <div className="mt-4">
            <ProbeList hunt={hunt} caption="Every probe in this hunt" />
          </div>
        </details>
      </div>
    </section>
  );
}
