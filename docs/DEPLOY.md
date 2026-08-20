# Deploying the reviewer (papaya-reviewer image)

## How the image gets built

`k8s/deployment.yaml` pulls `ghcr.io/papayapos/papaya-reviewer:latest` (private GHCR
package, pull secret `docker-auths` in the `claude-reviewer` namespace).

That image **is built by CI** — just not by this repository's Actions. The private repo
`papayapos/papaya-reviewer` is a mirror of this one and carries the same
`.github/workflows/docker-build.yml`; there `${{ github.repository }}` resolves to
`papayapos/papaya-reviewer`, so every push to its `main` runs **Docker Build & Push**
and publishes `:latest`, `:<semver>` and `:<sha>` to GHCR. This repository's own
workflow publishes `ghcr.io/martin-janci/claude-code-reviewer`, which nothing deploys.

## Normal release flow

1. Merge to this repo's `main` (Conventional Commits — `fix:`/`feat:` make the
   **Release** workflow cut a version + `chore(release): vX.Y.Z` commit).
2. Fetch `main` again so you have that release commit, then push it to the mirror:

   ```bash
   git fetch origin main
   git push papayapos origin/main:main      # remote: https://github.com/papayapos/papaya-reviewer.git
   ```

   Keep the two `main`s converged. The mirror runs its own Release workflow and may
   cut a release commit of its own; when that happens merge `papayapos/main` back into
   `origin/main` taking this repo's side for `CHANGELOG.md` / `package.json` conflicts
   (`git merge -X ours papayapos/main`) and push the merge to both remotes.

3. Wait for **Docker Build & Push** on `papayapos/papaya-reviewer` to finish:

   ```bash
   gh run list --repo papayapos/papaya-reviewer --limit 3
   ```

   Do not restart before it is green — the deployment pulls `:latest` with
   `imagePullPolicy: Always`, so an early restart just re-pulls the old image.

4. Roll out (`strategy: Recreate`, single replica — a restart is enough):

   ```bash
   ssh <cluster-host>
   kubectl rollout restart deployment/claude-reviewer -n claude-reviewer
   kubectl rollout status  deployment/claude-reviewer -n claude-reviewer
   kubectl logs -n claude-reviewer deployment/claude-reviewer | head   # "… vX.Y.Z starting"
   ```

5. Verify on a real PR. A PR stuck in `skipped: diff_too_large` is only re-evaluated
   when its head SHA changes, so force it:

   ```bash
   gh pr comment <owner>/<repo>#<n> --body "/review"
   ```

   and confirm the log shows `Filtered excluded paths from diff` → `Reviewing PR`
   rather than `Skipping: diff too large`.

## Fallback: manual build & push

Only when the mirror's CI is unavailable. Needs Docker with Buildx and a token with
`write:packages` **plus** write access to the `papayapos/papaya-reviewer` package
(org membership alone is not enough for a private package with per-package ACLs).

```bash
# 1. login (reuse the gh CLI token of an account with package write access)
gh auth token | docker login ghcr.io -u <github-username> --password-stdin

# 2. build from the commit you want to ship (linux/amd64 only — see graphify notes in Dockerfile)
VERSION=$(node -p "require('./package.json').version")
SHA=$(git rev-parse --short HEAD)
docker build --platform linux/amd64 -f Dockerfile \
  -t ghcr.io/papayapos/papaya-reviewer:latest \
  -t ghcr.io/papayapos/papaya-reviewer:"$VERSION" \
  -t ghcr.io/papayapos/papaya-reviewer:"$SHA" .

# 3. push all tags — the versioned/sha ones are what you roll back to
docker push ghcr.io/papayapos/papaya-reviewer:latest
docker push ghcr.io/papayapos/papaya-reviewer:"$VERSION"
docker push ghcr.io/papayapos/papaya-reviewer:"$SHA"
```

Then continue with steps 4–5 above. Expect the build to take a while (JDT LS, Kotlin
LSP, JRE, graphify pip install).

## Rolling back

```bash
kubectl set image deployment/claude-reviewer \
  reviewer=ghcr.io/papayapos/papaya-reviewer:<previous-semver-or-sha> -n claude-reviewer
```

## Configuration changes

`k8s/configmap.yaml` is the source of truth for the cluster config (e.g. `review.graphify`).
Apply it and restart, or use the dashboard hot-reload for fields that support it — but
land the change in the manifest too so the repo matches the cluster.
