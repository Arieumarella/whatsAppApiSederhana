FROM node:20-bookworm

WORKDIR /app

# Prevent puppeteer from downloading its own chrome during npm install
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Install chromium and fonts for puppeteer
RUN apt-get update && \
    apt-get install -y chromium fonts-freefont-ttf && \
    rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy rest of the project
COPY . .

EXPOSE 5000

CMD ["node", "server.js"]
