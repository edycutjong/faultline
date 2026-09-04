"use client";

/**
 * The Fault Report — the payoff screen.
 *
 * The hard rule here is provenance. The culprit, the diff and the evidence trail are
 * *verified*: they came from tests that actually executed. The single paragraph under
 * "Why it breaks" is *generated*, and it is labelled with the model that wrote it so the two
 * are never confused. When there is no paragraph, this component says so — it never invents
 * prose to fill the space.
 */

import type { Hunt } from "@/lib/types";
import { EM_DASH, formatCost, formatDate } from "./format";
import { CopyIssueButton } from "./CopyIssueButton";
import { ProbeList } from "./ProbeList";

function DiffView({ diff }: { diff: string }) {
  const lines = diff.replace(/\n$/, "").split("\n");
  return (
    <pre className="overflow-x-auto rounded-lg border border-line bg-[#0F0F11] py-3 font-mono text-[13px] leading-[1.55]">
      <code>
        {lines.map((line, i) => {
          const cls = line.startsWith("+++") || line.startsWith("---")
            ? "diff-meta"
            : line.startsWith("@@")
              ? "diff-hunk"
              : line.startsWith("+")
                ? "diff-add"
                : line.startsWith("-")
                  ? "diff-del"
                  : "";
          return (
            <span key={i} className={`diff-line ${cls}`}>
              {line === "" ? " " : line}
            </span>
          );
        })}
      </code>
    </pre>
  );
}

export function FaultReportView({ hunt }: { hunt: Hunt }) {
  const report = hunt.report;
  if (!report) return null;

  const narrating = hunt.status === "narrating";

  return (
    <section aria-labelledby="fault-report" className="rounded-card border border-line bg-surface">
      <header className="border-b border-line px-6 py-5">
        <p className="text-[12px] uppercase tracking-[0.14em] text-muted">Fault report</p>
        {/* The heading is the commit message: the most useful string on the screen, and the
            one a maintainer will recognise. */}
        <h2 id="fault-report" className="mt-2 max-w-[46ch] text-[26px] font-semibold leading-tight tracking-tight">
          {report.culpritSubject || "The culprit"}
        </h2>
      </header>

      {/* ---- Culprit: verified by executed tests ---- */}
      <div className="border-b border-line px-6 py-6">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className="inline-block h-3 w-3 rounded-[3px]"
            style={{ background: "var(--guilty)" }}
            aria-hidden="true"
          />
          <code className="font-mono text-[20px] text-text">{report.culpritSha}</code>
          <span className="rounded-full border border-line px-2.5 py-0.5 text-[12px] text-muted">
            verified by executed tests
          </span>
        </div>
        <dl className="mt-5 grid grid-cols-1 gap-x-10 gap-y-2 text-[14px] sm:grid-cols-3">
          <div>
            <dt className="text-muted">Author</dt>
            <dd className="mt-0.5">{report.culpritAuthor || EM_DASH}</dd>
          </div>
          <div>
            <dt className="text-muted">Date</dt>
            <dd className="mt-0.5 font-mono">{formatDate(report.culpritDate)}</dd>
          </div>
          <div>
            <dt className="text-muted">Compute cost</dt>
            <dd className="mt-0.5 font-mono">{formatCost(hunt.costUsd)}</dd>
          </div>
        </dl>
      </div>

      {/* ---- Diff ---- */}
      <div className="border-b border-line px-6 py-6">
        <h3 className="mb-3 text-[15px] font-semibold">The diff</h3>
        {report.diffText.trim() ? (
          <DiffView diff={report.diffText} />
        ) : (
          <p className="text-[14px] text-muted">
            The diff for this commit is not attached to the hunt record.
          </p>
        )}
      </div>

      {/* ---- The generated paragraph, labelled so it is never mistaken for the verified part ---- */}
      <div className="border-b border-line px-6 py-6">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h3 className="text-[15px] font-semibold">Why it breaks</h3>
          <span className="rounded-full border border-line px-2.5 py-0.5 font-mono text-[11px] text-muted">
            explained by {report.modelId.split("/").pop()}
          </span>
        </div>

        {report.rootCauseMd ? (
          <>
            <p className="max-w-[68ch] text-[16px] leading-relaxed text-text">
              {report.rootCauseMd.trim()}
            </p>
            <p className="mt-3 max-w-[68ch] text-[13px] text-muted">
              Generated text. The culprit above was proven by running the test; this paragraph
              was not. Read the diff before acting on it.
            </p>
          </>
        ) : (
          <p className="max-w-[68ch] text-[15px] text-muted">
            {narrating
              ? "Narration is still running. The culprit above is already final — the explanation is a decoration on an answer that already exists."
              : report.narrationError
                ? `No explanation was generated: ${report.narrationError}`
                : "No explanation is available for this hunt."}
          </p>
        )}
      </div>

      {/* ---- Evidence trail ---- */}
      <div className="border-b border-line px-6 py-5">
        <details>
          <summary className="flex items-center gap-2 text-[15px] font-semibold text-text">
            <span aria-hidden="true" className="text-muted">
              ▸
            </span>
            Evidence trail — {hunt.probes.length} probes
          </summary>
          <div className="mt-4">
            <ProbeList hunt={hunt} caption="Every probe in this hunt" />
          </div>
        </details>
      </div>

      <div className="px-6 py-6">
        <CopyIssueButton hunt={hunt} />
        <p className="mt-2 text-[13px] text-muted">
          Culprit, diff, model explanation and the full evidence table — one paste into a
          GitHub issue.
        </p>
      </div>
    </section>
  );
}
