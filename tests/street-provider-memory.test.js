import test from 'node:test';
import assert from 'node:assert/strict';
import {createGoogleProvider, getTileLayout} from '../src/street/googleProvider.js';

const START = Date.UTC(2026, 10, 26, 12);
const past = {panoId: 'paulista-2010', imageWidth: 13312, imageHeight: 6656, tileWidth: 512, tileHeight: 512};
const present = {...past, panoId: 'paulista-2024', imageWidth: 16384, imageHeight: 8192};
const tile = {zoom: 3, x: 0, y: 0};
const image = () => new Blob([Uint8Array.of(1, 2, 3, 4)], {type: 'image/png'});

function setup({headerOverrides = {}, ...options} = {}) {
  let time = START, offline = false;
  const calls = [];
  const provider = createGoogleProvider({
    apiKey: 'fixture-memory-cache-key', localTileBase: '/__street-cache', now: () => time,
    fetchImpl: async (url, config) => {
      calls.push(url);
      if (offline) throw new Error('No requests allowed while driving');
      assert.equal(config.cache, 'no-store');
      if (url.endsWith('/status')) return Response.json({type: 'disk'});
      return new Response(image(), {headers: {
        Date: new Date(time).toUTCString(), 'Cache-Control': 'private, max-age=3600, must-revalidate',
        'X-Street-Persisted': '1', 'X-Street-Cache': 'HIT', ...headerOverrides,
      }});
    }, ...options,
  });
  return {provider, calls, advance: delta => { time += delta; }, offline: () => { offline = true; }};
}

test('a prepared route retains all persisted blobs and driving reuses them with no HTTP or disk requests', async () => {
  const env = setup(), prepared = [];
  for (const metadata of [past, present]) {
    for (const {x, y} of getTileLayout(metadata, 3).tiles) {
      const position = {zoom: 3, x, y};
      prepared.push({metadata, position, blob: await env.provider.getTile(metadata, {...position, persistToDisk: true})});
    }
  }
  assert.equal(prepared.length, 60);
  assert.equal(env.calls.length, 61);
  assert.equal(env.provider.cacheStats().memoryEntries, 60);
  assert.equal(env.provider.cacheStats().memoryBytes, 240);
  env.offline();
  for (const {metadata, position, blob} of prepared) {
    assert.equal(await env.provider.getTile(metadata, position), blob, 'driving gets the same Blob');
    assert.equal(await env.provider.getTile(metadata, {...position, persistToDisk: true}), blob, 'disk confirmation remains valid');
  }
  assert.equal(env.calls.length, 61);
  assert.equal(env.provider.cacheStats().memoryHits, 120);
  assert.equal((await env.provider.flushCache()).pendingWrites, 0);
  assert.ok(!JSON.stringify(env.provider.cacheStats()).includes('pano'));
  env.provider.dispose();
  assert.equal(env.provider.cacheStats().memoryEntries, 0);
  assert.equal(env.provider.cacheStats().memoryBytes, 0);
});

test('tile source distinguishes the first Google download, memory reuse, and a new provider disk hit', async () => {
  const sources = [];
  const first = setup({headerOverrides: {'X-Street-Cache': 'MISS'}});
  const blob = await first.provider.getTile(past, {...tile, persistToDisk: true, onSource: source => sources.push(source)});
  assert.deepEqual(sources, ['google']);
  const calls = first.calls.length;
  assert.equal(await first.provider.getTile(past, {...tile, onSource: source => sources.push(source)}), blob);
  assert.deepEqual(sources, ['google', 'memory']);
  assert.equal(first.calls.length, calls, 'retained images must not trigger a local or Google fetch');
  first.provider.dispose();

  const reopened = setup();
  await reopened.provider.getTile(past, {...tile, persistToDisk: true, onSource: source => sources.push(source)});
  assert.deepEqual(sources, ['google', 'memory', 'disk']);
  assert.equal(reopened.calls.length, 2, 'the new provider checks local storage and reads the saved tile');
  reopened.provider.dispose();
});

test('a browser tile cache hit reports browser without a Google or local request', async () => {
  const blob = image(), sources = [];
  const env = setup({
    localTileBase: null,
    tileCache: {
      async get() { return blob; },
      async put() { assert.fail('A cache hit must not be written again'); },
    },
    fetchImpl() { assert.fail('A browser cache hit must not fetch'); },
  });
  assert.equal(await env.provider.getTile(past, {...tile, onSource: source => sources.push(source)}), blob);
  assert.deepEqual(sources, ['browser']);
  env.provider.dispose();
});

test('a direct Google tile response reports google once and a persisted browser hit reports browser', async () => {
  const saved = new Map(), sources = [], calls = [];
  const cache = {
    async get(position) { return saved.get(JSON.stringify(position)) || null; },
    async put(position, blob) { saved.set(JSON.stringify(position), blob); return true; },
  };
  const env = setup({
    localTileBase: null, tileCache: cache,
    fetchImpl: async url => {
      calls.push(new URL(url).pathname);
      if (new URL(url).pathname.endsWith('/createSession')) {
        return Response.json({session: 'fixture-session', expiry: String(START / 1000 + 3600)});
      }
      return new Response(image(), {headers: {Date: new Date(START).toUTCString(), 'Cache-Control': 'private, max-age=3600'}});
    },
  });
  await env.provider.getTile(past, {...tile, onSource: source => sources.push(source)});
  assert.deepEqual(sources, ['google']);
  await env.provider.flushCache();
  await env.provider.getTile(past, {...tile, onSource: source => sources.push(source)});
  assert.deepEqual(sources, ['google', 'browser']);
  assert.deepEqual(calls, ['/v1/createSession', '/v1/streetview/tiles/3/0/0']);
  env.provider.dispose();
});

test('failed tiles and unconfirmed disk writes never report a successful tile source', async () => {
  const sources = [];
  const failed = setup({fetchImpl: async url => url.endsWith('/status')
    ? Response.json({type: 'disk'}) : Response.json({code: 'ACCESS_DENIED'}, {status: 403})});
  await assert.rejects(failed.provider.getTile(past, {...tile, onSource: source => sources.push(source)}), {code: 'ACCESS_DENIED'});
  failed.provider.dispose();
  const unconfirmed = setup({headerOverrides: {'X-Street-Persisted': '0'}});
  await assert.rejects(unconfirmed.provider.getTile(past, {...tile, persistToDisk: true, onSource: source => sources.push(source)}), {code: 'DISK_CACHE_UNAVAILABLE'});
  unconfirmed.provider.dispose();
  assert.deepEqual(sources, []);
});

test('memory freshness honours Date and Age, expires, and reloads through the disk endpoint', async () => {
  const env = setup({headerOverrides: {Date: new Date(START).toUTCString(), Age: '3590'}});
  const initial = await env.provider.getTile(past, {...tile, persistToDisk: true});
  env.advance(9999);
  assert.equal(await env.provider.getTile(past, tile), initial);
  assert.equal(env.calls.length, 2);
  env.advance(1);
  const renewed = await env.provider.getTile(past, tile);
  assert.notEqual(renewed, initial);
  assert.equal(env.calls.length, 3);
  assert.equal(env.provider.cacheStats().memoryHits, 1);
  env.provider.dispose();
});

test('memory limits evict least recently used entries and keep byte counts accurate', async () => {
  const env = setup({memoryMaxEntries: 2, memoryMaxBytes: 8});
  const a = await env.provider.getTile(past, tile);
  await env.provider.getTile(past, {...tile, x: 1});
  assert.equal(await env.provider.getTile(past, tile), a, 'touching A keeps it newest');
  await env.provider.getTile(past, {...tile, x: 2});
  assert.equal(env.provider.cacheStats().memoryEntries, 2);
  assert.equal(env.provider.cacheStats().memoryBytes, 8);
  assert.equal(await env.provider.getTile(past, tile), a);
  const before = env.calls.length;
  await env.provider.getTile(past, {...tile, x: 1});
  assert.equal(env.calls.length, before + 1, 'least recently used B was removed');
  env.provider.dispose();
  const tiny = setup({memoryMaxBytes: 3});
  await tiny.provider.getTile(past, tile);
  assert.equal(tiny.provider.cacheStats().memoryEntries, 0, 'oversized individual tile is not retained');
  tiny.provider.dispose();
});

test('unconfirmed or uncacheable local responses cannot become retained proof of a disk write', async () => {
  const unconfirmed = setup({headerOverrides: {'X-Street-Persisted': '0'}});
  await unconfirmed.provider.getTile(past, tile);
  assert.equal(unconfirmed.provider.cacheStats().memoryEntries, 0);
  await assert.rejects(unconfirmed.provider.getTile(past, {...tile, persistToDisk: true}), {code: 'DISK_CACHE_UNAVAILABLE'});
  assert.equal(unconfirmed.calls.length, 3);
  unconfirmed.provider.dispose();
  for (const headerOverrides of [{'Cache-Control': 'no-store, max-age=3600'}, {'Cache-Control': 'no-cache, max-age=3600'}, {Date: 'invalid'}]) {
    const env = setup({headerOverrides});
    await env.provider.getTile(past, tile);
    await env.provider.getTile(past, tile);
    assert.equal(env.provider.cacheStats().memoryEntries, 0);
    assert.equal(env.calls.length, 3);
    env.provider.dispose();
  }
});

test('aborted and disposed providers cannot return retained images or keep a late response', async () => {
  const env = setup(), sources = [];
  await env.provider.getTile(past, tile);
  const stop = new AbortController(); stop.abort();
  await assert.rejects(env.provider.getTile(past, {...tile, signal: stop.signal, onSource: source => sources.push(source)}), {name: 'AbortError'});
  env.provider.dispose();
  await assert.rejects(env.provider.getTile(past, {...tile, onSource: source => sources.push(source)}), {code: 'DISPOSED'});
  assert.equal(env.provider.cacheStats().memoryBytes, 0);

  let resolveTile;
  const late = setup({fetchImpl: async url => url.endsWith('/status') ? Response.json({type: 'disk'}) : new Promise(resolve => { resolveTile = resolve; })});
  const request = late.provider.getTile(past, {...tile, onSource: source => sources.push(source)});
  while (!resolveTile) await new Promise(resolve => setImmediate(resolve));
  late.provider.dispose();
  resolveTile(new Response(image(), {headers: {Date: new Date(START).toUTCString(), 'Cache-Control': 'max-age=3600', 'X-Street-Persisted': '1'}}));
  await assert.rejects(request, {name: 'AbortError'});
  assert.equal(late.provider.cacheStats().memoryEntries, 0);
  assert.equal(late.provider.cacheStats().memoryBytes, 0);
  assert.deepEqual(sources, [], 'cancelled callers must not count a successful source');
});
