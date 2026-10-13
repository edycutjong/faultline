/**
 * The probe that ships is the probe that was tested.
 *
 * probe/probe.py is exercised by probe/test_probe.py; the app injects the embedded copy into
 * every job. If someone edits one without regenerating the other, this fails.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PROBE_SHA256, PROBE_SOURCE } from "@/lib/probe-source";
import { INJECTED_FILE_MAX_BYTES } from "@/lib/nebius/jobs";

describe("embedded probe source", () => {
  it("is byte-identical to probe/probe.py", () => {
    const onDisk = readFileSync(path.join(__dirname, "..", "probe", "probe.py"), "utf8");
    expect(PROBE_SOURCE).toBe(onDisk);
    expect(PROBE_SHA256).toBe(createHash("sha256").update(onDisk, "utf8").digest("hex"));
  });

  it("fits the Jobs API's 64 KiB injected-file ceiling", () => {
    expect(Buffer.byteLength(PROBE_SOURCE, "utf8")).toBeLessThanOrEqual(INJECTED_FILE_MAX_BYTES);
  });
});
