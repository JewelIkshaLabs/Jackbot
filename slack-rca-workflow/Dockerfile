FROM node:18-alpine

# Install git for cloning repositories
RUN apk add --no-cache git

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY src/ ./src/

# Clone repository at build time (before switching to non-root user)
ARG GITHUB_REPO
ARG GIT_CLONE_TOKEN
ARG BACKEND_BRANCH
RUN if [ -n "$GITHUB_REPO" ]; then \
      mkdir -p /app/repo && \
      if [ -n "$GIT_CLONE_TOKEN" ]; then \
        REPO_URL=$(echo $GITHUB_REPO | sed "s|https://github.com/|https://${GIT_CLONE_TOKEN}@github.com/|"); \
      else \
        REPO_URL=$GITHUB_REPO; \
      fi && \
      if [ -n "$BACKEND_BRANCH" ]; then \
        git clone --depth 1 -b $BACKEND_BRANCH $REPO_URL /app/repo || \
        git clone --depth 1 $REPO_URL /app/repo; \
      else \
        git clone --depth 1 $REPO_URL /app/repo; \
      fi && \
      echo "Repository cloned to /app/repo"; \
    else \
      echo "No GITHUB_REPO provided, skipping clone"; \
    fi

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Change ownership (including cloned repo)
RUN chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start application
CMD ["node", "src/server.js"]

