# Feedback for Nebius and the hackathon organisers

Written 2026-09-04, updated 2026-09-10 and 2026-10-13, while building
[Faultline](./README.md), which runs its probes on Nebius AI Cloud Serverless AI Jobs and its
narration on Nebius Token Factory.

Everything below is reproducible and dated. Where something blocked us, we say what we did
next, because a report that only complains is less useful than one that shows the workaround.

---

## 1. A new tenant is suspended at signup, with no notification and no stated path out

**This is the highest-impact issue we hit, by a wide margin.** It stopped the project's engine
for 46 days; it cleared on 2026-10-13 (see the end of this section).

- Tenant `tenant-e00rzrgpcth7hvbajg` was created `2026-08-28T04:32:42Z` and its
  `status.suspension_state` became `SUSPENDED` at `2026-08-28T04:33:03Z` — **21 seconds after
  creation**, before a single API call was made.
- Re-verified `2026-09-04` with a freshly issued federation token — still `SUSPENDED`, so the
  original failure was not an expired-credential artefact.
- Re-verified again `2026-09-10`: still `SUSPENDED`, **thirteen days later**, with no email, no
  console banner, and no reply to a support enquiry.

What makes this expensive is not the suspension itself but how it presents:

| Surface | What it does under suspension |
|---|---|
| `nebius iam tenant list` | Succeeds, and correctly shows `suspension_state: SUSPENDED` |
| `nebius iam project list` | Returns `{}` — an **empty list**, not an error |
| `nebius ai job list` | Returns `{}` — an **empty list**, not an error |
| `nebius ai job create` | `PermissionDenied: you do not have permission to access the requested object` |

A developer reads "empty project list" as "I have not created a project yet" and
`PermissionDenied` as "my IAM roles are wrong". Both send you down a long, wrong diagnostic
path. Neither mentions the tenant is suspended, even though the API plainly knows it is.

**Three changes would have saved us a week:**

1. Have `PermissionDenied` say so when the cause is tenant suspension. The error already
   carries a `Trace ID`; a `suspension_state=SUSPENDED` hint costs nothing and ends the
   investigation immediately.
2. Do not return an empty list for a resource collection the caller cannot see because of a
   tenant-level hold. An error is honest; `{}` is misleading.
3. Email on suspension. We received nothing at signup, and there is no self-service banner
   explaining what triggered it or how to clear it.

We understand new-account holds exist for good anti-abuse reasons. The problem is silence, not
the hold.

**How it ended (2026-10-13, 46 days after signup).** The suspension cleared at
`2026-10-13T12:16:02Z` — about **one minute** after we added a payment card and topped up $25
(card payment logged `12:15Z`). So the hold was a payment-method requirement. Nothing at signup,
in the CLI errors, or in the docs says that adding a card is what lifts it; one sentence in the
`PermissionDenied` message would have saved 46 days.

A smaller trap on the way out: the v2 command `nebius iam v2 tenant list` reports
`tenant_state: ACTIVE` while the v1 `nebius iam tenant list` reports `suspension_state:
SUSPENDED` for the same tenant at the same moment. `tenant_state` is a lifecycle field, but it
reads as "you are fine".

## 2. Token Factory presents a credit-card wall at first access

The hackathon grants **$25 in Token Factory credits** (activation code
`NEBIUS-DEVPOST-GLOBAL26`). Token Factory requires a payment method to be attached before
first use. The granted credit is therefore unreachable for any participant who cannot or will
not attach a card — which, for a global hackathon with a large student entry, is a meaningful
fraction of the field.

This directly changed what we built. Our first project design used Token Factory Sandboxes as
its engine; we dropped it the day we found the wall and rebuilt on AI Cloud Serverless AI Jobs.

**Update 2026-10-13.** With a card attached, Token Factory inference works, and Faultline now
makes its one narration call there (`nvidia/nemotron-3-super-120b-a12b`). Sandboxes is still
closed to us: `GET /sandboxes/v1/whoami` answers 200 with every permission `false` (`import`,
`spawn`, `spawn_disposable`, `list`, `cancel`, `set_image_tag`) while the beta-access request is
pending — a clear, honest answer, which we appreciated.

**Update 2026-10-14.** Beta access arrived: the same request now reports all six permissions
`true` (`evidence/sandboxes-whoami-2026-10-14.json`). Faultline's probes still run on Serverless
AI Jobs; a Sandboxes backend is not built.

**Suggestion:** let a promo activation code stand in for the card, at least up to the credit
value. A prize that cannot be spent is not a prize.

### This is not one participant's local problem

We initially reported this as our own account trouble. It is not. As of 2026-09-10 the event's
own discussion board carries a thread — *"Token Factory billing — country (Ghana) not
selectable, blocking account activation"* — in which **four participants in three countries
describe the same outcome through different mechanisms**:

| Country | Mechanism | Outcome |
|---|---|---|
| Ghana | Country absent from the billing country list | Cannot activate |
| Kyrgyzstan | Country absent from the list (neighbours present); `/settings/billing` 404s | Cannot activate |
| Indonesia | Country present; locally-issued Visa **and** Mastercard both declined at card verification | Cannot activate |
| Indonesia (us) | AI Cloud tenant suspended 21s after signup (§1) | Cannot create resources |

None of the four are excluded by the Official Rules, and all four hold the hackathon's $25
promo code. The billing country list has 65 entries; the hackathon is advertised as global and
had over 3,300 registered participants when we wrote this (2026-09-10) — the event page shows
22,638 on 2026-10-13.

The shape of the problem is that **eligibility and access are decided by two different
systems.** Devpost accepted every one of these registrations; the Nebius onboarding funnel then
declined them, for reasons that have nothing to do with the rules. Every one of these
participants must, per those same rules, make a runtime call to Nebius in order to submit at
all.

**Suggestion, concretely:** for a sponsored hackathon, provision participant accounts from the
registration list with the credit pre-attached, and skip card verification up to the credit
value. Failing that, publish a named support path for onboarding failures before the event
opens — the current path is a public forum thread and a hope.

## 3. The Builder Program link on the Resources page 404ed (fixed since)

The event's Resources tab linked to `dev.nebius.com/builders` **without a URL scheme**. A
schemeless `href` resolves relative to the current origin, so the anchor pointed at
`https://nebiusglobalaihackathon.devpost.com/dev.nebius.com/builders` and 404ed.

Participants who followed that link could conclude the Builder Program was closed and miss a
further $25 in credits plus Tavily credits. **Re-checked 2026-10-14: the page now links
`https://dev.nebius.com/builders` with its scheme, and it answers 200.** Thank you — the
one-prefix fix landed.

## 4. Serverless AI Jobs has no exit code and no logs over REST

This is a genuine API design gap, and it shaped our architecture.

- **No exit code.** There is no `exitCode` field anywhere in the `Job`, `JobSpec`, `JobStatus`,
  `JobInstanceStatus` or `JobStateDetails` schemas. `status.state` distinguishes `COMPLETED`
  from `FAILED`, but a container that exits non-zero on purpose — which is exactly what a test
  runner does — is indistinguishable from one that crashed.
- **No logs over REST.** `serverless/jobs/manage` and `serverless/quickstart/jobs` both state
  verbatim: *"Checking job logs is available only in the web console and CLI."* Every other
  operation in those documents has a REST tab; logs do not.

Together these mean **a job cannot report a result to a programmatic caller through the Jobs
API at all.** Our first workaround mounted an Object Storage bucket into every job, read-write,
and had the container write a JSON verdict file. We replaced it on 2026-10-13: a probe runs a
stranger's test suite, so anything mounted into it is the stranger's — including every other
hunt's records. Each probe now gets one **presigned PUT URL** for its own verdict object and no
credential at all. That works across regions too (a `uk-south1` job writes into an `eu-west1`
bucket over HTTPS), and we would defend it as the right design — but we arrived at it by
elimination, not by choice.

**Suggestion:** expose the container's exit code on `JobStatus`. It is one integer, the
platform already has it, and it would remove the need for a side channel in the most common
batch-job shape there is: *run a thing, tell me if it worked.*

## 4b. Measured on a new tenant: 2 jobs per region, and the third is rejected, not queued

Measured 2026-10-13, all in one session, reproducible with `nebius ai job create`:

| What | Measured |
|---|---|
| `compute.instance.count` per region | **2**. Three jobs launched together in one region → two `COMPLETED`, the third `ERROR`, `QuotaExceeded`: *"Quota limit exceeded. Exceeded limit for container tenant-e00rzrgpcth7hvbajg, quota compute.instance.count."* (`evidence/quota-third-job-rejected.json`). The compute pricing/quotas page reads as 12 non-GPU VMs. |
| Rejected vs queued | **Rejected.** A batch product that rejects instead of queueing pushes a scheduler into every caller. |
| CPU quota in `eu-north1` | **0 vCPU** on this tenant, so `cpu-e2` (eu-north1 only, and home of the smallest `2vcpu-8gb` preset) is unusable; `cpu-d3/2vcpu-8gb` in `eu-west1` works. |
| Cold start, stock `python:3.11` (~1 GB) on `cpu-d3/2vcpu-8gb` | create → workload start **4 m 18 s – 4 m 31 s** across four regions (`evidence/smoke-jobs*.json`; the first job, `evidence/spike-job.json`, took 4 m 28 s). Polled every 15 s: `STARTING` from about 1 min, `IMAGE_PULLING` from about 3 min, the workload at about 4 min 20 s. The workload itself (clone, install, 297 tests) took **4.8 s**. |
| Parallel cold starts | Overlap well: one job alone, two in flight together and a hunt round of eight (4 regions × 2) all reached workload start 4 m 12 s – 4 m 39 s after creation (`evidence/spike-job.json`, `evidence/smoke-jobs*.json`, `evidence/bench/hero-faultline-1.json`). |

**Suggestions:** queue over-quota jobs (or offer a flag to), and state the per-region instance
count for new tenants where the quota is documented. On the jobs quickstart, say both halves of the
cold start: provisioning and `STARTING` (about 3 minutes here) are fixed platform overhead, while
image pull (the last 70–80 s for a ~1 GB image, about 30% of the total) grows with image size
and is the part a user can shrink.

## 4c. Job creation is throttled, and the limit is not documented

Measured 2026-10-13 on hunt `295a5c3c`: eight jobs were created at 15:42 UTC (two in each of
four regions, all accepted). About five minutes later the next two creates returned
**`429 Too Many Requests`** — three times over ~1½ minutes, from separate requests — while a
single create we then sent by hand at 15:48:36 was accepted (`evidence/create-throttle-check.json`).
The docs state no rate limit for the Jobs API, and the 429 carried no `Retry-After` header. That
accepted create took **11.6 s** server-side (`x-envoy-upstream-service-time: 11635`).

It recurred on the next hunt (`827dfe7e`, 16:00 UTC): of a round's eight creates, sent four at a
time, six were accepted and two were refused with 429; both were accepted on the first retry 30 s
later. We now treat 429 as backoff (30 s, doubling to 4 min) and dispatch at most four creates at
a time. **Suggestions:** document the create rate limit, send `Retry-After` with a 429, and
consider a batch create — a fan-out workload creates its jobs in bursts by definition.

## 5. `--volume s3://bucket:/path:rw:profile` — the `profile` argument is undocumented

The CLI documents the mount syntax and says *"The `profile` is the AWS credentials profile to
use"*, but nowhere in the docs is it stated which file the container reads (`~/.aws/credentials`?),
under which user, or whether `AWS_PROFILE` is honoured. There is no example of the file's
contents.

The REST API's structured `s3Config` object (inline `accessKeyId`/`secretAccessKey`) is fully
specified and we used that instead. But a CLI user has no equivalent escape hatch, and the CLI
is what the quickstart teaches.

## 6. Smaller things

- **Docs vs. reality on GPU quota.** The default `eu-north1` allowance is **2** L40S GPUs for
  regular VMs. That is easy to miss, and it caps concurrent GPU jobs at one for most presets.
  Worth stating on the Serverless AI quotas page rather than only in the Compute quota tables,
  since Serverless AI is where people will hit it.
- **`POST /ai/v1/jobs/restart` has no prose documentation** — only an OpenAPI stub. What
  "restart" means for a batch job is not explained anywhere.
- **No refresh-token flow is documented** for the service-account access token. The only
  documented path is minting a fresh RS256 JWT and re-running the exchange every 12 hours.
  That is fine, but say so explicitly — we spent time looking for the refresh grant.
- **`OpenCodeReasoning-Nemotron-14B` model card is internally inconsistent**: it states
  *"Engine: vLLM"* under Inference but the only code sample uses `transformers.pipeline`.
- **Event page:** Toronto and Mexico City link to the same Luma event.
- **City Winner Awards eligibility is contradictory** between the Official Rules (which say
  attending) and the Resources page (which says attendance is not needed).
- **The prize-stacking sentence is ambiguous.** *"Each Project is eligible for one (1) Overall
  Award OR one (1) Track Award and one (1) Bonus Award"* parses two ways depending on whether
  the `OR` or the `and` binds tighter: either an Overall Award excludes a Bonus Award, or it
  does not. That changes how a team allocates effort across the bonus tracks.

---

## What we would keep exactly as it is

- **Per-second billing.** A probe's VM lives about 4 min 20 s for ~5 seconds of work and costs
  about half a cent at list price ($0.0948 for the 19 jobs of our 255-commit hunt). Billing by
  the second keeps that honest.
- **`spec.injectedFiles`.** It let us run every probe on the stock `python:3.11` image with our
  23 KB probe script written into the container at launch — no image build, no registry, no
  credentials for either. A small field that removed a whole step.
- **`GET /ai/v1/jobs/get-by-name`.** With deterministic job names it gives a crashed dispatcher
  a way to find the job it may have created, instead of creating a second one.
- **Conditional writes in Object Storage.** `If-None-Match: "*"` and `If-Match` behave exactly as
  documented: in 20 races of 2 to 8 concurrent creators on one key, exactly one won every time.
  Our whole control loop — no daemon, no database — rests on that.
- **Job lifecycle states are well chosen.** `PROVISIONING → STARTING → IMAGE_PULLING → RUNNING
  → COMPLETED` gave us exactly the granularity we needed for a progress UI, and the
  `NotEnoughResources` / `TimeoutExceeded` / `ContainerFailed` cause codes are genuinely
  actionable.
- **The docs are unusually complete.** We wrote a full REST client for Jobs, IAM token
  exchange and Object Storage entirely offline from the documentation, with no live API access
  — and when the account opened, the client worked against the real API first time. The gaps
  above are the exceptions. That is a good ratio.
