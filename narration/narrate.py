#!/usr/bin/env python3
"""
Faultline narration job.

Runs ONE completion against an NVIDIA open model on a GPU container VM, then exits. This is
a terminating Serverless AI Job rather than a Serverless Endpoint on purpose: an endpoint in
RUNNING bills continuously and needs a human to stop and start it across the judging window,
whereas narration is a single latency-insensitive call per hunt.

Contract
--------
Reads:
    FAULTLINE_HUNT_ID       hunt this narration belongs to
    FAULTLINE_COMMIT_SHA    the guilty commit
    FAULTLINE_MODEL_ID      HuggingFace model id (default: OpenCodeReasoning-Nemotron-14B)
    FAULTLINE_PROMPT        the fully-built prompt
    FAULTLINE_OUTPUT_PATH   mounted bucket path (e.g. /out)
    FAULTLINE_MAX_TOKENS    optional, default 400

Guarantees:
    Writes <FAULTLINE_OUTPUT_PATH>/<huntId>/narration.json, atomically, in every exit path.
    A missing file is indistinguishable from a still-running job, so the app would poll
    forever; writing an error object instead is what lets the hunt finish.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import traceback

SCHEMA = "faultline.narration.v1"
DEFAULT_MODEL = "nvidia/OpenCodeReasoning-Nemotron-14B"


def write_result(output_path: str, hunt_id: str, payload: dict) -> None:
    """Write the result atomically so a partially-flushed file is never read."""
    directory = os.path.join(output_path, hunt_id)
    os.makedirs(directory, exist_ok=True)
    target = os.path.join(directory, "narration.json")

    fd, temp_path = tempfile.mkstemp(dir=directory, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, target)
    except BaseException:
        if os.path.exists(temp_path):
            os.unlink(temp_path)
        raise


def generate(model_id: str, prompt: str, max_tokens: int) -> tuple[str, int | None, int | None]:
    """
    Generate with vLLM, which is the engine the model card names.

    Imported lazily so that a configuration error is reported through the normal result file
    rather than as an import crash before any handler is installed.
    """
    from vllm import LLM, SamplingParams  # type: ignore[import-not-found]

    llm = LLM(model=model_id, dtype="bfloat16", max_model_len=32768, gpu_memory_utilization=0.90)
    # Low temperature: this is an explanation of an established fact, not a creative task.
    params = SamplingParams(temperature=0.2, top_p=0.95, max_tokens=max_tokens)

    outputs = llm.generate([prompt], params)
    if not outputs or not outputs[0].outputs:
        raise RuntimeError("the model returned no completion")

    completion = outputs[0].outputs[0]
    prompt_tokens = len(outputs[0].prompt_token_ids) if outputs[0].prompt_token_ids else None
    completion_tokens = len(completion.token_ids) if completion.token_ids else None
    return completion.text.strip(), prompt_tokens, completion_tokens


def main() -> int:
    started = time.monotonic()
    output_path = os.environ.get("FAULTLINE_OUTPUT_PATH", "/out")
    hunt_id = os.environ.get("FAULTLINE_HUNT_ID", "unknown")
    commit_sha = os.environ.get("FAULTLINE_COMMIT_SHA", "")
    model_id = os.environ.get("FAULTLINE_MODEL_ID", DEFAULT_MODEL)
    prompt = os.environ.get("FAULTLINE_PROMPT", "")
    max_tokens = int(os.environ.get("FAULTLINE_MAX_TOKENS", "400"))

    base = {
        "schema": SCHEMA,
        "huntId": hunt_id,
        "commitSha": commit_sha,
        "modelId": model_id,
    }

    try:
        if not prompt.strip():
            raise ValueError("FAULTLINE_PROMPT is empty; nothing to narrate")

        text, prompt_tokens, completion_tokens = generate(model_id, prompt, max_tokens)
        payload = {
            **base,
            "rootCauseMd": text,
            "promptTokens": prompt_tokens,
            "completionTokens": completion_tokens,
            "durationMs": int((time.monotonic() - started) * 1000),
        }
        write_result(output_path, hunt_id, payload)
        print(json.dumps({"ok": True, "huntId": hunt_id, "chars": len(text)}))
        return 0

    except BaseException as exc:  # noqa: BLE001 - every path must still produce a file
        payload = {
            **base,
            "rootCauseMd": "",
            "error": f"{type(exc).__name__}: {exc}",
            "traceback": traceback.format_exc()[-4000:],
            "promptTokens": None,
            "completionTokens": None,
            "durationMs": int((time.monotonic() - started) * 1000),
        }
        try:
            write_result(output_path, hunt_id, payload)
        except BaseException:
            print(json.dumps({"ok": False, "fatal": "could not write result file"}), file=sys.stderr)
        print(json.dumps({"ok": False, "error": payload["error"]}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
