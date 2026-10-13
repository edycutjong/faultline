"use client";

/**
 * The new-hunt form. Three fields, plus the install command Faultline resolved from the
 * repository — shown, editable, never hidden. No YAML, no config file, no wizard.
 *
 * The form refuses up front in the states where submitting could only fail: no Nebius
 * credentials on the deploy, the daily live-hunt cap spent (unless a judge code is given),
 * or another live hunt holding every probe slot. Each says so plainly and points somewhere
 * useful rather than throwing an error after the click.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

const GITHUB_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/i;

export interface HuntBudget {
  liveHuntsToday: number;
  dailyCap: number;
  nebiusConfigured: boolean;
  slots?: number;
  liveHuntId?: string | null;
}

interface Preview {
  commits: number;
  installCommand: string;
  installReason: string;
  slots: number;
  expectedRounds: number | null;
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint: React.ReactNode;
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
  "field w-full rounded-lg border border-line bg-bg px-3.5 py-2.5 font-mono text-[14px] text-text placeholder:text-unknown";

export function NewHuntForm({ budget }: { budget: HuntBudget | null }) {
  const router = useRouter();
  const [repoUrl, setRepoUrl] = useState("");
  const [testCommand, setTestCommand] = useState("");
  const [goodRef, setGoodRef] = useState("");
  const [installCommand, setInstallCommand] = useState("");
  const [installEdited, setInstallEdited] = useState(false);
  const [accessCode, setAccessCode] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveHuntId, setLiveHuntId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const capReached =
    budget !== null && budget.dailyCap > 0 && budget.liveHuntsToday >= budget.dailyCap;
  const unconfigured = budget !== null && !budget.nebiusConfigured;
  const blocked = unconfigured || (capReached && accessCode.trim() === "");
  const runningElsewhere = liveHuntId ?? budget?.liveHuntId ?? null;

  const repoLooksValid = useMemo(
    () => repoUrl.trim() === "" || GITHUB_URL.test(repoUrl.trim()),
    [repoUrl],
  );

  // Resolve the range and the install command once the repo and good ref are filled in.
  // Debounced: GitHub's unauthenticated budget is small and shared by every visitor.
  useEffect(() => {
    const repo = repoUrl.trim();
    const good = goodRef.trim();
    if (!repo || !good || !GITHUB_URL.test(repo)) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setResolving(true);
      try {
        const query = new URLSearchParams({ repoUrl: repo, goodRef: good });
        const response = await fetch(`/api/resolve?${query.toString()}`, { signal: controller.signal });
        const payload = (await response.json()) as Preview & { error?: string };
        if (!response.ok) {
          setPreview(null);
          setPreviewError(payload.error ?? "Could not resolve that range.");
          return;
        }
        setPreview(payload);
        setPreviewError(null);
        if (!installEdited) setInstallCommand(payload.installCommand);
      } catch {
        // aborted or offline: keep whatever was shown
      } finally {
        setResolving(false);
      }
    }, 600);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [repoUrl, goodRef, installEdited]);

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
    setLiveHuntId(null);
    try {
      const response = await fetch("/api/hunts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repoUrl: repoUrl.trim(),
          testCommand: testCommand.trim(),
          installCommand: installCommand.trim(),
          goodRef: goodRef.trim(),
          ...(accessCode.trim() ? { accessCode: accessCode.trim() } : {}),
        }),
      });
      const payload = (await response.json()) as {
        hunt?: { id: string };
        error?: string;
        liveHuntId?: string;
      };
      if (!response.ok || !payload.hunt) {
        setError(payload.error ?? "The hunt could not be started.");
        setLiveHuntId(payload.liveHuntId ?? null);
        setSubmitting(false);
        return;
      }
      router.push(`/hunts/${payload.hunt.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The hunt could not be started.");
      setSubmitting(false);
    }
  }

  const slots = preview?.slots ?? budget?.slots ?? 0;

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
        hint="The exact command each probe container runs, unchanged, on its own commit."
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
        hint={
          resolving ? (
            "Resolving the range…"
          ) : previewError ? (
            <span style={{ color: "var(--guilty)" }}>{previewError}</span>
          ) : preview ? (
            <span className="font-mono text-text">
              {preview.commits} {preview.commits === 1 ? "commit" : "commits"} between {goodRef.trim()} and HEAD
              {preview.expectedRounds ? ` · at most ${preview.expectedRounds} rounds of up to ${slots} probes` : ""}
            </span>
          ) : (
            "A tag, branch or SHA where the test still passed. The failing end defaults to HEAD."
          )
        }
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

      <Field
        id="installCommand"
        label="Install command"
        hint={
          preview && !installEdited
            ? `Resolved from the repository: ${preview.installReason}. Edit it if your test dependencies live elsewhere.`
            : "Runs in every probe before the test, against that commit's own files. Leave empty to detect per commit."
        }
      >
        <input
          id="installCommand"
          name="installCommand"
          type="text"
          autoComplete="off"
          spellCheck={false}
          className={INPUT_CLASS}
          placeholder="pip install -e .[test]"
          value={installCommand}
          onChange={(e) => {
            setInstallCommand(e.target.value);
            setInstallEdited(true);
          }}
        />
      </Field>

      {capReached ? (
        <Field
          id="accessCode"
          label="Judge access code"
          hint="Today's free live hunts are used up. A judge code from the submission's testing instructions lifts the daily cap."
        >
          <input
            id="accessCode"
            name="accessCode"
            type="text"
            autoComplete="off"
            spellCheck={false}
            className={INPUT_CLASS}
            value={accessCode}
            onChange={(e) => setAccessCode(e.target.value)}
          />
        </Field>
      ) : null}

      {runningElsewhere ? (
        <div
          role="status"
          className="rounded-lg border px-4 py-3 text-[14px]"
          style={{
            borderColor: "color-mix(in srgb, var(--accent) 40%, transparent)",
            background: "color-mix(in srgb, var(--accent) 7%, transparent)",
          }}
        >
          <strong className="font-medium">A live hunt is running right now.</strong>{" "}
          It holds every probe slot this deployment has, so a second one would only starve it.{" "}
          <Link href={`/hunts/${runningElsewhere}`} className="underline underline-offset-2">
            Watch it live
          </Link>
          .
        </div>
      ) : null}

      {unconfigured ? (
        <div
          role="status"
          className="rounded-lg border px-4 py-3 text-[14px]"
          style={{
            borderColor: "color-mix(in srgb, var(--inconclusive) 40%, transparent)",
            background: "color-mix(in srgb, var(--inconclusive) 7%, transparent)",
          }}
        >
          <strong className="font-medium">Live hunts are unavailable on this deploy.</strong>{" "}
          No Nebius service-account credentials are configured, so no probe job can be
          dispatched. Everything else on this page — the recorded run, the evidence trail,
          the report — is real and readable without them.
        </div>
      ) : null}

      {error && !(liveHuntId && runningElsewhere) ? (
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
          className="rounded-lg px-5 py-2.5 text-[15px] font-medium transition-opacity duration-150 disabled:cursor-not-allowed disabled:opacity-40 cta-accent"
        >
          {submitting ? "Dispatching round 1…" : "Start hunt"}
        </button>
        <p className="text-[13px] text-muted">
          Round 1 tests both ends{slots > 2 ? ` plus ${slots - 2} suspects` : ""} in fresh containers. Each
          probe bills only while it runs.
        </p>
      </div>
    </form>
  );
}
