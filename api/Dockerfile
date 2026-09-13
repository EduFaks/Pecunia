FROM python:3.12-slim

WORKDIR /app
COPY --from=ghcr.io/astral-sh/uv:0.12.13 /uv /usr/local/bin/uv

# Dependency layer: driven by the lockfile, cached independently of src changes.
COPY pyproject.toml uv.lock ./
RUN uv export --frozen --no-dev --no-emit-project -o /tmp/requirements.txt \
    && uv pip install --system --no-cache -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt

COPY src ./src
COPY alembic.ini ./
COPY alembic ./alembic
RUN uv pip install --system --no-cache --no-deps .

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
    && useradd --system --create-home --uid 999 pecunia \
    && mkdir -p /data/config /data/files \
    && chown -R pecunia:pecunia /data

USER pecunia

EXPOSE 8000
ENTRYPOINT ["/entrypoint.sh"]
