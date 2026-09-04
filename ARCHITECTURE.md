# Architecture

**Written from the code, not from the plan.** Every claim below names the file that implements
it, so it can be checked rather than believed. Where something is not built yet, it says so.

---

## The shape of the thing

Faultline turns a broken commit range into a named commit by running the failing test on many
commits at once, each in its own container, on Nebius Serverless AI Jobs.

```
  three fields                                          Fault Report
       |                                                     ^
       v                                                     |
  POST /api/hunts ──> resolve range ──> plan band ──> dispatch N jobs
  (src/app/api/hunts/route.ts)  (src/lib/git.ts) (src/lib/planner.ts) (src/lib/nebius/jobs.ts)
       |                                                     |
       |                                    each job: clone one commit, install that
       |                                    commit's deps, run the test, write a verdict
       |                                    (probe/probe.py -> s3://bucket/<hunt>/probes/<sha>.json)
       v                                                     |
  GET /api/hunts/{id}  <──── 2s poll ────  client            |
  (the reconcile tick)                                       v
  (src/lib/hunt.ts)  ──> collect verdicts ──> narrow ──> dispatch next band
                              |
                         settled? ──> one GPU job, NVIDIA model, one paragraph
                                       (src/lib/narrate.ts, narration/narrate.py)
```

## Why N-ary and not binary

Binary bisection is optimal **when probes are sequential**, because each result informs the
next choice. Faultline's probes are simultaneous, which changes the problem: with N probes per
round the range is cut into **N+1 segments**, so it divides by **N+1**.

With N = 8 the divisor is 9:

| Range | Sequential binary | Faultline (N=8) | Chain |
|---|---|---|---|
| 64 | 6 rounds | **2 rounds** | 64 → ~8 → 1 |
| 128 | 7 rounds | **3 rounds** | 128 → ~15 → ~2 → 1 |
| 256 | 8 rounds | **3 rounds** | 256 → ~29 → ~3 → 1 |
| 1000 | 10 rounds | **4 rounds** | 1000 → ~112 → ~13 → ~2 → 1 |

Implemented in `src/lib/planner.ts` (`planBand`, `narrow`, `estimateRounds`). The round counts
in that table are not asserted from a formula — `tests/planner.test.ts` simulates the real
planner against **every possible culprit position** for each range size and takes the worst
case. `estimateRounds` itself simulates rather than computing a logarithm, so the number the
UI shows cannot drift from the search the product performs.

> `256 ÷ 8 = 32` is the divisor for a different algorithm. The correct round-1 figure is
> **~29**, and `tests/planner.test.ts` fails if it is ever 32.

We trade total compute (up to 24 job-runs vs 8) for wall-clock (3 rounds vs 8). That trade is
only rational because Serverless AI Jobs bill per second and run in parallel — which is the
remove-the-sponsor-and-it-collapses test.

## The control loop is a stateless tick

There is **no daemon and no worker**. Every `GET /api/hunts/{id}` performs one reconcile tick
(`reconcile` in `src/lib/hunt.ts`):

1. Read the hunt record.
2. For each probe without a verdict, read its verdict object; poll its job state.
3. If the current round is complete, check for a contradiction, then narrow.
4. If the range is down to one commit, settle and start narration. Otherwise dispatch the next
   band.

The client's 2-second poll is what advances the search. Nothing has to stay alive between
requests, which is what lets a hunt run on serverless hosting and survive an unattended
judging window. `reconcile` is idempotent: it only reads verdicts that already exist, so two
concurrent polls converge rather than double-dispatching.

## How a verdict actually travels

This is the load-bearing detail, and it is not what the plan assumed.

**The Serverless AI Jobs API cannot report a test result.** Verified against the API reference:

- There is **no exit-code field** anywhere in `Job`, `JobSpec`, `JobStatus`,
  `JobInstanceStatus` or `JobStateDetails`. `status.state` says `COMPLETED` or `FAILED`, but a
  test runner exits non-zero *on purpose*, so those are indistinguishable from a crash.
- **Job logs are not available over REST** — the Nebius docs state twice, verbatim, *"Checking
  job logs is available only in the web console and CLI."*

So the probe reports for itself. `probe/probe.py` writes a JSON verdict to the Object Storage
bucket mounted into the container, and `src/lib/store.ts` reads it. The object's existence is
the completion signal.

Three consequences the code makes explicit:

- **A terminal job with no verdict object is an `error`, never a `fail`** (`refreshProbe` in
  `src/lib/hunt.ts`). Recording it as a failure would narrow the range onto a commit whose test
  never ran, and blame an innocent author.
- The verdict file is written **atomically** (`probe/probe.py`), so a partially-flushed JSON is
  never read.
- A transient polling error leaves the probe pending rather than deciding a verdict.

## Honest refusal

If the verdict sequence is non-monotonic in commit order — a `pass` at a **higher** index than
a `fail` — then no single first-bad commit explains the results, and Faultline names none.
`detectContradiction` in `src/lib/verdicts.ts`, checked before narrowing in `reconcile`.

This is a pure function over verdicts already collected. **No commit is ever re-probed**, so
the honest answer costs zero extra jobs.

What is *not* a refusal: a round where every probe fails, or every probe passes. Both are
explicable — the culprit is early, or late — and both narrow correctly onto a real commit.
Refusing there would make the tool decline to answer in exactly the two positions a bisection
must handle. They earn a caveat on the report instead (`edgeCaveat`, same file), because each
rests on an assumption the hunt never probed.

## State

**No SQL, no Postgres.** One JSON object per hunt at `hunts/{id}.json` in the same Object
Storage bucket the jobs mount (`src/lib/store.ts`, key layout in `src/lib/nebius/storage.ts`).
Writes are single-writer per hunt, so there is no locking problem, and there is nothing that
can pause during an idle gap between submission and judging.

With no credentials configured the store falls back to process memory, so a cold visit to the
deploy renders rather than crashing. That fallback is deliberately not a database: a hunt that
outlives a restart is worth nothing if the jobs backing it were never dispatched.

## Sponsor surface inventory

| Surface | Where | Used for |
|---|---|---|
| Serverless AI Jobs (CPU) | `src/lib/nebius/jobs.ts` `createJob` | every probe — N concurrent, terminating, `cpu-e2`/`2vcpu-8gb` |
| Serverless AI Jobs (GPU) | `src/lib/narrate.ts` `dispatchNarration` | the NVIDIA model, one terminating job per hunt, `gpu-l40s-a`/`1gpu-8vcpu-32gb` |
| Job polling / cancel | `getJob`, `cancelJob` | reconcile tick; outstanding probes are cancelled once the answer is known, because jobs bill per second |
| Object Storage, mounted volume | `spec.volumes[].s3Config` in `createJob` | the verdict channel |
| Object Storage, S3 API | `src/lib/nebius/storage.ts` | hunt state, verdicts, narration output |
| IAM token exchange | `src/lib/nebius/auth.ts` | RS256 JWT signed with the service-account key, exchanged for a Bearer token |

**Deliberately not used:** Serverless **Endpoints** (a `RUNNING` endpoint bills continuously
and needs a human to stop and start it across the judging window — narration is one
latency-insensitive call, so a job that exits is the correct shape); **Token Factory** (it is
card-walled on this account, documented in `FEEDBACK.md` rather than faked); **Sandboxes**.

`GET /api/integrations/verify` renders the job IDs, states and API calls already on record, so
this table can be checked in thirty seconds without reading code.

## Authentication

No long-lived API key works for the Jobs API. The documented path, implemented in
`src/lib/nebius/auth.ts`:

1. Sign an RS256 JWT with the service account's authorized key (5-minute TTL).
2. `POST /oauth2/token/exchange` for a Bearer access token (12-hour TTL).
3. Cache it; re-mint ten minutes before expiry — a token expiring mid-hunt would strand
   dispatched jobs with no way to poll them.

Done with `node:crypto` rather than a JWT library, to keep a dependency off the credential
path. Object Storage uses a separate credential (an S3 access key) and SigV4, implemented in
`src/lib/nebius/sigv4.ts` and verified in `tests/sigv4.test.ts` against **AWS's own published
signature vectors** — the only way to have confidence in a signer without live credentials.

## Concurrency ceiling

`DEFAULT_BAND_SIZE = 8` is not arbitrary. The default `eu-north1` quota is **12 concurrent
non-GPU VMs**, and each probe is one VM. Eight leaves headroom for the narration job and for
retries. The GPU side is tighter — **2** L40S GPUs region-wide by default — which is why
narration is a single job and not a fan-out.

## Cost

Derived from measured job duration and published list prices, never from a constant:
`probeCostUsd` and `narrationCostUsd` in `src/lib/nebius/config.ts`. A hunt's `costUsd` is null
until at least one probe reports a duration, and the UI renders an em dash rather than a
guess.

Live hunts sit behind a **visible global daily counter** (`DAILY_LIVE_HUNT_CAP` in
`src/lib/store.ts`), so judge traffic cannot silently drain the credit balance and leave a dead
link.

## Not built yet

Stated plainly rather than implied:

- **No hunt has ever run against live Nebius infrastructure.** The account's tenant has been
  `SUSPENDED` since 21 seconds after its creation (see `FEEDBACK.md` §1), so `job create`
  returns `PermissionDenied`. Every Nebius call path is implemented and unit-tested against a
  simulated API at the HTTP boundary; none has been exercised against the real one.
- **There is therefore no recorded example hunt, and no measured wall-clock or cost figures.**
  `GET /api/examples/recorded` returns `available: false` with a reason rather than
  synthesising a run.
- The probe and narration images are built but have not been pulled by a Nebius job.
- Python-only, public GitHub repos only.
