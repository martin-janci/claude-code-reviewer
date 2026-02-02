#!/bin/sh
# Configure git to use gh CLI for GitHub authentication
if command -v gh >/dev/null 2>&1; then
  gh auth setup-git 2>/dev/null || true
fi
exec node dist/index.js "$@"
