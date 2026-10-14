import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/nebius/auth", () => ({
  getAccessToken: vi.fn(async () => "tok"),
}));

import {
  NebiusApiError,
  INJECTED_FILE_MAX_BYTES,
  cancelJob,
  createJob,
  getJob,
  getJobByName,
  listJobs,
  recentCalls,
} from "@/lib/nebius/jobs";
import type { NebiusConfig } from "@/lib/nebius/config";

const config = {
  serviceAccountId: "sa",
  authKeyId: "k",
  privateKeyPem: "pem",
  projectId: "proj-home",
  subnetId: "sub-home",
  region: "eu-north1",
} as unknown as NebiusConfig;

function ok(body: unknown, status = 200): Response {
  return { ok: true, status, statusText: "OK", json: async () => body } as unknown as Response;
}
function fail(status: number, text: string | null, statusText = "Bad"): Response {
  return {
    ok: false,
    status,
    statusText,
    text: async () => {
      if (text === null) throw new Error("boom");
      return text;
    },
  } as unknown as Response;
}
function mockFetch(res: Response) {
  return vi.fn(async () => res) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}
interface JobBody {
  spec: Record<string, unknown>;
  [k: string]: unknown;
}
function bodyOf(f: ReturnType<typeof vi.fn>): JobBody {
  return JSON.parse((f.mock.calls[0][1] as RequestInit).body as string) as JobBody;
}

describe("NebiusApiError", () => {
  it("carries status and body", () => {
    const e = new NebiusApiError("m", 418, "b");
    expect(e.name).toBe("NebiusApiError");
    expect(e.status).toBe(418);
    expect(e.body).toBe("b");
    expect(e.message).toBe("m");
  });
});

describe("createJob", () => {
  beforeEach(() => vi.clearAllMocks());

  it("builds a minimal spec with home-region defaults and returns resourceId", async () => {
    const f = mockFetch(ok({ resourceId: "job-1" }));
    const id = await createJob(config, { name: "n", image: "img" }, f);
    expect(id).toBe("job-1");
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.nebius.cloud/ai/v1/jobs");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
    });
    const b = bodyOf(f);
    expect(b.metadata).toEqual({ parentId: "proj-home", name: "n" });
    expect(b.spec.image).toBe("img");
    expect(b.spec.platform).toBe("cpu-d3");
    expect(b.spec.preset).toBe("2vcpu-8gb");
    expect(b.spec.subnetId).toBe("sub-home");
    expect(b.spec.timeout).toBe("3600s");
    expect(b.spec.disk).toEqual({ type: "NETWORK_SSD", sizeBytes: String(32 * 1024 ** 3) });
    expect(b.spec.containerCommand).toBeUndefined();
    expect(b.spec.args).toBeUndefined();
    expect(b.spec.environmentVariables).toBeUndefined();
    expect(b.spec.injectedFiles).toBeUndefined();
  });

  it("honours every option", async () => {
    const f = mockFetch(ok({ resourceId: "job-2" }));
    await createJob(
      config,
      {
        name: "n",
        image: "img",
        target: { region: "r2", projectId: "p2", subnetId: "s2" } as unknown as NonNullable<Parameters<typeof createJob>[1]["target"]>,
        containerCommand: "python",
        args: "/probe.py",
        env: { A: "1", B: "2" },
        files: [{ containerPath: "/probe.py", content: "print(1)" }],
        platform: "gpu",
        preset: "big",
        timeoutSeconds: 7200,
        diskSizeBytes: 100,
      },
      f,
    );
    const b = bodyOf(f);
    expect((b.metadata as Record<string, unknown>).parentId).toBe("p2");
    expect(b.spec).toMatchObject({
      platform: "gpu",
      preset: "big",
      subnetId: "s2",
      timeout: "7200s",
      containerCommand: "python",
      args: "/probe.py",
      environmentVariables: [
        { name: "A", value: "1" },
        { name: "B", value: "2" },
      ],
      injectedFiles: [
        { containerPath: "/probe.py", content: Buffer.from("print(1)").toString("base64") },
      ],
    });
    expect((b.spec.disk as Record<string, unknown>).sizeBytes).toBe("100");
  });

  it("floors a short timeout at 3600s", async () => {
    const f = mockFetch(ok({ resourceId: "x" }));
    await createJob(config, { name: "n", image: "i", timeoutSeconds: 10 }, f);
    expect(bodyOf(f).spec.timeout).toBe("3600s");
  });

  it("rejects empty and oversize injected files without calling fetch", async () => {
    const f = mockFetch(ok({ resourceId: "x" }));
    await expect(
      createJob(config, { name: "n", image: "i", files: [{ containerPath: "/a", content: "" }] }, f),
    ).rejects.toMatchObject({ status: 400, name: "NebiusApiError" });
    await expect(
      createJob(
        config,
        {
          name: "n",
          image: "i",
          files: [{ containerPath: "/b", content: "x".repeat(INJECTED_FILE_MAX_BYTES + 1) }],
        },
        f,
      ),
    ).rejects.toThrow(/injected file \/b is 65537 bytes/);
    expect(f).not.toHaveBeenCalled();
  });

  it("accepts a file exactly at the ceiling", async () => {
    const f = mockFetch(ok({ resourceId: "x" }));
    await createJob(
      config,
      {
        name: "n",
        image: "i",
        files: [{ containerPath: "/c", content: "x".repeat(INJECTED_FILE_MAX_BYTES) }],
      },
      f,
    );
    expect(f).toHaveBeenCalledOnce();
  });

  it("treats an empty files array as no files", async () => {
    const f = mockFetch(ok({ resourceId: "x" }));
    await createJob(config, { name: "n", image: "i", files: [] }, f);
    expect(bodyOf(f).spec.injectedFiles).toBeUndefined();
  });

  it("throws 502 when the operation has no resourceId", async () => {
    const f = mockFetch(ok({ status: { code: 3 } }));
    await expect(createJob(config, { name: "n", image: "i" }, f)).rejects.toMatchObject({
      status: 502,
      body: JSON.stringify({ status: { code: 3 } }),
    });
  });
});

describe("api error handling", () => {
  it("wraps non-ok responses, truncating the body to 1000 chars", async () => {
    const f = mockFetch(fail(500, "y".repeat(2000), "Server Error"));
    const err = await getJob(config, "a/b", f).catch((e) => e);
    expect(err).toBeInstanceOf(NebiusApiError);
    expect(err.message).toBe("GET /ai/v1/jobs/a%2Fb failed: 500 Server Error");
    expect(err.status).toBe(500);
    expect(err.body).toHaveLength(1000);
  });

  it("falls back to an empty body when text() rejects", async () => {
    const f = mockFetch(fail(503, null));
    await expect(getJob(config, "j", f)).rejects.toMatchObject({ status: 503, body: "" });
  });
});

describe("getJob / listJobs / cancelJob", () => {
  it("getJob sends a GET with no body or content-type", async () => {
    const job = { metadata: { id: "j" }, status: { state: "RUNNING" } };
    const f = mockFetch(ok(job));
    expect(await getJob(config, "j", f)).toEqual(job);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.nebius.cloud/ai/v1/jobs/j");
    expect(init.headers).toEqual({ Authorization: "Bearer tok" });
    expect("body" in init).toBe(false);
  });

  it("listJobs returns items, defaulting to the config project", async () => {
    const f = mockFetch(ok({ items: [{ metadata: { id: "1" } }] }));
    expect(await listJobs(config, undefined, f)).toHaveLength(1);
    expect(f.mock.calls[0][0]).toBe("https://api.nebius.cloud/ai/v1/jobs?parentId=proj-home");
  });

  it("listJobs returns [] when items is missing and honours an explicit project", async () => {
    const f = mockFetch(ok({}));
    expect(await listJobs(config, "other p", f)).toEqual([]);
    expect(f.mock.calls[0][0]).toContain("parentId=other%20p");
  });

  it("cancelJob posts the id", async () => {
    const f = mockFetch(ok({}));
    await expect(cancelJob(config, "j9", f)).resolves.toBeUndefined();
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.nebius.cloud/ai/v1/jobs/cancel");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ id: "j9" });
  });
});

describe("getJobByName", () => {
  it("returns the job and encodes query params", async () => {
    const job = { metadata: { id: "j" } };
    const f = mockFetch(ok(job));
    expect(await getJobByName(config, "p&1", "n a", f)).toEqual(job);
    expect(f.mock.calls[0][0]).toBe(
      "https://api.nebius.cloud/ai/v1/jobs/get-by-name?parentId=p%261&name=n%20a",
    );
  });

  it("returns null on 404", async () => {
    expect(await getJobByName(config, "p", "n", mockFetch(fail(404, "nf")))).toBeNull();
  });

  it("rethrows other API errors", async () => {
    await expect(getJobByName(config, "p", "n", mockFetch(fail(500, "x")))).rejects.toMatchObject({
      status: 500,
    });
  });

  it("rethrows non-API errors", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch;
    await expect(getJobByName(config, "p", "n", f)).rejects.toThrow("network");
  });
});

describe("recentCalls", () => {
  it("records calls and caps the log at 200", async () => {
    const f = mockFetch(ok({}));
    for (let i = 0; i < 205; i++) await cancelJob(config, String(i), f);
    const calls = recentCalls();
    expect(calls.length).toBe(200);
    const last = calls[calls.length - 1];
    expect(last).toMatchObject({ method: "POST", path: "/ai/v1/jobs/cancel", status: 200 });
    expect(typeof last.durationMs).toBe("number");
    expect(Number.isNaN(Date.parse(last.at))).toBe(false);
  });
});
