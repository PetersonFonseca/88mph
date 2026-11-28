import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile, rename, unlink} from 'node:fs/promises';
import {normalizeSavedRoute} from '../src/street/savedRoute.js';
import {LOCATIONS} from '../src/street/route.js';
import {join} from 'node:path';
import {createDiskTileCache, validTile} from './streetDiskCache.js';
import {tileFreshness} from '../src/street/tileCache.js';

const BASE = 'https://tile.googleapis.com/v1/';
const ABORT = () => new DOMException('Carregamento cancelado.', 'AbortError');
const active = signal => { if (signal?.aborted) throw ABORT(); };
function failure(code, status = 502) { return Object.assign(new Error(code), {code, status}); }

function waitWithSignal(promise, signal) {
  active(signal);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const stop = () => reject(ABORT());
    signal.addEventListener('abort', stop, {once: true});
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/** Official tile transport used only by the local development server. */
// Google answers 429 for short per-minute bursts too; waiting usually succeeds.
const QUOTA_RETRY_DELAYS = [2000, 5000, 15000, 30000, 60000];

function sleep(ms, signal) {
  active(signal);
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(ABORT()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    signal?.addEventListener('abort', stop, {once: true});
  });
}

export function createStreetTileService({apiKey, directory, fetchImpl = globalThis.fetch, now = Date.now, requestTimeoutMs = 15000, quotaRetryDelays = QUOTA_RETRY_DELAYS, ...limits} = {}) {
  const cache = createDiskTileCache({apiKey, directory, now, ...limits});
  const routeDirectory = join(directory, createHash('sha256').update(apiKey).digest('hex'));
  // Paulista keeps the original file name so existing archives are adopted as-is.
  const routePath = (location = 'paulista') => join(routeDirectory, location === 'paulista' ? 'route.json' : `route-${location}.json`);
  const pending = new Map(), controllers = new Set();
  let session, sessionPromise, disposed = false;
  const counts = {hits: 0, downloads: 0, stores: 0};

  async function request(path, query, {body, signal, referrer} = {}) {
    active(signal);
    if (disposed) throw ABORT();
    const controller = new AbortController(), stop = () => controller.abort();
    controllers.add(controller);
    signal?.addEventListener('abort', stop, {once: true});
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, requestTimeoutMs);
    const url = new URL(path, BASE);
    for (const [key, value] of Object.entries({...query, key: apiKey})) url.searchParams.set(key, String(value));
    try {
      const requestStartedAt = now();
      const headers = new Headers();
      if (body) headers.set('Content-Type', 'application/json');
      // The middleware accepts only this server's own origin as the referrer.
      if (referrer) headers.set('Referer', referrer);
      const response = await fetchImpl(url.href, {method: body ? 'POST' : 'GET', headers, ...(body ? {body: JSON.stringify(body)} : {}), signal: controller.signal});
      if (!response.ok) {
        let payload;
        try { payload = await response.json(); } catch { /* Never forward Google's error text or URL. */ }
        if (payload?.error?.errors?.some(error => error.reason === 'expired')) throw failure('SESSION_EXPIRED', response.status);
        if (response.status === 401 || response.status === 403) throw failure('ACCESS_DENIED', response.status);
        if (response.status === 429) {
          // A per-day limit only resets at midnight Pacific time: waiting seconds is pointless.
          const daily = payload?.error?.details?.some(detail => /PerDay/i.test(detail?.metadata?.quota_limit || '') || /^1\/d\//.test(detail?.metadata?.quota_unit || ''));
          if (daily) throw failure('DAILY_QUOTA_EXCEEDED', 429);
          const retryAfter = Number(response.headers?.get?.('Retry-After'));
          throw Object.assign(failure('QUOTA_EXCEEDED', 429), Number.isFinite(retryAfter) && retryAfter > 0 ? {retryAfterMs: Math.min(retryAfter, 300) * 1000} : {});
        }
        if (response.status === 404) throw failure('NOT_FOUND', 404);
        throw failure('GOOGLE_TILE_ERROR', response.status);
      }
      const result = body ? await response.json() : await response.blob();
      active(controller.signal);
      if (!body && (!result.size || !['image/jpeg', 'image/png', 'image/webp'].includes(result.type))) throw failure('INVALID_TILE');
      return body ? result : {blob: result, headers: new Headers(response.headers), requestStartedAt};
    } catch (error) {
      if (timedOut) throw failure('TIMEOUT', 504);
      if (controller.signal.aborted || signal?.aborted || disposed) throw ABORT();
      if (error.code && /^[A-Z_]+$/.test(error.code)) throw error;
      throw failure('GOOGLE_NETWORK_ERROR');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); controllers.delete(controller); }
  }

  async function getSession(signal, referrer) {
    active(signal);
    if (session?.expiry > now() + 30000) return session;
    if (!sessionPromise) sessionPromise = request('createSession', {}, {body: {mapType: 'streetview', language: 'pt-BR', region: 'BR'}, referrer})
      .then(data => {
        if (typeof data.session !== 'string' || !data.session || !Number.isFinite(Number(data.expiry)) || Number(data.expiry) * 1000 <= now()) throw failure('INVALID_SESSION');
        session = {token: data.session, expiry: Number(data.expiry) * 1000};
        return session;
      }).finally(() => { sessionPromise = null; });
    return waitWithSignal(sessionPromise, signal);
  }

  async function load(tile, signal, referrer, localOnly) {
    const cached = await cache.getEntry(tile, {signal});
    active(signal);
    if (cached) { counts.hits++; return {...cached, persisted: true, hit: true}; }
    if (localOnly) throw failure('LOCAL_TILE_MISSING', 404);
    for (let attempt = 0, quotaRetries = 0; attempt < 2; attempt++) {
      const current = await getSession(signal, referrer);
      try {
        const response = await request(`streetview/tiles/${tile.zoom}/${tile.x}/${tile.y}`, {panoId: tile.panoId, session: current.token}, {signal, referrer});
        counts.downloads++;
        // A local response confirms durability; the full-route preparation can
        // release its download buffer after this await and still reuse the file.
        const persisted = await cache.put(tile, response.blob, response.headers, {requestStartedAt: response.requestStartedAt, signal});
        active(signal);
        if (persisted) counts.stores++;
        return {...response, expiresAt: tileFreshness(response.headers, {now: now(), requestStartedAt: response.requestStartedAt}), persisted, hit: false};
      } catch (error) {
        if (error.code === 'QUOTA_EXCEEDED' && quotaRetries < quotaRetryDelays.length) {
          const delay = quotaRetryDelays[quotaRetries++];
          await sleep(Math.max(delay, error.retryAfterMs || 0), signal);
          attempt--; continue;
        }
        if (error.code !== 'SESSION_EXPIRED' || attempt > 0) throw error;
        if (session === current) session = null;
      }
    }
  }

  return {
    async getTile(tile, {signal, referrer, localOnly = false} = {}) {
      active(signal);
      if (disposed) throw ABORT();
      if (!validTile(tile)) throw failure('INVALID_TILE', 400);
      const key = JSON.stringify([tile.panoId, tile.zoom, tile.x, tile.y, localOnly]);
      let entry = pending.get(key);
      if (!entry || entry.controller.signal.aborted) {
        const controller = new AbortController();
        entry = {controller, consumers: 0, settled: false};
        const current = entry;
        entry.promise = load(tile, controller.signal, referrer, localOnly).finally(() => {
          current.settled = true;
          if (pending.get(key) === current) pending.delete(key);
        });
        pending.set(key, entry);
      }
      entry.consumers++;
      try { const result = await waitWithSignal(entry.promise, signal); active(signal); return result; }
      finally { if (--entry.consumers === 0 && !entry.settled) entry.controller.abort(); }
    },
    async readRoute(location = 'paulista') {
      if (!Object.hasOwn(LOCATIONS, location)) throw failure('INVALID_LOCATION', 400);
      try {
        const route = normalizeSavedRoute(JSON.parse(await readFile(routePath(location), 'utf8')));
        if (route.id !== location) throw new Error('mismatch');
        return route;
      }
      catch (error) { throw failure(error.code === 'ENOENT' ? 'LOCAL_ROUTE_MISSING' : 'INVALID_LOCAL_ROUTE', 404); }
    },
    async saveRoute(value) {
      const route = normalizeSavedRoute(value), target = routePath(route.id), temporary = target + '.' + randomUUID() + '.tmp';
      await mkdir(routeDirectory, {recursive: true, mode: 0o700});
      try { await writeFile(temporary, JSON.stringify(route), {mode: 0o600}); await rename(temporary, target); }
      finally { await unlink(temporary).catch(() => {}); }
      return {saved: true};
    },
    async inventory() { return {type: 'disk', ...await cache.stats()}; },
    status() { return {type: 'disk', directory: '.cache/streetview', ...cache.snapshot(), ...counts}; },
    async flush() { await Promise.allSettled([...pending.values()].map(entry => entry.promise)); await cache.flush(); },
    dispose() {
      disposed = true;
      for (const entry of pending.values()) entry.controller.abort();
      for (const controller of controllers) controller.abort();
      pending.clear(); session = null;
    },
  };
}

/** This middleware is intentionally a private, same-origin, loopback dev API. */
export function createStreetCacheMiddleware(service, {now = Date.now} = {}) {
  return async (req, res, next) => {
    if (!req.url?.startsWith('/__street-cache/')) return next();
    const json = (status, body) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(body));
    };
    let url;
    try { url = new URL(req.url, `http://${req.headers.host}`); } catch { return json(400, {code: 'INVALID_REQUEST'}); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const remote = req.socket?.remoteAddress;
    if (!local || (remote && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) ||
      req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== url.origin)) return json(403, {code: 'LOCAL_ONLY'});
    if (req.method !== 'GET' && !(req.method === 'PUT' && url.pathname === '/__street-cache/route')) return json(405, {code: 'METHOD_NOT_ALLOWED'});
    const controller = new AbortController(), abort = () => controller.abort();
    req.on('aborted', abort); res.on('close', abort);
    try {
      if (url.pathname === '/__street-cache/status') return json(200, service ? await service.status() : {type: 'browser'});
      if (url.pathname === '/__street-cache/inventory' && service) return json(200, await service.inventory());
      if (url.pathname === '/__street-cache/route' && service) {
        if (req.method === 'GET') return json(200, await service.readRoute(url.searchParams.get('location') || 'paulista'));
        if (req.headers['content-type'] !== 'application/json') return json(415, {code: 'INVALID_REQUEST'});
        const chunks = []; let size = 0;
        for await (const chunk of req) {
          size += Buffer.byteLength(chunk);
          if (size > 2 * 1024 * 1024) return json(413, {code: 'INVALID_LOCAL_ROUTE'});
          chunks.push(Buffer.from(chunk));
        }
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return json(400, {code: 'INVALID_LOCAL_ROUTE'}); }
        return json(200, await service.saveRoute(value));
      }
      const localOnly = url.pathname === '/__street-cache/local-tile';
      if ((!localOnly && url.pathname !== '/__street-cache/tile') || !service) return json(404, {code: 'NOT_FOUND'});
      const names = [...url.searchParams.keys()];
      if (names.length !== 4 || new Set(names).size !== 4 || names.some(name => !['panoId', 'zoom', 'x', 'y'].includes(name))) return json(400, {code: 'INVALID_TILE'});
      const raw = Object.fromEntries(url.searchParams);
      if (![raw.zoom, raw.x, raw.y].every(value => /^\d{1,2}$/.test(value))) return json(400, {code: 'INVALID_TILE'});
      const tile = {panoId: raw.panoId, zoom: Number(raw.zoom), x: Number(raw.x), y: Number(raw.y)};
      if (!validTile(tile)) return json(400, {code: 'INVALID_TILE'});
      const result = await service.getTile(tile, {signal: controller.signal, referrer: url.origin + '/', localOnly});
      active(controller.signal);
      const headers = {
        'Content-Type': result.blob.type, 'Content-Length': result.blob.size,
        'Cache-Control': 'no-store',
        Date: new Date(now()).toUTCString(), 'X-Street-Persisted': result.persisted ? '1' : '0',
        'X-Street-Archive': '1',
        'X-Street-Cache': result.hit ? 'HIT' : result.persisted ? 'MISS' : 'BYPASS',
        'X-Content-Type-Options': 'nosniff',
      };
      const etag = new Headers(result.headers).get('ETag');
      if (etag) headers.ETag = etag;
      const bytes = Buffer.from(await result.blob.arrayBuffer()); active(controller.signal);
      res.writeHead(200, headers); res.end(bytes);
    } catch (error) {
      if (error.name !== 'AbortError') json(Number.isInteger(error.status) ? error.status : 500, {code: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'DISK_CACHE_ERROR'});
    } finally { req.off('aborted', abort); res.off('close', abort); }
  };
}

export function streetCachePlugin({apiKey, enabled = true} = {}) {
  return {
    name: 'private-street-tile-cache', apply: 'serve',
    configureServer(server) {
      const service = enabled && apiKey ? createStreetTileService({apiKey, directory: join(server.config.root, '.cache', 'streetview')}) : null;
      server.middlewares.use(createStreetCacheMiddleware(service));
      server.httpServer?.once('close', () => service?.dispose());
    },
  };
}
