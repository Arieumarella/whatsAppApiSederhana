# Dockerfile for WhatsApp-API using whatsapp-web.js
# Uses Debian-based Node image and installs Chromium required by Puppeteer.
FROM node:20-bullseye-slim

WORKDIR /usr/src/app

# Default environment - can be overridden by docker-compose or .env
ENV NODE_ENV=production \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_ARGS="--no-sandbox,--disable-setuid-sandbox"

# Install runtime deps and Chromium
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libnss3 \
    libxss1 \
    libsecret-1-0 \
    libgtk-3-0 \
    libpangocairo-1.0-0 \
  && rm -rf /var/lib/apt/lists/*

# Copy package manifests first to leverage Docker cache
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production

# Copy app source
COPY . .

EXPOSE 5000

CMD ["node", "server.js"]
