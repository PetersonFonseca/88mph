import {normalizeMetadata} from './googleProvider.js';
import {LOCATIONS} from './route.js';

/** Validate and copy only route fields needed by the player; never store request URLs or tokens. */
export function normalizeSavedRoute(value) {
  const invalid = () => { throw Object.assign(new Error('O percurso salvo está incompleto ou inválido.'), {code: 'INVALID_LOCAL_ROUTE', status: 400}); };
  if (!Object.hasOwn(LOCATIONS, value?.id ?? '') || !Number.isFinite(value.length) || value.length <= 0 || value.length > 10000 ||
      !Number.isFinite(value.portalS) || value.portalS <= 0 || value.portalS >= value.length || !Number.isFinite(value.heading)) invalid();
  const metadata = raw => {
    const result = normalizeMetadata(raw);
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(result.panoId) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(result.date)) invalid();
    return {...result, links: []};
  };
  const route = {id: value.id, name: LOCATIONS[value.id].name, length: value.length, portalS: value.portalS, heading: value.heading, epochs: {}, portal: {}};
  for (const epoch of ['present', 'past']) {
    const raw = value.epochs?.[epoch]?.nodes;
    if (!Array.isArray(raw) || raw.length < 2 || raw.length > 2000) invalid();
    let previous = -1;
    const nodes = raw.map(node => {
      if (!Number.isFinite(node.s) || node.s < 0 || node.s > value.length || node.s <= previous || !Number.isFinite(node.heading)) invalid();
      previous = node.s;
      return {s: node.s, heading: node.heading, metadata: metadata(node.metadata)};
    });
    const portal = metadata(value.portal?.[epoch]);
    if (!nodes.some(node => Math.abs(node.s - value.portalS) < .01 && node.metadata.panoId === portal.panoId)) invalid();
    const dates = nodes.map(node => node.metadata.date).sort();
    route.portal[epoch] = portal;
    route.epochs[epoch] = {id: epoch, date: portal.date, dateRange: {from: dates[0], to: dates.at(-1)}, nodes};
  }
  return route;
}
