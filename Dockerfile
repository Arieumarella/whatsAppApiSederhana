# --- Stage 1: Builder ---
# Install all dependencies (including dev) so optional build steps can run
FROM ghcr.io/puppeteer/puppeteer:latest AS builder

WORKDIR /app

# Use non-root user provided by the puppeteer image
USER pptruser

# Copy package files and install all dependencies
COPY --chown=pptruser:pptruser package*.json ./
RUN npm install

# Copy source
COPY --chown=pptruser:pptruser . .

# If you have any build step (transpile, prisma generate, etc) run here
# RUN npm run build


# --- Stage 2: Runtime image ---
FROM ghcr.io/puppeteer/puppeteer:latest
WORKDIR /app
USER pptruser

# Copy only production dependencies
COPY --chown=pptruser:pptruser package*.json ./
RUN npm install --omit=dev

# Copy application code from builder stage
COPY --chown=pptruser:pptruser --from=builder /app .

# Expose the port (default in .env is 5000)
EXPOSE 5000

# Default command - run server.js
CMD [ "node", "server.js" ]
