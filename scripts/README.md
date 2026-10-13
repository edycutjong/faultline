# scripts/

## `seed.py` — FAULTBENCH-3

Faultline claims to find the commit that broke a test. That claim is only checkable
against histories where the answer is known in advance. `seed.py` builds three of them.

| Repo | Commits | Planted at | Regression | Dependency drift |
|---|---|---|---|---|
| `tzdata-pipeline` | 256 (255 after the known-good scaffold commit) | index 173 | the classic pytz pitfall: `replace(tzinfo=zone)` instead of `localize()` | `pytz==2022.1` → `2023.3` at index 150, golden values updated with it |
| `retry-lib` | 128 | index 91 | off-by-one in the backoff schedule length | none |
| `id-mint` | 64 | index 41 | hash key truncated, so similar names collide | none |

Each is a small but plausible Python package with a real pytest suite. One commit
introduces one real regression — a believable refactor, never a `raise Exception`. Every
commit before it passes the whole suite; every commit from it onward fails exactly one
named test. Filler commits are real changes (docstrings, helpers with their own tests,
constants, changelog entries, version bumps), so the history reads like a project.

### Usage

```sh
python scripts/seed.py --out /tmp/faultbench            # build all three
python scripts/seed.py --out /tmp/faultbench --only retry-lib
python scripts/seed.py --out /tmp/faultbench --verify   # re-derive and check SHAs
```

Stdlib only; shells out to `git`. Generate **outside** this repository — the seed output
is not committed.

### The answer key

`FAULTBENCH.json` is written to the **output root**, never inside a repository, so a hunt
run against one of these repos cannot read the answer out of the tree it is bisecting.
Per repo it records `plantedSha`, `parentSha`, `goodRef`, `badRef`, `plantedIndex`,
`failingTest`, `historySha256` (sha256 of the newline-joined commit list, oldest first),
and a prose description of the bug.

### Reproducibility

A re-run produces byte-identical trees and therefore identical commit SHAs. What is
pinned:

- RNG seed `20260904`, per-repo derived, driving every filler choice.
- Author and committer `Faultbench Bot <faultbench@example.invalid>`.
- `GIT_AUTHOR_DATE` = `GIT_COMMITTER_DATE` = `BASE_EPOCH + index * 1800`, from
  `1704704400` (2024-01-08T09:00:00Z).
- `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` pointed at `/dev/null`, `LC_ALL=C`,
  `TZ=UTC`, gpg signing off, hooks off, `core.autocrlf=false`, file mode `0644`.
- Default branch `main`.

Changing any of those changes every SHA downstream of it.

### How a judge verifies

```sh
python scripts/seed.py --out /tmp/faultbench            # 1. build
python scripts/seed.py --out /tmp/faultbench --verify   # 2. re-derive from scratch
```

`--verify` reads `FAULTBENCH.json`, re-derives each history from the on-disk repository,
**and** regenerates the whole repository into a temp directory from scratch, comparing
both against the recorded SHAs. It prints `OK` and exits 0, or lists every mismatch and
exits 1.

To confirm the plant is real rather than declared, check out the parent and the planted
commit and actually run pytest:

```sh
cd /tmp/faultbench/id-mint
git checkout -q <parentSha>  && PYTHONPATH=. python -m pytest -q   # 16 passed
git checkout -q <plantedSha> && PYTHONPATH=. python -m pytest -q   # 1 failed, 15 passed
```

Values observed for the pinned inputs above, with git 2.50.1 and Python 3.11 (regenerate and
`--verify` to reproduce; `FAULTBENCH.json` records every SHA):

| Repo | parentSha | plantedSha | Failing test |
|---|---|---|---|
| `tzdata-pipeline` | `bd522cc7c8c9` | `4e133d6c856c` | `tests/test_normalize.py::test_naive_local_midnight_is_interpreted_in_zone` |
| `retry-lib` | `5abbb803c523` | `33aeec509e50` | `tests/test_backoff.py::test_schedule_has_one_gap_per_retry` |
| `id-mint` | `221491845074` | `85ef8d156d0c` | `tests/test_mint.py::test_similar_service_names_do_not_collide` |

`retry-lib` and `id-mint` need no install (`PYTHONPATH=.` is enough). `tzdata-pipeline` pins its
tz database and needs `pip install -e .[test]` **at each commit** — that is the point of it.

The published copy of `tzdata-pipeline` is
[`edycutjong/faultbench-tzdata-pipeline`](https://github.com/edycutjong/faultbench-tzdata-pipeline)
(tag `v0.1.0` = the scaffold commit, the known-good ref).

### The three regressions

- **tzdata-pipeline** — `to_utc()` attaches the pytz zone with `replace(tzinfo=...)` instead
  of `localize()`, so naive input gets the zone's local-mean-time offset (−6:36:36 for Mexico
  City) instead of the offset in force on that date. Aware input is unaffected, so most of the
  suite stays green. **Its history drifts:** index 150 bumps `pytz` from 2022.1 to 2023.3
  because Mexico abolished daylight saving time (tzdata 2022f), and updates the golden value
  of the failing test with it. Each commit's test is right under its own pin and wrong under
  the other — so `git bisect run` in one reused environment blames an innocent commit (the
  pytz bump with an environment from the good ref; an early docs commit with one from HEAD).
- **retry-lib** — `schedule()` iterates `range(max_attempts)` instead of
  `range(max_attempts - 1)`, publishing one gap too many; `total_backoff()` then
  overstates the sleep budget. `Retrier` indexes the schedule defensively, so its own
  tests stay green.
- **id-mint** — `canonical_key()` truncates to `MAX_KEY_CHARS = 16` before hashing "to
  bound hashing cost", so any two resources sharing a 16-character prefix mint the same
  id. Every short-name test still passes, which is what lets it through review.
