#!/usr/bin/env node
// Free check of the keyframe projection against the running app (archive only, zoom 3, no Google calls).
// Needs the dev server: npm run dev (http://127.0.0.1:5173). Writes to .cache/timeline/paulista/parity/.
import {chromium} from 'playwright';
import {join} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {loadEnv, googleKey, TIMELINE_DIR} from './lib/env.mjs';
import {planView, renderView} from './lib/projection.mjs';
import {createTileSource} from './lib/tiles.mjs';
import {encodePng, ssim, ffmpeg, temporaryPath, publish} from './lib/ffmpeg.mjs';
import {cockpitLayout} from './lib/cockpit.mjs';
import {loadRoute} from './keyframes.mjs';
import {headingAt} from '../../src/street/route.js';

const base = process.env.BROWSER_URL || 'http://127.0.0.1:5173';
const width = 1920, height = 1080;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = join(TIMELINE_DIR, 'parity', stamp);

try { await fetch(base, {signal: AbortSignal.timeout(3000)}); }
catch { console.error(`Servidor de desenvolvimento indisponível em ${base}. Inicie com npm run dev.`); process.exit(1); }

await mkdir(dir, {recursive: true});
const browser = await chromium.launch({executablePath: process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
  headless: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : []});
let state;
try {
  const page = await (await browser.newContext({viewport: {width, height}, deviceScaleFactor: 1})).newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/');
  await page.waitForFunction(() => window.__street);
  await page.locator('#start').click();
  await page.locator('#connect-street').click();
  console.log('Abrindo o acervo local no app (sem Google)…');
  await page.waitForFunction(() => { const s = window.__street.snapshot(); return s.status === 'driving' && s.prepared; }, null, {timeout: 10 * 60000, polling: 1000});
  await page.locator('#close-street-panel').click();
  await page.addStyleTag({content: 'body > #app > :not(canvas) { visibility: hidden !important; }'});
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
  state = await page.evaluate(() => {
    const snapshot = window.__street.snapshot();
    return {s: snapshot.s, epoch: snapshot.epoch, projection: snapshot.projection, panoId: window.__street.journey.current.metadata.panoId};
  });
  await page.screenshot({path: join(dir, 'app.png')});
  if (errors.length) console.warn('Erros na página:', errors.join(' | '));
} finally { await browser.close(); }

const env = loadEnv(), route = await loadRoute(env);
const node = route.epochs[state.epoch].nodes.find(item => item.metadata.panoId === state.panoId);
if (!node) throw new Error('Panorama atual do app não encontrado no percurso salvo.');
const p = state.projection, expected = cockpitLayout(width, height);
for (const key of ['scale', 'offsetX', 'offsetY']) {
  if (Math.abs(p[key] - expected[key]) > 1e-6) throw new Error(`Projeção do app (${key}) difere da fórmula da cabine.`);
}
const intrinsics = {width, height, f: p.scale * 900, cx: p.vanishingX, cy: p.vanishingY};
const appHeading = headingAt(route, state.epoch, state.s);
const source = createTileSource({apiKey: googleKey(env), zoom: 3});
// Windshield region that shows the street at this size: photo x >= 100, photo y <= 140, minus a margin.
const crop = (() => {
  const x = Math.ceil(p.offsetX + p.scale * 100), y = 0, w = width - 8 - x, h = Math.floor(p.offsetY + p.scale * 140);
  return `${w}:${h}:${x}:${y}`;
})();
const results = [];
try {
  for (const offset of [0, 1, -1, 3]) {
    const plan = planView({metadata: node.metadata, viewHeading: appHeading + offset, intrinsics, zoom: 3, scale: 1});
    const {pixels} = await source.fetchTiles(node.metadata, plan);
    const file = join(dir, `mine-h${offset >= 0 ? '+' : ''}${offset}.png`);
    await encodePng(renderView(plan, pixels), file);
    results.push({offset, file, ssim: await ssim(join(dir, 'app.png'), file, {crop})});
  }
} finally { source.dispose(); }

const compare = join(dir, 'compare.png'), temporary = temporaryPath(compare);
await ffmpeg(['-i', join(dir, 'app.png'), '-i', results[0].file, '-filter_complex',
  `[0:v]crop=${crop},format=gbrp,split[a][a2];[1:v]crop=${crop},format=gbrp,split[b][b2];[a2][b2]blend=all_mode=difference,lutrgb=r=val*4:g=val*4:b=val*4[d];[a][b][d]vstack=inputs=3`, '-frames:v', '1', '-y', temporary]);
await publish(temporary, compare);
console.log(`s=${state.s.toFixed(1)} m · ${state.panoId} · rumo do app ${appHeading.toFixed(2)}° · f=${intrinsics.f.toFixed(1)} · ponto de fuga (${intrinsics.cx.toFixed(1)}, ${intrinsics.cy.toFixed(1)}) · recorte ${crop}`);
for (const result of results) console.log(`  rumo ${result.offset >= 0 ? '+' : ''}${result.offset}°: SSIM ${result.ssim.toFixed(4)}`);
console.log(`Comparação (app / quadro-chave / diferença): ${compare}`);
if (results[0].ssim < .9 || results.slice(1).some(result => result.ssim >= results[0].ssim)) {
  console.error('A projeção não confere com o app.'); process.exitCode = 1;
}
