# syntax=docker/dockerfile:1.7
# The BuildKit client is copied from a caller-pinned official image; no daemon,
# registry credentials, or workspace content is copied into the runtime image.
ARG NODE_BUILD_IMAGE
ARG NODE_RUNTIME_IMAGE
ARG BUILDKIT_CLIENT_IMAGE
ARG PRAETORIUM_BUILDKIT_BUILDCTL_PATH

FROM ${BUILDKIT_CLIENT_IMAGE} AS buildkit-client

FROM ${NODE_BUILD_IMAGE} AS build
ARG SERVICE_PACKAGE
ARG NODE_BUILD_IMAGE
ARG NODE_RUNTIME_IMAGE
ARG BUILDKIT_CLIENT_IMAGE
ARG BUILDKIT_CLIENT_BUILDCTL_PATH
ARG PRAETORIUM_BUILDKIT_BUILDCTL_PATH
WORKDIR /workspace
RUN node -e 'const digest = /^(?:[a-z0-9.-]+(?::[0-9]+)?\/)+[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/; for (const key of ["NODE_BUILD_IMAGE", "NODE_RUNTIME_IMAGE", "BUILDKIT_CLIENT_IMAGE"]) { if (!digest.test(process.env[key] ?? "")) throw new Error(`${key} must be a repository-qualified immutable digest`); } if (process.env.SERVICE_PACKAGE !== "@praetorium/build-worker") throw new Error("SERVICE_PACKAGE must be @praetorium/build-worker"); for (const key of ["BUILDKIT_CLIENT_BUILDCTL_PATH", "PRAETORIUM_BUILDKIT_BUILDCTL_PATH"]) { const value = process.env[key] ?? ""; if (!/^\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+$/.test(value) || value.split("/").includes("..")) throw new Error(`${key} must be a normalized absolute path`); }' \
  && corepack enable
# Go buildctl needs the system CA bundle; derive public roots from the same
# caller-pinned Node build image without installing packages or updating a base.
RUN node -e 'const { rootCertificates } = require("node:tls"); if (!Array.isArray(rootCertificates) || rootCertificates.length === 0 || rootCertificates.some((pem) => !pem.startsWith("-----BEGIN CERTIFICATE-----"))) throw new Error("Node bundled CA roots are unavailable"); const bundle = `${rootCertificates.map((pem) => pem.trimEnd()).join("\n")}\n`; require("node:tls").createSecureContext({ ca: bundle }); process.stdout.write(bundle);' \
  > /workspace/ca-certificates.crt \
  && test -s /workspace/ca-certificates.crt
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
ARG PRAETORIUM_BUILDKIT_BUILDCTL_PATH
ENV NODE_ENV=production \
    PRAETORIUM_BUILDKIT_BUILDCTL_PATH=${PRAETORIUM_BUILDKIT_BUILDCTL_PATH}
WORKDIR /app
# Source Producer fetches only an allowlisted GitHub Release at its verified
# immutable SHA. Build scripts still execute exclusively in remote BuildKit.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/* \
 && git --version
COPY --from=buildkit-client --chmod=0555 ${BUILDKIT_CLIENT_BUILDCTL_PATH} ${PRAETORIUM_BUILDKIT_BUILDCTL_PATH}
COPY --from=build --chmod=0444 /workspace/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN chmod 0755 /etc/ssl /etc/ssl/certs \
  && node -e 'for (const key of ["NODE_RUNTIME_IMAGE", "BUILDKIT_CLIENT_IMAGE"]) { if (!/^(?:[a-z0-9.-]+(?::[0-9]+)?\/)+[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(process.env[key] ?? "")) throw new Error(`${key} must be a repository-qualified immutable digest`); }' \
  && test -s /etc/ssl/certs/ca-certificates.crt \
  && node -e 'const fs = require("node:fs"); const tls = require("node:tls"); const bundle = fs.readFileSync("/etc/ssl/certs/ca-certificates.crt", "utf8"); if (!bundle.includes("-----BEGIN CERTIFICATE-----")) throw new Error("CA bundle is empty"); tls.createSecureContext({ ca: bundle });' \
  && test -x "$PRAETORIUM_BUILDKIT_BUILDCTL_PATH" \
  && "$PRAETORIUM_BUILDKIT_BUILDCTL_PATH" --version
COPY --from=build --chown=node:node /runtime/ ./
USER node
# Validate the same non-root identity used by the deployment, including directory traversal.
RUN node -e 'const fs = require("node:fs"); const tls = require("node:tls"); tls.createSecureContext({ ca: fs.readFileSync("/etc/ssl/certs/ca-certificates.crt", "utf8") });'
CMD ["node", "dist/main.js"]
