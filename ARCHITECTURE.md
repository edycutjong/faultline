# Architecture

**Written from the code.** Every claim below names the file that implements it, and every
number names the run or the evidence file it came from, so it can be checked rather than
believed.

---

## The shape of the thing

Faultline turns a broken commit range into a named commit by running the failing test on
several commits at once, each in a fresh container that installs that commit's own declared
dependencies, on Nebius Serverless AI Jobs.

```
  repo · failing test · good ref ──> POST /api/hunts ──> resolve range (GitHub API)
  (+ install command, resolved          (src/app/api/hunts/route.ts)   (src/lib/git.ts)
   from the repo, editable)                    │
                                               ▼
                        round 1: BOTH ENDS + suspects ──> one Nebius job per probe
                        (src/lib/hunt.ts planFirstRound)  (src/lib/backend/jobs-backend.ts)
                                                               │  stock python:3.11,
                                                               │  probe.py injected as a file
                                                               ▼
               probe: fetch one commit → install its deps → run the test
               → print the JSON verdict → PUT it to its presigned URL → empty POST /tick
                                                               │
                                                               ▼
   tick (src/lib/hunt.ts) ── compare-and-swap on the hunt record ── claims for every dispatch
     collect verdicts → refuse? (endpoints, contradiction, skips) → narrow → next round
                                                               │
                                          settled ──> one Token Factory call:
                                          NVIDIA Nemotron 3 Super explains the culprit
                                          (src/lib/narrate.ts)
```

## The search

**Planner** — `src/lib/planner.ts`, pure integer arithmetic, no I/O.

- Commits are indexed `0 … M` oldest first; 0 is the known-good ref, `M` the failing ref. The
  culprit is the first bad commit and always lies in `(lowIndex, highIndex]`.
- **Round 1 tests both ends** (`firstRoundInterior`). `git bisect` takes "good passes, bad
  fails" on faith; Faultline runs both in clean containers. When the backend has room for a
  full band beside them the endpoint probes are added; otherwise they take two of its slots.
- **N probes cut a range into N+1 segments** (`planBand`), placed at `k·C/(N+1)`. N is not a
  constant: it is the backend's capacity (`effectiveBand` in `src/lib/planner.ts`,
  `probeCapacity` in `src/lib/nebius/config.ts`).
- **Untestable commits are skipped, not blamed** (`planBand(..., skipped)`): the next band is
  spread over testable commits; a skipped commit is still a candidate culprit.
- Round counts are the worst case over every culprit position, computed by simulating the real
  planner (`estimateRounds`, `estimateHuntRounds`), never from a logarithm — the "Round 2 of ~3"
  line in the UI uses the same function, so it cannot disagree with the search.

On this deployment's capacity — 2 VMs per region × 4 regions = 8 probes — a 256-commit range
needs at most 3 rounds (`tests/bandsize.test.ts`: `estimateHuntRounds(256, 8, 8) === 3`), and the
255-commit hero fixture took 3; on a single region's 2 slots it would need 7.

**Refusal** — `src/lib/verdicts.ts`, pure functions over verdicts already collected:

| Outcome | Rule | Copy the user sees |
|---|---|---|
| `good_fails` / `bad_passes` | an endpoint misbehaves in its own clean environment | "The failing ref passes in a clean environment" points at the environment, not a commit |
| `good_unbuildable` / `bad_unbuildable` | an endpoint cannot be installed or run | "Your known-good ref can't be built today" |
| `contradiction` | a `pass` at a higher index than a `fail` | names the pair; no single commit explains it |
| `skipped_range` | only untestable commits remain between the bounds | "The culprit is one of these N commits", listed |

No commit is ever re-probed to decide a refusal; each costs zero extra jobs.

## The probe and how a verdict travels

**The Jobs API cannot report a test result.** There is no exit-code field in `Job`, `JobSpec`,
`JobStatus`, `JobInstanceStatus` or `JobStateDetails`, and job logs are not available over REST
("Checking job logs is available only in the web console and CLI"). So the probe reports for
itself — `probe/probe.py`, stdlib only:

1. Shallow-fetches exactly one commit, runs the install command, runs the test — all inside its
   own deadline (`FAULTLINE_TIMEOUT_SECONDS`, default 900 s, well inside the platform's 3600 s
   job minimum), so it always lives to report.
2. Prints and flushes the JSON verdict (what `nebius ai job logs` shows a human).
3. **PUTs the verdict to a presigned URL** that authorises exactly one key — its own verdict
   object — and nothing else (`presignPut` in `src/lib/nebius/storage.ts`, signer in
   `src/lib/nebius/sigv4.ts`, checked against AWS's published query-string example).
4. Sends an **empty** `POST /api/hunts/{id}/tick`. It carries nothing; the tick reads the
   verdict from storage itself.

`pass` = the test exited 0; `fail` = the test itself exited non-zero; `error` = the commit could
not be tested (clone, install, deadline). **`error` is a skip, never a fail** — recording it as
a failure would narrow onto a commit whose test never ran.

**How probe.py reaches a stock image.** The app injects it through `spec.injectedFiles`
(`createJob` in `src/lib/nebius/jobs.ts`; ≤ 64 KiB, the script is ~22 KB) and runs
`python3 -u /opt/faultline/probe.py`. No image is built or pushed. The bytes injected are
`src/lib/probe-source.ts`, generated by `scripts/embed-probe.mjs`; `tests/probe-source.test.ts`
fails if they drift from `probe/probe.py`, whose contract `probe/test_probe.py` exercises end to
end against a local repository and HTTP server.

**The job holds no credential.** Visitor code runs inside the probe — a public repository's
`conftest.py` is arbitrary code — so there is no bucket mount and no key in the job's
environment (`JobsBackend.dispatch` in `src/lib/backend/jobs-backend.ts`; asserted on every
dispatch in `tests/hunt.integration.test.ts`). The probe also strips the verdict and tick URLs
from the environment of git, pip and the test, and scrubs SigV4 signatures from any output it
carries back.

A verdict counts only if the document is complete and names this exact probe — hunt, key and
commit (`parseVerdict` in `src/lib/store.ts`). Anything else is treated as silence.

## The control loop

There is **no daemon and no worker**. A *tick* (`tick` in `src/lib/hunt.ts`) reads the hunt,
learns what happened to each probe, and does whatever the next step needs. Three things call it:
each probe's empty tick when its verdict is stored, the page polling every two seconds
(`GET /api/hunts/{id}`), and the uptime workflow's sweep (`GET /api/cron/sweep`). A hunt
therefore advances with nobody watching — demonstrated on the first live hunt, whose record was
read straight from the bucket while no client polled (`evidence/first-live-hunt.json`).

Ticks race by design. Two rules make that safe:

1. **The hunt record is only replaced with `If-Match: <etag>`** (`replaceHunt` in
   `src/lib/store.ts`). A tick that loses re-reads and re-runs its reasoning on the newer record.
2. **Every side effect is claimed first with `If-None-Match: "*"`** — one claim per
   `(round, commit, attempt)` for a dispatch (`claimDispatch`), one per attempt for narration.
   The claim's owner records the job ID in it, so a tick that loses the record race loses
   nothing, and a dispatcher that dies mid-create is recovered by looking its deterministic job
   name up (`GET /ai/v1/jobs/get-by-name`) instead of creating a second job.

Both primitives were measured on the real bucket before anything was built on them: in 20
races of 2, 5 and 8 concurrent creators on one key, exactly one won every time, and a stale
`If-Match` was refused with 412 (`evidence/g5-conditional-writes.json`).

**Failures that are not evidence** (`refreshProbe`, `failAttempt` in `src/lib/hunt.ts`):

- A job that ends without a verdict, a malformed verdict, a vanished job, a probe past its
  deadline, a failed create: retried twice, then the hunt **pauses** and says which probe and
  why. `POST /api/hunts/{id}/resume` gives it a fresh budget. Nothing is concluded from it.
- **Throttling** — `429 Too Many Requests` on create, or a job ending `QuotaExceeded` — is waited
  out with backoff (30 s doubling to 4 min) on its own, longer budget. A tick that leaves a probe
  waiting keeps its function alive (`after()`), sleeps until the backoff ends and POSTs the
  hunt's own tick URL (`src/lib/retick.ts`). The first live hunt hit exactly this: two round-2
  creates came back 429 (`FEEDBACK.md` §4c).
- The tick that names the culprit continues straight into narration: it is usually the last
  probe's own tick, and nothing else is guaranteed to come.

## The backend, and its limits

`ProbeBackend` (`src/lib/backend/types.ts`) is four verbs — dispatch, status, find (recovering
a dispatch whose creator died) and cancel — and a capacity. `JobsBackend` implements it on Serverless AI Jobs,
`cpu-d3` / `2vcpu-8gb`, stock `python:3.11`. A Token Factory Sandboxes backend would have to
implement the same verbs; we have not been able to try one — `GET /sandboxes/v1/whoami` reports
every permission `false` on this account (`evidence/sandboxes-whoami.json`).

Measured on this tenant (2026-10-13; `evidence/smoke-jobs*.json`, `evidence/first-live-hunt.json`):

- **2 concurrent VMs per region**; a third is rejected (`QuotaExceeded`), not queued. The
  dispatcher never puts more than `slotsPerRegion` live jobs in a region (`dispatchQueued`).
- So capacity comes from regions: `eu-west1`, `uk-south1`, `uk-south2` and `me-west1`, 8 slots
  in all (`FAULTLINE_EXTRA_REGIONS`, parsed by `parseExtraRegions`). A probe in `uk-south1`
  writes its verdict into the `eu-west1` bucket over HTTPS — the presigned URL is what makes the
  regions interchangeable.
- **Cold start about 4 min 20 s** from create to workload start (258–271 s in the four-region
  smoke run; 260.6 s p50 over the hero hunt's 19 jobs), for ~5 s of work; VM time per probe
  262–288 s on the first hunt. Rounds overlap their cold starts; consecutive rounds do not.

## One live hunt at a time

The 8 slots are shared by every hunt, so a second live hunt would only starve the first into
quota rejections. `acquireLiveLock` (`src/lib/store.ts`) takes `locks/live-hunt.json` with the
same conditional writes; a second `POST /api/hunts` gets `409` and a link to the running hunt.
The lock is released when the hunt stops holding capacity, and expires after 3 h regardless.

Live hunts also count against a **visible daily cap** (`dailyCap`, default 10, floor 1),
incremented with compare-and-swap so concurrent starts each count once. A judge access code,
configured only in the deployment's environment, lifts the cap — never the lock.

## Narration — NVIDIA Nemotron on Nebius Token Factory

One `POST /v1/chat/completions` per hunt to `nvidia/nemotron-3-super-120b-a12b`
(`src/lib/narrate.ts`), after test execution has already named the culprit: the diff, the
failing test's output, and an instruction to write one paragraph. Nemotron 3 Super is a
reasoning model — with a small budget it can return its reasoning and no answer — so the call
asks for `reasoning_effort: "low"` with `max_tokens: 4096` and reads `content` only.
An empty answer is a narration error, never invented prose. The model explains; it never
decides.

## Authentication

1. Sign an RS256 JWT with the service account's authorized key (`signJwt`, `node:crypto`, no
   JWT library on the credential path).
2. `POST /oauth2/token/exchange` for a 12-hour Bearer token; re-mint ten minutes early.
3. Object Storage uses a separate S3 access key and SigV4 (`src/lib/nebius/sigv4.ts`), checked
   against AWS's own published vectors in `tests/sigv4.test.ts`.

All of it stays in the app. A probe job receives none of it.

## Cost

Measured VM time × today's list price: `huntCostUsd` in `src/lib/pricing.ts` (`cpu-d3` from
1 October 2026: $0.015 per vCPU-hour, $0.0045 per GiB-hour; before that, $0.012 and $0.0032).
VM time is Nebius's own create→finish for each job once it has ended; until then,
dispatch→verdict, replaced by the job's figure on a later read (`billedMs`; `settleBill` in
`src/lib/hunt.ts`). The engine writes a snapshot into the hunt's `costUsd` as it goes, but nothing
reads it back: the UI and `scripts/bench.py` re-derive the cost from the probes' VM time, so a
price change re-prices old hunts instead of leaving stale figures on screen.

## State

No database. One JSON object per hunt (`hunts/{id}.json`), plus claims, verdicts, the lock and
the daily counter, all in one Object Storage bucket (key layout: `keys` in
`src/lib/nebius/storage.ts`). Without credentials the same operations run against process
memory with the same 412 semantics (`MemoryKv`), so a cold visit renders.

## Limits

- Python test suites, public GitHub repositories.
- A round costs about 4 min 20 s of cold start, more when job creation is throttled. For a fast suite a careful local bisect that builds a
  fresh environment per step finishes sooner; Faultline's case is correctness without writing
  that harness, both ends verified, and the work off your machine.
- One live hunt at a time on this deployment's 8 slots.
