import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {panoramaOrientation} from '../src/street/panoramaRenderer.js';
import {
  applyMatrix, cameraToPanorama, directionToUV, planView, renderView, smoothHeading, positionAt, bearing, nearestNode,
} from '../scripts/timeline/lib/projection.mjs';
import {keyframeName, parseIntrinsics} from '../scripts/timeline/keyframes.mjs';
import {cockpitLayout, windshieldMask} from '../scripts/timeline/lib/cockpit.mjs';
import {MAP} from '../src/car/cockpitMap.js';

function random(seed) { return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32; }
const uvDistance = ([u1, v1], [u2, v2]) => Math.hypot(Math.min(Math.abs(u1 - u2), 1 - Math.abs(u1 - u2)), v1 - v2);

test('closed-form ray matches the app camera (offset projection) and panorama orientation in three.js', () => {
  const next = random(7);
  for (let k = 0; k < 600; k++) {
    const metadata = {heading: next() * 360, tilt: 84 + next() * 12, roll: -6 + next() * 12};
    const view = next() * 360, pitch = -20 + next() * 40;
    const W = 1000 + Math.round(next() * 1600), H = 600 + Math.round(next() * 800);
    const f = 500 + next() * 900, cx = next() * W, cy = next() * H;
    const camera = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(2 * Math.atan(H / (2 * f))), W / H, .055, 1000);
    camera.setViewOffset(W, H, W / 2 - cx, H / 2 - cy, W, H);
    camera.rotation.set(THREE.MathUtils.degToRad(pitch), -THREE.MathUtils.degToRad(view), 0, 'YXZ');
    camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
    const X = next() * W, Y = next() * H;
    const world = new THREE.Vector3(X / W * 2 - 1, 1 - Y / H * 2, .5).unproject(camera).normalize();
    const local = world.applyQuaternion(panoramaOrientation(metadata).invert());
    const expected = directionToUV([local.x, local.y, local.z]);
    const actual = directionToUV(applyMatrix(cameraToPanorama(metadata, view, pitch), [(X - cx) / f, (cy - Y) / f, -1]));
    assert.ok(uvDistance(expected, actual) < 1e-9, `caso ${k}: ${expected} vs ${actual}`);
  }
});

test('equirect lookup inverts the app sphere geometry, so u = .5 is the panorama heading and v = 0 the zenith', () => {
  const geometry = new THREE.SphereGeometry(100, 96, 48);
  geometry.scale(-1, 1, 1); geometry.rotateY(-Math.PI / 2);
  const position = geometry.attributes.position, uv = geometry.attributes.uv;
  let checked = 0;
  for (let i = 0; i < position.count; i++) {
    const v = 1 - uv.getY(i);
    if (v < 1e-6 || v > 1 - 1e-6) continue; // poles carry a half-segment u offset
    const actual = directionToUV([position.getX(i), position.getY(i), position.getZ(i)]);
    assert.ok(uvDistance(actual, [uv.getX(i) % 1, v]) < 1e-6, `vértice ${i}`); // attributes are Float32
    checked++;
  }
  assert.ok(checked > 4000);
  assert.deepEqual(directionToUV(applyMatrix(cameraToPanorama({heading: 40, tilt: 90, roll: 0}, 40), [0, 0, -1])).map(value => +value.toFixed(9)), [.5, .5]);
});

test('tile planning covers the bilinear footprint, wraps across u = 0 and renders from the right tiles', () => {
  const metadata = {panoId: 'synthetic', heading: 0, tilt: 90, roll: 0, imageWidth: 2048, imageHeight: 1024, tileWidth: 512, tileHeight: 512};
  const intrinsics = {width: 160, height: 90, f: 80, cx: 60, cy: 50};
  // Looking 180 degrees away from the heading puts the view on the u = 0 / 1 seam.
  const seam = planView({metadata, viewHeading: 180, intrinsics, zoom: 5});
  const columns = new Set(seam.tiles.map(tile => tile.x));
  assert.ok(columns.has(0) && columns.has(3), 'precisa dos dois lados da emenda');
  // A horizontal ramp R = 255u, G = 255v makes every sample checkable away from the seam.
  const layout = seam.layout, tiles = new Map();
  for (let ty = 0; ty < layout.rows; ty++) for (let tx = 0; tx < layout.columns; tx++) {
    const data = new Uint8Array(512 * 512 * 3);
    for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
      const gx = tx * 512 + x, gy = ty * 512 + y, o = (y * 512 + x) * 3;
      data[o] = Math.round((gx + .5) / layout.width * 255); data[o + 1] = Math.round((gy + .5) / layout.height * 255); data[o + 2] = tx * 10 + ty;
    }
    tiles.set(`${tx},${ty}`, data);
  }
  const plan = planView({metadata, viewHeading: 30, intrinsics, zoom: 5});
  const image = renderView(plan, tile => tiles.get(`${tile.x},${tile.y}`));
  assert.equal(image.data.length, 160 * 90 * 3);
  for (const [i, j] of [[60, 50], [5, 5], [150, 80], [100, 20]]) {
    const [u, v] = directionToUV(applyMatrix(plan.matrix, [(i + .5 - 60) / 80, (50 - (j + .5)) / 80, -1]));
    const o = (j * 160 + i) * 3;
    assert.ok(Math.abs(image.data[o] - u * 255) <= 1.5, `R em ${i},${j}`);
    assert.ok(Math.abs(image.data[o + 1] - v * 255) <= 1.5, `G em ${i},${j}`);
  }
  assert.throws(() => renderView(plan, () => null), /ausente/);
});

test('smoothed road heading follows positions, not per-panorama headings', () => {
  const start = {lat: -23.56, lng: -46.65}, east = {lat: -23.56, lng: -46.64};
  const nodes = Array.from({length: 11}, (_, i) => ({s: i * 10, heading: i % 2 ? 300 : 320,
    metadata: {lat: start.lat, lng: start.lng + (east.lng - start.lng) * i / 10}}));
  assert.ok(Math.abs(smoothHeading(nodes, 50, 40) - bearing(positionAt(nodes, 10), positionAt(nodes, 90))) < 1e-9);
  assert.ok(Math.abs(smoothHeading(nodes, 50, 40) - bearing(start, east)) < .01, 'rumos alternados 300/320 são ignorados');
  assert.ok(Math.abs(positionAt(nodes, 25).lng - (start.lng + (east.lng - start.lng) * .25)) < 1e-12);
  assert.equal(nearestNode(nodes, 30.4).s, 30);
  assert.throws(() => nearestNode(nodes, 35), /Nenhum panorama/);
});

test('keyframe names and intrinsics are explicit and stable', () => {
  assert.deepEqual(parseIntrinsics('1920x1080,f=960,cx=720,cy=600'), {width: 1920, height: 1080, f: 960, cx: 720, cy: 600});
  assert.throws(() => parseIntrinsics('1920x1080'), /intrinsics/);
  assert.equal(keyframeName({epoch: 'present', s: 843.62, zoom: 5, intrinsics: parseIntrinsics(), heading: 311.954}),
    'kf-present-s0843.6-z5-1920x1080f960c720x600-h311.95');
});

test('cockpit layout reproduces the drive-view projection; the windshield mask opens only the glass', () => {
  const layout = cockpitLayout(1920, 1080);
  const s = 1.06 * Math.max(1920 / MAP.width, 1080 / (2 * (MAP.height - MAP.dashY)));
  assert.ok(Math.abs(layout.scale - s) < 1e-12);
  assert.ok(Math.abs(layout.f - s * MAP.focal) < 1e-9);
  assert.ok(Math.abs(layout.cy - (540 - s * MAP.dashY + s * MAP.vy)) < 1e-9);
  const mask = windshieldMask(MAP.width, MAP.height);
  assert.equal(mask[50 * MAP.width + 800], 0, 'para-brisa transparente');
  assert.equal(mask[600 * MAP.width + 800], 255, 'painel opaco');
  assert.equal(mask[100 * MAP.width + 20], 255, 'coluna esquerda opaca');
});
