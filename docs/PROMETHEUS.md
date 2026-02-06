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
  namespace: claude-reviewer
  labels:
    app: claude-reviewer
    release: prometheus
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

⚠️ **Status**: The PodMonitor is ready but commented out pending validation.

### Using Kustomize (After Validation)

The PodMonitor is commented out in `kustomization.yaml`. After validation, uncomment it:

```yaml
resources:
  # ...
  - podmonitor.yaml  # Uncomment this line
```

Then deploy:

```bash
kubectl apply -k k8s/
```

### Validation Steps

Before enabling in production:

1. Test endpoint: `curl http://localhost:3000/metrics`
2. Verify Prometheus format (# HELP, # TYPE lines)
3. Enable in staging/dev environment first
4. Monitor for 24 hours to ensure stability

### Manual Deployment

```bash
kubectl apply -f k8s/podmonitor.yaml
```

## Metrics Endpoint

### Current Status

✅ **Implemented** - The `/metrics` endpoint is now available in Prometheus text format.

### Format Support

The endpoint supports both formats based on the `Accept` header or `format` query parameter:

**Prometheus format** (default):
```bash
curl http://localhost:3000/metrics
# or
curl -H "Accept: text/plain" http://localhost:3000/metrics
```

**JSON format** (for debugging):
```bash
curl http://localhost:3000/metrics?format=json
# or
curl -H "Accept: application/json" http://localhost:3000/metrics
```

### Implementation Details

The application uses `prom-client` to export metrics in Prometheus text format. The `PrometheusExporter` class (in `src/prometheus.ts`) converts internal JSON metrics to Prometheus format.

**Metrics Approach:**
- Uses **Gauges** for cumulative values (reviews_total, errors_total, skips_total)
- Syncs metrics from snapshot state on each `/metrics` request
- This is correct for state-based (vs event-based) metric collection

**Important:** To get rates from gauges, use `rate()` or `irate()` in PromQL:
```promql
rate(claude_reviewer_reviews_total[5m])  # Reviews per second
```

Default Node.js metrics are automatically collected:
- `process_cpu_user_seconds_total` - CPU usage
- `process_resident_memory_bytes` - Memory usage
- `nodejs_heap_size_total_bytes` - Heap size
- `nodejs_eventloop_lag_seconds` - Event loop lag

## Recommended Metrics

### Application Metrics

- `claude_reviewer_reviews_total{verdict}` - Gauge of total reviews by verdict (use rate() for rates)
- `claude_reviewer_errors_total{phase}` - Gauge of total errors by phase
- `claude_reviewer_skips_total{reason}` - Gauge of total skips by reason
- `claude_reviewer_prs{status}` - Gauge of current PRs by status
- `claude_reviewer_active_reviews` - Gauge of reviews in progress
- `claude_reviewer_queue_depth` - Gauge of PRs waiting for review
- `claude_reviewer_review_duration_avg_seconds{phase}` - Gauge of average duration
- `claude_reviewer_review_duration_p95_seconds{phase}` - Gauge of p95 duration
- `claude_reviewer_review_duration_max_seconds{phase}` - Gauge of max duration

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
