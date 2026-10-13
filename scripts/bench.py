#!/usr/bin/env python3
"""FAULTBENCH — Faultline against `git bisect run`, on two axes: is the answer right, and how
long does it take.

Three baselines, on the same history, the same test command and the same install command:

    naive       `git bisect run` in ONE environment, built once and reused for every step —
                what a maintainer gets by running bisect in the virtualenv they already have.
                Run twice: with the environment built at the known-good ref, and at the
                failing ref.
    fresh-venv  `git bisect run` with a step script that builds a FRESH virtualenv at every
                step and installs that commit's own declared dependencies. Correct by
                construction, and the honest local competitor.
    faultline   one hunt through a deployed Faultline: every probe a fresh Nebius container
                with that commit's own dependencies, both ends tested, rounds in parallel.

HONESTY RULES, enforced in code:

  * Nothing is estimated. Every figure in a results file came from a run recorded in the same
    file. A run that fails is recorded as a failure; it is never replaced by a model of what
    it would have done.
  * Correctness is judged against the answer key passed with --truth, never inferred.
  * Distributions always carry their sample size, and a p95 over fewer than 20 samples is
    flagged as not meaningful rather than silently printed.
  * Local baselines run with a WARM pip cache — the favourable case for the baseline, and the
    report says so.

Stdlib only; shells out to git, python3 -m venv and pip.

Usage:
    python3 scripts/bench.py local --repo /tmp/faultbench/tzdata-pipeline --good <sha> --bad <sha> \\
        --test "python -m pytest -q tests/test_normalize.py::test_naive_local_midnight_is_interpreted_in_zone" \\
        --install "pip install -e .[test]" --truth <sha> --trials 5 --out evidence/bench/hero-local.json
    python3 scripts/bench.py faultline --api https://faultline-edy-cus-projects.vercel.app \\
        --repo-url https://github.com/edycutjong/faultbench-tzdata-pipeline --good v0.1.0 --bad main \\
        --test "..." --install "pip install -e .[test]" --truth <sha> --out evidence/bench/hero-faultline-1.json
    python3 scripts/bench.py report evidence/bench/*.json
    python3 scripts/bench.py step --install "..." --test "..."     # the fresh-venv bisect step
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shlex
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

SCHEMA = "faultbench.results.v2"
# Nebius list price for cpu-d3 (Non-GPU AMD Epyc Genoa) from 2026-10-01; a probe is 2 vCPU + 8 GiB.
CPU_HOUR_USD = 0.015
GIB_HOUR_USD = 0.0045
PRICE_BASIS = "cpu-d3 list price from 2026-10-01: $0.015/vCPU-h, $0.0045/GiB-h (docs.nebius.com/compute/resources/pricing)"
TERMINAL = {"done", "inconclusive", "error", "paused"}


# ----------------------------------------------------------------------------------------
# statistics — percentiles the way a reader expects, with the sample size always attached
# ----------------------------------------------------------------------------------------

def pct(values, q):
    """Nearest-rank percentile. Explicit, so nobody has to ask which interpolation this is."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, math.ceil(q / 100.0 * len(ordered)))
    return ordered[min(rank, len(ordered)) - 1]


def summarise(values, unit):
    clean = [v for v in values if v is not None]
    if not clean:
        return {"n": 0, "unit": unit, "note": "no samples"}
    return {
        "n": len(clean),
        "unit": unit,
        "min": round(min(clean), 2),
        "p50": round(pct(clean, 50), 2),
        "p95": round(pct(clean, 95), 2),
        "max": round(max(clean), 2),
        "mean": round(statistics.fmean(clean), 2),
        "p95_meaningful": len(clean) >= 20,
    }


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def iso_ms(text):
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000.0
    except (ValueError, AttributeError):
        return None


# ----------------------------------------------------------------------------------------
# commands
# ----------------------------------------------------------------------------------------

def run(argv, cwd=None, env=None, timeout=3600):
    return subprocess.run(argv, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, errors="replace", timeout=timeout)


def in_env(command, python):
    """Point a `python ...` / `pytest ...` / `pip ...` command at a specific interpreter."""
    argv = shlex.split(command)
    head = os.path.basename(argv[0]) if argv else ""
    if head in ("python", "python3"):
        return [python] + argv[1:]
    if head in ("pytest", "py.test"):
        return [python, "-m", "pytest"] + argv[1:]
    if head in ("pip", "pip3"):
        return [python, "-m", "pip"] + argv[1:]
    return argv


def make_venv(path, python=None):
    proc = run([python or sys.executable, "-m", "venv", path])
    if proc.returncode != 0:
        raise RuntimeError("venv creation failed: %s" % proc.stdout[-400:])
    return os.path.join(path, "bin", "python")


# ----------------------------------------------------------------------------------------
# the fresh-venv bisect step (invoked by `git bisect run`)
# ----------------------------------------------------------------------------------------

def cmd_step(args):
    """One `git bisect run` step: fresh venv, this commit's install, the test.

    Exit 125 when the commit cannot be installed — `git bisect skip` — so an unbuildable
    commit is never blamed or cleared.
    """
    scratch = tempfile.mkdtemp(prefix="fl-bisect-step-")
    try:
        python = make_venv(os.path.join(scratch, "venv"), args.python)
        install = run(in_env(args.install, python), cwd=os.getcwd()) if args.install else None
        if install is not None and install.returncode != 0:
            return 125
        test = run(in_env(args.test, python), cwd=os.getcwd())
        return 0 if test.returncode == 0 else 1
    except RuntimeError:
        return 125
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


# ----------------------------------------------------------------------------------------
# local baselines
# ----------------------------------------------------------------------------------------

def bisect(repo, good, bad, run_argv):
    """`git bisect run` from scratch. Returns (named sha or None, steps, seconds, log tail)."""
    run(["git", "bisect", "reset"], cwd=repo)
    run(["git", "checkout", "-q", bad], cwd=repo)
    started = time.monotonic()
    start = run(["git", "bisect", "start", bad, good], cwd=repo)
    if start.returncode != 0:
        raise RuntimeError("git bisect start failed: %s" % start.stdout[-400:])
    proc = run(["git", "bisect", "run"] + run_argv, cwd=repo, timeout=7200)
    seconds = time.monotonic() - started
    named = None
    for line in proc.stdout.splitlines():
        if line.endswith("is the first bad commit"):
            named = line.split()[0]
            break
    log = run(["git", "bisect", "log"], cwd=repo).stdout
    steps = sum(1 for line in log.splitlines() if line.startswith("git bisect good") or line.startswith("git bisect bad") or line.startswith("git bisect skip"))
    run(["git", "bisect", "reset"], cwd=repo)
    return named, steps, seconds, proc.stdout[-600:]


def subject(repo, sha):
    if not sha:
        return None
    return run(["git", "log", "-1", "--format=%s", sha], cwd=repo).stdout.strip()


def cmd_local(args):
    repo = os.path.abspath(args.repo)
    good = run(["git", "rev-parse", args.good], cwd=repo).stdout.strip()
    bad = run(["git", "rev-parse", args.bad], cwd=repo).stdout.strip()
    truth = run(["git", "rev-parse", args.truth], cwd=repo).stdout.strip()
    trials = []
    scratch = tempfile.mkdtemp(prefix="fl-bench-")
    try:
        for flavour, ref in (("naive (env built at known-good ref)", good), ("naive (env built at failing ref)", bad)):
            run(["git", "bisect", "reset"], cwd=repo)
            run(["git", "checkout", "-q", ref], cwd=repo)
            t0 = time.monotonic()
            python = make_venv(os.path.join(scratch, "env-%s" % ref[:8]), args.python)
            install = run(in_env(args.install, python), cwd=repo)
            setup_s = time.monotonic() - t0
            if install.returncode != 0:
                trials.append({"baseline": flavour, "error": "environment install failed", "tail": install.stdout[-400:]})
                continue
            for _ in range(args.trials):
                named, steps, seconds, tail = bisect(repo, good, bad, in_env(args.test, python))
                trials.append({
                    "baseline": flavour, "named": named, "namedSubject": subject(repo, named),
                    "correct": named == truth, "steps": steps, "seconds": round(seconds, 2),
                    "envSetupSeconds": round(setup_s, 2), "tail": None if named == truth else tail,
                })
                sys.stderr.write("%s: %s in %.1fs\n" % (flavour, (named or "none")[:12], seconds))

        step = [sys.executable, os.path.abspath(__file__), "step", "--install", args.install, "--test", args.test]
        if args.python:
            step += ["--python", args.python]
        for _ in range(args.trials):
            named, steps, seconds, tail = bisect(repo, good, bad, step)
            trials.append({
                "baseline": "fresh-venv", "named": named, "namedSubject": subject(repo, named),
                "correct": named == truth, "steps": steps, "seconds": round(seconds, 2),
                "tail": None if named == truth else tail,
            })
            sys.stderr.write("fresh-venv: %s in %.1fs\n" % ((named or "none")[:12], seconds))
    finally:
        run(["git", "bisect", "reset"], cwd=repo)
        shutil.rmtree(scratch, ignore_errors=True)

    result = {
        "schema": SCHEMA, "kind": "local", "label": args.label, "ranAt": now_iso(),
        "machine": {"platform": sys.platform, "python": run([args.python or sys.executable, "--version"]).stdout.strip(),
                    "git": run(["git", "--version"]).stdout.strip(), "pipCache": "warm"},
        "repo": args.repo_url or repo, "good": good, "bad": bad, "truth": truth, "truthSubject": subject(repo, truth),
        "commits": int(run(["git", "rev-list", "--count", "%s..%s" % (good, bad)], cwd=repo).stdout.strip() or 0),
        "testCommand": args.test, "installCommand": args.install, "trials": trials,
    }
    write(args.out, result)
    return 0


# ----------------------------------------------------------------------------------------
# faultline
# ----------------------------------------------------------------------------------------

def request(method, url, payload=None, timeout=120):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/json")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode()
        try:
            return exc.code, json.loads(body or "{}")
        except ValueError:
            return exc.code, {"error": body[:400]}
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return 0, {"error": "%s: %s" % (type(exc).__name__, exc)}


def cmd_faultline(args):
    api = args.api.rstrip("/")
    payload = {"repoUrl": args.repo_url, "testCommand": args.test, "installCommand": args.install,
               "goodRef": args.good, "badRef": args.bad}
    code_file = os.path.expanduser(args.access_code_file) if args.access_code_file else None
    if code_file and os.path.isfile(code_file):
        payload["accessCode"] = open(code_file).read().strip()

    if args.hunt_id:
        hunt_id = args.hunt_id
    else:
        status, body = request("POST", api + "/api/hunts", payload)
        if status != 201:
            sys.stderr.write("could not start the hunt: %s %s\n" % (status, body))
            return 1
        hunt_id = body["hunt"]["id"]
    sys.stderr.write("hunt %s\n" % hunt_id)

    deadline = time.monotonic() + args.timeout_minutes * 60
    hunt = None
    while time.monotonic() < deadline:
        status, body = request("GET", "%s/api/hunts/%s" % (api, hunt_id))
        if status == 200 and body.get("hunt"):
            hunt = body["hunt"]
            if hunt["status"] in TERMINAL:
                break
        time.sleep(args.poll_seconds)

    if not hunt or hunt["status"] not in TERMINAL:
        sys.stderr.write("hunt did not finish within %d minutes\n" % args.timeout_minutes)
        write(args.out, {"schema": SCHEMA, "kind": "faultline", "label": args.label, "huntId": hunt_id,
                         "error": "timeout", "hunt": hunt})
        return 1

    named = (hunt.get("report") or {}).get("culpritSha")
    probes = hunt.get("probes", [])
    vm = [p.get("vmMs") for p in probes if p.get("vmMs") is not None]
    vm_ms = sum(vm) if vm else None
    cold = [iso_ms(p.get("startedAt")) - iso_ms(p.get("dispatchedAt")) for p in probes
            if iso_ms(p.get("startedAt")) is not None and iso_ms(p.get("dispatchedAt")) is not None]
    rounds = []
    for r in range(1, hunt.get("round", 0) + 1):
        rp = [p for p in probes if p.get("round") == r]
        starts = [iso_ms(p.get("dispatchedAt")) for p in rp if p.get("dispatchedAt")]
        ends = [iso_ms(p.get("finishedAt")) for p in rp if p.get("finishedAt")]
        rounds.append({"round": r, "probes": len(rp),
                       "seconds": round((max(ends) - min(starts)) / 1000, 1) if starts and ends else None})
    result = {
        "schema": SCHEMA, "kind": "faultline", "label": args.label, "ranAt": now_iso(), "api": api,
        "huntId": hunt_id, "repo": args.repo_url, "truth": args.truth,
        "named": named, "correct": bool(named and args.truth and named.startswith(args.truth[:12])),
        "status": hunt["status"], "inconclusive": hunt.get("inconclusive"),
        "seconds": round((hunt.get("wallClockMs") or 0) / 1000, 1) if hunt.get("wallClockMs") else None,
        "rounds": hunt.get("round"), "probes": len(probes), "slots": hunt.get("slots"),
        "regions": hunt.get("regions"),
        # Cost is derived here from the VM time Nebius reported for each job, at the list price
        # stated below — never read from a figure stored when the hunt ran.
        "vmSeconds": round(vm_ms / 1000, 1) if vm_ms is not None else None,
        "costUsd": round(vm_ms / 3_600_000 * (2 * CPU_HOUR_USD + 8 * GIB_HOUR_USD), 4) if vm_ms is not None else None,
        "priceBasis": PRICE_BASIS,
        "jobIds": [p.get("jobId") for p in probes],
        "infraRetries": sum(len(p.get("infraFailures") or []) for p in probes),
        "perRound": rounds,
        "coldStartSeconds": summarise([c / 1000 for c in cold], "s"),
        "inContainerSeconds": summarise([(p.get("durationMs") or 0) / 1000 for p in probes if p.get("durationMs")], "s"),
        "narration": {"model": (hunt.get("report") or {}).get("modelId"),
                      "requestId": (hunt.get("report") or {}).get("narrationRequestId"),
                      "error": (hunt.get("report") or {}).get("narrationError")},
        "hunt": hunt,
    }
    write(args.out, result)
    sys.stderr.write("faultline: %s (%s) in %ss, %s rounds, %s probes\n" % (
        (named or "none")[:12], "correct" if result["correct"] else "WRONG/none", result["seconds"], result["rounds"], result["probes"]))
    return 0


# ----------------------------------------------------------------------------------------
# report
# ----------------------------------------------------------------------------------------

def cmd_report(args):
    rows = {}
    faultline = []
    for path in args.files:
        with open(path) as fh:
            data = json.load(fh)
        if data.get("kind") == "local":
            for t in data["trials"]:
                if "error" in t:
                    continue
                key = (data["label"], t["baseline"])
                rows.setdefault(key, []).append(t)
        elif data.get("kind") == "faultline" and not data.get("error"):
            faultline.append(data)

    out = {"schema": SCHEMA, "kind": "report", "ranAt": now_iso(), "baselines": [], "faultline": []}
    lines = ["| Repo | Baseline | Named the culprit | Wall-clock p50 (s) | p95 (s) | N |", "|---|---|---|---|---|---|"]
    for (label, baseline), trials in sorted(rows.items()):
        secs = summarise([t["seconds"] for t in trials], "s")
        right = sum(1 for t in trials if t["correct"])
        named = sorted({(t["named"] or "none")[:7] + " " + (t.get("namedSubject") or "") for t in trials})
        out["baselines"].append({"label": label, "baseline": baseline, "correct": right, "n": len(trials), "seconds": secs, "named": named})
        verdict = "%d/%d" % (right, len(trials)) + ("" if right == len(trials) else " — named " + "; ".join(named))
        lines.append("| %s | %s | %s | %s | %s | %d |" % (label, baseline, verdict, secs["p50"], secs["p95"] if secs["p95_meaningful"] else "%s (n<20)" % secs["p95"], len(trials)))
    by_label = {}
    for f in faultline:
        by_label.setdefault(f["label"], []).append(f)
    for label, runs in sorted(by_label.items()):
        secs = summarise([r["seconds"] for r in runs], "s")
        right = sum(1 for r in runs if r["correct"])
        out["faultline"].append({"label": label, "correct": right, "n": len(runs), "seconds": secs,
                                 "rounds": [r["rounds"] for r in runs], "probes": [r["probes"] for r in runs],
                                 "costUsd": [r["costUsd"] for r in runs], "huntIds": [r["huntId"] for r in runs]})
        lines.append("| %s | Faultline (%s slots) | %d/%d | %s | %s | %d |" % (
            label, runs[0].get("slots"), right, len(runs), secs["p50"],
            secs["p95"] if secs["p95_meaningful"] else "%s (n<20)" % secs["p95"], len(runs)))
    out["markdown"] = "\n".join(lines)
    print(out["markdown"])
    if args.out:
        write(args.out, out)
    return 0


def write(path, data):
    if not path:
        print(json.dumps(data, indent=2))
        return
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")
    sys.stderr.write("wrote %s\n" % path)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)

    step = sub.add_parser("step", help="one fresh-venv `git bisect run` step (internal)")
    step.add_argument("--install", default="")
    step.add_argument("--test", required=True)
    step.add_argument("--python")

    local = sub.add_parser("local", help="naive and fresh-venv git bisect run, N trials")
    for name in ("--repo", "--good", "--bad", "--test", "--truth", "--out", "--label"):
        local.add_argument(name, required=True)
    local.add_argument("--install", default="")
    local.add_argument("--repo-url")
    local.add_argument("--trials", type=int, default=3)
    local.add_argument("--python", help="interpreter for the venvs (default: this one)")

    fl = sub.add_parser("faultline", help="one hunt through a deployed Faultline")
    for name in ("--api", "--repo-url", "--good", "--bad", "--test", "--out", "--label"):
        fl.add_argument(name, required=True)
    fl.add_argument("--install", default="")
    fl.add_argument("--truth")
    fl.add_argument("--hunt-id", help="measure an already-started hunt instead of starting one")
    fl.add_argument("--access-code-file", help="file holding the judge access code (never pass it inline)")
    fl.add_argument("--poll-seconds", type=float, default=5.0)
    fl.add_argument("--timeout-minutes", type=int, default=75)

    report = sub.add_parser("report", help="merge result files into a summary")
    report.add_argument("files", nargs="+")
    report.add_argument("--out")

    args = parser.parse_args(argv)
    return {"step": cmd_step, "local": cmd_local, "faultline": cmd_faultline, "report": cmd_report}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
