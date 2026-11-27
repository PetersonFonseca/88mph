import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createGoogleProvider, getTileLayout, normalizeMetadata } from '../src/street/googleProvider.js';
import { PanoramaRenderer, panoramaOrientation } from '../src/street/panoramaRenderer.js';

const metadata = {
  panoId: 'current-pano', date: '2024-08', lat: -23.56, lng: -46.65,
  heading: 94.35, tilt: 88.4, roll: 1.7, imageWidth: 13312, imageHeight: 6656,
  tileWidth: 512, tileHeight: 512, copyright: '© Google',
  reportProblemLink: 'https://cbks0.googleapis.com/cbk?output=report&panoid=current-pano',
  links: [{ panoId: 'next-pano', heading: 92, text: 'Avenida Paulista' }],
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const session = (token = 'session-token', expiry = Date.now() + 3600000) => json({ session: token, expiry: String(Math.floor(expiry / 1000)), tileWidth: 512, tileHeight: 512 });

test('official sessions are shared by concurrent requests; metadata is normalized without inventing historical dates', async () => {
  const calls = [];
  const provider = createGoogleProvider({ apiKey: 'test-secret', fetchImpl: async (input, init) => {
    const url = new URL(input); calls.push({ url, init });
    if (url.pathname.endsWith('/createSession')) return session();
    return json(metadata);
  } });
  const [a, b] = await Promise.all([provider.getMetadata({ lat: -23.56, lng: -46.65 }), provider.getMetadata({ panoId: 'old-id', lat: 1, lng: 2 })]);
  assert.equal(calls.filter(call => call.init.method === 'POST').length, 1);
  assert.deepEqual(JSON.parse(calls[0].init.body), { mapType: 'streetview', language: 'pt-BR', region: 'BR' });
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[1].url.searchParams.get('radius'), '30');
  assert.equal(calls[2].url.searchParams.has('lat'), false);
  assert.equal(calls[2].url.searchParams.get('panoId'), 'old-id');
  assert.equal(a.date, '2024-08'); assert.deepEqual(a, b);
  assert.equal(a.links[0].panoId, 'next-pano'); assert.equal(a.tilt, 88.4);
  assert.equal(normalizeMetadata({ ...metadata, date: undefined }).date, null);
  assert.equal(normalizeMetadata({ ...metadata, reportProblemLink: 'javascript:alert(1)' }).reportProblemLink, '');
  provider.dispose();
});

test('tile requests use official path and return a Blob; native edge tiles are validated', async () => {
  const calls = [];
  const provider = createGoogleProvider({ apiKey: 'test-key', fetchImpl: async (input, init) => {
    const url = new URL(input); calls.push({ url, init });
    return url.pathname.endsWith('/createSession') ? session() : new Response(new Blob(['image-data'], { type: 'image/jpeg' }));
  } });
  const image = await provider.getTile(metadata, { zoom: 3, x: 6, y: 3 });
  assert.ok(image instanceof Blob);
  assert.equal(calls[1].url.pathname, '/v1/streetview/tiles/3/6/3');
  assert.equal(calls[1].url.searchParams.get('panoId'), metadata.panoId);
  assert.equal(calls[1].init.cache, 'default');
  await assert.rejects(provider.getTile(metadata, { zoom: 3, x: 7, y: 0 }), { code: 'INVALID_TILE' });
  assert.equal(calls.length, 2);
  provider.dispose();
});

test('expired token is replaced once; failed refresh cannot retry indefinitely', async () => {
  let sessions = 0, requests = 0;
  const provider = createGoogleProvider({ apiKey: 'test-key', fetchImpl: async input => {
    const url = new URL(input);
    if (url.pathname.endsWith('/createSession')) return session(`session-${++sessions}`);
    requests++;
    if (requests === 1) return json({ error: { errors: [{ reason: 'expired' }] } }, 400);
    assert.equal(url.searchParams.get('session'), 'session-2');
    return json(metadata);
  } });
  assert.equal((await provider.getMetadata({ panoId: 'id' })).panoId, metadata.panoId);
  assert.equal(sessions, 2); assert.equal(requests, 2); provider.dispose();

  let failures = 0;
  const alwaysExpired = createGoogleProvider({ apiKey: 'test-key', fetchImpl: async input => {
    if (new URL(input).pathname.endsWith('/createSession')) return session();
    failures++; return json({ error: { errors: [{ reason: 'expired' }] } }, 400);
  } });
  await assert.rejects(alwaysExpired.getMetadata({ panoId: 'id' }), { code: 'SESSION_EXPIRED' });
  assert.equal(failures, 2); alwaysExpired.dispose();
});

test('token expiry time triggers renewal without storing session or imagery outside memory', async () => {
  let clock = 1700000000000, created = 0;
  const provider = createGoogleProvider({ apiKey: 'test-key', now: () => clock, fetchImpl: async input => {
    if (new URL(input).pathname.endsWith('/createSession')) return session(`s${++created}`, clock + 60000);
    return json(metadata);
  } });
  await provider.getMetadata({ panoId: 'id' });
  clock += 45000;
  await provider.getMetadata({ panoId: 'id' });
  assert.equal(created, 2); provider.dispose();
});

test('errors never expose keys or URL/server messages; quota errors are not automatically retried', async () => {
  let calls = 0;
  const provider = createGoogleProvider({ apiKey: 'secret-never-print', fetchImpl: async input => {
    calls++;
    if (new URL(input).pathname.endsWith('/createSession')) return session();
    return json({ error: { message: input, errors: [{ reason: 'quotaExceeded', message: input }] } }, 403);
  } });
  await assert.rejects(provider.getMetadata({ panoId: 'id' }), error => error.code === 'QUOTA_EXCEEDED' && !error.message.includes('secret-never-print') && !error.message.includes('http'));
  assert.equal(calls, 2); provider.dispose();
  const network = createGoogleProvider({ apiKey: 'secret-never-print', fetchImpl: async input => { throw new Error(input); } });
  await assert.rejects(network.getMetadata({ panoId: 'id' }), error => error.code === 'NETWORK_ERROR' && !error.stack.includes('secret-never-print'));
  network.dispose();
  const missing = createGoogleProvider({ fetchImpl: () => { throw new Error('Must not fetch'); } });
  await assert.rejects(missing.getMetadata({ panoId: 'id' }), { code: 'MISSING_API_KEY' });
});

test('abort, disposal and timeout stop in-flight requests and report safe errors', async () => {
  const makeProvider = options => createGoogleProvider({ apiKey: 'test-key', ...options, fetchImpl: async (input, { signal }) => {
    if (new URL(input).pathname.endsWith('/createSession')) return session();
    return new Promise((resolve, reject) => {
      const stop = () => reject(new DOMException('unsafe URL', 'AbortError'));
      if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
    });
  } });
  const controller = new AbortController(), provider = makeProvider({});
  const request = provider.getMetadata({ panoId: 'id' }, { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 0)); controller.abort();
  await assert.rejects(request, { name: 'AbortError' }); provider.dispose(); provider.dispose();
  await assert.rejects(provider.getMetadata({ panoId: 'id' }), { code: 'DISPOSED' });
  const timeout = makeProvider({ requestTimeoutMs: 5 });
  await assert.rejects(timeout.getMetadata({ panoId: 'id' }), { code: 'TIMEOUT' }); timeout.dispose();
  const disposing = makeProvider({});
  const pending = disposing.getMetadata({ panoId: 'id' });
  await new Promise(resolve => setTimeout(resolve, 0)); disposing.dispose();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('legacy 13312px tiles use the native pyramid and crop horizontal/vertical edge padding', () => {
  const normal = getTileLayout(metadata, 3);
  assert.deepEqual([normal.width, normal.height, normal.columns, normal.rows], [3328, 1664, 7, 4]);
  assert.equal(normal.tiles.length, 28);
  assert.deepEqual(normal.tiles.at(-1), { x: 6, y: 3, width: 256, height: 128 });
  assert.ok(normal.tiles.every(tile => tile.x < 7 && tile.y < 4));
  const zero = getTileLayout(metadata, 0);
  assert.deepEqual(zero.tiles, [{ x: 0, y: 0, width: 416, height: 208 }]);
  const native = getTileLayout(metadata, 5);
  assert.deepEqual([native.columns, native.rows], [26, 13]);
  const small = getTileLayout({ ...metadata, imageWidth: 2000, imageHeight: 1000 }, 5);
  assert.deepEqual([small.width, small.height, small.columns, small.rows], [2000, 1000, 4, 2]);
  assert.deepEqual(small.tiles.at(-1), { x: 3, y: 1, width: 464, height: 488 });
  assert.throws(() => getTileLayout({ ...metadata, imageWidth: 0 }, 3), { code: 'INVALID_METADATA' });
});

test('modern 16384px panorama keeps its full 8×4 zoom-three grid', () => {
  const modern = { ...metadata, imageWidth: 16384, imageHeight: 8192 };
  const layout = getTileLayout(modern, 3);
  assert.deepEqual([layout.width, layout.height, layout.columns, layout.rows], [4096, 2048, 8, 4]);
  assert.equal(layout.tiles.length, 32);
  assert.deepEqual(layout.tiles.at(-1), { x: 7, y: 3, width: 512, height: 512 });
  assert.deepEqual(getTileLayout(modern, 0).tiles, [{ x: 0, y: 0, width: 512, height: 256 }]);
});

test('panorama heading uses north=-Z/east=+X; centered clone preserves cockpit projection and source camera', () => {
  const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(panoramaOrientation({ heading: 90, tilt: 90, roll: 0 }));
  assert.ok(direction.distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-6);
  const camera = new THREE.PerspectiveCamera(62, 16 / 9, .055, 1700);
  camera.position.set(40, 1.2, -230); camera.rotation.set(.1, -.5, 0, 'YXZ');
  camera.setViewOffset(1280, 720, 150, -30, 1280, 720);
  const subject = new PanoramaRenderer({}, camera), target = subject.centerCamera(camera, camera.clone(false));
  assert.deepEqual(target.position.toArray(), [0, 0, 0]);
  assert.deepEqual(camera.position.toArray(), [40, 1.2, -230]);
  assert.deepEqual(target.projectionMatrix.elements, camera.projectionMatrix.elements);
  assert.equal(target.children.length, 0); subject.dispose();
});

test('ready waits for GPU; preview restores state and shared geometry/target are released only by the viewer', async () => {
  const originalBitmap = globalThis.createImageBitmap, originalCanvas = globalThis.OffscreenCanvas;
  const events = [], warmTargets = []; let fenceChecks = 0, bitmapClosed = false;
  globalThis.createImageBitmap = async () => { events.push('decode'); return { width: 512, height: 512, close() { bitmapClosed = true; } }; };
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() { return { drawImage() { events.push('stitch'); } }; }
  };
  const gl = {
    SYNC_GPU_COMMANDS_COMPLETE: 1, ALREADY_SIGNALED: 2, CONDITION_SATISFIED: 3, WAIT_FAILED: 4,
    NO_ERROR: 0, getError: () => 0,
    isContextLost: () => false, fenceSync: () => ({}), flush() { events.push('flush'); },
    clientWaitSync() { events.push('fence'); return ++fenceChecks === 1 ? 0 : 3; }, deleteSync() {},
  };
  const renderer = {
    capabilities: { maxTextureSize: 4096 }, autoClear: false, toneMapping: THREE.ACESFilmicToneMapping,
    target: null, viewport: new THREE.Vector4(5, 6, 800, 600), scissor: new THREE.Vector4(7, 8, 500, 400), scissorTest: false,
    getContext: () => gl, getRenderTarget() { return this.target; }, setRenderTarget(value) { this.target = value; if (value) warmTargets.push(value); },
    getViewport(out) { return out.copy(this.viewport); }, getScissor(out) { return out.copy(this.scissor); },
    setViewport(...values) { values.length === 1 ? this.viewport.copy(values[0]) : this.viewport.set(...values); },
    setScissor(...values) { values.length === 1 ? this.scissor.copy(values[0]) : this.scissor.set(...values); },
    getScissorTest() { return this.scissorTest; }, setScissorTest(value) { this.scissorTest = value; },
    getSize(out) { return out.set(800, 600); },
    initTexture() { events.push('upload'); }, async compileAsync() { events.push('compile'); },
    render() { events.push('draw'); },
  };
  const camera = new THREE.PerspectiveCamera(), viewer = new PanoramaRenderer(renderer, camera);
  try {
    const resource = await viewer.prepare({ ...metadata, imageWidth: 512, imageHeight: 256 }, {
      async getTile() { events.push('fetch'); return new Blob(['test'], { type: 'image/jpeg' }); },
    }, { onProgress: ({ phase }) => events.push(phase) });
    assert.equal(resource.ready, true); assert.equal(bitmapClosed, true);
    assert.ok(events.indexOf('decode') < events.indexOf('upload'));
    assert.ok(events.indexOf('upload') < events.indexOf('draw'));
    assert.ok(events.indexOf('draw') < events.lastIndexOf('fence'));
    assert.ok(events.lastIndexOf('fence') < events.indexOf('ready'));
    assert.equal(fenceChecks, 2);
    viewer.renderPreview(resource, camera, { x: 20, y: 30, width: 200, height: 100 });
    assert.deepEqual(renderer.viewport.toArray(), [5, 6, 800, 600]);
    assert.deepEqual(renderer.scissor.toArray(), [7, 8, 500, 400]);
    assert.equal(renderer.scissorTest, false); assert.equal(renderer.autoClear, false);
    assert.equal(renderer.toneMapping, THREE.ACESFilmicToneMapping); assert.equal(renderer.target, null);
    const geometry = resource.scene.children[0].geometry, warmTarget = warmTargets[0];
    let geometryDisposals = 0, targetDisposals = 0;
    geometry.addEventListener('dispose', () => geometryDisposals++);
    warmTarget.addEventListener('dispose', () => targetDisposals++);
    const another = await viewer.prepare({ ...metadata, imageWidth: 512, imageHeight: 256 }, {
      async getTile() { return new Blob(['test'], { type: 'image/jpeg' }); },
    });
    assert.equal(another.scene.children[0].geometry, geometry);
    assert.equal(warmTargets.length, 2);
    assert.equal(warmTargets[1], warmTarget);
    resource.dispose(); resource.dispose(); assert.equal(resource.ready, false);
    assert.equal(another.ready, true, 'disposing one panorama leaves the shared geometry available');
    another.dispose();
    assert.equal(resource.scene.children.length, 0); assert.equal(viewer.resources.size, 0);
    assert.equal(geometryDisposals, 0); assert.equal(targetDisposals, 0);
    viewer.dispose(); viewer.dispose();
    assert.equal(geometryDisposals, 1); assert.equal(targetDisposals, 1);
  } finally {
    viewer.dispose();
    if (originalBitmap === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = originalBitmap;
    if (originalCanvas === undefined) delete globalThis.OffscreenCanvas; else globalThis.OffscreenCanvas = originalCanvas;
  }
});
