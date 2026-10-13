# Faultline probe

One job = one git commit = one verdict.

A Faultline hunt dispatches each round of probes in parallel as Nebius Serverless AI Jobs.
Each job checks out exactly one commit, installs *that commit's own* declared dependencies
from scratch, runs the failing test, and reports.

## How it reaches a job

On the default path there is **no custom image**. Every probe job runs the stock
`python:3.11` image (it ships git and pip), and the application injects `probe.py` into the
container at creation through the Jobs API's `spec.injectedFiles` (≤ 64 KiB; this file is
~22 KB). The entrypoint is `python3 -u /opt/faultline/probe.py`. The bytes the app injects
are `src/lib/probe-source.ts`, generated from this file by `scripts/embed-probe.mjs`;
`tests/probe-source.test.ts` fails if the two ever drift.

The `Dockerfile` here builds an optional slimmer image (non-root, `uv`, pre-seeded pytest).
It is not used by the deployed app: in the four smoke jobs the image pull took 79–95 s of a
cold start that runs about 4 min 20 s (`evidence/smoke-jobs*.json`, `DEMO.md`), so a prebuilt
slim image is a later optimisation, not a dependency.

## Why the probe has to self-report

The Jobs REST API exposes **no exit code** and **no logs**. Nothing the process returns
reaches the application. So the probe reports in three steps, in this order:

1. **Prints and flushes its JSON verdict** to stdout — what a human sees in `nebius ai job logs`.
2. **PUTs the same document to `FAULTLINE_VERDICT_URL`** — a presigned Object Storage URL
   that authorises exactly one key, this probe's own verdict object, until it expires.
3. **Sends an empty `POST` to `FAULTLINE_TICK_URL`** — "something landed, reconcile now".
   It carries nothing; the application reads the verdict from storage itself.

That is what lets a hunt advance with nobody watching. A probe that dies before step 2 is
noticed by the next reconcile (or the uptime sweep), retried, and never read as a verdict.

## The job holds no credential

Visitor code runs inside the probe — any public repository's `conftest.py` is arbitrary
code. So nothing in the job can write anywhere but its own verdict object: there is no
bucket mount, no access key, no service-account key in the environment. `probe.py` also
removes `FAULTLINE_VERDICT_URL` and `FAULTLINE_TICK_URL` from the environment of git, pip
and the test, and scrubs any SigV4 signature from output it carries back.

## Input contract — environment variables

| Variable | Required | Meaning |
|---|---|---|
| `FAULTLINE_HUNT_ID` | yes | Hunt this probe belongs to. |
| `FAULTLINE_PROBE_KEY` | yes | `r<round>-i<index>-<sha12>-a<attempt>` — names the verdict object. |
| `FAULTLINE_REPO_URL` | yes | Git URL to fetch from. |
| `FAULTLINE_COMMIT_SHA` | yes | The one commit to test. |
| `FAULTLINE_TEST_COMMAND` | yes | `shlex`-split and run without a shell in the checkout root. |
| `FAULTLINE_INSTALL_COMMAND` | no | e.g. `pip install -e .[test]`. Empty = detect from the commit's files. |
| `FAULTLINE_VERDICT_URL` | yes* | Presigned PUT URL for the verdict. (*Local runs may use `FAULTLINE_OUTPUT_PATH` instead.) |
| `FAULTLINE_TICK_URL` | no | Where to send the empty reconcile request. |
| `FAULTLINE_TIMEOUT_SECONDS` | no | The probe's own deadline for clone + install + test. Default 900. |

## Output contract — the verdict document

A `faultline.probe.v2` document matching `ProbeResult` in `src/lib/types.ts`:

```json
{
  "schema": "faultline.probe.v2",
  "huntId": "<hunt uuid>",
  "probeKey": "r<round>-i<index>-<sha12>-a<attempt>",
  "commitSha": "<40-hex sha>",
  "verdict": "fail",
  "exitCode": 1,
  "durationMs": 4800,
  "installCommand": "pip install -e .[test]",
  "timings": { "cloneMs": 700, "installMs": 3100, "testMs": 1000 },
  "detail": "deps: pip install -e .[test]; test exited 1",
  "tail": "E   AssertionError …"
}
```

The application accepts a verdict only if the document is complete and names this exact
probe (hunt, key and commit). Anything else is treated as silence: retried, never narrowed on.

## Verdict semantics

| Verdict | Means | `exitCode` |
|---|---|---|
| `pass` | The test command exited 0. | `0` |
| `fail` | The test command itself exited non-zero. | the code |
| `error` | The commit could not be tested: clone, checkout or install failed, or the probe's own deadline passed. The app treats it as `git bisect skip`. | `null` |

**The pass/fail/error split is the correctness backbone.** An `error` recorded as a `fail`
would narrow the bisection and blame an innocent commit.

## Deadline

`FAULTLINE_TIMEOUT_SECONDS` is one budget every step draws from (clone and install are each
capped to a share of it, the test gets what is left), well inside the platform's 3600 s job
minimum — so the probe always lives long enough to report, even when the test hangs.

Process exit code: `0` whenever a verdict was delivered (pass, fail or error), `2` if it
could not be. The job's own state is therefore an infrastructure signal: `COMPLETED` means
"reported", `FAILED` means "could not report", which the application retries.

## Tests

```sh
python3 -m unittest probe/test_probe.py -v
```

Runs the real `probe.py` against a throwaway local git repository and a local HTTP server
standing in for the presigned URL and the tick endpoint: pass, fail, unbuildable commit,
missing commit, a hanging test against the probe's own deadline, an undeliverable verdict,
and that visitor code never sees the capability URLs.
