import { test, expect } from "@playwright/test";

/**
 * The zero-credential cold visit. This is what a judge gets, so it is what is tested.
 *
 * Faultline cannot dispatch a hunt without Nebius credentials, and the tenant is currently
 * suspended. That is a real state, not an error state, and the app is supposed to say so
 * plainly rather than spin or throw. These tests assert the honest degradation actually
 * works — if it ever regressed into a stack trace or an infinite spinner, the first person
 * to find out would be a judge.
 */
test.describe("cold visit, no credentials", () => {
  test("the landing page renders with the claim and both calls to action", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    const response = await page.goto("/");
    expect(response?.status()).toBe(200);

    // The h1 is the claim, not the product name — "Your laptop can only be one machine."
    // The name lives in the header link. Asserting the claim is the stronger test: if the
    // page ever loses its argument, this fails.
    await expect(page.getByRole("heading", { level: 1 }))
      .toContainText(/Your laptop can only be one machine/i);
    await expect(page.getByRole("link", { name: /integration proof/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /run a live hunt/i }).first()).toBeVisible();

    expect(errors, `uncaught page errors: ${errors.join(" | ")}`).toEqual([]);
  });

  test("the hunt form is present and asks for exactly three things", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(/Three fields\. No YAML\./i)).toBeVisible();
    for (const label of [/Repository/i, /Failing test/i, /Last known good/i]) {
      await expect(page.getByText(label).first()).toBeVisible();
    }
  });

  test("the recorded-example endpoint says why it is empty instead of failing", async ({ request }) => {
    const res = await request.get("/api/examples/recorded");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("available");
    // Once a real hunt has been recorded this flips to true and carries the run. Until then
    // it must carry a reason, never an empty object and never a fabricated example.
    if (body.available === false) {
      expect(String(body.reason)).toMatch(/recorded|Nebius|dispatch/i);
    } else {
      expect(body.hunt).toBeTruthy();
    }
  });

  test("the integration report is honest about whether Nebius is configured", async ({ request }) => {
    const res = await request.get("/api/integrations/verify");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.nebiusConfigured).toBe("boolean");
    expect(Array.isArray(body.surfaces)).toBe(true);
    expect(Array.isArray(body.recentCalls)).toBe(true);
    // The surfaces list is a claim about which APIs the product uses. It must never be empty,
    // because the README and the submission both point a judge at this endpoint.
    expect(body.surfaces.length).toBeGreaterThan(0);
  });

  test("the visible daily counter is served and bounded", async ({ request }) => {
    const res = await request.get("/api/hunts");
    expect(res.status()).toBe(200);
    const body = await res.json();
    // The cap is what keeps the demo free and unrestricted through the judging window; the
    // landing page renders it as "live hunts today: N / 10".
    expect(body.dailyCap).toBeGreaterThan(0);
    expect(body.liveHuntsToday).toBeGreaterThanOrEqual(0);
    expect(body.liveHuntsToday).toBeLessThanOrEqual(body.dailyCap);
    expect(typeof body.nebiusConfigured).toBe("boolean");
  });
});

test.describe("metadata a link unfurl depends on", () => {
  test("title, description and the Open Graph card are all present", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Faultline/i);
    for (const [sel, pattern] of [
      ['meta[name="description"]', /commit range/i],
      ['meta[property="og:title"]', /Faultline/i],
      ['meta[property="og:image"]', /og-image\.png/],
      ['meta[name="twitter:card"]', /summary_large_image/],
    ] as const) {
      await expect(page.locator(sel)).toHaveAttribute("content", pattern);
    }
  });

  test("the icon the tab shows is actually served", async ({ request }) => {
    const res = await request.get("/icon.svg");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("svg");
  });
});
