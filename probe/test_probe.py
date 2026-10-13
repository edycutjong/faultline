"""The probe contract, exercised end to end on this machine.

A throwaway git repository stands in for GitHub and a local HTTP server stands in for the
presigned verdict URL and the tick endpoint, so every assertion runs the real probe.py as a
subprocess — the same file the application injects into each Nebius job.

    python3 -m unittest probe/test_probe.py
"""

from __future__ import annotations

import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest

PROBE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "probe.py")


class Recorder(http.server.BaseHTTPRequestHandler):
    """Accepts one PUT (the verdict) and any POST (ticks); remembers both."""

    received: list[tuple[str, str, bytes]] = []

    def _record(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        Recorder.received.append((self.command, self.path, body))
        self.send_response(200)
        self.end_headers()

    do_PUT = _record
    do_POST = _record

    def log_message(self, *args) -> None:  # silence the test output
        pass


def git(*args: str, cwd: str) -> str:
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.invalid",
               GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.invalid",
               GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull)
    return subprocess.run(["git", *args], cwd=cwd, env=env, check=True,
                          stdout=subprocess.PIPE, text=True).stdout.strip()


class ProbeContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Recorder)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

        cls.repo = tempfile.mkdtemp(prefix="probe-test-repo-")
        git("init", "--quiet", "-b", "main", cwd=cls.repo)
        # Allow `git fetch <sha>` from this local "remote", as GitHub does.
        git("config", "uploadpack.allowReachableSHA1InWant", "true", cwd=cls.repo)
        with open(os.path.join(cls.repo, "check.py"), "w") as fh:
            fh.write("import sys\nsys.exit(0)\n")
        git("add", ".", cwd=cls.repo)
        git("commit", "--quiet", "-m", "good", cwd=cls.repo)
        cls.good = git("rev-parse", "HEAD", cwd=cls.repo)
        with open(os.path.join(cls.repo, "check.py"), "w") as fh:
            fh.write("import os, sys\nprint('PROBE_ENV', sorted(k for k in os.environ if k.startswith('FAULTLINE_')))\nsys.exit(3)\n")
        git("commit", "--quiet", "-am", "bad", cwd=cls.repo)
        cls.bad = git("rev-parse", "HEAD", cwd=cls.repo)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()

    def setUp(self) -> None:
        Recorder.received = []

    def run_probe(self, sha: str, **overrides: str) -> subprocess.CompletedProcess:
        env = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": tempfile.mkdtemp(),
            "FAULTLINE_HUNT_ID": "hunt-test",
            "FAULTLINE_PROBE_KEY": f"r1-{sha[:12]}-a1",
            "FAULTLINE_REPO_URL": f"file://{self.repo}",
            "FAULTLINE_COMMIT_SHA": sha,
            "FAULTLINE_TEST_COMMAND": "python check.py",
            "FAULTLINE_INSTALL_COMMAND": "python -c pass",
            "FAULTLINE_VERDICT_URL": f"{self.base}/bucket/verdict.json?X-Amz-Signature=deadbeefcafe",
            "FAULTLINE_TICK_URL": f"{self.base}/api/hunts/hunt-test/tick",
            "FAULTLINE_TIMEOUT_SECONDS": "120",
        }
        env.update(overrides)
        return subprocess.run([sys.executable, PROBE], env=env, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True, timeout=180)

    def verdict(self) -> dict:
        puts = [body for method, _, body in Recorder.received if method == "PUT"]
        self.assertEqual(len(puts), 1, "exactly one verdict PUT")
        return json.loads(puts[0])

    def test_pass_is_put_then_ticked_and_mirrored_on_stdout(self) -> None:
        proc = self.run_probe(self.good)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        doc = self.verdict()
        self.assertEqual(doc["schema"], "faultline.probe.v2")
        self.assertEqual(doc["verdict"], "pass")
        self.assertEqual(doc["exitCode"], 0)
        self.assertEqual(doc["probeKey"], f"r1-{self.good[:12]}-a1")
        # The JSON line comes first on stdout and is the same document that was PUT.
        self.assertEqual(json.loads(proc.stdout.splitlines()[0]), doc)
        # The tick is empty, and it comes after the verdict.
        methods = [method for method, _, _ in Recorder.received]
        self.assertEqual(methods, ["PUT", "POST"])
        self.assertEqual(Recorder.received[1][2], b"")

    def test_fail_is_a_verdict_not_an_error(self) -> None:
        proc = self.run_probe(self.bad)
        self.assertEqual(proc.returncode, 0, "a delivered fail is a successful probe")
        doc = self.verdict()
        self.assertEqual(doc["verdict"], "fail")
        self.assertEqual(doc["exitCode"], 3)

    def test_visitor_code_never_sees_the_capability_urls(self) -> None:
        self.run_probe(self.bad)
        tail = self.verdict()["tail"]
        self.assertIn("PROBE_ENV", tail)
        self.assertNotIn("FAULTLINE_VERDICT_URL", tail)
        self.assertNotIn("FAULTLINE_TICK_URL", tail)
        self.assertNotIn("deadbeefcafe", json.dumps(self.verdict()))

    def test_unbuildable_commit_is_error_with_the_reason(self) -> None:
        self.run_probe(self.good, FAULTLINE_INSTALL_COMMAND="python -c \"import sys; sys.exit(7)\"")
        doc = self.verdict()
        self.assertEqual(doc["verdict"], "error")
        self.assertIsNone(doc["exitCode"])
        self.assertIn("dependency install failed (exit 7)", doc["detail"])

    def test_missing_commit_is_error_never_fail(self) -> None:
        self.run_probe("0" * 40)
        doc = self.verdict()
        self.assertEqual(doc["verdict"], "error")
        self.assertIn("git step failed", doc["detail"])

    def test_own_deadline_reports_instead_of_dying(self) -> None:
        proc = self.run_probe(
            self.good,
            FAULTLINE_TEST_COMMAND="python -c \"import time; time.sleep(60)\"",
            FAULTLINE_TIMEOUT_SECONDS="12",
        )
        self.assertEqual(proc.returncode, 0)
        doc = self.verdict()
        self.assertEqual(doc["verdict"], "error")
        self.assertIn("timed out", doc["detail"])

    def test_undeliverable_verdict_exits_nonzero(self) -> None:
        proc = self.run_probe(self.good, FAULTLINE_VERDICT_URL="http://127.0.0.1:9/verdict.json")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("FAILED to deliver verdict", proc.stderr)
        # The JSON line was still flushed before delivery was attempted.
        self.assertEqual(json.loads(proc.stdout.splitlines()[0])["verdict"], "pass")


if __name__ == "__main__":
    unittest.main()
