const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

process.env.IMAGE_DISK_CACHE_DIR = path.join(__dirname, 'cache-test');
process.env.IMAGE_DISK_CACHE_ENABLED = 'false';
process.env.TMDB_API_KEY = 'server-key';
process.env.ADMIN_API_KEY = 'admin-secret';

const { server, shutdown, _internals } = require('./server');

function requestAdmin(port, method, pathname, headers = {}, body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

assert.deepStrictEqual(_internals.parseQuery('/3/search/movie?query=a%3Db&include_adult=false'), {
  query: 'a=b',
  include_adult: 'false'
});
assert.deepStrictEqual(_internals.parseQuery('/3/movie?with_genres=1,2'), {
  with_genres: '1,2'
});

assert.strictEqual(_internals.getPathname('/3/movie/123?api_key=client'), '/3/movie/123');
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
assert.strictEqual(_internals.getApiKey({ headers: {} }, {}), 'server-key');
assert.strictEqual(
  _internals.getApiCacheKey('/3/search/movie', { query: 'a', page: '1', api_key: 'client-a' }),
  _internals.getApiCacheKey('/3/search/movie', { api_key: 'client-b', page: '1', query: 'a' })
);
assert.notStrictEqual(
  _internals.getApiCacheKey('/3/search/movie', { query: 'a', page: '1' }),
  _internals.getApiCacheKey('/3/search/movie', { query: 'b', page: '1' })
);

assert.strictEqual(_internals.isSafeImagePath('/t/p/w500/abc.jpg'), true);
assert.strictEqual(_internals.isSafeImagePath('/t/p/original/folder/abc.webp'), true);
assert.strictEqual(_internals.isSafeImagePath('/t/p/original/../../server.js'), false);
assert.strictEqual(_internals.isSafeImagePath('/t/p/original\\server.js'), false);

const cachePath = _internals.getCacheFilePath('/t/p/w500/abc.jpg');
assert.ok(cachePath.startsWith(path.resolve(process.env.IMAGE_DISK_CACHE_DIR) + path.sep));

assert.throws(() => _internals.getCacheFilePath('/t/p/original/../../server.js'), /Unsafe/);
assert.ok(_internals.cookieOptions(10).includes('HttpOnly'));
assert.ok(_internals.cookieOptions(10).includes('SameSite=Lax'));

const adminSession = _internals.createAdminSessionToken(60);
assert.strictEqual(_internals.verifyAdminSessionToken(adminSession), true);
assert.strictEqual(_internals.verifyAdminSessionToken('bad-token'), false);
assert.strictEqual(_internals.checkAdminKey({ headers: { cookie: `admin_session=${adminSession}` } }, {}), true);
assert.strictEqual(_internals.checkAdminKey({ headers: { cookie: 'admin_key=admin-secret' } }, {}), false);
assert.strictEqual(_internals.checkAdminKey({ headers: { 'x-admin-key': 'admin-secret' } }, {}), true);
assert.strictEqual(_internals.verifyAdminSessionToken(_internals.createAdminSessionToken(-1)), false);
assert.ok(_internals.cookieOptions(10).includes('Secure') === false);
process.env.COOKIE_SECURE = 'true';
assert.ok(_internals.cookieOptions(10).includes('Secure'));
process.env.COOKIE_SECURE = 'false';

assert.strictEqual(_internals.isSafeImagePath('/t/p/w500/abc.jpg?x=1'), false);
assert.strictEqual(_internals.isSafeImagePath('/t/p/original/%2e%2e/server.js'), false);
assert.strictEqual(_internals.isSafeImagePath('/x/p/w500/abc.jpg'), false);

const dashboardHtml = fs.readFileSync(path.join(__dirname, 'admin-dashboard.html'), 'utf8');
assert.match(dashboardHtml, /<button\b[^>]*\bid=["']btn_clear_cache["']/);
assert.match(
  dashboardHtml,
  /fetchJSON\(\s*["']\/admin\/clear-cache\?type=all["']\s*,\s*\{\s*method\s*:\s*["']POST["']\s*}\s*\)/
);

const lru = new _internals.LRUCache(5);
lru.set('a', Buffer.from('aaa'), 'text/plain');
lru.set('b', Buffer.from('bbb'), 'text/plain');
assert.strictEqual(lru.get('a'), null);
assert.strictEqual(lru.get('b').buffer.toString(), 'bbb');
lru.set('big', Buffer.alloc(2 * 1024 * 1024 + 1), 'application/octet-stream');
assert.strictEqual(lru.get('big'), null);

_internals.cacheSet('fresh-test', { ok: true }, 60);
assert.deepStrictEqual(_internals.cacheGet('fresh-test'), { ok: true });
_internals.cacheSet('expired-test', { ok: false }, -1);
assert.strictEqual(_internals.cacheGet('expired-test'), null);

const localReq = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
const dockerReq = { headers: {}, socket: { remoteAddress: '172.23.0.1' } };
const forwardedReq = { headers: { 'x-forwarded-for': '8.8.8.8, 172.23.0.1' }, socket: { remoteAddress: '172.23.0.1' } };
const realIpReq = { headers: { 'x-real-ip': '8.8.4.4' }, socket: { remoteAddress: '127.0.0.1' } };
assert.strictEqual(_internals.isLocalOrPrivateIP('127.0.0.1'), true);
assert.strictEqual(_internals.isLocalOrPrivateIP('172.23.0.1'), true);
assert.strictEqual(_internals.isLocalOrPrivateIP('8.8.8.8'), false);
assert.strictEqual(_internals.hasForwardedClientIP(forwardedReq), true);
assert.strictEqual(_internals.shouldRecordRequest(localReq, '/health', 'other'), false);
assert.strictEqual(_internals.shouldRecordRequest(localReq, '/t/p/w500/a.jpg', 'image'), false);
assert.strictEqual(_internals.shouldRecordRequest(dockerReq, '/3/movie/1', 'api'), false);
assert.strictEqual(_internals.shouldRecordRequest(forwardedReq, '/t/p/w500/a.jpg', 'image'), true);
assert.strictEqual(_internals.shouldRecordRequest(realIpReq, '/3/movie/1', 'api'), true);

(async () => {
  const diskTestDir = path.join(__dirname, 'cache-test-files');
  const nestedDir = path.join(diskTestDir, 'nested');
  await fs.promises.rm(diskTestDir, { recursive: true, force: true });
  await fs.promises.mkdir(nestedDir, { recursive: true });
  await fs.promises.writeFile(path.join(diskTestDir, 'a.txt'), 'aa');
  await fs.promises.writeFile(path.join(nestedDir, 'b.txt'), 'bbb');

  const files = await _internals.collectFiles(diskTestDir);
  assert.strictEqual(files.length, 2);
  assert.strictEqual(files.reduce((sum, file) => sum + file.size, 0), 5);
  assert.ok(files.every(file => typeof file.mtimeMs === 'number' && typeof file.atimeMs === 'number'));

  await fs.promises.rm(diskTestDir, { recursive: true, force: true });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;

  try {
    _internals.cacheSet('cache-clear-get-rejection', { ok: true }, 60);
    const getClear = await requestAdmin(port, 'GET', '/admin/clear-cache?type=api', {
      'X-Admin-Key': 'admin-secret'
    });
    assert.strictEqual(getClear.status, 405);
    assert.deepStrictEqual(_internals.cacheGet('cache-clear-get-rejection'), { ok: true });

    const crossSiteClear = await requestAdmin(port, 'POST', '/admin/clear-cache?type=api', {
      'X-Admin-Key': 'admin-secret',
      Origin: 'https://attacker.example',
      'Sec-Fetch-Site': 'cross-site'
    });
    assert.strictEqual(crossSiteClear.status, 403);
    assert.deepStrictEqual(_internals.cacheGet('cache-clear-get-rejection'), { ok: true });

    const sameOriginClear = await requestAdmin(port, 'POST', '/admin/clear-cache?type=api', {
      'X-Admin-Key': 'admin-secret',
      Origin: origin,
      'Sec-Fetch-Site': 'same-origin'
    });
    assert.strictEqual(sameOriginClear.status, 200);
    assert.strictEqual(_internals.cacheGet('cache-clear-get-rejection'), null);

    const oversizedAuthBody = JSON.stringify({ admin_key: 'x'.repeat(16 * 1024) });
    const oversizedAuth = await requestAdmin(port, 'POST', '/admin/auth', {
      'Content-Type': 'application/json'
    }, oversizedAuthBody);
    assert.strictEqual(oversizedAuth.status, 413);
  } finally {
    await new Promise(resolve => server.close(resolve));
    shutdown();
  }

  console.log('All tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
