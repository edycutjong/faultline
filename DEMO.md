# Demo — every number, and the command that produced it

Every hunt below ran on 2026-10-13 and 2026-10-14 against the live deployment
(https://faultline.edycu.dev) and real Nebius infrastructure; the local `git bisect run` baselines ran on a
MacBook (§5). The raw output of
every run is committed under [`evidence/`](evidence). Where a figure is a property of a fixture we
built, it says so.

---

## 1. The test suites — no credentials

```bash
npm install
npm test            # 553 unit + integration tests (100 % coverage of src/lib, enforced)
npm run test:probe  # 9 tests: the real probe.py against a local repo and HTTP server
npm run build && npm run e2e   # 50 checks: the production build with NO environment, desktop and mobile
```

The integration suite drives a whole hunt through the production code path — service-account
auth, the Jobs REST client, SigV4 storage with conditional writes, presigned verdict URLs, the
tick, Token Factory narration — with Nebius simulated at the HTTP boundary. It also asserts, for
every job a hunt creates, that the job is given `probe.py` as an injected file and **no
credential and no bucket mount**. `tests/sandboxes-backend.test.ts` asserts the same for the
Sandboxes backend: the spawn carries `probe.py` on stdin, the `FAULTLINE_*` variables and nothing
else — not the Token Factory key that made the call.

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
# eu-west1 (home) + uk-south1 → evidence/smoke-jobs.json
SMOKE_EXTRA_REGION="uk-south1:<project>:<subnet>" npm run test:live -- tests/live/smoke-jobs.live.ts
# uk-south2 + me-west1 only → evidence/smoke-jobs-more-regions.json
SMOKE_SKIP_HOME=1 SMOKE_EVIDENCE=smoke-jobs-more-regions.json \
  SMOKE_EXTRA_REGION="uk-south2:<project>:<subnet>,me-west1:<project>:<subnet>" \
  npm run test:live -- tests/live/smoke-jobs.live.ts
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
selects nothing and exits 5, to prove a non-passing verdict travels the same path as a passing one.
That was the probe of the day (sha256 `1f56a510…`, recorded in both files). The probe now records
pytest's exits 4 and 5, and exit 125 from any command, as `error` — the command tested nothing, so
the commit is skipped, never blamed — and a re-run of this smoke expects `error` for those three.
The `pass` is a real run of itsdangerous at `672971d6`. Inside the container the work took ~4–8 s
(clone, `pip install`, pytest). The rest is cold start.

### The same probe on Token Factory Sandboxes

```bash
# needs the Nebius env plus TOKENFACTORY_API_KEY and TOKENFACTORY_PROJECT_ID → evidence/smoke-sandboxes.json
npm run test:live -- tests/live/smoke-sandboxes.live.ts
```

[`evidence/smoke-sandboxes.json`](evidence/smoke-sandboxes.json), 2026-10-14: two probes through
the production `SandboxesBackend` on the hero fixture — the known-good commit `0260b672` returned
`pass`, the culprit `4e133d6c` returned `fail`, both via presigned PUT into the Object Storage bucket.
Dispatch to terminal state 11.4 s and 10.8 s; operation durations 7.98 s and 8 s, of which the
probe's own clone + install + test took 6.3 s and 6.8 s.

## 4. The first live hunt

[`evidence/first-live-hunt.json`](evidence/first-live-hunt.json) — hunt `295a5c3c` on a
15-commit slice of the hero fixture. Ten jobs across four regions; culprit `4e133d6c`, which
matches the fixture's answer key; Nemotron's paragraph (Token Factory request
`chatcmpl-b5427963b682a6b8`) explains the `localize()` → `replace(tzinfo=...)` change. We read it
against the diff and found nothing in it wrong.

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
python3 scripts/bench.py faultline --api https://faultline.edycu.dev \
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
(251.9–278.6 s), work inside the container 5.35 s p50 (4.8–8.2 s). The rounds add up to 961 s,
not 957 s, because the round figures overlap — mostly where two ticks raced at the end of round 1:
the record keeps the last round-1 verdict as read by the tick whose write won (+319.6 s), and
round 2's dispatch time from the claim of the tick that lost (+314.7 s). Its jobs were adopted,
not created twice — 19 probes, 19 jobs.

Nemotron's paragraph on this hunt (request `chatcmpl-988d2b477be0c269`) has the mechanism and the
06:37-instead-of-06:00 result right, but calls UTC−6 the "DST-adjusted" offset; Mexico City has had no
daylight saving time since October 2022, which is the very change this fixture's drift is about.
UTC−6 is simply standard time.

**The same range again, twice, from the app's own form.** [`evidence/rerun-hunt.json`](evidence/rerun-hunt.json) —
hunt `94efded1`, started on 2026-10-13 at 21:58 UTC and screen-recorded for the first cut of the demo video: the same
255 commits, the same test, `v0.1.0` as the known-good ref. It named `4e133d6c` again — 3 rounds, 19 jobs across the
four regions (6 eu-west1, 5 uk-south1, 4 uk-south2, 4 me-west1), 923 s, 5,047 VM-seconds = $0.0925 at list price; 12
creates were refused with `429` and retried. Nemotron's paragraph (request `chatcmpl-a5fbc7ddf16c7f81`) says the change
swaps `localize()` for `replace(tzinfo=...)`, which attaches the zone without applying its offset rules, so midnight lands
at 06:37 UTC instead of 06:00, and that the fix is to restore `localize()`. Read against the diff and the test output, the
mechanism, both times and the fix all hold; its aside that a zone's rules include "any DST or past-offset adjustments" is
generic — it does not say DST applied in July 2023, when Mexico City had none.

[`evidence/video-hunt.json`](evidence/video-hunt.json) — hunt `69542695`, started on 2026-10-14 at 04:41 UTC and
screen-recorded start to finish for the demo video, on the redesigned app. It named `4e133d6c` — 3 rounds, 19 probes,
1,032 s, 5,060 VM-seconds = $0.0928 at list price. 14 creates were refused with `429` and retried. Round 3 also sent three
jobs to uk-south1 within two seconds; the third, `aijob-e03s3sxfzvv3mqk2ay`, exceeded the two-per-region quota and Nebius
ended it `ERROR (QuotaExceeded)` without running the test. The hunt counted that as an infrastructure failure — not a
verdict — and re-dispatched commit 173 in eu-west1 (`aijob-e01e1sv0979rwsx4mq`), which cost about two minutes: 20 jobs
for 19 probes. The engine's slot count is meant to stop a third job in a region; that it did not here was a bug (two ticks on the same hunt record could fill the same last slot), and
the failure path is what kept the result right. It is fixed in `9d35f5f` — each launch into a region now claims its number with
`If-None-Match` — and a fresh run on the fix (`evidence/p7-hunt.json`, hunt `9d33fada`) named `4e133d6c` in 932 s with 19 probes, 10 `429`s retried and no `QuotaExceeded` job. On Jobs, Faultline is 4 / 4 on this history (957 s, 923 s, 1,032 s and 932 s); the Sandboxes hunt below makes it 5 / 5.
Hunt `69542695`'s paragraph (request `chatcmpl-a81f7f4ec15855e1`) names the swapped line, says `replace` attaches the zone
without applying its offset rules for that date, and gives 06:37 UTC instead of 06:00 — the probe's own assertion reads
`datetime(2023, 7, 1, 6, 37, …)` against `datetime(2023, 7, 1, 6, 0, …)`. Its fixes — restore `localize()` on line 78,
or call `localize(moment, is_dst=None)` — both hold. Its "(the zone's base or wrong DST offset)" is a hedge: the offset
`replace` attaches is pytz's first entry for the zone, local mean time (−6:37), and no DST applied in July 2023.
Hunt `9d33fada`'s paragraph (request `chatcmpl-84f55213a6a6f7b8`) names the swapped line, gives 06:37 UTC instead of
06:00 and restores `localize()`; all of it holds; its aside about DST adjustments is generic, as above.

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
python3 scripts/bench.py faultline --api https://faultline.edycu.dev \
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
337.2 s, 258.1 s; 16 creates refused with `429` and retried. Those add up to 885.6 s against the
918.9 s hunt: round 2's first creates were refused and waited out the 30 s backoff, so its first job
went out 33 s after round 1's last verdict. Create → workload start 256.4 s p50 over the 17 jobs.

**The explanation on this one is partly wrong, and that is the design working.** Nemotron's paragraph
(Token Factory request `chatcmpl-95d7f86bfadb7974`) correctly names the change — `__getstate__` now
returns a dict instead of a tuple — but then claims the new dict is empty. The real break is that state
pickled by the old version is a tuple, and the new `__setstate__` only reads names out of a dict. The
culprit is right because it came from running the test, not from the model; the report labels the
paragraph as generated, and the hunt record keeps the request ID so it can be checked.

### The drifting history on Token Factory Sandboxes

[`evidence/sandboxes-hunt.json`](evidence/sandboxes-hunt.json) — hunt `89cf7952`, started on
2026-10-14 at 12:55 UTC through `POST /api/hunts` on the deployed app with
`FAULTLINE_PROBE_BACKEND=sandboxes` (16 slots): the same repository, test, install command and refs
as `evidence/p7-hunt.json`. It named `4e133d6c` in **46.5 s** — 3 rounds, 20 probes, 20 sandboxes,
0 retries, 0 throttled creates. Round 1 sent all 10 probes (both ends + 8 suspects) at once; each
probe went from dispatch to verdict in 8.3–10.7 s, with 8.6–13.4 s of sandbox time per operation
and 6.0–7.0 s of that the probe's own clone, install and test. In round 2 two of the eight probes
waited ~15 s for a slot: round 1's ten sandboxes still counted as holding slots until their status
was re-read (the engine's 15 s exit grace), and 10 + 8 exceeds 16. Nemotron's paragraph (request
`chatcmpl-bdc1d9b0eabda9c2`) names the swapped line and says `replace` attaches the zone's tzinfo
without its historical offset rules for that date, gives 06:37 UTC instead of 06:00 and restores
`localize()`. Read against the diff and the test output, it holds.

Sandboxes publishes no list price, so no dollar figure is given; each operation reports a
`resources.cost` value of undocumented unit, summed raw in the evidence file (0.808 over 20
operations).

By a rule fixed on 2026-10-14 before the run — switch the default only if the hunt is correct and faster
than the fastest Jobs hunt on this history (923 s) — Sandboxes became the deployment's default
backend. Jobs stays selectable with `FAULTLINE_PROBE_BACKEND=jobs`. Faultline is 5 / 5 on this
history: four hunts on Jobs, one on Sandboxes.

### What the numbers say

- **Correctness.** On the drifting history, `git bisect run` in one reused environment named the
  wrong commit in 10 of 10 runs. Across both histories, a fresh environment per step named the right one in 8 of 8 local
  runs (5 on the fixture, 3 on attrs) and in all six Faultline hunts over these two ranges (five on the fixture,
  one on attrs). On attrs,
  where nothing drifts, every method is right.
- **Wall-clock.** On Serverless AI Jobs, Faultline is slower than both local methods on both
  repositories: a probe's VM takes about 4 min 20 s to start for ~5 s of work, and Nebius
  throttled job creation during these runs, so a round costs minutes where a local step costs
  seconds. On Token Factory Sandboxes the three rounds took 10.7 s, 24.1 s and 10.7 s from dispatch to last
  verdict (two of round 2's probes waited ~15 s for a slot), and the one hunt measured (46.5 s)
  finished ahead of the local fresh-venv bisect (57.44 s p50) on the drifting history — once, so
  it is a measurement, not a rule. attrs has not been hunted on Sandboxes.
- **So the claim is not speed.** It is the right commit without knowing about the drift or
  writing the fresh-environment harness, both ends proven, skips and contradictions handled, the
  work off your machine, and an explained report.

### A real refusal — the failing ref passes in a clean environment

[`evidence/refusal-hunt.json`](evidence/refusal-hunt.json) — hunt `074dc7a3` on the same 255-commit
fixture, but with a test that passes at both ends
(`tests/test_normalize.py::test_aware_input_keeps_its_own_offset`), standing in for "it fails on my
machine and nowhere else". Round 1 ran the two ends plus six suspects, 8 jobs across the four regions, every
verdict `pass`; the hunt stopped there as *inconclusive — "The failing ref passes in a clean environment"*,
without naming a commit and without a model call. 287 s from start to finish, one round, $0.0390 at list
price. No second round was spent on a range that has no culprit.

## 6. The recorded example

[`data/recorded-hunt.json`](data/recorded-hunt.json) is the hero hunt above, committed as it came
from the bucket with only `recorded` and `recordedAt` added, and labelled *recorded run,
2026-10-13* wherever it appears. It is what the landing page shows by default
(`GET /api/examples/recorded`), and it costs nothing to view.

One field in the file is stale: the `costUsd` stored inside the hunt records — 0.0713 here and in
`hero-faultline-1.json`, 0.0624 in `attrs-faultline-1.json` — was written by the app while it still
used the list price from before 1 October 2026. The records are kept as they came; the app prices a hunt
from its probes' `vmMs` whenever it renders one (`huntCostUsd` in `src/lib/pricing.ts`), `bench.py` does
the same, and `GET /api/examples/recorded` now serves the recorded hunt with that figure ($0.0948), so the
JSON and the UI agree. The `hunt.costUsd` nested inside the two `evidence/bench/*-faultline-1.json` files still carries the old figure; their top-level `costUsd` (0.0948 and 0.0830) is re-priced.

## 7. The app, cold, with no environment variables

```bash
npm run build && npm start
curl -s localhost:3000/api/hunts              # {"liveHuntsToday":0,"dailyCap":10,"nebiusConfigured":false,"slots":0,"liveHuntId":null}
curl -s localhost:3000/api/examples/recorded  # {"available":true,"hunt":{...}}
```

A cold visit renders the landing page and the recorded run; starting a live hunt says plainly
that this deployment has no Nebius credentials.
