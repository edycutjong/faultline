# Faultline probe container

One container = one git commit = one verdict.

A Faultline hunt dispatches N of these in parallel as Nebius Serverless AI Jobs. Each
job checks out exactly one commit, installs *that commit's own* declared dependencies
from scratch, runs the failing test, and self-reports.

## Why the container has to self-report

The Nebius Serverless AI Jobs REST API exposes **no exit-code field** and **no job logs**
(logs are web-console/CLI only). Nothing the process returns reaches the application.

So the verdict travels in a file, written to a mounted S3 Object Storage volume. That
file is the only channel. It is written even when the clone fails, the dependency
install fails, the test times out, the configuration is missing, or the probe itself
raises — because a missing file is indistinguishable from a still-running job, and would
stall the hunt forever.

## Input contract — environment variables

Supplied by the Jobs API via `spec.environmentVariables`.

| Variable | Required | Meaning |
|---|---|---|
| `FAULTLINE_HUNT_ID` | yes | Hunt this probe belongs to. Names the output prefix. |
| `FAULTLINE_REPO_URL` | yes | Git URL to fetch from. Any URL git accepts. |
| `FAULTLINE_COMMIT_SHA` | yes | The one commit to test. Full 40-character SHA. |
| `FAULTLINE_TEST_COMMAND` | yes | Shell-style command, `shlex`-split, run in the checkout root. |
| `FAULTLINE_OUTPUT_PATH` | yes | Mount point of the Object Storage volume, e.g. `/out`. |
| `FAULTLINE_TIMEOUT_SECONDS` | no | Total budget. Default 900. |

## Output contract — the verdict file

```
$FAULTLINE_OUTPUT_PATH/<huntId>/probes/<commitSha>.json
```

A `faultline.probe.v1` document matching the frozen `ProbeResult` interface in
`src/lib/types.ts`:

```json
{
  "schema": "faultline.probe.v1",
  "huntId": "hunt-pass-001",
  "commitSha": "5a77b12a7a9f052ce5a20c335d2825658f6aea52",
  "verdict": "pass",
  "exitCode": 0,
  "durationMs": 2326,
  "detail": "deps: pyproject.toml + uv pip install -e .; test exited 0",
  "tail": "..............s...      [100%]\n17 passed, 1 skipped in 0.09s\n"
}
```

Written atomically: a temp file in the same directory, `fsync`, then `os.replace`. A
reader polling the prefix never sees a half-flushed document.

The same JSON is also printed to stdout on one line, so `nebius ai job logs` shows a
human the exact verdict the application acted on.

## Verdict semantics

| Verdict | Means | `exitCode` |
|---|---|---|
| `pass` | The test command exited 0. | `0` |
| `fail` | The test command itself exited non-zero. | the code |
| `error` | The test never ran. | `null` |

`error` covers: clone or checkout failure, dependency-install failure, timeout, missing
or invalid configuration, and any unhandled exception.

**The pass/fail/error split is the correctness backbone.** An `error` recorded as a
`fail` would narrow the bisection and blame an innocent commit. Every failure path is
written to preserve the distinction — in particular, a failed dependency install raises
rather than falling through into a non-zero test exit.

## What the probe does

1. **Shallow-fetch one commit** — `git init`, `git remote add origin`, `git fetch --depth 1
   origin <sha>`, `git checkout FETCH_HEAD`. A full clone would download every object in
   history to test a single commit.
2. **Install that commit's dependencies from scratch**, first match wins:
   `pyproject.toml` → `uv pip install -e .`; `requirements.txt` → `uv pip install -r`;
   `setup.py` → `uv pip install -e .`. `pip` is the fallback if `uv` is absent. None of
   the three present is not an error — stdlib-only suites are legitimate. The strategy
   that ran is recorded in `detail`.
3. **Run the test command** with the remaining budget, capturing stdout+stderr combined.
4. **Write the verdict file**, then mirror it to stdout.

## Budget

`FAULTLINE_TIMEOUT_SECONDS` is split so a slow install cannot consume the whole window
and leave nothing for the test: clone gets `max(60, t/3)`, install `max(120, t/2)`, and
the test gets whatever is left with a floor of 30s. The floors mean a very small `t`
does not produce a sub-second test timeout.

## Output safety

- `tail` is capped at the last 4000 characters, prefixed with a truncation marker when
  anything was dropped. It lands in JSON and then on a public web page, so it is never
  unbounded.
- `tail` and `detail` are redacted before writing: values of environment variables whose
  names contain KEY / SECRET / TOKEN / PASSWORD / PASSWD / CREDENTIAL, URL-embedded
  credentials (`https://user:pass@host`), and bearer tokens.

## Image

- `python:3.11.13-slim-bookworm`, pinned by exact tag.
- `git` plus `uv` (copied from `ghcr.io/astral-sh/uv:0.5.11`, no pip-install step).
- `pytest` pre-seeded into `/opt/venv` so a stdlib-only commit is still testable. A
  commit that declares its own pytest overrides it at install time — the commit's own
  dependencies always win.
- Runs as non-root `probe` (uid 10001). `probe.py` is the last layer, so the apt/uv/venv
  layers stay cached across probe edits.
- `probe.py` is **stdlib only**. Every third-party import is cold-start cost and one more
  way to fail before the verdict is written.

Process exit code (not surfaced by Nebius; for local runs): `0` when a pass/fail verdict
was produced, `1` for an error verdict, `2` if the verdict file could not be written.

## Build and run locally

```sh
docker build -t faultline-probe:local -f probe/Dockerfile probe

mkdir -p /tmp/probe-out
docker run --rm \
  -e FAULTLINE_HUNT_ID=hunt-local \
  -e FAULTLINE_REPO_URL=https://github.com/hukkin/tomli.git \
  -e FAULTLINE_COMMIT_SHA=5a77b12a7a9f052ce5a20c335d2825658f6aea52 \
  -e FAULTLINE_TEST_COMMAND='python -m pytest -q' \
  -e FAULTLINE_OUTPUT_PATH=/out \
  -v /tmp/probe-out:/out \
  faultline-probe:local

cat /tmp/probe-out/hunt-local/probes/*.json
```

Nebius runs `linux/amd64`; build with `--platform linux/amd64` before pushing to a
registry from an Apple Silicon machine.
