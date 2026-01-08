# x402-skale Gateway Dockerfile
#
# Build:
#   docker build -t x402-skale-gateway .
#
# Run:
#   docker run -p 4002:4002 --env-file .env x402-skale-gateway
#

# ============================================
# Build Stage
# ============================================
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev)
RUN npm ci

# Copy source files
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# ============================================
# Production Stage
# ============================================
FROM node:20-alpine AS runner

WORKDIR /app

# Install production dependencies only
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    sqlite

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 x402

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm ci --production && \
    npm cache clean --force

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Create data directory
RUN mkdir -p /app/data && chown -R x402:nodejs /app/data

# Switch to non-root user
USER x402

# Expose port
EXPOSE 4002

# Environment
ENV NODE_ENV=production
ENV PORT=4002
ENV DATABASE_PATH=/app/data/x402.db

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget -q --spider http://localhost:4002/health || exit 1

# Start command
CMD ["node", "dist/index.js"]
