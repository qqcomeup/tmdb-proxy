import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

const checks = [];

function check(name, fn) {
  checks.push({ name, fn });
}

check('does not publish backup compose files', () => {
  const files = fs.readdirSync(root);
  if (files.some((file) => /^docker-compose\.yml\.bak/.test(file))) {
    throw new Error('backup docker-compose file is still present');
  }
});

check('docker-compose uses environment variables for secrets', () => {
  const compose = read('docker-compose.yml');
  if (!compose.includes('${TMDB_API_KEY:?TMDB_API_KEY is required}')) {
    throw new Error('TMDB_API_KEY is not required via environment variable');
  }
  if (!compose.includes('${ADMIN_API_KEY:?ADMIN_API_KEY is required}')) {
    throw new Error('ADMIN_API_KEY is not required via environment variable');
  }
  if (/TMDB_API_KEY=[a-f0-9]{32}\b/i.test(compose)) {
    throw new Error('docker-compose contains a 32-character hex TMDB key');
  }
  if (/ADMIN_API_KEY=\d{6,}\b/.test(compose)) {
    throw new Error('docker-compose contains a numeric admin key');
  }
});

check('Dockerfile uses supported Node 22 images', () => {
  const dockerfile = read('Dockerfile');
  if (!dockerfile.includes('FROM node:22-alpine AS builder')) {
    throw new Error('builder image is not node:22-alpine');
  }
  if (!dockerfile.includes('FROM gcr.io/distroless/nodejs22-debian13')) {
    throw new Error('runtime image is not distroless nodejs22-debian13');
  }
});

check('server does not contain duplicate pendingRequests.set call', () => {
  const server = read('server.js');
  if (/pendingRequests\.set\(key, promise\);\s*pendingRequests\.set\(key, promise\);/.test(server)) {
    throw new Error('duplicate pendingRequests.set(key, promise) call remains');
  }
});

check('GitHub Actions builds and pushes GHCR image', () => {
  const workflowPath = '.github/workflows/docker-image.yml';
  if (!exists(workflowPath)) {
    throw new Error(`${workflowPath} is missing`);
  }
  const workflow = read(workflowPath);
  for (const required of [
    'docker/login-action',
    'docker/metadata-action',
    'docker/build-push-action',
    'docker/setup-qemu-action',
    'platforms: linux/amd64,linux/arm64',
    'npm test',
    'ghcr.io/${{ github.repository_owner }}/tmdb-proxy',
    "push: ${{ github.event_name != 'pull_request' }}",
  ]) {
    if (!workflow.includes(required)) {
      throw new Error(`workflow missing: ${required}`);
    }
  }
});

check('server redacts request query secrets from logs', () => {
  const server = read('server.js');
  if (!server.includes('sanitizeRequestUrl(req.url)')) {
    throw new Error('request logging does not sanitize req.url');
  }
  if (!server.includes('api_key|key|admin_key')) {
    throw new Error('query secret keys are not covered by redaction');
  }
});

check('repository ignores local secrets and runtime data', () => {
  const gitignore = read('.gitignore');
  for (const required of ['.env', '!.env.example', 'cache/', 'logs/']) {
    if (!gitignore.includes(required)) {
      throw new Error(`.gitignore missing: ${required}`);
    }
  }
});

let failed = 0;
for (const { name, fn } of checks) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(`  ${error.message}`);
  }
}

if (failed > 0) {
  process.exitCode = 1;
}
