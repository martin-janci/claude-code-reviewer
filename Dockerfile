# Build stage
FROM node:20-alpine AS build
WORKDIR /build
COPY package.json package-lock.json* tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src/ ./src/
RUN npm run build

# Runtime stage
FROM registry.rlt.sk/claude-code-custom:latest
USER root
RUN apk add --no-cache github-cli git su-exec

WORKDIR /app
RUN mkdir -p /app/data && chown -R node:node /app
COPY --from=build /build/dist ./dist/
COPY --from=build /build/node_modules ./node_modules/
COPY --from=build /build/package.json ./
COPY --chown=node:node .claude/ /home/node/.claude/
COPY --chown=node:node entrypoint.sh /app/entrypoint.sh

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q --spider http://localhost:3000/health || exit 1
ENTRYPOINT ["sh", "/app/entrypoint.sh"]
