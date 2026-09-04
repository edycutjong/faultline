/**
 * Resolving the suspect range.
 *
 * Everything downstream — the planner's indices, the probe env vars, the issue's evidence
 * trail — is keyed on the ordered commit list this module produces. An off-by-one or a
 * truncated page here does not fail loudly; it names the wrong commit, confidently.
 *
 * GitHub is simulated at the HTTP boundary via the injected `fetchImpl`, so the pagination
 * walk, the ancestry check and the error mapping are all the production code path.
 */

import { describe, it, expect } from "vitest";
import {
  GitRangeError,
  fetchCommitDiff,
  parseRepoUrl,
  resolveRange,
  validateTestCommand,
} from "@/lib/git";

const REPO = { owner: "faultline-bench", repo: "tzdata-pipeline" };

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Narrow to GitRangeError without a cast, and fail loudly when nothing was thrown. */
function caught(fn: () => unknown): GitRangeError {
  try {
    fn();
  } catch (error) {
    if (error instanceof GitRangeError) return error;
    throw error;
  }
  throw new Error("expected a GitRangeError, but the call returned normally");
}

async function caughtAsync(fn: () => Promise<unknown>): Promise<GitRangeError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof GitRangeError) return error;
    throw error;
  }
  throw new Error("expected a GitRangeError, but the call resolved");
}

function shaFor(index: number): string {
  return `c${String(index).padStart(39, "0")}`;
}

interface GitHubCommitPayload {
  sha: string;
  commit: { message: string; author: { name?: string; date?: string } | null };
}

function commitPayload(index: number): GitHubCommitPayload {
  return {
    sha: shaFor(index),
    commit: {
      message: `change ${index}\n\nA body paragraph that must not reach the subject line.`,
      author: { name: "Dana", date: `2026-08-01T00:00:${String(index % 60).padStart(2, "0")}Z` },
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface FakeGitHubOptions {
  /** ref name -> resolved sha. A ref that is absent answers 404, as GitHub does. */
  refs: Record<string, string>;
  /** Page number (1-based) -> the commits GitHub returns for it, newest first. */
  page: (page: number) => GitHubCommitPayload[];
}

function fakeGitHub(options: FakeGitHubOptions) {
  const requests: string[] = [];

  const impl: typeof fetch = async (input) => {
    const url = urlOf(input);
    requests.push(url);

    const list = url.match(/\/repos\/[^/]+\/[^/]+\/commits\?.*\bpage=(\d+)/);
    if (list) return json(options.page(Number(list[1])));

    const ref = url.match(/\/repos\/[^/]+\/[^/]+\/commits\/(.+)$/);
    if (ref) {
      const sha = options.refs[decodeURIComponent(ref[1] ?? "")];
      if (!sha) return new Response("Not Found", { status: 404, statusText: "Not Found" });
      return json({ sha, commit: { message: "ref", author: null } });
    }

    throw new Error(`unexpected request in test: ${url}`);
  };

  return { impl, requests };
}

/**
 * A linear history: `count` suspect commits with the known-good ref sitting one step older,
 * served 100 per page exactly as the GitHub API paginates.
 */
function linearHistory(count: number) {
  const newestFirst = Array.from({ length: count }, (_, i) => commitPayload(count - i));
  const withGood = [...newestFirst, commitPayload(0)];
  return {
    refs: { good: shaFor(0), bad: shaFor(count) },
    page: (page: number) => withGood.slice((page - 1) * 100, page * 100),
  };
}

describe("parseRepoUrl", () => {
  it("accepts the https form a maintainer copies out of the address bar", () => {
    expect(parseRepoUrl("https://github.com/faultline-bench/tzdata-pipeline")).toEqual(REPO);
    expect(parseRepoUrl("http://www.github.com/faultline-bench/tzdata-pipeline")).toEqual(REPO);
  });

  it("accepts the https form with a trailing .git or slash, which the clone button emits", () => {
    expect(parseRepoUrl("https://github.com/faultline-bench/tzdata-pipeline.git")).toEqual(REPO);
    expect(parseRepoUrl("https://github.com/faultline-bench/tzdata-pipeline/")).toEqual(REPO);
    expect(parseRepoUrl("https://github.com/faultline-bench/tzdata-pipeline.git/")).toEqual(REPO);
  });

  it("accepts the SSH form, with and without the .git suffix", () => {
    expect(parseRepoUrl("git@github.com:faultline-bench/tzdata-pipeline")).toEqual(REPO);
    expect(parseRepoUrl("git@github.com:faultline-bench/tzdata-pipeline.git")).toEqual(REPO);
  });

  it("accepts the bare owner/repo shorthand", () => {
    expect(parseRepoUrl("faultline-bench/tzdata-pipeline")).toEqual(REPO);
    expect(parseRepoUrl("faultline-bench/tzdata-pipeline.git")).toEqual(REPO);
  });

  it("ignores surrounding whitespace from a sloppy paste", () => {
    expect(parseRepoUrl("  https://github.com/faultline-bench/tzdata-pipeline  ")).toEqual(REPO);
  });

  it("keeps a dot inside a repository name instead of mistaking it for a .git suffix", () => {
    expect(parseRepoUrl("owner/my.repo")).toEqual({ owner: "owner", repo: "my.repo" });
  });

  it("rejects an empty input as a missing field rather than a malformed one", () => {
    for (const input of ["", "   "]) {
      const error = caught(() => parseRepoUrl(input));
      expect(error.status).toBe(400);
      expect(error.message).toContain("required");
    }
  });

  it("rejects a non-GitHub host, because the probes can only clone from GitHub", () => {
    const error = caught(() => parseRepoUrl("https://gitlab.com/faultline-bench/tzdata-pipeline"));
    expect(error).toBeInstanceOf(GitRangeError);
    expect(error.status).toBe(400);
    expect(error.message).toContain("public GitHub repository");
  });

  it("rejects nonsense and half-URLs", () => {
    for (const input of [
      "not a repo at all",
      "https://github.com/faultline-bench",
      "https://github.com/a/b/c",
      "ftp://github.com/a/b",
    ]) {
      expect(() => parseRepoUrl(input)).toThrow(GitRangeError);
    }
  });
});

describe("validateTestCommand", () => {
  it("accepts a normal pytest invocation and returns it trimmed", () => {
    expect(validateTestCommand("  pytest tests/test_window.py::test_daily_boundary  ")).toBe(
      "pytest tests/test_window.py::test_daily_boundary",
    );
  });

  it("rejects an empty command", () => {
    for (const input of ["", "     "]) {
      const error = caught(() => validateTestCommand(input));
      expect(error.status).toBe(400);
      expect(error.message).toContain("required");
    }
  });

  it("rejects a command past the 500-character cap but accepts one exactly at it", () => {
    const atCap = `pytest ${"a".repeat(493)}`;
    expect(atCap).toHaveLength(500);
    expect(validateTestCommand(atCap)).toBe(atCap);

    const error = caught(() => validateTestCommand(`${atCap}a`));
    expect(error.status).toBe(400);
    expect(error.message).toContain("implausibly long");
  });

  it("rejects every shell metacharacter, since each one is a paste error or a chained command", () => {
    for (const meta of [";", "&", "|", ">", "<", "`", "$", "\\"]) {
      const error = caught(() => validateTestCommand(`pytest tests ${meta} whoami`));
      expect(error.status, meta).toBe(400);
      expect(error.message, meta).toContain("Shell metacharacters");
    }
  });
});

describe("resolveRange", () => {
  it("returns the range oldest-first, indexed from 1, excluding the known-good ref", async () => {
    const github = fakeGitHub(linearHistory(10));

    const commits = await resolveRange(REPO, "good", "bad", github.impl);

    expect(commits).toHaveLength(10);
    expect(commits.map((c) => c.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Index 1 is the oldest suspect — the commit immediately after the known-good ref.
    expect(commits[0]?.sha).toBe(shaFor(1));
    expect(commits[9]?.sha).toBe(shaFor(10));
    // The good ref is the baseline, not a suspect; testing it would waste a probe.
    expect(commits.map((c) => c.sha)).not.toContain(shaFor(0));
  });

  it("carries only the subject line, the author and the date onto each commit", async () => {
    const github = fakeGitHub(linearHistory(3));

    const commits = await resolveRange(REPO, "good", "bad", github.impl);

    expect(commits[0]?.subject).toBe("change 1");
    expect(commits[0]?.author).toBe("Dana");
    expect(commits[0]?.date).toBe("2026-08-01T00:00:01Z");
  });

  it("walks past the 100-commit page boundary, which the headline 256 case depends on", async () => {
    // The compare endpoint truncates at 250, so a 256-commit range is only reachable by
    // paging the commits endpoint. A silent stop at page 1 would search 100 commits and
    // name a culprit from the wrong sub-range.
    const github = fakeGitHub(linearHistory(256));

    const commits = await resolveRange(REPO, "good", "bad", github.impl);

    expect(commits).toHaveLength(256);
    expect(commits[0]?.sha).toBe(shaFor(1));
    expect(commits[255]?.sha).toBe(shaFor(256));
    expect(commits.map((c) => c.index)).toEqual(
      Array.from({ length: 256 }, (_, i) => i + 1),
    );

    const listed = github.requests.filter((u) => u.includes("per_page=100"));
    expect(listed).toHaveLength(3);
    expect(listed[0]).toContain("page=1");
    expect(listed[2]).toContain("page=3");
    // Every page is anchored on the failing commit, not on the default branch head.
    for (const request of listed) expect(request).toContain(`sha=${shaFor(256)}`);
  });

  it("refuses a range whose endpoints are the same commit", async () => {
    const github = fakeGitHub({
      refs: { good: shaFor(7), bad: shaFor(7) },
      page: () => [],
    });

    const error = await caughtAsync(() => resolveRange(REPO, "good", "bad", github.impl));
    expect(error.status).toBe(400);
    expect(error.message).toContain("same commit");
    // The endpoints settle it; no history needs listing.
    expect(github.requests.some((u) => u.includes("per_page=100"))).toBe(false);
  });

  it("refuses when the good ref never appears in the walk — a different line of history", async () => {
    // Bisection assumes one ordered line between the two refs. A good ref on a sibling
    // branch would otherwise silently yield "every commit in the repo" as the range.
    const github = fakeGitHub({
      refs: { good: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", bad: shaFor(50) },
      page: (page) => (page === 1 ? Array.from({ length: 50 }, (_, i) => commitPayload(50 - i)) : []),
    });

    const error = await caughtAsync(() => resolveRange(REPO, "good", "bad", github.impl));
    expect(error.status).toBe(400);
    expect(error.message).toContain("not on the same line of history");
  });

  it("refuses a range past the 2000-commit cap instead of paging forever", async () => {
    const github = fakeGitHub({
      refs: { good: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", bad: shaFor(9999) },
      page: (page) =>
        Array.from({ length: 100 }, (_, i) => commitPayload((page - 1) * 100 + i + 1)),
    });

    const error = await caughtAsync(() => resolveRange(REPO, "good", "bad", github.impl));
    expect(error.status).toBe(400);
    expect(error.message).toContain("larger than 2000 commits");
    // 21 pages is the first count that carries the collection past the cap.
    expect(github.requests.filter((u) => u.includes("per_page=100"))).toHaveLength(21);
  });

  it("maps a 404 onto the public-repositories explanation, not a raw HTTP error", async () => {
    const github = fakeGitHub({ refs: {}, page: () => [] });

    const error = await caughtAsync(() => resolveRange(REPO, "good", "bad", github.impl));
    expect(error.status).toBe(404);
    expect(error.message).toContain("not found");
    expect(error.message).toContain("public repositories");
  });

  it("maps 403 and 429 onto the rate-limit explanation with a retryable status", async () => {
    // Unauthenticated GitHub allows 60 requests/hour per IP; a handful of judges hitting the
    // deploy at once will see this, and it must not read as "your repo is broken".
    for (const status of [403, 429]) {
      const impl: typeof fetch = async () =>
        new Response("rate limited", { status, statusText: "Forbidden" });

      const error = await caughtAsync(() => resolveRange(REPO, "good", "bad", impl));
      expect(error.status, String(status)).toBe(429);
      expect(error.message, String(status)).toContain("rate limit");
    }
  });

  it("reports any other GitHub failure as a bad gateway", async () => {
    const impl: typeof fetch = async () =>
      new Response("boom", { status: 500, statusText: "Internal Server Error" });

    const error = await caughtAsync(() => resolveRange(REPO, "good", "bad", impl));
    expect(error.status).toBe(502);
    expect(error.message).toContain("GitHub request failed: 500");
  });
});

describe("fetchCommitDiff", () => {
  it("requests the patch media type and returns the diff verbatim", async () => {
    const diff = "diff --git a/w.py b/w.py\n-  return dt\n+  return dt.replace(tzinfo=None)";
    const seen: string[] = [];
    const impl: typeof fetch = async (input, init) => {
      seen.push(urlOf(input));
      const headers = new Headers(init?.headers);
      expect(headers.get("Accept")).toBe("application/vnd.github.diff");
      return new Response(diff, { status: 200 });
    };

    expect(await fetchCommitDiff(REPO, shaFor(13), 24_000, impl)).toBe(diff);
    expect(seen[0]).toContain(`/repos/faultline-bench/tzdata-pipeline/commits/${shaFor(13)}`);
  });

  it("truncates an oversized diff and says so, so the model never sees a silent cut", async () => {
    // A lockfile refresh is tens of thousands of lines and would crowd out the changed code
    // in a 32K-token context.
    const impl: typeof fetch = async () => new Response("x".repeat(5_000), { status: 200 });

    const diff = await fetchCommitDiff(REPO, shaFor(13), 100, impl);

    expect(diff.startsWith("x".repeat(100))).toBe(true);
    expect(diff).toContain("[diff truncated at 100 characters]");
    expect(diff).not.toContain("x".repeat(101));
  });

  it("leaves a diff exactly at the cap untouched", async () => {
    const impl: typeof fetch = async () => new Response("x".repeat(100), { status: 200 });

    const diff = await fetchCommitDiff(REPO, shaFor(13), 100, impl);

    expect(diff).toBe("x".repeat(100));
    expect(diff).not.toContain("truncated");
  });

  it("throws with the upstream status when the diff cannot be fetched", async () => {
    const impl: typeof fetch = async () => new Response("nope", { status: 451 });

    const error = await caughtAsync(() => fetchCommitDiff(REPO, shaFor(13), 24_000, impl));
    expect(error.status).toBe(451);
    expect(error.message).toContain(shaFor(13).slice(0, 7));
  });
});
