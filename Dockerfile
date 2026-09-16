# --- Build Stage ---
FROM node:22-slim AS builder

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# --- Production Stage ---
FROM node:22-slim AS runner

WORKDIR /app

# Install runtime dependencies for better-sqlite3 and timezone data
RUN apt-get update && apt-get install -y python3 make g++ tzdata && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node config/ ./config/
COPY --chown=node:node public/ ./public/

# Ensure directory for SQLite database volume with correct ownership
RUN mkdir -p /data && chown -R node:node /data /app

ENV NODE_ENV=production
ENV PORT=3000
ENV TZ=Asia/Ho_Chi_Minh
ENV DATABASE_PATH=/data/app.db
ENV CONFIG_PATH=./config/schedules.yaml

EXPOSE 3000

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
