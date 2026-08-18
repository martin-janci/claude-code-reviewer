# Manual Docker Build & Push (GHCR)

## Why this exists

`ghcr.io/papayapos/papaya-reviewer` — the image actually referenced by
`k8s/deployment.yaml` — is **not** built by this repo's `.github/workflows/docker-build.yml`.
That workflow publishes to `ghcr.io/martin-janci/claude-code-reviewer` (derived from
`${{ github.repository }}`). There is no known CI pipeline that builds
`papayapos/papaya-reviewer`; the deployment pulls it via a private pull secret
(`docker-auths` in the `claude-reviewer` namespace), which only makes sense if it's
pushed by hand. Use this doc when you need to ship a fix straight to TST/prod without
waiting on that gap to be resolved.

## Prerequisites

- Docker with Buildx (for `--platform linux/amd64`, the only platform this image supports —
  see the graphify install notes in `Dockerfile`)
- A GitHub PAT (or `gh auth token`) with `write:packages` scope, **and** actual write
  access to the `papayapos/papaya-reviewer` package specifically (org membership alone
  isn't sufficient for private packages with per-package ACLs)
- Repo checked out at the commit you want to ship (confirm your fix is actually present,
  e.g. `git log --oneline -5`)

## 1. Login to GHCR

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <your-github-username> --password-stdin
# or, reusing the gh CLI's own token:
gh auth token | docker login ghcr.io -u <your-github-username> --password-stdin
```

## 2. Build

Run from the repo root, on the commit you want to ship:

```bash
VERSION=$(node -p "require('./package.json').version")
docker build \
  --platform linux/amd64 \
  -f Dockerfile \
  -t ghcr.io/papayapos/papaya-reviewer:latest \
  -t ghcr.io/papayapos/papaya-reviewer:"$VERSION" \
  -t ghcr.io/papayapos/papaya-reviewer:"$(git rev-parse --short HEAD)" \
  .
```

This uses the production `Dockerfile` (dhi.io base, LSPs, graphify) — the same image
shape as CI would produce, just built locally. Expect it to take a while (JDT LS,
Kotlin LSP, Zulu JRE, graphify pip install).

## 3. Push

```bash
docker push ghcr.io/papayapos/papaya-reviewer:latest
docker push ghcr.io/papayapos/papaya-reviewer:"$VERSION"
docker push ghcr.io/papayapos/papaya-reviewer:"$(git rev-parse --short HEAD)"
```

Push the versioned/sha tags in addition to `latest` so there's something to roll back
to (`kubectl set image ...`) if `latest` turns out bad.

## 4. Deploy to TST

The deployment uses `imagePullPolicy: Always` with tag `:latest` and
`strategy: Recreate`, so a rollout restart is enough to pick up the new image:

```bash
ssh -p 22221 user@192.168.203.250
kubectl rollout restart deployment/claude-reviewer -n claude-reviewer
kubectl rollout status deployment/claude-reviewer -n claude-reviewer
kubectl logs -n claude-reviewer deployment/claude-reviewer -f
```

## 5. Verify

Trigger a re-review on the PR that was previously skipped:

```bash
gh pr comment papayapos/papayapos-common#530 --body "/review"
```

Confirm the log no longer shows `Skipping PR ... diff_too_large`.
