import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {createDiskTileCache, validTile} from '../server/streetDiskCache.js';
import {createStreetTileService, createStreetCacheMiddleware} from '../server/streetCachePlugin.js';
import {createGoogleProvider} from '../src/street/googleProvider.js';

const START = Date.UTC(2026, 10, 26, 12);
const KEY = 'fixture-only-disk-key';
const tile = {panoId: 'paulista-2010', zoom: 3, x: 1, y: 2};
const image = () => new Blob([Uint8Array.of(1, 2, 3, 4)], {type: 'image/png'});
const headers = extra => new Headers({'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600, must-revalidate, no-transform', Date: new Date(START).toUTCString(), ETag: '"fixture-etag"', ...extra});
const metadata = {panoId: tile.panoId, imageWidth: 13312, imageHeight: 6656, tileWidth: 512, tileHeight: 512};

async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'street-disk-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  let time = START;
  const config = {directory, apiKey: KEY, now: () => time, ...options};
  return {directory, config, cache: createDiskTileCache(config), advance: delta => { time += delta; }};
}

test('original image bytes and safe headers survive a new disk cache instance without credentials', async t => {
  const env = await setup(t);
  assert.equal(await env.cache.put(tile, image(), headers()), true);
  const second = createDiskTileCache(env.config), entry = await second.getEntry(tile);
  assert.deepEqual([...new Uint8Array(await entry.blob.arrayBuffer())], [1, 2, 3, 4]);
  assert.equal(entry.headers.ETag, '"fixture-etag"');
  const names = await readdir(env.directory);
  assert.match(names[0], /^[a-f0-9]{64}$/);
  const files = await readdir(join(env.directory, names[0]));
  assert.equal(files.filter(name => name.endsWith('.png')).length, 1);
  const json = await readFile(join(env.directory, names[0], files.find(name => name.endsWith('.json'))), 'utf8');
  assert.ok(!json.includes(KEY)); assert.ok(!json.includes('https://')); assert.ok(!json.includes('session'));
  assert.equal(await createDiskTileCache({...env.config, apiKey: 'another-key'}).get(tile), null);
});

test('archived bytes survive HTTP expiration and a restart years later', async t => {
  const env = await setup(t);
  await env.cache.put(tile, image(), headers());
  env.advance(10 * 365 * 86400000);
  const reopened = createDiskTileCache(env.config);
  assert.deepEqual(await (await reopened.get(tile)).arrayBuffer(), await image().arrayBuffer());
  for (const value of ['no-store, max-age=3600', 'no-cache, max-age=3600', 'max-age=0']) {
    assert.equal(await reopened.put(tile, image(), headers({'Cache-Control': value})), true);
  }
  assert.equal(await reopened.put(tile, image(), new Headers()), true);
});

test('corrupt or missing files are ignored but preserved for recovery', async t => {
  const env = await setup(t);
  await env.cache.put(tile, image(), headers());
  const namespace = join(env.directory, (await readdir(env.directory))[0]);
  const files = await readdir(namespace);
  await writeFile(join(namespace, 'keep-user-note.txt'), 'do not remove');
  await writeFile(join(namespace, files.find(name => name.endsWith('.png'))), 'corrupt-long-image');
  const other = createDiskTileCache(env.config);
  assert.equal(await other.get(tile), null);
  assert.deepEqual((await readdir(namespace)).sort(), [...files, 'keep-user-note.txt'].sort());
  await other.put(tile, image(), headers());
  const json = (await readdir(namespace)).find(name => name.endsWith('.json'));
  await writeFile(join(namespace, json), '{broken');
  assert.equal(await createDiskTileCache(env.config).get(tile), null);
  const retained = await readdir(namespace);
  for (const file of [...files, 'keep-user-note.txt']) assert.ok(retained.includes(file));
  assert.equal(retained.filter(file => file.endsWith('.png')).length, 2);
  assert.equal(await readFile(join(namespace, files.find(file => file.endsWith('.png'))), 'utf8'), 'corrupt-long-image');
});

test('explicit disk limits refuse new writes without evicting existing images', async t => {
  const env = await setup(t, {maxEntries: 2, maxBytes: 7});
  await Promise.all([0, 1, 2, 3].map(x => env.cache.put({...tile, x}, image(), headers())));
  assert.deepEqual(await env.cache.stats(), {entries: 1, bytes: 4, maxEntries: 2, maxBytes: 7});
  assert.ok(await env.cache.get({...tile, x: 0}));
  assert.equal(await env.cache.get({...tile, x: 3}), null);
  assert.equal((await createDiskTileCache(env.config).stats()).entries, 1);
});

test('aborted disk requests create no files and tile identifiers cannot traverse paths', async t => {
  const env = await setup(t), controller = new AbortController(); controller.abort();
  await assert.rejects(env.cache.put(tile, image(), headers(), {signal: controller.signal}), {name: 'AbortError'});
  await assert.rejects(env.cache.get(tile, {signal: controller.signal}), {name: 'AbortError'});
  for (const bad of [{...tile, panoId: '../escape'}, {...tile, panoId: 'https://example.com/image'}, {...tile, x: 32}, {...tile, y: 4}, {...tile, zoom: 6}, {...tile, x: 1.2}]) {
    assert.equal(validTile(bad), false);
    assert.equal(await env.cache.put(bad, image(), headers()), false);
  }
  assert.deepEqual(await readdir(env.directory), []);
});

function fakeGoogle({delay = false} = {}) {
  const calls = [], deferred = [];
  return {calls, deferred, fetchImpl: async (input, options) => {
    const url = new URL(input); calls.push(url.pathname);
    assert.equal(url.hostname, 'tile.googleapis.com');
    if (url.pathname.endsWith('/createSession')) return Response.json({session: 'fixture-session', expiry: String(START / 1000 + 3600)});
    assert.match(url.pathname, /^\/v1\/streetview\/tiles\/\d\/\d+\/\d+$/);
    if (delay) await new Promise((resolve, reject) => {
      deferred.push(resolve);
      options.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), {once: true});
    });
    return new Response(image(), {headers: headers()});
  }};
}

test('persistence capability responds immediately without scanning or creating cache files', async t => {
  const env = await setup(t);
  const service = createStreetTileService({...env.config, fetchImpl: async () => { throw new Error('must not fetch'); }});
  t.after(() => service.dispose());
  const status = service.status();
  assert.equal(status.type, 'disk');
  assert.equal(status.indexReady, false);
  assert.equal(status.entries, 0);
  assert.equal(typeof status.then, 'undefined', 'capability detection must not wait for filesystem work');
  assert.deepEqual(await readdir(env.directory), []);
});

test('second server instance serves complete saved tiles with zero Google requests', async t => {
  const env = await setup(t), google = fakeGoogle();
  const first = createStreetTileService({...env.config, fetchImpl: google.fetchImpl});
  for (const panoId of ['paulista-2010', 'paulista-2024']) for (const x of [0, 1]) {
    const result = await first.getTile({...tile, panoId, x});
    assert.equal(result.persisted, true); assert.equal(result.hit, false);
  }
  await first.flush(); first.dispose();
  const second = createStreetTileService({...env.config, fetchImpl: async () => { throw new Error('Google must not be called'); }});
  t.after(() => second.dispose());
  for (const panoId of ['paulista-2010', 'paulista-2024']) for (const x of [0, 1]) {
    const result = await second.getTile({...tile, panoId, x});
    assert.equal(result.persisted, true); assert.equal(result.hit, true);
  }
  const status = await second.status();
  assert.equal(status.type, 'disk'); assert.equal(status.entries, 4); assert.equal(status.hits, 4);
  assert.equal(google.calls.length, 5, 'one session plus four tiles, no extra metadata');
});

test('shared server request survives one consumer cancellation; all cancelled downloads are discarded', async t => {
  const env = await setup(t), google = fakeGoogle({delay: true});
  const service = createStreetTileService({...env.config, fetchImpl: google.fetchImpl});
  t.after(() => service.dispose());
  const a = new AbortController(), b = new AbortController();
  const first = service.getTile(tile, {signal: a.signal}), second = service.getTile(tile, {signal: b.signal});
  while (!google.deferred.length) await new Promise(resolve => setImmediate(resolve));
  a.abort(); await assert.rejects(first, {name: 'AbortError'});
  google.deferred.shift()();
  assert.equal((await second).persisted, true);
  assert.equal(google.calls.length, 2);
  const stop = new AbortController(), interrupted = service.getTile({...tile, x: 4}, {signal: stop.signal});
  while (!google.deferred.length) await new Promise(resolve => setImmediate(resolve));
  stop.abort(); await assert.rejects(interrupted, {name: 'AbortError'});
  await service.flush();
  assert.equal(await env.cache.get({...tile, x: 4}), null);
});

async function invoke(middleware, url, {method = 'GET', origin, body, host = '127.0.0.1:5173'} = {}) {
  const req = Object.assign(new EventEmitter(), {url, method, headers: {host, ...(body ? {'content-type': 'application/json'} : {}), ...(origin ? {origin} : {})}, socket: {remoteAddress: '127.0.0.1'}});
  req[Symbol.asyncIterator] = async function* () { if (body) yield Buffer.from(body); };
  const res = Object.assign(new EventEmitter(), {destroyed: false, writableEnded: false, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; this.writableEnded = true; }});
  await middleware(req, res, () => { res.next = true; });
  return res;
}

test('local endpoint rejects remote origins and arbitrary URLs, and serves archive bytes without HTTP caching', async t => {
  const env = await setup(t), google = fakeGoogle();
  const service = createStreetTileService({...env.config, fetchImpl: google.fetchImpl}); t.after(() => service.dispose());
  const middleware = createStreetCacheMiddleware(service, {now: env.config.now});
  const path = '/__street-cache/tile?' + new URLSearchParams({...tile, zoom: '3', x: '1', y: '2'});
  for (const [url, options, status] of [[path, {origin: 'https://evil.example'}, 403], [path, {host: 'evil.example'}, 403], [path, {method: 'POST'}, 405], [path + '&url=https://evil.example', {}, 400], ['/__street-cache/tile?panoId=..%2Fsecret&zoom=3&x=1&y=2', {}, 400]]) {
    assert.equal((await invoke(middleware, url, options)).status, status);
  }
  assert.equal(google.calls.length, 0);
  assert.equal(JSON.parse((await invoke(middleware, '/__street-cache/status')).body).type, 'disk');
  const first = await invoke(middleware, path);
  assert.equal(first.status, 200); assert.equal(first.headers['X-Street-Persisted'], '1');
  assert.equal(first.headers['X-Street-Cache'], 'MISS');
  env.advance(123000);
  const second = await invoke(middleware, path);
  assert.equal(second.headers['Cache-Control'], 'no-store');
  assert.equal(second.headers['X-Street-Archive'], '1');
  assert.equal(second.headers['X-Street-Cache'], 'HIT');
  assert.equal(second.headers.ETag, '"fixture-etag"');
  assert.deepEqual(second.body, first.body);
  assert.equal(google.calls.length, 2);
  assert.equal(JSON.parse((await invoke(createStreetCacheMiddleware(null), '/__street-cache/status')).body).type, 'browser');
});

test('browser provider sends local tiles to disk even with a browser cache hit; explicit persistence is confirmed', async () => {
  const calls = [];
  const provider = createGoogleProvider({apiKey: KEY, localTileBase: '/__street-cache', tileCache: {get() { throw new Error('must bypass browser cache'); }}, fetchImpl: async (url, options) => {
    calls.push(url); assert.equal(options.cache, 'no-store');
    if (url.endsWith('/status')) return Response.json({type: 'disk', directory: '.cache/streetview'});
    assert.ok(!url.includes(KEY)); assert.ok(!url.includes('session'));
    return new Response(image(), {headers: {...Object.fromEntries(headers()), 'X-Street-Persisted': '1', 'X-Street-Cache': 'HIT'}});
  }});
  assert.deepEqual(await provider.detectPersistence(), {type: 'disk', directory: '.cache/streetview'});
  assert.equal((await provider.getTile(metadata, {...tile, persistToDisk: true})).size, 4);
  await provider.flushCache();
  assert.equal(provider.cacheStats().hits, 1); assert.equal(calls.length, 2);
  provider.dispose();
});

test('browser never claims a download is saved without server confirmation and honours cancellation', async () => {
  const provider = createGoogleProvider({apiKey: KEY, localTileBase: '/__street-cache', fetchImpl: async url => url.endsWith('/status') ? Response.json({type: 'disk'}) : new Response(image(), {headers: {'X-Street-Persisted': '0'}})});
  await assert.rejects(provider.getTile(metadata, {...tile, persistToDisk: true}), {code: 'DISK_CACHE_UNAVAILABLE'});
  const controller = new AbortController(); controller.abort();
  await assert.rejects(provider.getTile(metadata, {...tile, signal: controller.signal}), {name: 'AbortError'});
  provider.dispose();
  const browser = createGoogleProvider({apiKey: KEY, localTileBase: '/__street-cache', fetchImpl: async () => new Response('missing', {status: 404})});
  assert.deepEqual(await browser.detectPersistence(), {type: 'browser'});
  await assert.rejects(browser.getTile(metadata, {...tile, persistToDisk: true}), {code: 'DISK_CACHE_UNAVAILABLE'});
  browser.dispose();
});

test('local endpoint reads expired originals and missing images never create a session or download', async t => {
  const env = await setup(t);
  await env.cache.put(tile, image(), headers());
  env.advance(86400000 * 365);
  let calls = 0;
  const service = createStreetTileService({...env.config, fetchImpl: async () => { calls++; throw new Error('Network forbidden'); }});
  t.after(() => service.dispose());
  const middleware = createStreetCacheMiddleware(service, {now: env.config.now});
  const path = '/__street-cache/local-tile?' + new URLSearchParams(tile);
  assert.equal((await invoke(middleware, path)).status, 200);
  const missing = await invoke(middleware, path.replace('x=1', 'x=0'));
  assert.equal(missing.status, 404);
  assert.equal(JSON.parse(missing.body).code, 'LOCAL_TILE_MISSING');
  assert.equal((await service.inventory()).entries, 1);
  assert.equal(calls, 0);
});

test('local-only provider cannot fall through to Google, including metadata and missing server', async () => {
  for (const disk of [true, false]) {
    const calls = [];
    const provider = createGoogleProvider({apiKey: KEY, localOnly: true, localTileBase: '/__street-cache', fetchImpl: async url => {
      calls.push(url);
      assert.ok(url.startsWith('/__street-cache/'));
      if (url.endsWith('/status')) return Response.json({type: disk ? 'disk' : 'browser'});
      assert.ok(url.includes('/local-tile?'));
      return Response.json({code: 'LOCAL_TILE_MISSING'}, {status: 404});
    }});
    await assert.rejects(provider.getMetadata({panoId: tile.panoId}), {code: 'LOCAL_ONLY'});
    await assert.rejects(provider.getTile(metadata, tile), {code: disk ? 'LOCAL_TILE_MISSING' : 'LOCAL_STORAGE_UNAVAILABLE'});
    assert.equal(calls.length, disk ? 2 : 1);
    provider.dispose();
  }
});

test('archive memory survives HTTP expiry without more local or Google requests', async () => {
  let time = START, calls = 0;
  const provider = createGoogleProvider({apiKey: KEY, localOnly: true, localTileBase: '/__street-cache', now: () => time, fetchImpl: async url => {
    calls++;
    return url.endsWith('/status') ? Response.json({type: 'disk'}) : new Response(image(), {headers: {'Cache-Control': 'no-store', 'X-Street-Archive': '1', 'X-Street-Persisted': '1', 'X-Street-Cache': 'HIT'}});
  }});
  const first = await provider.getTile(metadata, tile);
  time += 10 * 365 * 86400000;
  assert.equal(await provider.getTile(metadata, tile), first);
  assert.equal(calls, 2);
  provider.dispose();
});

test('saved route survives server restart, and bad writes cannot replace it', async t => {
  const env = await setup(t);
  const meta = {...metadata, date: '2010-02', lat: -23.5, lng: -46.6, heading: 315, copyright: 'test'};
  const route = {id: 'paulista', length: 900, portalS: 450, heading: 315, epochs: {}, portal: {}};
  for (const epoch of ['present', 'past']) {
    route.portal[epoch] = meta;
    route.epochs[epoch] = {nodes: [0, 450, 900].map(s => ({s, heading: 315, metadata: meta}))};
  }
  const first = createStreetTileService(env.config);
  await assert.rejects(first.readRoute(), {code: 'LOCAL_ROUTE_MISSING'});
  const middleware = createStreetCacheMiddleware(first);
  const body = JSON.stringify({...route, apiKey: 'must-not-save'});
  assert.equal((await invoke(middleware, '/__street-cache/route', {method: 'PUT', origin: 'https://evil.example', body})).status, 403);
  assert.equal((await invoke(middleware, '/__street-cache/route', {method: 'PUT', body: '{invalid'})).status, 400);
  assert.equal((await invoke(middleware, '/__street-cache/route', {method: 'PUT', body})).status, 200);
  assert.equal((await invoke(middleware, '/__street-cache/route')).status, 200);
  first.dispose();
  const second = createStreetTileService(env.config);
  t.after(() => second.dispose());
  const saved = await second.readRoute();
  assert.equal(saved.portalS, 450);
  assert.equal(saved.apiKey, undefined);
  await assert.rejects(second.saveRoute({...route, portalS: -1}), {code: 'INVALID_LOCAL_ROUTE'});
  assert.deepEqual(await second.readRoute(), saved);
});

test('legacy originals and later versions are never overwritten or removed on a repair', async t => {
  const env = await setup(t);
  await env.cache.put(tile, image(), headers());
  const namespace = join(env.directory, (await readdir(env.directory))[0]);
  const json = (await readdir(namespace)).find(file => file.endsWith('.json'));
  const record = JSON.parse(await readFile(join(namespace, json), 'utf8'));
  // Reproduce the historical filename format without modifying any real archive.
  const legacyFile = json.replace('.json', '.png');
  await writeFile(join(namespace, legacyFile), Buffer.from(await image().arrayBuffer()));
  await writeFile(join(namespace, json), JSON.stringify({...record, file: legacyFile}));
  env.advance(86400000 * 365);
  const reopened = createDiskTileCache(env.config);
  assert.equal((await reopened.get(tile)).size, 4);
  const replacement = new Blob(['a different image'], {type: 'image/png'});
  assert.equal(await reopened.put(tile, replacement, headers()), true);
  assert.deepEqual(await readFile(join(namespace, legacyFile)), Buffer.from(await image().arrayBuffer()));
  assert.deepEqual(await readFile(join(namespace, record.file)), Buffer.from(await image().arrayBuffer()));
  const current = JSON.parse(await readFile(join(namespace, json), 'utf8'));
  assert.notEqual(current.file, legacyFile);
  assert.notEqual(current.file, record.file);
  assert.equal(await (await createDiskTileCache(env.config).get(tile)).text(), 'a different image');
});

test('Google 429 bursts wait and retry instead of failing the download', async t => {
  const env = await setup(t), google = fakeGoogle();
  let refusals = 2;
  const service = createStreetTileService({...env.config, quotaRetryDelays: [1, 1, 1], fetchImpl: async (input, options) => {
    if (new URL(input).pathname.includes('/tiles/') && refusals-- > 0) return Response.json({error: {code: 429}}, {status: 429});
    return google.fetchImpl(input, options);
  }});
  t.after(() => service.dispose());
  const result = await service.getTile(tile);
  assert.equal(result.persisted, true); assert.equal(result.hit, false);
  assert.equal((await service.getTile(tile)).hit, true, 'the saved tile is never downloaded twice');
});

test('persistent quota errors stop after the configured retries and keep saved tiles', async t => {
  const env = await setup(t), google = fakeGoogle();
  const first = createStreetTileService({...env.config, fetchImpl: google.fetchImpl});
  await first.getTile(tile); await first.flush(); first.dispose();
  let tileCalls = 0;
  const service = createStreetTileService({...env.config, quotaRetryDelays: [1, 1], fetchImpl: async (input, options) => {
    if (new URL(input).pathname.includes('/tiles/')) { tileCalls++; return Response.json({error: {code: 429}}, {status: 429}); }
    return google.fetchImpl(input, options);
  }});
  t.after(() => service.dispose());
  await assert.rejects(service.getTile({...tile, x: 0}), error => error.code === 'QUOTA_EXCEEDED');
  assert.equal(tileCalls, 3);
  assert.equal((await service.getTile(tile)).hit, true);
});

test('a per-day Google quota fails at once without pointless retries', async t => {
  const env = await setup(t), google = fakeGoogle();
  let tileCalls = 0;
  const service = createStreetTileService({...env.config, quotaRetryDelays: [1, 1, 1], fetchImpl: async (input, options) => {
    if (!new URL(input).pathname.includes('/tiles/')) return google.fetchImpl(input, options);
    tileCalls++;
    return Response.json({error: {code: 429, details: [{metadata: {quota_unit: '1/d/{project}', quota_limit: 'streetviewtilesPerDayPerProject'}}]}}, {status: 429});
  }});
  t.after(() => service.dispose());
  await assert.rejects(service.getTile(tile), error => error.code === 'DAILY_QUOTA_EXCEEDED');
  assert.equal(tileCalls, 1);
});
