"use client";

/**
 * The new-hunt form. Three fields. No YAML, no config file, no wizard.
 *
 * The form refuses up front in the two states where submitting could only fail: no Nebius
 * credentials on the deploy, and the daily live-hunt cap already spent. Both say so plainly
 * and point at the recorded example rather than throwing an error after the click.
 */

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

const GITHUB_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/i;

export interface HuntBudget {
  liveHuntsToday: number;
  dailyCap: number;
  nebiusConfigured: boolean;
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5 md:grid-cols-[190px_1fr] md:items-baseline md:gap-4">
      <label htmlFor={id} className="text-[14px] font-medium text-text">
        {label}
      </label>
      <div>
        {children}
        <p className="mt-1.5 text-[12px] text-muted">{hint}</p>
      </div>
    </div>
  );
}

const INPUT_CLASS =
  "w-full rounded-lg border border-line bg-bg px-3.5 py-2.5 font-mono text-[14px] text-text placeholder:text-unknown focus:border-accent";

export function NewHuntForm({ budget }: { budget: HuntBudget | null }) {
  const router = useRouter();
  const [repoUrl, setRepoUrl] = useState("");
  const [testCommand, setTestCommand] = useState("");
  const [goodRef, setGoodRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const capReached =
    budget !== null && budget.dailyCap > 0 && budget.liveHuntsToday >= budget.dailyCap;
  const unconfigured = budget !== null && !budget.nebiusConfigured;
  const blocked = capReached || unconfigured;

  const repoLooksValid = useMemo(
    () => repoUrl.trim() === "" || GITHUB_URL.test(repoUrl.trim()),
    [repoUrl],
  );

  const canSubmit =
    !blocked &&
    !submitting &&
    repoUrl.trim() !== "" &&
    testCommand.trim() !== "" &&
    goodRef.trim() !== "" &&
    repoLooksValid;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/hunts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repoUrl: repoUrl.trim(),
          testCommand: testCommand.trim(),
          goodRef: goodRef.trim(),
        }),
      });
      const payload = (await response.json()) as {
        hunt?: { id: string };
        error?: string;
      };
      if (!response.ok || !payload.hunt) {
        setError(payload.error ?? "The hunt could not be started.");
        setSubmitting(false);
        return;
      }
      router.push(`/hunts/${payload.hunt.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The hunt could not be started.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
      <Field
        id="repoUrl"
        label="Repository"
        hint="A public GitHub repository. Faultline reads the commit range before it spends anything."
      >
        <input
          id="repoUrl"
          name="repoUrl"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          className={INPUT_CLASS}
          placeholder="https://github.com/owner/repo"
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          aria-invalid={!repoLooksValid}
          aria-describedby={repoLooksValid ? undefined : "repo-error"}
        />
        {!repoLooksValid ? (
          <p id="repo-error" className="mt-1.5 text-[12px]" style={{ color: "var(--guilty)" }}>
            Expected a URL of the form https://github.com/owner/repo
          </p>
        ) : null}
      </Field>

      <Field
        id="testCommand"
        label="Failing test"
        hint="The exact pytest invocation each probe container runs, unchanged, on its own commit."
      >
        <input
          id="testCommand"
          name="testCommand"
          type="text"
          autoComplete="off"
          spellCheck={false}
          className={INPUT_CLASS}
          placeholder="pytest tests/test_window.py::test_daily_boundary"
          value={testCommand}
          onChange={(e) => setTestCommand(e.target.value)}
        />
      </Field>

      <Field
        id="goodRef"
        label="Last known good"
        hint="A tag, branch or SHA where the test still passed. The failing end defaults to HEAD."
      >
        <input
          id="goodRef"
          name="goodRef"
          type="text"
          autoComplete="off"
          spellCheck={false}
          className={INPUT_CLASS}
          placeholder="v1.4.0"
          value={goodRef}
          onChange={(e) => setGoodRef(e.target.value)}
        />
      </Field>

      {blocked ? (
        <div
          role="status"
          className="rounded-lg border px-4 py-3 text-[14px]"
          style={{
            borderColor: "color-mix(in srgb, var(--inconclusive) 40%, transparent)",
            background: "color-mix(in srgb, var(--inconclusive) 7%, transparent)",
          }}
        >
          {unconfigured ? (
            <>
              <strong className="font-medium">Live hunts are unavailable on this deploy.</strong>{" "}
              No Nebius service-account credentials are configured, so no probe job can be
              dispatched. Everything else on this page — the recorded run, the evidence trail,
              the report — is real and readable without them.
            </>
          ) : (
            <>
              <strong className="font-medium">
                Today&rsquo;s {budget?.dailyCap} live hunts are spent.
              </strong>{" "}
              The cap is deliberate: judge traffic must not quietly drain the credit balance.
              The recorded example above costs nothing to view and is always available.
            </>
          )}
        </div>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="rounded-lg border px-4 py-3 text-[14px]"
          style={{
            borderColor: "color-mix(in srgb, var(--guilty) 45%, transparent)",
            background: "color-mix(in srgb, var(--guilty) 8%, transparent)",
          }}
        >
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-4 md:pl-[206px]">
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-lg px-5 py-2.5 text-[15px] font-medium transition-opacity duration-150 disabled:cursor-not-allowed disabled:opacity-40"
          style={{ background: "var(--accent)", color: "var(--on-accent)" }}
        >
          {submitting ? "Dispatching band…" : "Start hunt"}
        </button>
        <p className="text-[13px] text-muted">
          Eight probe containers go out at once. Nothing is billed until they run.
        </p>
      </div>
    </form>
  );
}
