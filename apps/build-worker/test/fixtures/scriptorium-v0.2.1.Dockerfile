ARG NODE_IMAGE=docker.io/library/node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
ARG GO_IMAGE=docker.io/library/golang:1.25.5-bookworm@sha256:d9132cce84391efab786495288756d60e1da215b1f94e87860aeefc3d4c45b6d
ARG PNPM_VERSION=12.10.1
ARG PROFILE=core

FROM ${NODE_IMAGE} AS pnpm-base
ARG PNPM_VERSION
ENV CI=true
RUN corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /opt/scriptorium

FROM pnpm-base AS source
COPY . ./
RUN pnpm install --frozen-lockfile

FROM source AS build
ARG PROFILE
ENV SCRIPTORIUM_PROFILE=${PROFILE}
RUN node scripts/profile-package.mjs --profile "${PROFILE}" --out /runtime

FROM ${GO_IMAGE} AS frontend-build
WORKDIR /src
COPY buildkit/frontend/go.mod buildkit/frontend/go.sum ./
COPY buildkit/frontend/main.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -buildvcs=false -ldflags='-s -w' -o /scriptorium-buildkit-frontend .

FROM source AS buildkit
ARG SCRIPTORIUM_PRODUCER_REVISION
ARG SCRIPTORIUM_DOCKERFILE_SHA256
ENV SCRIPTORIUM_PRODUCER_REVISION=${SCRIPTORIUM_PRODUCER_REVISION} \
    SCRIPTORIUM_DOCKERFILE_SHA256=${SCRIPTORIUM_DOCKERFILE_SHA256}
LABEL org.opencontainers.image.revision=${SCRIPTORIUM_PRODUCER_REVISION}
RUN test "${#SCRIPTORIUM_PRODUCER_REVISION}" -eq 40 \
 && printf '%s' "${SCRIPTORIUM_PRODUCER_REVISION}" | grep -Eq '^[a-f0-9]{40}$' \
 && printf '%s' "${SCRIPTORIUM_DOCKERFILE_SHA256}" | grep -Eq '^[a-f0-9]{64}$'
RUN pnpm build
RUN node scripts/profile-package.mjs --modules-json '[]' --prebuilt --prime-deploy-cache --out /tmp/scriptorium-hosted-artifact/app \
 && rm -rf /tmp/scriptorium-hosted-artifact
COPY --from=frontend-build /scriptorium-buildkit-frontend /usr/local/bin/scriptorium-buildkit-frontend
ENTRYPOINT ["/usr/local/bin/scriptorium-buildkit-frontend"]

FROM ${NODE_IMAGE} AS runtime-base
ARG SCRIPTORIUM_PRODUCER_REVISION
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    SCRIPTORIUM_PROFILE=hosted \
    SCRIPTORIUM_MODULE_PROFILE_PATH=/app/generated/server.mjs \
    SCRIPTORIUM_DATA_DIR=/data \
    SCRIPTORIUM_USAGE_DIR=/history \
    HOME=/data \
    SCRIPTORIUM_PRODUCER_REVISION=${SCRIPTORIUM_PRODUCER_REVISION}
LABEL org.opencontainers.image.revision=${SCRIPTORIUM_PRODUCER_REVISION}
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git tini \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /app /data /history \
 && chmod 0700 /history \
 && chown node:node /app /data /history
WORKDIR /app
USER node
VOLUME ["/data", "/history"]
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "launch.mjs"]

FROM ${NODE_IMAGE} AS runtime
ARG PROFILE
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    SCRIPTORIUM_PROFILE=${PROFILE} \
    SCRIPTORIUM_MODULE_PROFILE_PATH=/app/generated/server.mjs \
    SCRIPTORIUM_DATA_DIR=/data \
    SCRIPTORIUM_USAGE_DIR=/history \
    HOME=/data \
    TMPDIR=/tmp
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git tini \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data /history \
 && chmod 0700 /history \
 && chown node:node /data /history
WORKDIR /app
COPY --chown=node:node --from=build /runtime/ ./

USER node
VOLUME ["/data", "/history"]
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "launch.mjs"]
