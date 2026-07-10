const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ============== 版本信息 ==============
let PKG_VERSION = '0.0.0';
try {
  PKG_VERSION = require('./package.json').version || PKG_VERSION;
} catch {}

// ============== 配置 ==============
const PORT = process.env.PORT || 54321;
const IMAGE_CACHE_TTL = Number(process.env.IMAGE_CACHE_TTL) || 604800;
const API_CACHE_TTL = Number(process.env.API_CACHE_TTL) || 600;
const IMAGE_DISK_CACHE_ENABLED = process.env.IMAGE_DISK_CACHE_ENABLED !== 'false';
const IMAGE_DISK_CACHE_DIR = process.env.IMAGE_DISK_CACHE_DIR || '/tmp/tmdb-cache';
const IMAGE_DISK_CACHE_MAX_GB = Number(process.env.IMAGE_DISK_CACHE_MAX_GB) || 1;
const IMAGE_DISK_CACHE_MAX_BYTES = Math.floor(IMAGE_DISK_CACHE_MAX_GB * 1024 * 1024 * 1024);
const IMAGE_MEM_CACHE_MAX_MB = Number(process.env.IMAGE_MEM_CACHE_MAX_MB) || 100;
const IMAGE_MEM_CACHE_MAX_BYTES = IMAGE_MEM_CACHE_MAX_MB * 1024 * 1024;
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS) || 15000;
const API_CACHE_MAX_ITEMS = Number(process.env.API_CACHE_MAX_ITEMS) || 2000;
const REQUEST_LOG_CAP = 500;
const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 200;

// ============== Keep-Alive Agent ==============
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 80,
  maxFreeSockets: 20,
  timeout: FETCH_TIMEOUT_MS
});

// API 请求使用独立 agent，避免与图片请求的长连接互相干扰
const apiAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 30,
  maxFreeSockets: 5,
  timeout: FETCH_TIMEOUT_MS
});

// ============== 全局状态 ==============
const apiCache = new Map();
const apiCacheExpiry = new Map();
const REQUEST_LOGS = [];
const METRICS = {
  startTime: Date.now(),
  total: 0,
  image: { total: 0, mem_hit: 0, disk_hit: 0, miss: 0 },
  api: { total: 0, hit: 0, miss: 0 },
  other: { total: 0 },
  errors: { total: 0, api_502: 0, api_503: 0, timeout: 0 },
  byStatus: {},
  byMethod: {}
};

// ============== 图片内存缓存（LRU） ==============
class LRUCache {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.currentBytes = 0;
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, buffer, contentType) {
    const size = buffer.length;
    if (size > 2 * 1024 * 1024) return;

    if (this.cache.has(key)) {
      this.currentBytes -= this.cache.get(key).buffer.length;
      this.cache.delete(key);
    }

    while (this.currentBytes + size > this.maxBytes && this.cache.size > 0) {
      const firstKey = this.cache.keys().next().value;
      this.currentBytes -= this.cache.get(firstKey).buffer.length;
      this.cache.delete(firstKey);
    }

    this.cache.set(key, { buffer, contentType, size });
    this.currentBytes += size;
  }

  stats() {
    return { size: this.cache.size, bytes: this.currentBytes, maxBytes: this.maxBytes };
  }
}

const imageMemCache = new LRUCache(IMAGE_MEM_CACHE_MAX_BYTES);

// ============== 并发请求合并 ==============
const pendingRequests = new Map();

async function fetchWithDedup(key, fetchFn) {
  if (pendingRequests.has(key)) {
    return pendingRequests.get(key);
  }

  const promise = (async () => {
    try {
      return await fetchFn();
    } finally {
      pendingRequests.delete(key);
    }
  })();

  pendingRequests.set(key, promise);
  return promise;
}

// ============== API 缓存函数 ==============
function cacheGet(key) {
  const expiry = apiCacheExpiry.get(key);
  if (expiry && Date.now() > expiry) {
    apiCache.delete(key);
    apiCacheExpiry.delete(key);
    return null;
  }
  return apiCache.get(key) || null;
}

function cacheSet(key, value, ttlSeconds) {
  apiCache.set(key, value);
  apiCacheExpiry.set(key, Date.now() + ttlSeconds * 1000);

  // 超过上限时批量清理过期条目
  if (apiCache.size > API_CACHE_MAX_ITEMS) {
    const now = Date.now();
    let cleaned = 0;
    for (const [k, exp] of apiCacheExpiry) {
      if (exp < now) {
        apiCache.delete(k);
        apiCacheExpiry.delete(k);
        cleaned++;
      }
      if (cleaned > 200) break;
    }
    // 如果清理后仍然超限，删除最旧的
    if (apiCache.size > API_CACHE_MAX_ITEMS) {
      const firstKey = apiCache.keys().next().value;
      apiCache.delete(firstKey);
      apiCacheExpiry.delete(firstKey);
    }
  }
}

// ============== 工具函数 ==============
function getClientIP(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

function parseQuery(url) {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const params = {};
  url.slice(idx + 1).split('&').forEach(pair => {
    const [k, v] = pair.split('=');
    if (k) params[decodeURIComponent(k)] = v ? decodeURIComponent(v) : '';
  });
  return params;
}

function getPathname(url) {
  const idx = url.indexOf('?');
  return idx === -1 ? url : url.slice(0, idx);
}

function parseCookies(req) {
  const header = req.headers['cookie'] || '';
  const out = {};
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx > -1) {
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      if (k) out[k] = v;
    }
  });
  return out;
}

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

function getCacheFilePath(imagePath) {
  // 防止路径穿越：拒绝包含 .. 或绝对路径的输入
  const cleaned = imagePath.replace(/^\/+/, '');
  if (cleaned.includes('..') || path.isAbsolute(cleaned)) return null;

  const baseDir = path.resolve(IMAGE_DISK_CACHE_DIR);
  const target = path.resolve(baseDir, cleaned);

  // 校验解析后的路径仍在缓存目录内
  if (!target.startsWith(baseDir + path.sep) && target !== baseDir) return null;
  return target;
}

function getContentType(p) {
  const ext = path.extname(p).toLowerCase();
  const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
  return types[ext] || 'image/jpeg';
}

// ============== ETag 生成 ==============
function generateETag(buffer) {
  const len = buffer.length;
  const head = buffer.slice(0, Math.min(64, len));
  const tail = buffer.slice(Math.max(0, len - 64));
  let hash = len;
  for (let i = 0; i < head.length; i++) hash = ((hash << 5) - hash + head[i]) | 0;
  for (let i = 0; i < tail.length; i++) hash = ((hash << 5) - hash + tail[i]) | 0;
  return `"${len.toString(16)}-${(hash >>> 0).toString(16)}"`;
}

function checkNotModified(req, etag) {
  const ifNoneMatch = req.headers['if-none-match'];
  return ifNoneMatch && ifNoneMatch === etag;
}

// ============== Gzip 压缩 ==============
function shouldCompress(req) {
  const accept = req.headers['accept-encoding'] || '';
  return accept.includes('gzip');
}

function sendJSONCompressed(req, res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  const baseHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', ...headers };

  if (shouldCompress(req) && body.length > 1024) {
    zlib.gzip(body, (err, compressed) => {
      if (err) {
        res.writeHead(status, { ...baseHeaders, 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
      } else {
        res.writeHead(status, { ...baseHeaders, 'Content-Encoding': 'gzip', 'Content-Length': compressed.length });
        res.end(compressed);
      }
    });
  } else {
    res.writeHead(status, { ...baseHeaders, 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }
}

// 发送原始 JSON 字符串，不经过 parse+stringify，保留浮点精度等原始格式
function sendJSONRaw(req, res, status, rawText, headers = {}) {
  const baseHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', ...headers };
  const bodyBuf = Buffer.from(rawText, 'utf8');

  if (shouldCompress(req) && bodyBuf.length > 1024) {
    zlib.gzip(bodyBuf, (err, compressed) => {
      if (err) {
        res.writeHead(status, { ...baseHeaders, 'Content-Length': bodyBuf.length });
        res.end(bodyBuf);
      } else {
        res.writeHead(status, { ...baseHeaders, 'Content-Encoding': 'gzip', 'Content-Length': compressed.length });
        res.end(compressed);
      }
    });
  } else {
    res.writeHead(status, { ...baseHeaders, 'Content-Length': bodyBuf.length });
    res.end(bodyBuf);
  }
}

// ============== 日志与指标 ==============
function recordLog(entry) {
  REQUEST_LOGS.push(entry);
  if (REQUEST_LOGS.length > REQUEST_LOG_CAP) REQUEST_LOGS.shift();

  METRICS.total++;
  METRICS.byMethod[entry.method] = (METRICS.byMethod[entry.method] || 0) + 1;
  METRICS.byStatus[entry.status] = (METRICS.byStatus[entry.status] || 0) + 1;

  const cache = (entry.cache || '').toUpperCase();
  if (entry.type === 'image') {
    METRICS.image.total++;
    if (cache === 'MEM-HIT') METRICS.image.mem_hit++;
    else if (cache === 'DISK-HIT') METRICS.image.disk_hit++;
    else if (cache === 'MISS') METRICS.image.miss++;
  } else if (entry.type === 'api') {
    METRICS.api.total++;
    if (cache === 'HIT') METRICS.api.hit++;
    else if (cache === 'MISS') METRICS.api.miss++;
  } else {
    METRICS.other.total++;
  }

  if (entry.status >= 500) {
    METRICS.errors.total++;
    if (entry.status === 502) METRICS.errors.api_502++;
    else if (entry.status === 503) METRICS.errors.api_503++;
  }
}

// ============== HTTPS 请求（使用 HTTP/2，带自动解压和重试） ==============
const http2 = require('http2');

function httpsRequestOnce(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const origin = urlObj.origin;

    // 每次创建新 session，避免复用导致数据混乱
    const session = http2.connect(origin);
    let settled = false;

    const cleanup = () => {
      if (!session.closed && !session.destroyed) {
        session.close();
      }
    };

    session.on('error', (err) => {
      if (!settled) { settled = true; cleanup(); reject(err); }
    });

    const headers = {
      [http2.constants.HTTP2_HEADER_METHOD]: options.method || 'GET',
      [http2.constants.HTTP2_HEADER_PATH]: urlObj.pathname + urlObj.search,
      [http2.constants.HTTP2_HEADER_SCHEME]: 'https',
      [http2.constants.HTTP2_HEADER_AUTHORITY]: urlObj.host,
      'accept-encoding': 'identity',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'accept': 'application/json',
    };

    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) {
        if (k.toLowerCase() !== 'accept-encoding' && k.toLowerCase() !== 'user-agent') {
          headers[k.toLowerCase()] = v;
        }
      }
    }

    const req = session.request(headers);
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      if (!settled) {
        settled = true;
        req.close();
        cleanup();
        METRICS.errors.timeout++;
        reject(new Error('Request timeout'));
      }
    });

    const chunks = [];
    let responseHeaders = {};
    let statusCode = 200;

    req.on('response', (hdrs) => {
      responseHeaders = hdrs;
      statusCode = hdrs[http2.constants.HTTP2_HEADER_STATUS] || 200;
    });

    req.on('data', chunk => chunks.push(chunk));

    req.on('end', () => {
      if (settled) return;
      settled = true;
      // 使用 setImmediate 确保所有 data 事件都已处理
      setImmediate(() => {
        const raw = Buffer.concat(chunks);
        cleanup();

        // 自动检测 gzip magic bytes 并解压
        if (raw[0] === 0x1f && raw[1] === 0x8b) {
          zlib.gunzip(raw, (err, decoded) => {
            if (err) {
              console.error('H2 gunzip failed:', err.message, '| bodyLen:', raw.length);
              resolve({ status: statusCode, headers: responseHeaders, body: raw });
            } else {
              resolve({ status: statusCode, headers: responseHeaders, body: decoded });
            }
          });
          return;
        }

        const encoding = (responseHeaders['content-encoding'] || '').toLowerCase();
        if (encoding === 'deflate') {
          zlib.inflate(raw, (err, decoded) => {
            if (err) resolve({ status: statusCode, headers: responseHeaders, body: raw });
            else resolve({ status: statusCode, headers: responseHeaders, body: decoded });
          });
        } else if (encoding === 'br') {
          zlib.brotliDecompress(raw, (err, decoded) => {
            if (err) resolve({ status: statusCode, headers: responseHeaders, body: raw });
            else resolve({ status: statusCode, headers: responseHeaders, body: decoded });
          });
        } else {
          resolve({ status: statusCode, headers: responseHeaders, body: raw });
        }
      });
    });

    req.on('error', (err) => {
      if (!settled) { settled = true; cleanup(); reject(err); }
    });

    req.end();
  });
}

async function httpsRequest(url, options = {}) {
  let lastErr;
  for (let i = 0; i <= RETRY_COUNT; i++) {
    try {
      const resp = await httpsRequestOnce(url, options);
      // 5xx 时重试
      if (resp.status >= 500 && i < RETRY_COUNT) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (i + 1)));
        continue;
      }
      return resp;
    } catch (err) {
      lastErr = err;
      if (i < RETRY_COUNT) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (i + 1)));
      }
    }
  }
  throw lastErr;
}

// ============== 磁盘缓存 ==============
let diskCacheCleanupRunning = false;

async function getDirSize(dir) {
  let total = 0;
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const de of entries) {
      const full = path.join(dir, de.name);
      if (de.isFile()) { const s = await fs.promises.stat(full); total += s.size; }
      else if (de.isDirectory()) { total += await getDirSize(full); }
    }
  } catch {}
  return total;
}

async function collectFiles(dir, acc = []) {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const de of entries) {
      const full = path.join(dir, de.name);
      if (de.isFile()) { const s = await fs.promises.stat(full); acc.push({ path: full, size: s.size, atimeMs: s.atimeMs }); }
      else if (de.isDirectory()) { await collectFiles(full, acc); }
    }
  } catch {}
  return acc;
}

function cleanupCacheIfNeeded() {
  if (diskCacheCleanupRunning) return;
  diskCacheCleanupRunning = true;
  setImmediate(async () => {
    try {
      const total = await getDirSize(IMAGE_DISK_CACHE_DIR);
      if (total > IMAGE_DISK_CACHE_MAX_BYTES) {
        const files = await collectFiles(IMAGE_DISK_CACHE_DIR);
        files.sort((a, b) => a.atimeMs - b.atimeMs);
        let size = total;
        const target = IMAGE_DISK_CACHE_MAX_BYTES * 0.75;
        for (const f of files) {
          if (size <= target) break;
          try { await fs.promises.unlink(f.path); size -= f.size; } catch {}
        }
      }
    } catch {} finally {
      diskCacheCleanupRunning = false;
    }
  });
}

// ============== 响应辅助 ==============
function send404(res) {
  const html = `<!DOCTYPE html><html><head><title>404</title></head><body><h1>404 Not Found</h1></body></html>`;
  res.writeHead(404, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(html) });
  res.end(html);
}

// ============== 安全检查 ==============
function securityCheck(req) {
  const ua = req.headers['user-agent'] || '';
  // 允许无 UA 的内部请求（如 MoviePilot）
  if (!ua) return true;
  const lower = ua.toLowerCase();

  // 放行常见合法的社交/消息平台抓取器。
  // Telegram 在发送或编辑远程图片消息时，会由 Telegram 服务端抓取图片 URL；
  // 如果这里按 bot 关键字统一拦截，会导致 Bot API 返回 failed to get HTTP URL content。
  const allowedBots = [
    'telegrambot',
    'twitterbot',
    'facebookexternalhit',
    'discordbot',
    'slackbot',
    'whatsapp',
    'googlebot'
  ];
  if (allowedBots.some(s => lower.includes(s))) return true;

  const suspicious = ['scrapy', 'spider'];
  const isSuspicious = suspicious.some(s => lower.includes(s));
  return !(lower.includes('bot') || isSuspicious);
}

function getApiKey(req, query) {
  return req.headers['x-api-key'] || query.api_key || query.key;
}

function checkAdminKey(req, query) {
  const adminKey = (process.env.ADMIN_API_KEY || '').trim();
  if (!adminKey) return false;
  const cookies = parseCookies(req);
  const provided = req.headers['x-admin-key'] || query.admin_key || cookies['admin_key'] || '';
  return provided === adminKey;
}

// ============== 路由处理 ==============
async function handleHealth(req, res) {
  const memUsage = process.memoryUsage();
  sendJSONCompressed(req, res, 200, {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: PKG_VERSION,
    memory_mb: Math.round(memUsage.rss / 1024 / 1024),
    cache: {
      api_items: apiCache.size,
      image_mem_items: imageMemCache.stats().size,
      pending: pendingRequests.size
    }
  });
}

function getImageResponseHeaders(contentType, contentLength, etag, cacheStatus) {
  return {
    'Content-Type': contentType,
    'Content-Length': contentLength,
    'Cache-Control': `public, max-age=${IMAGE_CACHE_TTL}, immutable`,
    'ETag': etag,
    'X-Cache': cacheStatus,
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff'
  };
}

function getImageNotModifiedHeaders(etag) {
  return {
    'ETag': etag,
    'Cache-Control': `public, max-age=${IMAGE_CACHE_TTL}, immutable`,
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff'
  };
}

async function handleImage(req, res, pathname) {
  // 图片代理路径会被 Telegram、Discord、Slack 等服务端抓取器访问。
  // 不在这里按 UA 拦截 bot，避免远程图片消息被平台抓图失败。
  // 路径安全由路由前缀 /t/p/ 与 getCacheFilePath 的路径穿越检查保证。

  let cacheStatus = 'MISS';

  // 1. 检查内存缓存
  const memCached = imageMemCache.get(pathname);
  if (memCached) {
    cacheStatus = 'MEM-HIT';
    const etag = generateETag(memCached.buffer);

    if (checkNotModified(req, etag)) {
      res.writeHead(304, getImageNotModifiedHeaders(etag));
      res.end();
      return cacheStatus;
    }

    res.writeHead(200, getImageResponseHeaders(memCached.contentType, memCached.buffer.length, etag, 'MEM-HIT'));
    res.end(memCached.buffer);
    return cacheStatus;
  }

  // 2. 检查磁盘缓存
  if (IMAGE_DISK_CACHE_ENABLED) {
    const cacheFile = getCacheFilePath(pathname);
    if (cacheFile) {
      try {
        const buffer = await fs.promises.readFile(cacheFile);
        const contentType = getContentType(cacheFile);
        cacheStatus = 'DISK-HIT';

        imageMemCache.set(pathname, buffer, contentType);

        const etag = generateETag(buffer);

        if (checkNotModified(req, etag)) {
          res.writeHead(304, getImageNotModifiedHeaders(etag));
          res.end();
          return cacheStatus;
        }

        res.writeHead(200, getImageResponseHeaders(contentType, buffer.length, etag, 'DISK-HIT'));
        res.end(buffer);
        return cacheStatus;
      } catch {}
    }
  }

  // 3. 从上游获取（带请求合并）
  try {
    const upstream = await fetchWithDedup(pathname, async () => {
      const urlObj = new URL(`https://image.tmdb.org${pathname}`);
      const reqOptions = {
        hostname: urlObj.hostname,
        port: 443,
        path: urlObj.pathname,
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TMDB-Proxy/2.5)' },
        agent: httpsAgent,
        timeout: FETCH_TIMEOUT_MS
      };

      return new Promise((resolve, reject) => {
        const req = https.request(reqOptions, (r) => {
          const chunks = [];
          r.on('data', chunk => chunks.push(chunk));
          r.on('end', () => {
            resolve({ status: r.statusCode, headers: r.headers, buffer: Buffer.concat(chunks) });
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Image request timeout')); });
        req.end();
      });
    });

    if (upstream.status !== 200) {
      send404(res);
      return cacheStatus;
    }

    const contentType = upstream.headers['content-type'] || 'image/jpeg';
    const etag = generateETag(upstream.buffer);

    imageMemCache.set(pathname, upstream.buffer, contentType);

    res.writeHead(200, getImageResponseHeaders(contentType, upstream.buffer.length, etag, 'MISS'));
    res.end(upstream.buffer);

    // 异步写入磁盘缓存
    if (IMAGE_DISK_CACHE_ENABLED) {
      const cacheFile = getCacheFilePath(pathname);
      if (cacheFile) {
        ensureDir(path.dirname(cacheFile))
          .then(() => fs.promises.writeFile(cacheFile, upstream.buffer))
          .then(cleanupCacheIfNeeded)
          .catch(() => {});
      }
    }
  } catch (err) {
    console.error('Image proxy error:', err.message);
    send404(res);
  }
  return cacheStatus;
}

async function handleAPI(req, res, pathname, query) {
  if (!securityCheck(req)) { send404(res); return 'MISS'; }

  const apiKey = getApiKey(req, query);
  if (!apiKey) { send404(res); return 'MISS'; }

  // 缓存 key 使用统一的 server key，避免不同客户端 key 导致重复缓存
  const normalizedQuery = Object.assign({}, query);
  delete normalizedQuery.api_key;
  delete normalizedQuery.key;
  const cacheKey = `${pathname}:${JSON.stringify(normalizedQuery)}`;

  let cacheTTL = API_CACHE_TTL;
  if (pathname.includes('configuration')) cacheTTL = 3600;
  else if (pathname.includes('search')) cacheTTL = 300;
  else if (pathname.includes('popular') || pathname.includes('trending')) cacheTTL = 1800;
  else if (pathname.match(/\/(movie|tv)\/\d+/)) cacheTTL = 1800;

  const cached = cacheGet(cacheKey);
  if (cached) {
    const cachedStatus = cached.status || 200;
    const cachedText = cached.text || cached;
    sendJSONRaw(req, res, cachedStatus, cachedText, { 'Cache-Control': `public, max-age=${cacheTTL}`, 'X-Cache': 'HIT' });
    return 'HIT';
  }

  const params = new URLSearchParams(query);
  // 强制使用服务器配置的 API Key
  const serverApiKey = process.env.TMDB_API_KEY || apiKey;
  params.set('api_key', serverApiKey);
  // 还原逗号，TMDB API 需要原始逗号分隔
  const apiUrl = `https://api.tmdb.org${pathname}?${params.toString().replace(/%2C/gi, ',')}`;

  try {
    const upstream = await httpsRequest(apiUrl, { headers: { 'Accept': 'application/json' } });
    let text = upstream.body.toString('utf8');

    // 去掉 BOM
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

    if (!text.trim()) {
      sendJSONCompressed(req, res, 502, { error: 'Empty response from TMDB' });
      return 'MISS';
    }

    let valid = false;
    try { JSON.parse(text); valid = true; } catch (e) {
      // JSON 解析失败，尝试各种解压方式
      const buf = upstream.body;
      let decoded = null;

      try {
        decoded = await new Promise((ok, fail) => zlib.unzip(buf, (err, r) => err ? fail(err) : ok(r)));
      } catch (unzipErr) {
        console.error('unzip failed:', unzipErr.message, '| bodyLen:', buf.length);
      }

      if (!decoded) {
        try { decoded = await new Promise((ok, fail) => zlib.brotliDecompress(buf, (err, r) => err ? fail(err) : ok(r))); } catch {}
      }

      if (!decoded) {
        try { decoded = await new Promise((ok, fail) => zlib.inflateRaw(buf, (err, r) => err ? fail(err) : ok(r))); } catch {}
      }

      if (decoded) {
        text = decoded.toString('utf8');
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        try { JSON.parse(text); valid = true; } catch (e3) {
          console.error('JSON parse after decompress failed:', e3.message, '| decompressed len:', decoded.length);
        }
      }

      if (!valid) {
        console.error('JSON parse error:', e.message, '| status:', upstream.status, '| encoding:', upstream.headers['content-encoding'], '| bodyLen:', buf.length, '| hex:', buf.slice(0, 16).toString('hex'));
        sendJSONCompressed(req, res, 502, { error: 'Invalid JSON from TMDB' });
        return 'MISS';
      }
    }

    // 缓存原始 JSON 文本（保留浮点精度等原始格式）
    if (upstream.status === 200) {
      cacheSet(cacheKey, { status: 200, text }, cacheTTL);
    } else if (upstream.status === 404 || upstream.status === 204) {
      // 404/204 短期缓存，避免不存在的 ID 反复打 TMDB
      cacheSet(cacheKey, { status: upstream.status, text }, 30);
    }
    sendJSONRaw(req, res, upstream.status, text, { 'Cache-Control': `public, max-age=${cacheTTL}`, 'X-Cache': 'MISS' });
  } catch (err) {
    console.error('API proxy error:', err.message);
    sendJSONCompressed(req, res, 503, { error: 'Service unavailable', message: err.message });
  }
  return 'MISS';
}

async function handleAdminMetrics(req, res, query) {
  if (!checkAdminKey(req, query)) return send404(res);

  let diskBytes = 0;
  if (IMAGE_DISK_CACHE_ENABLED) {
    try { diskBytes = await getDirSize(IMAGE_DISK_CACHE_DIR); } catch {}
  }

  const memStats = imageMemCache.stats();

  sendJSONCompressed(req, res, 200, {
    metrics: METRICS,
    uptime_hours: ((Date.now() - METRICS.startTime) / 3600000).toFixed(1),
    mem_cache: {
      size: memStats.size,
      bytes: memStats.bytes,
      max_bytes: memStats.maxBytes,
      usage_pct: ((memStats.bytes / memStats.maxBytes) * 100).toFixed(1)
    },
    disk_cache: {
      enabled: IMAGE_DISK_CACHE_ENABLED,
      dir: IMAGE_DISK_CACHE_DIR,
      bytes: diskBytes,
      max_bytes: IMAGE_DISK_CACHE_MAX_BYTES,
      usage_pct: ((diskBytes / IMAGE_DISK_CACHE_MAX_BYTES) * 100).toFixed(1)
    },
    api_cache: {
      size: apiCache.size,
      max_items: API_CACHE_MAX_ITEMS
    }
  });
}

async function handleAdminLogs(req, res, query) {
  if (!checkAdminKey(req, query)) return send404(res);
  const limit = Math.min(1000, Math.max(1, Number(query.limit) || 200));
  sendJSONCompressed(req, res, 200, REQUEST_LOGS.slice(-limit));
}

async function handleAdminAuth(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;

  let data = {};
  try { data = JSON.parse(body); } catch {}

  const adminKey = process.env.ADMIN_API_KEY || process.env.TMDB_API_KEY || '';
  if (!adminKey) {
    return sendJSONCompressed(req, res, 500, { ok: false, message: 'Admin auth not configured' });
  }

  if (data.admin_key === adminKey) {
    sendJSONCompressed(req, res, 200, { ok: true });
  } else {
    sendJSONCompressed(req, res, 401, { ok: false });
  }
}

async function handleAdminStatus(req, res, query) {
  if (!checkAdminKey(req, query)) return send404(res);

  let diskBytes = 0;
  if (IMAGE_DISK_CACHE_ENABLED) {
    try { diskBytes = await getDirSize(IMAGE_DISK_CACHE_DIR); } catch {}
  }

  sendJSONCompressed(req, res, 200, {
    status: 'active',
    version: PKG_VERSION,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    cache: { api_size: apiCache.size, disk_bytes: diskBytes, mem_cache: imageMemCache.stats() },
    pending_requests: pendingRequests.size,
    timestamp: new Date().toISOString()
  });
}

async function handleAdminDashboard(res) {
  try {
    const html = await fs.promises.readFile(path.join(__dirname, 'admin-dashboard.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch { send404(res); }
}

async function handleAdminRandomBg(req, res, query) {
  if (!checkAdminKey(req, query)) return send404(res);

  const apiKey = process.env.TMDB_API_KEY || '';
  if (!apiKey) {
    return sendJSONCompressed(req, res, 200, { backdrop_path: null });
  }

  try {
    const apiUrl = `https://api.tmdb.org/3/movie/popular?api_key=${apiKey}&language=zh-CN&page=1`;
    const upstream = await httpsRequest(apiUrl, { headers: { 'Accept': 'application/json' } });
    let text = upstream.body.toString('utf8');
    let data;
    try { data = JSON.parse(text); } catch {
      const decoded = await new Promise((ok, fail) => zlib.gunzip(upstream.body, (err, r) => err ? fail(err) : ok(r)));
      data = JSON.parse(decoded.toString('utf8'));
    }

    if (data.results && data.results.length > 0) {
      const movies = data.results.filter(m => m.backdrop_path);
      if (movies.length > 0) {
        const pick = movies[Math.floor(Math.random() * movies.length)];
        return sendJSONCompressed(req, res, 200, { backdrop_path: pick.backdrop_path });
      }
    }
    sendJSONCompressed(req, res, 200, { backdrop_path: null });
  } catch (e) {
    sendJSONCompressed(req, res, 200, { backdrop_path: null });
  }
}

// ============== 清除缓存管理端点 ==============
async function handleAdminClearCache(req, res, query) {
  if (!checkAdminKey(req, query)) return send404(res);

  const type = query.type || 'all';
  const result = {};

  if (type === 'api' || type === 'all') {
    result.api_cleared = apiCache.size;
    apiCache.clear();
    apiCacheExpiry.clear();
  }

  if (type === 'mem' || type === 'all') {
    result.mem_cleared = imageMemCache.stats().size;
    imageMemCache.cache.clear();
    imageMemCache.currentBytes = 0;
  }

  if ((type === 'disk' || type === 'all') && IMAGE_DISK_CACHE_ENABLED) {
    let removed = 0;
    try {
      const files = await collectFiles(IMAGE_DISK_CACHE_DIR);
      for (const f of files) {
        try { await fs.promises.unlink(f.path); removed++; } catch {}
      }
    } catch {}
    result.disk_cleared = removed;
  }

  sendJSONCompressed(req, res, 200, { ok: true, ...result });
}

// ============== 主服务器 ==============
const server = http.createServer(async (req, res) => {
  const start = Date.now();

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Admin-Key',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

  const pathname = getPathname(req.url);
  const query = parseQuery(req.url);
  let type = 'other';
  let cacheStatus = '';

  try {
    if (pathname === '/health' || pathname === '/ping') {
      return handleHealth(req, res);
    }

    if (pathname.startsWith('/t/p/')) {
      type = 'image';
      cacheStatus = await handleImage(req, res, pathname);
      return;
    }

    if (pathname.startsWith('/3/')) {
      type = 'api';
      cacheStatus = await handleAPI(req, res, pathname, query);
      return;
    }

    // 管理端点
    if (pathname.startsWith('/admin/')) {
      if (pathname === '/admin/metrics') return handleAdminMetrics(req, res, query);
      if (pathname === '/admin/logs') return handleAdminLogs(req, res, query);
      if (pathname === '/admin/auth' && req.method === 'POST') return handleAdminAuth(req, res);
      if (pathname === '/admin/status') return handleAdminStatus(req, res, query);
      if (pathname === '/admin/dashboard') return handleAdminDashboard(res);
      if (pathname === '/admin/random-bg') return handleAdminRandomBg(req, res, query);
      if (pathname === '/admin/clear-cache') return handleAdminClearCache(req, res, query);
      return send404(res);
    }

    send404(res);
  } catch (err) {
    console.error('Server error:', err);
    sendJSONCompressed(req, res, 500, { error: 'Internal server error' });
  } finally {
    if (type !== 'other' || !pathname.startsWith('/admin')) {
      const entry = {
        time: Date.now(),
        ip: getClientIP(req),
        method: req.method,
        path: req.url,
        status: res.statusCode,
        durationMs: Date.now() - start,
        type,
        cache: cacheStatus
      };
      recordLog(entry);
      console.log(`[${new Date().toISOString()}] ${entry.ip} ${entry.method} ${entry.path} ${entry.status} ${entry.durationMs}ms ${entry.cache}`);
    }
  }
});

// ============== 定时清理过期 API 缓存 ==============
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [k, exp] of apiCacheExpiry) {
    if (exp < now) {
      apiCache.delete(k);
      apiCacheExpiry.delete(k);
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`[Cache GC] Cleaned ${cleaned} expired API cache entries`);
}, 300000); // 每 5 分钟

// ============== 启动 ==============
if (IMAGE_DISK_CACHE_ENABLED) ensureDir(IMAGE_DISK_CACHE_DIR).catch(console.error);

process.on('SIGTERM', () => { console.log('SIGTERM'); httpsAgent.destroy(); apiAgent.destroy(); process.exit(0); });
process.on('SIGINT', () => { console.log('SIGINT'); httpsAgent.destroy(); apiAgent.destroy(); process.exit(0); });

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎬 TMDB Proxy v${PKG_VERSION} on port ${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/health`);
  console.log(`⚡ Keep-Alive: enabled (max 80 sockets)`);
  console.log(`🗜️ Gzip: enabled (>1KB responses)`);
  console.log(`💾 Memory cache: ${IMAGE_MEM_CACHE_MAX_MB}MB | API cache: ${API_CACHE_MAX_ITEMS} items`);
  console.log(`🔄 Request dedup: enabled | Retry: ${RETRY_COUNT}x`);
  console.log(`📋 ETag/304: enabled`);
});

module.exports = server;
