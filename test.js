const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

process.env.IMAGE_DISK_CACHE_DIR = path.join(__dirname, 'cache-test');
process.env.IMAGE_DISK_CACHE_ENABLED = 'false';
process.env.TMDB_API_KEY = 'server-key';
process.env.ADMIN_API_KEY = 'admin-secret';
process.env.CORS_ALLOW_ORIGIN = 'https://allowed.example';

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
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
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
const encodedSecretUrl = _internals.sanitizeRequestUrl(
  '/3/search/movie?api%5Fkey=encoded-tmdb&query=test&%61dmin_key=encoded-admin&Key=encoded-key&key=encoded-key-2'
);
assert.ok(!encodedSecretUrl.includes('encoded-tmdb'));
assert.ok(!encodedSecretUrl.includes('encoded-admin'));
assert.ok(!encodedSecretUrl.includes('encoded-key'));
assert.ok(encodedSecretUrl.includes('query=test'));
assert.strictEqual(
  _internals.sanitizeRequestUrl('/3/movie/1?language=zh-CN'),
  '/3/movie/1?language=zh-CN'
);
assert.strictEqual(_internals.getApiKey({ headers: {} }, {}), 'server-key');
assert.strictEqual(
  _internals.getApiCacheKey('/3/search/movie', { query: 'a', page: '1', api_key: 'client-a' }),
  _internals.getApiCacheKey('/3/search/movie', { api_key: 'client-b', page: '1', query: 'a' })
);
process.env.TMDB_API_KEY = '';
assert.notStrictEqual(
  _internals.getApiCacheKey('/3/search/movie', { query: 'a', page: '1', api_key: 'client-a' }),
  _internals.getApiCacheKey('/3/search/movie', { api_key: 'client-b', page: '1', query: 'a' })
);
assert.notStrictEqual(
  _internals.getApiCacheKey('/3/search/movie', { query: 'a', page: '1' }, 'client-a'),
  _internals.getApiCacheKey('/3/search/movie', { query: 'a', page: '1' }, 'client-b')
);
process.env.TMDB_API_KEY = 'server-key';
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
assert.match(dashboardHtml, /id=["']details_drawer["']/);
assert.match(dashboardHtml, /id=["']btn_details["'][^>]*aria-controls=["']details_drawer["'][^>]*aria-expanded=["']false["']/);
assert.match(dashboardHtml, /id=["']btn_changebg["']/);
assert.match(dashboardHtml, /\['aurora', 'Aurora Glass'\]/);
assert.match(dashboardHtml, /\['terminal', 'Terminal'\]/);
assert.match(dashboardHtml, /\['swiss', 'Swiss Editorial'\]/);
assert.match(dashboardHtml, /data-theme="terminal"/);
assert.match(dashboardHtml, /data-theme="swiss"/);
assert.match(dashboardHtml, /prefers-reduced-motion:\s*reduce/);
assert.match(dashboardHtml, /event\.key\s*===\s*["']Escape["']/);
assert.match(dashboardHtml, /upstream:\s*\{\s*label:\s*['"]上游请求['"]/);
assert.match(dashboardHtml, /data-filter=["']upstream["'][^>]*>上游请求/);
assert.match(dashboardHtml, /UPSTREAM/);
assert.match(dashboardHtml, /formatBytes\(l\.bytes\)/);
assert.doesNotMatch(dashboardHtml, /播放预告|热门 TOP|海报墙/);
assert.ok(dashboardHtml.includes('diskPct >= 90 || memPct >= 90'));
assert.ok(!dashboardHtml.includes('diskPct >= 80 || memPct >= 80'));
assert.ok(dashboardHtml.includes('图片内存缓存使用率已超过 90%'));
assert.ok(!dashboardHtml.includes('资源告警'));
assert.ok(!dashboardHtml.includes('资源预警'));

const readme = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
assert.match(readme, /tmdb-cache:\/tmp\/tmdb-cache/);
assert.doesNotMatch(readme, /\.\/cache:\/tmp\/tmdb-cache/);

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
assert.strictEqual(_internals.getClientIP(forwardedReq), '172.23.0.1');
process.env.TRUST_PROXY = 'true';
assert.strictEqual(_internals.getClientIP(forwardedReq), '8.8.8.8');
assert.strictEqual(_internals.getClientIP(realIpReq), '8.8.4.4');
process.env.TRUST_PROXY = 'false';
assert.strictEqual(_internals.shouldRecordRequest(localReq, '/health', 'other'), false);
assert.strictEqual(_internals.shouldRecordRequest(localReq, '/t/p/w500/a.jpg', 'image'), false);
assert.strictEqual(_internals.shouldRecordRequest(dockerReq, '/3/movie/1', 'api'), false);
assert.strictEqual(_internals.shouldRecordRequest(forwardedReq, '/t/p/w500/a.jpg', 'image'), false);
assert.strictEqual(_internals.shouldRecordRequest(realIpReq, '/3/movie/1', 'api'), false);
process.env.TRUST_PROXY = 'true';
assert.strictEqual(_internals.shouldRecordRequest(forwardedReq, '/t/p/w500/a.jpg', 'image'), true);
assert.strictEqual(_internals.shouldRecordRequest(realIpReq, '/3/movie/1', 'api'), true);
process.env.TRUST_PROXY = 'false';

assert.strictEqual(_internals.resolveCorsOrigin({ headers: { origin: 'https://allowed.example' } }), 'https://allowed.example');
assert.strictEqual(_internals.resolveCorsOrigin({ headers: { origin: 'https://blocked.example' } }), null);
const corsHeaders = _internals.corsHeaders({ headers: { origin: 'https://allowed.example' } });
assert.strictEqual(corsHeaders['Access-Control-Allow-Origin'], 'https://allowed.example');
assert.strictEqual(corsHeaders.Vary, 'Origin');
assert.deepStrictEqual(_internals.corsHeaders({ headers: { origin: 'https://blocked.example' } }), { Vary: 'Origin' });
assert.strictEqual(_internals.enforceResponseLimit(4, 3, 'api'), false);
assert.strictEqual(_internals.enforceResponseLimit(4, 4, 'api'), true);

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
    assert.strictEqual(typeof _internals.recordUpstreamRequest, 'function');
    _internals.recordUpstreamRequest({
      kind: 'image',
      method: 'GET',
      url: 'https://image.tmdb.org/t/p/w500/upstream-test.jpg',
      status: 200,
      durationMs: 12,
      bytes: 3456
    });
    _internals.recordUpstreamRequest({
      kind: 'api',
      method: 'GET',
      url: 'https://api.tmdb.org/3/movie/1?api_key=secret-key&language=zh-CN',
      status: 200,
      durationMs: 34,
      bytes: 789
    });
    const upstreamLogsResponse = await requestAdmin(port, 'GET', '/admin/logs?limit=10', {
      'X-Admin-Key': 'admin-secret'
    });
    assert.strictEqual(upstreamLogsResponse.status, 200);
    const upstreamLogs = JSON.parse(upstreamLogsResponse.body);
    assert.ok(upstreamLogs.some(entry => (
      entry.type === 'upstream:image' &&
      entry.path === 'https://image.tmdb.org/t/p/w500/upstream-test.jpg' &&
      entry.cache === 'UPSTREAM' &&
      entry.bytes === 3456
    )));
    const upstreamApiLog = upstreamLogs.find(entry => entry.type === 'upstream:api');
    assert.ok(upstreamApiLog);
    assert.ok(!upstreamApiLog.path.includes('secret-key'));
    assert.ok(upstreamApiLog.path.includes('api_key=***'));

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

    _internals.cacheSet('proxy-cache-clear', { ok: true }, 60);
    const proxySameOriginClear = await requestAdmin(port, 'POST', '/admin/clear-cache?type=api', {
      'X-Admin-Key': 'admin-secret',
      Host: `127.0.0.1:${port}`,
      Origin: 'https://example.com',
      'Sec-Fetch-Site': 'same-origin'
    });
    assert.strictEqual(proxySameOriginClear.status, 200);
    assert.strictEqual(_internals.cacheGet('proxy-cache-clear'), null);

    const oversizedAuthBody = JSON.stringify({ admin_key: 'x'.repeat(16 * 1024) });
    const oversizedAuth = await requestAdmin(port, 'POST', '/admin/auth', {
      'Content-Type': 'application/json'
    }, oversizedAuthBody);
    assert.strictEqual(oversizedAuth.status, 413);

    const crossSiteAuth = await requestAdmin(port, 'POST', '/admin/auth', {
      'Content-Type': 'application/json',
      Origin: 'https://attacker.example',
      'Sec-Fetch-Site': 'cross-site'
    }, JSON.stringify({ admin_key: 'admin-secret' }));
    assert.strictEqual(crossSiteAuth.status, 403);
    assert.ok(!crossSiteAuth.headers['access-control-allow-origin']);

    const badAuthHeaders = {
      'Content-Type': 'application/json',
      Origin: origin,
      'Sec-Fetch-Site': 'same-origin',
      'X-Forwarded-For': '203.0.113.10'
    };
    process.env.TRUST_PROXY = 'true';
    for (let i = 0; i < 5; i++) {
      const failedAuth = await requestAdmin(port, 'POST', '/admin/auth', badAuthHeaders, JSON.stringify({ admin_key: `bad-${i}` }));
      assert.strictEqual(failedAuth.status, 401);
      assert.ok(!failedAuth.headers['access-control-allow-origin']);
    }
    const throttledAuth = await requestAdmin(port, 'POST', '/admin/auth', badAuthHeaders, JSON.stringify({ admin_key: 'bad-limit' }));
    assert.strictEqual(throttledAuth.status, 429);
    assert.strictEqual(throttledAuth.headers['retry-after'], '60');

    const goodAuth = await requestAdmin(port, 'POST', '/admin/auth', {
      'Content-Type': 'application/json',
      Origin: origin,
      'Sec-Fetch-Site': 'same-origin',
      'X-Forwarded-For': '203.0.113.11'
    }, JSON.stringify({ admin_key: 'admin-secret' }));
    assert.strictEqual(goodAuth.status, 200);
    assert.ok(!goodAuth.headers['access-control-allow-origin']);
    process.env.TRUST_PROXY = 'false';
  } finally {
    await new Promise(resolve => server.close(resolve));
    shutdown();
  }

  console.log('All tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
