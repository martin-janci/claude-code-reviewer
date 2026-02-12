# Build stage
# Using Docker Hardened Images (dhi.io) - Node 20 LTS with support until April 2026
# dhi.io provides automated security maintenance and is operated in Google ecosystem for lower latency
# Using -dev variant which includes shell for build commands
FROM dhi.io/node:20-alpine3.22-dev AS build
WORKDIR /build
COPY package.json package-lock.json* tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src/ ./src/
RUN npm run build

# Runtime stage
FROM dhi.io/node:20-alpine3.22-dev

# OCI labels for GitHub Container Registry integration
LABEL org.opencontainers.image.source="https://github.com/papayapos/claude-code-reviewer"
LABEL org.opencontainers.image.description="Automated PR code review service using Claude Code CLI"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.title="Claude Code PR Reviewer"
LABEL org.opencontainers.image.vendor="PapayaPOS"

USER root
RUN apk add --no-cache github-cli git su-exec

# Install Claude CLI via npm (global prefix under node user's home)
ENV NPM_CONFIG_PREFIX=/home/node/.local
ARG CLAUDE_CLI_VERSION=latest
RUN mkdir -p /home/node/.local && chown node:node /home/node/.local \
    && su-exec node npm install -g @anthropic-ai/claude-code@${CLAUDE_CLI_VERSION} \
    && su-exec node npm cache clean --force

WORKDIR /app
RUN mkdir -p /app/data && chown -R node:node /app
COPY --from=build /build/dist ./dist/
COPY --from=build /build/node_modules ./node_modules/
COPY --from=build /build/package.json ./
COPY --chown=node:node .claude/ /home/node/.claude/
COPY --chown=node:node .claude/ /home/node/.claude-defaults/
COPY --chown=node:node entrypoint.sh /app/entrypoint.sh

EXPOSE 3000 3001
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q --spider http://localhost:3000/health || exit 1
ENTRYPOINT ["sh", "/app/entrypoint.sh"]
