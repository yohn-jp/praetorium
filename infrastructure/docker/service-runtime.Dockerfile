# syntax=docker/dockerfile:1.7
# BuildKit callers must pass both base images as immutable repository@sha256 references.
ARG NODE_BUILD_IMAGE
ARG NODE_RUNTIME_IMAGE

FROM ${NODE_BUILD_IMAGE} AS build
ARG NODE_BUILD_IMAGE
ARG NODE_RUNTIME_IMAGE
WORKDIR /workspace
RUN node -e 'for (const key of ["NODE_BUILD_IMAGE", "NODE_RUNTIME_IMAGE"]) { if (!/^(?:[a-z0-9.-]+(?::[0-9]+)?\/)+[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(process.env[key] ?? "")) throw new Error(`${key} must be a repository-qualified immutable digest`); }' \
  && corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Lockfile patches must be present for the dependency-only fetch.
COPY plugins/ghcr/patches/@sigstore__core@4.0.1.patch ./plugins/ghcr/patches/@sigstore__core@4.0.1.patch
# Use the same bundled public CA roots for BuildKit proxy requests as the original install.
RUN node -e 'const fs = require("node:fs"); fs.mkdirSync("/etc/ssl/certs", { recursive: true }); fs.writeFileSync("/etc/ssl/certs/ca-certificates.crt", require("node:tls").rootCertificates.join("\n") + "\n");'
RUN --mount=type=cache,id=praetorium-pnpm-store,target=/pnpm/store,sharing=locked \
    NODE_USE_ENV_PROXY=1 NODE_USE_SYSTEM_CA=1 pnpm fetch --store-dir=/pnpm/store
COPY tsconfig.base.json turbo.json ./
COPY apps/ ./apps/
COPY packages/ ./packages/
COPY plugins/ ./plugins/
# Changing the service target must not invalidate the shared dependency fetch.
ARG SERVICE_PACKAGE
RUN --mount=type=cache,id=praetorium-pnpm-store,target=/pnpm/store,sharing=locked \
    node -e 'if (!/^@praetorium\/[a-z0-9-]+$/.test(process.env.SERVICE_PACKAGE ?? "")) throw new Error("SERVICE_PACKAGE must be an exact Praetorium workspace package");' \
  && export NODE_USE_ENV_PROXY=1 NODE_USE_SYSTEM_CA=1 \
  && pnpm install --offline --frozen-lockfile --store-dir=/pnpm/store --package-import-method=copy \
  && pnpm --filter "${SERVICE_PACKAGE}..." build \
  && pnpm --filter "$SERVICE_PACKAGE" deploy --prod --legacy /runtime

FROM ${NODE_RUNTIME_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /runtime/ ./
USER node
CMD ["node", "dist/main.js"]
