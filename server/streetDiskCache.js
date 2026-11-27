import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readdir, readFile, writeFile, rename, unlink, lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {tileFreshness} from '../src/street/tileCache.js';

const DEFAULT_ENTRIES = Number.MAX_SAFE_INTEGER, DEFAULT_BYTES = Number.MAX_SAFE_INTEGER;
const hash = value => createHash('sha256').update(value).digest('hex');
const abortError = () => new DOMException('Carregamento cancelado.', 'AbortError');
const active = signal => { if (signal?.aborted) throw abortError(); };
const extensions = {'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp'};

export function validTile(tile) {
  return typeof tile?.panoId === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(tile.panoId) &&
    Number.isInteger(tile.zoom) && tile.zoom >= 0 && tile.zoom <= 5 &&
    Number.isInteger(tile.x) && tile.x >= 0 && tile.x < 2 ** tile.zoom &&
    Number.isInteger(tile.y) && tile.y >= 0 && tile.y < Math.max(1, 2 ** (tile.zoom - 1));
}

/** Permanent private archive. HTTP freshness is recorded, never used to delete files.
 * Invalid records are ignored and preserved for recovery. Only temporary JSON writes are removed; image files are never overwritten or removed.
 */
export function createDiskTileCache({directory, apiKey, now = Date.now, maxEntries = DEFAULT_ENTRIES, maxBytes = DEFAULT_BYTES} = {}) {
  if (!directory || !apiKey) throw new TypeError('Diretório e chave são necessários para o cache local.');
  const namespace = join(directory, hash(apiKey));
  const entryLimit = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : DEFAULT_ENTRIES;
  const byteLimit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_BYTES;
  const index = new Map();
  let bytes = 0, opening, maintenance = Promise.resolve(), indexReady = false;
  const idFor = tile => validTile(tile) ? hash(JSON.stringify([tile.panoId, tile.zoom, tile.x, tile.y])) : null;
  const removeFile = file => unlink(join(namespace, file)).catch(error => { if (error.code !== 'ENOENT') throw error; });

  function validRecord(id, data) {
    return data?.version === 1 && validTile(data.tile) && idFor(data.tile) === id &&
      extensions[data.contentType] && (data.file === `${id}.${extensions[data.contentType]}` ||
        new RegExp(`^${id}\\.[a-f0-9-]{36}\\.${extensions[data.contentType]}$`).test(data.file)) &&
      Number.isSafeInteger(data.size) && data.size > 0 &&
      Number.isSafeInteger(data.storedAt) && data.storedAt > 0;
  }

  async function open() {
    if (!opening) opening = (async () => {
      await mkdir(namespace, {recursive: true, mode: 0o700});
      const files = await readdir(namespace);
      const records = files.filter(file => /^[a-f0-9]{64}\.json$/.test(file));
      for (let offset = 0; offset < records.length; offset += 64) {
        await Promise.all(records.slice(offset, offset + 64).map(async file => {
          const id = file.slice(0, -5);
          let data;
          try {
            const info = await lstat(join(namespace, file));
            if (!info.isFile() || info.size > 16384) throw new Error('Invalid metadata file');
            data = JSON.parse(await readFile(join(namespace, file), 'utf8'));
            const imageInfo = validRecord(id, data) && await lstat(join(namespace, data.file));
            if (!imageInfo?.isFile() || imageInfo.size !== data.size) throw new Error('Invalid image file');
            index.set(id, data); bytes += data.size;
          } catch { /* Preserve incomplete/corrupt files; never delete the archive automatically. */ }
        }));
      }
      indexReady = true;
    })();
    return opening;
  }

  function serialize(operation) {
    const result = maintenance.then(operation);
    maintenance = result.catch(() => {});
    return result;
  }

  return {
    async getEntry(tile, {signal} = {}) {
      active(signal);
      const id = idFor(tile);
      if (!id) return null;
      await open(); active(signal);
      const entry = index.get(id);
      if (!entry) return null;
      if (!validRecord(id, entry)) return null;
      try {
        const file = join(namespace, entry.file), info = await lstat(file);
        if (!info.isFile() || info.size !== entry.size) throw new Error('Invalid image file');
        const data = await readFile(file, {signal}); active(signal);
        if (data.byteLength !== entry.size) return null;
        return {blob: new Blob([data], {type: entry.contentType}), ...entry};
      } catch (error) {
        active(signal);
        return null;
      }
    },
    async get(tile, options) { return (await this.getEntry(tile, options))?.blob || null; },
    put(tile, blob, headers, {requestStartedAt, signal} = {}) {
      const storedAt = now(), expiresAt = tileFreshness(headers, {now: storedAt, requestStartedAt});
      return serialize(async () => {
        active(signal);
        const id = idFor(tile);
        if (!id) return false;
        await open(); active(signal);
        if (!extensions[blob?.type] || !blob.size || blob.size > byteLimit) return false;
        // Capacity limits reject new writes; they never evict saved photographs.
        const old = index.get(id);
        if (index.size + (old ? 0 : 1) > entryLimit || bytes - (old?.size || 0) + blob.size > byteLimit) return false;
        const safeHeaders = {};
        for (const name of ['Cache-Control', 'Date', 'Age', 'ETag', 'Last-Modified']) {
          const value = new Headers(headers).get(name);
          if (value !== null) safeHeaders[name] = value;
        }
        // Every image is immutable. Even repairs retain the previous original.
        const file = `${id}.${randomUUID()}.${extensions[blob.type]}`, suffix = `.${randomUUID()}.tmp`;
        const details = {version: 1, tile, file, size: blob.size, contentType: blob.type, storedAt, expiresAt, requestStartedAt: requestStartedAt ?? storedAt, headers: safeHeaders};
        try {
          await writeFile(join(namespace, file), Buffer.from(await blob.arrayBuffer()), {mode: 0o600, flag: 'wx', signal}); active(signal);
          await writeFile(join(namespace, `${id}.json${suffix}`), JSON.stringify(details), {mode: 0o600, signal}); active(signal);
          await rename(join(namespace, `${id}.json${suffix}`), join(namespace, `${id}.json`));
          const previous = index.get(id);
          if (previous) bytes -= previous.size;
          index.set(id, details); bytes += details.size;
          active(signal);
          return index.has(id);
        } finally {
          await removeFile(`${id}.json${suffix}`);
        }
      });
    },
    snapshot() { return {entries: index.size, bytes, maxEntries: entryLimit, maxBytes: byteLimit, indexReady}; },
    async stats() { await open(); await maintenance; return {entries: index.size, bytes, maxEntries: entryLimit, maxBytes: byteLimit}; },
    async flush() { await maintenance; },
  };
}
