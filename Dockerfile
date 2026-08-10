# Build stage
# Using Docker Hardened Images (dhi.io) - Node 20 LTS with support until April 2026
# dhi.io provides automated security maintenance and is operated in Google ecosystem for lower latency
# Using -dev variant which includes shell for build commands
FROM dhi.io/node:20-alpine3.22-dev AS build
WORKDIR /build
COPY package.json package-lock.json* tsconfig.json ./
RUN apk add --no-cache python3 make g++ && npm ci
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

# --- Language servers for LSP code-intelligence ---
# Java: Eclipse JDT LS (pure JVM — runs on Alpine's musl openjdk; python3 for its launcher)
RUN apk add --no-cache openjdk21-jre-headless python3 unzip gcompat libstdc++ \
    && mkdir -p /opt/jdtls \
    && wget -qO- https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz | tar -xz -C /opt/jdtls \
    && printf '#!/bin/sh\nexec /opt/jdtls/bin/jdtls --jvm-arg=-Xmx1024m "$@"\n' > /usr/local/bin/jdtls \
    && chmod +x /usr/local/bin/jdtls

# Kotlin: JetBrains kotlin-lsp (EXPERIMENTAL). Its native launcher + bundled JBR are
# glibc-only and fail on musl, so we discard them and launch the IntelliJ platform
# directly on a musl-native Zulu JRE 25, with the java command synthesized from the
# distribution's own product-info.json. Verified working on the pod before baking in.
# A runtime failure only disables the Kotlin LSP backend — reviews are unaffected.
ARG ZULU_JRE25_URL=https://cdn.azul.com/zulu/bin/zulu25.36.15-ca-jre25.0.4-linux_musl_x64.tar.gz
RUN wget -qO /tmp/zulu25.tar.gz ${ZULU_JRE25_URL} \
    && mkdir -p /opt/java25 && tar -xzf /tmp/zulu25.tar.gz -C /opt/java25 --strip-components=1 \
    && rm /tmp/zulu25.tar.gz
ARG KOTLIN_LSP_URL=https://download-cdn.jetbrains.com/language-server/kotlin-server/262.9593.0/kotlin-server-0.0.6-linux-amd64.vsix
RUN wget -qO /tmp/klsp.vsix ${KOTLIN_LSP_URL} \
    && mkdir -p /opt/kotlin-lsp && unzip -q /tmp/klsp.vsix 'extension/server/*' -d /opt/kotlin-lsp \
    && rm /tmp/klsp.vsix \
    && rm -rf /opt/kotlin-lsp/extension/server/jbr \
    && python3 -c "$(printf '%s\n' \
        "import json" \
        "p = json.load(open('/opt/kotlin-lsp/extension/server/product-info.json'))" \
        "lc = p['launch'][0]" \
        "ide = '/opt/kotlin-lsp/extension/server'" \
        "cp = ':'.join(ide + '/lib/' + j for j in lc['bootClassPathJarNames'])" \
        "args = ' '.join(chr(34) + a.replace('\$IDE_HOME', ide) + chr(34) for a in lc['additionalJvmArguments'])" \
        "s = '#!/bin/sh\nexec /opt/java25/bin/java -Xmx1024m ' + args + ' -cp ' + chr(34) + cp + chr(34) + ' ' + lc['mainClass'] + ' ' + chr(34) + chr(36) + '@' + chr(34) + '\n'" \
        "open('/usr/local/bin/kotlin-lsp', 'w').write(s)" \
    )" \
    && chmod +x /usr/local/bin/kotlin-lsp \
    && sh -n /usr/local/bin/kotlin-lsp

# Install Claude CLI via npm (global prefix under node user's home)
ENV NPM_CONFIG_PREFIX=/home/node/.local
ARG CLAUDE_CLI_VERSION=latest
RUN mkdir -p /home/node/.local && chown node:node /home/node/.local \
    && su-exec node npm install -g @anthropic-ai/claude-code@${CLAUDE_CLI_VERSION} \
    && su-exec node npm install -g typescript @vtsls/language-server \
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
