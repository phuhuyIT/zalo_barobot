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

# python3-venv hosts the SIFT matcher. libglib/libgomp are for opencv-python-headless.
RUN apt-get update && apt-get install -y python3 python3-venv python3-pip make g++ libglib2.0-0 libgomp1 tzdata && rm -rf /var/lib/apt/lists/*
COPY demo/match-pipeline/requirements.txt /tmp/match-requirements.txt
RUN python3 -m venv /opt/match \
  && /opt/match/bin/pip install --no-cache-dir -r /tmp/match-requirements.txt \
  && rm /tmp/match-requirements.txt
COPY demo/match-pipeline/pipeline.py demo/match-pipeline/score_cli.py /app/demo/match-pipeline/
ENV IMAGE_MATCH_PYTHON=/opt/match/bin/python
ENV IMAGE_MATCH_SCRIPT=/app/demo/match-pipeline/score_cli.py

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node config/ ./config/
COPY --chown=node:node public/ ./public/

# /data is replaced by the Railway volume at runtime (root-owned). entrypoint.sh chowns it.
RUN mkdir -p /data && chown -R node:node /data /app

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3000
ENV TZ=Asia/Ho_Chi_Minh
ENV DATABASE_PATH=/data/app.db
ENV CONFIG_PATH=./config/schedules.yaml
ENV TASKPROOF_WORKER_PORT=3001
ENV ZCA_SESSION_FILE_PATH=/data/zca-session.json
ENV PROOF_DIR=/data/proofs

# Chỉ public cổng official bot. Worker bind 127.0.0.1:3001 trong container.
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/supervisor.js"]
