# Stage 1: build the React UI into static files.
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# Stage 2: the Python API, which also serves the built UI.
FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.13.8 /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY app/ app/
# All committed data: hubs, snapshot, metro areas, nicknames, JEV second opinion (app.db is in .dockerignore).
COPY data/ data/
COPY --from=web /web/dist web/dist
ENV PORT=8000
EXPOSE 8000
# Proxy headers so the rate limit sees the client IP behind Render's proxy.
CMD ["sh", "-c", "uv run --no-sync uvicorn app.api:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
