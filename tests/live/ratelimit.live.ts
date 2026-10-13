import { it } from "vitest";
import { writeFileSync } from "node:fs";
import { loadConfig } from "@/lib/nebius/config";
import { getAccessToken } from "@/lib/nebius/auth";

it("probes the Jobs API for rate limiting", async () => {
  const result = loadConfig();
  if (!result.configured) throw new Error("not configured");
  const config = result.config;
  const token = await getAccessToken(config);
  const out: unknown[] = [];
  const list = await fetch(`https://api.nebius.cloud/ai/v1/jobs?parentId=${config.projectId}&pageSize=5`, { headers: { Authorization: `Bearer ${token}` } });
  out.push({ call: "list", status: list.status, retryAfter: list.headers.get("retry-after"), headers: Object.fromEntries([...list.headers].filter(([k]) => /rate|retry|limit|x-/i.test(k))) });
  const create = await fetch("https://api.nebius.cloud/ai/v1/jobs", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      metadata: { parentId: config.projectId, name: `faultline-ratelimit-check-${Date.now()}` },
      spec: { image: "python:3.11", containerCommand: "python3", args: "-c pass", platform: "cpu-d3", preset: "2vcpu-8gb", subnetId: config.subnetId, timeout: "3600s", disk: { type: "NETWORK_SSD", sizeBytes: String(32 * 1024 ** 3) } },
    }),
  });
  const body = await create.text();
  out.push({ call: "create", status: create.status, retryAfter: create.headers.get("retry-after"), headers: Object.fromEntries([...create.headers].filter(([k]) => /rate|retry|limit|x-/i.test(k))), body: body.slice(0, 800) });
  writeFileSync("/tmp/ratelimit.json", JSON.stringify(out, null, 2));
});
