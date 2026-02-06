# Docker Registry Migration

## Overview

This document describes the migration from `registry.rlt.sk` to GitHub Container Registry (`ghcr.io/papayapos`).

## Changes

### Before
```yaml
image: registry.rlt.sk/claude-code-reviewer:latest
```

### After
```yaml
image: ghcr.io/papayapos/claude-code-reviewer:latest
```

## Benefits

1. **Public Access** - No authentication required for pulling images
2. **Multi-Architecture** - Automated builds for amd64 and arm64
3. **CI/CD Integration** - Direct integration with GitHub Actions
4. **Version Tags** - Semantic versioning support (v1, v1.15, v1.15.0)
5. **Transparency** - Public visibility of all image versions

## Migration Path

### For Existing Deployments

If you're currently using `registry.rlt.sk`, you can migrate gradually:

1. **Test Phase** - Deploy to a test namespace with new registry
   ```bash
   kubectl create namespace claude-reviewer-test
   # Update kustomization to use test namespace
   kubectl apply -k k8s/
   ```

2. **Verify** - Ensure the new image works correctly
   ```bash
   kubectl get pods -n claude-reviewer-test
   kubectl logs -n claude-reviewer-test deployment/claude-reviewer
   ```

3. **Production Migration** - Update existing deployment
   ```bash
   kubectl set image deployment/claude-reviewer \
     reviewer=ghcr.io/papayapos/claude-code-reviewer:latest \
     -n claude-reviewer
   ```

4. **Verify Rolling Update**
   ```bash
   kubectl rollout status deployment/claude-reviewer -n claude-reviewer
   ```

### Rollback Plan

If issues occur with the new registry:

```bash
kubectl set image deployment/claude-reviewer \
  reviewer=registry.rlt.sk/claude-code-reviewer:latest \
  -n claude-reviewer
```

## Authentication

### Public Images (Current)

No authentication required:
```bash
docker pull ghcr.io/papayapos/claude-code-reviewer:latest
```

### Private Images (If Needed)

If images become private in the future:

1. Create GitHub Personal Access Token with `read:packages` scope
2. Create Kubernetes secret:
   ```bash
   kubectl create secret docker-registry ghcr-secret \
     --docker-server=ghcr.io \
     --docker-username=YOUR_GITHUB_USERNAME \
     --docker-password=YOUR_GITHUB_TOKEN \
     -n claude-reviewer
   ```

3. Add to deployment:
   ```yaml
   spec:
     imagePullSecrets:
     - name: ghcr-secret
   ```

## Available Tags

- `latest` - Latest build from main branch
- `v1.15.0` - Specific version (semantic versioning)
- `v1.15` - Major.minor version (auto-updated)
- `v1` - Major version (auto-updated)
- `main` - Latest main branch build
- `main-<sha>` - Specific commit from main

## Registry Comparison

| Feature | registry.rlt.sk | ghcr.io/papayapos |
|---------|-----------------|-------------------|
| Access | Private (VPN/auth required) | Public |
| Multi-arch | Single arch | amd64 + arm64 |
| Versioning | Manual | Automated (semver) |
| CI/CD | Manual push | GitHub Actions |
| Availability | Internal only | Global CDN |
| Cost | Infrastructure cost | Free (public repos) |

## References

- [GitHub Container Registry Documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [Multi-platform Docker Builds](.github/workflows/docker.yml)
