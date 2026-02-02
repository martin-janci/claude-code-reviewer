#!/bin/sh
# Ensure /home/.claude and /home/node/.claude point to the same location.
# The base image uses HOME=/home (credentials at /home/.claude/), but the
# node user's HOME is /home/node. Symlink so both paths work.
if [ -d /home/node/.claude ] && [ ! -e /home/.claude ]; then
  ln -s /home/node/.claude /home/.claude
elif [ -d /home/.claude ] && [ ! -e /home/node/.claude ]; then
  ln -s /home/.claude /home/node/.claude
fi

# Fix ownership on volumes that may be mounted as root.
# On some filesystems (e.g. Synology NAS), chown silently fails on bind mounts,
# so we also mkdir + chmod the dirs Claude CLI needs at runtime.
for claude_dir in /home/node/.claude /home/.claude; do
  [ -d "$claude_dir" ] || continue
  chown -R node:node "$claude_dir" 2>/dev/null || true
  for sub in debug todos projects statsig; do
    mkdir -p "$claude_dir/$sub"
    chmod 777 "$claude_dir/$sub" 2>/dev/null || true
  done
  chmod 777 "$claude_dir" 2>/dev/null || true
done
chown -R node:node /app/data 2>/dev/null || true

# Configure git
su-exec node git config --global advice.detachedHead false

# Configure git to use gh CLI for GitHub authentication
if command -v gh >/dev/null 2>&1; then
  su-exec node sh -c 'gh auth setup-git 2>/dev/null || true'
fi

# Drop to node user and start the app
exec su-exec node node dist/index.js "$@"
