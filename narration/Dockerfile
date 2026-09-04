# Faultline narration job — one NVIDIA-model completion per hunt, then exit.
#
# Contract:
#   reads  FAULTLINE_{HUNT_ID,COMMIT_SHA,MODEL_ID,PROMPT,OUTPUT_PATH,MAX_TOKENS}
#   writes <FAULTLINE_OUTPUT_PATH>/<huntId>/narration.json in every exit path
#
# Runs on Nebius Serverless AI Jobs, platform gpu-l40s-a / preset 1gpu-8vcpu-32gb.
# The base image already carries vLLM and the CUDA runtime, so the container does not
# compile anything at start — cold start is dominated by the weight load, not the build.
FROM vllm/vllm-openai:v0.6.3

# Weights are cached into the mounted bucket so a second hunt loads rather than re-downloads.
ENV HF_HOME=/out/.hf-cache \
    PYTHONUNBUFFERED=1

COPY narrate.py /app/narrate.py

ENTRYPOINT ["python3", "/app/narrate.py"]
