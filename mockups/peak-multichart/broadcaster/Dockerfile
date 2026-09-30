# Chromium + Node from Playwright's image, plus ffmpeg and a virtual screen.
FROM mcr.microsoft.com/playwright:v1.56.1-noble
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg xvfb fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY broadcaster.mjs ./
ENV NODE_ENV=production
CMD ["node", "broadcaster.mjs"]
