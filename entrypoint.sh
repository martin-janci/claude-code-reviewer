#!/bin/sh
# Fix ownership on volumes that may be mounted as root
chown -R node:node /home/node/.claude /app/data 2>/dev/null || true

# Configure git (as node user)
su-exec node git config --global advice.detachedHead false

# Configure git to use gh CLI for GitHub authentication
if command -v gh >/dev/null 2>&1; then
  su-exec node sh -c 'gh auth setup-git 2>/dev/null || true'
fi

# Drop to node user and start the app
exec su-exec node node dist/index.js "$@"
