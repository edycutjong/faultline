#!/usr/bin/env python3
"""Faultline probe — tests ONE git commit and self-reports a verdict.

Runs as the entrypoint of a Nebius Serverless AI Job. The Jobs API exposes no exit
code and no logs over REST, so the only channel back to the application is a JSON
file written to the mounted Object Storage volume:

    $FAULTLINE_OUTPUT_PATH/<huntId>/probes/<commitSha>.json

That file MUST exist when this process ends, whatever went wrong. A missing verdict
file is indistinguishable from a still-running probe and stalls the whole hunt.

The single most important rule in this file is the pass/fail/error split:

    pass   the test command exited 0
    fail   the test command itself exited non-zero
    error  the test never got to run (clone, checkout, dependency install, timeout,
           bad configuration, unhandled exception)

An `error` recorded as a `fail` would narrow the bisection search and blame an
innocent commit. Every code path below is written to preserve that distinction.

Stdlib only, on purpose: this runs in a minimal container where every third-party
import is cold-start cost and one more way to fail before the verdict is written.
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

SCHEMA = "faultline.probe.v1"

# Last N characters of combined test output carried in the verdict file. The tail is
# rendered in a public, judged UI, so it is capped here and never unbounded.
TAIL_LIMIT = 4000
TRUNCATION_MARKER = "[... output truncated, showing last {n} characters ...]\n"

DEFAULT_TIMEOUT_SECONDS = 900

# Env var NAMES whose VALUES get scrubbed out of tail/detail before writing.
SECRETISH_NAME = re.compile(r"(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)", re.IGNORECASE)

# https://user:pass@host -> https://user:***@host
URL_CREDENTIALS = re.compile(r"(?P<scheme>[a-zA-Z][a-zA-Z0-9+.-]*://)(?P<user>[^/\s:@]+):(?P<pw>[^/\s@]+)@")

# Common bearer/authorization shapes that show up in pip / git output.
BEARER = re.compile(r"(?i)\b(bearer|authorization:\s*bearer)\s+([A-Za-z0-9._\-]{12,})")

REDACTED = "[REDACTED]"


# --------------------------------------------------------------------------------------
# redaction
# --------------------------------------------------------------------------------------

def _secret_values() -> list[str]:
    """Values of environment variables that look like credentials, longest first.

    Longest-first matters: if TOKEN is a prefix of TOKEN_FULL, replacing the long one
    first avoids leaving a readable suffix behind.
    """
    out: list[str] = []
    for name, value in os.environ.items():
        if not value or len(value) < 6:
            continue
        if SECRETISH_NAME.search(name):
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
    return text


def make_tail(text: str) -> str | None:
    """Last TAIL_LIMIT characters, with a marker when anything was dropped."""
    if not text:
        return None
    if len(text) <= TAIL_LIMIT:
        return text
    return TRUNCATION_MARKER.format(n=TAIL_LIMIT) + text[-TAIL_LIMIT:]


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

def run(argv: list[str], cwd: str | None = None, timeout: int = 600, env: dict | None = None):
    """Run a command, capture combined output as text. Never raises on non-zero exit."""
    return subprocess.run(
        argv,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        errors="replace",
        timeout=timeout,
        env=env,
    )


# --------------------------------------------------------------------------------------
# steps
# --------------------------------------------------------------------------------------

def clone_commit(repo_url: str, sha: str, workdir: str, timeout: int) -> str:
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
        try:
            proc = run(argv, cwd=cwd, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise ProbeError(
                f"git step timed out after {timeout}s: {' '.join(argv)}",
                "\n".join(log),
            )
        except OSError as exc:
            raise ProbeError(f"could not execute git: {exc}", "\n".join(log))
        log.append(f"$ {' '.join(argv)}\n{proc.stdout}")
        if proc.returncode != 0:
            raise ProbeError(
                f"git step failed (exit {proc.returncode}): {' '.join(argv)}",
                "\n".join(log),
            )
    return "\n".join(log)


def has_uv() -> bool:
    return shutil.which("uv") is not None


def install_dependencies(workdir: str, timeout: int) -> tuple[str, str]:
    """Install THIS COMMIT's declared dependencies. Returns (strategy, log).

    Priority: pyproject.toml > requirements.txt > setup.py > none. `none` is not an
    error: plenty of suites are stdlib-only, and refusing to run them would report
    `error` for commits that are perfectly testable.
    """
    def path(name: str) -> str:
        return os.path.join(workdir, name)

    uv = has_uv()
    if os.path.isfile(path("pyproject.toml")):
        strategy = "pyproject.toml + uv pip install -e ." if uv else "pyproject.toml + pip install -e ."
        argv = (
            ["uv", "pip", "install", "--python", sys.executable, "-e", "."]
            if uv
            else [sys.executable, "-m", "pip", "install", "--no-input", "-e", "."]
        )
    elif os.path.isfile(path("requirements.txt")):
        strategy = "requirements.txt + uv pip install" if uv else "requirements.txt + pip install"
        argv = (
            ["uv", "pip", "install", "--python", sys.executable, "-r", "requirements.txt"]
            if uv
            else [sys.executable, "-m", "pip", "install", "--no-input", "-r", "requirements.txt"]
        )
    elif os.path.isfile(path("setup.py")):
        strategy = "setup.py + uv pip install -e ." if uv else "setup.py + pip install -e ."
        argv = (
            ["uv", "pip", "install", "--python", sys.executable, "-e", "."]
            if uv
            else [sys.executable, "-m", "pip", "install", "--no-input", "-e", "."]
        )
    else:
        return ("none (no pyproject.toml, requirements.txt or setup.py at repo root)", "")

    try:
        proc = run(argv, cwd=workdir, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise ProbeError(f"dependency install timed out after {timeout}s ({strategy})")
    except OSError as exc:
        raise ProbeError(f"could not execute installer: {exc}")

    log = f"$ {' '.join(argv)}\n{proc.stdout}"
    if proc.returncode != 0:
        # Install failure is an ERROR, never a FAIL. The commit's test never ran, so we
        # know nothing about whether the commit is good, and must not narrow the search.
        raise ProbeError(
            f"dependency install failed (exit {proc.returncode}) using {strategy}",
            log,
        )
    return (strategy, log)


def run_test(command: str, workdir: str, timeout: int) -> tuple[int, str]:
    """Run the test command. Returns (exit_code, combined_output).

    Raises ProbeError only when the command could not run at all or timed out. A
    non-zero exit is returned normally: that is a `fail`, which is a real result.
    """
    try:
        argv = shlex.split(command)
    except ValueError as exc:
        raise ProbeError(f"test command is not parseable: {exc}")
    if not argv:
        raise ProbeError("test command is empty")

    env = dict(os.environ)
    # Make the checkout importable for `python -m pytest` style commands without an
    # install step, and keep output unbuffered so a timeout still yields a useful tail.
    env["PYTHONPATH"] = workdir + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    env["PYTHONUNBUFFERED"] = "1"

    try:
        proc = run(argv, cwd=workdir, timeout=timeout, env=env)
    except subprocess.TimeoutExpired as exc:
        partial = exc.output or ""
        if isinstance(partial, bytes):
            partial = partial.decode("utf-8", "replace")
        raise ProbeError(f"test command timed out after {timeout}s", partial)
    except OSError as exc:
        raise ProbeError(f"could not execute test command {argv[0]!r}: {exc}")
    return (proc.returncode, proc.stdout)


# --------------------------------------------------------------------------------------
# output
# --------------------------------------------------------------------------------------

def write_result(output_path: str, hunt_id: str, commit_sha: str, result: dict) -> str:
    """Atomically write the verdict file. Returns the path written.

    Atomic because the application polls this prefix: a reader must never see a
    half-flushed JSON document. Write to a temp file in the SAME directory (so the
    rename cannot cross a filesystem boundary), fsync, then os.replace.
    """
    directory = os.path.join(output_path, hunt_id, "probes")
    os.makedirs(directory, exist_ok=True)
    final = os.path.join(directory, f"{commit_sha}.json")
    payload = json.dumps(result, indent=2, ensure_ascii=False) + "\n"

    fd, tmp = tempfile.mkstemp(dir=directory, prefix=f".{commit_sha}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
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

def main() -> int:
    started = time.monotonic()

    # Read these defensively: they are needed to name the output file, and the file has
    # to be written even when configuration is what is broken.
    hunt_id = os.environ.get("FAULTLINE_HUNT_ID", "").strip() or "unknown-hunt"
    commit_sha = os.environ.get("FAULTLINE_COMMIT_SHA", "").strip() or "unknown-commit"
    output_path = os.environ.get("FAULTLINE_OUTPUT_PATH", "").strip() or "/out"

    secrets = _secret_values()
    verdict = "error"
    exit_code: int | None = None
    detail: str | None = None
    tail_source = ""

    try:
        hunt_id = env_or_fail("FAULTLINE_HUNT_ID")
        repo_url = env_or_fail("FAULTLINE_REPO_URL")
        commit_sha = env_or_fail("FAULTLINE_COMMIT_SHA")
        test_command = env_or_fail("FAULTLINE_TEST_COMMAND")
        output_path = env_or_fail("FAULTLINE_OUTPUT_PATH")

        raw_timeout = os.environ.get("FAULTLINE_TIMEOUT_SECONDS", "").strip()
        try:
            timeout = int(raw_timeout) if raw_timeout else DEFAULT_TIMEOUT_SECONDS
        except ValueError:
            raise ProbeError(f"FAULTLINE_TIMEOUT_SECONDS is not an integer: {raw_timeout!r}")
        if timeout <= 0:
            raise ProbeError(f"FAULTLINE_TIMEOUT_SECONDS must be positive, got {timeout}")

        workdir = tempfile.mkdtemp(prefix="faultline-repo-")

        # Give clone and install a slice of the budget each so a slow install cannot
        # eat the entire window and leave nothing for the test.
        clone_timeout = max(60, timeout // 3)
        install_timeout = max(120, timeout // 2)

        clone_log = clone_commit(repo_url, commit_sha, workdir, clone_timeout)
        strategy, install_log = install_dependencies(workdir, install_timeout)

        elapsed = time.monotonic() - started
        test_timeout = max(30, int(timeout - elapsed))
        exit_code, test_output = run_test(test_command, workdir, test_timeout)

        verdict = "pass" if exit_code == 0 else "fail"
        detail = f"deps: {strategy}; test exited {exit_code}"
        tail_source = test_output
        del clone_log, install_log

    except ProbeError as exc:
        verdict = "error"
        exit_code = None
        detail = exc.detail
        tail_source = exc.output or ""
    except BaseException:
        # Last line of defence. Anything at all — including KeyboardInterrupt and
        # SystemExit — still produces a verdict file rather than a silent absence.
        verdict = "error"
        exit_code = None
        detail = "unhandled exception in probe:\n" + traceback.format_exc()
        tail_source = ""

    duration_ms = int((time.monotonic() - started) * 1000)

    result = {
        "schema": SCHEMA,
        "huntId": hunt_id,
        "commitSha": commit_sha,
        "verdict": verdict,
        "exitCode": exit_code,
        "durationMs": duration_ms,
        "detail": redact(detail, secrets),
        "tail": redact(make_tail(redact(tail_source, secrets) or ""), secrets),
    }

    # stdout mirror: `nebius ai job logs` is console/CLI-only, but when a human does look
    # there they should see the exact verdict the app acted on, on one greppable line.
    print(json.dumps(result, ensure_ascii=False), flush=True)

    try:
        written = write_result(output_path, hunt_id, commit_sha, result)
        print(f"faultline: verdict written to {written}", flush=True)
    except Exception as exc:  # noqa: BLE001 - nothing above this to catch it
        print(f"faultline: FAILED to write verdict file: {exc}", file=sys.stderr, flush=True)
        return 2

    # Exit 0 whenever a verdict was produced, including `fail`. A `fail` verdict is a
    # successful probe: the job succeeded at learning that the commit is bad.
    return 0 if verdict != "error" else 1


if __name__ == "__main__":
    sys.exit(main())
