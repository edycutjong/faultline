/**
 * Read a hunt record straight from the bucket — without ticking it.
 *
 * Used to prove a hunt advances with nobody watching: every request to the app ticks the
 * hunt, so the only honest way to observe progress made by the probes' own ticks is to read
 * the record from storage directly.
 *
 *   HUNT_ID=<id> npm run test:live -- tests/live/read-hunt.live.ts
 */

import { it } from "vitest";
import { writeFileSync } from "node:fs";
import { readHunt, storeContext } from "@/lib/store";

it("reads the hunt record", async () => {
  const id = process.env.HUNT_ID ?? "";
  const hunt = await readHunt(storeContext(), id);
  const out = process.env.HUNT_OUT ?? `/tmp/hunt-${id}.json`;
  writeFileSync(out, `${JSON.stringify(hunt, null, 2)}\n`);
});
