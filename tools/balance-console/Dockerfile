FROM node:24-alpine AS build

RUN corepack enable
WORKDIR /app

COPY tools/balance-console/package.json tools/balance-console/pnpm-lock.yaml tools/balance-console/pnpm-workspace.yaml ./tools/balance-console/
WORKDIR /app/tools/balance-console
RUN pnpm install --frozen-lockfile

WORKDIR /app
COPY configs ./configs
COPY tools/balance-console ./tools/balance-console
WORKDIR /app/tools/balance-console
RUN pnpm build

FROM node:24-alpine AS runtime

RUN corepack enable
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/configs ./configs
COPY --from=build /app/tools/balance-console ./tools/balance-console
WORKDIR /app/tools/balance-console
EXPOSE 3000
CMD ["pnpm", "start", "--host", "0.0.0.0"]
