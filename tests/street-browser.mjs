import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright';
import { PAULISTA } from '../src/street/route.js';

// Start Vite with STREET_DISK_CACHE=0, VITE_GOOGLE_MAPS_API_KEY=browser-test-only and port 5174.
// Every Maps API request is fulfilled locally. These are colored test tiles,
// not street photographs, and this test does not validate Google's real archive.
const baseURL = process.env.BROWSER_URL || 'http://127.0.0.1:5174';
const output = new URL('../artifacts/street-browser/', import.meta.url);
await mkdir(output, {recursive: true});

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
const colors = {present: [44, 111, 150], past: [166, 94, 48]};
const images = Object.fromEntries(Object.entries(colors).map(([key, value]) => [key, solidPNG(value)]));

function makeFixtures() {
  const nodes = new Map(), radians = Math.PI / 180, radius = 6371008.8;
  for (const epoch of ['present', 'past']) {
    const seed = PAULISTA.seeds[epoch];
    const id = index => index === 0 ? seed.panoId : `fixture-${epoch}-${index}`;
    for (let index = -15; index <= 15; index++) {
      const distance = index * 30, angle = PAULISTA.heading * radians;
      nodes.set(id(index), {
        epoch, panoId: id(index), date: seed.date,
        lat: seed.lat + distance * Math.cos(angle) / radius / radians,
        lng: seed.lng + distance * Math.sin(angle) / (radius * Math.cos(seed.lat * radians)) / radians,
        heading: PAULISTA.heading, tilt: 90, roll: 0,
        imageWidth: epoch === 'past' ? 13312 : 16384,
        imageHeight: epoch === 'past' ? 6656 : 8192, tileWidth: 512, tileHeight: 512,
        copyright: 'Fixture local de teste — sem fotografias reais', imageryType: 'outdoor',
        reportProblemLink: 'https://www.google.com/maps',
        links: [
          ...(index > -15 ? [{panoId: id(index - 1), heading: (PAULISTA.heading + 180) % 360}] : []),
          ...(index < 15 ? [{panoId: id(index + 1), heading: PAULISTA.heading}] : []),
        ],
      });
    }
  }
  return nodes;
}

const fixtures = makeFixtures(), requests = [], unexpected = [], errors = [];
let denyAccess = false, prohibitRequests = false;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined),
  headless: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : [],
});
const context = await browser.newContext({viewport: {width: 1440, height: 900}, deviceScaleFactor: 1});
await context.route('https://tile.googleapis.com/**', async route => {
  const request = route.request(), url = new URL(request.url());
  requests.push({path: url.pathname, panoId: url.searchParams.get('panoId')});
  const json = body => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(body)});
  if (prohibitRequests) { unexpected.push('Request during prepared jump: ' + url.pathname); await route.abort(); return; }
  if (denyAccess) { await route.fulfill({status: 403, contentType: 'application/json', body: JSON.stringify({error: {code: 403, message: 'Test access denied'}})}); return; }
  if (url.pathname === '/v1/createSession' && request.method() === 'POST') {
    assert.equal(request.postDataJSON().mapType, 'streetview');
    await json({session: 'fixture-session', expiry: String(Math.floor(Date.now() / 1000) + 3600), tileWidth: 512, tileHeight: 512, imageFormat: 'png'});
    return;
  }
  const fixture = fixtures.get(url.searchParams.get('panoId'));
  if (url.pathname === '/v1/streetview/metadata') {
    if (fixture) { const {epoch, ...metadata} = fixture; await json(metadata); return; }
    if (url.searchParams.has('lat') && url.searchParams.has('lng')) {
      const {epoch, ...metadata} = fixtures.get(PAULISTA.seeds.present.panoId);
      await json(metadata); return;
    }
  }
  if (/^\/v1\/streetview\/tiles\/\d+\/\d+\/\d+$/.test(url.pathname) && fixture) {
    const [zoom, x, y] = url.pathname.split('/').slice(-3).map(Number);
    const divisor = 2 ** (5 - zoom);
    if (zoom > 5 || x >= Math.ceil(fixture.imageWidth / divisor / fixture.tileWidth) || y >= Math.ceil(fixture.imageHeight / divisor / fixture.tileHeight)) {
      unexpected.push(`Tile fora da pirâmide nativa: ${url.pathname}`);
      await route.fulfill({status: 400, contentType: 'application/json', body: JSON.stringify({error: {code: 400, errors: [{reason: 'invalidRequest'}]}})}); return;
    }
    await route.fulfill({status: 200, contentType: 'image/png', body: images[fixture.epoch], headers: {
      'Cache-Control': 'private, max-age=3600, must-revalidate',
      'Date': new Date().toUTCString(),
      'ETag': `"fixture-${fixture.panoId}-${zoom}-${x}-${y}"`,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Date, ETag, Cache-Control',
    }}); return;
  }
  unexpected.push('Unexpected fixture request: ' + url.pathname + ' ' + (url.searchParams.get('panoId') || ''));
  await route.fulfill({status: 404, contentType: 'application/json', body: JSON.stringify({error: {code: 404}})});
});
const page = await context.newPage();
page.setDefaultTimeout(30000);
page.on('pageerror', error => errors.push(error.stack || error.message));
const report = {baseURL, fixtureOnly: true, startedAt: new Date().toISOString(), checks: [], errors, unexpected};
const snapshot = () => page.evaluate(() => window.__street.snapshot());
async function check(name, fn) {
  const started = performance.now();
  try { await fn(); report.checks.push({name, passed: true, elapsedMs: Math.round(performance.now() - started)}); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({name, passed: false, error: error.stack || error.message}); throw error; }
  finally { await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2)); }
}
async function previewPixel() {
  return page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    // The UI copies the prepared GPU render into this visible preview canvas.
    const canvas = document.querySelector('#preview-canvas');
    return [...canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data];
  });
}

try {
  await check('Configuração e acervo simulado abrem o modo Paulista', async () => {
    await page.goto(`${baseURL}/?mode=paulista`, {waitUntil: 'networkidle'});
    await page.waitForFunction(() => window.__street && document.documentElement.dataset.ready === 'true');
    assert.equal((await snapshot()).configured, true, 'Start Vite with VITE_GOOGLE_MAPS_API_KEY=browser-test-only.');
    await page.locator('#start').click();
    await page.locator('#update-street').click();
    await page.locator('#street-panel').waitFor({state: 'visible', timeout: 90000});
    await page.waitForFunction(() => window.__street.journey?.prepared?.ready, null, {timeout: 90000});
    assert.equal((await snapshot()).epoch, 'present');
    const downloaded = (await snapshot()).download;
    assert.equal(downloaded.progress, 1, 'O percurso inteiro precisa estar baixado antes de liberar a partida.');
    assert.equal(downloaded.completedPanoramas, downloaded.totalPanoramas);
    assert.ok(downloaded.totalPanoramas > 50);
    assert.equal((await snapshot()).aheadReady, 6);
    assert.equal((await snapshot()).destinationAheadReady, 3);
    assert.match(await page.locator('#preview-date').innerText(), /fev\. 2010/);
    const route = await page.evaluate(() => ({length: window.__street.route.length, portalS: window.__street.route.portalS}));
    assert.ok(route.length >= 899 && route.length <= 901, JSON.stringify(route));
    assert.ok(route.portalS >= 449 && route.portalS <= 451);
    report.initialMemory = (await snapshot()).memory;
  });

  await check('A prévia mostra os mesmos pixels preparados na GPU', async () => {
    const pixel = await previewPixel();
    assert.ok(colors.past.every((value, index) => Math.abs(pixel[index] - value) < 6), `Expected past ${colors.past}, rendered ${pixel}`);
    report.previewPixel = pixel;
    await page.evaluate(() => window.__fixturePreview = window.__street.journey.prepared);
    await page.screenshot({path: new URL('fixture-preview.png', output).pathname});
  });

  await check('Cabine e prévia permanecem alinhadas em diferentes telas', async () => {
    for (const [width, height] of [[1024, 768], [1680, 900]]) {
      await page.setViewportSize({width, height});
      await page.waitForFunction(({width, height}) => window.__street.snapshot().projection?.width === width && window.__street.snapshot().projection?.height === height, {width, height});
      const pixel = await previewPixel();
      assert.ok(colors.past.every((value, index) => Math.abs(pixel[index] - value) < 6), `Preview moved at ${width}×${height}: ${pixel}`);
    }
    await page.setViewportSize({width: 1440, height: 900});
  });

  await check('Segunda conexão reutiliza o cache local sem novos downloads de tiles', async () => {
    await page.evaluate(() => window.__street.flushCache());
    const cacheInfo = await page.evaluate(async () => {
      const names = (await caches.keys()).filter(name => name.startsWith('88mph-street-tiles-v1-'));
      const keys = (await Promise.all(names.map(async name => (await (await caches.open(name)).keys()).map(request => request.url)))).flat();
      return { names: names.length, entries: keys.length,
        privatePaths: keys.every(key => new URL(key).pathname.startsWith('/__88mph_private_tiles__/')),
        credentialFree: keys.every(key => !/[?&](?:key|session)=/.test(key) && !key.includes('browser-test-only')),
      };
    });
    assert.ok(cacheInfo.names > 0 && cacheInfo.entries > 0, 'A primeira conexão deve gravar tiles permitidos pelo Cache-Control.');
    assert.equal(cacheInfo.privatePaths, true); assert.equal(cacheInfo.credentialFree, true);
    const tileRequests = () => requests.filter(request => request.path.startsWith('/v1/streetview/tiles/')).length;
    const before = tileRequests();
    // Same page/context preserves CacheStorage, while reloading destroys every
    // provider, canvas and in-memory panorama from the first connection.
    await page.reload({waitUntil: 'networkidle'});
    await page.waitForFunction(() => !!window.__street);
    await page.locator('#start').click();
    await page.locator('#update-street').click();
    await page.waitForFunction(() => window.__street.journey?.prepared?.ready, null, {timeout: 90000});
    const pixel = await previewPixel();
    assert.ok(colors.past.every((value, index) => Math.abs(pixel[index] - value) < 6), `Cached preview ${pixel}`);
    assert.equal(tileRequests(), before, 'A segunda conexão deve usar os tiles persistidos, sem chamar o endpoint de imagens.');
    assert.equal((await snapshot()).epoch, 'present');
    assert.equal((await snapshot()).memory.textures, report.initialMemory.textures);
    await page.evaluate(() => window.__fixturePreview = window.__street.journey.prepared);
    report.cacheReuse = { beforeTileRequests: before, afterTileRequests: tileRequests(), ...cacheInfo, previewPixel: pixel };
  });

  await check('W alcança 88 mph no portal; a troca preparada funciona sem rede', async () => {
    await page.locator('#drive-street').click();
    await page.keyboard.down('w');
    try { await page.waitForFunction(() => window.__street.journey.status === 'departure', null, {timeout: 120000}); }
    finally { await page.keyboard.up('w'); }
    const departure = await snapshot();
    assert.equal(departure.speedMph, 88);
    assert.ok(Math.abs(departure.speedKmh - 141.622272) < .001);
    assert.equal(departure.metrics.bufferEvents, 0, 'O percurso já baixado e preparado deve avançar sem pausas de carregamento.');
    assert.ok(Math.abs(departure.s - departure.portalS) < .001);
    const requestCount = requests.length;
    prohibitRequests = true;
    await context.setOffline(true);
    await page.waitForFunction(() => window.__street.journey.status === 'arrival' && Number(document.querySelector('#street-flash').style.opacity) < .05, null, {timeout: 20000});
    await page.keyboard.press('h');
    const arrival = await snapshot();
    assert.equal(arrival.status, 'arrival');
    assert.equal(arrival.epoch, 'past');
    assert.equal(arrival.metrics.travelCount, 1);
    assert.ok(arrival.metrics.commitMs < 50, `Synchronous commit took ${arrival.metrics.commitMs} ms`);
    assert.equal(await page.evaluate(() => window.__street.journey.current === window.__fixturePreview), true);
    assert.equal(requests.length, requestCount);
    assert.deepEqual(unexpected, []);
    assert.equal(await page.locator('#street-attribution').isVisible(), true);
    report.departure = departure; report.arrival = arrival; report.requestsAtJump = requestCount;
    await page.screenshot({path: new URL('fixture-arrival.png', output).pathname});
    await context.setOffline(false);
    prohibitRequests = false;
  });

  await check('Nova aproximação prepara o retorno e libera recursos anteriores', async () => {
    await page.locator('#street-restart').click();
    await page.waitForFunction(() => window.__street.journey?.prepared?.ready && window.__street.journey.snapshot().s === 0, null, {timeout: 90000});
    const state = await snapshot();
    assert.equal(state.epoch, 'past');
    assert.equal(state.destinationEpoch, 'present');
    assert.equal(state.memory.textures, report.initialMemory.textures);
    assert.equal(state.memory.geometries, report.initialMemory.geometries);
    const pixel = await previewPixel();
    assert.ok(colors.present.every((value, index) => Math.abs(pixel[index] - value) < 6), `Return preview ${pixel}`);
    report.returnMemory = state.memory;
  });

  await check('Acesso negado mantém o modo fechado e apresenta um erro sem credenciais', async () => {
    denyAccess = true;
    await page.goto(`${baseURL}/?mode=paulista`, {waitUntil: 'networkidle'});
    await page.waitForFunction(() => !!window.__street);
    await page.locator('#start').click();
    await page.locator('#update-street').click();
    await page.locator('#setup-error').waitFor({state: 'visible'});
    const message = await page.locator('#setup-error').innerText();
    assert.ok(message.length > 15);
    assert.ok(!message.includes('browser-test-only'));
    assert.equal(await page.locator('#street-dashboard').isVisible(), false);
    assert.equal(await page.locator('#connect-street').isEnabled(), true);
    report.accessError = message;
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = error.stack || error.message;
  console.error(error);
  try { report.lastSnapshot = await snapshot(); await page.screenshot({path: new URL('failure.png', output).pathname}); } catch { /* Preserve the original failure. */ }
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString(); report.requestCount = requests.length;
  await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2));
  await browser.close();
  console.log(`Relatório com fixtures locais: ${new URL('report.json', output).pathname}`);
}
