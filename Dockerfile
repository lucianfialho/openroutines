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
# policy.yaml (F5 #168) is a hard boot requirement — loadPolicy() throws if it
# is missing, so ship a valid default in the image. Override at deploy via a
# bind mount or POLICY_PATH.
COPY --from=builder /app/policy.yaml ./policy.yaml

EXPOSE 3000

CMD ["node", "dist/main.js"]
