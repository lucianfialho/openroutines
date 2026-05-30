# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Runtime stage
FROM node:20-alpine

# Install GitHub CLI for github_fetch_issue tool
RUN apk add --no-cache github-cli git

# Allow git operations on mounted repos (e.g. /repo in Docker Compose)
RUN git config --global --add safe.directory '*'

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/persistence/migrations ./dist/persistence/migrations
COPY --from=builder /app/src/gate/migrations ./dist/gate/migrations

EXPOSE 3000

CMD ["node", "dist/main.js"]
