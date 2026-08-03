# No `# syntax=docker/dockerfile:1` directive, deliberately. Pinning the frontend
# makes every build pull docker/dockerfile from a registry before it reads a line
# of this file, which is the same build-time network dependency the committed Yarn
# release exists to avoid — and it fails closed, with an opaque
# "resolve image config ... DeadlineExceeded". Nothing here needs a feature the
# built-in BuildKit frontend lacks; `RUN --mount=type=cache` is the newest thing
# used and has been built in since Docker 23. Add the directive back if a genuine
# frontend feature is needed, not by reflex.
#
# One image, three roles (spec §2.5). OPENBOOKS_ROLE=api|worker|migrate selects
# the entrypoint at boot — packages/server/src/config/role.ts holds the register
# and fails fast on an unrecognised value. Self-host and hosted run this exact
# artifact, so nothing below may branch on deployment environment.

ARG NODE_VERSION=22.19.0

# The Yarn 4 binary is committed at .yarn/releases (see .gitignore) so no build
# needs corepack or network access to bootstrap a package manager. The `yarn` on
# PATH in the node images is Yarn 1, which does not read .yarnrc.yml's yarnPath,
# so the release is invoked directly at every call site below. Bumping the pin in
# package.json means bumping this default.
ARG YARN=.yarn/releases/yarn-4.17.1.cjs

# ── base ─────────────────────────────────────────────────────────────────────
# Debian slim rather than Alpine. `enableScripts: false` in .yarnrc.yml means
# native dependencies must resolve a prebuilt binary at require time with no
# compile fallback, and glibc is the target prebuild publishers ship first and
# most reliably. argon2 does ship musl builds, but choosing musl would make
# correctness depend on libc autodetection across the whole dependency tree
# rather than one package — not worth the ~40 MB saved.
#
# No architecture is pinned anywhere in this file: buildx resolves it, so an
# arm64 dev machine and x86_64 Fargate build the same definition unchanged.
FROM node:${NODE_VERSION}-slim AS base
WORKDIR /app

# ── toolchain ────────────────────────────────────────────────────────────────
# Manifests only, so a source-only edit does not invalidate the install layer.
# Each workspace manifest is copied explicitly: `COPY packages/*/package.json`
# flattens the paths and Yarn would not find the workspaces.
FROM base AS toolchain
ENV YARN_GLOBAL_FOLDER=/opt/yarn
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases .yarn/releases
COPY packages/e2e/package.json packages/e2e/
COPY packages/eslint-plugin/package.json packages/eslint-plugin/
COPY packages/plugin-api/package.json packages/plugin-api/
COPY packages/server/package.json packages/server/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/web/package.json packages/web/

# ── deps ─────────────────────────────────────────────────────────────────────
# Full install including devDependencies — esbuild and typescript are build
# inputs. The lockfile is authored on darwin-arm64 but already carries the
# resolutions for every platform-specific optional package, so `--immutable`
# holds on linux too; a failure here means yarn.lock is genuinely stale.
FROM toolchain AS deps
ARG YARN
RUN --mount=type=cache,target=/opt/yarn node "${YARN}" install --immutable

# ── build ────────────────────────────────────────────────────────────────────
# `yarn build` at the root, per package.json. It emits dist/server/main.js via
# scripts/build-server.mjs and also builds @openbooks/web, which this image does
# not ship (the SPA is served as static assets — see OB-007). Running the root
# script rather than the server workspace alone keeps one definition of "the
# production build" instead of two that can drift.
FROM deps AS build
ARG YARN
COPY . .
RUN node "${YARN}" build

# ── prod-deps ────────────────────────────────────────────────────────────────
# The runtime node_modules. scripts/build-server.mjs leaves argon2, mysql2, pino,
# pino-pretty and thread-stream out of the bundle, so they are resolved from disk
# at require time and have to physically exist here; everything else is inlined.
# `workspaces focus @openbooks/server --production` installs exactly the server's
# dependency closure and drops devDependencies, which is what keeps esbuild,
# vitest, testcontainers and the React toolchain out of the image.
#
# pino-pretty is the one external that is *not* installed, because it is a
# devDependency — correct for production, where logs are JSON (spec §12). It only
# becomes a problem if application code ever imports it unconditionally rather
# than behind a development-only branch, and the symptom would be a runtime
# module-not-found in this image while dev and test pass.
FROM toolchain AS prod-deps
ARG YARN
RUN --mount=type=cache,target=/opt/yarn \
    node "${YARN}" workspaces focus @openbooks/server --production

# ── runtime ──────────────────────────────────────────────────────────────────
FROM base AS runtime

ENV NODE_ENV=production

# node_modules plus the manifests that make Node resolve dist/server/main.js as
# ESM (the root package.json's "type": "module") and keep the workspace symlinks
# from dangling.
COPY --from=prod-deps --chown=root:root /app /app
COPY --from=build --chown=root:root /app/dist ./dist

# The local StorageProvider (STORAGE_PROVIDER=local) writes rendered artifacts —
# 1099 Copy B PDFs, invoice/statement PDFs, uploaded logos — under STORAGE_LOCAL_PATH
# (compose default /var/lib/openbooks/storage). The process runs as `node` (below) and
# /var/lib is root-owned, so the base directory must exist and be node-owned before the
# privilege drop; without it the first write dies with `EACCES: mkdir '/var/lib/openbooks'`
# (nothing had ever exercised a local write until the 1099 Copy B download). Creating it
# here also sets the ownership a fresh Docker named volume mounted at this path inherits on
# first init, so persisted artifact storage stays writable.
RUN mkdir -p /var/lib/openbooks/storage && chown -R node:node /var/lib/openbooks

# The `node` user (uid 1000) ships with the base image. Nothing in the runtime
# tree is owned by it, so the process cannot modify its own code.
USER node

EXPOSE 3000

# Liveness for the api role. Uses Node's built-in fetch because the slim image
# has no curl or wget, and 127.0.0.1 rather than localhost to avoid resolving to
# an unbound ::1. HTTP_PORT and its 3000 default mirror the schema in
# packages/server/src/config/env.ts — no default is duplicated into ENV, so the
# config module stays the only place that decides it.
#
# HEALTHCHECK is a property of the image, not the role, so it is wrong for
# `worker` (no listener) and `migrate` (exits). docker-compose.yml disables it
# for those two services. The /health path is the api role's contract with
# OB-022; if that route lands elsewhere, this must follow.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "dist/server/main.js"]

# ── web ────────────────────────────────────────────────────────────────────────
# The React SPA behind nginx, served same-origin with the API: nginx forwards
# /v1, /health and /docs to the api container, so the HttpOnly session cookie and
# the deliberately-absent CORS layer both hold — a browser reaching the API on a
# different origin would break on both. Reuses the `build` stage's SPA output
# rather than rebuilding it. A separate final stage from `runtime`: the app roles
# pin `target: runtime` in docker-compose.yml so appending this cannot change the
# image they build, and the web service selects `target: web`.
FROM nginx:alpine AS web
COPY infra/nginx/openbooks-web.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/web/dist /usr/share/nginx/html
