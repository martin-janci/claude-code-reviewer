#!/bin/bash
set -e

# Define versions to build
VERSIONS=("1.10.0" "1.11.0" "1.12.0" "1.13.0")
REGISTRY="registry.rlt.sk/claude-code-reviewer"

echo "Building multi-platform Docker images for linux/amd64..."

# Create/use buildx builder for multi-platform builds
docker buildx create --name multiplatform --use 2>/dev/null || docker buildx use multiplatform

for VERSION in "${VERSIONS[@]}"; do
  echo ""
  echo "=========================================="
  echo "Building version $VERSION for linux/amd64..."
  echo "=========================================="
  
  # Checkout the tag
  git checkout "v${VERSION}" || {
    echo "Warning: Tag v${VERSION} not found, skipping..."
    continue
  }
  
  # Build and push the image for linux/amd64
  docker buildx build \
    --platform linux/amd64 \
    --tag "${REGISTRY}:${VERSION}" \
    --push \
    .
  
  echo "✓ Successfully built and pushed ${REGISTRY}:${VERSION}"
done

# Build and push latest from main
echo ""
echo "=========================================="
echo "Building latest from main for linux/amd64..."
echo "=========================================="
git checkout main
docker buildx build \
  --platform linux/amd64 \
  --tag "${REGISTRY}:latest" \
  --tag "${REGISTRY}:1.13.0" \
  --push \
  .

echo ""
echo "=========================================="
echo "✓ All images built and pushed successfully!"
echo "=========================================="
