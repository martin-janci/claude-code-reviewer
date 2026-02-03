# Claude Code PR Reviewer - Setup Guide

Complete setup guide for getting Claude Code PR Reviewer running in your environment.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [GitHub Setup](#github-setup)
3. [Claude CLI Setup](#claude-cli-setup)
4. [Deployment Options](#deployment-options)
5. [Configuration](#configuration)
6. [Verification](#verification)
7. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Required

- **GitHub Account** with admin access to repositories you want to review
- **Claude API Access** (Anthropic account)
- **Deployment Environment**:
  - Docker + Docker Compose, OR
  - Kubernetes cluster, OR
  - Node.js 20+ for local development

### Optional

- **Jira** account (for Jira integration)
- **Slack** workspace (for notifications)
- **Custom domain** (for webhook mode)

---

## GitHub Setup

### 1. Create GitHub Personal Access Token

1. Go to **GitHub** → **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)**
2. Click **Generate new token** → **Generate new token (classic)**
3. Configure:
   - **Note**: `Claude Code PR Reviewer`
   - **Expiration**: Choose based on your security policy
   - **Scopes**: Select:
     - ✅ `repo` (Full control of private repositories)
     - ✅ `read:org` (Read org and team membership)
4. Click **Generate token**
5. **Copy the token** (you won't see it again!) - Example: `ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

### 2. Install `gh` CLI

The reviewer uses GitHub CLI for operations:

**macOS:**
```bash
brew install gh
```

**Linux:**
```bash
# Debian/Ubuntu
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt update
sudo apt install gh

# Fedora/RHEL
sudo dnf install gh
```

**Verify installation:**
```bash
gh --version
```

---

## Claude CLI Setup

### 1. Install Claude CLI

**macOS:**
```bash
brew install claude
```

**Linux:**
```bash
curl -fsSL https://docs.anthropic.com/install.sh | bash
```

**Verify installation:**
```bash
claude --version
```

### 2. Authenticate Claude CLI

```bash
claude auth login
```

Follow the prompts to authenticate with your Anthropic account.

**Verify authentication:**
```bash
claude --version
# Should show authenticated status
```

---

## Deployment Options

Choose your deployment method:

### Option 1: Docker Compose (Recommended for Testing)

**Prerequisites:**
- Docker and Docker Compose installed

**Steps:**

1. **Clone the repository:**
```bash
git clone https://github.com/martin-janci/claude-code-reviewer.git
cd claude-code-reviewer
```

2. **Create configuration:**
```bash
cp config.yaml.example config.yaml
nano config.yaml
```

Edit the configuration:
```yaml
mode: webhook  # or "polling" or "both"

repos:
  - owner: your-github-org
    repo: your-repo
  # Add more repos as needed

review:
  codebaseAccess: true  # Recommended
  dryRun: false  # Set to true for testing
```

3. **Create environment file:**
```bash
cat > .env << EOF
GITHUB_TOKEN=ghp_your_token_here
WEBHOOK_SECRET=$(openssl rand -hex 32)
EOF
```

4. **Copy Claude credentials:**
```bash
mkdir -p .claude
cp -r ~/.claude/* .claude/
```

5. **Start the service:**
```bash
docker-compose up -d
```

6. **Check logs:**
```bash
docker-compose logs -f
```

You should see:
```
Claude Code PR Reviewer v1.13.0 starting
```

**Access health check:**
```bash
curl http://localhost:3000/health
```

---

### Option 2: Kubernetes (Recommended for Production)

See detailed guide in [k8s/README.md](k8s/README.md)

**Quick steps:**

1. **Clone and navigate:**
```bash
git clone https://github.com/martin-janci/claude-code-reviewer.git
cd claude-code-reviewer/k8s
```

2. **Configure secrets:**
```bash
nano secret.yaml
```

Add your credentials:
```yaml
stringData:
  GITHUB_TOKEN: "ghp_your_token_here"
  WEBHOOK_SECRET: "your_webhook_secret_here"
```

3. **Configure application:**
```bash
nano configmap.yaml
```

Update repos section:
```yaml
repos:
  - owner: your-org
    repo: your-repo
```

4. **Deploy:**
```bash
./deploy.sh
```

5. **Verify:**
```bash
kubectl get pods -n claude-reviewer
kubectl logs -n claude-reviewer -l app=claude-reviewer
```

---

### Option 3: Local Development

**Prerequisites:**
- Node.js 20+
- `gh` CLI authenticated
- `claude` CLI authenticated

**Steps:**

1. **Clone and install:**
```bash
git clone https://github.com/martin-janci/claude-code-reviewer.git
cd claude-code-reviewer
npm install
```

2. **Configure:**
```bash
cp config.yaml.example config.yaml
nano config.yaml
```

3. **Set environment variables:**
```bash
export GITHUB_TOKEN=ghp_your_token_here
export WEBHOOK_SECRET=$(openssl rand -hex 32)
```

4. **Build and run:**
```bash
npm run build
npm start
```

---

## Configuration

### Basic Configuration

Edit `config.yaml`:

```yaml
# Mode Selection
mode: webhook  # "polling" | "webhook" | "both"

# Webhook Configuration (if using webhook mode)
webhook:
  port: 3000
  path: /webhook

# Polling Configuration (if using polling mode)
polling:
  intervalSeconds: 300  # Check every 5 minutes

# Repositories to review
repos:
  - owner: your-org
    repo: your-repo
  - owner: your-org
    repo: another-repo

# Review Settings
review:
  maxDiffLines: 5000          # Skip PRs with more lines
  skipDrafts: true            # Skip draft PRs
  skipWip: true               # Skip PRs with WIP in title
  commentTrigger: "^\\s*/review\\s*$"  # Regex for /review command
  codebaseAccess: true        # Enable full codebase access
  cloneDir: data/clones       # Where to store clones
  reviewTimeoutMs: 600000     # 10 minute timeout
  reviewMaxTurns: 30          # Max Claude agentic turns
  maxConcurrentReviews: 3     # Parallel review limit
  dryRun: false               # Set true to test without posting
```

### Feature Configuration

#### Enable Autofix

```yaml
features:
  autofix:
    enabled: true
    commandTrigger: "^\\s*/fix\\s*$"  # /fix command
    autoApply: false  # Safe: creates separate branch
    maxTurns: 10
    timeoutMs: 300000  # 5 minutes
```

#### Enable Jira Integration

```yaml
features:
  jira:
    enabled: true
    baseUrl: "https://your-org.atlassian.net"
    projectKeys: ["PROJ", "ENG"]
```

Add Jira credentials to environment:
```bash
export JIRA_TOKEN=your_jira_api_token
export JIRA_EMAIL=your.email@example.com
```

#### Enable Slack Notifications

```yaml
features:
  slack:
    enabled: true
    notifyOn:
      - error
      - request_changes
```

Add Slack webhook to environment:
```bash
export SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

#### Enable Audit Logging

```yaml
features:
  audit:
    enabled: true
    maxEntries: 10000
    filePath: data/audit.json
    includeMetadata: true
    minSeverity: info
```

---

## GitHub Webhook Setup (Webhook Mode)

### 1. Expose Your Service

**For local testing with ngrok:**
```bash
ngrok http 3000
```

Copy the HTTPS URL: `https://xxxx-xx-xx-xx-xx.ngrok.io`

**For production:**
Use your domain: `https://claude-reviewer.your-domain.com`

### 2. Configure GitHub Webhook

For each repository:

1. Go to **Repository** → **Settings** → **Webhooks** → **Add webhook**

2. **Configure webhook:**
   - **Payload URL**: `https://your-domain.com/webhook`
   - **Content type**: `application/json`
   - **Secret**: Use your `WEBHOOK_SECRET` from config
   - **SSL verification**: Enable SSL verification

3. **Select events:**
   - ✅ Pull requests
   - ✅ Issue comments
   - ✅ Pushes

4. **Activate:**
   - ✅ Active

5. Click **Add webhook**

### 3. Verify Webhook

1. Create a test PR in your repository
2. Check webhook delivery in **Settings** → **Webhooks** → Click your webhook
3. Look at **Recent Deliveries** - should see 2xx responses
4. Check reviewer logs for activity

---

## Verification

### 1. Health Check

```bash
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "ok",
  "version": "1.13.0",
  "uptime": 123,
  "settings": {
    "mode": "webhook",
    "repos": ["your-org/your-repo"]
  },
  "auth": {
    "claude": {
      "available": true,
      "authenticated": true
    },
    "github": {
      "available": true,
      "authenticated": true
    }
  }
}
```

### 2. Test Review

**Option A: Create a test PR**

1. Create a new branch
2. Make a small change
3. Open a PR
4. Wait for automatic review (webhook mode) or next poll (polling mode)

**Option B: Trigger manual review**

Comment on any PR:
```
/review
```

### 3. Test Autofix (if enabled)

On a PR with review findings, comment:
```
/fix
```

Bot should respond with a separate `autofix/pr-N` branch containing fixes.

### 4. Check Logs

**Docker Compose:**
```bash
docker-compose logs -f reviewer
```

**Kubernetes:**
```bash
kubectl logs -n claude-reviewer -l app=claude-reviewer -f
```

**Local:**
Check console output

Look for:
```
Claude Code PR Reviewer v1.13.0 starting
Webhook server started on port 3000
```

### 5. Check Metrics

```bash
curl http://localhost:3000/metrics
```

Shows:
- Review counts
- Success/error rates
- Average review time
- PR status distribution

---

## Troubleshooting

### Issue: "GitHub authentication failed"

**Cause:** Invalid or expired GitHub token

**Solution:**
1. Generate a new token with correct permissions (`repo`, `read:org`)
2. Update `GITHUB_TOKEN` environment variable or secret
3. Restart the service

**Verify:**
```bash
gh auth status
```

### Issue: "Claude authentication failed"

**Cause:** Claude CLI not authenticated

**Solution:**
```bash
claude auth login
```

For Docker, ensure `.claude/` directory is mounted with credentials.

### Issue: "Webhook not receiving events"

**Cause:** Multiple possible issues

**Solution:**

1. **Check webhook deliveries in GitHub:**
   - Go to repo **Settings** → **Webhooks**
   - Click your webhook
   - Check **Recent Deliveries**
   - Look for error responses

2. **Verify webhook secret matches:**
   ```bash
   # In your config
   echo $WEBHOOK_SECRET
   # Should match GitHub webhook secret
   ```

3. **Check ingress/networking:**
   ```bash
   # Test externally
   curl https://your-domain.com/webhook
   # Should return 405 (method not allowed) not 404
   ```

4. **Check logs for incoming requests:**
   ```bash
   docker-compose logs -f | grep webhook
   ```

### Issue: "Reviews not posting to GitHub"

**Cause:** Dry run mode enabled or insufficient permissions

**Solution:**

1. **Check dry run mode:**
   ```yaml
   review:
     dryRun: false  # Must be false
   ```

2. **Verify GitHub token permissions:**
   - Token needs `repo` (full) access
   - Check token at https://github.com/settings/tokens

3. **Check rate limits:**
   ```bash
   curl -H "Authorization: token $GITHUB_TOKEN" \
     https://api.github.com/rate_limit
   ```

### Issue: "Timeout errors"

**Cause:** Large PRs or slow network

**Solution:**

1. **Increase timeouts:**
   ```yaml
   review:
     reviewTimeoutMs: 900000  # 15 minutes
     cloneTimeoutMs: 180000   # 3 minutes
   ```

2. **Reduce max diff lines:**
   ```yaml
   review:
     maxDiffLines: 3000  # Lower threshold
   ```

3. **Check network connectivity:**
   ```bash
   time git clone https://github.com/your-org/your-repo.git
   ```

### Issue: "Out of memory"

**Cause:** Too many concurrent reviews or large repos

**Solution:**

1. **Reduce concurrent reviews:**
   ```yaml
   review:
     maxConcurrentReviews: 1
   ```

2. **Increase resource limits (Kubernetes):**
   ```yaml
   resources:
     limits:
       memory: "4Gi"
   ```

3. **Increase Docker memory (Docker Compose):**
   ```yaml
   services:
     reviewer:
       mem_limit: 4g
   ```

### Issue: "State file corruption"

**Cause:** Multiple instances or crash during write

**Solution:**

1. **Stop all instances:**
   ```bash
   docker-compose down
   # or
   kubectl scale deployment/claude-reviewer --replicas=0 -n claude-reviewer
   ```

2. **Backup and reset state:**
   ```bash
   cp data/state.json data/state.json.backup
   echo '{"version":2,"prs":{}}' > data/state.json
   ```

3. **Ensure single replica:**
   - Docker Compose: Only run one instance
   - Kubernetes: Keep `replicas: 1`

4. **Restart:**
   ```bash
   docker-compose up -d
   # or
   kubectl scale deployment/claude-reviewer --replicas=1 -n claude-reviewer
   ```

---

## Getting Help

### Logs and Diagnostics

**Collect logs:**
```bash
# Docker Compose
docker-compose logs --tail=1000 > reviewer.log

# Kubernetes
kubectl logs -n claude-reviewer -l app=claude-reviewer --tail=1000 > reviewer.log
```

**Check state:**
```bash
# View current state
cat data/state.json | jq .

# Check audit log
cat data/audit.json | jq . | tail -50
```

**Health diagnostics:**
```bash
curl http://localhost:3000/health | jq .
curl http://localhost:3000/metrics | jq .
```

### Support Channels

- **GitHub Issues**: https://github.com/martin-janci/claude-code-reviewer/issues
- **Documentation**: Check README.md and inline comments
- **Configuration**: See config.yaml for all options

### Report a Bug

Include:
1. Version: Check logs for "v1.13.0" or run `docker-compose logs | grep version`
2. Deployment method: Docker Compose / Kubernetes / Local
3. Configuration: Sanitized config.yaml (remove secrets)
4. Logs: Last 100 lines before error
5. Steps to reproduce

---

## Security Best Practices

### 1. Secrets Management

**Never commit secrets to git:**
```bash
# Add to .gitignore
echo ".env" >> .gitignore
echo "data/" >> .gitignore
echo ".claude/" >> .gitignore
```

**Use environment variables:**
```bash
export GITHUB_TOKEN=...
export WEBHOOK_SECRET=...
```

**Kubernetes: Use external secrets operator**
```yaml
# Instead of plain Secret, use ExternalSecret
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: claude-reviewer-secrets
spec:
  secretStoreRef:
    name: vault-backend
    kind: SecretStore
  target:
    name: claude-reviewer-secrets
  data:
  - secretKey: GITHUB_TOKEN
    remoteRef:
      key: claude-reviewer/github-token
```

### 2. Token Permissions

**GitHub token - minimum required:**
- `repo` (full control) - Required for posting reviews
- `read:org` - Required for org repos

**Avoid:**
- ❌ `admin:org` - Not needed
- ❌ `delete_repo` - Not needed
- ❌ `admin:public_key` - Not needed

### 3. Network Security

**Webhook mode:**
- Always use HTTPS for webhook endpoint
- Validate webhook signatures (automatic with `WEBHOOK_SECRET`)
- Use firewall rules to restrict access

**Kubernetes:**
```yaml
# NetworkPolicy example
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: claude-reviewer
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
  - to:
    - namespaceSelector: {}
    ports:
    - port: 443  # HTTPS to GitHub/Claude APIs
```

### 4. Regular Updates

**Check for updates:**
```bash
# Docker
docker pull registry.rlt.sk/claude-code-reviewer:latest

# Git
git pull origin main
```

**Subscribe to releases:**
- GitHub: Watch repository → Custom → Releases
- Check CHANGELOG.md for breaking changes

---

## Next Steps

After setup is complete:

1. ✅ **Monitor first reviews** - Check logs and GitHub for review activity
2. ✅ **Enable features gradually** - Start with basic reviews, then enable autofix, Jira, etc.
3. ✅ **Tune configuration** - Adjust timeouts, thresholds based on your needs
4. ✅ **Set up monitoring** - Use /metrics endpoint with Prometheus/Grafana
5. ✅ **Create team documentation** - Share how to use `/review` and `/fix` commands

**Ready to review!** 🎉
