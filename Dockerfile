# Nabikaran — production image (Next.js standalone, Node 22, non-root).
# Build:  docker build -t nabikaran:latest .
# Run:    see docker-compose.yml

FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /app
# MCP_HOST is baked into the host-based rewrite at build time (next.config.ts rewrites()).
ARG MCP_HOST=mcp.nabikaran.org
ENV MCP_HOST=$MCP_HOST NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build-time placeholders only; real values come from the container environment at runtime.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build \
    SESSION_SECRET=build OTP_PEPPER=build WORKER_TOKEN=build \
    npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN apk add --no-cache curl \
 && addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health >/dev/null || curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health | grep -q 503
CMD ["node", "server.js"]
