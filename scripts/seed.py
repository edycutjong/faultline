#!/usr/bin/env python3
"""FAULTBENCH-3 — deterministic seed repositories with planted regressions.

Faultline claims to find the commit that broke a test. That claim is only checkable
against histories where the answer is known in advance, so this script builds three
of them:

    tzdata-pipeline   256 commits   naive/aware datetime mix-up
    retry-lib         128 commits   off-by-one in the backoff schedule length
    id-mint            64 commits   hash key truncated, so similar names collide

Each repository is a small but genuinely plausible Python package with a real pytest
suite. Exactly one commit introduces exactly one real regression: every commit before
it passes the whole suite, every commit from it onward fails one named test. The bug
is a plausible refactor, never a `raise Exception`.

DETERMINISM is the point. Fixed RNG seed, fixed author and committer identity, fixed
commit timestamp sequence and fixed file content mean a re-run produces byte-identical
trees and therefore identical commit SHAs. `--verify` proves it: it re-derives every
history from scratch and compares against the recorded manifest.

The answer key (`FAULTBENCH.json`) is written to the OUTPUT ROOT, never inside a
repository, so a hunt run against one of these repos cannot read the answer out of the
tree it is bisecting.

Stdlib only; shells out to `git`.

Usage:
    python scripts/seed.py --out /tmp/faultbench
    python scripts/seed.py --out /tmp/faultbench --only retry-lib
    python scripts/seed.py --out /tmp/faultbench --verify
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile

# --------------------------------------------------------------------------------------
# fixed generator inputs — changing ANY of these changes every SHA
# --------------------------------------------------------------------------------------

SEED = 20260904
AUTHOR_NAME = "Faultbench Bot"
AUTHOR_EMAIL = "faultbench@example.invalid"
# 2024-01-08T09:00:00Z, a Monday. One commit every 1800s.
BASE_EPOCH = 1704704400
COMMIT_INTERVAL_SECONDS = 1800
DEFAULT_BRANCH = "main"
MANIFEST_NAME = "FAULTBENCH.json"
MANIFEST_SCHEMA = "faultbench.v1"

MIT_LICENSE = """MIT License

Copyright (c) 2024 Faultbench

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""


# --------------------------------------------------------------------------------------
# git plumbing
# --------------------------------------------------------------------------------------

def git(args, cwd, env=None, check=True):
    proc = subprocess.run(
        ["git"] + args,
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    if check and proc.returncode != 0:
        raise RuntimeError("git %s failed (%d):\n%s" % (" ".join(args), proc.returncode, proc.stdout))
    return proc.stdout


def git_version():
    return subprocess.run(["git", "--version"], stdout=subprocess.PIPE, text=True).stdout.strip()


def commit_env(index):
    """Environment pinning identity AND both timestamps — the two usual sources of drift."""
    stamp = "@%d +0000" % (BASE_EPOCH + index * COMMIT_INTERVAL_SECONDS)
    env = dict(os.environ)
    env.update(
        {
            "GIT_AUTHOR_NAME": AUTHOR_NAME,
            "GIT_AUTHOR_EMAIL": AUTHOR_EMAIL,
            "GIT_AUTHOR_DATE": stamp,
            "GIT_COMMITTER_NAME": AUTHOR_NAME,
            "GIT_COMMITTER_EMAIL": AUTHOR_EMAIL,
            "GIT_COMMITTER_DATE": stamp,
            # Any of these leaking in from the developer's config would change the tree
            # or the commit object and break reproducibility.
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_SYSTEM": os.devnull,
            "LC_ALL": "C",
            "TZ": "UTC",
        }
    )
    return env


GIT_CONFIG_FLAGS = [
    "-c", "user.name=%s" % AUTHOR_NAME,
    "-c", "user.email=%s" % AUTHOR_EMAIL,
    "-c", "commit.gpgsign=false",
    "-c", "core.autocrlf=false",
    "-c", "core.fileMode=true",
    "-c", "core.hooksPath=%s" % os.devnull,
]


def write_tree(root, files):
    """Materialise the whole working tree, deleting files that are no longer declared."""
    wanted = set(files)
    for dirpath, dirnames, filenames in os.walk(root):
        if ".git" in dirnames:
            dirnames.remove(".git")
        for name in filenames:
            rel = os.path.relpath(os.path.join(dirpath, name), root)
            if rel not in wanted:
                os.unlink(os.path.join(dirpath, name))
    for rel, content in files.items():
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(content)
        os.chmod(path, 0o644)


def commit(root, files, message, index):
    write_tree(root, files)
    env = commit_env(index)
    git(["add", "-A"], cwd=root, env=env)
    git(GIT_CONFIG_FLAGS + ["commit", "-q", "--allow-empty-message", "-m", message], cwd=root, env=env)


# --------------------------------------------------------------------------------------
# source templates
# --------------------------------------------------------------------------------------

PYPROJECT = '''[build-system]
requires = ["setuptools>=61"]
build-backend = "setuptools.build_meta"

[project]
name = "{dist}"
version = "{version}"
description = "{description}"
readme = "README.md"
license = {{ text = "MIT" }}
requires-python = ">=3.9"
dependencies = []

[project.optional-dependencies]
test = ["pytest>=7"]

[tool.setuptools.packages.find]
include = ["{pkg}*"]

[tool.pytest.ini_options]
testpaths = ["tests"]
'''

README = '''# {dist}

{description}

## Install

    pip install -e .[test]

## Test

    python -m pytest -q

## Usage notes

- Everything in this package is pure and side-effect free; the tests need no fixtures.
- The public surface is re-exported from `{pkg}/__init__.py`.
'''

CHANGELOG = '''# Changelog

All notable changes to this project are recorded here. Newest entries last.

## Unreleased
'''

CONSTANTS = '''"""Tunables collected in one place so they can be reviewed in one diff."""
'''

UTIL = '''"""Small pure helpers shared across the package.

Nothing here knows about the domain; anything that does belongs in a real module.
"""
'''

TEST_UTIL = '''"""Tests for the shared helpers. One test per helper, no fixtures."""

from {pkg} import util

'''


# --- tzdata-pipeline -------------------------------------------------------------------

TZ_NORMALIZE_GOOD = '''"""Offset-aware timestamp normalisation.

Two upstream feeds reach this pipeline. The legacy CSV exporter emits *naive* local
timestamps and states the zone out of band; the newer webhook emits offset-aware ISO
strings. Both shapes funnel through `to_utc`, which is the only place in the package
allowed to attach a tzinfo.
"""

from datetime import datetime, timedelta, timezone

#: Minutes east of UTC. Deliberately a fixed table rather than a tz database lookup:
#: the feeds only ever quote these five zones and a table is testable offline.
OFFSETS = {
    "UTC": 0,
    "Europe/Amsterdam": 60,
    "Asia/Jakarta": 420,
    "Asia/Tokyo": 540,
    "America/New_York": -300,
}


def offset_for(zone):
    """Minutes east of UTC for a supported zone name."""
    try:
        return OFFSETS[zone]
    except KeyError:
        raise ValueError("unsupported zone: %s" % zone)


def tzinfo_for(zone):
    """A fixed-offset tzinfo for a supported zone name."""
    return timezone(timedelta(minutes=offset_for(zone)))


def to_utc(moment, zone):
    """Convert `moment` to UTC.

    A naive `moment` is *local wall-clock time in `zone`*, so it has to be given that
    zone's tzinfo before conversion. An aware `moment` already carries its own offset
    and `zone` is ignored.
    """
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=tzinfo_for(zone))
    return moment.astimezone(timezone.utc)


def day_bucket(moment, zone):
    """The local calendar date `moment` falls on in `zone`, as an ISO date string."""
    local = to_utc(moment, zone).astimezone(tzinfo_for(zone))
    return local.date().isoformat()


def parse_iso(text):
    """Parse an ISO 8601 timestamp, accepting a trailing Z."""
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    return datetime.fromisoformat(text)
'''

# The regression: the naive branch stops consulting the zone table and stamps UTC on
# local wall-clock time. Aware input is unaffected, which is why most of the suite
# stays green and only the naive-input test turns red. Expressed as a patch, not a
# whole-file swap, so the planted commit's diff is exactly this hunk and nothing else.
TZ_PATCH = [
    (
        '''    A naive `moment` is *local wall-clock time in `zone`*, so it has to be given that
    zone's tzinfo before conversion. An aware `moment` already carries its own offset
    and `zone` is ignored.
    """
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=tzinfo_for(zone))''',
        '''Inputs are normalised to UTC exactly once, at the edge, so the rest of the
    pipeline never has to branch on tzinfo again.
    """
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)''',
    ),
]

TZ_WINDOWS = '''"""Fixed-width windowing over already-normalised UTC instants."""

from datetime import timedelta

from .normalize import to_utc, tzinfo_for


def floor_to(moment, minutes):
    """Round `moment` down to a multiple of `minutes` past the hour."""
    if minutes <= 0:
        raise ValueError("window must be positive")
    discard = (moment.minute % minutes) * 60 + moment.second
    return (moment - timedelta(seconds=discard)).replace(microsecond=0)


def window_key(moment, zone, minutes):
    """Stable string key for the window `moment` belongs to, in local time."""
    local = to_utc(moment, zone).astimezone(tzinfo_for(zone))
    return floor_to(local, minutes).strftime("%Y-%m-%dT%H:%M%z")
'''

TZ_TEST_NORMALIZE = '''"""Tests for offset normalisation.

`test_naive_local_midnight_is_interpreted_in_zone` is the one that pins the contract
for the legacy CSV feed: naive input means local wall-clock, not UTC.
"""

from datetime import datetime, timedelta, timezone

import pytest

from tzdata_pipeline.normalize import OFFSETS, day_bucket, offset_for, parse_iso, to_utc


def test_offset_table_covers_the_documented_zones():
    assert set(OFFSETS) == {
        "UTC",
        "Europe/Amsterdam",
        "Asia/Jakarta",
        "Asia/Tokyo",
        "America/New_York",
    }


def test_offset_for_rejects_an_unknown_zone():
    with pytest.raises(ValueError):
        offset_for("Mars/Olympus")


def test_aware_input_keeps_its_own_offset():
    aware = datetime(2024, 3, 1, 12, 0, tzinfo=timezone(timedelta(minutes=420)))
    assert to_utc(aware, "UTC") == datetime(2024, 3, 1, 5, 0, tzinfo=timezone.utc)


def test_naive_local_midnight_is_interpreted_in_zone():
    naive = datetime(2024, 3, 1, 0, 0)
    assert to_utc(naive, "Asia/Jakarta") == datetime(2024, 2, 29, 17, 0, tzinfo=timezone.utc)


def test_day_bucket_uses_the_local_calendar_date():
    aware = datetime(2024, 3, 1, 23, 30, tzinfo=timezone.utc)
    assert day_bucket(aware, "Asia/Jakarta") == "2024-03-02"


def test_parse_iso_accepts_trailing_z():
    assert parse_iso("2024-03-01T00:00:00Z") == datetime(2024, 3, 1, tzinfo=timezone.utc)
'''

TZ_TEST_WINDOWS = '''"""Tests for fixed-width windowing."""

from datetime import datetime, timezone

import pytest

from tzdata_pipeline.windows import floor_to, window_key


def test_floor_to_rounds_down_to_the_window():
    moment = datetime(2024, 3, 1, 12, 47, 31, tzinfo=timezone.utc)
    assert floor_to(moment, 15) == datetime(2024, 3, 1, 12, 45, tzinfo=timezone.utc)


def test_floor_to_rejects_a_zero_window():
    with pytest.raises(ValueError):
        floor_to(datetime(2024, 3, 1, tzinfo=timezone.utc), 0)


def test_window_key_is_rendered_in_local_time():
    moment = datetime(2024, 3, 1, 12, 47, tzinfo=timezone.utc)
    assert window_key(moment, "Asia/Jakarta", 15) == "2024-03-01T19:45+0700"
'''


# --- retry-lib -------------------------------------------------------------------------

RETRY_POLICY = '''"""The retry policy object: how many attempts, how long between them."""


class RetryPolicy:
    """Immutable description of a retry strategy.

    `max_attempts` counts *calls*, not retries. A policy with `max_attempts=4` calls
    the wrapped function up to four times, which leaves three gaps to sleep through.
    """

    __slots__ = ("max_attempts", "base_delay", "factor", "max_delay", "retry_on")

    def __init__(self, max_attempts=4, base_delay=0.1, factor=2.0, max_delay=5.0, retry_on=Exception):
        if max_attempts < 1:
            raise ValueError("max_attempts must be at least 1")
        if base_delay < 0:
            raise ValueError("base_delay must not be negative")
        if factor < 1:
            raise ValueError("factor must be at least 1")
        if max_delay < base_delay:
            raise ValueError("max_delay must not be below base_delay")
        self.max_attempts = max_attempts
        self.base_delay = base_delay
        self.factor = factor
        self.max_delay = max_delay
        self.retry_on = retry_on

    def __repr__(self):
        return "RetryPolicy(max_attempts=%r, base_delay=%r, factor=%r, max_delay=%r)" % (
            self.max_attempts,
            self.base_delay,
            self.factor,
            self.max_delay,
        )
'''

RETRY_BACKOFF_GOOD = '''"""Exponential backoff schedules.

The schedule is precomputed rather than derived inside the retry loop so that a caller
can budget for it, log it, or assert on it in a test without running anything.
"""


def delay_at(policy, index):
    """The `index`-th gap, capped at `policy.max_delay`."""
    return min(policy.base_delay * (policy.factor ** index), policy.max_delay)


def schedule(policy):
    """Every gap the policy will sleep through, in order.

    `max_attempts` calls have `max_attempts - 1` gaps between them. The bound below is
    that fencepost: a 4-attempt policy sleeps three times, not four.
    """
    return [delay_at(policy, index) for index in range(policy.max_attempts - 1)]


def total_backoff(policy):
    """Worst-case seconds spent sleeping if every attempt fails."""
    return sum(schedule(policy))
'''

# The regression: the fencepost is lost in a "simplification" of the bound. The retrier
# indexes the schedule defensively so it still behaves; only the published schedule and
# the advertised sleep budget are wrong, which is exactly the sort of bug that survives
# review and reaches production.
RETRY_PATCH = [
    (
        '''    `max_attempts` calls have `max_attempts - 1` gaps between them. The bound below is
    that fencepost: a 4-attempt policy sleeps three times, not four.
    """
    return [delay_at(policy, index) for index in range(policy.max_attempts - 1)]''',
        '''    One gap is produced per attempt the policy allows, in ascending order.
    """
    return [delay_at(policy, index) for index in range(policy.max_attempts)]''',
    ),
]

RETRY_RETRIER = '''"""The retry driver."""

from .backoff import schedule


class Retrier:
    """Calls a function under a `RetryPolicy`.

    The sleeper is injected so tests never actually sleep; the default is
    `time.sleep`, bound lazily so importing this module does not import `time` for
    callers that pass their own.
    """

    def __init__(self, policy, sleeper=None):
        self.policy = policy
        self.sleeper = sleeper
        self.slept = []

    def _sleep(self, seconds):
        self.slept.append(seconds)
        if self.sleeper is not None:
            self.sleeper(seconds)
        elif seconds:
            import time

            time.sleep(seconds)

    def call(self, func, *args, **kwargs):
        gaps = schedule(self.policy)
        last_attempt = self.policy.max_attempts - 1
        for attempt in range(self.policy.max_attempts):
            try:
                return func(*args, **kwargs)
            except self.policy.retry_on:
                if attempt >= last_attempt:
                    raise
                self._sleep(gaps[attempt])
        raise AssertionError("unreachable: loop always returns or raises")
'''

RETRY_TEST_BACKOFF = '''"""Tests for the backoff schedule.

`test_schedule_has_one_gap_per_retry` is the fencepost test: the schedule describes the
gaps *between* attempts, so it is always one shorter than the attempt count.
"""

import pytest

from retry_lib.backoff import delay_at, schedule, total_backoff
from retry_lib.policy import RetryPolicy


def policy(**kwargs):
    base = dict(max_attempts=4, base_delay=0.1, factor=2.0, max_delay=5.0)
    base.update(kwargs)
    return RetryPolicy(**base)


def test_delay_at_grows_geometrically():
    p = policy()
    assert delay_at(p, 0) == pytest.approx(0.1)
    assert delay_at(p, 1) == pytest.approx(0.2)
    assert delay_at(p, 2) == pytest.approx(0.4)


def test_delay_at_is_capped():
    p = policy(max_attempts=12)
    assert delay_at(p, 11) == pytest.approx(5.0)


def test_schedule_has_one_gap_per_retry():
    assert schedule(policy()) == pytest.approx([0.1, 0.2, 0.4])


def test_total_backoff_is_the_sum_of_the_schedule():
    p = policy()
    assert total_backoff(p) == pytest.approx(sum(schedule(p)))
'''

RETRY_TEST_RETRIER = '''"""Tests for the retry driver. No test here ever really sleeps."""

import pytest

from retry_lib.policy import RetryPolicy
from retry_lib.retrier import Retrier


class Boom(Exception):
    pass


def test_a_successful_call_is_not_retried():
    calls = []

    def ok():
        calls.append(1)
        return "fine"

    assert Retrier(RetryPolicy(), sleeper=lambda s: None).call(ok) == "fine"
    assert len(calls) == 1


def test_calls_stop_at_max_attempts():
    calls = []

    def always_fails():
        calls.append(1)
        raise Boom("nope")

    r = Retrier(RetryPolicy(max_attempts=3, retry_on=Boom), sleeper=lambda s: None)
    with pytest.raises(Boom):
        r.call(always_fails)
    assert len(calls) == 3


def test_an_unlisted_exception_is_not_retried():
    calls = []

    def wrong_error():
        calls.append(1)
        raise ValueError("not retryable")

    r = Retrier(RetryPolicy(max_attempts=3, retry_on=Boom), sleeper=lambda s: None)
    with pytest.raises(ValueError):
        r.call(wrong_error)
    assert len(calls) == 1


def test_a_single_attempt_policy_never_sleeps():
    def always_fails():
        raise Boom("nope")

    r = Retrier(RetryPolicy(max_attempts=1, retry_on=Boom), sleeper=lambda s: None)
    with pytest.raises(Boom):
        r.call(always_fails)
    assert r.slept == []


def test_policy_validates_its_arguments():
    with pytest.raises(ValueError):
        RetryPolicy(max_attempts=0)
    with pytest.raises(ValueError):
        RetryPolicy(factor=0.5)
'''


# --- id-mint ---------------------------------------------------------------------------

MINT_GOOD = '''"""Deterministic short identifiers for named resources.

An id is a base-32 rendering of the leading bits of `sha256(canonical_key)`. The same
namespace and name always mint the same id, on any machine, in any process, forever —
which is the entire point, so `canonical_key` is the most safety-critical function in
the package.
"""

import hashlib

#: Length of a minted id, in alphabet characters.
ID_LENGTH = 12

#: Crockford-flavoured base32: no i, l, o or u, so ids cannot be misread aloud.
ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"


def canonical_key(namespace, name):
    """The exact string that gets hashed.

    Case and surrounding whitespace are insignificant. Everything else is significant:
    the whole point of the key is that two different resources cannot produce it.
    """
    return "%s:%s" % (namespace.strip().lower(), name.strip().lower())


def encode(digest, length):
    """Render the leading bits of `digest` as `length` alphabet characters."""
    value = int.from_bytes(digest, "big")
    out = []
    for _ in range(length):
        value, remainder = divmod(value, len(ALPHABET))
        out.append(ALPHABET[remainder])
    return "".join(reversed(out))


def mint(namespace, name, length=ID_LENGTH):
    """Mint the stable short id for a resource."""
    if length < 1:
        raise ValueError("length must be at least 1")
    digest = hashlib.sha256(canonical_key(namespace, name).encode("utf-8")).digest()
    return encode(digest, length)
'''

# The regression: a bounded-cost "optimisation" truncates the key before hashing, so any
# two resources sharing a 16-character prefix mint the same id. Every short-name test in
# the suite still passes, which is what makes it survivable.
MINT_PATCH = [
    (
        '''#: Crockford-flavoured base32: no i, l, o or u, so ids cannot be misread aloud.
ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"''',
        '''#: Crockford-flavoured base32: no i, l, o or u, so ids cannot be misread aloud.
ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"

#: Hashing cost is linear in key length, and the ids only consume the leading bits of
#: the digest anyway, so the key is bounded here.
MAX_KEY_CHARS = 16''',
    ),
    (
        '''    return "%s:%s" % (namespace.strip().lower(), name.strip().lower())''',
        '''    return ("%s:%s" % (namespace.strip().lower(), name.strip().lower()))[:MAX_KEY_CHARS]''',
    ),
]

MINT_REGISTRY = '''"""An in-memory registry that refuses to mint a colliding id."""

from .mint import mint


class CollisionError(Exception):
    """Two distinct resources minted the same id."""


class Registry:
    """Maps minted ids back to the resources that produced them."""

    def __init__(self, length=None):
        self.length = length
        self._by_id = {}

    def add(self, namespace, name):
        ident = mint(namespace, name) if self.length is None else mint(namespace, name, self.length)
        owner = (namespace, name)
        existing = self._by_id.get(ident)
        if existing is not None and existing != owner:
            raise CollisionError("%s already minted by %r" % (ident, existing))
        self._by_id[ident] = owner
        return ident

    def resolve(self, ident):
        return self._by_id.get(ident)

    def __len__(self):
        return len(self._by_id)
'''

MINT_TEST = '''"""Tests for id minting.

`test_similar_service_names_do_not_collide` is the anti-collision contract: the whole
name is significant, not just its opening characters.
"""

import pytest

from id_mint.mint import ID_LENGTH, canonical_key, mint

#: Real-looking deployment names. Several share long prefixes on purpose — that is the
#: shape of a service catalogue, and the shape that breaks a truncating key.
CORPUS = [
    "user-profile-service",
    "user-profile-worker",
    "user-profile-scheduler",
    "billing-invoice-service",
    "billing-invoice-worker",
]


def test_canonical_key_normalises_case_and_whitespace():
    assert canonical_key("  SVC ", " Checkout ") == "svc:checkout"


def test_ids_are_stable_across_runs():
    assert mint("svc", "checkout") == "fy44vjcm1sb5"


def test_length_is_configurable():
    assert mint("svc", "checkout", 8) == "vjcm1sb5"
    assert len(mint("svc", "checkout")) == ID_LENGTH


def test_namespace_is_part_of_the_identity():
    assert mint("a", "x") != mint("b", "x")


def test_length_must_be_positive():
    with pytest.raises(ValueError):
        mint("svc", "checkout", 0)


def test_similar_service_names_do_not_collide():
    ids = [mint("svc", name) for name in CORPUS]
    assert len(set(ids)) == len(CORPUS)
'''

MINT_TEST_REGISTRY = '''"""Tests for the collision-refusing registry."""

import pytest

from id_mint.registry import CollisionError, Registry


def test_registry_resolves_what_it_minted():
    reg = Registry()
    ident = reg.add("svc", "checkout")
    assert reg.resolve(ident) == ("svc", "checkout")
    assert len(reg) == 1


def test_adding_the_same_resource_twice_is_idempotent():
    reg = Registry()
    assert reg.add("svc", "checkout") == reg.add("svc", "checkout")
    assert len(reg) == 1


def test_a_forced_collision_is_refused():
    # length=1 makes collisions certain within a handful of names.
    reg = Registry(length=1)
    with pytest.raises(CollisionError):
        for index in range(64):
            reg.add("svc", "resource-%d" % index)
'''


# --------------------------------------------------------------------------------------
# repository definitions
# --------------------------------------------------------------------------------------

def tz_scaffold():
    pkg = "tzdata_pipeline"
    desc = "Normalise event timestamps arriving from mixed-offset feeds."
    return {
        "pyproject.toml": PYPROJECT.format(dist="tzdata-pipeline", version="0.1.0", description=desc, pkg=pkg),
        "README.md": README.format(dist="tzdata-pipeline", description=desc, pkg=pkg),
        "CHANGELOG.md": CHANGELOG,
        "LICENSE": MIT_LICENSE,
        ".gitignore": "__pycache__/\n*.egg-info/\n.pytest_cache/\n",
        "%s/__init__.py" % pkg: '"""tzdata-pipeline — one UTC representation for every feed."""\n\n'
        'from .normalize import OFFSETS, day_bucket, offset_for, to_utc  # noqa: F401\n'
        'from .windows import floor_to, window_key  # noqa: F401\n\n'
        '__version__ = "0.1.0"\n',
        "%s/normalize.py" % pkg: TZ_NORMALIZE_GOOD,
        "%s/windows.py" % pkg: TZ_WINDOWS,
        "%s/constants.py" % pkg: CONSTANTS,
        "%s/util.py" % pkg: UTIL,
        "tests/test_normalize.py": TZ_TEST_NORMALIZE,
        "tests/test_windows.py": TZ_TEST_WINDOWS,
        "tests/test_util.py": TEST_UTIL.format(pkg=pkg),
    }


def retry_scaffold():
    pkg = "retry_lib"
    desc = "A small, explicit retry policy with a precomputed backoff schedule."
    return {
        "pyproject.toml": PYPROJECT.format(dist="retry-lib", version="0.1.0", description=desc, pkg=pkg),
        "README.md": README.format(dist="retry-lib", description=desc, pkg=pkg),
        "CHANGELOG.md": CHANGELOG,
        "LICENSE": MIT_LICENSE,
        ".gitignore": "__pycache__/\n*.egg-info/\n.pytest_cache/\n",
        "%s/__init__.py" % pkg: '"""retry-lib — retry policies you can read before you run them."""\n\n'
        'from .backoff import delay_at, schedule, total_backoff  # noqa: F401\n'
        'from .policy import RetryPolicy  # noqa: F401\n'
        'from .retrier import Retrier  # noqa: F401\n\n'
        '__version__ = "0.1.0"\n',
        "%s/policy.py" % pkg: RETRY_POLICY,
        "%s/backoff.py" % pkg: RETRY_BACKOFF_GOOD,
        "%s/retrier.py" % pkg: RETRY_RETRIER,
        "%s/constants.py" % pkg: CONSTANTS,
        "%s/util.py" % pkg: UTIL,
        "tests/test_backoff.py": RETRY_TEST_BACKOFF,
        "tests/test_retrier.py": RETRY_TEST_RETRIER,
        "tests/test_util.py": TEST_UTIL.format(pkg=pkg),
    }


def mint_scaffold():
    pkg = "id_mint"
    desc = "Stable, collision-refusing short ids for named resources."
    return {
        "pyproject.toml": PYPROJECT.format(dist="id-mint", version="0.1.0", description=desc, pkg=pkg),
        "README.md": README.format(dist="id-mint", description=desc, pkg=pkg),
        "CHANGELOG.md": CHANGELOG,
        "LICENSE": MIT_LICENSE,
        ".gitignore": "__pycache__/\n*.egg-info/\n.pytest_cache/\n",
        "%s/__init__.py" % pkg: '"""id-mint — the same name always mints the same id."""\n\n'
        'from .mint import ID_LENGTH, canonical_key, mint  # noqa: F401\n'
        'from .registry import CollisionError, Registry  # noqa: F401\n\n'
        '__version__ = "0.1.0"\n',
        "%s/mint.py" % pkg: MINT_GOOD,
        "%s/registry.py" % pkg: MINT_REGISTRY,
        "%s/constants.py" % pkg: CONSTANTS,
        "%s/util.py" % pkg: UTIL,
        "tests/test_mint.py": MINT_TEST,
        "tests/test_registry.py": MINT_TEST_REGISTRY,
        "tests/test_util.py": TEST_UTIL.format(pkg=pkg),
    }


REPOS = {
    "tzdata-pipeline": {
        "package": "tzdata_pipeline",
        "commits": 256,
        "planted_index": 173,
        "scaffold": tz_scaffold,
        "target": "tzdata_pipeline/normalize.py",
        "patch": TZ_PATCH,
        "plant_message": "normalize: normalise to UTC once at the edge",
        "failing_test": "tests/test_normalize.py::test_naive_local_midnight_is_interpreted_in_zone",
        "bug": "to_utc() stamps timezone.utc on naive input instead of the zone's own "
               "offset, so every timestamp from the legacy CSV feed lands off by that "
               "offset. Offset-aware input is unaffected, so the rest of the suite stays green.",
        "docs": ["tzdata_pipeline/normalize.py", "tzdata_pipeline/windows.py", "tzdata_pipeline/util.py"],
    },
    "retry-lib": {
        "package": "retry_lib",
        "commits": 128,
        "planted_index": 91,
        "scaffold": retry_scaffold,
        "target": "retry_lib/backoff.py",
        "patch": RETRY_PATCH,
        "plant_message": "backoff: one gap per allowed attempt",
        "failing_test": "tests/test_backoff.py::test_schedule_has_one_gap_per_retry",
        "bug": "schedule() iterates range(max_attempts) instead of range(max_attempts - 1), "
               "so it publishes one gap too many and total_backoff() overstates the sleep "
               "budget. Retrier indexes the schedule defensively, so its own tests stay green.",
        "docs": ["retry_lib/backoff.py", "retry_lib/policy.py", "retry_lib/util.py"],
    },
    "id-mint": {
        "package": "id_mint",
        "commits": 64,
        "planted_index": 41,
        "scaffold": mint_scaffold,
        "target": "id_mint/mint.py",
        "patch": MINT_PATCH,
        "plant_message": "mint: bound the hashed key length",
        "failing_test": "tests/test_mint.py::test_similar_service_names_do_not_collide",
        "bug": "canonical_key() truncates to MAX_KEY_CHARS=16 before hashing, so any two "
               "resources sharing a 16-character prefix mint the same id. Every short-name "
               "test still passes, which is what lets it through review.",
        "docs": ["id_mint/mint.py", "id_mint/registry.py", "id_mint/util.py"],
    },
}


# --------------------------------------------------------------------------------------
# filler mutations — real changes, never empty commits
# --------------------------------------------------------------------------------------

AREAS = ["docs", "chore", "refactor", "test", "build"]

NOTE_SUBJECTS = [
    "spell out the units on the public helpers",
    "record why the offset table is hand-maintained",
    "call out the pure-function invariant in the module header",
    "note that the helpers never allocate on the hot path",
    "document the failure mode callers actually hit",
    "clarify which arguments are keyword-only",
    "explain the naming of the private helpers",
    "cross-reference the module that owns this contract",
    "mention the assumption the tests encode",
    "describe the ordering guarantee callers rely on",
    "flag the branch that is deliberately not defensive",
    "state the precision the caller can count on",
]

HELPER_TEMPLATES = [
    (
        'def {name}(values):\n'
        '    """Drop the Nones, keep the order."""\n'
        '    return [value for value in values if value is not None]\n',
        'def test_{name}():\n'
        '    assert util.{name}([1, None, 2]) == [1, 2]\n',
    ),
    (
        'def {name}(value, low, high):\n'
        '    """Clamp `value` into the inclusive range [low, high]."""\n'
        '    return min(max(value, low), high)\n',
        'def test_{name}():\n'
        '    assert util.{name}(9, 0, 5) == 5\n'
        '    assert util.{name}(-1, 0, 5) == 0\n',
    ),
    (
        'def {name}(items, size):\n'
        '    """Split `items` into consecutive chunks of at most `size`."""\n'
        '    if size < 1:\n'
        '        raise ValueError("size must be positive")\n'
        '    return [items[i:i + size] for i in range(0, len(items), size)]\n',
        'def test_{name}():\n'
        '    assert util.{name}([1, 2, 3], 2) == [[1, 2], [3]]\n',
    ),
    (
        'def {name}(text):\n'
        '    """Lowercase, collapse whitespace, join with hyphens."""\n'
        '    return "-".join(text.lower().split())\n',
        'def test_{name}():\n'
        '    assert util.{name}("  Hello   World ") == "hello-world"\n',
    ),
    (
        'def {name}(value, default=0):\n'
        '    """Best-effort int coercion that never raises."""\n'
        '    try:\n'
        '        return int(value)\n'
        '    except (TypeError, ValueError):\n'
        '        return default\n',
        'def test_{name}():\n'
        '    assert util.{name}("7") == 7\n'
        '    assert util.{name}("x", 3) == 3\n',
    ),
    (
        'def {name}(items):\n'
        '    """De-duplicate while preserving first-seen order."""\n'
        '    seen = set()\n'
        '    out = []\n'
        '    for item in items:\n'
        '        if item not in seen:\n'
        '            seen.add(item)\n'
        '            out.append(item)\n'
        '    return out\n',
        'def test_{name}():\n'
        '    assert util.{name}([1, 2, 1, 3]) == [1, 2, 3]\n',
    ),
]

HELPER_VERBS = ["normalise", "coerce", "collapse", "flatten", "compact", "resolve",
                "trim", "align", "expand", "merge"]
HELPER_NOUNS = ["keys", "values", "rows", "labels", "records", "entries", "tokens",
                "chunks", "fields", "spans", "batches", "slots"]

CONSTANT_NAMES = ["MAX_BATCH_ROWS", "DEFAULT_PAGE_SIZE", "WARN_AFTER_SECONDS",
                  "MAX_LABEL_CHARS", "RETRY_BUDGET_SECONDS", "CACHE_ENTRIES",
                  "MAX_INFLIGHT", "SLOW_CALL_MILLIS", "MAX_KEY_PARTS", "LOG_SAMPLE_RATE"]


def append_to_docstring(source, line):
    """Insert `line` as the last paragraph of a module docstring."""
    open_quote = source.index('"""')
    close_quote = source.index('"""', open_quote + 3)
    return source[:close_quote] + "\n" + line + "\n" + source[close_quote:]


class Filler:
    """Deterministic stream of real, small, plausible changes."""

    def __init__(self, spec, rng):
        self.spec = spec
        self.rng = rng
        self.pkg = spec["package"]
        self.version = [0, 1, 0]
        self.helper_names = self._helper_names()
        self.helper_cursor = 0
        self.constant_cursor = 0
        self.note_cursor = 0
        self.doc_cursor = 0
        self.issue = 100

    def _helper_names(self):
        names = ["%s_%s" % (verb, noun) for verb in HELPER_VERBS for noun in HELPER_NOUNS]
        self.rng.shuffle(names)
        return names

    def next_issue(self):
        self.issue += self.rng.randint(1, 4)
        return self.issue

    def apply(self, files):
        """Mutate `files` in place and return the commit message."""
        kind = self.rng.choices(
            ["changelog", "docstring", "helper", "constant", "version", "readme"],
            weights=[30, 26, 18, 12, 6, 8],
        )[0]
        return getattr(self, "_" + kind)(files)

    def _note(self):
        note = NOTE_SUBJECTS[self.note_cursor % len(NOTE_SUBJECTS)]
        self.note_cursor += 1
        return note

    def _changelog(self, files):
        area = AREAS[self.rng.randrange(len(AREAS))]
        note = self._note()
        issue = self.next_issue()
        files["CHANGELOG.md"] += "- (#%d) %s: %s\n" % (issue, area, note)
        return "docs(changelog): %s (#%d)" % (note, issue)

    def _docstring(self, files):
        targets = self.spec["docs"]
        target = targets[self.doc_cursor % len(targets)]
        self.doc_cursor += 1
        note = self._note()
        sentence = "Note: " + note[0].upper() + note[1:] + "."
        files[target] = append_to_docstring(files[target], sentence)
        module = os.path.basename(target)[:-3]
        return "docs(%s): %s" % (module, note)

    def _helper(self, files):
        if self.helper_cursor >= len(self.helper_names):
            return self._changelog(files)
        name = self.helper_names[self.helper_cursor]
        self.helper_cursor += 1
        body, test = HELPER_TEMPLATES[self.rng.randrange(len(HELPER_TEMPLATES))]
        util_path = "%s/util.py" % self.pkg
        files[util_path] += "\n\n" + body.format(name=name)
        files["tests/test_util.py"] += "\n" + test.format(name=name) + "\n"
        return "util: add %s()" % name

    def _constant(self, files):
        name = CONSTANT_NAMES[self.constant_cursor % len(CONSTANT_NAMES)]
        if self.constant_cursor >= len(CONSTANT_NAMES):
            name = "%s_%d" % (name, self.constant_cursor // len(CONSTANT_NAMES) + 1)
        self.constant_cursor += 1
        value = self.rng.choice([8, 16, 32, 64, 100, 128, 250, 500, 1000])
        files["%s/constants.py" % self.pkg] += "\n%s = %d\n" % (name, value)
        return "chore(constants): introduce %s" % name

    def _version(self, files):
        self.version[2] += 1
        new = ".".join(str(part) for part in self.version)
        old_line = 'version = "%s"' % ".".join(
            [str(self.version[0]), str(self.version[1]), str(self.version[2] - 1)]
        )
        files["pyproject.toml"] = files["pyproject.toml"].replace(old_line, 'version = "%s"' % new, 1)
        init = "%s/__init__.py" % self.pkg
        files[init] = files[init].replace(
            '__version__ = "%s"' % ".".join([str(self.version[0]), str(self.version[1]), str(self.version[2] - 1)]),
            '__version__ = "%s"' % new,
            1,
        )
        return "build: bump version to %s" % new

    def _readme(self, files):
        note = self._note()
        files["README.md"] += "- %s%s.\n" % (note[0].upper(), note[1:])
        return "docs(readme): %s" % note


# --------------------------------------------------------------------------------------
# generation
# --------------------------------------------------------------------------------------

def apply_patch(source, patch, name):
    """Apply the planted regression as a minimal hunk on the CURRENT file.

    A whole-file swap would also revert every docstring line the filler commits added
    since the scaffold, so the culprit's diff would be large and obviously synthetic.
    Patching the live content keeps the planted diff to exactly the regression.
    """
    for old, new in patch:
        if old not in source:
            raise RuntimeError("%s: plant anchor not found in %s" % (name, old.splitlines()[0]))
        source = source.replace(old, new, 1)
    return source


def build_repo(name, spec, root):
    """Create the repository at `root` and return its ordered list of commit SHAs."""
    if os.path.exists(root):
        shutil.rmtree(root)
    os.makedirs(root)
    git(["init", "-q", "-b", DEFAULT_BRANCH, "."], cwd=root, env=commit_env(0))

    rng = random.Random(SEED + sum(ord(c) for c in name))
    files = spec["scaffold"]()
    filler = Filler(spec, rng)

    total = spec["commits"]
    planted = spec["planted_index"]
    if not 1 <= planted < total:
        raise ValueError("planted_index out of range for %s" % name)

    commit(root, files, "chore: initial package scaffold with tests", 0)
    for index in range(1, total):
        if index == planted:
            files[spec["target"]] = apply_patch(files[spec["target"]], spec["patch"], name)
            message = spec["plant_message"]
        else:
            message = filler.apply(files)
        commit(root, files, message, index)

    return history(root)


def history(root):
    out = git(["rev-list", "--reverse", "HEAD"], cwd=root)
    return [line.strip() for line in out.splitlines() if line.strip()]


def history_digest(shas):
    return hashlib.sha256("\n".join(shas).encode("utf-8")).hexdigest()


def repo_record(name, spec, path, shas):
    planted = spec["planted_index"]
    return {
        "name": name,
        "path": os.path.basename(path),
        "package": spec["package"],
        "commits": len(shas),
        "plantedIndex": planted,
        "plantedSha": shas[planted],
        "parentSha": shas[planted - 1],
        "goodRef": shas[0],
        "badRef": shas[-1],
        "headSha": shas[-1],
        "historySha256": history_digest(shas),
        "failingTest": spec["failing_test"],
        "testCommand": "python -m pytest -q " + spec["failing_test"],
        "suiteCommand": "python -m pytest -q",
        "bug": spec["bug"],
        "plantMessage": spec["plant_message"],
    }


def generate(out_dir, only=None):
    os.makedirs(out_dir, exist_ok=True)
    names = [only] if only else list(REPOS)
    records = []
    for name in names:
        spec = REPOS[name]
        path = os.path.join(out_dir, name)
        sys.stderr.write("building %s (%d commits) ...\n" % (name, spec["commits"]))
        shas = build_repo(name, spec, path)
        records.append(repo_record(name, spec, path, shas))
        sys.stderr.write("  planted %s at index %d/%d\n" % (records[-1]["plantedSha"][:12], spec["planted_index"], spec["commits"]))

    manifest_path = os.path.join(out_dir, MANIFEST_NAME)
    manifest = {
        "schema": MANIFEST_SCHEMA,
        "generator": {
            "seed": SEED,
            "author": "%s <%s>" % (AUTHOR_NAME, AUTHOR_EMAIL),
            "baseEpoch": BASE_EPOCH,
            "commitIntervalSeconds": COMMIT_INTERVAL_SECONDS,
            "branch": DEFAULT_BRANCH,
            "git": git_version(),
            "python": sys.version.split()[0],
        },
        "repos": records,
    }
    if only and os.path.isfile(manifest_path):
        # Keep the records for repos this run did not touch.
        try:
            with open(manifest_path, encoding="utf-8") as fh:
                previous = json.load(fh)
            kept = [r for r in previous.get("repos", []) if r["name"] != only]
            manifest["repos"] = sorted(kept + records, key=lambda r: list(REPOS).index(r["name"]))
        except (OSError, ValueError, KeyError):
            pass
    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")
    sys.stderr.write("manifest: %s\n" % manifest_path)
    return manifest


def verify(out_dir, only=None):
    """Re-derive every history from scratch and compare against the manifest."""
    manifest_path = os.path.join(out_dir, MANIFEST_NAME)
    with open(manifest_path, encoding="utf-8") as fh:
        manifest = json.load(fh)

    failures = []
    staging = tempfile.mkdtemp(prefix="faultbench-verify-")
    try:
        for record in manifest["repos"]:
            name = record["name"]
            if only and name != only:
                continue
            spec = REPOS[name]

            on_disk = os.path.join(out_dir, record["path"])
            if os.path.isdir(os.path.join(on_disk, ".git")):
                shas = history(on_disk)
                check(failures, name, "on-disk history length", len(shas), record["commits"])
                check(failures, name, "on-disk history digest", history_digest(shas), record["historySha256"])
                if len(shas) == record["commits"]:
                    check(failures, name, "on-disk planted sha", shas[record["plantedIndex"]], record["plantedSha"])
                    check(failures, name, "on-disk parent sha", shas[record["plantedIndex"] - 1], record["parentSha"])
            else:
                failures.append("%s: no repository at %s" % (name, on_disk))

            sys.stderr.write("re-deriving %s ...\n" % name)
            rebuilt = build_repo(name, spec, os.path.join(staging, name))
            check(failures, name, "rebuilt history digest", history_digest(rebuilt), record["historySha256"])
            check(failures, name, "rebuilt planted sha", rebuilt[record["plantedIndex"]], record["plantedSha"])
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    if failures:
        for line in failures:
            print("FAIL  " + line)
        return 1
    print("OK  every history re-derived to the SHAs recorded in %s" % manifest_path)
    return 0


def check(failures, name, label, actual, expected):
    if actual != expected:
        failures.append("%s: %s is %r, manifest says %r" % (name, label, actual, expected))


def main(argv=None):
    parser = argparse.ArgumentParser(description="Generate the FAULTBENCH-3 seed repositories.")
    parser.add_argument("--out", required=True, help="output directory (created if absent)")
    parser.add_argument("--only", choices=sorted(REPOS), help="build or verify a single repository")
    parser.add_argument("--verify", action="store_true", help="re-derive SHAs and compare to the manifest")
    args = parser.parse_args(argv)

    out_dir = os.path.abspath(args.out)
    if args.verify:
        return verify(out_dir, args.only)

    manifest = generate(out_dir, args.only)
    for record in manifest["repos"]:
        print("%-16s %3d commits  planted %s  parent %s  %s" % (
            record["name"], record["commits"], record["plantedSha"][:12],
            record["parentSha"][:12], record["failingTest"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
