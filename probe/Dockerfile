# =====================================================================================
# Faultline probe image — the container contract
# =====================================================================================
#
# One container = one git commit = one verdict.
#
# READS (environment variables, supplied by the Nebius Jobs API via
# `spec.environmentVariables`):
#
#   FAULTLINE_HUNT_ID          required  hunt this probe belongs to
#   FAULTLINE_REPO_URL         required  git URL to fetch from
#   FAULTLINE_COMMIT_SHA       required  the ONE commit to test (full SHA)
#   FAULTLINE_TEST_COMMAND     required  shell-style command, run in the checkout root
#   FAULTLINE_OUTPUT_PATH      required  mount point of the S3 volume, e.g. /out
#   FAULTLINE_TIMEOUT_SECONDS  optional  total budget, default 900
#
# GUARANTEES (write):
#
#   $FAULTLINE_OUTPUT_PATH/$FAULTLINE_HUNT_ID/probes/$FAULTLINE_COMMIT_SHA.json
#
#   A `faultline.probe.v1` ProbeResult document, written atomically (temp file +
#   os.replace), ALWAYS — including when the clone, the dependency install, or the
#   probe itself fails. The Jobs API exposes no exit code and no logs over REST, so
#   this file is the only channel by which a verdict reaches the application. A
#   missing file is indistinguishable from a still-running job and stalls the hunt.
#
#   The same JSON is also printed to stdout on one line, so `nebius ai job logs`
#   shows a human the exact verdict the application acted on.
#
# EXIT CODE: 0 for a pass/fail verdict, 1 for an error verdict, 2 if the verdict file
# could not be written. Nebius does not surface this; it is for local runs.
# =====================================================================================

FROM python:3.11.9-slim-bookworm

# git is the only OS package the probe needs. ca-certificates for https remotes.
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        git=1:2.39.* \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# uv, copied from its own published image rather than pip-installed: no build step, no
# resolver run at image-build time, and it is pinned to an exact version. uv is what
# makes the per-commit dependency install cheap, and that install is the dominant cost
# of a probe.
COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /usr/local/bin/uv

# Non-root. The probe writes only to /tmp (the checkout) and to the mounted volume.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin probe

# A virtualenv owned by the probe user, so `uv pip install -e .` of the commit under
# test works without root and without mutating the image's system site-packages.
ENV VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    GIT_TERMINAL_PROMPT=0
RUN python -m venv "$VIRTUAL_ENV" \
    && chown -R probe:probe "$VIRTUAL_ENV"

# pytest is pre-seeded so that a stdlib-only commit (no pyproject/requirements/setup.py)
# can still be tested with a `pytest`-shaped command. A commit that declares its own
# pytest version overrides this at install time — the commit's own deps always win.
RUN uv pip install --python "$VIRTUAL_ENV/bin/python" \
        "pytest==8.3.4" \
    && chown -R probe:probe "$VIRTUAL_ENV"

# Copied last: probe.py is the only layer that changes during development, so the
# apt/uv/venv layers above stay cached.
COPY --chown=probe:probe probe.py /app/probe.py

USER probe
WORKDIR /app
ENV HOME=/home/probe

ENTRYPOINT ["python", "/app/probe.py"]
