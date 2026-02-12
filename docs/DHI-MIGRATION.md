# Docker Hardened Images (DHI) Migration Guide

## Overview

This document describes the migration from standard Docker Hub images to Docker Hardened Images (DHI).

## What is DHI?

Docker Hardened Images (dhi.io) is a Docker-operated service in the Google Cloud ecosystem that provides:

- **Automated security maintenance** - Continuous vulnerability scanning and patching
- **Lower latency** - Operated in Google ecosystem vs docker.io (AMER region only)
- **Extended support** - Node 24 LTS supported until April 2028
- **Enterprise-grade** - Similar to VMware Bitnami (now Broadcom, with uncertain future direction)

## Migration Status

### Completed
- ✅ Build stage: `node:20-alpine` → `dhi.io/node:20-alpine3.22-dev`
- ✅ Runtime stage: `registry.rlt.sk/claude-code-custom:latest` → `dhi.io/node:20-alpine3.22-dev` + Claude CLI via npm
- ✅ Kubernetes manifests: Updated to use `ghcr.io/papayapos/claude-code-reviewer`
- ✅ PodMonitor: Added for future Prometheus integration (currently commented out)
- ✅ Claude CLI: Installed via `npm install -g @anthropic-ai/claude-code` (no custom base image)
- ✅ PVC for `.claude`: Writable volume with init container for auth credential injection

### Pending
- ⏳ Node 24 upgrade: Requires compatibility testing before migration
  - Current: Node 20 LTS (support until April 2026)
  - Target: `dhi.io/node:24-alpine3.23-dev` (support until April 2028)
  - Needs: Testing of dependencies and runtime compatibility

## Prerequisites

To use DHI images, you need:

1. **Docker Hub Account** - Required to access dhi.io registry
2. **Authentication** - Login to dhi.io registry:
   ```bash
   docker login dhi.io
   ```

For more details, see: https://papayapos.atlassian.net/wiki/spaces/PTD/pages/689504266/Docker+recommendations+for+future

## Image Comparison

| Aspect | docker.io/node:20-alpine | dhi.io/node:20-alpine3.21 | dhi.io/node:24-alpine3.23-dev |
|--------|--------------------------|---------------------------|--------------------------------|
| Node version | 20.x | 20.x | 24.x (LTS) |
| Support until | 2026-04 | 2026-04 | 2028-04 |
| Security updates | Manual | Automated | Automated |
| Registry location | AMER only | Google Cloud (global) | Google Cloud (global) |
| Vulnerability scanning | Basic | Comprehensive | Comprehensive |

## Migration Steps

### For Build Stage (Already Done)

The build stage has been migrated to use DHI with Node 20:

```dockerfile
FROM dhi.io/node:20-alpine3.22-dev AS build
```

This maintains compatibility with the current Node 20 runtime while gaining DHI security benefits.

### For Runtime Stage (Completed)

The runtime stage now uses DHI base with Claude CLI installed via npm:

```dockerfile
FROM dhi.io/node:20-alpine3.22-dev
RUN apk add --no-cache github-cli git su-exec
ENV NPM_CONFIG_PREFIX=/home/node/.local
RUN mkdir -p /home/node/.local && chown node:node /home/node/.local \
    && su-exec node npm install -g @anthropic-ai/claude-code \
    && su-exec node npm cache clean --force
```

Key decisions:
- Claude CLI installed as `node` user (not root) under `/home/node/.local`
- Version pinnable via `ARG CLAUDE_CLI_VERSION=latest`
- Auto-update on startup via `CLAUDE_AUTO_UPDATE=true` env var
- Runtime update via dashboard API (`POST /api/claude/update`)
- `.claude` directory on a writable PVC (seeded from baked-in defaults on first boot)

## Kubernetes Considerations

The Kubernetes manifests have been updated to:
- Use `ghcr.io/papayapos/claude-code-reviewer` registry
- Add Prometheus PodMonitor for future metrics collection (currently commented out)
- Maintain `claude-reviewer` namespace for backward compatibility

## Rollback Plan

If issues occur with DHI images:

1. Revert Dockerfile:
   ```dockerfile
   FROM node:20-alpine AS build
   ```

2. Rebuild and redeploy

3. No compatibility issues expected (same Node 20 version)

## References

- [Docker Hardened Images Documentation](https://docs.docker.com/dhi/)
- [PapayaPOS Docker Recommendations](https://papayapos.atlassian.net/wiki/spaces/PTD/pages/689504266/Docker+recommendations+for+future)
- [Node.js Release Schedule](https://github.com/nodejs/release#release-schedule)
