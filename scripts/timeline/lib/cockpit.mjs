import {join} from 'node:path';
import {MAP} from '../../../src/car/cockpitMap.js';
import {ROOT} from './env.mjs';
import {decodeImageToRgb, encodePng, exists} from './ffmpeg.mjs';

export const COCKPIT_IMAGE = join(ROOT, 'public', 'img', 'cockpit.png');

/** The drive-view projection of src/car/cockpit.js (zoom 0, no pan): photo placement and screen intrinsics. */
export function cockpitLayout(width, height) {
  const scale = 1.06 * Math.max(width / MAP.width, height / (2 * (MAP.height - MAP.dashY)));
  const offsetX = (width - scale * MAP.width) / 2, offsetY = height / 2 - scale * MAP.dashY;
  return {width, height, scale, offsetX, offsetY, f: scale * MAP.focal, cx: offsetX + scale * MAP.vx, cy: offsetY + scale * MAP.vy};
}

export function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Cockpit alpha: 0 inside the windshield polygon, 255 elsewhere, 4x4 supersampled edges (even-odd scanlines). */
export function windshieldMask(width = MAP.width, height = MAP.height, polygon = MAP.windshield) {
  const coverage = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let sy = 0; sy < 4; sy++) {
    const py = y + (sy + .5) / 4, crossings = [];
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
      if ((yi > py) !== (yj > py)) crossings.push((xj - xi) * (py - yi) / (yj - yi) + xi);
    }
    crossings.sort((a, b) => a - b);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      // Sub-sample columns x + (sx + .5) / 4 strictly left of the right crossing, at or right of the left one.
      const first = Math.max(0, Math.ceil(crossings[k] * 4 - .5)), last = Math.min(width * 4 - 1, Math.ceil(crossings[k + 1] * 4 - .5) - 1);
      for (let sample = first; sample <= last; sample++) coverage[y * width + (sample >> 2)]++;
    }
  }
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = Math.round(255 * (1 - coverage[i] / 16));
  return mask;
}

/** RGBA overlay of the cockpit photo with the windshield cut out, cached as a PNG. */
export async function cockpitOverlay(final) {
  if (await exists(final)) return final;
  const photo = await decodeImageToRgb(COCKPIT_IMAGE);
  if (photo.width !== MAP.width || photo.height !== MAP.height) throw new Error('A foto da cabine mudou de tamanho; recalibre cockpitMap.js.');
  const mask = windshieldMask(photo.width, photo.height), rgba = new Uint8Array(photo.width * photo.height * 4);
  for (let i = 0; i < mask.length; i++) {
    rgba[i * 4] = photo.data[i * 3]; rgba[i * 4 + 1] = photo.data[i * 3 + 1]; rgba[i * 4 + 2] = photo.data[i * 3 + 2]; rgba[i * 4 + 3] = mask[i];
  }
  return encodePng({data: rgba, width: photo.width, height: photo.height, pixFmt: 'rgba'}, final);
}
