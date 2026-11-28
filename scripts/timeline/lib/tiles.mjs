import {createStreetTileService} from '../../../server/streetCachePlugin.js';
import {ARCHIVE_DIR, KEYFRAME_TILE_DIR, DEV_REFERRER} from './env.mjs';
import {decodeJpegToRgb} from './ffmpeg.mjs';

async function pool(items, size, worker) {
  let cursor = 0;
  await Promise.all(Array.from({length: Math.min(size, items.length)}, async () => {
    while (cursor < items.length) { const item = items[cursor++]; await worker(item); }
  }));
}

/**
 * Zoom 3 reads only the app's archive (never downloads, never writes there).
 * Higher zooms use a separate archive under .cache/timeline/tiles and may download missing tiles.
 */
export function createTileSource({apiKey, zoom, allowDownload = false, maxDownloads = 400}) {
  const archive = zoom <= 3;
  const service = createStreetTileService({apiKey, directory: archive ? ARCHIVE_DIR : KEYFRAME_TILE_DIR});
  const counts = {disk: 0, google: 0};
  let downloads = 0;

  async function fetchTiles(metadata, plan, {concurrency = 6, onProgress = () => {}} = {}) {
    const tile = ({x, y}) => ({panoId: metadata.panoId, zoom: plan.zoom, x, y});
    const blobs = new Map(), missing = [];
    await pool(plan.tiles, concurrency, async item => {
      try { blobs.set(`${item.x},${item.y}`, (await service.getTile(tile(item), {localOnly: true})).blob); counts.disk++; }
      catch (error) {
        if (error.code !== 'LOCAL_TILE_MISSING') throw error;
        missing.push(item);
      }
    });
    if (missing.length) {
      if (archive || !allowDownload) {
        throw Object.assign(new Error(`${missing.length} blocos de ${plan.tiles.length} ausentes em disco (${metadata.panoId}, zoom ${plan.zoom}).`), {code: 'TILES_MISSING', missing: missing.length});
      }
      if (downloads + missing.length > maxDownloads) {
        throw Object.assign(new Error(`Seriam baixados ${downloads + missing.length} blocos, acima do limite de ${maxDownloads} desta execução.`), {code: 'DOWNLOAD_LIMIT'});
      }
      await pool(missing, concurrency, async item => {
        const result = await service.getTile(tile(item), {referrer: DEV_REFERRER});
        blobs.set(`${item.x},${item.y}`, result.blob);
        downloads++; counts[result.hit ? 'disk' : 'google']++;
        onProgress({downloaded: downloads});
      });
    }
    const pixels = new Map();
    await pool(plan.tiles, concurrency, async item => {
      const bytes = Buffer.from(await blobs.get(`${item.x},${item.y}`).arrayBuffer());
      pixels.set(`${item.x},${item.y}`, await decodeJpegToRgb(bytes, plan.layout.tileWidth, plan.layout.tileHeight));
    });
    return {pixels: item => pixels.get(`${item.x},${item.y}`), missing: missing.length};
  }

  /** Counts tiles absent from disk without downloading anything. */
  async function countMissing(metadata, plan) {
    let missing = 0;
    await pool(plan.tiles, 8, async item => {
      try { await service.getTile({panoId: metadata.panoId, zoom: plan.zoom, x: item.x, y: item.y}, {localOnly: true}); }
      catch (error) { if (error.code === 'LOCAL_TILE_MISSING') missing++; else throw error; }
    });
    return missing;
  }

  return {fetchTiles, countMissing, counts, get downloads() { return downloads; }, dispose: () => service.dispose()};
}
