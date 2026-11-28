import {createTileCache, tileFreshness} from './tileCache.js';

const BASE_URL = 'https://tile.googleapis.com/v1/';
const MAX_ZOOM = 5;
const MEMORY_ENTRIES = 16384, MEMORY_BYTES = 512 * 1024 * 1024;

export class StreetViewError extends Error {
  constructor(message, code = 'STREET_VIEW_ERROR', status = 0) {
    super(message);
    this.name = 'StreetViewError';
    this.code = code;
    this.status = status;
  }
}

function abortError() { return new DOMException('Carregamento cancelado.', 'AbortError'); }
function assertActive(signal) { if (signal?.aborted) throw abortError(); }
function number(value, fallback = NaN) {
  return value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback;
}
function dimension(value) {
  const result = number(value);
  if (!Number.isInteger(result) || result <= 0 || result > 65536) {
    throw new StreetViewError('O panorama retornou dimensões inválidas.', 'INVALID_METADATA');
  }
  return result;
}

export function normalizeMetadata(data) {
  if (!data || typeof data.panoId !== 'string' || !data.panoId ||
      !Number.isFinite(number(data.lat)) || Math.abs(number(data.lat)) > 90 ||
      !Number.isFinite(number(data.lng)) || Math.abs(number(data.lng)) > 180) {
    throw new StreetViewError('O Google não retornou um panorama válido para este ponto.', 'INVALID_METADATA');
  }
  let reportProblemLink = '';
  try {
    const url = new URL(data.reportProblemLink);
    if (url.protocol === 'https:' && /(^|\.)(google\.com|googleapis\.com)$/.test(url.hostname)) reportProblemLink = url.href;
  } catch { /* An absent reporting link must never become an unsafe href. */ }
  return Object.freeze({
    panoId: data.panoId, date: typeof data.date === 'string' ? data.date : null,
    lat: number(data.lat), lng: number(data.lng),
    heading: number(data.heading, 0), tilt: number(data.tilt, 90), roll: number(data.roll, 0),
    imageWidth: dimension(data.imageWidth), imageHeight: dimension(data.imageHeight),
    tileWidth: dimension(data.tileWidth), tileHeight: dimension(data.tileHeight),
    copyright: typeof data.copyright === 'string' ? data.copyright : '', reportProblemLink,
    imageryType: typeof data.imageryType === 'string' ? data.imageryType : '',
    links: Object.freeze((Array.isArray(data.links) ? data.links : [])
      .filter(link => typeof link.panoId === 'string' && link.panoId && Number.isFinite(number(link.heading)))
      .map(link => Object.freeze({ panoId: link.panoId, heading: number(link.heading), text: typeof link.text === 'string' ? link.text : '' }))),
  });
}

// Metadata describes the native z=5 image. Lower levels halve that image, not
// an assumed 16384px canvas: legacy 13312px panoramas have only 7 columns at z=3.
// Cropping each edge tile also removes the unused pixels at z=0.
// The oldest captures (2007, 3328px) stop at z=3: their metadata size is the
// native image at that level, so a request above it is clamped to it.
// https://developers.google.com/maps/documentation/tile/streetview
export function nativeZoom(metadata) {
  const columns = dimension(metadata.imageWidth) / dimension(metadata.tileWidth);
  return Math.min(MAX_ZOOM, Math.max(0, Math.ceil(Math.log2(columns) - 1e-9)));
}

export function getTileLayout(metadata, requestedZoom = 3) {
  if (!Number.isInteger(requestedZoom) || requestedZoom < 0 || requestedZoom > MAX_ZOOM) throw new StreetViewError('Zoom do panorama inválido.', 'INVALID_TILE');
  const imageWidth = dimension(metadata.imageWidth), imageHeight = dimension(metadata.imageHeight);
  const tileWidth = dimension(metadata.tileWidth), tileHeight = dimension(metadata.tileHeight);
  const maxZoom = nativeZoom(metadata), zoom = Math.min(requestedZoom, maxZoom);
  const divisor = 2 ** (maxZoom - zoom);
  const width = Math.max(1, Math.ceil(imageWidth / divisor));
  const height = Math.max(1, Math.ceil(imageHeight / divisor));
  const columns = Math.ceil(width / tileWidth), rows = Math.ceil(height / tileHeight);
  const tiles = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    tiles.push({ x, y, width: Math.min(tileWidth, width - x * tileWidth), height: Math.min(tileHeight, height - y * tileHeight) });
  }
  return { zoom, width, height, tileWidth, tileHeight, columns, rows, tiles };
}

function safeResponseError(status, payload) {
  const reasons = payload?.error?.errors?.map(item => item.reason) || [];
  if (reasons.includes('expired')) return new StreetViewError('A sessão do Street View expirou.', 'SESSION_EXPIRED', status);
  if (status === 429 || reasons.some(reason => ['quotaExceeded', 'rateLimitExceeded'].includes(reason))) return new StreetViewError('O limite de uso do Google foi atingido. As imagens já baixadas ficam salvas; tente de novo mais tarde para baixar só as que faltam, ou aumente a cota da Map Tiles API no Google Cloud.', 'QUOTA_EXCEEDED', status);
  if (status === 401 || status === 403) return new StreetViewError('O Google recusou o acesso. Confira a chave, a Map Tiles API, o faturamento e os domínios permitidos.', 'ACCESS_DENIED', status);
  if (status === 404 || reasons.includes('notFound')) return new StreetViewError('Esta imagem do Street View não está disponível. Escolha novamente o panorama.', 'NOT_FOUND', status);
  return new StreetViewError(`Não foi possível carregar o Street View (HTTP ${status}).`, 'HTTP_ERROR', status);
}

function waitWithSignal(promise, signal) {
  assertActive(signal);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function createGoogleProvider({ apiKey, fetchImpl = globalThis.fetch, requestTimeoutMs = 15000, now = Date.now, tileCache, localTileBase = import.meta.env?.DEV ? '/__street-cache' : null, localOnly = false, memoryMaxEntries = MEMORY_ENTRIES, memoryMaxBytes = MEMORY_BYTES } = {}) {
  let session = null, sessionPromise = null, disposed = false;
  const controllers = new Set();
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  const cache = tileCache ?? createTileCache({apiKey: key, now});
  const pendingTiles = new Map();
  const cacheWrites = new Set();
  const cacheCounters = {hits: 0, misses: 0, stores: 0, memoryHits: 0};
  const localRequests = new Set();
  const memoryTiles = new Map();
  const memoryEntryLimit = Number.isInteger(memoryMaxEntries) && memoryMaxEntries > 0 ? memoryMaxEntries : MEMORY_ENTRIES;
  const memoryByteLimit = Number.isSafeInteger(memoryMaxBytes) && memoryMaxBytes > 0 ? memoryMaxBytes : MEMORY_BYTES;
  let memoryBytes = 0, nextMemoryExpiry = Infinity;
  let persistencePromise, persistence = {type: 'browser'};

  function forgetMemory(tileKey) {
    const entry = memoryTiles.get(tileKey);
    if (entry) { memoryBytes -= entry.blob.size; memoryTiles.delete(tileKey); }
  }

  function memoryTile(tileKey) {
    const entry = memoryTiles.get(tileKey), time = now();
    if (!entry) return null;
    if (entry.expiresAt <= time || entry.storedAt > time) { forgetMemory(tileKey); return null; }
    memoryTiles.delete(tileKey); memoryTiles.set(tileKey, entry);
    return entry.blob;
  }

  function rememberPersistedTile(tileKey, response) {
    // A retained blob is also proof of a completed disk write. The initial
    // route download and driving share archived originals for this session.
    const storedAt = now();
    const expiresAt = response.archived ? Infinity : tileFreshness(response.headers, {now: storedAt, requestStartedAt: response.requestStartedAt});
    forgetMemory(tileKey);
    if (disposed || !response.persisted || !expiresAt || response.blob.size > memoryByteLimit) return;
    if (storedAt >= nextMemoryExpiry) {
      nextMemoryExpiry = Infinity;
      for (const [key, entry] of memoryTiles) {
        if (entry.expiresAt <= storedAt || entry.storedAt > storedAt) forgetMemory(key);
        else nextMemoryExpiry = Math.min(nextMemoryExpiry, entry.expiresAt);
      }
    }
    memoryTiles.set(tileKey, {blob: response.blob, expiresAt, storedAt});
    memoryBytes += response.blob.size;
    nextMemoryExpiry = Math.min(nextMemoryExpiry, expiresAt);
    while (memoryTiles.size > memoryEntryLimit || memoryBytes > memoryByteLimit) forgetMemory(memoryTiles.keys().next().value);
  }

  function cacheStats() {
    return {...cacheCounters, pendingWrites: cacheWrites.size + localRequests.size, storage: persistence.type, memoryEntries: memoryTiles.size, memoryBytes};
  }

  async function localRequest(path, {signal, tile = false, body, timeoutMs = requestTimeoutMs} = {}) {
    if (disposed) throw abortError();
    assertActive(signal);
    const controller = new AbortController(), abort = () => controller.abort();
    controllers.add(controller);
    signal?.addEventListener('abort', abort, {once: true});
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const requestStartedAt = now();
      // Always reach the local server: a browser cache hit would not prove that
      // this machine's project directory contains the downloaded image.
      const response = await fetchImpl(localTileBase + path, {signal: controller.signal, cache: 'no-store', credentials: 'same-origin', ...(body ? {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : {})});
      if (!response.ok) {
        let payload;
        try { payload = await response.json(); } catch { /* Safe local error only. */ }
        const localErrors = {
          LOCAL_TILE_MISSING: 'Esta imagem não está no acervo local. Nenhum download foi iniciado.',
          LOCAL_ROUTE_MISSING: 'As imagens estão preservadas, mas o percurso ainda não foi salvo neste computador. Use “Atualizar com Google” para salvar o percurso e completar as imagens.',
          INVALID_LOCAL_ROUTE: 'O percurso salvo está incompleto ou inválido. As imagens permanecem no disco.',
        };
        if (localErrors[payload?.code]) throw new StreetViewError(localErrors[payload.code], payload.code, response.status);
        if (payload?.code === 'DAILY_QUOTA_EXCEEDED') throw new StreetViewError('A cota diária de imagens do Street View deste projeto Google acabou. As imagens já baixadas ficam salvas. A cota volta à meia-noite do horário do Pacífico (por volta de 5h em Brasília), ou pode ser aumentada no Google Cloud em Map Tiles API → Cotas.', 'DAILY_QUOTA_EXCEEDED', response.status);
        if (['ACCESS_DENIED', 'QUOTA_EXCEEDED', 'NOT_FOUND'].includes(payload?.code)) throw safeResponseError(response.status);
        throw new StreetViewError('Não foi possível salvar a imagem no computador. Confira o servidor local e tente novamente.', 'DISK_CACHE_ERROR', response.status);
      }
      const result = tile ? await response.blob() : await response.json();
      assertActive(controller.signal);
      if (tile && (!result.size || !result.type?.startsWith('image/'))) throw new StreetViewError('O servidor local retornou uma imagem inválida.', 'INVALID_TILE');
      return tile ? {blob: result, headers: new Headers(response.headers), requestStartedAt, persisted: response.headers.get('X-Street-Persisted') === '1', hit: response.headers.get('X-Street-Cache') === 'HIT', archived: response.headers.get('X-Street-Archive') === '1'} : result;
    } catch (error) {
      if (timedOut) throw new StreetViewError('O carregamento local demorou demais. Tente novamente.', 'TIMEOUT');
      if (controller.signal.aborted || signal?.aborted || disposed) throw abortError();
      if (error instanceof StreetViewError) throw error;
      throw new StreetViewError('Não foi possível conectar ao armazenamento local do jogo.', 'DISK_CACHE_ERROR');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controllers.delete(controller); }
  }

  async function detectPersistence({signal} = {}) {
    if (disposed) throw abortError();
    assertActive(signal);
    if (!localTileBase) return {type: 'browser'};
    if (!persistencePromise) persistencePromise = localRequest('/status', {timeoutMs: Math.min(3000, requestTimeoutMs)})
      .then(result => { persistence = result?.type === 'disk' ? {type: 'disk', directory: '.cache/streetview'} : {type: 'browser'}; return persistence; })
      .catch(error => { if (disposed) throw error; return persistence; });
    return {...await waitWithSignal(persistencePromise, signal)};
  }

  async function request(path, query, { signal, body, type = 'json' } = {}) {
    if (disposed) throw new StreetViewError('A conexão com o Street View foi encerrada.', 'DISPOSED');
    if (localOnly) throw new StreetViewError('O modo local não consulta o Google.', 'LOCAL_ONLY');
    if (!key) throw new StreetViewError('Configure VITE_GOOGLE_MAPS_API_KEY para carregar fotografias do Google Street View.', 'MISSING_API_KEY');
    assertActive(signal);
    const controller = new AbortController();
    controllers.add(controller);
    let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, requestTimeoutMs);
    const url = new URL(path, BASE_URL);
    for (const [name, value] of Object.entries({ ...query, key })) url.searchParams.set(name, String(value));
    try {
      const requestStartedAt = now();
      const response = await fetchImpl(url.href, {
        method: body ? 'POST' : 'GET', signal: controller.signal,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
        // HTTP caching remains authoritative when CORS hides freshness headers.
        cache: 'default', credentials: 'omit',
      });
      if (!response.ok) {
        let payload;
        try { payload = await response.json(); } catch { payload = null; }
        throw safeResponseError(response.status, payload);
      }
      const result = type === 'tile' ? await response.blob() : await response.json();
      assertActive(controller.signal);
      if (type === 'tile' && (!result.size || (result.type && !result.type.startsWith('image/')))) {
        throw new StreetViewError('O Google retornou um bloco de imagem inválido.', 'INVALID_TILE');
      }
      return type === 'tile' ? {blob: result, headers: new Headers(response.headers), requestStartedAt} : result;
    } catch (error) {
      if (timedOut) throw new StreetViewError('O carregamento do Street View demorou demais. Tente novamente.', 'TIMEOUT');
      if (controller.signal.aborted || signal?.aborted || disposed) throw abortError();
      if (error instanceof StreetViewError) throw error;
      // Fetch and server error messages may include credential-bearing URLs.
      throw new StreetViewError('Não foi possível conectar ao Google Street View. Confira a conexão e tente novamente.', 'NETWORK_ERROR');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); controllers.delete(controller);
    }
  }

  async function getSession(signal) {
    assertActive(signal);
    if (session && session.expiry > now() + 30000) return session;
    if (!sessionPromise) {
      sessionPromise = request('createSession', {}, { body: { mapType: 'streetview', language: 'pt-BR', region: 'BR' } })
        .then(data => {
          const expiry = number(data.expiry) * 1000;
          if (typeof data.session !== 'string' || !data.session || !Number.isFinite(expiry) || expiry <= now()) {
            throw new StreetViewError('O Google retornou uma sessão inválida. Tente novamente.', 'INVALID_SESSION');
          }
          session = { token: data.session, expiry }; return session;
        }).finally(() => { sessionPromise = null; });
    }
    return waitWithSignal(sessionPromise, signal);
  }

  async function sessionRequest(path, query, options = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await getSession(options.signal);
      try { return await request(path, { ...query, session: current.token }, options); }
      catch (error) {
        if (error.code !== 'SESSION_EXPIRED' || attempt > 0) throw error;
        if (session === current) session = null;
      }
    }
  }

  return {
    detectPersistence,
    async readLocalRoute({signal, location = 'paulista'} = {}) {
      if ((await detectPersistence({signal})).type !== 'disk') throw new StreetViewError('Abra o jogo pelo servidor local para acessar as imagens do computador.', 'LOCAL_STORAGE_UNAVAILABLE');
      return localRequest(`/route?location=${encodeURIComponent(location)}`, {signal});
    },
    async saveLocalRoute(route, {signal} = {}) { return localRequest('/route', {signal, body: route}); },
    async localInventory({signal} = {}) { return localRequest('/inventory', {signal}); },
    async getMetadata({ panoId, lat, lng, radius = 30 } = {}, { signal } = {}) {
      let query;
      if (typeof panoId === 'string' && panoId.trim()) query = { panoId: panoId.trim() };
      else {
        if (!Number.isFinite(number(lat)) || Math.abs(number(lat)) > 90 || !Number.isFinite(number(lng)) || Math.abs(number(lng)) > 180 || !Number.isFinite(number(radius)) || number(radius) <= 0) {
          throw new StreetViewError('Informe uma posição válida para procurar o Street View.', 'INVALID_LOCATION');
        }
        query = { lat: number(lat), lng: number(lng), radius: number(radius) };
      }
      return normalizeMetadata(await sessionRequest('streetview/metadata', query, { signal }));
    },
    async getTile(metadata, { zoom, x, y, signal, persistToDisk = false, onSource } = {}) {
      if (disposed) throw new StreetViewError('A conexão com o Street View foi encerrada.', 'DISPOSED');
      if (!key && !localOnly) throw new StreetViewError('Configure VITE_GOOGLE_MAPS_API_KEY para carregar fotografias do Google Street View.', 'MISSING_API_KEY');
      assertActive(signal);
      const layout = getTileLayout(metadata, zoom);
      if (!metadata.panoId || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= layout.columns || y >= layout.rows) {
        throw new StreetViewError('Coordenadas do bloco de imagem inválidas.', 'INVALID_TILE');
      }
      const tile = {panoId: metadata.panoId, zoom: layout.zoom, x, y};
      const tileKey = JSON.stringify([tile.panoId, tile.zoom, x, y]);
      const retained = memoryTile(tileKey);
      if (retained) { cacheCounters.hits++; cacheCounters.memoryHits++; onSource?.('memory'); return retained; }
      const consumer = new AbortController(), stop = () => consumer.abort();
      signal?.addEventListener('abort', stop, {once: true}); controllers.add(consumer);
      let pending;
      try {
        const storage = await detectPersistence({signal: consumer.signal});
        if (storage.type === 'disk') {
          const query = new URLSearchParams({panoId: tile.panoId, zoom: String(tile.zoom), x: String(x), y: String(y)});
          // Downloads may wait on the server while Google's per-minute limit resets.
          const request = localRequest(`/${localOnly ? 'local-tile' : 'tile'}?${query}`, {signal: consumer.signal, tile: true, timeoutMs: localOnly ? requestTimeoutMs : Math.max(requestTimeoutMs, 180000)});
          localRequests.add(request);
          let response;
          try { response = await request; } finally { localRequests.delete(request); }
          assertActive(consumer.signal);
          if (persistToDisk && !response.persisted) throw new StreetViewError('Esta imagem não pôde ser salva no disco. Verifique o espaço disponível e tente novamente.', 'DISK_CACHE_UNAVAILABLE');
          rememberPersistedTile(tileKey, response);
          if (response.hit) cacheCounters.hits++;
          else { cacheCounters.misses++; if (response.persisted) cacheCounters.stores++; }
          onSource?.(response.hit ? 'disk' : 'google');
          return response.blob;
        }
        if (localOnly) throw new StreetViewError('O modo local precisa do servidor local do jogo. Nenhum download foi iniciado.', 'LOCAL_STORAGE_UNAVAILABLE');
        if (persistToDisk) throw new StreetViewError('O armazenamento no computador precisa do servidor local do jogo.', 'DISK_CACHE_UNAVAILABLE');
        let hit = null;
        try { hit = await waitWithSignal(Promise.resolve().then(() => cache.get(tile)), consumer.signal); }
        catch { assertActive(consumer.signal); }
        assertActive(consumer.signal);
        if (hit) { cacheCounters.hits++; onSource?.('browser'); return hit; }
        cacheCounters.misses++;
        pending = pendingTiles.get(tileKey);
        if (!pending || pending.controller.signal.aborted) {
          const controller = new AbortController();
          pending = {controller, consumers: 0, settled: false, promise: null, writePromise: null};
          const entry = pending;
          controllers.add(controller);
          entry.promise = (async () => {
            const response = await sessionRequest(`streetview/tiles/${layout.zoom}/${x}/${y}`, {panoId: tile.panoId}, {signal: controller.signal, type: 'tile'});
            assertActive(controller.signal);
            // Decode/render can start immediately. Keep a completed request in
            // pendingTiles until storage finishes so another caller reuses it.
            // Already downloaded, valid data may finish saving after dispose.
            controllers.delete(controller);
            const writing = Promise.resolve().then(() => cache.put(tile, response.blob, response.headers, {requestStartedAt: response.requestStartedAt}))
              .then(stored => { if (stored) cacheCounters.stores++; }, () => {})
              .finally(() => {
                cacheWrites.delete(writing);
                if (pendingTiles.get(tileKey) === entry) pendingTiles.delete(tileKey);
              });
            entry.writePromise = writing; cacheWrites.add(writing);
            return response.blob;
          })().finally(() => {
            entry.settled = true; controllers.delete(controller);
            if (!entry.writePromise && pendingTiles.get(tileKey) === entry) pendingTiles.delete(tileKey);
          });
          pendingTiles.set(tileKey, pending);
        }
        pending.consumers++;
        const blob = await waitWithSignal(pending.promise, consumer.signal);
        assertActive(consumer.signal);
        onSource?.('google');
        return blob;
      } finally {
        signal?.removeEventListener('abort', stop); controllers.delete(consumer);
        if (pending && --pending.consumers === 0 && !pending.settled) pending.controller.abort();
      }
    },
    cacheStats,
    async flushCache() {
      // Call after loading a view when a test or explicit workflow needs to know
      // its writes are durable before creating another provider/reloading.
      await Promise.allSettled([...pendingTiles.values()].map(entry => entry.promise));
      await Promise.allSettled([...localRequests]);
      while (cacheWrites.size) await Promise.allSettled([...cacheWrites]);
      return cacheStats();
    },
    dispose() {
      if (disposed) return;
      disposed = true; session = null;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      pendingTiles.clear();
      memoryTiles.clear(); memoryBytes = 0; nextMemoryExpiry = Infinity;
    },
  };
}
