# Kubernetes Deployment Guide

This directory contains Kubernetes manifests for deploying Claude Code PR Reviewer.

## Prerequisites

- Kubernetes cluster (v1.19+)
- `kubectl` configured to access your cluster
- GitHub Personal Access Token with `repo` and `read:org` permissions
- Ingress controller (nginx, traefik, etc.) if using webhook mode
- Claude CLI authentication (if using Claude API)

## Quick Start

### 1. Create Namespace

```bash
kubectl apply -f k8s/namespace.yaml
```

### 2. Configure Secrets

Edit `k8s/secret.yaml` and add your credentials:

```bash
# Required
GITHUB_TOKEN=ghp_your_token_here
WEBHOOK_SECRET=$(openssl rand -hex 32)
```

Apply the secret:

```bash
kubectl apply -f k8s/secret.yaml
```

### 3. Configure Application

Edit `k8s/configmap.yaml`:

- Set your repositories in `repos` section
- Configure mode: `webhook`, `polling`, or `both`
- Enable features as needed (jira, autofix, slack, etc.)

Apply the config:

```bash
kubectl apply -f k8s/configmap.yaml
```

### 4. Create Storage

```bash
kubectl apply -f k8s/pvc.yaml
```

### 5. Deploy Application

```bash
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
```

### 6. Setup Ingress (Webhook Mode)

Edit `k8s/ingress.yaml`:

- Change `host` to your domain
- Configure TLS if needed
- Adjust ingress class and annotations

Apply ingress:

```bash
kubectl apply -f k8s/ingress.yaml
```

### 7. Configure GitHub Webhook

In your GitHub repository settings:

1. Go to **Settings** → **Webhooks** → **Add webhook**
2. **Payload URL**: `https://claude-reviewer.your-domain.com/webhook`
3. **Content type**: `application/json`
4. **Secret**: Use the same value as `WEBHOOK_SECRET`
5. **Events**: Select:
   - Pull requests
   - Issue comments
   - Pushes
6. **Active**: ✓
7. Click **Add webhook**

## Verify Deployment

### Check Pod Status

```bash
kubectl get pods -n claude-reviewer
```

Expected output:
```
NAME                              READY   STATUS    RESTARTS   AGE
claude-reviewer-xxxxxxxxx-xxxxx   1/1     Running   0          1m
```

### Check Logs

```bash
kubectl logs -n claude-reviewer -l app=claude-reviewer -f
```

You should see:
```
Claude Code PR Reviewer v1.13.0 starting
```

### Check Health

```bash
kubectl port-forward -n claude-reviewer svc/claude-reviewer 3000:3000
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "ok",
  "version": "1.13.0",
  "uptime": 123,
  "settings": { ... },
  "auth": { ... }
}
```

## Configuration Options

### Mode Selection

**Webhook Mode** (Recommended for production):
```yaml
mode: webhook
```
- Real-time review triggers
- Requires ingress and GitHub webhook
- Lower resource usage

**Polling Mode**:
```yaml
mode: polling
polling:
  intervalSeconds: 300
```
- No ingress needed
- Periodic PR scanning
- Higher resource usage

**Both Mode**:
```yaml
mode: both
```
- Combines webhook + polling
- Best reliability
- Highest resource usage

### Resource Sizing

**Small (1-3 repos)**:
```yaml
resources:
  requests:
    memory: "512Mi"
    cpu: "250m"
  limits:
    memory: "1Gi"
    cpu: "500m"
storage: 5Gi
```

**Medium (3-10 repos)**:
```yaml
resources:
  requests:
    memory: "1Gi"
    cpu: "500m"
  limits:
    memory: "2Gi"
    cpu: "1000m"
storage: 10Gi
```

**Large (10+ repos)**:
```yaml
resources:
  requests:
    memory: "2Gi"
    cpu: "1000m"
  limits:
    memory: "4Gi"
    cpu: "2000m"
storage: 20Gi
```

### Claude CLI Authentication

If you need Claude CLI authentication, create a secret with your `.claude` directory:

```bash
# From your local machine with authenticated claude CLI
kubectl create secret generic claude-reviewer-claude-config \
  --from-file=config.json=$HOME/.claude/config.json \
  -n claude-reviewer
```

## Features Configuration

### Enable Autofix

In `configmap.yaml`:

```yaml
features:
  autofix:
    enabled: true
    commandTrigger: "^\\s*/fix\\s*$"
    autoApply: false  # Safe: push to autofix/pr-N branch
    maxTurns: 10
    timeoutMs: 300000
```

### Enable Jira Integration

In `secret.yaml`:

```yaml
stringData:
  JIRA_TOKEN: "your_token"
  JIRA_EMAIL: "you@example.com"
  JIRA_BASE_URL: "https://your-org.atlassian.net"
```

In `configmap.yaml`:

```yaml
features:
  jira:
    enabled: true
    projectKeys: ["PROJ", "ENG"]
```

### Enable Slack Notifications

In `secret.yaml`:

```yaml
stringData:
  SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/YOUR/WEBHOOK/URL"
```

In `configmap.yaml`:

```yaml
features:
  slack:
    enabled: true
    notifyOn:
      - error
      - request_changes
```

## Troubleshooting

### Pod Won't Start

```bash
kubectl describe pod -n claude-reviewer -l app=claude-reviewer
kubectl logs -n claude-reviewer -l app=claude-reviewer
```

Common issues:
- Missing secrets
- Invalid config.yaml syntax
- Insufficient resources
- PVC not bound

### Health Check Failing

```bash
kubectl logs -n claude-reviewer -l app=claude-reviewer | grep -i error
```

Check:
- GitHub token validity
- Claude CLI authentication
- Network connectivity

### Webhook Not Working

```bash
# Check ingress
kubectl get ingress -n claude-reviewer

# Check service
kubectl get svc -n claude-reviewer

# Check endpoint
kubectl get endpoints -n claude-reviewer
```

Test webhook delivery in GitHub:
- Go to repository **Settings** → **Webhooks**
- Click on your webhook
- Check **Recent Deliveries**
- Should see 2xx responses

### Reviews Not Posting

Check logs:

```bash
kubectl logs -n claude-reviewer -l app=claude-reviewer | grep -i "review"
```

Common issues:
- Insufficient GitHub token permissions
- DRY_RUN mode enabled
- Rate limiting

## Updating

### Update to Latest Version

```bash
kubectl set image deployment/claude-reviewer \
  reviewer=registry.rlt.sk/claude-code-reviewer:latest \
  -n claude-reviewer

# Or edit deployment.yaml and apply
kubectl apply -f k8s/deployment.yaml
```

### Update Configuration

```bash
# Edit configmap.yaml
kubectl apply -f k8s/configmap.yaml

# Restart pods to pick up new config
kubectl rollout restart deployment/claude-reviewer -n claude-reviewer
```

### Update Secrets

```bash
# Edit secret.yaml
kubectl apply -f k8s/secret.yaml

# Restart pods
kubectl rollout restart deployment/claude-reviewer -n claude-reviewer
```

## Monitoring

### Check Metrics

```bash
kubectl port-forward -n claude-reviewer svc/claude-reviewer 3000:3000
curl http://localhost:3000/metrics
```

### Check Audit Log

```bash
kubectl exec -n claude-reviewer -it \
  $(kubectl get pod -n claude-reviewer -l app=claude-reviewer -o name) \
  -- cat /app/data/audit.json | tail -100
```

### Export Logs

```bash
kubectl logs -n claude-reviewer -l app=claude-reviewer --since=24h > reviewer.log
```

## Scaling Considerations

⚠️ **Important**: Keep `replicas: 1` in the deployment.

The application uses:
- File-based state storage (`state.json`)
- File-based audit logs
- Git worktrees for PR reviews

Running multiple replicas will cause:
- State corruption
- Duplicate reviews
- Race conditions

For high availability, use:
- PVC with `ReadWriteOnce` access mode
- `strategy: type: Recreate` (prevents multiple pods)
- Backup/restore of PVC data

## Backup

### Backup State and Data

```bash
kubectl exec -n claude-reviewer \
  $(kubectl get pod -n claude-reviewer -l app=claude-reviewer -o name) \
  -- tar czf - /app/data | cat > backup-$(date +%Y%m%d).tar.gz
```

### Restore from Backup

```bash
kubectl exec -n claude-reviewer -i \
  $(kubectl get pod -n claude-reviewer -l app=claude-reviewer -o name) \
  -- tar xzf - -C / < backup-20260203.tar.gz

kubectl rollout restart deployment/claude-reviewer -n claude-reviewer
```

## Security Best Practices

1. **Secrets Management**: Use a secrets manager (Vault, Sealed Secrets, External Secrets Operator)
2. **RBAC**: Limit pod permissions with ServiceAccount + Role
3. **Network Policies**: Restrict pod network access
4. **Pod Security**: Use PodSecurityPolicy or Pod Security Standards
5. **Image Scanning**: Scan images for vulnerabilities
6. **TLS**: Always use HTTPS for webhook ingress
7. **Webhook Secret**: Use strong random secret (32+ characters)

## Support

For issues, see:
- GitHub Issues: https://github.com/martin-janci/claude-code-reviewer/issues
- Main README: ../README.md
- Configuration Guide: ../config.yaml
