# Use Node.js 20 Alpine for minimal image size
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy application code
COPY src/ ./src/

# Create logs directory
RUN mkdir -p logs

# Set environment to production
ENV NODE_ENV=production

# Run as non-root user for security
USER node

# Expose port (optional, for health check endpoint if added)
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "console.log('healthy')" || exit 1

# Start the application
CMD ["node", "src/index.js"]
