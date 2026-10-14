/** Gap-filling coverage for src/lib/git.ts: token header, default fetch, shape fallbacks. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitRangeError,
  fetchCommitDiff,
  githubJson,
  optionalDependencyGroups,
  resolveHuntRange,
  resolveRange,
  resolveRef,
  suggestInstallCommand,
} from "@/lib/git";

const REPO = { owner: "o", repo: "r" };

function json(body: unknown, status = 200, statusText = ""): Response {
  return new Response(JSON.stringify(body), { status, statusText });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("githubJson", () => {
  it("sends the bearer token when GITHUB_TOKEN is set, and omits it otherwise", async () => {
    const seen: Array<Record<string, string>> = [];
    const f = (async (_u: unknown, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return json({ ok: 1 });
    }) as unknown as typeof fetch;

    vi.stubEnv("GITHUB_TOKEN", "  tok  ");
    await githubJson("/x", f);
    vi.stubEnv("GITHUB_TOKEN", "   ");
    await githubJson("/x", f);
    vi.stubEnv("GITHUB_TOKEN", "");
    await githubJson("/x", f);
    expect(seen[0]?.Authorization).toBe("Bearer tok");
    expect(seen[1]?.Authorization).toBeUndefined();
    expect(seen[2]?.Authorization).toBeUndefined();
  });

  it("maps 404, 403, 429 and other failures to GitRangeError statuses", async () => {
    const run = (status: number) =>
      githubJson("/x", (async () => json({}, status, "Nope")) as unknown as typeof fetch).catch(
        (e: unknown) => e as GitRangeError,
      ) as Promise<GitRangeError>;
    expect((await run(404)).status).toBe(404);
    expect((await run(403)).status).toBe(429);
    expect((await run(429)).status).toBe(429);
    const e = await run(500);
    expect(e.status).toBe(502);
    expect(e.message).toBe("GitHub request failed: 500 Nope");
  });
});

describe("default fetch parameter", () => {
  it("uses global fetch when none is injected", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => {
      calls.push(u);
      if (u.includes("/contents/")) return new Response("[project]", { status: 200 });
      if (u.includes("/git/trees/")) {
        return json({ tree: [{ path: "pyproject.toml", type: "blob" }] });
      }
      if (u.endsWith("/commits/abc")) return new Response("diff body", { status: 200 });
      if (u.includes("/commits/good")) return json({ sha: "g" });
      if (u.includes("/commits/bad")) return json({ sha: "b" });
      if (u.includes("/commits?sha=b")) {
        return json([
          { sha: "b", commit: { message: "m", author: null } },
          { sha: "g", commit: { message: "x", author: null } },
        ]);
      }
      return json({}, 500);
    });

    expect(await resolveRef(REPO, "good")).toBe("g");
    expect((await resolveRange(REPO, "good", "bad")).map((c) => c.sha)).toEqual(["b"]);
    expect((await suggestInstallCommand(REPO, "s")).command).toBe("pip install -e . pytest");
    expect(await fetchCommitDiff(REPO, "abc")).toBe("diff body");
    expect(calls.length).toBeGreaterThan(4);
  });
});

describe("resolveHuntRange commit shaping", () => {
  it("falls back for missing message, author name and date; keeps empty-batch break", async () => {
    const f = (async (u: string) => {
      if (u.includes("/commits/good")) return json({ sha: "g" });
      if (u.includes("/commits/bad")) return json({ sha: "b" });
      return json([
        { sha: "c3", commit: { author: null } },
        { sha: "c2", commit: { message: "", author: {} } },
        { sha: "c1", commit: { message: `${"a".repeat(300)}\nbody`, author: { name: "Ann", date: "D" } } },
        { sha: "g", commit: { message: "good", author: null } },
      ]);
    }) as unknown as typeof fetch;
    const { commits } = await resolveHuntRange(REPO, "good", "bad", f);
    expect(commits.map((c) => c.sha)).toEqual(["c1", "c2", "c3"]);
    expect(commits[0]).toMatchObject({ index: 1, subject: "a".repeat(200), author: "Ann", date: "D" });
    expect(commits[1]).toMatchObject({ subject: "", author: "unknown", date: "" });
    expect(commits[2]).toMatchObject({ subject: "", author: "unknown", date: "" });
  });

  it("reports non-ancestor when history runs out (empty page)", async () => {
    const f = (async (u: string) => {
      if (u.includes("/commits/good")) return json({ sha: "g" });
      if (u.includes("/commits/bad")) return json({ sha: "b" });
      if (u.endsWith("page=1")) return json([{ sha: "x", commit: { message: "m", author: null } }]);
      return json([]);
    }) as unknown as typeof fetch;
    await expect(resolveHuntRange(REPO, "good", "bad", f)).rejects.toThrow(/not an ancestor/);
  });

  it("rejects ranges beyond the cap", async () => {
    const f = (async (u: string) => {
      if (u.includes("/commits/good")) return json({ sha: "g" });
      if (u.includes("/commits/bad")) return json({ sha: "b" });
      const page = Number(/page=(\d+)/.exec(u)?.[1]);
      return json(
        Array.from({ length: 100 }, (_, i) => ({
          sha: `s${page}-${i}`,
          commit: { message: "m", author: null },
        })),
      );
    }) as unknown as typeof fetch;
    await expect(resolveHuntRange(REPO, "good", "bad", f)).rejects.toThrow(/larger than 2000/);
  });
});

describe("suggestInstallCommand fallbacks", () => {
  const tree = (paths: string[], text: string | null = null) =>
    (async (u: string) => {
      if (u.includes("/git/trees/")) {
        return json({ tree: paths.map((path) => ({ path, type: "blob" })).concat([{ path: "d", type: "tree" }]) });
      }
      return text === null ? new Response("", { status: 404 }) : new Response(text);
    }) as unknown as typeof fetch;

  it("handles a tree response with no tree field", async () => {
    const f = (async () => json({})) as unknown as typeof fetch;
    expect((await suggestInstallCommand(REPO, "s", f)).command).toBe("pip install pytest");
  });

  it("uses a declared test extra from pyproject.toml", async () => {
    const f = tree(["pyproject.toml"], "[project.optional-dependencies]\ndev = []\n");
    expect((await suggestInstallCommand(REPO, "s", f)).command).toBe("pip install -e .[dev]");
  });

  it("falls back to explicit pytest when pyproject is unreadable or has no extra", async () => {
    const r = await suggestInstallCommand(REPO, "s", tree(["pyproject.toml"], null));
    expect(r.command).toBe("pip install -e . pytest");
    expect(r.reason).toMatch(/no test extra/);
  });

  it("setup.py/setup.cfg with and without dev requirements", async () => {
    const withDev = await suggestInstallCommand(REPO, "s", tree(["setup.cfg", "requirements-dev.txt"]));
    expect(withDev.command).toBe("pip install -e . -r requirements-dev.txt");
    expect(withDev.reason).toBe("setup.py plus requirements-dev.txt");
    const without = await suggestInstallCommand(REPO, "s", tree(["setup.py"]));
    expect(without.command).toBe("pip install -e . pytest");
    expect(without.reason).toMatch(/setup\.py, with pytest/);
  });

  it("requirements files with and without dev variants", async () => {
    expect((await suggestInstallCommand(REPO, "s", tree(["requirements.txt"]))).command).toBe(
      "pip install -r requirements.txt pytest",
    );
    expect(
      (await suggestInstallCommand(REPO, "s", tree(["requirements.txt", "requirements-test.txt"]))).command,
    ).toBe("pip install -r requirements.txt -r requirements-test.txt");
    expect((await suggestInstallCommand(REPO, "s", tree(["dev-requirements.txt"]))).command).toBe(
      "pip install -r dev-requirements.txt",
    );
  });

  it("falls through to bare pytest with no packaging files", async () => {
    expect((await suggestInstallCommand(REPO, "s", tree(["README.md"]))).command).toBe("pip install pytest");
  });
});

describe("fetchCommitDiff", () => {
  it("truncates over-long diffs and reports failures with the status", async () => {
    const ok = (async () => new Response("x".repeat(50))) as unknown as typeof fetch;
    expect(await fetchCommitDiff(REPO, "abcdef123", 10, ok)).toBe(
      `${"x".repeat(10)}\n\n[diff truncated at 10 characters]`,
    );
    const bad = (async () => new Response("", { status: 410 })) as unknown as typeof fetch;
    const err = (await fetchCommitDiff(REPO, "abcdef123", 10, bad).catch((e: unknown) => e as GitRangeError)) as GitRangeError;
    expect(err.status).toBe(410);
    expect(err.message).toBe("Could not fetch the diff for abcdef1: 410");
  });
});

describe("optionalDependencyGroups", () => {
  it("ignores lines outside the section and non-matching lines", () => {
    expect(
      optionalDependencyGroups('x = 1\n[project.optional-dependencies]\n"a-b" = []\n# c\n[other]\nz = 1'),
    ).toEqual(["a-b"]);
  });
});

describe("validateInstallCommand length", () => {
  it("rejects an implausibly long install command", async () => {
    const { validateInstallCommand } = await import("@/lib/git");
    expect(() => validateInstallCommand(`pip install ${"a".repeat(300)}`)).toThrow(/implausibly long/);
  });
});
