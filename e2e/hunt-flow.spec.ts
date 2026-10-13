import { test, expect } from "@playwright/test";

/**
 * The core journey, as far as it can honestly go without credentials.
 *
 * The suite runs the app with no credentials, so it stops where that reality stops: it drives
 * the validation a maintainer would actually hit, and asserts that a hunt that cannot be
 * dispatched produces a stated reason rather than a silent failure. With credentials, the
 * dispatch assertions below become reachable and the guard flips.
 */
test.describe("starting a hunt", () => {
  test("the form rejects a URL that is not a public GitHub repository", async ({ request }) => {
    const res = await request.post("/api/hunts", {
      data: { repoUrl: "not-a-url", testCommand: "pytest -q", goodRef: "v1.0.0" },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(String((await res.json()).error)).toBeTruthy();
  });

  test("missing required fields are named, not swallowed", async ({ request }) => {
    const res = await request.post("/api/hunts", { data: { repoUrl: "https://github.com/a/b" } });
    expect(res.status()).toBe(400);
    expect(String((await res.json()).error)).toMatch(/required/i);
  });

  /**
   * bandSize caps the interior probes per round at 8; what a hunt actually gets is the
   * backend's capacity (2 VMs per region, measured). Input is validated before anything
   * touches the backend, so these are refused even on a deploy with no credentials.
   */
  for (const bad of [0, 9, 2.5, "eight"] as const) {
    test(`bandSize ${JSON.stringify(bad)} is refused with the bound explained`, async ({ request }) => {
      const res = await request.post("/api/hunts", {
        data: {
          repoUrl: "https://github.com/faultline-bench/id-mint",
          testCommand: "python -m pytest -q",
          goodRef: "v1.0.0",
          bandSize: bad,
        },
      });
      expect(res.status()).toBe(400);
      expect(String((await res.json()).error)).toMatch(/bandSize/i);
    });
  }

  test("a hunt that cannot be dispatched explains why rather than hanging", async ({ request }) => {
    const res = await request.post("/api/hunts", {
      data: {
        repoUrl: "https://github.com/faultline-bench/id-mint",
        testCommand: "python -m pytest -q",
        goodRef: "v1.0.0",
      },
    });
    const body = await res.json();
    if (res.status() === 201) {
      // Credentials are present and the range resolved: the hunt is real.
      expect(body.hunt.id).toBeTruthy();
      expect(body.hunt.slots).toBeGreaterThan(0);
      expect(body.hunt.commits.length).toBeGreaterThan(0);
    } else {
      // The expected path today. What matters is that the failure is *stated*.
      expect(res.status()).toBeGreaterThanOrEqual(400);
      expect(String(body.error).length).toBeGreaterThan(10);
    }
  });

  test("an unknown hunt id is a stated 404, not a crash", async ({ request }) => {
    const res = await request.get("/api/hunts/00000000-0000-0000-0000-000000000000");
    expect(res.status()).toBe(404);
    expect(String((await res.json()).error)).toBeTruthy();
  });
});
