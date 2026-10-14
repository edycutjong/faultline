import { describe, it, expect } from "vitest";

import { detectContradiction, endpointRefusal } from "@/lib/verdicts";
import type { ProbeRole, Verdict } from "@/lib/types";
import { probe as baseProbe } from "./helpers";

function endpoint(role: ProbeRole, verdict: Verdict, detail: string | null) {
  return baseProbe(role === "good" ? 0 : 64, verdict, { commitSha: "abcdef1234567890", role, detail });
}

describe("endpointRefusal detail formatting", () => {
  it("reports a placeholder when the probe carries no detail", () => {
    const r = endpointRefusal([endpoint("good", "error", null)]);
    expect(r?.reason).toBe("good_unbuildable");
    expect(r?.explanation).toContain("(no detail reported)");
    expect(r?.explanation).toContain("abcdef1");
  });

  it("keeps only the first line of a multi-line detail, trimmed", () => {
    const r = endpointRefusal([endpoint("bad", "error", "  npm ERR! boom  \nsecond line")]);
    expect(r?.reason).toBe("bad_unbuildable");
    expect(r?.explanation).toContain("(npm ERR! boom)");
    expect(r?.explanation).not.toContain("second line");
  });

  it("truncates a first line longer than 160 characters", () => {
    const r = endpointRefusal([endpoint("good", "error", "x".repeat(200))]);
    expect(r?.explanation).toContain(`(${"x".repeat(157)}...)`);
    expect(r?.explanation).not.toContain("x".repeat(158));
  });
});

describe("detectContradiction ordering", () => {
  it("keeps the highest-index pass when a lower pass arrives later", () => {
    const hi = baseProbe(30, "pass", { commitSha: "hi".repeat(20) });
    const lo = baseProbe(10, "pass", { commitSha: "lo".repeat(20) });
    const f = baseProbe(5, "fail", { commitSha: "ff".repeat(20) });
    expect(detectContradiction([hi, lo, f])).toEqual({ passSha: hi.commitSha, failSha: f.commitSha });
  });
});
