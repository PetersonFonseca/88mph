#!/usr/bin/env node
// Builds the look-dev review: cockpit previews, contact sheets, speed measurements and an HTML page.
//   node scripts/timeline/review.mjs        (reads .cache/timeline/paulista/state.json; writes artifacts/timeline-lookdev/)
import {readFile, writeFile, mkdir, copyFile} from 'node:fs/promises';
import {join, basename, extname} from 'node:path';
import {MAP} from '../../src/car/cockpitMap.js';
import {loadEnv, googleKey, ROOT, TIMELINE_DIR} from './lib/env.mjs';
import {DEFAULT_INTRINSICS, planView, renderView, smoothHeading} from './lib/projection.mjs';
import {createTileSource} from './lib/tiles.mjs';
import {cockpitLayout, cockpitOverlay} from './lib/cockpit.mjs';
import {ffmpeg, run, probe, contactSheet, exists, temporaryPath, publish} from './lib/ffmpeg.mjs';

export const REVIEW_DIR = join(ROOT, 'artifacts', 'timeline-lookdev');
const even = value => 2 * Math.round(value / 2);

/** Where the generated frame lands on screen so that its vanishing point sits on the cockpit's. */
export function compositeGeometry(width, height, video, intrinsics = DEFAULT_INTRINSICS) {
  const layout = cockpitLayout(width, height);
  const ratio = video.width / intrinsics.width; // generated clips may come back at another size
  const k = layout.f / (intrinsics.f * ratio);
  return {
    layout, k,
    video: {width: even(video.width * k), height: even(video.height * k),
      x: Math.round(layout.cx - intrinsics.cx * ratio * k), y: Math.round(layout.cy - intrinsics.cy * ratio * k)},
    cockpit: {width: Math.round(MAP.width * layout.scale), height: Math.round(MAP.height * layout.scale), x: Math.round(layout.offsetX), y: Math.round(layout.offsetY)},
    roof: Math.max(0, Math.round(layout.offsetX + 57 * layout.scale)),
  };
}

/** The clip seen through the DeLorean windshield, as the app would frame it at width x height. */
export async function cockpitPreview(video, final, {width = 1920, height = 1080, intrinsics = DEFAULT_INTRINSICS} = {}) {
  if (await exists(final)) return final;
  const info = await probe(video), g = compositeGeometry(width, height, info, intrinsics);
  const overlay = await cockpitOverlay(join(TIMELINE_DIR, 'review', 'cockpit-overlay.png'));
  const temporary = temporaryPath(final);
  const roof = g.roof ? `,drawbox=x=0:y=0:w=${g.roof}:h=${height}:color=0x12171b:t=fill` : '';
  await ffmpeg(['-i', video, '-loop', '1', '-i', overlay, '-filter_complex',
    `color=c=0x08131b:s=${width}x${height}:r=${info.fps || 24}[base];` +
    `[0:v]scale=${g.video.width}:${g.video.height}:flags=lanczos,setsar=1[clip];` +
    `[base][clip]overlay=x=${g.video.x}:y=${g.video.y}:shortest=1[street];` +
    `[1:v]scale=${g.cockpit.width}:${g.cockpit.height}:flags=lanczos,format=rgba[cockpit];` +
    `[street][cockpit]overlay=x=${g.cockpit.x}:y=${g.cockpit.y}:shortest=1${roof},format=yuv420p[out]`,
    '-map', '[out]', '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-movflags', '+faststart', '-y', temporary]);
  return publish(temporary, final);
}

/** Present-day clip -> white flash -> 1955 clip, both already framed in the cockpit. */
export async function miniTrip(present, past, final, {flash = 1.2} = {}) {
  if (await exists(final)) return final;
  const a = await probe(present), b = await probe(past);
  const fps = a.fps || 24, offset = Math.max(0, a.duration - flash);
  const temporary = temporaryPath(final);
  await ffmpeg(['-i', present, '-i', past, '-filter_complex',
    `[0:v]fps=${fps},format=yuv420p,setsar=1[a];[1:v]fps=${fps},scale=${a.width}:${a.height},format=yuv420p,setsar=1[b];` +
    `[a][b]xfade=transition=fadewhite:duration=${flash}:offset=${offset.toFixed(3)},format=yuv420p[out]`,
    '-map', '[out]', '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-movflags', '+faststart', '-y', temporary]);
  void b;
  return publish(temporary, final);
}

async function grayFrames(video, width, height) {
  const data = await run('ffmpeg', ['-hide_banner', '-v', 'error', '-i', video, '-vf', `scale=${width}:${height}:flags=area,format=gray`, '-f', 'rawvideo', 'pipe:1']);
  const size = width * height, frames = [];
  for (let offset = 0; offset + size <= data.length; offset += size) frames.push(data.subarray(offset, offset + size));
  return frames;
}

function toGray({data, width, height}) {
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) gray[i] = Math.round(.2126 * data[i * 3] + .7152 * data[i * 3 + 1] + .0722 * data[i * 3 + 2]);
  return gray;
}

/** Normalized cross-correlation over the upper part of the frame (buildings, not the traffic near the car). */
export function similarity(a, b, width, height, rows = .62) {
  const limit = Math.round(height * rows) * width;
  let ma = 0, mb = 0;
  for (let i = 0; i < limit; i++) { ma += a[i]; mb += b[i]; }
  ma /= limit; mb /= limit;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < limit; i++) { const x = a[i] - ma, y = b[i] - mb; ab += x * y; aa += x * x; bb += y * y; }
  return ab / Math.sqrt(aa * bb || 1);
}

/**
 * Where along the avenue each frame is: the best-matching real panorama between the clip's first and last
 * keyframes (rendered free from the zoom-3 archive with the same framing). Smoothed by a running median.
 */
export async function measureTravel(video, {route, sFrom, sTo, source, epoch = 'present', size = [192, 108]}) {
  const [width, height] = size, scale = width / DEFAULT_INTRINSICS.width;
  const intrinsics = {width, height, f: DEFAULT_INTRINSICS.f * scale, cx: DEFAULT_INTRINSICS.cx * scale, cy: DEFAULT_INTRINSICS.cy * scale};
  const nodes = route.epochs[epoch].nodes, candidates = nodes.filter(node => node.s >= sFrom - .5 && node.s <= sTo + .5);
  const references = [];
  for (const node of candidates) {
    const plan = planView({metadata: node.metadata, viewHeading: smoothHeading(nodes, node.s), intrinsics, zoom: 3, scale: 1});
    const {pixels} = await source.fetchTiles(node.metadata, plan);
    references.push({s: node.s, gray: toGray(renderView(plan, pixels))});
  }
  const info = await probe(video), frames = await grayFrames(video, width, height);
  const raw = frames.map(frame => {
    let best = null;
    for (const reference of references) {
      const score = similarity(frame, reference.gray, width, height);
      if (!best || score > best.score) best = {s: reference.s, score};
    }
    return best;
  });
  const window = 5, smooth = raw.map((_, i) => {
    const values = raw.slice(Math.max(0, i - window), i + window + 1).map(item => item.s).sort((x, y) => x - y);
    return values[Math.floor(values.length / 2)];
  });
  const fps = info.fps || frames.length / info.duration;
  const samples = smooth.map((s, i) => ({t: i / fps, s, score: raw[i].score}));
  const linear = t => sFrom + (sTo - sFrom) * t / ((frames.length - 1) / fps);
  const deviation = Math.max(...samples.map(sample => Math.abs(sample.s - linear(sample.t))));
  let backwards = 0;
  for (let i = 1; i < smooth.length; i++) if (smooth[i] < smooth[i - 1] - 1) backwards++;
  return {fps, frames: frames.length, candidates: candidates.length, samples, maxDeviationM: deviation, backwardSteps: backwards,
    meanScore: samples.reduce((sum, sample) => sum + sample.score, 0) / samples.length};
}

const escapeHtml = text => String(text ?? '').replace(/[&<>"]/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[char]);

function page({cards, committed, generatedAt}) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Paulista 1955 · revisão</title><style>
:root{color-scheme:dark;--bg:#0b0f12;--card:#141a1f;--line:#26313a;--text:#e8eef2;--muted:#94a3ad;--accent:#ff8a3d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,sans-serif}
header{padding:28px 16px 8px;max-width:1280px;margin:auto}h1{margin:0 0 4px;font-size:26px}header p{margin:0;color:var(--muted)}
main{display:grid;gap:18px;padding:16px;max-width:1280px;margin:auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
.card h2{margin:0 0 4px;font-size:17px}.meta{color:var(--muted);font-size:13px;margin:0 0 10px}
.grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr))}
video,img{width:100%;border-radius:8px;background:#000;display:block}figure{margin:0}figcaption{color:var(--muted);font-size:12px;margin-top:4px}
.tag{display:inline-block;padding:1px 8px;border-radius:99px;background:#22303a;color:var(--text);font-size:12px;margin-right:6px}
.warn{color:var(--accent)}svg{width:100%;height:auto;background:#0f1418;border-radius:8px}
</style></head><body><header><h1>Paulista 1955 · teste de visual</h1>
<p>Recriação por IA a partir de fotos do Street View (Google). Uso local, não publicar. Gasto comprometido: US$ ${committed.toFixed(2)} · gerado em ${escapeHtml(generatedAt)}.</p></header>
<main>${cards.join('\n')}</main></body></html>`;
}

function travelChart(measure, sFrom, sTo) {
  const w = 600, h = 220, pad = 34, tMax = measure.samples.at(-1)?.t || 1;
  const x = t => pad + (w - 2 * pad) * t / tMax, y = s => h - pad - (h - 2 * pad) * (s - sFrom) / ((sTo - sFrom) || 1);
  const points = measure.samples.map(sample => `${x(sample.t).toFixed(1)},${y(sample.s).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Posição na avenida ao longo do clipe">
<line x1="${pad}" y1="${y(sFrom)}" x2="${w - pad}" y2="${y(sTo)}" stroke="#4b5b66" stroke-dasharray="4 4"/>
<polyline points="${points}" fill="none" stroke="#ff8a3d" stroke-width="2.5"/>
<text x="${pad}" y="${h - 10}" fill="#94a3ad" font-size="12">0 s</text><text x="${w - pad}" y="${h - 10}" fill="#94a3ad" font-size="12" text-anchor="end">${tMax.toFixed(1)} s</text>
<text x="6" y="${y(sFrom)}" fill="#94a3ad" font-size="12">${sFrom.toFixed(0)} m</text><text x="6" y="${y(sTo) + 12}" fill="#94a3ad" font-size="12">${sTo.toFixed(0)} m</text></svg>
<figcaption>Laranja: posição estimada quadro a quadro (melhor foto real correspondente). Tracejado: velocidade constante. Desvio máximo ${measure.maxDeviationM.toFixed(0)} m${measure.backwardSteps ? ` · <span class="warn">${measure.backwardSteps} recuos</span>` : ''}.</figcaption>`;
}

async function main() {
  const statePath = join(TIMELINE_DIR, 'state.json');
  if (!await exists(statePath)) { console.log('Nada gerado ainda (state.json ausente).'); return; }
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const {lookdevShots} = await import('./shots/lookdev.mjs');
  let selection = {};
  try { selection = JSON.parse(await readFile(join(TIMELINE_DIR, 'selection.json'), 'utf8')); } catch { /* not chosen yet */ }
  const specs = await lookdevShots({dir: TIMELINE_DIR, selection});
  const media = join(REVIEW_DIR, 'media');
  await mkdir(media, {recursive: true});
  const env = loadEnv();
  const {loadRoute} = await import('./keyframes.mjs');
  const route = await loadRoute(env), source = createTileSource({apiKey: googleKey(env), zoom: 3});
  const copy = async file => {
    const target = join(media, basename(file));
    if (!await exists(target)) await copyFile(join(TIMELINE_DIR, file), target);
    return `media/${basename(file)}`;
  };
  const cards = [], measurements = {};
  const sOf = file => Number(/-s(\d+\.\d)-/.exec(file || '')?.[1]);
  try {
    for (const spec of specs) {
      const record = state.jobs[spec.id];
      if (record?.state !== 'downloaded') continue;
      const tags = `<span class="tag">${escapeHtml(spec.model)}</span><span class="tag">US$ ${(record.estimateUsd ?? 0).toFixed(2)}</span>`;
      if (spec.output === 'images') {
        const inputs = [record.inputs.image_urls].flat();
        const figures = [`<figure><img src="${await copy(inputs[0])}" alt="Quadro original"><figcaption>Original (Street View)</figcaption></figure>`];
        for (const [index, output] of record.outputs.entries()) {
          figures.push(`<figure><img src="${await copy(output.file)}" alt="${escapeHtml(spec.title)}"><figcaption>${escapeHtml(spec.id)}${record.outputs.length > 1 ? `:${index + 1}` : ''} · ${escapeHtml(basename(output.file))}</figcaption></figure>`);
        }
        cards.push(`<section class="card"><h2>${escapeHtml(spec.id)} · ${escapeHtml(spec.title)}</h2><p class="meta">${tags}</p><div class="grid">${figures.join('')}</div></section>`);
        continue;
      }
      const clip = join(TIMELINE_DIR, record.outputs[0].file), stem = basename(clip, extname(clip));
      const info = await probe(clip);
      const preview = await cockpitPreview(clip, join(media, `${stem}-cabine.mp4`));
      const sheet = await contactSheet(clip, join(media, `${stem}-folha.png`), {every: Math.max(1, Math.round((info.frames || 96) / 24))});
      let chart = '';
      const first = record.inputs.image_url, last = record.inputs.end_image_url;
      if (first?.startsWith('keyframes/') && last?.startsWith('keyframes/')) {
        const measure = await measureTravel(clip, {route, sFrom: sOf(first), sTo: sOf(last), source});
        measurements[spec.id] = {...measure, samples: undefined, sFrom: sOf(first), sTo: sOf(last)};
        chart = travelChart(measure, sOf(first), sOf(last));
      }
      cards.push(`<section class="card"><h2>${escapeHtml(spec.id)} · ${escapeHtml(spec.title)}</h2>
<p class="meta">${tags}<span class="tag">${info.width}×${info.height} · ${info.fps?.toFixed(2)} fps · ${info.frames} quadros · ${info.duration?.toFixed(2)} s</span></p>
<div class="grid"><figure><video src="${await copy(record.outputs[0].file)}" controls loop muted playsinline></video><figcaption>Clipe gerado</figcaption></figure>
<figure><video src="media/${basename(preview)}" controls loop muted playsinline></video><figcaption>Pelo para-brisa, como no app (1920×1080)</figcaption></figure>
<figure><img src="media/${basename(sheet)}" alt="Folha de contato"><figcaption>Folha de contato</figcaption></figure>${chart ? `<figure>${chart}</figure>` : ''}</div></section>`);
    }
    const present = state.jobs.T3?.state === 'downloaded' ? state.jobs.T3 : null;
    const past = ['T5', 'T4'].map(id => state.jobs[id]).find(record => record?.state === 'downloaded');
    if (present && past) {
      const name = (record, suffix) => join(media, `${basename(record.outputs[0].file, extname(record.outputs[0].file))}${suffix}`);
      const trip = await miniTrip(name(present, '-cabine.mp4'), name(past, '-cabine.mp4'), join(media, `viagem-${present.requestId.slice(0, 8)}-${past.requestId.slice(0, 8)}.mp4`));
      cards.unshift(`<section class="card"><h2>Mini-viagem · presente → clarão → 1955</h2><p class="meta">T3 + ${past === state.jobs.T5 ? 'T5' : 'T4'}, montados como no app</p><video src="media/${basename(trip)}" controls loop muted playsinline></video></section>`);
    }
  } finally { source.dispose(); }
  let committed = 0;
  for (const record of Object.values(state.jobs)) for (const attempt of [record, ...(record.attempts || [])]) {
    if (['submitting', 'accepted', 'completed', 'downloaded'].includes(attempt.state)) committed += attempt.estimateUsd || 0;
  }
  await writeFile(join(REVIEW_DIR, 'measurements.json'), JSON.stringify(measurements, null, 2));
  await writeFile(join(REVIEW_DIR, 'index.html'), page({cards, committed, generatedAt: new Date().toLocaleString('pt-BR')}));
  console.log(`Revisão: ${join(REVIEW_DIR, 'index.html')} · ${cards.length} itens · gasto comprometido US$ ${committed.toFixed(2)}`);
  for (const [id, measure] of Object.entries(measurements)) {
    console.log(`  ${id}: ${measure.frames} quadros a ${measure.fps.toFixed(2)} fps · desvio máx. ${measure.maxDeviationM.toFixed(0)} m da velocidade constante · ${measure.backwardSteps} recuos · correlação média ${measure.meanScore.toFixed(2)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => { console.error(`Erro: ${error.message}`); process.exitCode = 1; });
}
