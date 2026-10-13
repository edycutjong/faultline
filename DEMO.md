# Demo — every number, and the command that produced it

Everything below was run on 2026-10-13 against the live deployment
(https://faultline-edy-cus-projects.vercel.app) and real Nebius infrastructure. The raw output of
every run is committed under [`evidence/`](evidence). Where a figure is a property of a fixture we
built, it says so.

---

## 1. The test suites — no credentials

```bash
npm install
npm test            # 275 unit + integration tests
npm run test:probe  # 7 tests: the real probe.py against a local repo and HTTP server
npm run e2e         # 44 checks: the app with NO environment, desktop and mobile
```

The integration suite drives a whole hunt through the production code path — service-account
auth, the Jobs REST client, SigV4 storage with conditional writes, presigned verdict URLs, the
tick, Token Factory narration — with Nebius simulated at the HTTP boundary. It also asserts, for
every job a hunt creates, that the job is given `probe.py` as an injected file and **no
credential and no bucket mount**.

## 2. Conditional writes on the real bucket (G5)

The control loop has no daemon and no database; it rests on two Object Storage primitives. They
were measured before anything was built on them:

```bash
npm run test:live -- tests/live/g5-conditional-put.live.ts   # needs the Nebius env
```

[`evidence/g5-conditional-writes.json`](evidence/g5-conditional-writes.json): 20 races with 2, 5
and 8 concurrent `If-None-Match: "*"` creators on one fresh key — **exactly one winner in 20 of
20**, every loser `412`. A replace with a stale `If-Match` ETag: `412`; with the fresh one: `2xx`.

## 3. A probe, in four regions (smoke)

```bash
SMOKE_EXTRA_REGION="uk-south1:<project>:<subnet>" npm run test:live -- tests/live/smoke-jobs.live.ts
```

[`evidence/smoke-jobs.json`](evidence/smoke-jobs.json),
[`evidence/smoke-jobs-more-regions.json`](evidence/smoke-jobs-more-regions.json): real jobs on
the stock `python:3.11` image, `probe.py` injected as a file, no mount, no credential — each
delivered its verdict into the `eu-west1` bucket through a presigned URL:

| Region | Job | Verdict | Create → workload start |
|---|---|---|---|
| eu-west1 | `aijob-e01r34w4tx1qvvss89` | pass (exit 0) | 4 m 26 s |
| uk-south1 | `aijob-e03mbvtcvpcfhrzwbj` | fail (exit 5) | 4 m 18 s |
| uk-south2 | `aijob-e05h4ab6aja7far8d2` | fail (exit 5) | 4 m 29 s |
| me-west1 | `aijob-i00qatnkkk2eby3v2y` | fail (exit 5) | 4 m 31 s |

The three `fail`s are deliberate: those jobs ran pytest with `-k no_such_test_anywhere`, which
selects nothing and exits 5, to prove a failing verdict travels the same path as a passing one.
The `pass` is a real run of itsdangerous at `672971d6`. Inside the container the work took ~4–8 s
(clone, `pip install`, pytest). The rest is cold start.

## 4. The first live hunt

[`evidence/first-live-hunt.json`](evidence/first-live-hunt.json) — hunt `295a5c3c` on a
15-commit slice of the hero fixture. Ten jobs across four regions; culprit `4e133d6c`, which
matches the fixture's answer key; Nemotron's paragraph (Token Factory request
`chatcmpl-b5427963b682a6b8`) explains the `localize()` → `replace(tzinfo=...)` change.

What it also showed, recorded rather than smoothed over:

- **It advanced with nobody watching.** Round 1 finished and round 2 was dispatched while no
  client polled — the record was read straight from the bucket.
- **Nebius throttled job creation.** Round 2's two creates came back `429 Too Many Requests`.
  They were recorded as infrastructure failures, never verdicts; that build counted them against
  the retry budget, so the hunt **paused** with its reason and was **resumed** once. The engine
  now treats `429` as backoff with its own budget, and wakes the hunt when the backoff ends.

## 5. The benchmark — three baselines, two axes

```bash
python3 scripts/seed.py --out /tmp/faultbench          # regenerate the fixtures (byte-identical)
python3 scripts/seed.py --out /tmp/faultbench --verify

# git bisect run: one reused env (built at the good ref, then at the failing ref), and a fresh
# venv per step — 5 trials each, scored against the answer key
python3 scripts/bench.py local --repo <clone of faultbench-tzdata-pipeline> --good v0.1.0 --bad main \
  --truth 4e133d6c856c2e756fce5a328896f20fecfc62eb \
  --test "python -m pytest -q -p no:cacheprovider tests/test_normalize.py::test_naive_local_midnight_is_interpreted_in_zone" \
  --install "pip install -e .[test]" --trials 5 --label tzdata-pipeline --out evidence/bench/hero-local.json

# Faultline: one hunt through the deployed app, polled to the end
python3 scripts/bench.py faultline --api https://faultline-edy-cus-projects.vercel.app \
  --repo-url https://github.com/edycutjong/faultbench-tzdata-pipeline --good v0.1.0 --bad main \
  --test "python -m pytest -q tests/test_normalize.py::test_naive_local_midnight_is_interpreted_in_zone" \
  --install "pip install -e .[test]" --truth 4e133d6c856c2e756fce5a328896f20fecfc62eb \
  --label tzdata-pipeline --out evidence/bench/hero-faultline-1.json

python3 scripts/bench.py report evidence/bench/*.json
```

Local runs: a MacBook, Python 3.11, git 2.50, warm pip cache (the favourable case for the
baselines).

### The drifting history — `faultbench-tzdata-pipeline`, 255 commits

A generated fixture: `pytz` is pinned at `2022.1` and moves to `2023.3` at commit 150 (Mexico
abolished daylight saving time, tzdata 2022f) together with the golden value of the failing test;
commit 173 plants the classic pytz bug, `replace(tzinfo=zone)` instead of `localize()`. Each
commit's test is right under its own pin and wrong under the other.

| How | Named | Right | Wall-clock (N) |
|---|---|---|---|
| `git bisect run`, one env built at the known-good ref (`pytz 2022.1`) | `e46e5342` build(deps): bump pytz to 2023.3 — Mexico abolished DST, update golden values | **0 / 5** | 1.43 s p50 (5) — plus 7.9 s to build the env once |
| `git bisect run`, one env built at the failing ref (`pytz 2023.3`) | `acebfbfa` docs(changelog): spell out the units on the public helpers (#104) | **0 / 5** | 1.49 s p50 (5) — plus 7.1 s to build the env once |
| `git bisect run`, fresh venv at every step | `4e133d6c` | 5 / 5 | 57.44 s p50, 58.02 s max (5); 8 steps each |
| **Faultline** — hunt `827dfe7e`, 8 slots in 4 regions | `4e133d6c` | 1 / 1 | 957 s (1); 3 rounds, 19 jobs; 5,173 VM-seconds = $0.0948 at list price |

Faultline's 957 s, round by round ([`evidence/bench/hero-faultline-1.json`](evidence/bench/hero-faultline-1.json)):
round 1, 8 probes, 318.5 s; round 2, 8 probes, 374.3 s; round 3, 3 probes, 268.6 s. Ten creates
were refused with `429` and retried (two in round 1, eight in round 2) — every one visible as an
attempt number in the recorded hunt. Across the 19 jobs: create → workload start 260.6 s p50
(251.9–278.6 s), work inside the container 5.35 s p50 (4.8–8.2 s).

### A real regression — `python-attrs/attrs` 22.1.0 → 22.2.0, 135 commits

Culprit `89a890a3` ("Change `__getstate__` and `__setstate__` to use a dict"), named by the fix
itself: *"Regression in 89a890a3262273514619d1881c6a8b0fe26c66ac."*
([#1085](https://github.com/python-attrs/attrs/pull/1085)). The test feeds the old tuple-style
pickle state to `__setstate__`. At least one commit in the range cannot be installed with today's
setuptools (we checked `300d3ee3`) — a real skip, had a probe landed on it (none did):

```bash
git -C attrs checkout -q 300d3ee32ce6fb312b34b972879d1f7e5819626d   # "Looks like pytest-mypy is broken on 3.11"
python3 -m venv /tmp/v && /tmp/v/bin/python -m pip install -q -e attrs
#   error in attrs setup command: 'extras_require' must be a dictionary whose values are strings or
#   lists of strings containing valid project/version requirement specifiers.      (pip exits 1)
```

```bash
python3 scripts/bench.py local --repo <clone of python-attrs/attrs> \
  --good b3dfebe2e10b44437c4f97d788fb5220d790efd0 --bad a9960de98d0f58ccb2880d03c97dafba3fc1111c \
  --truth 89a890a3262273514619d1881c6a8b0fe26c66ac --install "pip install -e ." --trials 3 --label attrs \
  --test "python -c \"assert (lambda C: (lambda i: (i.__setstate__((1, 2)), (i.x, i.y))[1])(C.__new__(C)))(__import__('attr').make_class('C', ['x', 'y'], slots=True)) == (1, 2)\"" \
  --out evidence/bench/attrs-local.json
python3 scripts/bench.py faultline --api https://faultline-edy-cus-projects.vercel.app \
  --repo-url https://github.com/python-attrs/attrs --good b3dfebe2e10b44437c4f97d788fb5220d790efd0 \
  --bad a9960de98d0f58ccb2880d03c97dafba3fc1111c --install "pip install -e ." \
  --truth 89a890a3262273514619d1881c6a8b0fe26c66ac --label attrs --test "<the same command>" \
  --out evidence/bench/attrs-faultline-1.json
```

| How | Named | Right | Wall-clock (N) |
|---|---|---|---|
| `git bisect run`, one env built at the known-good ref | `89a890a3` | 3 / 3 | 0.56 s p50 (3) |
| `git bisect run`, one env built at the failing ref | `89a890a3` | 3 / 3 | 0.55 s p50 (3) |
| `git bisect run`, fresh venv at every step | `89a890a3` | 3 / 3 | 43.81 s p50, 44.67 s max (3); 8 steps each |
| **Faultline** — hunt `50824b63`, 8 slots in 4 regions | `89a890a3` | 1 / 1 | 918.9 s (1); 3 rounds, 17 jobs; 4,528 VM-seconds = $0.0830 at list price |

Round by round ([`evidence/bench/attrs-faultline-1.json`](evidence/bench/attrs-faultline-1.json)): 290.3 s,
337.2 s, 258.1 s; 16 creates refused with `429` and retried. Create → workload start 256.4 s p50 over
the 17 jobs.

**The explanation on this one is partly wrong, and that is the design working.** Nemotron's paragraph
(Token Factory request `chatcmpl-95d7f86bfadb7974`) correctly names the change — `__getstate__` now
returns a dict instead of a tuple — but then claims the new dict is empty. The real break is that state
pickled by the old version is a tuple, and the new `__setstate__` only reads names out of a dict. The
culprit is right because it came from running the test, not from the model; the report labels the
paragraph as generated, and the hunt record keeps the request ID so it can be checked.

### What the numbers say

- **Correctness.** On the drifting history, `git bisect run` in one reused environment named the
  wrong commit in 10 of 10 runs; a fresh environment per step named the right one in 8 of 8 local
  runs (5 on the fixture, 3 on attrs) and in both Faultline hunts (one per repository). On attrs,
  where nothing drifts, every method is right.
- **Wall-clock.** Faultline is slower than both local methods on both repositories. A probe's VM
  takes about 4 min 20 s to start for ~5 s of work, and Nebius throttled job creation during these
  runs, so a round costs minutes where a local step costs seconds.
- **So the claim is not speed.** It is the right commit without knowing about the drift or
  writing the fresh-environment harness, both ends proven, skips and contradictions handled, the
  work off your machine, and an explained report.

## 6. The recorded example

[`data/recorded-hunt.json`](data/recorded-hunt.json) is the hero hunt above, committed as it came
from the bucket with only `recorded` and `recordedAt` added, and labelled *recorded run,
2026-10-13* wherever it appears. It is what the landing page shows by default
(`GET /api/examples/recorded`), and it costs nothing to view.

One field in it is stale: the `costUsd` stored inside the hunt records — 0.0713 here and in
`hero-faultline-1.json`, 0.0624 in `attrs-faultline-1.json` — was written by the app while it still
used the list price from before 1 October 2026. The app now prices a hunt from its probes' `vmMs` when
it renders (`huntCostUsd` in `src/lib/pricing.ts`), and `bench.py` does the same; that is where
$0.0948 and $0.0830 come from.

## 7. The app, cold, with no environment variables

```bash
npm run build && npm start
curl -s localhost:3000/api/hunts              # {"liveHuntsToday":0,"dailyCap":10,"nebiusConfigured":false,"slots":0,"liveHuntId":null}
curl -s localhost:3000/api/examples/recorded  # {"available":true,"hunt":{...}}
```

A cold visit renders the landing page and the recorded run; starting a live hunt says plainly
that this deployment has no Nebius credentials.
