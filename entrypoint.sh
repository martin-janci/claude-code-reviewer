#!/bin/sh
set -e

# Ensure required subdirectories exist in .claude
for sub in debug todos projects statsig; do
  mkdir -p "/home/node/.claude/$sub" 2>/dev/null || true
done

# Fix ownership if needed
chown -R node:node /home/node/.claude 2>/dev/null || true
chown -R node:node /app/data 2>/dev/null || true

# Configure git for node user
su-exec node git config --global advice.detachedHead false

# Configure git to use gh CLI for GitHub authentication
if command -v gh >/dev/null 2>&1; then
  su-exec node sh -c 'gh auth setup-git 2>/dev/null || true'
fi

# Drop to node user and start the app
exec su-exec node node dist/index.js "$@"
