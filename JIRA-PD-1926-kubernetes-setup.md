# Claude Code PR Reviewer - Kubernetes Deployment

## Overview

Claude Code PR Reviewer is now fully deployable to Kubernetes with production-ready manifests. This includes automated PR reviews with full codebase access, autofix capabilities, Jira integration, and comprehensive audit logging.

## Quick Start

### 1. Prerequisites

- Kubernetes cluster (v1.25+)
- `kubectl` configured with cluster access
- GitHub Personal Access Token with `repo` and `read:org` permissions
- Claude CLI authenticated (credentials will be mounted as Secret)

### 2. Deployment Steps

```bash
# Clone repository
git clone https://github.com/martin-janci/claude-code-reviewer.git
cd claude-code-reviewer/k8s

# Configure secrets
nano secret.yaml
# Add your GITHUB_TOKEN and WEBHOOK_SECRET

# Configure repositories to review
nano configmap.yaml
# Update repos section with your GitHub org/repos

# Deploy all resources
kubectl apply -f namespace.yaml
kubectl apply -f secret.yaml
kubectl apply -f configmap.yaml
kubectl apply -f pvc.yaml
kubectl apply -f deployment.yaml
kubectl apply -f service.yaml
kubectl apply -f ingress.yaml

# Verify deployment
kubectl get pods -n claude-reviewer
kubectl logs -n claude-reviewer -l app=claude-reviewer -f
```

### 3. Health Check

```bash
kubectl port-forward -n claude-reviewer svc/claude-reviewer 3000:3000
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "ok",
  "version": "<current-version>",
  "uptime": 123,
  "settings": {
    "mode": "webhook",
    "repos": ["your-org/your-repo"]
  },
  "auth": {
    "claude": {"available": true, "authenticated": true},
    "github": {"available": true, "authenticated": true}
  }
}
```

## Architecture

### Resources Created

| Resource | Namespace | Purpose |
|----------|-----------|---------|
| `Namespace` | claude-reviewer | Isolated namespace for all resources |
| `Secret` | claude-reviewer | GitHub token, webhook secret, optional Jira/Slack credentials |
| `ConfigMap` | claude-reviewer | Application configuration (repos, review settings, features) |
| `PersistentVolumeClaim` | claude-reviewer | 10Gi storage for clones, state, and audit logs |
| `Deployment` | claude-reviewer | Single-replica deployment with health checks |
| `Service` | claude-reviewer | ClusterIP service on port 3000 |
| `Ingress` | claude-reviewer | NGINX ingress for webhook endpoint |

### Deployment Configuration

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: claude-reviewer
  namespace: claude-reviewer
spec:
  replicas: 1  # Single replica to avoid state conflicts
  strategy:
    type: Recreate  # Ensure only one pod at a time
  template:
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      containers:
      - name: reviewer
        image: registry.rlt.sk/claude-code-reviewer:latest
        imagePullPolicy: Always
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: false  # Needs write for /tmp and node_modules
          capabilities:
            drop: ["ALL"]
        resources:
          requests:
            memory: "512Mi"
            cpu: "250m"
            ephemeral-storage: "1Gi"
          limits:
            memory: "2Gi"
            cpu: "1000m"
            ephemeral-storage: "5Gi"
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 30
          timeoutSeconds: 5
          failureThreshold: 5
        readinessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 10
```

**Key Design Decisions:**
- **Single replica** - State persistence via JSON file requires exclusive access
- **Recreate strategy** - Prevents concurrent pods modifying state
- **PVC mount** - Data persists across pod restarts
- **Health checks** - High `failureThreshold` (5) prevents restarts during long reviews
- **Security context** - Non-root, no privilege escalation, all capabilities dropped
- **`imagePullPolicy: Always`** - Ensures `:latest` tag always pulls the newest image

### Volume Mounts

```yaml
volumeMounts:
  - name: config
    mountPath: /app/config.yaml
    subPath: config.yaml
    readOnly: true
  - name: data
    mountPath: /app/data  # State, clones, audit logs
  - name: claude-config
    mountPath: /home/node/.claude  # Claude auth credentials
    readOnly: true
```

### Storage

**PersistentVolumeClaim**: 10Gi storage for:
- `/app/data/state.json` - PR state tracking
- `/app/data/clones/` - Bare git clones + worktrees
- `/app/data/audit.json` - Audit log entries

**Adjust size based on:**
- Number of repositories (each repo needs ~100-500MB)
- Clone depth and repo size
- Audit log retention

## Configuration

### ConfigMap (config.yaml)

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: claude-reviewer-config
  namespace: claude-reviewer
data:
  config.yaml: |
    mode: webhook  # "polling" | "webhook" | "both"

    webhook:
      port: 3000
      path: /webhook

    repos:
      - owner: your-org
        repo: your-repo
      # Add more repos here

    review:
      maxDiffLines: 5000
      skipDrafts: true
      skipWip: true
      codebaseAccess: true
      cloneDir: data/clones
      reviewTimeoutMs: 600000  # 10 minutes
      reviewMaxTurns: 30
      maxConcurrentReviews: 3
      dryRun: false

    features:
      jira:
        enabled: true
        baseUrl: "https://your-org.atlassian.net"
        projectKeys: ["PROJ", "PD"]

      autofix:
        enabled: true
        commandTrigger: "^\\s*/fix\\s*$"
        autoApply: false  # Creates autofix/pr-N branch
        maxTurns: 10

      audit:
        enabled: true
        maxEntries: 10000
        filePath: data/audit.json

      slack:
        enabled: false
        notifyOn:
          - error
          - request_changes
```

### Secret (Credentials)

> **WARNING:** Never commit secret.yaml with real credentials to version control.
> Consider using [Sealed Secrets](https://github.com/bitnami-labs/sealed-secrets),
> [External Secrets Operator](https://external-secrets.io/), or create secrets imperatively:
> ```bash
> kubectl create secret generic claude-reviewer-secrets -n claude-reviewer \
>   --from-literal=GITHUB_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxx" \
>   --from-literal=WEBHOOK_SECRET="$(openssl rand -hex 32)"
> ```

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: claude-reviewer-secrets
  namespace: claude-reviewer
type: Opaque
stringData:
  GITHUB_TOKEN: "ghp_xxxxxxxxxxxxxxxxxxxx"
  WEBHOOK_SECRET: "generate_with_openssl_rand_hex_32"

  # Optional: Jira integration
  JIRA_TOKEN: "your_jira_api_token"
  JIRA_EMAIL: "your.email@example.com"

  # Optional: Slack notifications
  SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/YOUR/WEBHOOK/URL"
```

**Generate webhook secret:**
```bash
openssl rand -hex 32
```

### Ingress (GitHub Webhooks)

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: claude-reviewer
  namespace: claude-reviewer
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - claude-reviewer.your-domain.com
    secretName: claude-reviewer-tls
  rules:
  - host: claude-reviewer.your-domain.com
    http:
      paths:
      - path: /webhook
        pathType: Exact
        backend:
          service:
            name: claude-reviewer
            port:
              number: 3000
```

## GitHub Webhook Setup

1. Go to each repository → **Settings** → **Webhooks** → **Add webhook**
2. Configure:
   - **Payload URL**: `https://claude-reviewer.your-domain.com/webhook`
   - **Content type**: `application/json`
   - **Secret**: Your `WEBHOOK_SECRET` from the Secret
   - **Events**: Pull requests, Issue comments, Pushes
3. Save and verify delivery in webhook settings

## Features

### Core Review Features
✅ **Automatic PR Review** - Reviews new and updated PRs via webhooks or polling
✅ **Full Codebase Access** - Claude explores entire repository, not just diff
✅ **Inline Comments** - Posts comments on specific lines in "Files changed" tab
✅ **Conventional Comments** - Uses standard labels (issue, suggestion, nitpick, question, praise)
✅ **Manual Trigger** - Post `/review` comment to force re-review
✅ **Review Verification** - Detects deleted/dismissed reviews and re-queues

### Optional Features (Enable in ConfigMap)
🔧 **Autofix** - `/fix` command to automatically apply fixes to review findings
🎯 **Jira Integration** - Extracts and validates Jira issue keys from PR titles/branches
📝 **Auto-Description** - Generates PR descriptions from diffs using Claude
🏷️ **Auto-Labeling** - Applies labels based on review verdict, severity, and file paths
💬 **Slack Notifications** - Sends notifications for review events
📊 **Audit Logging** - Comprehensive operational audit trail

## Operations

### View Logs
```bash
kubectl logs -n claude-reviewer -l app=claude-reviewer -f
```

### Check Health
```bash
kubectl get pods -n claude-reviewer
kubectl exec -n claude-reviewer deploy/claude-reviewer -- curl localhost:3000/health
```

### View Metrics
```bash
kubectl exec -n claude-reviewer deploy/claude-reviewer -- curl localhost:3000/metrics
```

### Restart Deployment
```bash
kubectl rollout restart deployment/claude-reviewer -n claude-reviewer
kubectl rollout status deployment/claude-reviewer -n claude-reviewer
```

### Scale (Not Recommended)
```bash
# WARNING: Only run 1 replica to avoid state conflicts
kubectl scale deployment/claude-reviewer --replicas=1 -n claude-reviewer
```

### Update Configuration
```bash
# Edit ConfigMap
kubectl edit configmap/claude-reviewer-config -n claude-reviewer

# Restart to apply changes
kubectl rollout restart deployment/claude-reviewer -n claude-reviewer
```

### Check Storage Usage
```bash
kubectl exec -n claude-reviewer deploy/claude-reviewer -- df -h /app/data
kubectl exec -n claude-reviewer deploy/claude-reviewer -- du -sh /app/data/*
```

## Troubleshooting

### Pod Not Starting
```bash
kubectl describe pod -n claude-reviewer -l app=claude-reviewer
kubectl logs -n claude-reviewer -l app=claude-reviewer
```

Common issues:
- Missing Secret or ConfigMap
- Invalid image pull (check registry access)
- PVC not bound (check storage class)

### Authentication Failures
```bash
# Check GitHub token
kubectl exec -n claude-reviewer deploy/claude-reviewer -- gh auth status

# Check Claude CLI
kubectl exec -n claude-reviewer deploy/claude-reviewer -- claude --version
```

### Webhook Not Receiving Events
1. Check ingress is routing correctly:
```bash
kubectl get ingress -n claude-reviewer
curl https://claude-reviewer.your-domain.com/health
```

2. Check GitHub webhook delivery logs in repo settings
3. Verify webhook secret matches Secret resource

### Out of Memory
Increase resource limits:
```yaml
resources:
  limits:
    memory: "4Gi"
```

### Disk Full
1. Check disk usage:
```bash
kubectl exec -n claude-reviewer deploy/claude-reviewer -- du -sh /app/data/*
```

2. Increase PVC size:
```bash
kubectl patch pvc claude-reviewer-data -n claude-reviewer -p '{"spec":{"resources":{"requests":{"storage":"20Gi"}}}}'
```

3. Clean up old clones (all repos will be re-cloned on next review, increasing initial latency):
```bash
kubectl exec -n claude-reviewer deploy/claude-reviewer -- rm -rf /app/data/clones/*
```

## Monitoring

### Prometheus Integration

The `/metrics` endpoint exposes:
- Review counts (total, success, error)
- Average review time
- PR status distribution
- Error rates by phase

Example ServiceMonitor (ensure the `port` name matches the Service port name):
```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: claude-reviewer
  namespace: claude-reviewer
spec:
  selector:
    matchLabels:
      app: claude-reviewer
  endpoints:
  - port: http  # Must match the named port in your Service spec
    path: /metrics
    interval: 30s
```

### Grafana Dashboard

Key metrics to monitor:
- Review success rate
- Average review duration
- Queue depth (pending_review PRs)
- Error frequency by phase
- Disk usage trends

## Security

### Network Policies

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: claude-reviewer
  namespace: claude-reviewer
spec:
  podSelector:
    matchLabels:
      app: claude-reviewer
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          name: ingress-nginx
    ports:
    - port: 3000
  egress:
  - ports:
    - port: 443    # HTTPS to GitHub/Claude APIs
      protocol: TCP
  - ports:
    - port: 53     # DNS
      protocol: UDP
    - port: 53
      protocol: TCP
```

### RBAC (Optional)

If using service accounts (secrets are mounted as volumes, so no API access needed):
```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: claude-reviewer
  namespace: claude-reviewer
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: claude-reviewer
  namespace: claude-reviewer
rules:
- apiGroups: [""]
  resources: ["configmaps"]
  verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: claude-reviewer
  namespace: claude-reviewer
subjects:
- kind: ServiceAccount
  name: claude-reviewer
roleRef:
  kind: Role
  name: claude-reviewer
  apiGroup: rbac.authorization.k8s.io
```

## Backup and Restore

### Backup State
```bash
POD=$(kubectl get pod -n claude-reviewer -l app=claude-reviewer -o jsonpath='{.items[0].metadata.name}')
kubectl cp claude-reviewer/$POD:/app/data/state.json ./state-backup.json
kubectl cp claude-reviewer/$POD:/app/data/audit.json ./audit-backup.json
```

### Restore State
```bash
POD=$(kubectl get pod -n claude-reviewer -l app=claude-reviewer -o jsonpath='{.items[0].metadata.name}')
kubectl cp ./state-backup.json claude-reviewer/$POD:/app/data/state.json
kubectl rollout restart deployment/claude-reviewer -n claude-reviewer
```

## Upgrading

### Update to Latest Version
```bash
# Edit deployment to use new image tag
kubectl set image deployment/claude-reviewer reviewer=registry.rlt.sk/claude-code-reviewer:<VERSION> -n claude-reviewer

# Monitor rollout
kubectl rollout status deployment/claude-reviewer -n claude-reviewer

# Check logs
kubectl logs -n claude-reviewer -l app=claude-reviewer -f
```

### Rollback
```bash
kubectl rollout undo deployment/claude-reviewer -n claude-reviewer
kubectl rollout status deployment/claude-reviewer -n claude-reviewer
```

## Documentation

- **Complete Setup Guide**: [SETUP.md](https://github.com/martin-janci/claude-code-reviewer/blob/main/SETUP.md)
- **Kubernetes README**: [k8s/README.md](https://github.com/martin-janci/claude-code-reviewer/blob/main/k8s/README.md)
- **Main README**: [README.md](https://github.com/martin-janci/claude-code-reviewer/blob/main/README.md)
- **Configuration Reference**: [config.yaml.example](https://github.com/martin-janci/claude-code-reviewer/blob/main/config.yaml.example)

## Support

- **GitHub Issues**: https://github.com/martin-janci/claude-code-reviewer/issues
- **Repository**: https://github.com/martin-janci/claude-code-reviewer
- **Docker Image**: registry.rlt.sk/claude-code-reviewer:latest
