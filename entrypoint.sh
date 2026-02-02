#!/bin/sh
# Ensure /home/node/.claude exists as a real writable directory
mkdir -p /home/node/.claude
for sub in debug todos projects statsig; do
  mkdir -p "/home/node/.claude/$sub"
done

# Copy credentials from wherever they exist (root login stores at /root/.claude)
for candidate in /root/.claude /home/.claude; do
  if [ -f "$candidate/.credentials.json" ] && [ ! -f /home/node/.claude/.credentials.json ]; then
    echo "Copying credentials from $candidate to /home/node/.claude"
    cp -a "$candidate/.credentials.json" /home/node/.claude/.credentials.json
  fi
done

# Fix ownership — must come after copy/mkdir
chown -R node:node /home/node/.claude 2>/dev/null || true
chmod -R 777 /home/node/.claude 2>/dev/null || true
chown -R node:node /app/data 2>/dev/null || true

# Symlink so root's claude also sees the same dir (for manual exec debugging)
if [ ! -L /root/.claude ] && [ -d /root/.claude ]; then
  rm -rf /root/.claude
fi
ln -sf /home/node/.claude /root/.claude 2>/dev/null || true

# Configure git
su-exec node git config --global advice.detachedHead false

# Configure git to use gh CLI for GitHub authentication
if command -v gh >/dev/null 2>&1; then
  su-exec node sh -c 'gh auth setup-git 2>/dev/null || true'
fi

# Drop to node user and start the app
exec su-exec node node dist/index.js "$@"
