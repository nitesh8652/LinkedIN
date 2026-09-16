# syntax=docker/dockerfile:1.7
FROM node:20-bookworm-slim

# Playwright/Chromium system deps are installed via `playwright install --with-deps`.
# Keep apt cache clean and install tini for proper signal handling.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force

# Install Chromium + required OS libs. playwright is already installed via npm.
RUN npx playwright install --with-deps chromium

# Copy app source (respects .dockerignore)
COPY . .

# Ensure runtime dirs exist and are owned by non-root user
RUN mkdir -p uploads outputs \
  && groupadd -r appgroup && useradd -r -g appgroup -G audio,video -s /bin/bash appuser \
  && chown -R appuser:appgroup /app

ENV NODE_ENV=production
ENV PORT=3000
# Playwright: skip download on later npm installs (browser already installed)
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

EXPOSE 3000

# Drop privileges
USER appuser

# Healthcheck hits a cheap, no-credit endpoint that proves Express is up.
# SearXNG/Serper availability is reported inside the app job log, not here.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/search-config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
