# --- Build Stage ---
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# --- Production Stage ---
FROM node:20-alpine AS runner

WORKDIR /app

# Install runtime dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --only=production && apk del python3 make g++

COPY --from=builder /app/dist ./dist
COPY config/ ./config/
COPY public/ ./public/

# Ensure directory for SQLite database volume
RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/data/app.db
ENV CONFIG_PATH=./config/schedules.yaml

EXPOSE 3000

CMD ["node", "dist/index.js"]
