FROM python:3.12-slim-trixie AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

# Build tools for any sdist-only deps (pynacl/curl-cffi/psycopg2 fall back to source on aarch64
# when no matching wheel exists). Confined to the builder stage.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential libffi-dev \
 && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app
COPY pyproject.toml README.md ./
COPY src/ src/

RUN pip install --no-cache-dir .


FROM python:3.12-slim-trixie

RUN groupadd --system --gid 999 nonroot \
 && useradd --system --gid 999 --uid 999 --create-home nonroot

COPY --from=builder --chown=nonroot:nonroot /opt/venv /opt/venv

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

USER nonroot
WORKDIR /home/nonroot

EXPOSE 8123

ENTRYPOINT ["hevy2garmin"]
CMD ["status"]
