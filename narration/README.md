# Narration job

One completion from an NVIDIA open model per hunt, run as a **terminating** Nebius Serverless
AI Job on `gpu-l40s-a` / `1gpu-8vcpu-32gb`.

**Model:** `nvidia/OpenCodeReasoning-Nemotron-14B` (Apache-2.0, 32K context). Chosen because
the task is reading a diff plus a traceback and explaining causation — code reasoning, not
code generation. Fallback: `nvidia/OpenCodeReasoning-Nemotron-7B`, same licence, same family.

**Why a job and not an endpoint.** A Serverless Endpoint bills continuously while `RUNNING`
and needs a human to stop and start it. Narration is one latency-insensitive call per hunt,
so a container that exits is both cheaper and the only shape that survives an unattended
judging window.

## Contract

| Env var | Meaning |
|---|---|
| `FAULTLINE_HUNT_ID` | hunt this narration belongs to |
| `FAULTLINE_COMMIT_SHA` | the guilty commit |
| `FAULTLINE_MODEL_ID` | HuggingFace model id (default: the 14B above) |
| `FAULTLINE_PROMPT` | the fully-built prompt, constructed in `src/lib/narrate.ts` |
| `FAULTLINE_OUTPUT_PATH` | mounted bucket path, `/out` |
| `FAULTLINE_MAX_TOKENS` | optional, default 400 |

Writes `<FAULTLINE_OUTPUT_PATH>/<huntId>/narration.json` **atomically, in every exit path**,
including failures. A missing file is indistinguishable from a still-running job, so an error
object is what lets the hunt finish rather than poll forever.

## What the model does and does not decide

It explains; it never decides. The guilty commit is produced by test execution across the
commit range, so a wrong or missing completion degrades the report's prose without affecting
the claim the product defends.

## Building

```bash
docker build -t faultline/narration:v1 narration/
```

The image is large (vLLM + CUDA). It is pulled once per job by Serverless AI; the weights are
cached into the mounted bucket via `HF_HOME` so subsequent hunts load rather than download.
