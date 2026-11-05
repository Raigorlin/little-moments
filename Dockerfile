FROM oven/bun:1.3.14-alpine AS build

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
RUN bun run build

FROM oven/bun:1.3.14-alpine AS runtime

WORKDIR /app
ENV PORT=5174 \
    HOST=0.0.0.0 \
    CAMPING_DOCKER_LOCAL_ONLY=1 \
    CAMPING_DB=/app/data/accounts.sqlite \
    CAMPING_OPENAI_API_KEY_FILE=/run/secrets/openai_api_key
RUN mkdir -p /app/data && chown bun:bun /app/data
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --from=build --chown=bun:bun /app/server ./server
COPY --from=build --chown=bun:bun /app/src ./src
COPY --from=build --chown=bun:bun /app/scripts/serve.mjs ./scripts/serve.mjs
COPY --from=build --chown=bun:bun /app/node_modules ./node_modules
USER bun
EXPOSE 5174
CMD ["bun", "scripts/serve.mjs"]
