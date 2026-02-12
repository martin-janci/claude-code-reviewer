#!/bin/bash
set -e

# Define versions to build
VERSIONS=("1.10.0" "1.11.0" "1.12.0" "1.13.0")
REGISTRY="registry.rlt.sk/claude-code-reviewer"

echo "Building and pushing Docker images for all recent versions..."

for VERSION in "${VERSIONS[@]}"; do
  echo ""
  echo "=========================================="
  echo "Building version $VERSION..."
  echo "=========================================="
  
  # Checkout the tag
  git checkout "v${VERSION}" || {
    echo "Warning: Tag v${VERSION} not found, skipping..."
    continue
  }
  
  # Build the image
  docker build -t "${REGISTRY}:${VERSION}" .
  
  # Push the image
  echo "Pushing ${REGISTRY}:${VERSION}..."
  docker push "${REGISTRY}:${VERSION}"
  
  echo "✓ Successfully built and pushed ${REGISTRY}:${VERSION}"
done

# Build and push latest from main
echo ""
echo "=========================================="
echo "Building latest from main..."
echo "=========================================="
git checkout main
docker build -t "${REGISTRY}:latest" -t "${REGISTRY}:1.13.0" .
docker push "${REGISTRY}:latest"
docker push "${REGISTRY}:1.13.0"

echo ""
echo "=========================================="
echo "✓ All images built and pushed successfully!"
echo "=========================================="
docker images "${REGISTRY}" --format "table {{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.CreatedAt}}"
