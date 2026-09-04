"use client";

/**
 * `Copy as GitHub issue` — the memorable moment.
 *
 * One click yields a complete, pasteable issue and the button morphs to "✓ Copied" for 2s
 * (--dur-copy). The text itself comes from `renderIssue` in `src/lib/issue.ts`, the same
 * function `GET /api/hunts/{id}/report?format=md` serves, so what a maintainer pastes is
 * byte-identical to what the API returns. There is deliberately no second renderer here:
 * two renderers means two ways for the payoff artefact to be wrong.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Hunt } from "@/lib/types";
import { renderIssue } from "@/lib/issue";

async function writeToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Clipboard permission denied or an insecure origin — fall through to the manual path.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export function CopyIssueButton({ hunt }: { hunt: Hunt }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const onClick = useCallback(async () => {
    const ok = await writeToClipboard(renderIssue(hunt));
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    // ui.md: the check state is held for 2s, then the button returns to itself.
    timer.current = setTimeout(() => setState("idle"), 2000);
  }, [hunt]);

  return (
    <div className="flex flex-col items-start gap-3">
      <button
        type="button"
        onClick={onClick}
        className={`rounded-lg border px-4 py-2.5 text-[14px] font-medium transition-colors duration-150 ${
          state === "copied"
            ? "copied-flash"
            : "border-line bg-surface text-text hover:border-muted"
        }`}
      >
        {state === "copied"
          ? "✓ Copied"
          : state === "failed"
            ? "Copy blocked — select the text below"
            : "Copy as GitHub issue"}
      </button>

      <span aria-live="polite" className="sr-only">
        {state === "copied" ? "Issue markdown copied to clipboard" : ""}
      </span>

      {/* The clipboard is not available on every origin. When it refuses, the text is still
          reachable by hand rather than lost behind a dead button. */}
      {state === "failed" ? (
        <textarea
          readOnly
          rows={10}
          aria-label="Issue markdown"
          className="w-full rounded-lg border border-line bg-bg p-3 font-mono text-[12px] text-muted"
          value={renderIssue(hunt)}
        />
      ) : null}
    </div>
  );
}
