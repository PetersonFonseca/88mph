const EARTH_RADIUS = 6371008.8;
const RAD = Math.PI / 180;
const DISTANCE_EPSILON = 0.01;
// These IDs were observed in the official Maps UI. Each still requires API validation.
const HISTORICAL_SEEDS = Object.freeze([
  Object.freeze({ panoId: 'TWkq4FhO4j2To4D2VHKGPA', date: '2010-02', lat: -23.5621532, lng: -46.655571 }),
  Object.freeze({ panoId: 'ySq_gSvrYMYFFrW9IcvWGg', date: '2011-04', lat: -23.5621099, lng: -46.655576 }),
  Object.freeze({ panoId: 'jDx00tGnr9cBNPxxdUdftA', date: '2013-11', lat: -23.56217, lng: -46.655586 }),
]);

export const PAULISTA = Object.freeze({
  id: 'paulista',
  name: 'Avenida Paulista · São Paulo',
  heading: 315,
  targetEachSide: 1000,
  minimumBeforePortal: 400,
  minimumAfterPortal: 250,
  maxGap: 60,
  maxCrossDistance: 25,
  maxHeadingDifference: 45,
  maxTurn: 30,
  recentCaptureWindowYears: 4,
  maxRequests: 1600,
  historicalSeeds: HISTORICAL_SEEDS,
  seeds: Object.freeze({
    present: Object.freeze({ panoId: '-TCfsMM9CMoFPuENp1ExDw', date: '2024-11', lat: -23.5621371, lng: -46.6555775 }),
    past: HISTORICAL_SEEDS[0],
  }),
});

export class RouteCoverageError extends Error {
  constructor(message, code = 'ROUTE_COVERAGE') {
    super(message);
    this.name = 'RouteCoverageError';
    this.humanError = message;
    this.code = code;
  }
}

export function distanceMeters(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

/** Local metres along the avenue and across it; zero is the supplied portal. */
export function projectToRoute(lat, lng, origin = PAULISTA.seeds.present, heading = PAULISTA.heading) {
  const north = (lat - origin.lat) * RAD * EARTH_RADIUS;
  const east = (lng - origin.lng) * RAD * EARTH_RADIUS * Math.cos(origin.lat * RAD);
  const angle = heading * RAD;
  return { along: north * Math.cos(angle) + east * Math.sin(angle), cross: east * Math.cos(angle) - north * Math.sin(angle) };
}

export function headingDifference(a, b) {
  return Math.abs((((a - b + 180) % 360) + 360) % 360 - 180);
}

/** Follow the road tangent without a 360-degree spin or a heading change at the portal. */
export function headingAt(route, epoch, s) {
  const fallback = Number.isFinite(route?.heading) ? route.heading : PAULISTA.heading;
  const nodes = route?.epochs?.[epoch]?.nodes;
  if (!nodes?.length || !Number.isFinite(s)) return fallback;
  const value = node => Math.abs(node.s - route.portalS) <= DISTANCE_EPSILON ? fallback : Number.isFinite(node.heading) ? node.heading : fallback;
  if (s <= nodes[0].s) return value(nodes[0]);
  if (s >= nodes.at(-1).s) return value(nodes.at(-1));
  let low = 0, high = nodes.length - 1;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (nodes[middle].s <= s) low = middle; else high = middle;
  }
  const a = value(nodes[low]), b = value(nodes[high]);
  const fraction = (s - nodes[low].s) / (nodes[high].s - nodes[low].s);
  const delta = (((b - a + 180) % 360) + 360) % 360 - 180;
  return (a + delta * fraction + 360) % 360;
}

function bearing(a, b) {
  const dLng = (b.lng - a.lng) * RAD;
  const latA = a.lat * RAD, latB = b.lat * RAD;
  return (Math.atan2(Math.sin(dLng) * Math.cos(latB), Math.cos(latA) * Math.sin(latB) - Math.sin(latA) * Math.cos(latB) * Math.cos(dLng)) / RAD + 360) % 360;
}

function abortIfNeeded(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('Preparação cancelada.', 'AbortError');
}

function canonicalMetadata(raw) {
  const lat = raw?.lat ?? raw?.location?.lat;
  const lng = raw?.lng ?? raw?.location?.lng;
  const date = raw?.date ?? raw?.imageDate;
  const panoId = raw?.panoId ?? raw?.pano;
  if (!panoId || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180 || typeof date !== 'string' || !/^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/.test(date)) {
    throw new RouteCoverageError('O Street View não informou localização e data válidas para este panorama.', 'INVALID_METADATA');
  }
  return {
    ...raw, panoId, lat, lng, date,
    links: (raw.links ?? []).map(link => ({ ...link, panoId: link.panoId ?? link.pano })).filter(link => link.panoId && Number.isFinite(link.heading)),
  };
}

function isSameYear(metadata, date) {
  return metadata.date.slice(0, 4) === date.slice(0, 4);
}

function allowedCapture(metadata, portal, epoch) {
  if (epoch === 'past') return isSameYear(metadata, portal.date);
  return Number(metadata.date.slice(0, 4)) >= Number(portal.date.slice(0, 4)) - PAULISTA.recentCaptureWindowYears;
}

function avenueLink(link) {
  return !link.text?.trim() || /paulista/i.test(link.text);
}

function projectOnPolyline(metadata, nodes) {
  let best = null;
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1], b = nodes[i];
    const point = projectToRoute(metadata.lat, metadata.lng, a.metadata, 0);
    const end = projectToRoute(b.metadata.lat, b.metadata.lng, a.metadata, 0);
    const lengthSquared = end.along ** 2 + end.cross ** 2;
    if (!lengthSquared) continue;
    const t = Math.min(1, Math.max(0, (point.along * end.along + point.cross * end.cross) / lengthSquared));
    const distance = Math.hypot(point.along - t * end.along, point.cross - t * end.cross);
    if (!best || distance < best.distance) best = { along: a.along + t * (b.along - a.along), distance };
  }
  return best;
}

/** Match historical positions to actual road distance, keeping both portals at zero. */
function alignHistoricalNodes(present, past) {
  const portal = past.find(node => node.along === 0);
  const currentPortal = present.find(node => node.along === 0).metadata;
  const portalOffset = { lat: currentPortal.lat - portal.metadata.lat, lng: currentPortal.lng - portal.metadata.lng };
  const matched = [{ ...portal, along: 0 }];
  for (const direction of [-1, 1]) {
    let lastAlong = 0;
    const branch = past.filter(node => direction * node.along > 0).sort((a, b) => direction * (a.along - b.along));
    const reference = present.filter(node => direction * node.along >= 0);
    for (const node of branch) {
      const projection = projectOnPolyline({ lat: node.metadata.lat + portalOffset.lat, lng: node.metadata.lng + portalOffset.lng }, reference);
      if (!projection || projection.distance > PAULISTA.maxCrossDistance) break;
      const along = projection.along;
      if (direction * (along - lastAlong) < 1) break;
      matched.push({ ...node, along });
      lastAlong = along;
    }
  }
  return matched.sort((a, b) => a.along - b.along);
}

function isMissingCapture(error) {
  return error?.code === 'NOT_FOUND' || error?.code === 'INVALID_METADATA';
}

function canTryHistoricalFallback(error) {
  return error instanceof RouteCoverageError && ['ROUTE_COVERAGE', 'INVALID_METADATA'].includes(error.code);
}

function labelFor(epoch, nodes, portal) {
  const dates = [...new Set(nodes.map(node => node.metadata.date))].sort();
  const range = dates[0] === dates.at(-1) ? dates[0] : `${dates[0]} a ${dates.at(-1)}`;
  return {
    id: epoch,
    label: `${epoch === 'present' ? 'Presente disponível' : 'Passado'} · ${range}`,
    date: portal.date,
    dateRange: { from: dates[0], to: dates.at(-1) },
    nodes,
  };
}

function locationAt(nodes, along) {
  if (along <= nodes[0].along) return nodes[0].metadata;
  for (let i = 1; i < nodes.length; i++) {
    const next = nodes[i], previous = nodes[i - 1];
    if (along <= next.along) {
      const t = (along - previous.along) / (next.along - previous.along);
      return {
        lat: previous.metadata.lat + t * (next.metadata.lat - previous.metadata.lat),
        lng: previous.metadata.lng + t * (next.metadata.lng - previous.metadata.lng),
      };
    }
  }
  return nodes.at(-1).metadata;
}

function validateAlignment(present, past, start, end) {
  const positions = [...new Set([start, end, ...present.map(node => node.along), ...past.map(node => node.along)])]
    .filter(along => along >= start && along <= end).sort((a, b) => a - b);
  let previous = null;
  for (const along of positions) {
    const pair = { present: locationAt(present, along), past: locationAt(past, along) };
    if (distanceMeters(pair.present, pair.past) > PAULISTA.maxCrossDistance) {
      throw new RouteCoverageError('As imagens das duas épocas não cobrem a mesma faixa da Avenida Paulista.');
    }
    if (previous && along - previous.along > 1 && headingDifference(bearing(previous.pair.present, pair.present), bearing(previous.pair.past, pair.past)) > PAULISTA.maxHeadingDifference) {
      throw new RouteCoverageError('Os panoramas das duas épocas seguem direções incompatíveis neste trecho.');
    }
    previous = { along, pair };
  }
}

/** Discover metadata through official panorama links; no images are downloaded. */
export async function resolvePaulistaRoute(provider, { signal, onProgress = () => {}, historicalSeeds = PAULISTA.historicalSeeds } = {}) {
  if (typeof provider?.getMetadata !== 'function') throw new TypeError('O provedor precisa implementar getMetadata.');
  if (!Array.isArray(historicalSeeds) || !historicalSeeds.length || historicalSeeds.some(seed => !seed?.panoId || typeof seed.date !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(seed.date) || !Number.isFinite(seed.lat) || !Number.isFinite(seed.lng))) {
    throw new TypeError('Informe ao menos uma captura histórica observada com ID, data e coordenadas.');
  }
  const cache = new Map();
  let loaded = 0, requests = 0;
  let fatalError = null;
  const progress = data => onProgress({ loaded, ...data });

  async function read(request) {
    abortIfNeeded(signal);
    if (fatalError) throw fatalError;
    const key = request.panoId || `location:${request.lat},${request.lng}:${request.radius ?? ''}`;
    if (!cache.has(key)) {
      if (++requests > PAULISTA.maxRequests) throw new RouteCoverageError('A verificação do percurso excedeu o limite de consultas. Tente novamente.', 'REQUEST_LIMIT');
      const pending = Promise.resolve().then(() => {
        abortIfNeeded(signal);
        if (fatalError) throw fatalError;
        return provider.getMetadata(request, { signal });
      }).then(raw => {
        abortIfNeeded(signal);
        const metadata = canonicalMetadata(raw);
        loaded++;
        return metadata;
      }).catch(error => {
        if (!isMissingCapture(error)) fatalError = error;
        throw error;
      });
      cache.set(key, pending);
    }
    return cache.get(key);
  }

  async function resolveSeed(epoch, seed = PAULISTA.seeds[epoch]) {
    let metadata;
    try {
      metadata = await read({ panoId: seed.panoId });
    } catch (error) {
      abortIfNeeded(signal);
      if (!isMissingCapture(error)) throw error;
      if (epoch === 'past') throw new RouteCoverageError(`O panorama de ${seed.date.slice(0, 4)} não está disponível pela API oficial. Não é possível preparar a viagem histórica.`);
    }
    if (epoch === 'present' && (!metadata || metadata.date !== seed.date || distanceMeters(seed, metadata) > PAULISTA.maxCrossDistance)) {
      // Location lookup is the documented refresh mechanism, not a date selector.
      try {
        metadata = await read({ lat: seed.lat, lng: seed.lng, radius: PAULISTA.maxCrossDistance });
      } catch (error) {
        abortIfNeeded(signal);
        if (!isMissingCapture(error)) throw error;
        throw new RouteCoverageError('Não foi possível verificar uma captura atual neste ponto da Avenida Paulista.');
      }
      if (metadata.date < seed.date) throw new RouteCoverageError('A captura atual disponível é anterior à referência de novembro de 2024.');
    }
    if (epoch === 'past' && !isSameYear(metadata, seed.date)) {
      throw new RouteCoverageError(`O panorama histórico retornado não é de ${seed.date.slice(0, 4)}. A viagem foi interrompida para não exibir a época errada.`);
    }
    if (distanceMeters(seed, metadata) > PAULISTA.maxCrossDistance) {
      throw new RouteCoverageError('O panorama encontrado fica fora do ponto de viagem na Avenida Paulista.');
    }
    progress({ stage: 'portal', epoch, message: `Captura ${metadata.date} verificada.` });
    return metadata;
  }

  progress({ stage: 'start', message: 'Verificando as capturas reais da Avenida Paulista…' });
  const presentPortal = await resolveSeed('present');

  async function firstForwardHeading(portal, epoch) {
    const candidates = portal.links.filter(link => avenueLink(link) && headingDifference(link.heading, PAULISTA.heading) <= PAULISTA.maxHeadingDifference)
      .sort((a, b) => headingDifference(a.heading, PAULISTA.heading) - headingDifference(b.heading, PAULISTA.heading));
    for (const link of candidates) {
      if (link.panoId === portal.panoId) continue;
      let neighbor;
      try { neighbor = await read({ panoId: link.panoId }); }
      catch (error) {
        abortIfNeeded(signal);
        if (!isMissingCapture(error)) throw error;
        continue;
      }
      const gap = distanceMeters(portal, neighbor);
      const heading = bearing(portal, neighbor);
      if (allowedCapture(neighbor, portal, epoch) && gap >= 1 && gap <= PAULISTA.maxGap + DISTANCE_EPSILON && headingDifference(heading, PAULISTA.heading) <= PAULISTA.maxHeadingDifference) return heading;
    }
    throw new RouteCoverageError(`Não há um próximo panorama válido da captura ${portal.date} na direção da Avenida Paulista.`);
  }

  async function discover(epoch, portal, routeHeading) {
    const visited = new Set([portal.panoId]);
    async function follow(direction) {
      const nodes = [];
      const initialHeading = direction > 0 ? routeHeading : (routeHeading + 180) % 360;
      let heading = initialHeading, current = portal, currentAlong = 0;
      function viable(metadata) {
        const gap = distanceMeters(current, metadata);
        const nextHeading = bearing(current, metadata);
        return allowedCapture(metadata, portal, epoch) && gap >= 1 && gap <= PAULISTA.maxGap + DISTANCE_EPSILON &&
          headingDifference(nextHeading, initialHeading) <= PAULISTA.maxHeadingDifference && headingDifference(nextHeading, heading) <= PAULISTA.maxTurn;
      }
      async function lookup(request) {
        try { return await read(request); }
        catch (error) { abortIfNeeded(signal); if (!isMissingCapture(error)) throw error; return null; }
      }
      async function crossIntersection(intersection) {
        const links = intersection.links.filter(link => !visited.has(link.panoId) && /paulista/i.test(link.text ?? '') &&
          headingDifference(link.heading, initialHeading) <= PAULISTA.maxHeadingDifference && headingDifference(link.heading, heading) <= PAULISTA.maxTurn)
          .sort((a, b) => headingDifference(a.heading, heading) - headingDifference(b.heading, heading));
        for (const link of links) {
          const metadata = await lookup({ panoId: link.panoId });
          if (!metadata || visited.has(metadata.panoId) || !viable(metadata) || distanceMeters(intersection, metadata) > PAULISTA.maxGap) continue;
          // A junction may name the transverse street. Skip its image only after
          // verifying that the next official link rejoins Paulista within one normal gap.
          return metadata;
        }
        return null;
      }
      for (let step = 0; step < 300 && Math.abs(currentAlong) + DISTANCE_EPSILON < PAULISTA.targetEachSide; step++) {
        abortIfNeeded(signal);
        const candidates = current.links.filter(link => !visited.has(link.panoId) && headingDifference(link.heading, initialHeading) <= PAULISTA.maxHeadingDifference && headingDifference(link.heading, heading) <= PAULISTA.maxTurn)
          .sort((a, b) => Number(!avenueLink(a)) - Number(!avenueLink(b)) || headingDifference(a.heading, heading) - headingDifference(b.heading, heading));
        let next = null;
        for (const link of candidates) {
          let metadata;
          try {
            metadata = await read({ panoId: link.panoId });
          } catch (error) {
            abortIfNeeded(signal);
            if (!isMissingCapture(error)) throw error;
            continue;
          }
          if (metadata.panoId !== link.panoId && visited.has(metadata.panoId)) continue;
          if (!viable(metadata)) continue;
          if (!avenueLink(link)) {
            metadata = await crossIntersection(metadata);
            if (!metadata) continue;
          }
          // A current location lookup can refresh an old bridge's links; it is not a date selector.
          if (epoch === 'present' && metadata.date < portal.date) {
            const refreshed = await lookup({ lat: metadata.lat, lng: metadata.lng, radius: 15 });
            if (refreshed && !visited.has(refreshed.panoId) && refreshed.date >= metadata.date && distanceMeters(refreshed, metadata) <= PAULISTA.maxCrossDistance && viable(refreshed)) metadata = refreshed;
          }
          next = { metadata, along: currentAlong + direction * distanceMeters(current, metadata) };
          break;
        }
        // A nearby official location lookup may bridge a broken recent link. Historical
        // coordinates must never be resolved this way because the API has no year selector.
        if (!next && epoch === 'present') {
          for (const meters of [20, 40]) {
            const lat = current.lat + meters * Math.cos(heading * RAD) / EARTH_RADIUS / RAD;
            const lng = current.lng + meters * Math.sin(heading * RAD) / (EARTH_RADIUS * Math.cos(current.lat * RAD)) / RAD;
            const metadata = await lookup({ lat, lng, radius: 15 });
            if (!metadata || visited.has(metadata.panoId) || !viable(metadata) || !metadata.links.some(link => /paulista/i.test(link.text ?? ''))) continue;
            next = { metadata, along: currentAlong + direction * distanceMeters(current, metadata) };
            break;
          }
        }
        if (!next) break;
        visited.add(next.metadata.panoId);
        heading = bearing(current, next.metadata);
        nodes.push(next);
        current = next.metadata;
        currentAlong = next.along;
        progress({ stage: 'route', epoch, direction, meters: Math.abs(currentAlong), message: `Verificando ${epoch === 'past' ? portal.date.slice(0, 4) : 'o presente'}: ${Math.round(Math.abs(currentAlong))} m ${direction > 0 ? 'após' : 'antes'} do portal.` });
      }
      return nodes;
    }
    const [before, after] = await Promise.all([follow(-1), follow(1)]);
    return [...before, { along: 0, metadata: portal }, ...after].sort((a, b) => a.along - b.along);
  }

  async function attemptHistorical(seed) {
    const pastPortal = await resolveSeed('past', seed);
    if (distanceMeters(presentPortal, pastPortal) > PAULISTA.maxCrossDistance) {
      throw new RouteCoverageError('Os pontos de partida das duas épocas estão distantes demais para uma viagem no mesmo lugar.');
    }
    const [currentHeading, oldHeading] = await Promise.all([firstForwardHeading(presentPortal, 'present'), firstForwardHeading(pastPortal, 'past')]);
    if (headingDifference(currentHeading, oldHeading) > PAULISTA.maxHeadingDifference) {
      throw new RouteCoverageError('Os primeiros panoramas das duas épocas seguem ruas diferentes.');
    }
    const routeHeading = (Math.atan2(Math.sin(currentHeading * RAD) + Math.sin(oldHeading * RAD), Math.cos(currentHeading * RAD) + Math.cos(oldHeading * RAD)) / RAD + 360) % 360;
    const [present, historical] = await Promise.all([discover('present', presentPortal, routeHeading), discover('past', pastPortal, routeHeading)]);
    const past = alignHistoricalNodes(present, historical);
    const start = Math.max(present[0].along, past[0].along);
    const end = Math.min(present.at(-1).along, past.at(-1).along);
    if (-start + DISTANCE_EPSILON < PAULISTA.minimumBeforePortal || end + DISTANCE_EPSILON < PAULISTA.minimumAfterPortal) {
      throw new RouteCoverageError(`Ainda não há cobertura contínua na mesma faixa nas duas épocas: são necessários ${PAULISTA.minimumBeforePortal} m antes e ${PAULISTA.minimumAfterPortal} m depois do portal.`);
    }
    validateAlignment(present, past, start, end);
    const normalize = nodes => nodes.filter(node => node.along >= start - 0.001 && node.along <= end + 0.001)
      .map(node => {
        const index = nodes.indexOf(node);
        const before = nodes[Math.max(0, index - 1)], after = nodes[Math.min(nodes.length - 1, index + 1)];
        return { s: Math.max(0, Math.min(end - start, node.along - start)), heading: bearing(before.metadata, after.metadata), metadata: node.metadata };
      });
    return {
      id: PAULISTA.id, name: PAULISTA.name, portalS: -start, length: end - start, heading: routeHeading,
      epochs: { present: labelFor('present', normalize(present), presentPortal), past: labelFor('past', normalize(past), pastPortal) },
      portal: { present: presentPortal, past: pastPortal },
    };
  }

  let lastCoverageError;
  for (let index = 0; index < historicalSeeds.length; index++) {
    abortIfNeeded(signal);
    try {
      const route = await attemptHistorical(historicalSeeds[index]);
      progress({ stage: 'ready', meters: route.length, message: `${Math.round(route.length)} m verificados nas duas épocas.` });
      return route;
    } catch (error) {
      abortIfNeeded(signal);
      if (!canTryHistoricalFallback(error)) throw error;
      lastCoverageError = error;
      if (index < historicalSeeds.length - 1) progress({ stage: 'historical-fallback', epoch: 'past', message: `${historicalSeeds[index].date} sem percurso completo. Verificando a captura observada ${historicalSeeds[index + 1].date}…` });
    }
  }
  throw lastCoverageError;
}
