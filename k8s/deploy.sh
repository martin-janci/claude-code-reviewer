#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "================================================"
echo "Claude Code PR Reviewer - Kubernetes Deployment"
echo "================================================"

# Check if kubectl is available
if ! command -v kubectl &> /dev/null; then
    echo -e "${RED}Error: kubectl is not installed${NC}"
    exit 1
fi

# Check if we can connect to cluster
if ! kubectl cluster-info &> /dev/null; then
    echo -e "${RED}Error: Cannot connect to Kubernetes cluster${NC}"
    exit 1
fi

echo -e "${GREEN}✓${NC} kubectl is configured"

# Check if secrets are configured
if grep -q "ghp_your_token_here" secret.yaml; then
    echo -e "${YELLOW}Warning: Please configure your secrets in secret.yaml before deploying!${NC}"
    echo "  - GITHUB_TOKEN"
    echo "  - WEBHOOK_SECRET"
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Check if config is customized
if grep -q "your-org" configmap.yaml; then
    echo -e "${YELLOW}Warning: Please configure your repos in configmap.yaml!${NC}"
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

echo ""
echo "Deploying to Kubernetes..."
echo ""

# Deploy using kubectl (or kustomize if available)
if command -v kustomize &> /dev/null; then
    echo "Using kustomize..."
    kustomize build . | kubectl apply -f -
else
    echo "Using kubectl..."
    kubectl apply -f namespace.yaml
    kubectl apply -f configmap.yaml
    kubectl apply -f secret.yaml
    kubectl apply -f pvc.yaml
    kubectl apply -f deployment.yaml
    kubectl apply -f service.yaml
    kubectl apply -f ingress.yaml
fi

echo ""
echo -e "${GREEN}✓${NC} Resources applied"

# Wait for deployment
echo ""
echo "Waiting for deployment to be ready..."
kubectl wait --for=condition=available --timeout=300s \
    deployment/claude-reviewer -n claude-reviewer || true

# Show status
echo ""
echo "================================================"
echo "Deployment Status"
echo "================================================"

kubectl get pods -n claude-reviewer -o wide
echo ""
kubectl get svc -n claude-reviewer
echo ""
kubectl get ingress -n claude-reviewer

# Get pod name
POD_NAME=$(kubectl get pod -n claude-reviewer -l app=claude-reviewer -o jsonpath="{.items[0].metadata.name}" 2>/dev/null || echo "")

if [ -n "$POD_NAME" ]; then
    echo ""
    echo "================================================"
    echo "Recent Logs"
    echo "================================================"
    kubectl logs -n claude-reviewer "$POD_NAME" --tail=20 || true
fi

echo ""
echo "================================================"
echo "Next Steps"
echo "================================================"
echo ""
echo "1. Check logs:"
echo "   kubectl logs -n claude-reviewer -l app=claude-reviewer -f"
echo ""
echo "2. Check health:"
echo "   kubectl port-forward -n claude-reviewer svc/claude-reviewer 3000:3000"
echo "   curl http://localhost:3000/health"
echo ""
echo "3. Configure GitHub webhook (webhook mode):"
echo "   URL: https://your-domain.com/webhook"
echo "   Secret: (from secret.yaml)"
echo "   Events: Pull requests, Issue comments, Pushes"
echo ""
echo "4. Monitor:"
echo "   kubectl get pods -n claude-reviewer -w"
echo ""
