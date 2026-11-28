import {getTileLayout} from '../../../src/street/googleProvider.js';

const RAD = Math.PI / 180;
const EARTH_RADIUS = 6371008.8;

/** Generated frames: 16:9 at 1080p, framed like the cockpit (vanishing point left of centre, horizon slightly low). */
export const DEFAULT_INTRINSICS = Object.freeze({width: 1920, height: 1080, f: 960, cx: 720, cy: 600});

// Row-major 3x3 rotations with three.js handedness.
const rotX = a => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, -s, 0, s, c]; };
const rotY = a => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c]; };
const rotZ = a => { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0, 0, 0, 1]; };
function multiply(a, b) {
  const out = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  }
  return out;
}
export function applyMatrix(m, [x, y, z]) {
  return [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
}

/**
 * Camera space -> panorama sphere local space, as the app renders it:
 * camera.rotation = (pitch, -heading, 0, 'YXZ') and the sphere mesh uses panoramaOrientation(metadata),
 * i.e. Euler(90 - tilt, -heading, -roll, 'YXZ'). local = R_Z(roll) R_X(-(90 - tilt)) R_Y(panoHeading - view) R_X(pitch) cam.
 */
export function cameraToPanorama(metadata, viewHeading, viewPitch = 0) {
  const heading = (metadata.heading ?? 0) * RAD, tilt = (90 - (metadata.tilt ?? 90)) * RAD, roll = (metadata.roll ?? 0) * RAD;
  return multiply(rotZ(roll), multiply(rotX(-tilt), multiply(rotY(heading - viewHeading * RAD), rotX(viewPitch * RAD))));
}

/** Inverse of three.js SphereGeometry after the app's scale(-1,1,1) and rotateY(-PI/2): u from the left, v from the top. */
export function directionToUV([x, y, z]) {
  const length = Math.hypot(x, y, z);
  let u = Math.atan2(-x, z) / (2 * Math.PI);
  u -= Math.floor(u);
  return [u, Math.acos(Math.max(-1, Math.min(1, y / length))) / Math.PI];
}

/** Ray through the centre of output pixel (i, j); i, j in output pixels of a grid `scale` times denser. */
export function cameraRay(i, j, {f, cx, cy}, scale = 1) {
  return [((i + .5) / scale - cx) / f, (cy - (j + .5) / scale) / f, -1];
}

/** Calls visit(px, py) with the equirect source position (pixel units, centres at .5) of every output pixel, row by row. */
function forEachSource({matrix: m, layout, intrinsics, scale}, visit) {
  const width = Math.round(intrinsics.width * scale), height = Math.round(intrinsics.height * scale);
  const {f, cx, cy} = intrinsics, TAU = 2 * Math.PI;
  for (let j = 0; j < height; j++) {
    const y = (cy - (j + .5) / scale) / f;
    for (let i = 0; i < width; i++) {
      const x = ((i + .5) / scale - cx) / f;
      const lx = m[0] * x + m[1] * y - m[2], ly = m[3] * x + m[4] * y - m[5], lz = m[6] * x + m[7] * y - m[8];
      let u = Math.atan2(-lx, lz) / TAU;
      u -= Math.floor(u);
      const v = Math.acos(Math.max(-1, Math.min(1, ly / Math.sqrt(lx * lx + ly * ly + lz * lz)))) / Math.PI;
      visit(u * layout.width - .5, v * layout.height - .5);
    }
  }
}

const wrap = (x, size) => ((x % size) + size) % size;
const clampRow = (y, size) => y < 0 ? 0 : y >= size ? size - 1 : y;

/** Everything needed to render one view; `tiles` is the exact bilinear footprint at this zoom. */
export function planView({metadata, viewHeading, viewPitch = 0, intrinsics = DEFAULT_INTRINSICS, zoom = 5, scale = 1}) {
  const layout = getTileLayout(metadata, zoom), matrix = cameraToPanorama(metadata, viewHeading, viewPitch);
  const plan = {metadata, viewHeading, viewPitch, intrinsics: {...intrinsics}, zoom, scale, layout, matrix};
  const needed = new Uint8Array(layout.columns * layout.rows);
  const tw = layout.tileWidth, th = layout.tileHeight;
  forEachSource(plan, (px, py) => {
    const x0 = Math.floor(px), y0 = Math.floor(py);
    const ca = Math.floor(wrap(x0, layout.width) / tw), cb = Math.floor(wrap(x0 + 1, layout.width) / tw);
    const ra = Math.floor(clampRow(y0, layout.height) / th) * layout.columns, rb = Math.floor(clampRow(y0 + 1, layout.height) / th) * layout.columns;
    needed[ra + ca] = needed[ra + cb] = needed[rb + ca] = needed[rb + cb] = 1;
  });
  plan.tiles = [];
  needed.forEach((flag, index) => {
    if (!flag) return;
    const x = index % layout.columns, y = Math.floor(index / layout.columns);
    plan.tiles.push({x, y, width: Math.min(tw, layout.width - x * tw), height: Math.min(th, layout.height - y * th)});
  });
  return plan;
}

/**
 * Bilinear rectilinear render. `pixels(tile)` returns the tile's RGB24 bytes (tileWidth x tileHeight).
 * Returns RGB24 at intrinsics * scale; downscale afterwards for anti-aliasing.
 */
export function renderView(plan, pixels) {
  const {layout, intrinsics, scale} = plan;
  const width = Math.round(intrinsics.width * scale), height = Math.round(intrinsics.height * scale);
  const tw = layout.tileWidth, th = layout.tileHeight, columns = layout.columns;
  const grid = new Array(columns * layout.rows).fill(null);
  for (const tile of plan.tiles) {
    const data = pixels(tile);
    if (!data || data.length < tw * th * 3) throw new Error(`Bloco ${tile.x},${tile.y} ausente ou incompleto.`);
    grid[tile.y * columns + tile.x] = data;
  }
  const source = (x, y) => {
    const data = grid[Math.floor(y / th) * columns + Math.floor(x / tw)];
    if (!data) throw new Error(`Amostra fora dos blocos planejados (${x}, ${y}).`);
    return data;
  };
  const out = new Uint8Array(width * height * 3);
  let offset = 0;
  forEachSource(plan, (px, py) => {
    const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
    const xa = wrap(x0, layout.width), xb = wrap(x0 + 1, layout.width);
    const ya = clampRow(y0, layout.height), yb = clampRow(y0 + 1, layout.height);
    const d00 = source(xa, ya), d10 = source(xb, ya), d01 = source(xa, yb), d11 = source(xb, yb);
    const o00 = ((ya % th) * tw + xa % tw) * 3, o10 = ((ya % th) * tw + xb % tw) * 3;
    const o01 = ((yb % th) * tw + xa % tw) * 3, o11 = ((yb % th) * tw + xb % tw) * 3;
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
    for (let c = 0; c < 3; c++) {
      out[offset++] = Math.round(d00[o00 + c] * w00 + d10[o10 + c] * w10 + d01[o01 + c] * w01 + d11[o11 + c] * w11);
    }
  });
  return {width, height, data: out};
}

export function bearing(a, b) {
  const dLng = (b.lng - a.lng) * RAD, latA = a.lat * RAD, latB = b.lat * RAD;
  return (Math.atan2(Math.sin(dLng) * Math.cos(latB), Math.cos(latA) * Math.sin(latB) - Math.sin(latA) * Math.cos(latB) * Math.cos(dLng)) / RAD + 360) % 360;
}

export function distanceMeters(a, b) {
  const dLat = (b.lat - a.lat) * RAD, dLng = (b.lng - a.lng) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

/** Position along the captured route at distance s (linear between nodes, clamped to the ends). */
export function positionAt(nodes, s) {
  if (s <= nodes[0].s) return {lat: nodes[0].metadata.lat, lng: nodes[0].metadata.lng};
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i].s >= s) {
      const a = nodes[i - 1], b = nodes[i], t = (s - a.s) / (b.s - a.s);
      return {lat: a.metadata.lat + (b.metadata.lat - a.metadata.lat) * t, lng: a.metadata.lng + (b.metadata.lng - a.metadata.lng) * t};
    }
  }
  const last = nodes.at(-1);
  return {lat: last.metadata.lat, lng: last.metadata.lng};
}

/** Road direction from the positions span metres behind and ahead: steadier than per-panorama headings. */
export function smoothHeading(nodes, s, span = 40) {
  const from = Math.max(nodes[0].s, s - span), to = Math.min(nodes.at(-1).s, s + span);
  return bearing(positionAt(nodes, from), positionAt(nodes, to));
}

export function nearestNode(nodes, s, tolerance = .75) {
  let best = null;
  for (const node of nodes) if (!best || Math.abs(node.s - s) < Math.abs(best.s - s)) best = node;
  if (!best || Math.abs(best.s - s) > tolerance) throw new Error(`Nenhum panorama a menos de ${tolerance} m de s=${s}.`);
  return best;
}
