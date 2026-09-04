/**
 * Resolving a suspect range from a public repository.
 *
 * Faultline never clones the repo itself — the probes do that, one commit at a time, inside
 * their own containers. The app only needs the ordered list of commit SHAs between the known
 * good ref and the bad one, which the GitHub REST API answers without a clone.
 *
 * Public repos only at MVP. A private repo needs credentials we deliberately do not accept.
 */

import type { Commit } from "@/lib/types";

export class GitRangeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitRangeError";
  }
}

export interface RepoRef {
  owner: string;
  repo: string;
}

/** Accepts the forms a maintainer actually pastes, including a trailing `.git` or slash. */
export function parseRepoUrl(input: string): RepoRef {
  const trimmed = input.trim();
  if (!trimmed) throw new GitRangeError("Repository URL is required.", 400);

  const patterns = [
    /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
    /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1] && match[2]) return { owner: match[1], repo: match[2] };
  }

  throw new GitRangeError(
    "That does not look like a public GitHub repository URL. Faultline supports public GitHub repos at this stage.",
    400,
  );
}

const GITHUB_API = "https://api.github.com";
const MAX_RANGE = 2000;

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "faultline",
  };
  // Optional. Unauthenticated GitHub allows 60 requests/hour per IP, which a handful of
  // judges hitting the deploy at once would exhaust; a token raises it to 5000.
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

interface GitHubCommit {
  sha: string;
  commit: {
    message: string;
    author: { name?: string; date?: string } | null;
  };
}

async function githubJson<T>(path: string, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(`${GITHUB_API}${path}`, { headers: githubHeaders() });

  if (res.status === 404) {
    throw new GitRangeError(
      "Repository or ref not found. Faultline can only reach public repositories.",
      404,
    );
  }
  if (res.status === 403 || res.status === 429) {
    throw new GitRangeError(
      "GitHub rate limit reached while resolving the commit range. Try again shortly.",
      429,
    );
  }
  if (!res.ok) {
    throw new GitRangeError(`GitHub request failed: ${res.status} ${res.statusText}`, 502);
  }

  return (await res.json()) as T;
}

/** Resolve a ref (tag, branch or SHA) to a full commit SHA. */
export async function resolveRef(
  { owner, repo }: RepoRef,
  ref: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const data = await githubJson<GitHubCommit>(
    `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
    fetchImpl,
  );
  return data.sha;
}

/**
 * List the commits from `goodRef` (exclusive) to `badRef` (inclusive), oldest first.
 *
 * Walked page by page from the bad ref backwards rather than via the compare endpoint,
 * which truncates at 250 commits — the 256-commit case sits just past that cliff.
 */
export async function resolveRange(
  ref: RepoRef,
  goodRef: string,
  badRef: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Commit[]> {
  const goodSha = await resolveRef(ref, goodRef, fetchImpl);
  const badSha = await resolveRef(ref, badRef, fetchImpl);

  if (goodSha === badSha) {
    throw new GitRangeError(
      "The known-good ref and the failing ref are the same commit, so there is no range to search.",
      400,
    );
  }

  const collected: GitHubCommit[] = [];
  let page = 1;
  let foundGood = false;

  while (!foundGood && collected.length <= MAX_RANGE) {
    const batch = await githubJson<GitHubCommit[]>(
      `/repos/${ref.owner}/${ref.repo}/commits?sha=${badSha}&per_page=100&page=${page}`,
      fetchImpl,
    );
    if (batch.length === 0) break;

    for (const commit of batch) {
      if (commit.sha === goodSha) {
        foundGood = true;
        break;
      }
      collected.push(commit);
    }
    page += 1;
  }

  if (!foundGood) {
    throw new GitRangeError(
      collected.length > MAX_RANGE
        ? `That range is larger than ${MAX_RANGE} commits. Pick a more recent known-good ref.`
        : "The known-good ref is not an ancestor of the failing ref, so they are not on the same line of history.",
      400,
    );
  }

  // The API returns newest first; bisection indexes oldest first.
  collected.reverse();

  return collected.map((commit, index) => ({
    sha: commit.sha,
    index: index + 1, // index 0 is the known-good ref itself, which is not a suspect.
    subject: (commit.commit.message ?? "").split("\n")[0]?.slice(0, 200) ?? "",
    author: commit.commit.author?.name ?? "unknown",
    date: commit.commit.author?.date ?? "",
  }));
}

/** A test command must be a plausible pytest invocation, not arbitrary shell. */
export function validateTestCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) throw new GitRangeError("A failing test command is required.", 400);
  if (trimmed.length > 500) {
    throw new GitRangeError("That test command is implausibly long.", 400);
  }
  // The command runs inside a throwaway container with no credentials, so this is a
  // usability guard rather than a security boundary — but shell metacharacters are far more
  // likely to be a paste error than an intention.
  if (/[;&|><`$\\]/.test(trimmed)) {
    throw new GitRangeError(
      "Shell metacharacters are not allowed in the test command. Give a single pytest invocation.",
      400,
    );
  }
  return trimmed;
}
