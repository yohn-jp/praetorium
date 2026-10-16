FROM node:24-alpine AS build

WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @praetorium/instance-access... run build
RUN pnpm --filter @praetorium/instance-access deploy --prod --legacy /out

FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    INSTANCE_ACCESS_PORT=8080
WORKDIR /app
COPY --from=build --chown=10001:10001 /out/ ./
USER 10001:10001
EXPOSE 8080
CMD ["node", "dist/server.js"]
