#!/bin/sh
# Discover where Claude credentials actually live.
# Possible locations: /root/.claude, /home/.claude, /home/node/.claude
CLAUDE_SRC=""
for candidate in /root/.claude /home/.claude /home/node/.claude; do
  if [ -f "$candidate/.credentials.json" ]; then
    CLAUDE_SRC="$candidate"
    break
  fi
done

# Determine the node user's HOME
NODE_HOME=$(su-exec node sh -c 'echo $HOME')
NODE_CLAUDE="$NODE_HOME/.claude"

# If credentials exist but not where the node user expects, symlink
if [ -n "$CLAUDE_SRC" ] && [ "$CLAUDE_SRC" != "$NODE_CLAUDE" ]; then
  echo "Linking credentials: $CLAUDE_SRC -> $NODE_CLAUDE"
  rm -rf "$NODE_CLAUDE" 2>/dev/null || true
  ln -sf "$CLAUDE_SRC" "$NODE_CLAUDE"
fi

# Fix ownership on volumes that may be mounted as root.
# On some filesystems (e.g. Synology NAS), chown silently fails on bind mounts,
# so we also mkdir + chmod the dirs Claude CLI needs at runtime.
for claude_dir in "$NODE_CLAUDE" "$CLAUDE_SRC"; do
  [ -n "$claude_dir" ] && [ -d "$claude_dir" ] || continue
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
