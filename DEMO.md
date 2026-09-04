# Demo

Every command below was run on 2026-09-04, and the output shown is what it actually printed.
Where a step cannot be run yet, it says so instead of showing an invented result.

**Nothing here requires a Nebius account.** The parts that do are marked, and they are the
parts that do not work yet — see [Why there is no live hunt](#why-there-is-no-live-hunt).

---

## 1. The test suite (30 seconds, no credentials)

```bash
npm install
npm test
```

Observed:

```
 ✓ tests/sigv4.test.ts (13 tests)
 ✓ tests/issue.test.ts (8 tests)
 ✓ tests/verdicts.test.ts (39 tests)
 ✓ tests/planner.test.ts (36 tests)
 ✓ tests/hunt.integration.test.ts (8 tests)

 Test Files  5 passed (5)
      Tests  104 passed (104)
```

The two worth opening:

- **`tests/planner.test.ts`** proves the claim the product is built on. It does not check a
  formula — it simulates the real planner against *every possible culprit position* for each
  range size and takes the worst case. The N+1 divisor is pinned directly:
  `planBand(0, 256, 8) === [28, 57, 85, 114, 142, 171, 199, 228]`, and the worst range
  surviving round 1 is asserted `=== 29` and `< 32`. A `256 → 32` trail fails the suite.
- **`tests/hunt.integration.test.ts`** runs a whole hunt through the real dispatch and
  reconcile code with Nebius simulated at the HTTP boundary, and asserts *3 rounds, at most 24
  job-runs, correct culprit* — against the system as shipped, not the planner in isolation.

## 2. The app, cold, with no environment variables

```bash
npm run build && npm start
```

```bash
curl -s localhost:3000/api/hunts
```

Observed:

```json
{"liveHuntsToday":0,"dailyCap":10,"nebiusConfigured":false}
```

```bash
curl -s localhost:3000/api/examples/recorded
```

Observed:

```json
{"available":false,"reason":"No recorded hunt has been captured yet. A recording is a real run against live Nebius Serverless AI Jobs, so it cannot be produced until the account can dispatch them."}
```

That is the honest state, and the landing page renders it as a designed panel rather than an
error. **No sample hunt is fabricated anywhere in this repository.**

## 3. Resolving a real commit range (needs network, not Nebius)

This is the first half of a hunt and it works today against the live GitHub API.

```bash
curl -s -X POST localhost:3000/api/hunts \
  -H 'Content-Type: application/json' \
  -d '{"repoUrl":"https://github.com/psf/requests",
       "testCommand":"pytest tests/test_requests.py::TestRequests::test_entry_points",
       "goodRef":"v2.31.0","badRef":"v2.32.0"}'
```

Observed:

```
commits      : 127
round        : 1
probe indices: [14, 28, 42, 56, 71, 85, 99, 113]
first commit : 6e5b15d542 Fix linting issues
last commit  : d6ebc4a2f1 v2.32.0
```

**Check the arithmetic yourself.** 127 candidates, 8 probes: 127 ÷ 9 ≈ 14.1, and the probes
land on multiples of 14. That is the N+1 divisor on real data. Under a ÷8 divisor they would
sit ~15.9 apart.

Every probe then reports `verdict: "error"` with
`"Nebius is not configured, so no probe job could be dispatched."` — the honest result, not a
silent failure and not a fabricated pass.

## 4. The probe container, run directly (needs network, not Nebius)

`probe/probe.py` is stdlib-only, so it runs without Docker. This is the exact code the
container executes. All three verdict paths, run against a real commit in `pallets/click`:

**Pass** — the test exits 0:

```json
{"schema": "faultline.probe.v1", "huntId": "localtest",
 "commitSha": "874ca2bc1c30d93a4ac6e36a15ed685eafe89097",
 "verdict": "pass", "exitCode": 0, "durationMs": 2288,
 "detail": "deps: setup.py + uv pip install -e .; test exited 0", "tail": null}
```

**Fail** — the test itself exits non-zero:

```json
{"verdict": "fail", "exitCode": 3, "durationMs": 2353,
 "detail": "deps: setup.py + uv pip install -e .; test exited 3"}
```

**Error** — the commit does not exist, so the test never ran:

```json
{"verdict": "error", "exitCode": null, "durationMs": 1141,
 "detail": "git step failed (exit 128): git fetch --quiet --depth 1 origin deadbeef...",
 "tail": "fatal: remote error: upload-pack: not our ref deadbeef..."}
```

**That third case is the one that matters.** A container that could not run the test reports
`error`, never `fail`. A `fail` narrows the search; recording a broken probe as a failure
would blame a commit whose test never ran. The distinction is asserted in
`tests/hunt.integration.test.ts` ("records an error, not a fail, when a job finishes without
writing a verdict").

Reproduce it:

```bash
mkdir -p /tmp/faultline-out
FAULTLINE_HUNT_ID=localtest \
FAULTLINE_REPO_URL=https://github.com/pallets/click \
FAULTLINE_COMMIT_SHA=874ca2bc1c30d93a4ac6e36a15ed685eafe89097 \
FAULTLINE_TEST_COMMAND='python -c "import sys; sys.exit(0)"' \
FAULTLINE_OUTPUT_PATH=/tmp/faultline-out \
python3 probe/probe.py
```

## 5. The SigV4 signer, checked against AWS

```bash
npx vitest run tests/sigv4.test.ts
```

13 tests, five of which assert **AWS's own published signature values** for their published
example requests. Without live credentials that is the only way to know a signer is correct,
so it is how this one is verified rather than by inspection.

---

## Why there is no live hunt

The second half of a hunt — dispatching probes as Nebius Serverless AI Jobs — has never run.

The account's tenant has been `SUSPENDED` since **21 seconds after it was created**
(`created_at 2026-08-28T04:32:42Z`, `updated_at 2026-08-28T04:33:03Z`), so every create call
returns `PermissionDenied`. Re-verified with a fresh token on 2026-09-04:

```
$ nebius ai job create --name faultline-spike-probe --image python:3.11-slim \
    --platform cpu-e2 --preset 2vcpu-8gb --dry-run
Error: rpc error: code = PermissionDenied desc = you do not have permission to
access the requested object
```

Consequently, and stated plainly:

- **No wall-clock or cost figure appears anywhere in this repository.** Not in the README, not
  in the UI, not here. The app renders an em dash where a measured cost would go.
- **There is no recorded example hunt**, because a recording means real job IDs from a real
  run.
- The probe and narration images have not been pulled by a Nebius job.

Every Nebius call path is implemented against the documented API and exercised by tests
against a simulation at the HTTP boundary. None has met the real service. That gap is the
honest boundary of this submission, and it is described further in [`FEEDBACK.md`](FEEDBACK.md)
§1, where it is also the lead item of feedback to Nebius — because the way suspension presents
itself (an empty project list, and a `PermissionDenied` that never mentions it) is what made it
cost a week.

## What to run first, if you have five minutes

1. `npm test` — 104 tests, no setup.
2. Open `tests/planner.test.ts` and read `worstCaseRounds`. That function is the product's
   central claim, written so it cannot flatter itself.
3. `curl` the range-resolution example in §3 and check the probe spacing arithmetic.
4. Read the "What is not true yet" section of the [README](README.md#-what-is-not-true-yet).
