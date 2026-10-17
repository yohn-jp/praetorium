# syntax=docker/dockerfile:1.7
# The BuildKit client is copied from a caller-pinned official image; no daemon,
# registry credentials, or workspace content is copied into the runtime image.
ARG NODE_BUILD_IMAGE
ARG NODE_RUNTIME_IMAGE
ARG BUILDKIT_CLIENT_IMAGE

FROM ${BUILDKIT_CLIENT_IMAGE} AS buildkit-client

FROM ${NODE_BUILD_IMAGE} AS build
ARG SERVICE_PACKAGE
ARG NODE_BUILD_IMAGE
ARG NODE_RUNTIME_IMAGE
ARG BUILDKIT_CLIENT_IMAGE
ARG BUILDKIT_CLIENT_BUILDCTL_PATH
WORKDIR /workspace
RUN node -e 'const digest = /^(?:[a-z0-9.-]+(?::[0-9]+)?\/)+[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/; for (const key of ["NODE_BUILD_IMAGE", "NODE_RUNTIME_IMAGE", "BUILDKIT_CLIENT_IMAGE"]) { if (!digest.test(process.env[key] ?? "")) throw new Error(`${key} must be a repository-qualified immutable digest`); } if (process.env.SERVICE_PACKAGE !== "@praetorium/build-worker") throw new Error("SERVICE_PACKAGE must be @praetorium/build-worker"); if (!/^\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+$/.test(process.env.BUILDKIT_CLIENT_BUILDCTL_PATH ?? "") || process.env.BUILDKIT_CLIENT_BUILDCTL_PATH.split("/").includes("..")) throw new Error("BUILDKIT_CLIENT_BUILDCTL_PATH must be a normalized absolute path");' \
  && corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.base.json turbo.json ./
COPY apps/ ./apps/
COPY packages/ ./packages/
COPY plugins/ ./plugins/
RUN pnpm install --frozen-lockfile \
  && pnpm --filter "${SERVICE_PACKAGE}..." build \
  && pnpm --filter "$SERVICE_PACKAGE" deploy --prod --legacy /runtime

FROM ${NODE_RUNTIME_IMAGE} AS runtime
ARG NODE_RUNTIME_IMAGE
ARG BUILDKIT_CLIENT_IMAGE
ARG BUILDKIT_CLIENT_BUILDCTL_PATH
ENV NODE_ENV=production \
    PRAETORIUM_BUILDKIT_BUILDCTL_PATH=/usr/local/bin/buildctl
WORKDIR /app
COPY --from=buildkit-client --chmod=0555 ${BUILDKIT_CLIENT_BUILDCTL_PATH} /usr/local/bin/buildctl
RUN node -e 'for (const key of ["NODE_RUNTIME_IMAGE", "BUILDKIT_CLIENT_IMAGE"]) { if (!/^(?:[a-z0-9.-]+(?::[0-9]+)?\/)+[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(process.env[key] ?? "")) throw new Error(`${key} must be a repository-qualified immutable digest`); }' \
  && test -x /usr/local/bin/buildctl \
  && /usr/local/bin/buildctl --version
COPY --from=build --chown=node:node /runtime/ ./
USER node
CMD ["node", "dist/main.js"]
