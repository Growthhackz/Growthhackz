# Sol trigger service. Railway: set the service root to sol-trigger-service/ and attach a volume at /data.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    DATABASE_PATH=/data/sol-trigger.db \
    HOST=::
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 4030
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server.js"]
