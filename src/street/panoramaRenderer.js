import * as THREE from 'three';
import { getTileLayout, StreetViewError } from './googleProvider.js';

function aborted(signal) { if (signal?.aborted) throw new DOMException('Carregamento cancelado.', 'AbortError'); }

export function panoramaOrientation(metadata) {
  // North=-Z, East=+X. u=.5 is the panorama heading. Clockwise compass
  // headings and the documented clockwise horizon roll oppose Three's axes.
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(90 - (metadata.tilt ?? 90)),
    -THREE.MathUtils.degToRad(metadata.heading ?? 0),
    -THREE.MathUtils.degToRad(metadata.roll ?? 0), 'YXZ',
  ));
}

async function decodeTile(blob, signal) {
  aborted(signal);
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    if (signal?.aborted) { bitmap.close(); aborted(signal); }
    return bitmap;
  }
  const url = URL.createObjectURL(blob), image = new Image();
  try { image.src = url; await image.decode(); aborted(signal); return image; }
  finally { URL.revokeObjectURL(url); }
}

function prepareShaders(renderer, scene, camera, signal) {
  aborted(signal);
  let abort, timer;
  const pending = new Promise((resolve, reject) => {
    abort = () => reject(new DOMException('Carregamento cancelado.', 'AbortError'));
    timer = setTimeout(() => reject(new StreetViewError('A preparação gráfica demorou demais. Tente novamente.', 'GPU_TIMEOUT')), 15000);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => renderer.compileAsync(scene, camera)).then(resolve, reject);
  });
  return pending.finally(() => { clearTimeout(timer); signal.removeEventListener('abort', abort); });
}

async function waitForGPU(renderer, signal) {
  const gl = renderer.getContext();
  if (gl.isContextLost()) throw new StreetViewError('A placa gráfica perdeu a conexão. Recarregue a página.', 'GPU_CONTEXT_LOST');
  const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!fence) throw new StreetViewError('Não foi possível preparar a imagem na placa gráfica.', 'GPU_NOT_READY');
  gl.flush();
  const started = performance.now();
  try {
    while (true) {
      aborted(signal);
      const result = gl.clientWaitSync(fence, 0, 0);
      if (result === gl.ALREADY_SIGNALED || result === gl.CONDITION_SATISFIED) return;
      if (result === gl.WAIT_FAILED || gl.isContextLost()) throw new StreetViewError('A placa gráfica não conseguiu preparar o panorama.', 'GPU_NOT_READY');
      if (performance.now() - started > 10000) throw new StreetViewError('A preparação gráfica demorou demais. Tente novamente.', 'GPU_TIMEOUT');
      await new Promise(resolve => setTimeout(resolve, 8));
    }
  } finally { gl.deleteSync(fence); }
}

function captureRenderer(renderer) {
  return {
    target: renderer.getRenderTarget(), viewport: renderer.getViewport(new THREE.Vector4()),
    scissor: renderer.getScissor(new THREE.Vector4()), scissorTest: renderer.getScissorTest(),
    autoClear: renderer.autoClear, toneMapping: renderer.toneMapping,
  };
}
function restoreRenderer(renderer, saved) {
  renderer.setRenderTarget(saved.target); renderer.setViewport(saved.viewport);
  renderer.setScissor(saved.scissor); renderer.setScissorTest(saved.scissorTest);
  renderer.autoClear = saved.autoClear; renderer.toneMapping = saved.toneMapping;
}

export class PanoramaRenderer {
  constructor(renderer, camera) {
    this.renderer = renderer; this.camera = camera;
    this.panoCamera = camera.clone(false); this.previewCamera = camera.clone(false);
    this.resources = new Set(); this.pending = new Set(); this.disposed = false;
    // Every panorama uses the same immutable sphere; only its material and
    // mesh orientation differ. The viewer owns these shared GPU resources.
    this.geometry = new THREE.SphereGeometry(100, 96, 48);
    this.geometry.scale(-1, 1, 1); this.geometry.rotateY(-Math.PI / 2);
    this.warmTarget = new THREE.WebGLRenderTarget(4, 4);
  }

  async prepare(metadata, provider, { signal, onProgress } = {}) {
    if (this.disposed) throw new StreetViewError('O visualizador foi encerrado.', 'DISPOSED');
    aborted(signal);
    const controller = new AbortController(), abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true }); this.pending.add(controller);
    let zoom = 3, layout = getTileLayout(metadata, zoom), resource = null, canvas = null;
    const maxTextureSize = this.renderer.capabilities.maxTextureSize;
    while ((layout.width > maxTextureSize || layout.height > maxTextureSize) && zoom > 0) layout = getTileLayout(metadata, --zoom);
    try {
      canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(layout.width, layout.height) : document.createElement('canvas');
      canvas.width = layout.width; canvas.height = layout.height;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new StreetViewError('O navegador não conseguiu preparar as fotografias.', 'CANVAS_UNAVAILABLE');
      let cursor = 0, loaded = 0, failure = null;
      const progress = phase => onProgress?.({ loaded, total: layout.tiles.length, phase,
        progress: phase === 'ready' ? 1 : phase === 'gpu' ? .95 : loaded / layout.tiles.length * .9,
      });
      progress('tiles');
      const workers = Array.from({ length: Math.min(8, layout.tiles.length) }, async () => {
        try {
          while (cursor < layout.tiles.length) {
            aborted(controller.signal);
            const tile = layout.tiles[cursor++];
            const blob = await provider.getTile(metadata, { zoom, x: tile.x, y: tile.y, signal: controller.signal });
            const bitmap = await decodeTile(blob, controller.signal);
            try {
              if (bitmap.width < tile.width || bitmap.height < tile.height) throw new StreetViewError('Um bloco de fotografia veio incompleto.', 'INVALID_TILE');
              context.drawImage(bitmap, 0, 0, tile.width, tile.height, tile.x * layout.tileWidth, tile.y * layout.tileHeight, tile.width, tile.height);
            } finally { bitmap.close?.(); }
            loaded++; progress('tiles');
          }
        } catch (error) { failure ||= error; controller.abort(); throw error; }
      });
      await Promise.allSettled(workers);
      if (failure) throw failure;
      aborted(controller.signal);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.generateMipmaps = false; texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter;
      texture.wrapS = THREE.RepeatWrapping; texture.wrapT = THREE.ClampToEdgeWrapping;
      const material = new THREE.MeshBasicMaterial({ map: texture, fog: false, toneMapped: false, depthTest: false, depthWrite: false });
      const sphere = new THREE.Mesh(this.geometry, material); sphere.quaternion.copy(panoramaOrientation(metadata)); sphere.frustumCulled = false;
      const scene = new THREE.Scene(); scene.add(sphere);
      let released = false;
      resource = { metadata, scene, ready: false, zoom, width: layout.width, height: layout.height,
        dispose: () => {
          if (released) return;
          released = true; resource.ready = false;
          material.dispose(); texture.dispose(); scene.clear();
          canvas.width = canvas.height = 1; this.resources.delete(resource);
        },
      };
      this.resources.add(resource); progress('gpu');
      this.renderer.initTexture(texture);
      const warmCamera = this.centerCamera(this.camera, this.panoCamera);
      await prepareShaders(this.renderer, scene, warmCamera, controller.signal);
      aborted(controller.signal);
      const saved = captureRenderer(this.renderer);
      try {
        this.renderer.setRenderTarget(this.warmTarget); this.renderer.setViewport(0, 0, 4, 4); this.renderer.setScissorTest(false);
        this.renderer.autoClear = true; this.renderer.toneMapping = THREE.NoToneMapping;
        this.renderer.render(scene, warmCamera);
        const gl = this.renderer.getContext();
        if (gl.getError() !== gl.NO_ERROR) throw new StreetViewError('A placa gráfica não conseguiu carregar a fotografia.', 'GPU_UPLOAD_FAILED');
      } finally { restoreRenderer(this.renderer, saved); }
      await waitForGPU(this.renderer, controller.signal);
      aborted(controller.signal); resource.ready = true; progress('ready'); return resource;
    } catch (error) {
      resource?.dispose();
      if (!resource && canvas) canvas.width = canvas.height = 1;
      throw error;
    } finally { signal?.removeEventListener('abort', abort); this.pending.delete(controller); }
  }

  centerCamera(source, target) {
    target.copy(source, false); target.position.set(0, 0, 0);
    source.getWorldQuaternion(target.quaternion);
    target.layers.set(0); target.updateMatrixWorld(true);
    return target;
  }

  render(resource, camera = this.camera) {
    if (this.disposed || !resource?.ready) return;
    const renderer = this.renderer, saved = captureRenderer(renderer);
    try {
      renderer.autoClear = true; renderer.toneMapping = THREE.NoToneMapping;
      renderer.render(resource.scene, this.centerCamera(camera, this.panoCamera));
    } finally { restoreRenderer(renderer, saved); }
  }

  // x/y are CSS pixels from the top-left of the renderer canvas.
  renderPreview(resource, camera = this.camera, { x, y, width, height }) {
    if (this.disposed || !resource?.ready || width <= 0 || height <= 0) return;
    const renderer = this.renderer, saved = captureRenderer(renderer);
    const size = renderer.getSize(new THREE.Vector2());
    const preview = this.centerCamera(camera, this.previewCamera);
    preview.clearViewOffset(); preview.aspect = width / height; preview.fov = 65; preview.updateProjectionMatrix();
    try {
      renderer.setViewport(x, size.y - y - height, width, height);
      renderer.setScissor(x, size.y - y - height, width, height); renderer.setScissorTest(true);
      renderer.autoClear = true; renderer.toneMapping = THREE.NoToneMapping;
      renderer.render(resource.scene, preview);
    } finally { restoreRenderer(renderer, saved); }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.pending) controller.abort();
    for (const resource of [...this.resources]) resource.dispose();
    this.pending.clear();
    this.geometry.dispose(); this.warmTarget.dispose();
  }
}
