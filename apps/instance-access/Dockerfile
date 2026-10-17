FROM docker.io/library/node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build

WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @praetorium/instance-access... run build
RUN pnpm --filter @praetorium/instance-access deploy --prod --legacy /out

FROM docker.io/library/node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS runtime
ENV NODE_ENV=production \
    INSTANCE_ACCESS_PORT=8080
WORKDIR /app
COPY --from=build --chown=10001:10001 /out/ ./
USER 10001:10001
EXPOSE 8080
CMD ["node", "dist/server.js"]
