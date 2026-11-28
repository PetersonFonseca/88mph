#!/usr/bin/env node
// Renders forward-facing keyframes from Street View panoramas along the saved Paulista route.
//   node scripts/timeline/keyframes.mjs --at 843.6,879,919.6,portal,1088 --zoom 5
// Zoom 3 reads only the app's archive; zoom 5 downloads missing tiles (Google quota) into .cache/timeline/tiles.
import {parseArgs} from 'node:util';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {loadEnv, googleKey, archiveNamespace, TIMELINE_DIR} from './lib/env.mjs';
import {DEFAULT_INTRINSICS, planView, renderView, smoothHeading, nearestNode} from './lib/projection.mjs';
import {createTileSource} from './lib/tiles.mjs';
import {encodePng, exists, publish, temporaryPath} from './lib/ffmpeg.mjs';
import {normalizeSavedRoute} from '../../src/street/savedRoute.js';
import {headingAt} from '../../src/street/route.js';

export async function loadRoute(env = loadEnv()) {
  return normalizeSavedRoute(JSON.parse(await readFile(join(archiveNamespace(googleKey(env)), 'route.json'), 'utf8')));
}

export function parseIntrinsics(text) {
  if (!text) return {...DEFAULT_INTRINSICS};
  const match = /^(\d+)x(\d+),f=([\d.]+),cx=([\d.]+),cy=([\d.]+)$/.exec(text.replace(/\s+/g, ''));
  if (!match) throw new Error('Use --intrinsics LARGURAxALTURA,f=F,cx=CX,cy=CY (ex.: 1920x1080,f=960,cx=720,cy=600).');
  const [width, height, f, cx, cy] = match.slice(1).map(Number);
  return {width, height, f, cx, cy};
}

export function keyframeName({epoch, s, zoom, intrinsics, heading}) {
  const i = intrinsics;
  return `kf-${epoch}-s${s.toFixed(1).padStart(6, '0')}-z${zoom}-${i.width}x${i.height}f${i.f}c${i.cx}x${i.cy}-h${heading.toFixed(2)}`;
}

export async function renderKeyframe({route, epoch = 'present', at, zoom = 5, scale = 2, intrinsics = DEFAULT_INTRINSICS,
  heading: headingMode = 'smooth', source, outDir = join(TIMELINE_DIR, 'keyframes'), log = console.log}) {
  const nodes = route.epochs[epoch].nodes;
  const node = at === 'portal' ? nearestNode(nodes, route.portalS, .01) : nearestNode(nodes, Number(at));
  const heading = headingMode === 'smooth' ? smoothHeading(nodes, node.s)
    : headingMode === 'app' ? headingAt(route, epoch, node.s) : Number(headingMode);
  if (!Number.isFinite(heading)) throw new Error(`Rumo inválido: ${headingMode}`);
  const name = keyframeName({epoch, s: node.s, zoom, intrinsics, heading});
  const png = join(outDir, `${name}.png`), sidecar = join(outDir, `${name}.json`);
  if (await exists(png)) { log(`= ${name}.png já existe`); return {png, sidecar, node, heading, skipped: true}; }
  const plan = planView({metadata: node.metadata, viewHeading: heading, intrinsics, zoom, scale});
  const started = Date.now();
  const {pixels, missing} = await source.fetchTiles(node.metadata, plan);
  const image = renderView(plan, pixels);
  await encodePng(image, png, {outWidth: intrinsics.width, outHeight: intrinsics.height});
  const details = {
    version: 1, epoch, s: node.s, portal: Math.abs(node.s - route.portalS) < .01, panoId: node.metadata.panoId,
    date: node.metadata.date, lat: node.metadata.lat, lng: node.metadata.lng, heading, headingMode,
    nodeHeading: node.heading, panoHeading: node.metadata.heading, tilt: node.metadata.tilt, roll: node.metadata.roll,
    zoom, scale, intrinsics, tiles: plan.tiles.length, downloadedTiles: missing, file: `${name}.png`, createdAt: new Date().toISOString(),
  };
  const temporary = temporaryPath(sidecar);
  await writeFile(temporary, JSON.stringify(details, null, 2));
  await publish(temporary, sidecar);
  log(`+ ${name}.png · s=${node.s.toFixed(1)} m · ${node.metadata.date} · rumo ${heading.toFixed(2)}° · ${plan.tiles.length} blocos (${missing} baixados) · ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return {png, sidecar, node, heading, details};
}

async function main() {
  const {values} = parseArgs({options: {
    at: {type: 'string'}, epoch: {type: 'string', default: 'present'}, zoom: {type: 'string', default: '5'},
    scale: {type: 'string', default: '2'}, heading: {type: 'string', default: 'smooth'}, intrinsics: {type: 'string'},
    out: {type: 'string'}, 'dry-run': {type: 'boolean', default: false}, 'local-only': {type: 'boolean', default: false},
    'max-downloads': {type: 'string', default: '400'},
  }});
  if (!values.at) throw new Error('Informe --at com distâncias em metros ou "portal" (ex.: --at 843.6,portal).');
  const env = loadEnv(), route = await loadRoute(env), zoom = Number(values.zoom), scale = Number(values.scale);
  const intrinsics = parseIntrinsics(values.intrinsics), targets = values.at.split(',').map(value => value.trim()).filter(Boolean);
  const source = createTileSource({apiKey: googleKey(env), zoom, allowDownload: !values['local-only'] && !values['dry-run'], maxDownloads: Number(values['max-downloads'])});
  try {
    if (values['dry-run']) {
      let total = 0, absent = 0;
      for (const at of targets) {
        const nodes = route.epochs[values.epoch].nodes;
        const node = at === 'portal' ? nearestNode(nodes, route.portalS, .01) : nearestNode(nodes, Number(at));
        const plan = planView({metadata: node.metadata, viewHeading: smoothHeading(nodes, node.s), intrinsics, zoom, scale});
        const missing = await source.countMissing(node.metadata, plan);
        total += plan.tiles.length; absent += missing;
        console.log(`s=${node.s.toFixed(1)} m · ${node.metadata.date} · ${plan.tiles.length} blocos · ${missing} ausentes em disco`);
      }
      console.log(`Total: ${total} blocos, ${absent} a baixar do Google (zoom ${zoom}).`);
      return;
    }
    for (const at of targets) {
      await renderKeyframe({route, epoch: values.epoch, at, zoom, scale, intrinsics, heading: values.heading, source,
        outDir: values.out || join(TIMELINE_DIR, 'keyframes')});
    }
    console.log(`Blocos: ${source.counts.disk} do disco, ${source.counts.google} do Google.`);
  } finally { source.dispose(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error.code === 'DAILY_QUOTA_EXCEEDED'
      ? 'Cota diária do Street View atingida. Nada foi perdido; tente depois da meia-noite do Pacífico (~05:00 em Brasília).'
      : `Erro: ${error.message}`);
    process.exitCode = 1;
  });
}
