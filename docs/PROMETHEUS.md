# Prometheus Monitoring Integration

## Overview

This document describes the Prometheus monitoring setup for Claude Code Reviewer.

## PodMonitor Configuration

A PodMonitor resource is provided for automatic metrics collection when using the Prometheus Operator.

### Configuration

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: claude-reviewer
  namespace: claude
  labels:
    app: claude-reviewer
    release: prometheus

⚠️ **IMPORTANT**: This PodMonitor is ready for deployment but commented out in kustomization.yaml.
The application does not yet expose a /metrics endpoint. Uncomment after implementing metrics.

spec:
  podMetricsEndpoints:
  - interval: 15s
    path: /metrics
    port: http
  selector:
    matchLabels:
      app: claude-reviewer
```

### Key Parameters

- **interval**: `15s` - Metrics are scraped every 15 seconds
- **path**: `/metrics` - Prometheus-compatible metrics endpoint
- **port**: `http` - Matches the container port name (3000)
- **release**: `prometheus` - Label used by Prometheus Operator for service discovery

## Deployment

### Using Kustomize (Recommended)

The PodMonitor is included in the kustomization.yaml:

```bash
kubectl apply -k k8s/
```

### Manual Deployment

```bash
kubectl apply -f k8s/podmonitor.yaml
```

## Metrics Endpoint

### Current Status

⚠️ **Not Yet Implemented** - The application does not currently expose a `/metrics` endpoint.

### Future Implementation

To add Prometheus metrics support:

1. Install `prom-client` dependency:
   ```bash
   npm install prom-client
   ```

2. Add metrics middleware to the webhook server (`src/webhook/server.ts`):
   ```typescript
   import { register, collectDefaultMetrics } from 'prom-client';

   // Collect default metrics (memory, CPU, etc.)
   collectDefaultMetrics({ prefix: 'claude_reviewer_' });

   // Add /metrics endpoint
   app.get('/metrics', async (req, res) => {
     res.set('Content-Type', register.contentType);
     res.send(await register.metrics());
   });
   ```

3. Add custom metrics for review operations:
   ```typescript
   import { Counter, Histogram } from 'prom-client';

   const reviewsTotal = new Counter({
     name: 'claude_reviewer_reviews_total',
     help: 'Total number of PR reviews',
     labelNames: ['status', 'verdict'],
   });

   const reviewDuration = new Histogram({
     name: 'claude_reviewer_review_duration_seconds',
     help: 'Duration of PR reviews',
     buckets: [1, 5, 10, 30, 60, 120, 300],
   });
   ```

## Recommended Metrics

### Application Metrics

- `claude_reviewer_reviews_total{status, verdict}` - Counter of reviews by status/verdict
- `claude_reviewer_review_duration_seconds` - Histogram of review durations
- `claude_reviewer_errors_total{phase}` - Counter of errors by phase
- `claude_reviewer_state_transitions_total{from, to}` - Counter of state transitions
- `claude_reviewer_clone_operations_total{operation}` - Counter of clone/worktree operations
- `claude_reviewer_webhook_events_total{event}` - Counter of webhook events received

### System Metrics (Default)

- `process_cpu_user_seconds_total` - CPU usage
- `process_resident_memory_bytes` - Memory usage
- `nodejs_heap_size_total_bytes` - Heap size
- `nodejs_eventloop_lag_seconds` - Event loop lag

## Grafana Dashboard

### Example Queries

**Review Success Rate:**
```promql
rate(claude_reviewer_reviews_total{status="reviewed"}[5m])
/
rate(claude_reviewer_reviews_total[5m])
```

**Average Review Duration:**
```promql
rate(claude_reviewer_review_duration_seconds_sum[5m])
/
rate(claude_reviewer_review_duration_seconds_count[5m])
```

**Error Rate by Phase:**
```promql
rate(claude_reviewer_errors_total[5m])
```

**Active PRs by Status:**
```promql
claude_reviewer_pr_status_gauge
```

## Alerting

### Recommended Alerts

**High Error Rate:**
```yaml
alert: HighReviewErrorRate
expr: rate(claude_reviewer_errors_total[5m]) > 0.1
for: 5m
annotations:
  summary: High error rate in Claude Code Reviewer
```

**Slow Reviews:**
```yaml
alert: SlowReviews
expr: |
  rate(claude_reviewer_review_duration_seconds_sum[5m])
  /
  rate(claude_reviewer_review_duration_seconds_count[5m]) > 300
for: 10m
annotations:
  summary: Reviews taking longer than 5 minutes on average
```

**Service Down:**
```yaml
alert: ClaudeReviewerDown
expr: up{job="claude-reviewer"} == 0
for: 2m
annotations:
  summary: Claude Code Reviewer is down
```

## Verification

### Check PodMonitor

```bash
kubectl get podmonitor -n claude
kubectl describe podmonitor claude-reviewer -n claude
```

### Check Prometheus Targets

1. Access Prometheus UI
2. Go to Status → Targets
3. Look for `podMonitor/claude/claude-reviewer/0`
4. Verify target is UP and being scraped

### Test Metrics Endpoint

```bash
kubectl port-forward -n claude svc/claude-reviewer 3000:3000
curl http://localhost:3000/metrics
```

## References

- [Prometheus Operator PodMonitor](https://github.com/prometheus-operator/prometheus-operator/blob/main/Documentation/design.md#podmonitor)
- [prom-client Documentation](https://github.com/siimon/prom-client)
- [Prometheus Best Practices](https://prometheus.io/docs/practices/naming/)
