import {getTileLayout} from './googleProvider.js';

function active(signal) {
  if (signal?.aborted) throw new DOMException('Download cancelado.', 'AbortError');
}

/** Download the selected trip once; no GPU textures are kept for the whole road. */
export async function downloadRoute(route, provider, {signal, onProgress = () => {}, concurrency = 12, zoom = 3, persistToDisk = true, localOnly = false} = {}) {
  active(signal);
  const panoramas = new Map();
  for (const epoch of Object.values(route.epochs)) {
    for (const {metadata} of epoch.nodes) panoramas.set(metadata.panoId, metadata);
  }
  for (const metadata of Object.values(route.portal)) panoramas.set(metadata.panoId, metadata);
  const tasks = [], pending = new Map();
  for (const metadata of panoramas.values()) {
    const layout = getTileLayout(metadata, zoom);
    pending.set(metadata.panoId, layout.tiles.length);
    for (const tile of layout.tiles) tasks.push({metadata, zoom, x: tile.x, y: tile.y});
  }
  if (!tasks.length) throw new Error('O percurso não contém imagens para baixar.');
  let cursor = 0, loaded = 0, bytes = 0, completedPanoramas = 0, missing = 0, failure;
  const sources = {memory: {count: 0, bytes: 0}, disk: {count: 0, bytes: 0}, browser: {count: 0, bytes: 0}, google: {count: 0, bytes: 0}, unknown: {count: 0, bytes: 0}};
  const abort = new AbortController(), cancel = () => abort.abort();
  signal?.addEventListener('abort', cancel, {once: true});
  const snapshot = () => ({loaded, total: tasks.length, bytes, completedPanoramas, totalPanoramas: panoramas.size, missing, checked: loaded + missing, progress: (loaded + missing) / tasks.length,
    sources: Object.fromEntries(Object.entries(sources).map(([name, value]) => [name, {...value}]))});
  onProgress(snapshot());
  try {
    const workers = Array.from({length: Math.min(Math.max(1, Math.floor(concurrency) || 1), 16, tasks.length)}, async () => {
      try {
        while (cursor < tasks.length) {
          active(abort.signal);
          const {metadata, ...tile} = tasks[cursor++];
          let source = 'unknown';
          let image;
          try { image = await provider.getTile(metadata, {...tile, persistToDisk, signal: abort.signal,
            onSource: value => { if (Object.hasOwn(sources, value)) source = value; }});
          } catch (error) {
            if (!localOnly || error.code !== 'LOCAL_TILE_MISSING') throw error;
            missing++; onProgress(snapshot()); continue;
          }
          active(abort.signal);
          loaded++; bytes += image.size;
          sources[source].count++; sources[source].bytes += image.size;
          const remaining = pending.get(metadata.panoId) - 1;
          pending.set(metadata.panoId, remaining);
          if (!remaining) completedPanoramas++;
          onProgress(snapshot());
        }
      } catch (error) { failure ||= error; abort.abort(); }
    });
    await Promise.all(workers);
    if (failure) throw failure;
    active(signal);
    if (missing) throw Object.assign(new Error(`Faltam ${missing} de ${tasks.length} blocos de imagem para este percurso. ${completedPanoramas} de ${panoramas.size} panoramas estão completos. Nenhum download foi iniciado. Use “Atualizar com Google” para completar o acervo.`), {code: 'LOCAL_ROUTE_INCOMPLETE'});
    await provider.flushCache?.();
    active(signal);
    return snapshot();
  } finally { signal?.removeEventListener('abort', cancel); }
}
