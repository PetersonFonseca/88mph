import test from 'node:test';
import assert from 'node:assert/strict';
import {downloadRoute} from '../src/street/downloadRoute.js';

const meta = panoId => ({panoId, imageWidth: 16384, imageHeight: 8192, tileWidth: 512, tileHeight: 512});
const a = meta('recent'), b = meta('past');
const route = {epochs: {present: {nodes: [{metadata: a}]}, past: {nodes: [{metadata: b}]}}, portal: {present: a, past: b}};

test('downloads every panorama in both epochs once and waits for durable storage', async () => {
  const seen = new Set(); let inFlight = 0, maximum = 0, flushed = false;
  const progress = [];
  const result = await downloadRoute(route, {
    async getTile(metadata, tile) {
      assert.equal(tile.persistToDisk, true);
      const key = `${metadata.panoId}:${tile.zoom}:${tile.x}:${tile.y}`;
      assert.ok(!seen.has(key)); seen.add(key);
      inFlight++; maximum = Math.max(maximum, inFlight);
      await new Promise(resolve => setTimeout(resolve, 1)); inFlight--;
      tile.onSource(metadata.panoId === 'recent' ? 'disk' : 'google');
      return new Blob(['tile']);
    },
    async flushCache() { await Promise.resolve(); flushed = true; },
  }, {concurrency: 6, onProgress: value => progress.push(value)});
  assert.equal(result.total, 64); assert.equal(result.loaded, 64);
  assert.equal(result.totalPanoramas, 2); assert.equal(result.completedPanoramas, 2);
  assert.equal(result.progress, 1); assert.equal(result.bytes, 256);
  assert.ok(maximum <= 6 && maximum > 1); assert.equal(flushed, true);
  assert.deepEqual(result.sources.disk, {count: 32, bytes: 128});
  assert.deepEqual(result.sources.google, {count: 32, bytes: 128});
  assert.equal(result.sources.unknown.count, 0);
  assert.deepEqual(progress[0].sources.google, {count: 0, bytes: 0});
});

test('a fully reused route reports no bytes received from Google', async () => {
  const result = await downloadRoute(route, {
    async getTile(metadata, {onSource}) {
      onSource(metadata.panoId === 'recent' ? 'memory' : 'browser');
      return new Blob(['cached']);
    },
  }, {persistToDisk: false});
  assert.equal(result.sources.google.count, 0);
  assert.equal(result.sources.google.bytes, 0);
  assert.equal(result.sources.memory.bytes + result.sources.browser.bytes, result.bytes);
  assert.equal(result.sources.memory.count + result.sources.browser.count, result.loaded);
});

test('a failed download cancels workers and never reports the route as ready', async () => {
  let requests = 0, ready = false;
  await assert.rejects(downloadRoute(route, {
    async getTile(metadata, {signal}) {
      requests++;
      if (requests === 2) throw new Error('Download interrupted');
      await new Promise(resolve => setTimeout(resolve, 2));
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      return new Blob(['tile']);
    },
    flushCache() { ready = true; },
  }, {concurrency: 4}), /Download interrupted/);
  assert.ok(requests <= 4); assert.equal(ready, false);
});

test('cancelled downloads stop before requesting any tiles', async () => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(downloadRoute(route, {getTile() {assert.fail('Unexpected download');}}, {signal: abort.signal}), {name: 'AbortError'});
});

test('local preparation counts every missing tile and never declares a partial route ready', async () => {
  let calls = 0, last;
  await assert.rejects(downloadRoute(route, {
    async getTile(metadata, {onSource}) {
      calls++;
      if (metadata.panoId === 'past') throw Object.assign(new Error('missing'), {code: 'LOCAL_TILE_MISSING'});
      onSource('disk'); return new Blob(['saved']);
    },
    flushCache() { assert.fail('An incomplete route is not ready'); },
  }, {localOnly: true, onProgress: value => { last = value; }}), {code: 'LOCAL_ROUTE_INCOMPLETE'});
  assert.equal(calls, 64);
  assert.equal(last.missing, 32);
  assert.equal(last.completedPanoramas, 1);
  assert.equal(last.sources.google.bytes, 0);
});
