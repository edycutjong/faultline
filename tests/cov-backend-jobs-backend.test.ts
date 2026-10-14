import { describe, it, expect, vi, beforeEach } from "vitest";

const jobs = vi.hoisted(() => {
  class NebiusApiError extends Error {
    constructor(public status: number, message = "x") {
      super(message);
    }
  }
  return {
    NebiusApiError,
    createJob: vi.fn(),
    getJob: vi.fn(),
    getJobByName: vi.fn(),
    cancelJob: vi.fn(),
  };
});
vi.mock("@/lib/nebius/jobs", () => jobs);

import { JobsBackend, PROBE_PATH } from "@/lib/backend/jobs-backend";
import type { NebiusConfig } from "@/lib/nebius/config";

const config = {
  probeImage: "python:3.11",
  slotsPerRegion: 3,
  probeRegions: [
    { region: "eu-west1", projectId: "p1", subnetId: "s1" },
    { region: "uk-south1", projectId: "p2", subnetId: "s2" },
  ],
} as unknown as NebiusConfig;

const launch = {
  name: "n",
  region: "uk-south1",
  huntId: "h",
  probeKey: "k",
  repoUrl: "u",
  commitSha: "c",
  testCommand: "t",
  installCommand: "i",
  verdictUrl: "v",
  tickUrl: null as string | null,
  timeoutSeconds: 60,
};

beforeEach(() => vi.resetAllMocks());

describe("JobsBackend (mocked jobs api)", () => {
  it("exposes regions, slots and capacity", () => {
    const b = new JobsBackend(config, vi.fn() as unknown as typeof fetch);
    expect(b.regions).toEqual(["eu-west1", "uk-south1"]);
    expect(b.slotsPerRegion).toBe(3);
    expect(b.capacity()).toBe(6);
  });

  it("dispatches with tick url and default fetch", async () => {
    jobs.createJob.mockResolvedValue("job-1");
    const b = new JobsBackend(config);
    const r = await b.dispatch({ ...launch, tickUrl: "https://tick" });
    expect(r).toEqual({ runId: "job-1" });
    const [cfg, spec, f] = jobs.createJob.mock.calls[0];
    expect(cfg).toBe(config);
    expect(f).toBe(fetch);
    expect(spec.target.projectId).toBe("p2");
    expect(spec.args).toBe(`-u ${PROBE_PATH}`);
    expect(spec.env.FAULTLINE_TICK_URL).toBe("https://tick");
  });

  it("omits the tick url when absent and rejects unknown regions", async () => {
    jobs.createJob.mockResolvedValue("job-2");
    const b = new JobsBackend(config, vi.fn() as unknown as typeof fetch);
    await b.dispatch(launch);
    expect(jobs.createJob.mock.calls[0][1].env.FAULTLINE_TICK_URL).toBeUndefined();
    await expect(b.dispatch({ ...launch, region: "nope" })).rejects.toThrow(/not configured/);
  });

  it("maps a full job status", async () => {
    jobs.getJob.mockResolvedValue({
      metadata: { createdAt: "c" },
      status: { state: "COMPLETED", startedAt: "s", finishedAt: "f", stateDetails: { code: "OK", message: "m" } },
    });
    const b = new JobsBackend(config, vi.fn() as unknown as typeof fetch);
    expect(await b.status("j")).toEqual({
      state: "COMPLETED", terminal: true, createdAt: "c", startedAt: "s", finishedAt: "f", code: "OK", message: "m",
    });
  });

  it("maps a sparse job status to nulls", async () => {
    jobs.getJob.mockResolvedValue({ metadata: {}, status: { state: "RUNNING" } });
    const b = new JobsBackend(config, vi.fn() as unknown as typeof fetch);
    expect(await b.status("j")).toEqual({
      state: "RUNNING", terminal: false, createdAt: null, startedAt: null, finishedAt: null, code: null, message: null,
    });
  });

  it("returns null on 404 and rethrows other errors", async () => {
    const b = new JobsBackend(config, vi.fn() as unknown as typeof fetch);
    jobs.getJob.mockRejectedValueOnce(new jobs.NebiusApiError(404));
    expect(await b.status("j")).toBeNull();
    const e500 = new jobs.NebiusApiError(500);
    jobs.getJob.mockRejectedValueOnce(e500);
    await expect(b.status("j")).rejects.toBe(e500);
    const plain = new Error("boom");
    jobs.getJob.mockRejectedValueOnce(plain);
    await expect(b.status("j")).rejects.toBe(plain);
  });

  it("finds a job by name in the region's project", async () => {
    const b = new JobsBackend(config, vi.fn() as unknown as typeof fetch);
    jobs.getJobByName.mockResolvedValueOnce({ metadata: { id: "j9" } });
    expect(await b.find("n", "uk-south1")).toEqual({ runId: "j9" });
    expect(jobs.getJobByName.mock.calls[0][1]).toBe("p2");
    jobs.getJobByName.mockResolvedValueOnce(null);
    expect(await b.find("n", "eu-west1")).toBeNull();
  });

  it("cancels a job", async () => {
    const f = vi.fn() as unknown as typeof fetch;
    jobs.cancelJob.mockResolvedValue(undefined);
    await new JobsBackend(config, f).cancel("j");
    expect(jobs.cancelJob).toHaveBeenCalledWith(config, "j", f);
  });
});
