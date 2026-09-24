# Companion worker: renders media (ffmpeg + sharp), posts to Binance Square and Reddit (Chromium).
# Railway: set the service root to content-machine-service/worker/ and attach a volume at /data.
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core git && rm -rf /var/lib/apt/lists/*
# Official Binance Square scripts, pinned. Override with --build-arg BINANCE_SKILLS_REF=<commit>.
ARG BINANCE_SKILLS_REF=9960c675387bd27f8866645b83693c1fa87242f6
RUN git clone https://github.com/binance/binance-skills-hub.git /opt/binance-skills-hub \
 && git -C /opt/binance-skills-hub checkout "$BINANCE_SKILLS_REF"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npx playwright install --with-deps chromium
COPY *.mjs ./
ENV BINANCE_SQUARE_SKILL_DIR=/opt/binance-skills-hub/skills/binance/square-post \
    REDDIT_STATE_PATH=/data/reddit-session.json \
    DIRECTORY_STATE_DIR=/data \
    DIRECTORY_DEBUG_DIR=/data/debug \
    FFMPEG_PATH=ffmpeg
CMD ["node", "worker.mjs"]
