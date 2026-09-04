# One image, one process. `codevis serve` already serves the built frontend
# from `frontend/build` alongside `/api/timeline`, so splitting the two into
# separate containers only created a same-origin problem to solve — the static
# server had no way to reach the API.

FROM node:22-alpine AS frontend-build

WORKDIR /frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend ./
RUN npm run build

FROM rust:1-slim AS build

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake \
    pkg-config \
    git \
    && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash app

COPY --from=build /app/target/release/codevis /usr/local/bin/codevis
# ServeDir resolves `frontend/build` relative to the working directory, so this
# path and WORKDIR above have to stay in sync.
COPY --from=frontend-build /frontend/build ./frontend/build
# Multi-project mode writes a registry + per-project clones/timelines under
# this directory. `/app` itself isn't chowned to `app`, so without this the
# unprivileged user couldn't create it at runtime.
RUN mkdir -p /app/data && chown app:app /app/data
USER app

EXPOSE 3001

# `--host 0.0.0.0` is required in a container: the default is loopback, which
# is unreachable through a published port.
CMD ["codevis", "serve", "--host", "0.0.0.0", "--port", "3001", "--data-dir", "/app/data"]
