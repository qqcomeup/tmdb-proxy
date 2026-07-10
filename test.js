const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.IMAGE_DISK_CACHE_DIR = path.join(__dirname, 'cache-test');
process.env.IMAGE_DISK_CACHE_ENABLED = 'false';
process.env.TMDB_API_KEY = 'server-key';
process.env.ADMIN_API_KEY = 'admin-secret';

const { _internals } = require('./server');

assert.deepStrictEqual(_internals.parseQuery('/3/search/movie?query=a%3Db&include_adult=false'), {
  query: 'a=b',
  include_adult: 'false'
});
assert.deepStrictEqual(_internals.parseQuery('/3/movie?with_genres=1,2'), {
  with_genres: '1,2'
});

assert.strictEqual(_internals.getPathname('/3/movie/123?api_key=client'), '/3/movie/123');
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
  console.log('All tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
