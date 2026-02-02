#!/bin/sh
# Fix ownership on volumes that may be mounted as root.
# On some filesystems (e.g. Synology NAS), chown silently fails on bind mounts,
# so we also mkdir + chmod the dirs Claude CLI needs at runtime.
for claude_dir in /home/node/.claude /home/.claude; do
  if [ -d "$claude_dir" ]; then
    chown -R node:node "$claude_dir" 2>/dev/null || true
    for sub in debug todos projects statsig; do
      mkdir -p "$claude_dir/$sub"
      chmod 777 "$claude_dir/$sub" 2>/dev/null || true
    done
    chmod 777 "$claude_dir" 2>/dev/null || true
  fi
done
chown -R node:node /app/data 2>/dev/null || true

# Detect where Claude credentials live and set HOME accordingly.
# The base image default HOME is /home (credentials at /home/.claude/),
# but docker-compose may bind-mount to /home/node/.claude instead.
if [ -f /home/node/.claude/.credentials.json ]; then
  export HOME=/home/node
elif [ -f /home/.claude/.credentials.json ]; then
  export HOME=/home
fi

# Configure git
su-exec node git config --global advice.detachedHead false

# Configure git to use gh CLI for GitHub authentication
if command -v gh >/dev/null 2>&1; then
  su-exec node sh -c 'gh auth setup-git 2>/dev/null || true'
fi

# Drop to node user and start the app
exec su-exec node node dist/index.js "$@"
