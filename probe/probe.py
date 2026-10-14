#!/usr/bin/env python3
"""Faultline probe — tests ONE git commit and self-reports a verdict.

Runs as the entrypoint of a Nebius Serverless AI Job on a stock `python:3.11` image; the
application injects this file into the container at launch. The Jobs API exposes no exit
code and no logs over REST, so the only channel back to the application is one JSON
document, PUT to a presigned URL that authorises exactly one key:

    PUT $FAULTLINE_VERDICT_URL        (the probe's own verdict object, nothing else)

then an EMPTY request to $FAULTLINE_TICK_URL, which tells the application "something
landed — reconcile". The tick carries nothing: the application reads the verdict from
storage itself, so a forged tick can at worst cause a harmless extra reconcile.

The single most important rule in this file is the pass/fail/error split:

    pass   the test command exited 0
    fail   the test command itself exited non-zero — except the exits below
    error  the test never got to run (clone, checkout, dependency install, timeout,
           bad configuration, unhandled exception), or the command said it tested
           nothing: exit 125 from any command (`git bisect run`'s "cannot test this
           commit"), and pytest's exit 4 (usage error, e.g. the selected test does not
           exist at this commit) or 5 (no tests collected). The application treats
           `error` as `git bisect skip`, never as evidence about the commit

An `error` recorded as a `fail` would narrow the bisection search and blame an
innocent commit. Every code path below is written to preserve that distinction.

The probe enforces its OWN deadline (FAULTLINE_TIMEOUT_SECONDS), well inside the
platform's job timeout, so that it always lives long enough to report.

Visitor code runs in this container. So the verdict URL and the tick URL are removed
from the environment handed to git, pip and the test, and scrubbed from any output that
is carried back. No credential is ever given to the job at all.

Stdlib only, on purpose: every third-party import is cold-start cost and one more way to
fail before the verdict is written.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.request

SCHEMA = "faultline.probe.v2"

# Last N characters of combined test output carried in the verdict. The tail is rendered
# in a public, judged UI, so it is capped here and never unbounded.
TAIL_LIMIT = 4000
TRUNCATION_MARKER = "[... output truncated, showing last {n} characters ...]\n"

DEFAULT_TIMEOUT_SECONDS = 900

# `git bisect run`'s exit for "this commit cannot be tested", from any test command.
CANNOT_TEST_EXIT = 125

# pytest's documented exits for "nothing was tested". 1 (tests failed) and 2 (interrupted, or a
# collection error, which a regression can cause) remain `fail`.
PYTEST_DID_NOT_RUN = {
    4: "usage error: the selected test does not exist at this commit",
    5: "no tests were collected",
}

# Env vars that carry capabilities. Never handed to a child process.
PRIVATE_ENV = ("FAULTLINE_VERDICT_URL", "FAULTLINE_TICK_URL")

# Env var NAMES whose VALUES get scrubbed out of tail/detail before writing.
SECRETISH_NAME = re.compile(r"(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)", re.IGNORECASE)

# https://user:pass@host -> https://[REDACTED]:[REDACTED]@host
URL_CREDENTIALS = re.compile(r"(?P<scheme>[a-zA-Z][a-zA-Z0-9+.-]*://)(?P<user>[^/\s:@]+):(?P<pw>[^/\s@]+)@")

# Common bearer/authorization shapes that show up in pip / git output.
BEARER = re.compile(r"(?i)\b(bearer|authorization:\s*bearer)\s+([A-Za-z0-9._\-]{12,})")

# Any SigV4 query-string signature, wherever it came from.
PRESIGNED = re.compile(r"(?i)(X-Amz-(?:Signature|Credential)=)[^&\s\"']+")

REDACTED = "[REDACTED]"


# --------------------------------------------------------------------------------------
# redaction
# --------------------------------------------------------------------------------------

def _secret_values() -> list[str]:
    """Values that must never be echoed back, longest first.

    Longest-first matters: if TOKEN is a prefix of TOKEN_FULL, replacing the long one
    first avoids leaving a readable suffix behind.
    """
    out: list[str] = []
    for name, value in os.environ.items():
        if not value or len(value) < 6:
            continue
        if SECRETISH_NAME.search(name) or name in PRIVATE_ENV:
            out.append(value)
    # Credentials embedded in the repo URL are secrets even though the var name is not.
    repo_url = os.environ.get("FAULTLINE_REPO_URL", "")
    m = URL_CREDENTIALS.search(repo_url)
    if m:
        out.append(m.group("pw"))
        out.append(m.group("user"))
    return sorted(set(out), key=len, reverse=True)


def redact(text: str | None, secrets: list[str]) -> str | None:
    if not text:
        return text
    for secret in secrets:
        if secret and secret in text:
            text = text.replace(secret, REDACTED)
    text = URL_CREDENTIALS.sub(lambda m: f"{m.group('scheme')}{REDACTED}:{REDACTED}@", text)
    text = BEARER.sub(lambda m: f"{m.group(1)} {REDACTED}", text)
    text = PRESIGNED.sub(lambda m: f"{m.group(1)}{REDACTED}", text)
    return text


def make_tail(text: str) -> str | None:
    """Last TAIL_LIMIT characters, with a marker when anything was dropped."""
    if not text:
        return None
    if len(text) <= TAIL_LIMIT:
        return text
    return TRUNCATION_MARKER.format(n=TAIL_LIMIT) + text[-TAIL_LIMIT:]


def child_env(extra: dict | None = None) -> dict:
    """The environment visitor code sees: ours, minus every capability."""
    env = {k: v for k, v in os.environ.items() if k not in PRIVATE_ENV}
    env.setdefault("PIP_DISABLE_PIP_VERSION_CHECK", "1")
    env.setdefault("PIP_NO_INPUT", "1")
    env.setdefault("PIP_ROOT_USER_ACTION", "ignore")
    env.setdefault("GIT_TERMINAL_PROMPT", "0")
    if extra:
        env.update(extra)
    return env


# --------------------------------------------------------------------------------------
# errors
# --------------------------------------------------------------------------------------

class ProbeError(Exception):
    """Something stopped the test from running. Always maps to verdict `error`."""

    def __init__(self, detail: str, output: str = "") -> None:
        super().__init__(detail)
        self.detail = detail
        self.output = output


# --------------------------------------------------------------------------------------
# subprocess helper
# --------------------------------------------------------------------------------------

def run(argv: list[str], cwd: str | None = None, timeout: float = 600, env: dict | None = None):
    """Run a command, capture combined output as text. Never raises on non-zero exit."""
    return subprocess.run(
        argv,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        errors="replace",
        timeout=max(1, timeout),
        env=env if env is not None else child_env(),
    )


class Budget:
    """The probe's own deadline. Every step draws from it; none may outlive it."""

    def __init__(self, seconds: int) -> None:
        self.deadline = time.monotonic() + seconds
        self.total = seconds

    def remaining(self) -> float:
        return self.deadline - time.monotonic()

    def slice(self, label: str, at_most: float | None = None) -> float:
        left = self.remaining()
        if left <= 5:
            raise ProbeError(f"probe deadline of {self.total}s reached before {label}")
        return min(left, at_most) if at_most else left


# --------------------------------------------------------------------------------------
# steps
# --------------------------------------------------------------------------------------

def clone_commit(repo_url: str, sha: str, workdir: str, budget: Budget) -> str:
    """Shallow-fetch exactly one commit.

    `git clone` of a large repo downloads every object in history to test a single
    commit. init + remote add + fetch --depth 1 <sha> downloads one tree. That is the
    whole point of a per-commit container: the probe should be dominated by the test,
    not by history it will never read.
    """
    log: list[str] = []
    steps = [
        (["git", "init", "--quiet", workdir], None),
        (["git", "remote", "add", "origin", repo_url], workdir),
        (["git", "fetch", "--quiet", "--depth", "1", "origin", sha], workdir),
        (["git", "checkout", "--quiet", "FETCH_HEAD"], workdir),
    ]
    for argv, cwd in steps:
        timeout = budget.slice("git", at_most=max(60.0, budget.total / 3))
        try:
            proc = run(argv, cwd=cwd, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise ProbeError(f"git step timed out after {int(timeout)}s: {' '.join(argv)}", "\n".join(log))
        except OSError as exc:
            raise ProbeError(f"could not execute git: {exc}", "\n".join(log))
        log.append(f"$ {' '.join(argv)}\n{proc.stdout}")
        if proc.returncode != 0:
            raise ProbeError(
                f"git step failed (exit {proc.returncode}): {' '.join(argv)}",
                "\n".join(log),
            )
    return "\n".join(log)


def detect_install(workdir: str) -> tuple[str, list[str] | None]:
    """The install this commit declares, when the caller gave none. (strategy, argv).

    Priority: pyproject.toml or setup.py -> `pip install -e .`; else requirements.txt ->
    `pip install -r requirements.txt`; else none. `none` is not an
    error: plenty of suites are stdlib-only, and refusing to run them would report
    `error` for commits that are perfectly testable.
    """
    def has(name: str) -> bool:
        return os.path.isfile(os.path.join(workdir, name))

    pip = [sys.executable, "-m", "pip", "install", "--no-input", "--quiet"]
    if has("pyproject.toml") or has("setup.py"):
        return ("pip install -e . (detected)", pip + ["-e", "."])
    if has("requirements.txt"):
        return ("pip install -r requirements.txt (detected)", pip + ["-r", "requirements.txt"])
    return ("none (no pyproject.toml, setup.py or requirements.txt at repo root)", None)


def resolve_install(command: str, workdir: str) -> tuple[str, list[str] | None]:
    """Turn the user's install command into argv, pointing `pip` at this interpreter."""
    command = command.strip()
    if not command:
        return detect_install(workdir)
    try:
        argv = shlex.split(command)
    except ValueError as exc:
        raise ProbeError(f"install command is not parseable: {exc}")
    if not argv:
        return detect_install(workdir)
    head = os.path.basename(argv[0])
    if head in ("pip", "pip3"):
        argv = [sys.executable, "-m", "pip"] + argv[1:]
    elif head in ("python", "python3"):
        argv = [sys.executable] + argv[1:]
    return (command, argv)


def install_dependencies(command: str, workdir: str, budget: Budget) -> tuple[str, str]:
    """Install THIS COMMIT's declared dependencies. Returns (strategy, log)."""
    strategy, argv = resolve_install(command, workdir)
    if argv is None:
        return (strategy, "")

    timeout = budget.slice("dependency install", at_most=max(120.0, budget.total / 2))
    try:
        proc = run(argv, cwd=workdir, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise ProbeError(f"dependency install timed out after {int(timeout)}s ({strategy})")
    except OSError as exc:
        raise ProbeError(f"could not execute installer: {exc}")

    log = f"$ {strategy}\n{proc.stdout}"
    if proc.returncode != 0:
        # Install failure is an ERROR, never a FAIL. The commit's test never ran, so we
        # know nothing about whether the commit is good, and must not narrow the search.
        raise ProbeError(f"dependency install failed (exit {proc.returncode}) using {strategy}", log)
    return (strategy, log)


def wants_pytest(argv: list[str]) -> bool:
    if not argv:
        return False
    head = os.path.basename(argv[0])
    if head in ("pytest", "py.test"):
        return True
    return head.startswith("python") and argv[1:3] == ["-m", "pytest"]


def ensure_pytest(argv: list[str], workdir: str, budget: Budget) -> str | None:
    """A commit whose declared install omits pytest still deserves a verdict.

    Returns a note for the detail line when pytest had to be added, else None.
    """
    if not wants_pytest(argv):
        return None
    check = run([sys.executable, "-c", "import pytest"], cwd=workdir, timeout=60)
    if check.returncode == 0:
        return None
    timeout = budget.slice("pytest install", at_most=180.0)
    try:
        proc = run([sys.executable, "-m", "pip", "install", "--quiet", "pytest"], cwd=workdir, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise ProbeError("installing pytest timed out")
    if proc.returncode != 0:
        raise ProbeError(f"this commit does not install pytest and adding it failed (exit {proc.returncode})", proc.stdout)
    return "pytest was not installed by this commit's dependencies, so the latest pytest was added"


def run_test(command: str, workdir: str, budget: Budget) -> tuple[int, str, str | None]:
    """Run the test command. Returns (exit_code, combined_output, note).

    Raises ProbeError when the command could not run at all, timed out, or exited with a
    code that means it tested nothing (125; pytest's 4 and 5). Any other non-zero exit is
    returned normally: that is a `fail`, which is a real result.
    """
    try:
        argv = shlex.split(command)
    except ValueError as exc:
        raise ProbeError(f"test command is not parseable: {exc}")
    if not argv:
        raise ProbeError("test command is empty")

    is_pytest = wants_pytest(argv)
    note = ensure_pytest(argv, workdir, budget)
    head = os.path.basename(argv[0])
    if head in ("python", "python3"):
        argv = [sys.executable] + argv[1:]
    elif head in ("pytest", "py.test"):
        # Through this interpreter, so the suite sees exactly what was just installed.
        argv = [sys.executable, "-m", "pytest"] + argv[1:]

    # Make the checkout importable for `python -m pytest` style commands without an
    # install step, and keep output unbuffered so a timeout still yields a useful tail.
    existing = os.environ.get("PYTHONPATH")
    env = child_env({
        "PYTHONPATH": workdir + (os.pathsep + existing if existing else ""),
        "PYTHONUNBUFFERED": "1",
    })

    timeout = budget.slice("the test")
    try:
        proc = run(argv, cwd=workdir, timeout=timeout, env=env)
    except subprocess.TimeoutExpired as exc:
        partial = exc.output or ""
        if isinstance(partial, bytes):
            partial = partial.decode("utf-8", "replace")
        raise ProbeError(f"test command timed out after {int(timeout)}s", partial)
    except OSError as exc:
        raise ProbeError(f"could not execute test command {argv[0]!r}: {exc}")
    # Exits that say the command tested nothing. Recorded as `fail`, a commit where the test
    # file does not exist yet would narrow the search and blame an innocent commit.
    if proc.returncode == CANNOT_TEST_EXIT:
        raise ProbeError(f"test command exited {CANNOT_TEST_EXIT} (cannot test this commit)", proc.stdout)
    if is_pytest and proc.returncode in PYTEST_DID_NOT_RUN:
        raise ProbeError(f"pytest exited {proc.returncode} ({PYTEST_DID_NOT_RUN[proc.returncode]})", proc.stdout)
    return (proc.returncode, proc.stdout, note)


# --------------------------------------------------------------------------------------
# output
# --------------------------------------------------------------------------------------

def http(method: str, url: str, body: bytes | None, content_type: str | None, timeout: float = 30) -> int:
    request = urllib.request.Request(url, data=body, method=method)
    if content_type:
        request.add_header("Content-Type", content_type)
    request.add_header("User-Agent", "faultline-probe")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.status


def put_verdict(url: str, payload: bytes, attempts: int = 4) -> None:
    """PUT the verdict, retrying transient failures. Raises after the last attempt."""
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            status = http("PUT", url, payload, "application/json")
            if 200 <= status < 300:
                return
            last = RuntimeError(f"HTTP {status}")
        except urllib.error.HTTPError as exc:
            last = RuntimeError(f"HTTP {exc.code}")
            if 400 <= exc.code < 500 and exc.code not in (408, 429):
                break  # a signature or expiry problem will not improve with retries
        except Exception as exc:  # noqa: BLE001 - network errors of every shape
            last = exc
        time.sleep(min(8, 2 ** attempt))
    raise RuntimeError(f"verdict upload failed: {last}")


def send_tick(url: str) -> None:
    """Best effort. A lost tick is recovered by the next poll or the sweep."""
    for attempt in range(2):
        try:
            http("POST", url, b"", None, timeout=20)
            return
        except Exception:  # noqa: BLE001
            time.sleep(2 * (attempt + 1))


def write_local(output_path: str, hunt_id: str, probe_key: str, payload: bytes) -> str:
    """Local-run fallback when no verdict URL is given: an atomic file write."""
    directory = os.path.join(output_path, hunt_id, "verdicts")
    os.makedirs(directory, exist_ok=True)
    final = os.path.join(directory, f"{probe_key}.json")
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=f".{probe_key}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, final)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return final


def env_or_fail(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ProbeError(f"required environment variable {name} is missing or empty")
    return value


# --------------------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------------------

def probe() -> dict:
    """Clone, install, test. Returns the verdict document (never raises)."""
    started = time.monotonic()

    # Read these defensively: they name the verdict, which must be written even when
    # configuration is what is broken.
    hunt_id = os.environ.get("FAULTLINE_HUNT_ID", "").strip() or "unknown-hunt"
    commit_sha = os.environ.get("FAULTLINE_COMMIT_SHA", "").strip() or "unknown-commit"
    probe_key = os.environ.get("FAULTLINE_PROBE_KEY", "").strip() or commit_sha

    secrets = _secret_values()
    verdict = "error"
    exit_code: int | None = None
    detail: str | None = None
    tail_source = ""
    timings: dict[str, int] = {}
    install_used: str | None = None

    try:
        hunt_id = env_or_fail("FAULTLINE_HUNT_ID")
        repo_url = env_or_fail("FAULTLINE_REPO_URL")
        commit_sha = env_or_fail("FAULTLINE_COMMIT_SHA")
        test_command = env_or_fail("FAULTLINE_TEST_COMMAND")
        install_command = os.environ.get("FAULTLINE_INSTALL_COMMAND", "")

        raw_timeout = os.environ.get("FAULTLINE_TIMEOUT_SECONDS", "").strip()
        try:
            timeout = int(raw_timeout) if raw_timeout else DEFAULT_TIMEOUT_SECONDS
        except ValueError:
            raise ProbeError(f"FAULTLINE_TIMEOUT_SECONDS is not an integer: {raw_timeout!r}")
        if timeout <= 0:
            raise ProbeError(f"FAULTLINE_TIMEOUT_SECONDS must be positive, got {timeout}")
        budget = Budget(timeout)

        workdir = tempfile.mkdtemp(prefix="faultline-repo-")

        t0 = time.monotonic()
        clone_commit(repo_url, commit_sha, workdir, budget)
        t1 = time.monotonic()
        install_used, _ = install_dependencies(install_command, workdir, budget)
        t2 = time.monotonic()
        exit_code, test_output, note = run_test(test_command, workdir, budget)
        t3 = time.monotonic()
        timings = {
            "cloneMs": int((t1 - t0) * 1000),
            "installMs": int((t2 - t1) * 1000),
            "testMs": int((t3 - t2) * 1000),
        }

        verdict = "pass" if exit_code == 0 else "fail"
        detail = f"deps: {install_used}; test exited {exit_code}"
        if note:
            detail += f"; {note}"
        tail_source = test_output

    except ProbeError as exc:
        verdict = "error"
        exit_code = None
        detail = exc.detail
        tail_source = exc.output or ""
    except BaseException:
        # Last line of defence. Anything at all — including KeyboardInterrupt and
        # SystemExit — still produces a verdict rather than a silent absence.
        verdict = "error"
        exit_code = None
        detail = "unhandled exception in probe:\n" + traceback.format_exc()
        tail_source = ""

    return {
        "schema": SCHEMA,
        "huntId": hunt_id,
        "probeKey": probe_key,
        "commitSha": commit_sha,
        "verdict": verdict,
        "exitCode": exit_code,
        "durationMs": int((time.monotonic() - started) * 1000),
        "installCommand": redact(install_used, secrets),
        "timings": timings,
        "detail": redact(detail, secrets),
        "tail": redact(make_tail(redact(tail_source, secrets) or ""), secrets),
    }


def main() -> int:
    result = probe()
    payload = (json.dumps(result, ensure_ascii=False) + "\n").encode("utf-8")

    # 1. The JSON line, flushed before anything else can go wrong. `nebius ai job logs`
    #    is CLI-only, but whoever reads it sees the exact verdict the app acted on.
    sys.stdout.write(payload.decode("utf-8"))
    sys.stdout.flush()

    verdict_url = os.environ.get("FAULTLINE_VERDICT_URL", "").strip()
    tick_url = os.environ.get("FAULTLINE_TICK_URL", "").strip()

    # 2. The verdict document, to the one key this probe may write.
    try:
        if verdict_url:
            put_verdict(verdict_url, payload)
            print("faultline: verdict uploaded", flush=True)
        else:
            output_path = os.environ.get("FAULTLINE_OUTPUT_PATH", "").strip() or "/out"
            written = write_local(output_path, result["huntId"], result["probeKey"], payload)
            print(f"faultline: verdict written to {written}", flush=True)
    except Exception as exc:  # noqa: BLE001 - nothing above this to catch it
        print(f"faultline: FAILED to deliver verdict: {exc}", file=sys.stderr, flush=True)
        return 2

    # 3. The empty tick: "reconcile now". Sent only after the verdict is durable, so the
    #    reconcile it triggers can always see it.
    if tick_url:
        send_tick(tick_url)

    # Exit 0 whenever a verdict was DELIVERED — `pass`, `fail` and `error` alike. That keeps
    # the job's own state a clean infrastructure signal: COMPLETED means "reported", and
    # FAILED means the probe could not report, which the app retries rather than reads.
    return 0


if __name__ == "__main__":
    sys.exit(main())
