"use client";

/**
 * The paused screen.
 *
 * A hunt pauses when one probe failed to report on every attempt — a VM that never started,
 * a quota rejection, a job that died before it could speak. That is the infrastructure, not
 * the code, so nothing is concluded from it: no commit is narrowed on and no commit is
 * blamed. The user is told which probe, why, and offered one button.
 */

import { useState } from "react";
import type { Hunt } from "@/lib/types";
import { shortSha } from "./format";

export function PausedView({ hunt, onResume }: { hunt: Hunt; onResume?: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pause = hunt.pause;
  if (!pause) return null;

  async function resume() {
    if (!onResume) return;
    setBusy(true);
    setError(null);
    try {
      await onResume();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not resume the hunt.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="paused"
      className="rounded-card border bg-surface px-6 py-6"
      style={{ borderColor: "color-mix(in srgb, var(--inconclusive) 45%, transparent)" }}
    >
      <p className="text-[12px] uppercase tracking-[0.14em] text-muted">Paused — infrastructure, not evidence</p>
      <h2 id="paused" className="mt-2 text-[24px] font-semibold tracking-tight" style={{ color: "var(--inconclusive)" }}>
        The probe for {shortSha(pause.commitSha)} never reported.
      </h2>
      <p className="mt-3 max-w-[68ch] text-[15px] leading-relaxed text-text">{pause.message}</p>
      <p className="mt-3 max-w-[68ch] text-[14px] text-muted">
        Everything already learned is kept. Resuming retries only this probe, with a fresh budget
        of attempts.
      </p>
      {onResume ? (
        <div className="mt-5 flex flex-wrap items-center gap-4">
          <button
            type="button"
            onClick={resume}
            disabled={busy}
            className="rounded-lg px-5 py-2.5 text-[15px] font-medium transition-opacity duration-150 disabled:cursor-not-allowed disabled:opacity-40 cta-accent"
          >
            {busy ? "Resuming…" : "Resume hunt"}
          </button>
          {error ? (
            <p role="alert" className="text-[14px]" style={{ color: "var(--guilty)" }}>
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
