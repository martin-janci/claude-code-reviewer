# Grafana Dashboard Setup

## Overview

This guide explains how to set up Grafana dashboards for visualizing Claude Code Reviewer metrics collected by Prometheus.

## Prerequisites

- Prometheus with PodMonitor configured (see [PROMETHEUS.md](PROMETHEUS.md))
- Grafana instance connected to Prometheus as a data source
- Claude Code Reviewer deployed and exposing `/metrics` endpoint

## Quick Start

### Import Pre-Built Dashboard

1. Open Grafana UI
2. Navigate to **Dashboards** → **Import**
3. Upload `k8s/grafana-dashboard.json`
4. Select your Prometheus data source
5. Click **Import**

The dashboard will be immediately available with all panels configured.

## Dashboard Panels

### Overview Metrics

**1. Total Reviews**
- Single stat showing cumulative review count
- Query: `sum(claude_reviewer_reviews_total)`

**2. Review Rate by Verdict**
- Time series showing reviews per second by verdict (approve, comment, request_changes)
- Query: `rate(claude_reviewer_reviews_total[5m])`

### PR Status

**3. PRs by Status**
- Pie chart showing distribution of PRs across states
- Query: `claude_reviewer_prs`
- States: pending_review, reviewing, reviewed, error, closed, merged

**4. Active Reviews**
- Gauge showing number of reviews currently in progress
- Query: `claude_reviewer_active_reviews`
- Thresholds: Green (0-4), Yellow (5-9), Red (10+)

**5. Queue Depth**
- Gauge showing number of PRs waiting for review
- Query: `claude_reviewer_queue_depth`
- Thresholds: Green (0-9), Yellow (10-19), Red (20+)

### Performance Metrics

**6. Error Rate by Phase**
- Time series showing error rate per phase
- Query: `rate(claude_reviewer_errors_total[5m])`
- Phases: diff_fetch, clone_prepare, claude_review, comment_post

**7. Review Duration (p50, p95)**
- Histogram showing review latency percentiles
- Queries:
  - p95: `histogram_quantile(0.95, rate(claude_reviewer_review_duration_seconds_bucket[5m]))`
  - p50: `histogram_quantile(0.50, rate(claude_reviewer_review_duration_seconds_bucket[5m]))`
- Shows: total, diff_fetch, clone_prepare, claude_review, comment_post

### System Metrics

**8. Memory Usage**
- Time series showing resident memory and heap size
- Queries:
  - `process_resident_memory_bytes{job="claude-reviewer"}`
  - `nodejs_heap_size_total_bytes{job="claude-reviewer"}`

**9. CPU & Event Loop**
- Time series showing CPU usage and event loop lag
- Queries:
  - `rate(process_cpu_user_seconds_total{job="claude-reviewer"}[5m])`
  - `nodejs_eventloop_lag_seconds{job="claude-reviewer"}`

## Manual Dashboard Creation

If you prefer to create the dashboard manually:

### 1. Create Dashboard

```bash
# Navigate to Grafana
# Click "+" → "Dashboard" → "Add new panel"
```

### 2. Add Panels

**Total Reviews (Stat)**
```promql
sum(claude_reviewer_reviews_total)
```

**Review Rate by Verdict (Time Series)**
```promql
rate(claude_reviewer_reviews_total[5m])
```
Legend: `{{verdict}}`

**PRs by Status (Pie Chart)**
```promql
claude_reviewer_prs
```
Legend: `{{status}}`

**Active Reviews (Gauge)**
```promql
claude_reviewer_active_reviews
```

**Queue Depth (Gauge)**
```promql
claude_reviewer_queue_depth
```

**Error Rate (Time Series)**
```promql
rate(claude_reviewer_errors_total[5m])
```
Legend: `{{phase}}`

**Review Duration p95 (Time Series)**
```promql
histogram_quantile(0.95, rate(claude_reviewer_review_duration_seconds_bucket[5m]))
```
Legend: `p95 - {{phase}}`

**Review Duration p50 (Time Series)**
```promql
histogram_quantile(0.50, rate(claude_reviewer_review_duration_seconds_bucket[5m]))
```
Legend: `p50 - {{phase}}`

**Memory Usage (Time Series)**
```promql
# Resident Memory
process_resident_memory_bytes{job="claude-reviewer"}

# Heap Size
nodejs_heap_size_total_bytes{job="claude-reviewer"}
```

**CPU Usage (Time Series)**
```promql
rate(process_cpu_user_seconds_total{job="claude-reviewer"}[5m])
```

**Event Loop Lag (Time Series)**
```promql
nodejs_eventloop_lag_seconds{job="claude-reviewer"}
```

## Dashboard Configuration

### Time Range
- Default: Last 1 hour
- Auto-refresh: 30 seconds

### Variables (Optional)

Create dashboard variables for filtering:

**Namespace**
```promql
label_values(claude_reviewer_reviews_total, namespace)
```

**Pod**
```promql
label_values(claude_reviewer_reviews_total{namespace="$namespace"}, pod)
```

Then use in queries:
```promql
claude_reviewer_reviews_total{namespace="$namespace", pod=~"$pod"}
```

## Alerts

Configure Grafana alerts for critical thresholds:

### High Error Rate
```promql
rate(claude_reviewer_errors_total[5m]) > 0.1
```
- Condition: Above 0.1 errors/sec for 5 minutes
- Severity: Warning

### High Queue Depth
```promql
claude_reviewer_queue_depth > 20
```
- Condition: More than 20 PRs queued for 10 minutes
- Severity: Warning

### Slow Reviews
```promql
histogram_quantile(0.95, rate(claude_reviewer_review_duration_seconds_bucket[5m])) > 300
```
- Condition: p95 latency above 5 minutes
- Severity: Warning

### Service Down
```promql
up{job="claude-reviewer"} == 0
```
- Condition: Service unreachable for 2 minutes
- Severity: Critical

### High Memory Usage
```promql
process_resident_memory_bytes{job="claude-reviewer"} > 2e9
```
- Condition: Memory usage above 2GB
- Severity: Warning

## Dashboard Customization

### Add Custom Panels

**Review Success Rate**
```promql
rate(claude_reviewer_reviews_total{verdict="approve"}[5m])
/
rate(claude_reviewer_reviews_total[5m])
```

**State Transitions**
```promql
rate(claude_reviewer_state_transitions_total[5m])
```
Legend: `{{from_status}} → {{to_status}}`

**Skip Rate by Reason**
```promql
rate(claude_reviewer_skips_total[5m])
```
Legend: `{{reason}}`

### Panel Templates

**Single Stat with Sparkline**
- Visualization: Stat
- Graph mode: Area
- Color mode: Value
- Calculation: Last (not null)

**Time Series with Fill**
- Visualization: Time series
- Fill opacity: 10%
- Line width: 1px
- Point size: 5px (never show)

**Gauge with Thresholds**
- Visualization: Gauge
- Thresholds:
  - Green: 0-threshold1
  - Yellow: threshold1-threshold2
  - Red: threshold2+

## Sharing Dashboards

### Export Dashboard

1. Open dashboard
2. Click **Dashboard settings** (gear icon)
3. Click **JSON Model**
4. Copy JSON
5. Save to `k8s/grafana-dashboard.json`

### Import Dashboard

```bash
# Via UI
Dashboard → Import → Upload JSON file

# Via API
curl -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GRAFANA_API_KEY" \
  -d @k8s/grafana-dashboard.json \
  http://grafana:3000/api/dashboards/db
```

### Share Snapshot

1. Click **Share** (top right)
2. Select **Snapshot** tab
3. Choose expiration time
4. Click **Publish snapshot**
5. Copy link

## Kubernetes Integration

### Deploy as ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: claude-reviewer-dashboard
  namespace: monitoring
  labels:
    grafana_dashboard: "1"
data:
  claude-reviewer.json: |
    {{ .Files.Get "k8s/grafana-dashboard.json" | indent 4 }}
```

Grafana sidecar will auto-import dashboards with label `grafana_dashboard: "1"`.

### Using Grafana Operator

```yaml
apiVersion: grafana.integreatly.org/v1beta1
kind: GrafanaDashboard
metadata:
  name: claude-reviewer
  namespace: monitoring
spec:
  json: |
    {{ .Files.Get "k8s/grafana-dashboard.json" | indent 4 }}
```

## Troubleshooting

### No Data in Panels

**Check Prometheus data source:**
```bash
# Test Prometheus query
curl http://prometheus:9090/api/v1/query?query=claude_reviewer_reviews_total
```

**Verify PodMonitor is scraping:**
```bash
kubectl get podmonitor -n claude-reviewer
kubectl describe podmonitor claude-reviewer -n claude-reviewer
```

**Check Prometheus targets:**
- Open Prometheus UI
- Navigate to Status → Targets
- Look for `claude-reviewer` endpoint

### Incorrect Job Label

If queries fail with "job=claude-reviewer", update the dashboard queries to match your actual job label:

```promql
# Find your job label
up{namespace="claude-reviewer"}

# Update queries
claude_reviewer_reviews_total{namespace="claude-reviewer"}
```

### Dashboard Import Fails

**UID conflict:**
- Edit JSON, change `"uid": "claude-code-reviewer"` to a unique value
- Or delete existing dashboard first

**Data source mismatch:**
- Update `"datasource": {"uid": "prometheus"}` to match your Prometheus UID
- Or select correct data source during import

## Best Practices

1. **Use templating** - Add namespace/pod variables for multi-environment dashboards
2. **Set appropriate refresh rates** - 30s for real-time monitoring, 1m for historical analysis
3. **Configure alerts** - Set up critical threshold alerts in Grafana or Prometheus
4. **Add descriptions** - Document panel queries and thresholds in panel descriptions
5. **Version control** - Keep dashboard JSON in git for change tracking
6. **Test queries** - Verify PromQL queries in Prometheus UI before adding to Grafana

## Resources

- [Grafana Documentation](https://grafana.com/docs/)
- [PromQL Query Examples](https://prometheus.io/docs/prometheus/latest/querying/examples/)
- [Grafana Dashboard Best Practices](https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/best-practices/)
