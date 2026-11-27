import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createTileCache, tileFreshness} from '../src/street/tileCache.js';
import {createGoogleProvider} from '../src/street/googleProvider.js';

const START = Date.UTC(2026, 10, 26, 12, 0, 0);
const tile = {panoId: 'historical-pano', zoom: 3, x: 2, y: 1};
const image = () => new Blob([new Uint8Array([1, 2, 3, 4])], {type: 'image/png'});
const headers = extra => new Headers({'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600, must-revalidate, no-transform', Date: new Date(START).toUTCString(), ETag: '"fixture-etag"', ...extra});

class MemoryCache {
  records = new Map();
  writes = 0;
  reads = 0;
  failWrites = false;
  key(request) { return typeof request === 'string' ? request : request.url; }
  async match(request) { this.reads++; return this.records.get(this.key(request))?.clone(); }
  async put(request, response) {
    this.writes++;
    if (this.failWrites) throw new DOMException('Storage full', 'QuotaExceededError');
    this.records.set(this.key(request), response.clone());
  }
  async delete(request) { return this.records.delete(this.key(request)); }
  async keys() { return [...this.records.keys()].map(url => new Request(url)); }
}
function setup(options = {}) {
  let time = START;
  const caches = new Map(), names = [];
  const cacheStorage = {async open(name) {
    names.push(name);
    if (!caches.has(name)) caches.set(name, new MemoryCache());
    return caches.get(name);
  }};
  const configuration = {apiKey: 'fixture-api-key-not-a-real-secret', cacheStorage, cryptoImpl: webcrypto, origin: 'https://game.example', now: () => time, ...options};
  return {cache: createTileCache(configuration), caches, names, configuration, advance: value => time += value};
}

test('only explicit positive max-age permits storage; private and must-revalidate are supported', () => {
  assert.equal(tileFreshness(headers(), {now: START}), START + 3600000);
  assert.equal(tileFreshness(headers({'Cache-Control': 'PRIVATE, max-age="60", must-revalidate'}), {now: START}), START + 60000);
  for (const value of ['private', 'max-age=0', 'max-age=-1', 'max-age=60, no-store', 'max-age=60, no-cache', 'max-age=60, no-cache="ETag"', 's-maxage=60', 'max-age=60, max-age=3600']) {
    assert.equal(tileFreshness(headers({'Cache-Control': value}), {now: START}), null, value);
  }
});

test('Date, Age, and request delay conservatively reduce freshness without serving stale', () => {
  assert.equal(tileFreshness(headers(), {now: START + 500000}), START + 3600000);
  assert.equal(tileFreshness(headers({Age: '3500'}), {now: START + 2000, requestStartedAt: START}), START + 100000);
  assert.equal(tileFreshness(headers({Age: '3600'}), {now: START}), null);
  assert.equal(tileFreshness(headers({Age: 'bad'}), {now: START}), null);
  assert.equal(tileFreshness(headers({Date: 'invalid'}), {now: START}), null);
  assert.equal(tileFreshness(new Headers({'Cache-Control': 'private, max-age=3600'}), {now: START}), null, 'CORS-hidden age metadata must not reset freshness');
  assert.equal(tileFreshness(headers({'Cache-Control': 'max-age=60, stale-while-revalidate=600', Age: '61'}), {now: START}), null);
});

test('fresh tiles survive cache instances, expire on time, and preserve ETag', async () => {
  const env = setup();
  assert.equal(await env.cache.put(tile, image(), headers()), true);
  const secondVisit = createTileCache(env.configuration);
  assert.deepEqual([...new Uint8Array(await (await secondVisit.get(tile)).arrayBuffer())], [1, 2, 3, 4]);
  const storage = [...env.caches.values()][0];
  const entry = [...storage.records.values()][0];
  assert.equal(entry.headers.get('ETag'), '"fixture-etag"');
  env.advance(3600000);
  assert.equal(await secondVisit.get(tile), null);
  assert.equal(storage.records.size, 0);
});

test('cache keys are local and namespaces contain neither API key nor Google session', async () => {
  const env = setup();
  await env.cache.put({...tile, panoId: 'pano/with spaces'}, image(), headers());
  const storage = [...env.caches.values()][0];
  const url = new URL([...storage.records.keys()][0]);
  assert.equal(url.origin, 'https://game.example');
  assert.equal(url.search, '');
  assert.match(url.pathname, /pano%2Fwith%20spaces\/3\/2\/1$/);
  assert.match(env.names[0], /^88mph-street-tiles-v1-[a-f0-9]{64}$/);
  const stored = env.names.join(' ') + [...storage.records.keys()].join(' ');
  assert.ok(!stored.includes(env.configuration.apiKey));
  assert.ok(!stored.includes('session'));
  const anotherKey = createTileCache({...env.configuration, apiKey: 'another-fixture-key'});
  assert.equal(await anotherKey.get({...tile, panoId: 'pano/with spaces'}), null);
});

test('no-store replaces any earlier entry and unsupported directives are not saved', async () => {
  const env = setup();
  await env.cache.put(tile, image(), headers());
  assert.equal(await env.cache.put(tile, image(), headers({'Cache-Control': 'no-store, max-age=3600'})), false);
  assert.equal(await env.cache.get(tile), null);
  assert.equal(await env.cache.put(tile, image(), headers({'Cache-Control': 'no-cache, max-age=3600'})), false);
  assert.equal([...env.caches.values()][0].records.size, 0);
});

test('entry and byte limits evict oldest tiles and concurrent writes remain bounded', async () => {
  const env = setup({maxEntries: 2, maxBytes: 7});
  assert.equal(await env.cache.put(tile, image(), headers()), true);
  env.advance(1000);
  assert.equal(await env.cache.put({...tile, x: 3}, image(), headers()), true);
  assert.equal(await env.cache.get(tile), null, '8 bytes exceed the 7-byte budget');
  assert.ok(await env.cache.get({...tile, x: 3}));
  const bounded = setup({maxEntries: 2});
  await Promise.all([0, 1, 2, 3, 4].map(x => bounded.cache.put({...tile, x}, image(), headers())));
  assert.equal([...bounded.caches.values()][0].records.size, 2);
});

test('purges expired entries on writes and clearing affects only the active key namespace', async () => {
  const env = setup();
  await env.cache.put(tile, image(), headers({'Cache-Control': 'max-age=1'}));
  env.advance(2000);
  await env.cache.put({...tile, x: 3}, image(), headers());
  assert.equal([...env.caches.values()][0].records.size, 1);
  const other = createTileCache({...env.configuration, apiKey: 'other-fixture-key'});
  await other.put(tile, image(), headers());
  assert.equal(await env.cache.clear(), true);
  assert.equal(await env.cache.get({...tile, x: 3}), null);
  assert.ok(await other.get(tile));
});

test('storage restrictions, quota failures, unsupported APIs, and invalid keys become misses', async () => {
  const env = setup();
  await env.cache.get(tile);
  [...env.caches.values()][0].failWrites = true;
  assert.equal(await env.cache.put(tile, image(), headers()), false);
  assert.equal(await env.cache.put({...tile, x: 3}, image(), headers()), false);
  assert.equal([...env.caches.values()][0].writes, 1, 'do not keep exhausting quota');
  for (const configuration of [
    {cacheStorage: undefined}, {cryptoImpl: {}}, {apiKey: ''}, {origin: 'invalid'},
    {cacheStorage: {open: async () => { throw new Error('Storage disabled'); }}},
  ]) {
    const cache = createTileCache({...env.configuration, ...configuration});
    assert.equal(await cache.get(tile), null);
    assert.equal(await cache.put(tile, image(), headers()), false);
  }
  assert.equal(await env.cache.get({...tile, zoom: -1}), null);
});

test('live cache index avoids a disk scan for every tile write', async () => {
  const env = setup();
  await env.cache.put(tile, image(), headers());
  const storage = [...env.caches.values()][0];
  storage.reads = 0;
  for (let x = 0; x < 100; x++) await env.cache.put({...tile, x}, image(), headers());
  assert.equal(storage.reads, 0, 'existing index should maintain limits without rematching every stored response');
  assert.equal(storage.records.size, 100);
});

const panorama = panoId => ({panoId, imageWidth: 13312, imageHeight: 6656, tileWidth: 512, tileHeight: 512});
const tileOptions = {zoom: 3, x: 0, y: 0};
const sessionResponse = () => new Response(JSON.stringify({session: 'fixture-session', expiry: String(START / 1000 + 3600)}), {headers: {'Content-Type': 'application/json'}});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

test('provider saves two panoramas and a new provider reuses them without session or tile requests', async () => {
  const env = setup();
  let requests = 0;
  const provider = createGoogleProvider({apiKey: env.configuration.apiKey, now: () => START, tileCache: env.cache, fetchImpl: async input => {
    requests++;
    return new URL(input).pathname.endsWith('createSession') ? sessionResponse() : new Response(image(), {headers: headers()});
  }});
  await Promise.all(['present-pano', 'past-pano'].map(id => provider.getTile(panorama(id), tileOptions)));
  await provider.flushCache();
  assert.equal(requests, 3);
  assert.equal(provider.cacheStats().stores, 2);
  provider.dispose();
  const nextVisit = createGoogleProvider({apiKey: env.configuration.apiKey, now: () => START, tileCache: createTileCache(env.configuration), fetchImpl: async () => {
    throw new Error('A fresh persisted tile must not call Google again.');
  }});
  const cached = await Promise.all(['present-pano', 'past-pano'].map(id => nextVisit.getTile(panorama(id), tileOptions)));
  assert.ok(cached.every(blob => blob.size === 4));
  assert.equal(nextVisit.cacheStats().hits, 2);
  assert.equal(nextVisit.cacheStats().misses, 0);
  nextVisit.dispose();
});

test('provider returns an image before disk writes finish and deduplicates during background storage', async () => {
  const saving = deferred();
  let network = 0, stores = 0;
  const provider = createGoogleProvider({apiKey: 'fixture-key', now: () => START,
    tileCache: {get: async () => null, put: () => { stores++; return saving.promise; }},
    fetchImpl: async input => {
      network++;
      return new URL(input).pathname.endsWith('createSession') ? sessionResponse() : new Response(image(), {headers: headers()});
    },
  });
  const first = await provider.getTile(panorama('past'), tileOptions);
  assert.equal(first.size, 4, 'decoding can start while the write is still unresolved');
  assert.equal(provider.cacheStats().pendingWrites, 1);
  const second = await provider.getTile(panorama('past'), tileOptions);
  assert.equal(first, second);
  assert.equal(network, 2);
  assert.equal(stores, 1);
  // A valid, already downloaded image can finish saving after the view closes.
  provider.dispose();
  saving.resolve(true);
  assert.equal((await provider.flushCache()).stores, 1);
});

test('abort and disposal interrupt cache reads rather than returning a late cache hit', async () => {
  for (const mode of ['abort', 'dispose']) {
    const reading = deferred(), controller = new AbortController();
    const provider = createGoogleProvider({apiKey: 'fixture-key', tileCache: {get: () => reading.promise, put: async () => false}, fetchImpl: async () => {
      throw new Error('Must not fetch after cancellation.');
    }});
    const pending = provider.getTile(panorama('past'), {...tileOptions, signal: controller.signal});
    if (mode === 'abort') controller.abort(); else provider.dispose();
    await assert.rejects(pending, {name: 'AbortError'});
    reading.resolve(image());
    provider.dispose();
    await assert.rejects(provider.getTile(panorama('past'), tileOptions), {code: 'DISPOSED'});
  }
});

test('one aborted consumer cannot cancel another consumer of the same in-flight tile', async () => {
  const downloading = deferred(), firstAbort = new AbortController();
  let tileRequests = 0;
  const provider = createGoogleProvider({apiKey: 'fixture-key', now: () => START,
    tileCache: {get: async () => null, put: async () => true},
    fetchImpl: async input => {
      if (new URL(input).pathname.endsWith('createSession')) return sessionResponse();
      tileRequests++;
      return downloading.promise;
    },
  });
  const first = provider.getTile(panorama('past'), {...tileOptions, signal: firstAbort.signal});
  const second = provider.getTile(panorama('past'), tileOptions);
  await new Promise(setImmediate);
  firstAbort.abort();
  await assert.rejects(first, {name: 'AbortError'});
  downloading.resolve(new Response(image(), {headers: headers()}));
  assert.equal((await second).size, 4);
  assert.equal(tileRequests, 1);
  await provider.flushCache();
  provider.dispose();
});
