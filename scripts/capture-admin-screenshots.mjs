/**
 * Capture admin dashboard screenshots for README/docs.
 * Usage: node scripts/capture-admin-screenshots.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'docs', 'images');
const ADMIN_KEY = process.env.ADMIN_API_KEY || 'docs-screenshot-admin';
const PORT = Number(process.env.SCREENSHOT_PORT || 54329);
const BASE = `http://127.0.0.1:${PORT}`;

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE}${urlPath}`, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
  });
}

async function waitForHealth(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const code = await httpGet('/health');
      if (code === 200) return;
    } catch {}
    await wait(200);
  }
  throw new Error('server health timeout');
}

async function ensureServer() {
  try {
    await waitForHealth(800);
    console.log('using already-running server on', PORT);
    return null;
  } catch {}

  const cacheDir = process.platform === 'win32'
    ? path.join('C:\\tmp', 'tmdb-cache')
    : '/tmp/tmdb-cache';
  fs.mkdirSync(cacheDir, { recursive: true });

  const env = {
    ...process.env,
    PORT: String(PORT),
    ADMIN_API_KEY: ADMIN_KEY,
    TMDB_API_KEY: process.env.TMDB_API_KEY || 'docs-screenshot-tmdb-key',
    IMAGE_DISK_CACHE_DIR: cacheDir,
    IMAGE_DISK_CACHE_ENABLED: 'true',
    COOKIE_SECURE: 'false',
    TRUST_PROXY: 'false',
  };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await waitForHealth();
  console.log('started local server on', PORT);
  return child;
}

async function getSharp() {
  const require = createRequire(import.meta.url);
  try {
    return require('sharp');
  } catch {
    await new Promise((resolve, reject) => {
      const npm = spawn(
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['install', '--no-save', 'sharp@0.34.2'],
        { cwd: root, stdio: 'inherit', shell: true }
      );
      npm.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`npm install sharp failed: ${code}`))));
    });
    return require('sharp');
  }
}

async function pngToWebp(pngPath, webpPath, { maxHeight } = {}) {
  const sharp = await getSharp();
  let pipeline = sharp(pngPath);
  if (maxHeight) {
    const meta = await pipeline.metadata();
    if (meta.height && meta.height > maxHeight) {
      pipeline = sharp(pngPath).extract({
        left: 0,
        top: 0,
        width: meta.width,
        height: maxHeight,
      });
    }
  }
  await pipeline.webp({ quality: 82, effort: 5 }).toFile(webpPath);
  fs.unlinkSync(pngPath);
}

async function preparePage(context) {
  await context.addInitScript(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem('tmdb_bg_mode', 'night');
      localStorage.setItem('tmdb_theme', 'aurora');
      localStorage.setItem('tmdb_alert_pct', '90');
    } catch {}
  });

  const page = await context.newPage();
  await page.goto(`${BASE}/admin/dashboard`, { waitUntil: 'networkidle' });

  const keyInput = page.locator('#key');
  if (await keyInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await keyInput.fill(ADMIN_KEY);
    await page.locator('#btn').click();
  }
  await page.locator('#content').waitFor({ state: 'visible', timeout: 10000 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'aurora';
    document.body.classList.add('bg-mode-night', 'wall-night-0');
    document.body.classList.remove('bg-mode-tmdb');
    const diskPath = document.getElementById('v_disk_path');
    if (diskPath) diskPath.textContent = '/tmp/tmdb-cache';
  });
  // Wait for metrics first paint / empty-state text.
  await page.locator('#v_total').waitFor({ state: 'visible' });
  await wait(1000);
  return page;
}

async function forceAlertPct(page, value = 90) {
  // Vue 3 v-model.number: set via native setter + input/change events.
  await page.locator('#alert_pct').evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  // Fallback: keyboard edit if still wrong
  const current = await page.locator('#alert_pct').inputValue();
  if (String(current) !== String(value)) {
    await page.locator('#alert_pct').click({ clickCount: 3 });
    await page.keyboard.type(String(value));
    await page.keyboard.press('Tab');
  }
  await wait(200);
  const finalVal = await page.locator('#alert_pct').inputValue();
  console.log('alert_pct value =', finalVal);
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const child = await ensureServer();
  const browser = await chromium.launch({ headless: true });

  try {
    // Desktop overview: taller viewport so action dock is fully visible.
    {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1100 },
        deviceScaleFactor: 1,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        reducedMotion: 'reduce',
      });
      const page = await preparePage(context);
      const png = path.join(outDir, '_tmp-desktop.png');
      await page.screenshot({ path: png, fullPage: false });
      await pngToWebp(png, path.join(outDir, 'admin-dashboard-desktop.webp'), { maxHeight: 1100 });
      console.log('wrote admin-dashboard-desktop.webp');

      await page.locator('#btn_details').click();
      await page.locator('#details_drawer.open').waitFor({ timeout: 5000 });
      await forceAlertPct(page, 90);
      await page.evaluate(() => {
        const diskPath = document.getElementById('v_disk_path');
        if (diskPath) diskPath.textContent = '/tmp/tmdb-cache';
      });
      await wait(400);
      const pngDetails = path.join(outDir, '_tmp-details.png');
      await page.screenshot({ path: pngDetails, fullPage: false });
      await pngToWebp(pngDetails, path.join(outDir, 'admin-dashboard-details.webp'));
      console.log('wrote admin-dashboard-details.webp');
      await context.close();
    }

    // Mobile overview.
    {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        reducedMotion: 'reduce',
      });
      const page = await preparePage(context);
      const png = path.join(outDir, '_tmp-mobile.png');
      await page.screenshot({ path: png, fullPage: false });
      await pngToWebp(png, path.join(outDir, 'admin-dashboard-mobile.webp'));
      console.log('wrote admin-dashboard-mobile.webp');
      await context.close();
    }
  } finally {
    await browser.close();
    if (child) child.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
