import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {deflateSync} from 'node:zlib';
import {chromium} from 'playwright';
import {createDiskTileCache} from '../server/streetDiskCache.js';
import {createStreetTileService, createStreetCacheMiddleware} from '../server/streetCachePlugin.js';

const directory = await mkdtemp(join(tmpdir(), 'street-local-browser-'));
const config = {directory, apiKey: 'local-browser-fixture-only'};
const cache = createDiskTileCache({...config, now: () => Date.UTC(2020, 0, 1)});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}
function solidPNG([r, g, b], size = 512) {
  const raw = Buffer.alloc((size * 3 + 1) * size), header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const offset = y * (size * 3 + 1) + 1 + x * 3;
    raw[offset] = r; raw[offset + 1] = g; raw[offset + 2] = b;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
const bytes = solidPNG([44, 111, 150], 1);
const route = {id: 'paulista', length: 900, portalS: 450, heading: 315, epochs: {}, portal: {}};
for (const epoch of ['present', 'past']) {
  const nodes = [0, 450, 900].map((s, i) => ({s, heading: 315, metadata: {
    panoId: `fixture-${epoch}-${i}`, date: epoch === 'past' ? '2010-02' : '2024-11', lat: -23.56, lng: -46.65,
    heading: 315, imageWidth: 4, imageHeight: 4, tileWidth: 1, tileHeight: 1, copyright: 'Fixture local',
  }}));
  route.epochs[epoch] = {nodes}; route.portal[epoch] = nodes[1].metadata;
  for (const {metadata} of nodes) await cache.put({panoId: metadata.panoId, zoom: 3, x: 0, y: 0}, new Blob([bytes], {type: 'image/png'}), new Headers({'Cache-Control': 'max-age=3600', Date: 'Wed, 01 Jan 2020 00:00:00 GMT'}));
}
let serverGoogleCalls = 0, missing = false;
const service = createStreetTileService({...config, fetchImpl: async () => { serverGoogleCalls++; throw new Error('Google forbidden'); }});
const middleware = createStreetCacheMiddleware({...service, getTile(tile, options) {
  if (missing && tile.panoId === 'fixture-past-2') {
    if (options.localOnly) throw Object.assign(new Error('missing'), {status: 404, code: 'LOCAL_TILE_MISSING'});
    serverGoogleCalls++; throw Object.assign(new Error('offline'), {status: 502, code: 'GOOGLE_NETWORK_ERROR'});
  }
  return service.getTile(tile, options);
}});
const base = process.env.BROWSER_URL || 'http://127.0.0.1:5174';
const server = createServer((req, res) => middleware(req, res, async () => {
  try {
    const response = await fetch(new URL(req.url, base));
    res.writeHead(response.status, {'Content-Type': response.headers.get('content-type') || 'text/plain'});
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(502); res.end(); }
}));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({executablePath: process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined, headless: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : []});
const context = await browser.newContext({viewport: {width: 1440, height: 1050}});
let browserGoogleCalls = 0;
await context.route('https://tile.googleapis.com/**', r => { browserGoogleCalls++; return r.fulfill({status: 429, contentType: 'application/json', body: '{"error":{"code":429}}'}); });
const page = await context.newPage(), errors = [];
page.setDefaultTimeout(20000);
page.on('pageerror', error => errors.push(error.message));
const open = async () => { await page.goto(origin + '/'); await page.waitForFunction(() => window.__street); await page.locator('#start').click(); };
try {
  await open();
  await page.locator('#connect-street').click();
  await page.locator('#setup-error').waitFor({state: 'visible'});
  assert.match(await page.locator('#setup-error').innerText(), /percurso ainda não foi salvo/);
  assert.match(await page.locator('#download-detail').innerText(), /6 blocos/);
  assert.equal(browserGoogleCalls, 0); assert.equal(serverGoogleCalls, 0);
  await mkdir('artifacts/street-local-browser', {recursive: true});
  await page.screenshot({path: 'artifacts/street-local-browser/missing-route.png', fullPage: true});
  await service.saveRoute(route);
  await open();
  await page.locator('#connect-street').click();
  await page.waitForFunction(() => window.__street.journey?.prepared?.ready);
  let state = await page.evaluate(() => window.__street.snapshot());
  assert.equal(state.sourceMode, 'local'); assert.equal(state.download.loaded, 6);
  assert.equal(state.download.sources.google.bytes, 0); assert.equal(state.download.sources.disk.count, 6);
  await page.locator('#drive-street').click();
  assert.equal(await page.locator('#street-panel').isVisible(), false);
  // Reload proves the route and image bytes work without the previous provider's memory.
  await open();
  await page.locator('#connect-street').click();
  await page.waitForFunction(() => window.__street.journey?.prepared?.ready);
  assert.equal(browserGoogleCalls, 0); assert.equal(serverGoogleCalls, 0);
  missing = true;
  await open();
  await page.locator('#connect-street').click();
  await page.locator('#setup-error').waitFor({state: 'visible'});
  assert.match(await page.locator('#setup-error').innerText(), /Faltam 1 de 6/);
  assert.equal(await page.locator('#street-dashboard').isVisible(), false);
  assert.equal(browserGoogleCalls, 0); assert.equal(serverGoogleCalls, 0);
  await page.locator('#update-street').click();
  await page.waitForFunction(() => !window.__street.snapshot().connecting && window.__street.snapshot().sourceMode === 'google');
  // The update reuses the saved route: no rediscovery, only the missing tile goes to Google.
  assert.equal(browserGoogleCalls, 0, 'update must reuse the saved route');
  assert.equal(serverGoogleCalls, 1, 'only the missing tile may be requested');
  assert.deepEqual(errors, []);
  const report = {passed: true, expiredArchiveReload: true, missingRouteSafe: true, incompleteRouteSafe: true, googleCallsBeforeExplicitUpdate: 0, savedRouteReusedOnUpdate: true, serverGoogleCalls};
  await writeFile('artifacts/street-local-browser/report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  console.error('Browser state', await page.evaluate(() => ({error: document.querySelector('#setup-error')?.textContent, destinationError: document.querySelector('#destination-error')?.textContent, snapshot: window.__street?.snapshot()})), errors);
  throw error;
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); service.dispose(); await rm(directory, {recursive: true, force: true});
}
