# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npx tsc

# Production stage
FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/src/dashboard/public ./dist/dashboard/public

# Env vars are injected by Coolify at runtime
ENV NODE_ENV=production
ENV DASHBOARD_PORT=3000

EXPOSE 3000

CMD ["node", "dist/index.js"]
