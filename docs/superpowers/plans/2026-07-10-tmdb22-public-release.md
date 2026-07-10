# TMDB Proxy v2.6.1 Public Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the reviewed and sanitized tmdb22 v2.6.1 source to `qqcomeup/tmdb-proxy` and build one GHCR image supporting both amd64 and arm64.

**Architecture:** Keep the current public repository and its history as the release workspace. Import only reviewed application files from tmdb22, add runtime request-log redaction, retain the public-release validator and documentation, then use Docker Buildx/QEMU to publish a multi-platform manifest.

**Tech Stack:** Node.js 22, built-in Node.js HTTP/HTTPS/HTTP2 modules, Docker Buildx, QEMU, GitHub Actions, GHCR, Docker Compose.

## Global Constraints

- Do not modify `/home/dev/桌面/tmdb2026/tmdb22`.
- Never copy or commit `/home/dev/桌面/tmdb2026/tmdb22/.env`.
- Keep repository name `qqcomeup/tmdb-proxy` and image name `ghcr.io/qqcomeup/tmdb-proxy`.
- Build `linux/amd64` and `linux/arm64` under the same image tags.
- Runtime image must be `gcr.io/distroless/nodejs22-debian13` and run as UID/GID `65532:65532`.
- Compose must pull the prebuilt GHCR image and require `TMDB_API_KEY` plus `ADMIN_API_KEY`.
- Preserve Chinese-first documentation and the two mutually exclusive secret-configuration methods.

---

### Task 1: Import the reviewed v2.6.1 application

**Files:**
- Replace: `server.js`
- Replace: `admin-dashboard.html`
- Create: `test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: reviewed files under `/home/dev/桌面/tmdb2026/tmdb22`.
- Produces: v2.6.1 application exports `server`, `startServer`, `shutdown`, and `_internals`; npm scripts `check`, `test`, and `validate:release`.

- [ ] **Step 1: Confirm the private environment file is ignored**

Run:

```bash
test ! -e .env
git ls-files | rg '(^|/)\.env$' && exit 1 || true
```

Expected: the public repository tracks no `.env` file.

- [ ] **Step 2: Mechanically copy only the reviewed application files**

Run from `/tmp/tmdb2026-public`:

```bash
cp /home/dev/桌面/tmdb2026/tmdb22/server.js ./server.js
cp /home/dev/桌面/tmdb2026/tmdb22/admin-dashboard.html ./admin-dashboard.html
cp /home/dev/桌面/tmdb2026/tmdb22/test.js ./test.js
```

Expected: only the three named files are imported; `.env`, Compose, Dockerfile, cache, and logs are not copied.

- [ ] **Step 3: Set the public package metadata and scripts**

Replace `package.json` with:

```json
{
  "name": "tmdb-proxy",
  "version": "2.6.1",
  "description": "TMDB Proxy - Zero dependencies",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "check": "node --check server.js && node --check test.js",
    "test": "node test.js",
    "validate:release": "node scripts/validate-public-release.mjs"
  },
  "author": "qqcomeup",
  "license": "MIT",
  "engines": {
    "node": ">=18.0.0"
  }
}
```

- [ ] **Step 4: Run the imported source tests**

Run:

```bash
npm run check
npm test
```

Expected: syntax checks complete successfully and output ends with `All tests passed`.

- [ ] **Step 5: Commit the application import**

```bash
git add server.js admin-dashboard.html test.js package.json
git commit -m "feat: upgrade proxy to v2.6.1"
```

---

### Task 2: Redact secrets from request logs

**Files:**
- Modify: `test.js`
- Modify: `server.js`

**Interfaces:**
- Produces: `_internals.sanitizeRequestUrl(url)` returning a log-safe URL string.
- Consumes: raw `req.url` in the HTTP server request-finalization block.

- [ ] **Step 1: Add failing redaction tests**

Add these assertions to `test.js` after the pathname tests:

```js
const sanitizedUrl = _internals.sanitizeRequestUrl(
  '/3/search/movie?api_key=tmdb-private&query=test&key=client-private&ADMIN_KEY=admin-private'
);
assert.ok(!sanitizedUrl.includes('tmdb-private'));
assert.ok(!sanitizedUrl.includes('client-private'));
assert.ok(!sanitizedUrl.includes('admin-private'));
assert.ok(sanitizedUrl.includes('query=test'));
assert.strictEqual(
  _internals.sanitizeRequestUrl('/3/movie/1?language=zh-CN'),
  '/3/movie/1?language=zh-CN'
);
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm test
```

Expected: failure because `_internals.sanitizeRequestUrl` is not defined.

- [ ] **Step 3: Implement URL redaction**

Add beside `getPathname` in `server.js`:

```js
function sanitizeRequestUrl(url) {
  return String(url || '').replace(
    /([?&](?:api_key|key|admin_key)=)[^&#]*/gi,
    '$1[REDACTED]'
  );
}
```

Change the request log entry from:

```js
path: req.url,
```

to:

```js
path: sanitizeRequestUrl(req.url),
```

Add `sanitizeRequestUrl` to `_internals` exports.

- [ ] **Step 4: Run security and regression tests**

Run:

```bash
npm run check
npm test
```

Expected: all checks pass and the three secret values are absent from the sanitized URL.

- [ ] **Step 5: Commit log redaction**

```bash
git add server.js test.js
git commit -m "fix: redact keys from request logs"
```

---

### Task 3: Adapt the v2.6.1 container configuration for public deployment

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `.gitignore`

**Interfaces:**
- Produces: non-root image listening on port 54321 with writable `/tmp/tmdb-cache`.
- Produces: Compose service pulling `ghcr.io/qqcomeup/tmdb-proxy:latest`.

- [ ] **Step 1: Replace the Dockerfile**

Use:

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY server.js admin-dashboard.html package.json ./
RUN mkdir -p /tmp/tmdb-cache && chown -R 65532:65532 /tmp/tmdb-cache

FROM gcr.io/distroless/nodejs22-debian13
WORKDIR /app
ENV NODE_ENV=production PORT=54321
COPY --from=builder /app ./
COPY --from=builder --chown=65532:65532 /tmp/tmdb-cache /tmp/tmdb-cache
USER 65532:65532
EXPOSE 54321
CMD ["server.js"]
```

- [ ] **Step 2: Replace the public Compose file**

Use:

```yaml
services:
  tmdb-proxy:
    image: ghcr.io/qqcomeup/tmdb-proxy:latest
    user: "65532:65532"
    container_name: tmdb-proxy
    mem_limit: ${CONTAINER_MEM_LIMIT:-512m}
    mem_reservation: ${CONTAINER_MEM_RESERVATION:-256m}
    pids_limit: 256
    ports:
      - "${BIND_ADDRESS:-127.0.0.1}:${PORT:-54321}:54321"
    environment:
      - NODE_ENV=production
      - PORT=54321
      - TMDB_API_KEY=${TMDB_API_KEY:?TMDB_API_KEY is required}
      - ADMIN_API_KEY=${ADMIN_API_KEY:?ADMIN_API_KEY is required}
      - COOKIE_SECURE=${COOKIE_SECURE:-true}
      - IMAGE_DISK_CACHE_ENABLED=${IMAGE_DISK_CACHE_ENABLED:-true}
      - IMAGE_DISK_CACHE_DIR=/tmp/tmdb-cache
      - IMAGE_DISK_CACHE_MAX_GB=${IMAGE_DISK_CACHE_MAX_GB:-1}
      - IMAGE_MEM_CACHE_MAX_MB=${IMAGE_MEM_CACHE_MAX_MB:-100}
      - IMAGE_CACHE_TTL=${IMAGE_CACHE_TTL:-604800}
      - API_CACHE_TTL=${API_CACHE_TTL:-600}
      - API_CACHE_MAX_ITEMS=${API_CACHE_MAX_ITEMS:-2000}
      - FETCH_TIMEOUT_MS=${FETCH_TIMEOUT_MS:-15000}
      - API_RETRY_COUNT=${API_RETRY_COUNT:-2}
      - IMAGE_RETRY_COUNT=${IMAGE_RETRY_COUNT:-1}
      - RETRY_DELAY_MS=${RETRY_DELAY_MS:-150}
      - DISK_CACHE_CLEANUP_INTERVAL_MS=${DISK_CACHE_CLEANUP_INTERVAL_MS:-600000}
    restart: unless-stopped
    volumes:
      - tmdb-cache:/tmp/tmdb-cache
    healthcheck:
      test: ["CMD", "/nodejs/bin/node", "-e", "require('http').get('http://localhost:54321/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

volumes:
  tmdb-cache:
```

- [ ] **Step 3: Replace `.env.example` with public defaults**

Use:

```env
TMDB_API_KEY=
ADMIN_API_KEY=

BIND_ADDRESS=127.0.0.1
PORT=54321
COOKIE_SECURE=true

CONTAINER_MEM_LIMIT=512m
CONTAINER_MEM_RESERVATION=256m

IMAGE_DISK_CACHE_ENABLED=true
IMAGE_DISK_CACHE_MAX_GB=1
IMAGE_MEM_CACHE_MAX_MB=100
IMAGE_CACHE_TTL=604800
API_CACHE_TTL=600
API_CACHE_MAX_ITEMS=2000

FETCH_TIMEOUT_MS=15000
API_RETRY_COUNT=2
IMAGE_RETRY_COUNT=1
RETRY_DELAY_MS=150
DISK_CACHE_CLEANUP_INTERVAL_MS=600000
```

- [ ] **Step 4: Ensure generated test data remains ignored**

Add to `.gitignore` if absent:

```gitignore
cache-test/
cache-test-files/
```

- [ ] **Step 5: Validate Compose expansion**

Run:

```bash
TMDB_API_KEY=dummy ADMIN_API_KEY=dummy COOKIE_SECURE=false docker compose config >/dev/null
```

Expected: exit status 0 with no missing-variable error.

- [ ] **Step 6: Commit container configuration**

```bash
git add Dockerfile docker-compose.yml .env.example .gitignore
git commit -m "build: harden public container deployment"
```

---

### Task 4: Build amd64 and arm64 images in GitHub Actions

**Files:**
- Modify: `.github/workflows/docker-image.yml`
- Modify: `scripts/validate-public-release.mjs`

**Interfaces:**
- Produces: GHCR manifest tags containing `linux/amd64` and `linux/arm64`.
- Consumes: Dockerfile and npm validation scripts from Tasks 1-3.

- [ ] **Step 1: Strengthen source validation in the workflow**

Set the validation commands to:

```yaml
      - name: Validate source
        run: |
          npm run check
          npm test
          npm run validate:release
```

- [ ] **Step 2: Enable QEMU before Buildx**

Add:

```yaml
      - name: Set up QEMU
        uses: docker/setup-qemu-action@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3
```

- [ ] **Step 3: Configure both target platforms**

Add under `docker/build-push-action@v6` inputs:

```yaml
          platforms: linux/amd64,linux/arm64
```

Keep existing GHCR login, metadata tags, GHA cache, and conditional push behavior.

- [ ] **Step 4: Add release-validator assertions**

Extend the workflow check in `scripts/validate-public-release.mjs` with these required strings:

```js
'docker/setup-qemu-action',
'platforms: linux/amd64,linux/arm64',
'npm test',
```

Add a server safety check:

```js
check('server redacts request query secrets from logs', () => {
  const server = read('server.js');
  if (!server.includes('sanitizeRequestUrl(req.url)')) {
    throw new Error('request logging does not sanitize req.url');
  }
  if (!server.includes('api_key|key|admin_key')) {
    throw new Error('query secret keys are not covered by redaction');
  }
});
```

- [ ] **Step 5: Run repository validation**

Run:

```bash
npm run check
npm test
npm run validate:release
```

Expected: all checks report success.

- [ ] **Step 6: Commit multi-architecture CI**

```bash
git add .github/workflows/docker-image.yml scripts/validate-public-release.mjs
git commit -m "ci: build amd64 and arm64 images"
```

---

### Task 5: Update the Chinese deployment guide

**Files:**
- Modify: `README.md`

**Interfaces:**
- Documents: v2.6.1 features, multi-architecture image, Compose deployment, environment variables, HTTP/HTTPS cookie behavior, updates, and source tests.

- [ ] **Step 1: Update the feature and image sections**

State that the image supports both architectures:

````md
镜像同时支持：

- `linux/amd64`：常见 Intel / AMD 服务器
- `linux/arm64`：ARM64 服务器、树莓派 64 位等

两种架构使用同一个镜像地址，Docker 会自动选择：

```bash
ghcr.io/qqcomeup/tmdb-proxy:latest
```
````

- [ ] **Step 2: Keep the two secret-configuration methods explicit**

Document exactly:

```md
下面两种部署方式二选一：

- 直接把密钥写入 `docker-compose.yml` 时，不需要 `.env`。
- 使用仓库自带 `docker-compose.yml` 时，把密钥写入 `.env`。
```

The direct Compose example must include:

```yaml
      - TMDB_API_KEY=你的_TMDB_API_KEY
      - ADMIN_API_KEY=你的管理密码
      - COOKIE_SECURE=false
```

- [ ] **Step 3: Explain secure-cookie behavior**

Add:

```md
- 通过 HTTPS 域名访问管理面板：使用 `COOKIE_SECURE=true`。
- 直接通过 `http://服务器IP:端口` 访问：使用 `COOKIE_SECURE=false`，否则浏览器不会保存管理登录 Cookie。
```

- [ ] **Step 4: Document current optional variables and tests**

Include `COOKIE_SECURE`, `FETCH_TIMEOUT_MS`, `API_RETRY_COUNT`, `IMAGE_RETRY_COUNT`, `RETRY_DELAY_MS`, `API_CACHE_MAX_ITEMS`, resource limits, and:

```bash
npm run check
npm test
npm run validate:release
```

- [ ] **Step 5: Review documentation for secret safety and stale options**

Run:

```bash
rg -n 'IMAGE_DISK_CACHE_TRIGGER_GB|your_tmdb|真实密钥|真实密码' README.md .env.example docker-compose.yml && exit 1 || true
```

Expected: no stale unsupported variable or real credential wording that could be mistaken for a value.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md
git commit -m "docs: update v2.6.1 multi-arch deployment guide"
```

---

### Task 6: Verify, publish, and inspect the GHCR manifest

**Files:**
- Verify: all tracked release files
- Publish: current `main` branch to `origin`

**Interfaces:**
- Produces: successful GitHub Actions run and public multi-platform `latest` image.

- [ ] **Step 1: Run all local tests**

Run:

```bash
npm run check
npm test
npm run validate:release
TMDB_API_KEY=dummy ADMIN_API_KEY=dummy COOKIE_SECURE=false docker compose config >/dev/null
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 2: Run the local HTTP smoke test with dummy secrets**

Run a temporary port-zero server and verify:

- `/health` returns 200.
- encoded traversal under `/t/p/` returns 404.
- `/admin/auth` returns a signed `admin_session` cookie.
- `/admin/status` accepts that session and returns 200.
- `/3/configuration` returns parseable JSON from TMDB even with a dummy key.

Expected: status summary `200, 404, 200, 200` and parseable upstream JSON.

- [ ] **Step 3: Scan every public file for sensitive material**

Run:

```bash
perl -MFile::Find -ne 'BEGIN { @p=( [qr/(gh[pousr]_[A-Za-z0-9_]{20,})/,"github-token"], [qr/(sk-[A-Za-z0-9_-]{20,})/,"openai-like-key"], [qr/(AKIA[0-9A-Z]{16})/,"aws-access-key"], [qr/(-----BEGIN (RSA|OPENSSH|EC|DSA|PRIVATE) KEY-----)/,"private-key"], [qr/TMDB_API_KEY=[a-f0-9]{32}\b/i,"tmdb-key"], [qr/ADMIN_API_KEY=\d{6,}\b/,"admin-key"] ); } for my $p (@p) { if ($_ =~ $p->[0]) { print "$ARGV:$.:$p->[1]\n"; last } } close ARGV if eof' $(find . -type f -not -path './.git/*' | sort)
```

Expected: no output.

- [ ] **Step 4: Review the exact publication diff**

Run:

```bash
git status --short --branch
git diff origin/main...HEAD --stat
git log --oneline origin/main..HEAD
```

Expected: only the approved source, tests, release configuration, documentation, and design/plan commits are present.

- [ ] **Step 5: Push the current main branch**

```bash
git push origin main
```

Expected: push succeeds without force and starts the Docker image workflow.

- [ ] **Step 6: Wait for GitHub Actions**

```bash
run_id=$(gh run list --repo qqcomeup/tmdb-proxy --workflow docker-image.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$run_id" --repo qqcomeup/tmdb-proxy --exit-status
```

Expected: checkout, tests, QEMU setup, amd64/arm64 build, and GHCR push all succeed.

- [ ] **Step 7: Inspect the published multi-platform manifest**

Run:

```bash
docker buildx imagetools inspect ghcr.io/qqcomeup/tmdb-proxy:latest
```

Expected output contains both:

```text
Platform: linux/amd64
Platform: linux/arm64
```

- [ ] **Step 8: Confirm a clean synchronized worktree**

```bash
git status --short --branch
```

Expected: `main...origin/main` with no modified or untracked files.
