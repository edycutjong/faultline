/**
 * The verify view's job list against the real Jobs API — read-only, no job is created.
 *
 *   npm run test:live -- tests/live/recent-jobs.live.ts
 */

import { it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { storeContext } from "@/lib/store";
import { recentProbeJobs } from "@/lib/nebius/recent-jobs";

it("lists the latest probe jobs in every region", async () => {
  const config = storeContext().config;
  if (!config) throw new Error("Nebius env not loaded");
  const out = await recentProbeJobs(config);
  writeFileSync(process.env.RECENT_OUT ?? "/tmp/recent-jobs.json", `${JSON.stringify(out, null, 1)}\n`);
  expect(out.unavailable).toEqual([]);
  expect(out.jobs.length).toBeGreaterThan(0);
});
