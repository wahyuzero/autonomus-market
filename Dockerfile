# Build stage — install ALL deps (including typescript) and compile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx tsc

# Production stage — slim image with only production deps
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/dashboard/public ./dist/dashboard/public

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/index.js"]
