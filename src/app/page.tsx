"use client";

/**
 * Home — the landing page and the app are ONE page.
 *
 * The hero states the mechanism, not the category. Above the fold sits the recorded example
 * hunt, always labelled as a replay. Below it, three fields and a visible daily counter, so
 * the cost of the demo is on screen rather than hidden in a credit balance.
 */

import { useEffect, useState } from "react";
import { NewHuntForm, type HuntBudget } from "@/components/NewHuntForm";
import { RecordedExample } from "@/components/RecordedExample";
import { IntegrationProof } from "@/components/IntegrationProof";

export default function HomePage() {
  const [budget, setBudget] = useState<HuntBudget | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/hunts")
      .then((r) => r.json() as Promise<HuntBudget>)
      .then((payload) => {
        if (!cancelled) setBudget(payload);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto max-w-6xl px-5">
      {/* ---------------------------------------------------------------- hero */}
      <section className="pt-16 pb-12 md:pt-24 md:pb-16">
        <h1 className="max-w-[18ch] text-[42px] font-semibold leading-[1.05] tracking-[-0.02em] md:text-[64px]">
          Find the commit that broke it — in a clean room.
        </h1>
        <p className="mt-6 max-w-[64ch] text-[18px] leading-relaxed text-muted md:text-[20px]">
          An unattended <code className="font-mono text-[0.9em] text-text">git bisect run</code> in
          one reused environment can blame the wrong commit when dependencies drift across the
          range. Faultline tests every suspect in a fresh Nebius container built from that
          commit&rsquo;s own dependencies, proves both ends first, refuses to guess when the
          verdicts disagree — and has NVIDIA Nemotron explain the culprit.
        </p>

        <div className="mt-9 flex flex-wrap items-center gap-4">
          <a
            href="#start"
            className="rounded-lg px-5 py-3 text-[15px] font-medium cta-accent"
          >
            Run a live hunt
          </a>
          <a
            href="#recorded"
            className="btn-quiet rounded-lg border border-line px-5 py-3 text-[15px] text-text"
          >
            Watch the recorded run
          </a>
          <LiveCounter budget={budget} />
        </div>

        {/* The three properties, stated plainly. */}
        <dl className="mt-14 grid gap-6 border-t border-line pt-8 sm:grid-cols-3">
          <Fact
            term="Each commit, its own environment"
            detail={`One terminating Nebius Serverless AI Job per probe, installing that commit's own declared dependencies.${
              budget?.slots ? ` A round runs up to ${budget.slots} of them in parallel.` : ""
            }`}
          />
          <Fact
            term="Both ends tested, not assumed"
            detail="Round 1 runs your known-good ref and your failing ref in clean containers. If the failing ref passes there, the bug is in your environment — and Faultline says so."
          />
          <Fact
            term="Or no answer at all"
            detail="If the verdicts contradict each other, no single commit explains them and Faultline refuses to name one. Commits that will not build are skipped, never blamed."
          />
        </dl>
      </section>

      {/* ------------------------------------------------------------ recorded */}
      <section id="recorded" className="scroll-mt-16 pb-16">
        <SectionHeading
          eyebrow="The product, running"
          title="A real hunt, replayed"
          blurb="Real Nebius job IDs, real timestamps, real verdicts. It costs nothing to view and it is never presented as live."
        />
        <RecordedExample />
      </section>

      {/* ---------------------------------------------------------------- form */}
      <section id="start" className="scroll-mt-16 pb-16">
        <SectionHeading
          eyebrow="Start a hunt"
          title="Three fields. No YAML."
          blurb="Point Faultline at a public repository, a failing test, and the last ref where it passed. It resolves the install command from the repository — check it, edit it, start."
        />
        <div className="rounded-card border border-line bg-surface px-6 py-8">
          <NewHuntForm budget={budget} />
        </div>
      </section>

      {/* ----------------------------------------------------------- integration */}
      <section className="pb-8">
        <SectionHeading
          eyebrow="Sponsor integration"
          title="Nebius is the engine, not a badge"
          blurb="Every probe is a container on Nebius Serverless AI Jobs; every verdict comes back through a presigned Object Storage URL, so no credential ever enters a probe; every explanation is one Token Factory call to NVIDIA Nemotron."
        />
        <IntegrationProof />
      </section>
    </div>
  );
}

function SectionHeading({
  eyebrow,
  title,
  blurb,
}: {
  eyebrow: string;
  title: string;
  blurb: string;
}) {
  return (
    <div className="mb-6">
      <p className="text-[12px] uppercase tracking-[0.14em] text-muted">{eyebrow}</p>
      <h2 className="mt-2 text-[28px] font-semibold tracking-tight md:text-[32px]">{title}</h2>
      <p className="mt-2 max-w-[70ch] text-[15px] leading-relaxed text-muted">{blurb}</p>
    </div>
  );
}

function Fact({ term, detail }: { term: string; detail: string }) {
  return (
    <div>
      <dt className="font-mono text-[14px] text-text">{term}</dt>
      <dd className="mt-2 text-[14px] leading-relaxed text-muted">{detail}</dd>
    </div>
  );
}

/**
 * The visible daily counter. Until `GET /api/hunts` answers there is no number to show, so
 * none is shown — this counter never guesses.
 */
function LiveCounter({ budget }: { budget: HuntBudget | null }) {
  if (budget === null) {
    return (
      <p className="font-mono text-[13px] text-muted" aria-live="polite">
        live hunts today: …
      </p>
    );
  }

  const spent = budget.liveHuntsToday >= budget.dailyCap;

  return (
    <p className="font-mono text-[13px] text-muted" aria-live="polite">
      live hunts today: {budget.liveHuntsToday} / {budget.dailyCap}
      {spent ? " — spent for today; the recorded run is always free" : null}
      {!budget.nebiusConfigured ? " — live hunts unavailable on this deploy" : null}
    </p>
  );
}
