// Look-dev batch (stage 1): what the model does with our frames, before paying for a whole drive.
import {readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {edit1955, continuity1955, drivePresent, drive1955, morphTo1955} from '../prompts.mjs';

export const MAGI = 'sand/magi-2/image-to-video';
export const SEEDREAM = 'bytedance/seedream/v5.0/pro/edit';
export const QWEN = 'alibaba/qwen-image-3/edit';
const NEGATIVE = 'modern skyscrapers, glass towers, modern cars, concrete barriers, plastic fences, bike lane, LED screens, billboards, text, watermark, sepia, black and white, film grain, blurry, distorted perspective';
const PRICE_PER_SECOND = .08;
const IMAGE_EXPECT_USD = .15;

const KEYFRAMES = {k0844: 843.6, k0879: 879.0, k0920: 919.6, k1004: 1003.7, k1088: 1088.0};

/** Keyframe files by distance, independent of the heading suffix in their names. */
export async function keyframeFiles(dir) {
  const names = await readdir(join(dir, 'keyframes')).catch(() => []);
  return Object.fromEntries(Object.entries(KEYFRAMES).map(([key, s]) => {
    const prefix = `kf-present-s${s.toFixed(1).padStart(6, '0')}-z5-1920x1080f960c720x600-h`;
    const match = names.filter(name => name.startsWith(prefix) && name.endsWith('.png')).sort().at(-1);
    return [key, match ? `keyframes/${match}` : null];
  }));
}

function editJob(id, title, model, prompt, imageUrls, {seed} = {}) {
  const params = model === QWEN
    ? {prompt, resolution: '2k', aspect_ratio: '16:9', negative_prompt: NEGATIVE, ...(seed === undefined ? {} : {seed})}
    : {prompt, resolution: '2k', aspect_ratio: '16:9'};
  return {id, title, model, output: 'images', expectUsd: IMAGE_EXPECT_USD, inputs: {image_urls: imageUrls}, params};
}

function videoJob(id, title, prompt, first, last, duration) {
  return {
    id, title, model: MAGI, output: 'video', expectUsd: duration * PRICE_PER_SECOND,
    inputs: last ? {image_url: first, end_image_url: last} : {image_url: first},
    params: {prompt, duration, aspect_ratio: '16:9', resolution: '1080p', seed: 1955, generate_audio: false},
  };
}

export async function lookdevShots({dir, selection = {}}) {
  const k = await keyframeFiles(dir);
  const missing = Object.entries(k).filter(([, file]) => !file).map(([key]) => key);
  if (missing.length) throw new Error(`Quadros-chave ausentes: ${missing.join(', ')}. Rode scripts/timeline/keyframes.mjs primeiro.`);
  const model1955 = selection.model1955 || SEEDREAM;
  return [
    editJob('I1', '1955 · Seedream · manhã', SEEDREAM, edit1955('manha'), [k.k1004]),
    editJob('I2', '1955 · Seedream · dia', SEEDREAM, edit1955('dia'), [k.k1004]),
    editJob('I3', '1955 · Seedream · manhã (variação)', SEEDREAM, edit1955('manha'), [k.k1004]),
    editJob('I4', '1955 · Qwen · manhã', QWEN, edit1955('manha'), [k.k1004], {seed: 11}),
    editJob('I5', '1955 · Qwen · dia', QWEN, edit1955('dia'), [k.k1004], {seed: 11}),
    editJob('I6', '1955 · Qwen · manhã (variação)', QWEN, edit1955('manha'), [k.k1004], {seed: 29}),
    videoJob('T1', 'Presente · 35 m entre fotos · 4 s', drivePresent, k.k0844, k.k0879, 4),
    videoJob('T2', 'Presente · 76 m entre fotos · 4 s', drivePresent, k.k0844, k.k0920, 4),
    videoJob('T3', 'Presente · 160 m até o portal · 4 s (ritmo de 88 mph)', drivePresent, k.k0844, k.k1004, 4),
    editJob('I7', '1955 · continuidade a 1088 m', model1955, continuity1955(), [k.k1088, {select: 'portal1955'}], {seed: 11}),
    videoJob('T4', '1955 livre · 8 s', drive1955, {select: 'portal1955'}, null, 8),
    videoJob('T5', '1955 ancorado · portal → 1088 m · 8 s', drive1955, {select: 'portal1955'}, {output: 'I7'}, 8),
    videoJob('T6', 'Salto como metamorfose · 920 m → portal 1955 · 5 s', morphTo1955, k.k0920, {select: 'portal1955'}, 5),
  ];
}
