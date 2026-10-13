# =====================================================================================
# Faultline probe image — the container contract
# =====================================================================================
#
# One container = one git commit = one verdict.
#
# NOT ON THE DEFAULT PATH. The deployed app runs every probe on the stock `python:3.11`
# image and injects probe.py at job creation (spec.injectedFiles). This image is the later
# optimisation: smaller pull, non-root, uv, pre-seeded pytest. See probe/README.md for the
# contract — environment variables in, one verdict PUT to a presigned URL out.
# =====================================================================================

FROM python:3.11.16-slim-bookworm

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

# Non-root. The probe writes only to /tmp (the checkout); its verdict leaves over HTTPS.
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
