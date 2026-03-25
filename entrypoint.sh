#!/bin/sh
set -e

# Add Claude CLI to PATH
export PATH="/home/node/.local/bin:$PATH"

# --- PVC initialization ---
# If .claude is empty or missing key content (fresh PVC mount), seed from baked-in defaults
if [ ! -f "/home/node/.claude/.seeded" ]; then
  echo "[entrypoint] Empty .claude detected — seeding from defaults..."
  cp -a /home/node/.claude-defaults/. /home/node/.claude/
  touch /home/node/.claude/.seeded
fi

# Ensure required subdirectories exist in .claude
for sub in debug todos projects statsig; do
  mkdir -p "/home/node/.claude/$sub" 2>/dev/null || true
done

# Fix ownership if needed
chown -R node:node /home/node/.claude 2>/dev/null || true
chown -R node:node /app/data 2>/dev/null || true

# --- Claude CLI auto-update ---
if [ "${CLAUDE_AUTO_UPDATE}" = "true" ]; then
  BEFORE=$(su-exec node claude --version 2>/dev/null || echo "unknown")
  echo "[entrypoint] Auto-update enabled — updating Claude CLI (current: ${BEFORE})..."
  if su-exec node npm install -g @anthropic-ai/claude-code 2>&1; then
    AFTER=$(su-exec node claude --version 2>/dev/null || echo "unknown")
    echo "[entrypoint] Claude CLI updated: ${BEFORE} -> ${AFTER}"
  else
    echo "[entrypoint] WARNING: Claude CLI update failed, continuing with existing version"
  fi
fi

# --- Persist .claude.json inside the volume via symlink ---
# Claude CLI writes to /home/node/.claude.json but that's outside the volume.
# Symlink it into the volume so it survives container restarts.
if [ -f "/home/node/.claude/.claude.json" ] && [ ! -L "/home/node/.claude.json" ]; then
  # Volume has a saved copy, create symlink
  rm -f /home/node/.claude.json
  ln -s /home/node/.claude/.claude.json /home/node/.claude.json
  echo "[entrypoint] Symlinked .claude.json from volume"
elif [ ! -e "/home/node/.claude/.claude.json" ]; then
  # First run or fresh volume — restore from backup if available, then symlink
  LATEST_BACKUP=$(ls -t /home/node/.claude/backups/.claude.json.backup.* 2>/dev/null | head -1)
  if [ -n "$LATEST_BACKUP" ]; then
    cp "$LATEST_BACKUP" /home/node/.claude/.claude.json
    chown node:node /home/node/.claude/.claude.json
    echo "[entrypoint] Restored .claude.json from backup: $(basename "$LATEST_BACKUP")"
  fi
  rm -f /home/node/.claude.json
  ln -s /home/node/.claude/.claude.json /home/node/.claude.json
  echo "[entrypoint] Symlinked .claude.json into volume"
fi

# --- Version logging ---
echo "[entrypoint] Claude CLI version: $(su-exec node claude --version 2>/dev/null || echo 'not found')"

# Configure git for node user
su-exec node git config --global advice.detachedHead false

# Configure git to use gh CLI for GitHub authentication
if command -v gh >/dev/null 2>&1; then
  su-exec node sh -c 'gh auth setup-git 2>/dev/null || true'
fi

# Drop to node user and start the app
exec su-exec node node dist/index.js "$@"
