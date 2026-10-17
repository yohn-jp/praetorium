# syntax=docker/dockerfile:1.7
# BuildKit callers must pass both base images as immutable repository@sha256 references.
ARG NODE_BUILD_IMAGE
ARG NODE_RUNTIME_IMAGE

FROM ${NODE_BUILD_IMAGE} AS build
ARG SERVICE_PACKAGE
ARG NODE_BUILD_IMAGE
ARG NODE_RUNTIME_IMAGE
WORKDIR /workspace
RUN node -e 'for (const key of ["NODE_BUILD_IMAGE", "NODE_RUNTIME_IMAGE"]) { if (!/^(?:[a-z0-9.-]+(?::[0-9]+)?\/)+[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(process.env[key] ?? "")) throw new Error(`${key} must be a repository-qualified immutable digest`); } if (!/^@praetorium\/[a-z0-9-]+$/.test(process.env.SERVICE_PACKAGE ?? "")) throw new Error("SERVICE_PACKAGE must be an exact Praetorium workspace package");' \
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
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /runtime/ ./
USER node
CMD ["node", "dist/main.js"]
