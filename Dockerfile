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
RUN npm ci --only=production

COPY --from=builder /app/dist ./dist
COPY config/ ./config/
COPY public/ ./public/

# Ensure directory for SQLite database volume
RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=3000
ENV TZ=Asia/Ho_Chi_Minh
ENV DATABASE_PATH=/data/app.db
ENV CONFIG_PATH=./config/schedules.yaml

EXPOSE 3000

CMD ["node", "dist/index.js"]
