#!/usr/bin/env python3
"""Stub Faultline API — the offline test harness for scripts/bench.py.

WHAT THIS IS FOR. bench.py is the instrument that produces the only performance numbers this
project will ever publish. An instrument that has never been run is not trustworthy, and the
Nebius tenant has been suspended since 21 seconds after it was created, so bench.py cannot be
exercised against the real thing yet. This serves enough of the API contract - POST /api/hunts,
GET /api/hunts/{id}, bandSize validation, the probe timing fields - to drive bench.py end to
end with no Nebius, no network and no app.

WHAT IT IS EMPHATICALLY NOT. The timings below are FIXED CONSTANTS chosen to be plausible.
They are not measurements of anything. Every hunt it returns carries `"simulated": true`, and
bench.py propagates that to a `SIMULATED: true` stamp at the top of the results file plus a
loud warning on stderr, precisely so a file produced this way can never be mistaken for real
data. Do not remove that marker.

The band arithmetic here is implemented INDEPENDENTLY of src/lib/planner.ts, which makes it a
cross-check rather than a mirror: if the stub and the product disagree about how many rounds a
256-commit range needs, one of them is wrong and that is worth knowing.

Usage:
    python3 scripts/bench_stub.py &
    python3 scripts/bench.py --manifest <manifest> --api http://127.0.0.1:8731 \
        --repo-base https://github.com/faultline-bench --trials 1
"""
import json, time, uuid, threading
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer

HUNTS = {}
COLD_MS, EXEC_MS = 9000, 41000   # plausible fixed timings; the stub is a harness, not a claim

def iso(dt): return dt.astimezone(timezone.utc).isoformat().replace("+00:00","Z")

def build(repo_url, band, n_commits, planted_idx):
    hid = str(uuid.uuid4()); t0 = datetime.now(timezone.utc)
    low, high, rnd, probes = 0, n_commits, 0, []
    while high - low > 1:
        rnd += 1
        seg = (high - low) / (band + 1)
        idxs = sorted({min(high-1, max(low+1, low + round((i+1)*seg))) for i in range(band)})
        for i in idxs:
            d = t0 + timedelta(milliseconds=(rnd-1)*(COLD_MS+EXEC_MS))
            s = d + timedelta(milliseconds=COLD_MS); f = s + timedelta(milliseconds=EXEC_MS)
            probes.append({"commitSha": "c%039d" % i, "commitIndex": i, "round": rnd,
                "jobId": "computejob-e00%s" % uuid.uuid4().hex[:14],
                "jobState": "COMPLETED", "verdict": "fail" if i >= planted_idx else "pass",
                "detail": None, "dispatchedAt": iso(d), "startedAt": iso(s), "finishedAt": iso(f),
                "durationMs": EXEC_MS, "verdictKey": "%s/probes/%d.json" % (hid, i)})
        passes = [i for i in idxs if i < planted_idx]; fails = [i for i in idxs if i >= planted_idx]
        low = max([low] + passes); high = min([high] + fails)
        if rnd > 40: break
    wall = rnd * (COLD_MS + EXEC_MS)
    return {"id": hid, "repoUrl": repo_url, "testCommand": "python -m pytest -q",
            "goodRef": "g", "badRef": "HEAD", "status": "done",
            "commits": [], "probes": probes, "round": rnd, "lowIndex": low, "highIndex": high,
            "bandSize": band,
            "report": {"culpritSha": "c%039d" % planted_idx, "culpritSubject": "refactor",
                       "culpritAuthor": "Bot", "culpritDate": iso(t0), "diffText": "",
                       "rootCauseMd": "stub", "modelId": "nvidia/OpenCodeReasoning-Nemotron-14B",
                       "narrationJobId": "computejob-e00narr", "narrationError": None},
            "inconclusive": None, "createdAt": iso(t0),
            "finishedAt": iso(t0 + timedelta(milliseconds=wall)),
            "wallClockMs": wall, "costUsd": round(len(probes) * EXEC_MS/1000 * 0.000_09, 6),
            "recorded": False, "recordedAt": None,
            "simulated": True}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code)
        self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path == "/api/hunts": return self._send(200, {"count":0,"limit":10})
        hid = self.path.rsplit("/",1)[-1]
        h = HUNTS.get(hid)
        return self._send(200, {"hunt": h}) if h else self._send(404, {"error":"No such hunt."})
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or "{}")
        band = body.get("bandSize", 8)
        if not isinstance(band, int) or band < 1 or band > 12:
            return self._send(400, {"error":"bandSize must be an integer between 1 and 12."})
        name = body["repoUrl"].rsplit("/",1)[-1]
        n, planted = {"tzdata-pipeline":(256,181),"retry-lib":(128,77),"id-mint":(64,29)}.get(name,(64,29))
        h = build(body["repoUrl"], band, n, planted); HUNTS[h["id"]] = h
        return self._send(201, {"hunt": h})

srv = HTTPServer(("127.0.0.1", 8731), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
print("stub on 8731", flush=True)
try:
    while True:
        time.sleep(3600)
except KeyboardInterrupt:
    pass
