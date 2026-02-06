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
- ✅ Build stage: `node:20-alpine` → `dhi.io/node:20-alpine3.21`
- ✅ Kubernetes manifests: Updated to use `ghcr.io/papayapos/claude-code-reviewer`
- ✅ PodMonitor: Added for future Prometheus integration (currently commented out)

### Pending
- ⏳ Node 24 upgrade: Requires compatibility testing before migration
  - Current: Node 20 LTS (support until April 2026)
  - Target: `dhi.io/node:24-alpine3.23-dev` (support until April 2028)
  - Needs: Testing of dependencies and runtime compatibility
- ⏳ Runtime stage: Still using `registry.rlt.sk/claude-code-custom:latest`
  - Needs evaluation of custom image requirements
  - Consider migrating to `dhi.io/node:20-alpine3.21` + separate Claude CLI setup

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
FROM dhi.io/node:20-alpine3.21 AS build
```

This maintains compatibility with the current Node 20 runtime while gaining DHI security benefits.

### For Runtime Stage (Future Work)

Current runtime stage uses a custom base image with Claude CLI pre-installed. To fully migrate to DHI:

1. Evaluate custom image dependencies:
   - Claude CLI installation
   - GitHub CLI (gh)
   - Git
   - Other custom configurations

2. Option A: Migrate to DHI base + install tools
   ```dockerfile
   FROM dhi.io/node:20-alpine3.21
   RUN apk add --no-cache github-cli git
   # Add Claude CLI installation steps
   ```

3. Option B: Keep custom base but rebuild from DHI
   - Rebuild `claude-code-custom` image using `dhi.io/node:20-alpine3.21`
   - Maintain custom tooling layer

4. Option C (Future): Upgrade to Node 24 after testing
   - Test all dependencies with Node 24
   - Verify runtime compatibility
   - Then migrate to `dhi.io/node:24-alpine3.23-dev`

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
