const CACHE_PREFIX = '88mph-street-tiles-v1-';
const ENTRY_PREFIX = '/__88mph_private_tiles__/';
const MAX_ENTRIES = 8192;
const MAX_BYTES = 256 * 1024 * 1024;
const EXPIRES_HEADER = 'X-88mph-Expires';
const STORED_HEADER = 'X-88mph-Stored';
const SIZE_HEADER = 'X-88mph-Bytes';

/** Return a conservative freshness deadline, or null when storage is not safe.
 * CacheStorage does not apply HTTP cache directives on our behalf. In particular,
 * absent/unexposed Date metadata must not turn an old response into a fresh one.
 */
export function tileFreshness(headers, {now = Date.now(), requestStartedAt = now} = {}) {
  try {
    const values = new Headers(headers);
    const directives = values.get('Cache-Control')?.split(',').map(value => value.trim()) || [];
    if (directives.some(value => /^(?:no-store|no-cache)(?:\s*=|$)/i.test(value))) return null;
    const maximumAges = directives.filter(value => /^max-age\s*=/i.test(value));
    if (maximumAges.length !== 1) return null;
    const match = maximumAges[0].match(/^max-age\s*=\s*"?(\d+)"?$/i);
    if (!match) return null;
    const maxAgeMs = Number(match[1]) * 1000;
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0 || !Number.isFinite(now)) return null;
    const date = Date.parse(values.get('Date') || '');
    if (!Number.isFinite(date)) return null;
    const rawAge = values.get('Age');
    if (rawAge !== null && !/^\d+$/.test(rawAge.trim())) return null;
    const ageMs = Number(rawAge || 0) * 1000;
    if (!Number.isSafeInteger(ageMs)) return null;
    const delay = Number.isFinite(requestStartedAt) ? Math.max(0, now - requestStartedAt) : 0;
    const currentAge = Math.max(0, now - date, ageMs + delay);
    const expiresAt = now + maxAgeMs - currentAge;
    return Number.isSafeInteger(expiresAt) && expiresAt > now ? expiresAt : null;
  } catch { return null; }
}

function tilePath(tile) {
  if (typeof tile?.panoId !== 'string' || !tile.panoId || tile.panoId.length > 512 ||
    !Number.isInteger(tile.zoom) || tile.zoom < 0 || tile.zoom > 5 ||
    !Number.isSafeInteger(tile.x) || tile.x < 0 || !Number.isSafeInteger(tile.y) || tile.y < 0) return null;
  return `${ENTRY_PREFIX}${encodeURIComponent(tile.panoId)}/${tile.zoom}/${tile.x}/${tile.y}`;
}

/** Private, per-key browser cache for explicitly cacheable tiles only.
 * Keys never include Google's request URL, API key, or session token.
 * Failures are cache misses; storage must never block the game.
 */
export function createTileCache({
  apiKey, cacheStorage = globalThis.caches, cryptoImpl = globalThis.crypto,
  origin = globalThis.location?.origin, now = Date.now,
  maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES,
} = {}) {
  let cachePromise = null, writesDisabled = false, maintenance = Promise.resolve();
  let index = null;
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  let localOrigin;
  try {
    const parsed = new URL(origin);
    if (['https:', 'http:'].includes(parsed.protocol)) localOrigin = parsed.origin;
  } catch { /* A non-browser context has no private origin to use. */ }
  const entryLimit = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : MAX_ENTRIES;
  const byteLimit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : MAX_BYTES;

  async function open() {
    if (!key || !localOrigin || !cacheStorage?.open || !cryptoImpl?.subtle?.digest) return null;
    if (!cachePromise) {
      cachePromise = Promise.resolve().then(async () => {
        const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(key));
        const namespace = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
        return cacheStorage.open(CACHE_PREFIX + namespace);
      }).catch(() => null);
    }
    return cachePromise;
  }

  function entryURL(tile) {
    const path = tilePath(tile);
    return path && localOrigin ? localOrigin + path : null;
  }

  function record(response, time) {
    const expiresAt = Number(response.headers.get(EXPIRES_HEADER));
    const storedAt = Number(response.headers.get(STORED_HEADER));
    const size = Number(response.headers.get(SIZE_HEADER));
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= time || !Number.isSafeInteger(storedAt) ||
      storedAt <= 0 || storedAt > time || !Number.isSafeInteger(size) || size <= 0 || size > byteLimit ||
      !response.headers.get('Content-Type')?.startsWith('image/')) return null;
    return {expiresAt, storedAt, size};
  }

  async function purge(cache) {
    const time = now();
    // Read persisted metadata once, then update the index on each get/put/delete.
    // A full disk scan for every downloaded tile would stall large panoramas.
    if (!index) {
      const refreshed = new Map(), requests = await cache.keys();
      for (let offset = 0; offset < requests.length; offset += 32) {
        await Promise.all(requests.slice(offset, offset + 32).map(async request => {
          const response = await cache.match(request), details = response && record(response, time);
          if (!details) await cache.delete(request);
          else refreshed.set(request.url, details);
        }));
      }
      index = refreshed;
    }
    for (const [url, details] of index) if (details.expiresAt <= time || details.storedAt > time) {
      await cache.delete(url); index.delete(url);
    }
    const live = [...index.entries()].map(([request, details]) => ({request, ...details}));
    live.sort((a, b) => a.storedAt - b.storedAt);
    let bytes = live.reduce((sum, item) => sum + item.size, 0);
    while (live.length > entryLimit || bytes > byteLimit) {
      const oldest = live.shift();
      bytes -= oldest.size;
      await cache.delete(oldest.request);
      index.delete(oldest.request);
    }
  }

  function serialize(operation) {
    const result = maintenance.then(operation).catch(() => false);
    maintenance = result.then(() => undefined);
    return result;
  }

  return {
    async get(tile) {
      try {
        const url = entryURL(tile), cache = url && await open();
        if (!cache) return null;
        const response = await cache.match(url);
        const details = response && record(response, now());
        if (!details) { if (response) await cache.delete(url); index?.delete(url); return null; }
        const blob = await response.blob();
        if (blob.size !== details.size || now() >= details.expiresAt) { await cache.delete(url); index?.delete(url); return null; }
        index?.set(url, details);
        return blob;
      } catch { return null; }
    },

    put(tile, blob, headers, {requestStartedAt, signal} = {}) {
      // Capture receipt time before entering the write queue; queueing must not
      // extend the response's lifetime. Writes are serialized to enforce bounds.
      const storedAt = now();
      const expiresAt = tileFreshness(headers, {now: storedAt, requestStartedAt});
      return serialize(async () => {
        if (signal?.aborted) return false;
        const url = entryURL(tile), cache = url && await open();
        if (!cache || signal?.aborted) return false;
        if (!expiresAt || expiresAt <= now() || !blob?.size || blob.size > byteLimit || !blob.type?.startsWith('image/')) {
          await cache.delete(url); index?.delete(url);
          return false;
        }
        if (writesDisabled) return false;
        await purge(cache);
        if (signal?.aborted) return false;
        const source = new Headers(headers);
        const safeHeaders = new Headers({
          'Content-Type': blob.type, 'Cache-Control': source.get('Cache-Control'),
          [EXPIRES_HEADER]: String(expiresAt), [STORED_HEADER]: String(storedAt), [SIZE_HEADER]: String(blob.size),
        });
        for (const name of ['Date', 'Age', 'ETag', 'Last-Modified']) {
          const value = source.get(name);
          if (value !== null) safeHeaders.set(name, value);
        }
        try {
          // Construct a fresh response: response.url must never retain a Google
          // URL containing the API key or its transient session token.
          await cache.put(url, new Response(blob, {status: 200, headers: safeHeaders}));
        } catch {
          writesDisabled = true;
          return false;
        }
        if (signal?.aborted) { await cache.delete(url); index?.delete(url); return false; }
        index.set(url, {expiresAt, storedAt, size: blob.size});
        await purge(cache);
        return index.has(url);
      });
    },

    clear() {
      return serialize(async () => {
        const cache = await open();
        if (!cache) return false;
        for (const request of await cache.keys()) await cache.delete(request);
        index = new Map();
        writesDisabled = false;
        return true;
      });
    },
  };
}
