const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { version: VERSION } = require('./package.json');

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
const API_RESPONSE_MAX_MB = Number(process.env.API_RESPONSE_MAX_MB) || 5;
const IMAGE_RESPONSE_MAX_MB = Number(process.env.IMAGE_RESPONSE_MAX_MB) || 20;
const API_RESPONSE_MAX_BYTES = Math.floor(API_RESPONSE_MAX_MB * 1024 * 1024);
const IMAGE_RESPONSE_MAX_BYTES = Math.floor(IMAGE_RESPONSE_MAX_MB * 1024 * 1024);
const API_CACHE_MAX_ITEMS = Number(process.env.API_CACHE_MAX_ITEMS) || 2000;
const API_CACHE_MAX_MB = Number(process.env.API_CACHE_MAX_MB) || 50;
const API_CACHE_MAX_BYTES = Math.floor(API_CACHE_MAX_MB * 1024 * 1024);
const REQUEST_LOG_CAP = 500;
const API_RETRY_COUNT = Number(process.env.API_RETRY_COUNT) || 2;
const IMAGE_RETRY_COUNT = Number(process.env.IMAGE_RETRY_COUNT) || 1;
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS) || 150;
const DISK_CACHE_SIZE_TTL_MS = Number(process.env.DISK_CACHE_SIZE_TTL_MS) || 30000;
const DISK_CACHE_CLEANUP_INTERVAL_MS = Number(process.env.DISK_CACHE_CLEANUP_INTERVAL_MS) || 600000;
const ADMIN_AUTH_BODY_MAX_BYTES = 8 * 1024;
const ADMIN_AUTH_FAILURE_WINDOW_MS = 60 * 1000;
const ADMIN_AUTH_SOURCE_FAILURE_LIMIT = 5;
const ADMIN_AUTH_GLOBAL_FAILURE_LIMIT = 50;
const IMAGE_RATE_LIMIT_WINDOW_MS = Number(process.env.IMAGE_RATE_LIMIT_WINDOW_MS) || 60 * 1000;
const IMAGE_RATE_LIMIT_MAX = Number(process.env.IMAGE_RATE_LIMIT_MAX) || 600;
// CORS 允许来源：默认 '*' 保持现有行为；配置逗号分隔白名单后仅回显命中的 Origin
const CORS_ALLOW_ORIGIN = (process.env.CORS_ALLOW_ORIGIN || '*').trim();
const CORS_ALLOW_LIST = CORS_ALLOW_ORIGIN === '*'
  ? null
  : new Set(CORS_ALLOW_ORIGIN.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));

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
const apiCacheSizes = new Map();
let apiCacheBytes = 0;
const http2Sessions = new Map();
const REQUEST_LOGS = [];
const adminAuthFailures = new Map();
const imageRateBuckets = new Map();
let diskCacheBytesSnapshot = 0;
let diskCacheBytesSnapshotAt = 0;
let diskCacheBytesRefreshPromise = null;
const METRICS = {
  startTime: Date.now(),
  total: 0,
  image: { total: 0, mem_hit: 0, disk_hit: 0, dedup_hit: 0, miss: 0 },
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
    return { result: await pendingRequests.get(key), deduped: true };
  }

  const promise = (async () => {
    try {
      return await fetchFn();
    } finally {
      pendingRequests.delete(key);
    }
  })();

  pendingRequests.set(key, promise);
  return { result: await promise, deduped: false };
}

// ============== API 缓存函数 ==============
function apiCacheDelete(key) {
  if (!apiCache.has(key)) return;
  apiCacheBytes -= apiCacheSizes.get(key) || 0;
  if (apiCacheBytes < 0) apiCacheBytes = 0;
  apiCache.delete(key);
  apiCacheExpiry.delete(key);
  apiCacheSizes.delete(key);
}

function cacheGet(key) {
  const expiry = apiCacheExpiry.get(key);
  if (expiry && Date.now() > expiry) {
    apiCacheDelete(key);
    return null;
  }
  return apiCache.get(key) || null;
}

function cacheSet(key, value, ttlSeconds) {
  // 估算条目字节大小（JSON 序列化长度），用于字节维度上限
  let size;
  try { size = Buffer.byteLength(JSON.stringify(value)); } catch { size = 0; }

  apiCacheDelete(key);
  apiCache.set(key, value);
  apiCacheExpiry.set(key, Date.now() + ttlSeconds * 1000);
  apiCacheSizes.set(key, size);
  apiCacheBytes += size;

  // 超过条目或字节上限时批量清理过期条目
  if (apiCache.size > API_CACHE_MAX_ITEMS || apiCacheBytes > API_CACHE_MAX_BYTES) {
    const now = Date.now();
    let cleaned = 0;
    for (const [k, exp] of apiCacheExpiry) {
      if (exp < now) {
        apiCacheDelete(k);
        cleaned++;
      }
      if (cleaned > 200) break;
    }
    // 如果清理后仍然超限（条目或字节），从最旧的开始删除
    while ((apiCache.size > API_CACHE_MAX_ITEMS || apiCacheBytes > API_CACHE_MAX_BYTES)
           && apiCache.size > 0) {
      const firstKey = apiCache.keys().next().value;
      apiCacheDelete(firstKey);
    }
  }
}

// ============== 工具函数 ==============
function getClientIP(req) {
  if ((process.env.TRUST_PROXY || '').toLowerCase() === 'true') {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();
    if (req.headers['x-real-ip']) return req.headers['x-real-ip'];
  }
  return req.socket?.remoteAddress || 'unknown';
}

function hasForwardedClientIP(req) {
  return Boolean(req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
}

function normalizeIP(ip) {
  return String(ip || '').replace(/^::ffff:/, '');
}

function isLocalOrPrivateIP(ip) {
  const value = normalizeIP(ip);
  return value === '127.0.0.1'
    || value === '::1'
    || value === 'localhost'
    || value.startsWith('10.')
    || value.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(value);
}

function resolveCorsOrigin(req) {
  if (!CORS_ALLOW_LIST) return '*';
  const origin = req.headers.origin;
  if (origin && CORS_ALLOW_LIST.has(String(origin).toLowerCase())) return origin;
  return null;
}

function corsHeaders(req) {
  const origin = resolveCorsOrigin(req);
  const headers = {};
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  if (origin !== '*') headers.Vary = 'Origin';
  return headers;
}

function enforceResponseLimit(currentBytes, maxBytes) {
  return currentBytes <= maxBytes;
}

function responseWithinLimit(buffer, maxBytes) {
  return Buffer.isBuffer(buffer) && enforceResponseLimit(buffer.length, maxBytes);
}

function shouldRecordRequest(req, pathname, type) {
  if (pathname === '/health' || pathname === '/ping') return false;
  if (type === 'other' && pathname.startsWith('/admin')) return false;
  if (isLocalOrPrivateIP(getClientIP(req))) return false;
  return type !== 'other' || !pathname.startsWith('/admin');
}

function parseQuery(url) {
  const params = {};
  try {
    const parsed = new URL(url, 'http://localhost');
    for (const [key, value] of parsed.searchParams) params[key] = value;
  } catch {}
  return params;
}

function getPathname(url) {
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    const idx = url.indexOf('?');
    return idx === -1 ? url : url.slice(0, idx);
  }
}

function sanitizeRequestUrl(url) {
  const raw = String(url || '');
  const hashIndex = raw.indexOf('#');
  const withoutHash = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : raw.slice(hashIndex);
  const queryIndex = withoutHash.indexOf('?');
  if (queryIndex === -1) return raw;

  const prefix = withoutHash.slice(0, queryIndex + 1);
  const query = withoutHash.slice(queryIndex + 1);
  const secretKeys = new Set(['api_key', 'key', 'admin_key']);
  const redacted = query.split('&').map(part => {
    const equalsIndex = part.indexOf('=');
    const rawName = equalsIndex === -1 ? part : part.slice(0, equalsIndex);
    let decodedName = rawName;
    try {
      decodedName = decodeURIComponent(rawName.replace(/\+/g, ' '));
    } catch {}
    if (secretKeys.has(decodedName.toLowerCase())) {
      return `${rawName}=[REDACTED]`;
    }
    return part;
  });
  return `${prefix}${redacted.join('&')}${hash}`;
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

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function signAdminSession(expiresAt) {
  const adminKey = (process.env.ADMIN_API_KEY || '').trim();
  return crypto.createHmac('sha256', adminKey).update(String(expiresAt)).digest('base64url');
}

function createAdminSessionToken(maxAgeSeconds) {
  const expiresAt = Math.floor(Date.now() / 1000) + maxAgeSeconds;
  return `${expiresAt}.${signAdminSession(expiresAt)}`;
}

function verifyAdminSessionToken(token) {
  const adminKey = (process.env.ADMIN_API_KEY || '').trim();
  if (!adminKey || typeof token !== 'string') return false;
  const [expiresAt, signature, extra] = token.split('.');
  if (!expiresAt || !signature || extra) return false;
  const expires = Number(expiresAt);
  if (!Number.isSafeInteger(expires) || expires < Math.floor(Date.now() / 1000)) return false;
  return timingSafeEqualString(signature, signAdminSession(expiresAt));
}

function cookieOptions(maxAgeSeconds) {
  const parts = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${maxAgeSeconds}`);
  if ((process.env.COOKIE_SECURE || '').toLowerCase() === 'true') parts.push('Secure');
  return parts.join('; ');
}

function isSameOriginAdminMutation(req) {
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite === 'cross-site' || fetchSite === 'same-site') return false;
  if (fetchSite === 'same-origin') return true;

  const origin = req.headers.origin;
  if (!origin) return true;

  try {
    const originUrl = new URL(origin);
    if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') return false;
    const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    const allowedHosts = [forwardedHost, req.headers.host]
      .filter(Boolean)
      .map(host => String(host).toLowerCase());
    return allowedHosts.includes(originUrl.host.toLowerCase());
  } catch {
    return false;
  }
}

function adminAuthFailureBucket(key, now = Date.now()) {
  const fresh = (adminAuthFailures.get(key) || []).filter(ts => now - ts < ADMIN_AUTH_FAILURE_WINDOW_MS);
  adminAuthFailures.set(key, fresh);
  return fresh;
}

function adminAuthSource(req) {
  return normalizeIP(getClientIP(req));
}

function isAdminAuthRateLimited(req) {
  const now = Date.now();
  return adminAuthFailureBucket(`source:${adminAuthSource(req)}`, now).length >= ADMIN_AUTH_SOURCE_FAILURE_LIMIT
    || adminAuthFailureBucket('global', now).length >= ADMIN_AUTH_GLOBAL_FAILURE_LIMIT;
}

function recordFailedAdminAuth(req) {
  const now = Date.now();
  adminAuthFailureBucket(`source:${adminAuthSource(req)}`, now).push(now);
  adminAuthFailureBucket('global', now).push(now);
}

function resetAdminAuthFailures(req) {
  adminAuthFailures.delete(`source:${adminAuthSource(req)}`);
}

// 图片端点按客户端 IP 的滑动窗口限流（本地/内网 IP 不限流）
function isImageRateLimited(req, now = Date.now()) {
  const ip = normalizeIP(getClientIP(req));
  if (!ip || ip === 'unknown' || isLocalOrPrivateIP(ip)) return false;
  const fresh = (imageRateBuckets.get(ip) || []).filter(ts => now - ts < IMAGE_RATE_LIMIT_WINDOW_MS);
  if (fresh.length >= IMAGE_RATE_LIMIT_MAX) {
    imageRateBuckets.set(ip, fresh);
    return true;
  }
  fresh.push(now);
  imageRateBuckets.set(ip, fresh);
  // 惰性清理：桶数量偏大时移除已过期的空桶
  if (imageRateBuckets.size > 5000) {
    for (const [key, arr] of imageRateBuckets) {
      if (!arr.length || now - arr[arr.length - 1] >= IMAGE_RATE_LIMIT_WINDOW_MS) imageRateBuckets.delete(key);
    }
  }
  return false;
}

function readRequestBody(req, maxBytes) {
  const contentLength = Number(req.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    req.resume();
    const error = new Error('Request body too large');
    error.code = 'BODY_TOO_LARGE';
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let overflow = false;

    req.on('data', chunk => {
      if (overflow) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        overflow = true;
        req.resume();
        const error = new Error('Request body too large');
        error.code = 'BODY_TOO_LARGE';
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!overflow) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', error => {
      if (!overflow) reject(error);
    });
  });
}

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

function getCacheFilePath(imagePath) {
  if (!isSafeImagePath(imagePath)) throw new Error('Unsafe image path');

  const base = path.resolve(IMAGE_DISK_CACHE_DIR);
  const target = path.resolve(base, imagePath.replace(/^\/+/, ''));
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error('Unsafe cache path');
  }
  return target;
}

function isSafeImagePath(imagePath) {
  if (typeof imagePath !== 'string') return false;
  if (!imagePath.startsWith('/t/p/')) return false;
  if (imagePath.includes('\\') || imagePath.includes('\0')) return false;
  const segments = imagePath.split('/');
  if (segments.some(part => part === '..')) return false;
  return /^\/t\/p\/[A-Za-z0-9._/-]+$/.test(imagePath);
}

function getContentType(p) {
  const ext = path.extname(p).toLowerCase();
  const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
  return types[ext] || 'image/jpeg';
}

// ============== ETag 生成 ==============
function generateETag(buffer) {
  const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 20);
  return `"${buffer.length.toString(16)}-${hash}"`;
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
  const { cors, ...responseHeaders } = headers;
  const baseHeaders = { 'Content-Type': 'application/json; charset=utf-8', ...responseHeaders };
  if (cors !== false) Object.assign(baseHeaders, corsHeaders(req));

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

function sendAdminJSONCompressed(req, res, status, data, headers = {}) {
  sendJSONCompressed(req, res, status, data, { ...headers, cors: false });
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
    else if (cache === 'DEDUP-HIT') METRICS.image.dedup_hit++;
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

function redactLogUrl(url) {
  return sanitizeRequestUrl(String(url || '')).replace(/=\[REDACTED\]/g, '=***');
}

function recordUpstreamRequest({ kind, method = 'GET', url, status = 0, durationMs = 0, bytes = 0, error = '' }) {
  const safeKind = kind === 'api' ? 'api' : 'image';
  const entry = {
    time: Date.now(),
    ip: 'upstream',
    method,
    path: redactLogUrl(url),
    status,
    durationMs,
    type: `upstream:${safeKind}`,
    cache: 'UPSTREAM',
    bytes
  };
  if (error) entry.error = String(error).slice(0, 200);
  recordLog(entry);
  const suffix = error ? ` error=${entry.error}` : ` bytes=${bytes}`;
  console.log(`[${new Date(entry.time).toISOString()}] upstream ${method} ${entry.path} ${status} ${durationMs}ms ${entry.cache}${suffix}`);
  return entry;
}

// ============== HTTPS 请求（使用 HTTP/2，带自动解压和重试） ==============
const http2 = require('http2');

function getHttp2Session(origin) {
  const existing = http2Sessions.get(origin);
  if (existing && !existing.closed && !existing.destroyed) {
    return existing;
  }

  const session = http2.connect(origin);
  http2Sessions.set(origin, session);

  const clearSession = () => {
    if (http2Sessions.get(origin) === session) {
      http2Sessions.delete(origin);
    }
  };

  session.on('close', clearSession);
  session.on('error', clearSession);
  session.on('goaway', clearSession);

  return session;
}

function httpsRequestOnce(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const origin = urlObj.origin;
    const session = getHttp2Session(origin);
    let settled = false;

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

    let req;
    try {
      req = session.request(headers);
    } catch (err) {
      reject(err);
      return;
    }
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      if (!settled) {
        settled = true;
        req.close();
        METRICS.errors.timeout++;
        reject(new Error('Request timeout'));
      }
    });

    const chunks = [];
    let totalBytes = 0;
    let responseHeaders = {};
    let statusCode = 200;

    req.on('response', (hdrs) => {
      responseHeaders = hdrs;
      statusCode = hdrs[http2.constants.HTTP2_HEADER_STATUS] || 200;
    });

    req.on('data', chunk => {
      if (settled) return;
      totalBytes += chunk.length;
      if (!enforceResponseLimit(totalBytes, options.maxBytes || API_RESPONSE_MAX_BYTES)) {
        settled = true;
        req.close();
        reject(new Error('Upstream API response too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      // 使用 setImmediate 确保所有 data 事件都已处理
      setImmediate(() => {
        const raw = Buffer.concat(chunks);

        // 自动检测 gzip magic bytes 并解压
        if (raw[0] === 0x1f && raw[1] === 0x8b) {
          zlib.gunzip(raw, (err, decoded) => {
            if (err) {
              console.error('H2 gunzip failed:', err.message, '| bodyLen:', raw.length);
              resolve({ status: statusCode, headers: responseHeaders, body: raw });
            } else if (!responseWithinLimit(decoded, options.maxBytes || API_RESPONSE_MAX_BYTES)) {
              reject(new Error('Decoded upstream API response too large'));
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
            else if (!responseWithinLimit(decoded, options.maxBytes || API_RESPONSE_MAX_BYTES)) reject(new Error('Decoded upstream API response too large'));
            else resolve({ status: statusCode, headers: responseHeaders, body: decoded });
          });
        } else if (encoding === 'br') {
          zlib.brotliDecompress(raw, (err, decoded) => {
            if (err) resolve({ status: statusCode, headers: responseHeaders, body: raw });
            else if (!responseWithinLimit(decoded, options.maxBytes || API_RESPONSE_MAX_BYTES)) reject(new Error('Decoded upstream API response too large'));
            else resolve({ status: statusCode, headers: responseHeaders, body: decoded });
          });
        } else {
          resolve({ status: statusCode, headers: responseHeaders, body: raw });
        }
      });
    });

    req.on('error', (err) => {
      if (!settled) { settled = true; reject(err); }
    });

    try {
      req.end();
    } catch (err) {
      if (!settled) {
        settled = true;
        reject(err);
      }
    }
  });
}

function delayRetry(attempt) {
  return new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
}

async function httpsRequest(url, options = {}) {
  let lastErr;
  for (let i = 0; i <= API_RETRY_COUNT; i++) {
    try {
      const resp = await httpsRequestOnce(url, options);
      if (resp.status >= 500 && i < API_RETRY_COUNT) {
        await delayRetry(i);
        continue;
      }
      return resp;
    } catch (err) {
      lastErr = err;
      if (i < API_RETRY_COUNT) await delayRetry(i);
    }
  }
  throw lastErr;
}

function httpsImageRequestOnce(options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = https.request(options, (r) => {
      const chunks = [];
      let totalBytes = 0;
      r.on('data', chunk => {
        if (settled) return;
        totalBytes += chunk.length;
        if (!enforceResponseLimit(totalBytes, options.maxBytes || IMAGE_RESPONSE_MAX_BYTES)) {
          settled = true;
          reject(new Error('Upstream image response too large'));
          req.destroy(new Error('Upstream image response too large'));
          return;
        }
        chunks.push(chunk);
      });
      r.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ status: r.statusCode, headers: r.headers, buffer: Buffer.concat(chunks) });
      });
      r.on('error', (err) => {
        if (settled) return;
        settled = true;
        req.destroy();
        reject(err);
      });
    });
    req.setTimeout(options.timeout || FETCH_TIMEOUT_MS, () => {
      if (settled) return;
      settled = true;
      METRICS.errors.timeout++;
      req.destroy();
      reject(new Error('Image request timeout'));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    req.end();
  });
}

async function httpsImageRequest(options) {
  let lastErr;
  for (let i = 0; i <= IMAGE_RETRY_COUNT; i++) {
    try {
      const resp = await httpsImageRequestOnce(options);
      if (resp.status >= 500 && i < IMAGE_RETRY_COUNT) {
        await delayRetry(i);
        continue;
      }
      return resp;
    } catch (err) {
      lastErr = err;
      if (i < IMAGE_RETRY_COUNT) await delayRetry(i);
    }
  }
  throw lastErr;
}

// ============== 磁盘缓存 ==============
let diskCacheCleanupRunning = false;
let diskWriteCounter = 0;

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
      if (de.isFile()) {
        const s = await fs.promises.stat(full);
        acc.push({ path: full, size: s.size, mtimeMs: s.mtimeMs, atimeMs: s.atimeMs });
      } else if (de.isDirectory()) {
        await collectFiles(full, acc);
      }
    }
  } catch {}
  return acc;
}

async function getDiskCacheBytes(force = false) {
  if (!IMAGE_DISK_CACHE_ENABLED) return 0;

  const now = Date.now();
  const isFresh = diskCacheBytesSnapshotAt && (now - diskCacheBytesSnapshotAt) < DISK_CACHE_SIZE_TTL_MS;
  if (!force && isFresh) return diskCacheBytesSnapshot;

  if (!diskCacheBytesRefreshPromise) {
    diskCacheBytesRefreshPromise = (async () => {
      const bytes = await getDirSize(IMAGE_DISK_CACHE_DIR);
      diskCacheBytesSnapshot = bytes;
      diskCacheBytesSnapshotAt = Date.now();
      return bytes;
    })().finally(() => {
      diskCacheBytesRefreshPromise = null;
    });
  }

  if (force || (!diskCacheBytesSnapshotAt && !diskCacheBytesSnapshot)) {
    return diskCacheBytesRefreshPromise;
  }

  return diskCacheBytesSnapshot;
}

function setDiskCacheBytesSnapshot(bytes) {
  diskCacheBytesSnapshot = Math.max(0, bytes);
  diskCacheBytesSnapshotAt = Date.now();
}

function cleanupCacheIfNeeded() {
  if (diskCacheCleanupRunning) return;
  diskCacheCleanupRunning = true;
  setImmediate(async () => {
    try {
      // 快速路径：若快照仍新鲜且明显低于阈值，跳过全量扫描
      const snapshotFresh = diskCacheBytesSnapshotAt
        && (Date.now() - diskCacheBytesSnapshotAt) < DISK_CACHE_SIZE_TTL_MS;
      if (snapshotFresh && diskCacheBytesSnapshot < IMAGE_DISK_CACHE_MAX_BYTES * 0.9) {
        return;
      }
      const total = await getDirSize(IMAGE_DISK_CACHE_DIR);
      if (total > IMAGE_DISK_CACHE_MAX_BYTES) {
        const files = await collectFiles(IMAGE_DISK_CACHE_DIR);
        files.sort((a, b) => Math.min(a.atimeMs, a.mtimeMs) - Math.min(b.atimeMs, b.mtimeMs));
        let size = total;
        const target = IMAGE_DISK_CACHE_MAX_BYTES * 0.75;
        for (const f of files) {
          if (size <= target) break;
          try { await fs.promises.unlink(f.path); size -= f.size; } catch {}
        }
        setDiskCacheBytesSnapshot(size);
        return;
      }
      setDiskCacheBytesSnapshot(total);
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
  const suspicious = ['scrapy', 'spider'];
  const isSuspicious = suspicious.some(s => lower.includes(s));
  return !((lower.includes('bot') && !lower.includes('googlebot')) || isSuspicious);
}

function getApiKey(req, query) {
  return (process.env.TMDB_API_KEY || req.headers['x-api-key'] || query.api_key || query.key || '').trim();
}

function getApiCacheKey(pathname, query, apiKey = '') {
  const entries = Object.entries(query)
    .filter(([key]) => key !== 'api_key' && key !== 'key')
    .sort(([a], [b]) => a.localeCompare(b));
  const serverApiKey = (process.env.TMDB_API_KEY || '').trim();
  const clientApiKey = String(apiKey || query.api_key || query.key || '').trim();
  const keyScope = serverApiKey || !clientApiKey
    ? ''
    : `:clientKey:${crypto.createHash('sha256').update(clientApiKey).digest('hex').slice(0, 16)}`;
  return `${pathname}:${JSON.stringify(entries)}${keyScope}`;
}

function checkAdminKey(req, query) {
  const adminKey = (process.env.ADMIN_API_KEY || '').trim();
  if (!adminKey) return false;
  const provided = req.headers['x-admin-key'] || query.admin_key || '';
  if (provided) return timingSafeEqualString(provided, adminKey);
  return verifyAdminSessionToken(parseCookies(req)['admin_session']);
}

// ============== 路由处理 ==============
async function handleHealth(req, res) {
  const memUsage = process.memoryUsage();
  sendJSONCompressed(req, res, 200, {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: VERSION,
    memory_mb: Math.round(memUsage.rss / 1024 / 1024),
    cache: {
      api_items: apiCache.size,
      image_mem_items: imageMemCache.stats().size,
      pending: pendingRequests.size
    }
  });
}

async function handleImage(req, res, pathname) {
  if (!securityCheck(req)) return send404(res);
  if (!isSafeImagePath(pathname)) return send404(res);

  if (isImageRateLimited(req)) {
    const retryAfter = Math.ceil(IMAGE_RATE_LIMIT_WINDOW_MS / 1000);
    res.writeHead(429, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Retry-After': String(retryAfter),
      ...corsHeaders(req)
    });
    res.end('Too Many Requests');
    return 'MISS';
  }

  let cacheStatus = 'MISS';

  // 1. 检查内存缓存
  const memCached = imageMemCache.get(pathname);
  if (memCached) {
    cacheStatus = 'MEM-HIT';
    const etag = generateETag(memCached.buffer);

    if (checkNotModified(req, etag)) {
      res.writeHead(304, {
        'ETag': etag,
        'Cache-Control': `public, max-age=${IMAGE_CACHE_TTL}, immutable`,
        ...corsHeaders(req)
      });
      res.end();
      return cacheStatus;
    }

    res.writeHead(200, {
      'Content-Type': memCached.contentType,
      'Content-Length': memCached.buffer.length,
      'Cache-Control': `public, max-age=${IMAGE_CACHE_TTL}, immutable`,
      'ETag': etag,
      'X-Cache': 'MEM-HIT',
      ...corsHeaders(req)
    });
    res.end(memCached.buffer);
    return cacheStatus;
  }

  // 2. 检查磁盘缓存
  if (IMAGE_DISK_CACHE_ENABLED) {
    const cacheFile = getCacheFilePath(pathname);
    try {
      const buffer = await fs.promises.readFile(cacheFile);
      const contentType = getContentType(cacheFile);
      cacheStatus = 'DISK-HIT';

      imageMemCache.set(pathname, buffer, contentType);

      const etag = generateETag(buffer);

      if (checkNotModified(req, etag)) {
        res.writeHead(304, {
          'ETag': etag,
          'Cache-Control': `public, max-age=${IMAGE_CACHE_TTL}, immutable`,
          ...corsHeaders(req)
        });
        res.end();
        return cacheStatus;
      }

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': buffer.length,
        'Cache-Control': `public, max-age=${IMAGE_CACHE_TTL}, immutable`,
        'ETag': etag,
        'X-Cache': 'DISK-HIT',
        ...corsHeaders(req)
      });
      res.end(buffer);
      return cacheStatus;
    } catch {}
  }

  // 3. 从上游获取（带请求合并）
  try {
    const { result: upstream, deduped } = await fetchWithDedup(pathname, async () => {
      const urlObj = new URL(`https://image.tmdb.org${pathname}`);
      const upstreamUrl = urlObj.toString();
      const reqOptions = {
        hostname: urlObj.hostname,
        port: 443,
        path: urlObj.pathname,
        method: 'GET',
        headers: { 'User-Agent': `Mozilla/5.0 (compatible; TMDB-Proxy/${VERSION})` },
        agent: httpsAgent,
        timeout: FETCH_TIMEOUT_MS
      };

      const upstreamStart = Date.now();
      try {
        const response = await httpsImageRequest(reqOptions);
        recordUpstreamRequest({
          kind: 'image',
          method: 'GET',
          url: upstreamUrl,
          status: response.status,
          durationMs: Date.now() - upstreamStart,
          bytes: response.buffer ? response.buffer.length : 0
        });
        return response;
      } catch (error) {
        recordUpstreamRequest({
          kind: 'image',
          method: 'GET',
          url: upstreamUrl,
          status: 0,
          durationMs: Date.now() - upstreamStart,
          error: error.message
        });
        throw error;
      }
    });

    if (upstream.status !== 200) {
      send404(res);
      return cacheStatus;
    }

    cacheStatus = deduped ? 'DEDUP-HIT' : 'MISS';
    const contentType = upstream.headers['content-type'] || 'image/jpeg';
    const etag = generateETag(upstream.buffer);

    imageMemCache.set(pathname, upstream.buffer, contentType);

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': upstream.buffer.length,
      'Cache-Control': `public, max-age=${IMAGE_CACHE_TTL}, immutable`,
      'ETag': etag,
      'X-Cache': deduped ? 'DEDUP-HIT' : 'MISS',
      ...corsHeaders(req)
    });
    res.end(upstream.buffer);

    // 异步写入磁盘缓存（先写临时文件再 rename，保证原子性）
    if (IMAGE_DISK_CACHE_ENABLED) {
      const cacheFile = getCacheFilePath(pathname);
      const tmpFile = `${cacheFile}.${process.pid}.${(diskWriteCounter = (diskWriteCounter + 1) >>> 0)}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      ensureDir(path.dirname(cacheFile))
        .then(() => fs.promises.writeFile(tmpFile, upstream.buffer))
        .then(() => fs.promises.rename(tmpFile, cacheFile))
        .then(cleanupCacheIfNeeded)
        .catch(() => { fs.promises.unlink(tmpFile).catch(() => {}); });
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

  const cacheKey = getApiCacheKey(pathname, query, apiKey);

  let cacheTTL = API_CACHE_TTL;
  if (pathname.includes('configuration')) cacheTTL = 3600;
  else if (pathname.includes('search')) cacheTTL = 300;
  else if (pathname.includes('popular') || pathname.includes('trending')) cacheTTL = 1800;
  else if (pathname.match(/\/(movie|tv)\/\d+/)) cacheTTL = 1800;

  const cached = cacheGet(cacheKey);
  if (cached) {
    sendJSONCompressed(req, res, 200, cached, { 'Cache-Control': `public, max-age=${cacheTTL}`, 'X-Cache': 'HIT' });
    return 'HIT';
  }

  const params = new URLSearchParams(query);
  params.set('api_key', apiKey);
  // 仅对 TMDB 中确实使用逗号分隔列表的参数还原逗号，
  // 避免误伤查询值本身含逗号的参数（如 query/标题）
  const COMMA_LIST_PARAMS = new Set([
    'append_to_response', 'with_genres', 'without_genres',
    'with_companies', 'without_companies', 'with_keywords', 'without_keywords',
    'with_people', 'with_cast', 'with_crew', 'with_watch_providers',
    'with_watch_monetization_types', 'with_release_type', 'with_origin_country'
  ]);
  const queryString = Array.from(params.entries()).map(([key, value]) => {
    const encodedKey = encodeURIComponent(key);
    let encodedValue = encodeURIComponent(value);
    if (COMMA_LIST_PARAMS.has(key)) {
      encodedValue = encodedValue.replace(/%2C/gi, ',');
    }
    return `${encodedKey}=${encodedValue}`;
  }).join('&');
  const apiUrl = `https://api.tmdb.org${pathname}?${queryString}`;

  try {
    const upstreamStart = Date.now();
    let upstream;
    try {
      upstream = await httpsRequest(apiUrl, { headers: { 'Accept': 'application/json' } });
      recordUpstreamRequest({
        kind: 'api',
        method: 'GET',
        url: apiUrl,
        status: upstream.status,
        durationMs: Date.now() - upstreamStart,
        bytes: upstream.body ? upstream.body.length : 0
      });
    } catch (error) {
      recordUpstreamRequest({
        kind: 'api',
        method: 'GET',
        url: apiUrl,
        status: 0,
        durationMs: Date.now() - upstreamStart,
        error: error.message
      });
      throw error;
    }
    let text = upstream.body.toString('utf8');

    // 去掉 BOM
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

    if (!text.trim()) {
      sendJSONCompressed(req, res, 502, { error: 'Empty response from TMDB' });
      return 'MISS';
    }

    let data;
    try { data = JSON.parse(text); } catch (e) {
      // JSON 解析失败，尝试各种解压方式
      const buf = upstream.body;
      let decoded = null;

      // 使用 zlib.unzip 自动检测 gzip/deflate
      try {
        decoded = await new Promise((ok, fail) => zlib.unzip(buf, (err, r) => err ? fail(err) : ok(r)));
      } catch (unzipErr) {
        console.error('unzip failed:', unzipErr.message, '| bodyLen:', buf.length);
      }

      // 尝试 brotli
      if (!decoded) {
        try { decoded = await new Promise((ok, fail) => zlib.brotliDecompress(buf, (err, r) => err ? fail(err) : ok(r))); } catch {}
      }

      // 尝试 raw deflate
      if (!decoded) {
        try { decoded = await new Promise((ok, fail) => zlib.inflateRaw(buf, (err, r) => err ? fail(err) : ok(r))); } catch {}
      }

      if (decoded) {
        if (!responseWithinLimit(decoded, API_RESPONSE_MAX_BYTES)) {
          sendJSONCompressed(req, res, 502, { error: 'Decoded response from TMDB is too large' });
          return 'MISS';
        }
        text = decoded.toString('utf8');
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        try { data = JSON.parse(text); } catch (e3) {
          console.error('JSON parse after decompress failed:', e3.message, '| decompressed len:', decoded.length);
          decoded = null; data = null;
        }
      }

      if (!data) {
        console.error('JSON parse error:', e.message, '| status:', upstream.status, '| encoding:', upstream.headers['content-encoding'], '| bodyLen:', buf.length, '| hex:', buf.slice(0, 16).toString('hex'));
        sendJSONCompressed(req, res, 502, { error: 'Invalid JSON from TMDB' });
        return 'MISS';
      }
    }

    if (upstream.status === 200) cacheSet(cacheKey, data, cacheTTL);
    sendJSONCompressed(req, res, upstream.status, data, { 'Cache-Control': `public, max-age=${cacheTTL}`, 'X-Cache': 'MISS' });
  } catch (err) {
    console.error('API proxy error:', err.message);
    sendJSONCompressed(req, res, 503, { error: 'Service unavailable', message: err.message });
  }
  return 'MISS';
}

async function handleAdminMetrics(req, res, query) {
  if (!checkAdminKey(req, query)) return send404(res);

  let diskBytes = 0;
  try { diskBytes = await getDiskCacheBytes(); } catch {}

  const memStats = imageMemCache.stats();

  sendAdminJSONCompressed(req, res, 200, {
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
  sendAdminJSONCompressed(req, res, 200, REQUEST_LOGS.slice(-limit));
}

async function handleAdminAuth(req, res) {
  if (!isSameOriginAdminMutation(req)) {
    return sendAdminJSONCompressed(req, res, 403, { ok: false, message: 'Cross-site admin auth denied' });
  }
  if (isAdminAuthRateLimited(req)) {
    return sendAdminJSONCompressed(req, res, 429, { ok: false, message: 'Too many failed login attempts' }, { 'Retry-After': '60' });
  }

  let body = '';
  try {
    body = await readRequestBody(req, ADMIN_AUTH_BODY_MAX_BYTES);
  } catch (error) {
    if (error.code === 'BODY_TOO_LARGE') {
      return sendAdminJSONCompressed(req, res, 413, { ok: false, message: 'Request body too large' });
    }
    throw error;
  }

  let data = {};
  try { data = JSON.parse(body); } catch {}

  const adminKey = (process.env.ADMIN_API_KEY || '').trim();
  if (!adminKey) {
    return sendAdminJSONCompressed(req, res, 500, { ok: false, message: 'Admin auth not configured' });
  }

  if (timingSafeEqualString(data.admin_key || '', adminKey)) {
    resetAdminAuthFailures(req);
    const maxAge = 7 * 24 * 60 * 60;
    sendAdminJSONCompressed(req, res, 200, { ok: true }, {
      'Set-Cookie': [
        `admin_session=${createAdminSessionToken(maxAge)}; ${cookieOptions(maxAge)}`,
        `admin_key=; ${cookieOptions(0)}`
      ]
    });
  } else {
    recordFailedAdminAuth(req);
    sendAdminJSONCompressed(req, res, 401, { ok: false });
  }
}

async function handleAdminLogout(req, res) {
  if (!isSameOriginAdminMutation(req)) {
    return sendAdminJSONCompressed(req, res, 403, { ok: false, message: 'Cross-site admin logout denied' });
  }
  sendAdminJSONCompressed(req, res, 200, { ok: true }, {
    'Set-Cookie': [
      `admin_session=; ${cookieOptions(0)}`,
      `admin_key=; ${cookieOptions(0)}`
    ]
  });
}

async function handleAdminStatus(req, res, query) {
  if (!checkAdminKey(req, query)) return send404(res);

  let diskBytes = 0;
  try { diskBytes = await getDiskCacheBytes(); } catch {}

  sendAdminJSONCompressed(req, res, 200, {
    status: 'active',
    version: VERSION,
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
    return sendAdminJSONCompressed(req, res, 200, { backdrop_path: null });
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
        return sendAdminJSONCompressed(req, res, 200, { backdrop_path: pick.backdrop_path });
      }
    }
    sendAdminJSONCompressed(req, res, 200, { backdrop_path: null });
  } catch (e) {
    sendAdminJSONCompressed(req, res, 200, { backdrop_path: null });
  }
}

// ============== 清除缓存管理端点 ==============
async function handleAdminClearCache(req, res, query) {
  if (req.method !== 'POST') {
    return sendAdminJSONCompressed(req, res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
  }
  if (!isSameOriginAdminMutation(req)) {
    return sendAdminJSONCompressed(req, res, 403, { error: 'Cross-site admin mutation denied' });
  }
  if (!checkAdminKey(req, query)) return send404(res);

  const type = query.type || 'all';
  const result = {};

  if (type === 'api' || type === 'all') {
    result.api_cleared = apiCache.size;
    apiCache.clear();
    apiCacheExpiry.clear();
    apiCacheSizes.clear();
    apiCacheBytes = 0;
  }

  if (type === 'mem' || type === 'all') {
    result.mem_cleared = imageMemCache.stats().size;
    imageMemCache.cache.clear();
    imageMemCache.currentBytes = 0;
  }

  if (IMAGE_DISK_CACHE_ENABLED && (type === 'disk' || type === 'all')) {
    const files = await collectFiles(IMAGE_DISK_CACHE_DIR);
    let removed = 0;
    let bytes = 0;
    for (const file of files) {
      try {
        await fs.promises.unlink(file.path);
        removed++;
        bytes += file.size;
      } catch {}
    }
    result.disk_files_cleared = removed;
    result.disk_bytes_cleared = bytes;
    setDiskCacheBytesSnapshot(0);
  }

  sendAdminJSONCompressed(req, res, 200, { ok: true, ...result });
}

// ============== 主服务器 ==============
const server = http.createServer(async (req, res) => {
  const start = Date.now();
  const pathname = getPathname(req.url);
  const query = parseQuery(req.url);

  if (req.method === 'OPTIONS') {
    if (pathname.startsWith('/admin/')) {
      if (!isSameOriginAdminMutation(req)) {
        res.writeHead(403, { 'Content-Length': 0 });
        return res.end();
      }
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Admin-Key',
        'Access-Control-Max-Age': '86400'
      });
      return res.end();
    }
    res.writeHead(204, {
      ...corsHeaders(req),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Admin-Key',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

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
      if (pathname === '/admin/logout' && req.method === 'POST') return handleAdminLogout(req, res);
      if (pathname === '/admin/status') return handleAdminStatus(req, res, query);
      if (pathname === '/admin/dashboard') return handleAdminDashboard(res);
      if (pathname === '/admin/random-bg') return handleAdminRandomBg(req, res, query);
      if (pathname === '/admin/clear-cache') return handleAdminClearCache(req, res, query);
      return send404(res);
    }

    send404(res);
  } catch (err) {
    console.error('Server error:', err);
    if (pathname.startsWith('/admin/')) {
      sendAdminJSONCompressed(req, res, 500, { error: 'Internal server error' });
    } else {
      sendJSONCompressed(req, res, 500, { error: 'Internal server error' });
    }
  } finally {
    if (shouldRecordRequest(req, pathname, type)) {
      const entry = {
        time: Date.now(),
        ip: getClientIP(req),
        method: req.method,
        path: sanitizeRequestUrl(req.url),
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
const apiCacheGcTimer = setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [k, exp] of apiCacheExpiry) {
    if (exp < now) {
      apiCacheDelete(k);
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`[Cache GC] Cleaned ${cleaned} expired API cache entries`);
}, 300000); // 每 5 分钟
apiCacheGcTimer.unref();

const diskCacheGcTimer = IMAGE_DISK_CACHE_ENABLED ? setInterval(cleanupCacheIfNeeded, DISK_CACHE_CLEANUP_INTERVAL_MS) : null;
if (diskCacheGcTimer) diskCacheGcTimer.unref();

// ============== Start ==============
function startServer() {
  if (IMAGE_DISK_CACHE_ENABLED) {
    ensureDir(IMAGE_DISK_CACHE_DIR).then(cleanupCacheIfNeeded).catch(console.error);
  }

  return server.listen(PORT, '0.0.0.0', () => {
    console.log(`TMDB Proxy v${VERSION} on port ${PORT}`);
    console.log(`Health: http://localhost:${PORT}/health`);
    console.log(`Keep-Alive: enabled (max 80 sockets)`);
    console.log(`Gzip: enabled (>1KB responses)`);
    console.log(`Memory cache: ${IMAGE_MEM_CACHE_MAX_MB}MB | API cache: ${API_CACHE_MAX_ITEMS} items`);
    console.log(`Request dedup: enabled | API retry: ${API_RETRY_COUNT}x | Image retry: ${IMAGE_RETRY_COUNT}x`);
    console.log(`ETag/304: enabled`);
  });
}

function shutdown() {
  clearInterval(apiCacheGcTimer);
  if (diskCacheGcTimer) clearInterval(diskCacheGcTimer);
  httpsAgent.destroy();
  apiAgent.destroy();
  for (const session of http2Sessions.values()) {
    if (!session.closed && !session.destroyed) {
      session.destroy();
    }
  }
  http2Sessions.clear();
  if (server.listening) server.close();
}

if (require.main === module) {
  startServer();
  process.on('SIGTERM', () => { console.log('SIGTERM'); shutdown(); process.exit(0); });
  process.on('SIGINT', () => { console.log('SIGINT'); shutdown(); process.exit(0); });
}

module.exports = {
  server,
  startServer,
  shutdown,
  _internals: {
    parseQuery,
    getPathname,
    sanitizeRequestUrl,
    getApiKey,
    getApiCacheKey,
    isSafeImagePath,
    getCacheFilePath,
    cookieOptions,
    createAdminSessionToken,
    verifyAdminSessionToken,
    checkAdminKey,
    LRUCache,
    cacheGet,
    cacheSet,
    collectFiles,
    getDiskCacheBytes,
    shouldRecordRequest,
    isLocalOrPrivateIP,
    hasForwardedClientIP,
    getClientIP,
    resolveCorsOrigin,
    corsHeaders,
    enforceResponseLimit,
    recordUpstreamRequest
  }
};
