"use client";

/**
 * A hunt in progress — the hero screen.
 *
 * The view is a 2-second poll of `GET /api/hunts/{id}`, not SSE. Each poll that is due runs
 * one reconcile tick, but the hunt does not depend on it: every probe ticks the hunt itself
 * when its verdict is stored, so closing this tab does not stop the search. The poll stops
 * when the hunt stops (finished, refused or paused), and a resume starts it again.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Hunt } from "@/lib/types";
import { HuntView } from "@/components/HuntView";
import { isActive } from "@/components/format";

const POLL_MS = 2000;

interface HuntResponse {
  hunt?: Hunt;
  warning?: string;
  error?: string;
}

export default function HuntPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === "string" ? params.id : "";

  const [hunt, setHunt] = useState<Hunt | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const stopped = useRef(false);

  async function resume() {
    const response = await fetch(`/api/hunts/${id}/resume`, { method: "POST" });
    const payload = (await response.json()) as HuntResponse;
    if (!response.ok || !payload.hunt) throw new Error(payload.error ?? "Could not resume the hunt.");
    setHunt(payload.hunt);
    setGeneration((g) => g + 1); // restart polling
  }

  useEffect(() => {
    if (!id) return;
    stopped.current = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        const response = await fetch(`/api/hunts/${id}`, { cache: "no-store" });
        const payload = (await response.json()) as HuntResponse;

        if (stopped.current) return;

        if (!response.ok || !payload.hunt) {
          setError(payload.error ?? "That hunt could not be loaded.");
          return; // no reschedule: a 404 does not become a 200 by asking again
        }

        setHunt(payload.hunt);
        setWarning(payload.warning ?? null);
        setError(null);

        // Terminal states are final. Stop polling rather than spinning on a dead hunt.
        if (!isActive(payload.hunt.status)) return;
      } catch (cause) {
        if (stopped.current) return;
        // A dropped tick is not a dead hunt; keep the last known state and retry.
        setWarning(
          cause instanceof Error ? `Reconcile tick failed: ${cause.message}` : "Reconcile tick failed.",
        );
      }
      if (!stopped.current) timer = setTimeout(tick, POLL_MS);
    }

    void tick();

    return () => {
      stopped.current = true;
      if (timer) clearTimeout(timer);
    };
  }, [id, generation]);

  return (
    <div className="mx-auto max-w-6xl px-5 py-10">
      <nav aria-label="Breadcrumb" className="mb-6 text-[13px] text-muted">
        <Link href="/" className="hover:text-text">
          Faultline
        </Link>
        <span aria-hidden="true" className="px-2">
          /
        </span>
        <span className="font-mono">hunt {id.slice(0, 8) || "—"}</span>
      </nav>

      {error ? (
        <section
          aria-labelledby="hunt-error"
          className="rounded-card border border-line bg-surface px-6 py-10"
        >
          <h1 id="hunt-error" className="text-[24px] font-semibold tracking-tight">
            That hunt is not here.
          </h1>
          <p className="mt-3 max-w-[68ch] text-[15px] leading-relaxed text-muted">{error}</p>
          <p className="mt-3 max-w-[68ch] text-[15px] leading-relaxed text-muted">
            Hunts live in Nebius Object Storage. Without Nebius credentials they are held in
            process memory instead, and a server restart ends them — a hunt that outlives the
            jobs backing it would be worth nothing anyway.
          </p>
          <Link
            href="/"
            className="mt-8 inline-block rounded-lg px-4 py-2.5 text-[14px] font-medium"
            style={{ background: "var(--accent)", color: "var(--on-accent)" }}
          >
            Start a new hunt
          </Link>
        </section>
      ) : hunt === null ? (
        <section
          className="rounded-card border border-line bg-surface px-6 py-10"
          aria-busy="true"
          aria-live="polite"
        >
          <h1 className="text-[20px] font-semibold tracking-tight">Resolving the range…</h1>
          <p className="mt-2 text-[14px] text-muted">
            The commit range is resolved before anything is dispatched, so a bad ref costs
            zero jobs.
          </p>
        </section>
      ) : (
        <>
          <header className="mb-8">
            <h1 className="text-[30px] font-semibold tracking-tight md:text-[36px]">
              {hunt.status === "done"
                ? "One commit explains every verdict."
                : hunt.status === "inconclusive"
                  ? "Faultline will not name a single culprit."
                  : hunt.status === "error"
                    ? "The hunt stopped early."
                    : hunt.status === "paused"
                      ? "Paused: a probe never reported."
                      : hunt.status === "narrating"
                        ? "Culprit named. Explaining it now."
                        : "Eliminating suspects."}
            </h1>
            <p className="mt-2 max-w-[70ch] text-[15px] leading-relaxed text-muted">
              {hunt.status === "narrating"
                ? "The search is over — the commit below is final. NVIDIA Nemotron on Nebius Token Factory is writing one explanatory paragraph from its diff."
                : hunt.status === "paused"
                  ? "Nothing was concluded from the missing probe. Everything already learned is kept."
                  : isActive(hunt.status)
                    ? "Each round goes out together, one fresh container per commit. Probes report as they finish and the next round is dispatched automatically — you can close this tab."
                    : "The search is finished. Every probe below ran as a real Nebius Serverless AI Job."}
            </p>
          </header>

          {warning ? (
            <p
              role="status"
              className="mb-6 rounded-lg border px-4 py-3 text-[14px]"
              style={{
                borderColor: "color-mix(in srgb, var(--inconclusive) 40%, transparent)",
                background: "color-mix(in srgb, var(--inconclusive) 7%, transparent)",
              }}
            >
              {warning} The last known state is shown; the next tick will retry.
            </p>
          ) : null}

          <HuntView hunt={hunt} onResume={resume} />
        </>
      )}
    </div>
  );
}
