import test from 'node:test';
import assert from 'node:assert/strict';
import { PAULISTA, RouteCoverageError, distanceMeters, headingAt, headingDifference, projectToRoute, resolvePaulistaRoute as resolveRoute } from '../src/street/route.js';

const resolvePaulistaRoute = (provider, options = {}) => resolveRoute(provider, { historicalSeeds: [PAULISTA.seeds.past], ...options });

const R = 6371008.8;
function coordinate(along, cross = 0, origin = PAULISTA.seeds.present, heading = PAULISTA.heading) {
  const a = heading * Math.PI / 180;
  const north = along * Math.cos(a) - cross * Math.sin(a);
  const east = along * Math.sin(a) + cross * Math.cos(a);
  return { lat: origin.lat + north / R * 180 / Math.PI, lng: origin.lng + east / (R * Math.cos(origin.lat * Math.PI / 180)) * 180 / Math.PI };
}

function mockProvider({ before = 450, after = 450, spacing = 30, transform = () => {} } = {}) {
  const records = new Map(), calls = [];
  for (const epoch of ['present', 'past']) {
    const seed = PAULISTA.seeds[epoch];
    const indexes = [];
    for (let s = -before; s <= after; s += spacing) indexes.push(s);
    if (!indexes.includes(0)) indexes.push(0);
    indexes.sort((a, b) => a - b);
    const id = s => s === 0 ? seed.panoId : `${epoch}:${s}`;
    for (let i = 0; i < indexes.length; i++) {
      const s = indexes[i];
      const metadata = { panoId: id(s), ...coordinate(s, 0, seed), date: seed.date, links: [] };
      if (i > 0) metadata.links.push({ panoId: id(indexes[i - 1]), heading: 135 });
      if (i < indexes.length - 1) metadata.links.push({ panoId: id(indexes[i + 1]), heading: 315 });
      transform(metadata, { epoch, s });
      records.set(metadata.panoId, metadata);
    }
  }
  return {
    records, calls,
    async getMetadata(request, { signal } = {}) {
      signal?.throwIfAborted();
      calls.push(request);
      const result = records.get(request.panoId ?? PAULISTA.seeds.present.panoId);
      if (!result) throw Object.assign(new Error('Panorama ausente.'), { code: 'NOT_FOUND' });
      return result;
    },
  };
}

test('geography projects forward, backward and lateral movement in metres', () => {
  const p = coordinate(360, 12);
  const result = projectToRoute(p.lat, p.lng);
  assert.ok(Math.abs(result.along - 360) < 0.001);
  assert.ok(Math.abs(result.cross - 12) < 0.001);
  assert.ok(Math.abs(distanceMeters(PAULISTA.seeds.present, coordinate(100)) - 100) < 0.1);
  assert.equal(headingDifference(355, 5), 10);
});

test('official linked metadata forms aligned epochs and preserves the portal', async () => {
  const provider = mockProvider();
  const progress = [];
  const route = await resolvePaulistaRoute(provider, { onProgress: event => progress.push(event) });
  assert.ok(Math.abs(route.portalS - 450) < 0.1);
  assert.ok(Math.abs(route.length - 900) < 0.1);
  assert.equal(route.portal.past.panoId, PAULISTA.seeds.past.panoId);
  assert.equal(route.epochs.past.date, '2010-02');
  for (const epoch of Object.values(route.epochs)) {
    assert.ok(epoch.nodes.every((node, i, nodes) => node.s >= 0 && node.s <= route.length && (!i || node.s > nodes[i - 1].s)));
    const portal = epoch.nodes.find(node => node.metadata.panoId === route.portal[epoch.id].panoId);
    assert.equal(portal.s, route.portalS);
  }
  assert.equal(progress.at(-1).stage, 'ready');
  assert.ok(provider.calls.every(request => !('date' in request) && !('year' in request)), 'only supported ID and location queries');
});

test('a historical seed that resolves to another year stops before route discovery', async () => {
  const provider = mockProvider({ transform(metadata, { epoch, s }) { if (epoch === 'past' && s === 0) metadata.date = '2024-11'; } });
  await assert.rejects(resolvePaulistaRoute(provider), error => error instanceof RouteCoverageError && /não é de 2010/.test(error.humanError));
  assert.equal(provider.calls.length, 2);
});

test('missing 2010 coverage never falls back to the present coordinates', async () => {
  const provider = mockProvider();
  provider.records.delete(PAULISTA.seeds.past.panoId);
  await assert.rejects(resolvePaulistaRoute(provider), /2010 não está disponível/);
  assert.ok(provider.calls.every(request => request.panoId));
});

test('a changed present ID is refreshed by coordinates with its returned capture date', async () => {
  const provider = mockProvider({ transform(metadata, { epoch }) { if (epoch === 'present') metadata.date = '2025-06'; } });
  const route = await resolvePaulistaRoute(provider);
  assert.equal(route.epochs.present.date, '2025-06');
  assert.match(route.epochs.present.label, /2025-06/);
  assert.equal(provider.calls.filter(request => !request.panoId && request.lat === PAULISTA.seeds.present.lat && request.lng === PAULISTA.seeds.present.lng).length, 1);
});

test('routes shorter than the physical acceleration and arrival margins are rejected', async () => {
  await assert.rejects(resolvePaulistaRoute(mockProvider({ before: 390 })), /400 m antes e 250 m depois/);
  await assert.rejects(resolvePaulistaRoute(mockProvider({ after: 240 })), /400 m antes e 250 m depois/);
});

test('coverage exactly at the required margins survives coordinate rounding', async () => {
  const route = await resolvePaulistaRoute(mockProvider({ before: 400, after: 250, spacing: 25 }));
  assert.ok(Math.abs(route.portalS - 400) < 0.01);
  assert.ok(Math.abs(route.length - 650) < 0.01);
});

test('the common usable route ends when either epoch runs out of valid links', async () => {
  const provider = mockProvider();
  for (const [id] of provider.records) if (id.startsWith('past:') && (+id.split(':')[1] < -420 || +id.split(':')[1] > 300)) provider.records.delete(id);
  const route = await resolvePaulistaRoute(provider);
  assert.ok(Math.abs(route.portalS - 420) < 0.01);
  assert.ok(Math.abs(route.length - 720) < 0.01);
  assert.ok(route.epochs.present.nodes.every(node => node.s >= 0 && node.s <= route.length));
});

test('historical links cannot silently switch years', async () => {
  const provider = mockProvider({ transform(metadata, { epoch, s }) { if (epoch === 'past' && s <= -270) metadata.date = '2011-01'; } });
  await assert.rejects(resolvePaulistaRoute(provider), /cobertura contínua/);
});

test('gaps above 60 metres and off-route geometry do not become driveable coverage', async () => {
  await assert.rejects(resolvePaulistaRoute(mockProvider({ spacing: 90 })), error => error instanceof RouteCoverageError);
  const provider = mockProvider({ transform(metadata, { epoch, s }) { if (epoch === 'past' && s <= -270) Object.assign(metadata, coordinate(s, 35, PAULISTA.seeds.past)); } });
  await assert.rejects(resolvePaulistaRoute(provider), /cobertura contínua/);
});

test('valid individual corridors must still align with one another within 25 metres', async () => {
  const provider = mockProvider({ transform(metadata, { epoch, s }) {
    const cross = Math.min(1, Math.abs(s) / 90) * (epoch === 'present' ? 18 : -18);
    Object.assign(metadata, coordinate(s, cross, PAULISTA.seeds[epoch]));
  } });
  await assert.rejects(resolvePaulistaRoute(provider), /mesma faixa/);
});

test('panorama loops terminate and do not create length from repeated images', async () => {
  const provider = mockProvider({ before: 90, after: 90, transform(metadata, { epoch, s }) {
    if (s === -90) metadata.links.unshift({ panoId: PAULISTA.seeds[epoch].panoId, heading: 135 });
    if (s === 90) metadata.links.push({ panoId: PAULISTA.seeds[epoch].panoId, heading: 315 });
  } });
  await assert.rejects(resolvePaulistaRoute(provider), /cobertura contínua/);
  const ids = provider.calls.filter(request => request.panoId).map(request => request.panoId);
  assert.equal(ids.length, new Set(ids).size);
  assert.ok(ids.length <= 14);
});

test('links pointing onto a side street cannot extend route coverage', async () => {
  const provider = mockProvider({ transform(metadata, { s }) {
    if (Math.abs(s) === 90) for (const link of metadata.links) link.heading = 45;
  } });
  await assert.rejects(resolvePaulistaRoute(provider), /cobertura contínua/);
});

test('month differences within a year stay visible in the epoch label', async () => {
  const provider = mockProvider({ transform(metadata, { epoch, s }) { if (epoch === 'present' && s > 0) metadata.date = '2024-10'; } });
  const route = await resolvePaulistaRoute(provider);
  assert.equal(route.epochs.present.date, '2024-11');
  assert.match(route.epochs.present.label, /2024-10 a 2024-11/);
});

test('aborted discovery does not call the provider', async () => {
  const provider = mockProvider(), controller = new AbortController();
  controller.abort();
  await assert.rejects(resolvePaulistaRoute(provider, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(provider.calls.length, 0);
});

test('the avenue heading is derived from verified geometry rather than the initial 315-degree hint', async () => {
  const provider = mockProvider({ transform(metadata, { epoch, s }) {
    Object.assign(metadata, coordinate(s, 0, PAULISTA.seeds[epoch], 309));
    for (const link of metadata.links) link.heading = link.heading === 315 ? 309 : 129;
  } });
  const route = await resolvePaulistaRoute(provider);
  assert.ok(headingDifference(route.heading, 309) < 0.01);
  assert.ok(Math.abs(route.length - 900) < 0.01);
});

function addHistoricalEpoch(provider, seed) {
  const id = s => s === 0 ? seed.panoId : `${seed.date}:${s}`;
  for (let s = -450; s <= 450; s += 30) {
    const metadata = { panoId: id(s), ...coordinate(s, 0, seed), date: seed.date, links: [] };
    if (s > -450) metadata.links.push({ panoId: id(s - 30), heading: 135 });
    if (s < 450) metadata.links.push({ panoId: id(s + 30), heading: 315 });
    provider.records.set(metadata.panoId, metadata);
  }
}

test('default fallback checks a complete 2011 route when the 2010 route is too short', async () => {
  const provider = mockProvider();
  for (const [id] of provider.records) if (id.startsWith('past:') && +id.split(':')[1] < -240) provider.records.delete(id);
  addHistoricalEpoch(provider, PAULISTA.historicalSeeds[1]);
  const progress = [];
  const route = await resolveRoute(provider, { onProgress: event => progress.push(event) });
  assert.equal(route.epochs.past.date, '2011-04');
  assert.equal(route.portal.past.panoId, PAULISTA.historicalSeeds[1].panoId);
  assert.ok(route.portalS >= 299.99 && route.length - route.portalS >= 249.99);
  assert.ok(progress.some(event => event.stage === 'historical-fallback'));
  assert.ok(!provider.calls.some(request => request.panoId === PAULISTA.historicalSeeds[2].panoId));
});

test('only observed candidate IDs are tried when 2010 and 2011 are unavailable', async () => {
  const provider = mockProvider();
  provider.records.delete(PAULISTA.seeds.past.panoId);
  addHistoricalEpoch(provider, PAULISTA.historicalSeeds[2]);
  const route = await resolveRoute(provider);
  assert.equal(route.epochs.past.date, '2013-11');
  assert.match(route.epochs.past.label, /2013-11/);
  assert.ok(provider.calls.every(request => !('date' in request) && !('year' in request)));
});

test('a historical ID with the wrong date permits the next observed candidate', async () => {
  const provider = mockProvider({ transform(metadata, { epoch, s }) { if (epoch === 'past' && s === 0) metadata.date = '2024-11'; } });
  addHistoricalEpoch(provider, PAULISTA.historicalSeeds[1]);
  const route = await resolveRoute(provider);
  assert.equal(route.epochs.past.date, '2011-04');
});

test('invalid capture metadata can be skipped without masking other provider failures', async () => {
  const provider = mockProvider({ transform(metadata, { epoch, s }) { if (epoch === 'past' && s === 0) metadata.date = null; } });
  addHistoricalEpoch(provider, PAULISTA.historicalSeeds[1]);
  assert.equal((await resolveRoute(provider)).epochs.past.date, '2011-04');
});

for (const code of ['ACCESS_DENIED', 'QUOTA_EXCEEDED', 'TIMEOUT', 'NETWORK_ERROR']) {
  for (const phase of ['present', 'history', 'forward-link', 'route-link', 'refresh']) {
    test(`${code} during ${phase} propagates unchanged and never selects another historical year`, async () => {
      const provider = mockProvider();
      addHistoricalEpoch(provider, PAULISTA.historicalSeeds[1]);
      const error = Object.assign(new Error(`Provider ${code}`), { code });
      const read = provider.getMetadata;
      const blockedId = { present: PAULISTA.seeds.present.panoId, history: PAULISTA.seeds.past.panoId, 'forward-link': 'past:30', 'route-link': 'past:-90' }[phase];
      if (phase === 'refresh') provider.records.delete(PAULISTA.seeds.present.panoId);
      provider.getMetadata = async (request, options) => {
        if (phase === 'refresh' ? !request.panoId : request.panoId === blockedId) { provider.calls.push(request); throw error; }
        return read(request, options);
      };
      await assert.rejects(resolveRoute(provider), failure => failure === error);
      assert.ok(!provider.calls.some(request => request.panoId === PAULISTA.historicalSeeds[1].panoId));
    });
  }
}

test('unknown provider errors are not converted into missing historical coverage', async () => {
  const provider = mockProvider();
  const error = new Error('Unexpected provider fault');
  provider.getMetadata = async () => { throw error; };
  await assert.rejects(resolveRoute(provider), failure => failure === error);
});

test('the extended route follows a curved Paulista for about two kilometres', async () => {
  const provider = mockProvider({ before: 1020, after: 1020, transform(metadata, { epoch, s }) {
    Object.assign(metadata, coordinate(s, 0.00008 * s * s, PAULISTA.seeds[epoch]));
    for (const link of metadata.links) link.text = 'Av. Paulista';
  } });
  const route = await resolvePaulistaRoute(provider);
  assert.ok(route.length >= 2000 && route.length < 2120);
  assert.ok(route.portalS > 990 && route.length - route.portalS > 990);
  assert.ok(route.epochs.present.nodes.every(node => Number.isFinite(node.heading)));
  assert.ok(headingDifference(route.epochs.present.nodes[0].heading, route.epochs.present.nodes.at(-1).heading) > 10);
  for (const epoch of Object.values(route.epochs)) {
    assert.equal(epoch.nodes.find(node => node.metadata.panoId === route.portal[epoch.id].panoId).s, route.portalS);
  }
});

test('shorter verified coverage remains usable when it still allows the physical approach', async () => {
  const route = await resolvePaulistaRoute(mockProvider({ before: 450, after: 300 }));
  assert.ok(route.length > 749 && route.length < 751);
});

test('recent bridge captures report their actual range while the historical year remains fixed', async () => {
  const provider = mockProvider({ transform(metadata, { epoch, s }) {
    if (epoch === 'present' && s < -240) metadata.date = '2021-12';
  } });
  const route = await resolvePaulistaRoute(provider);
  assert.deepEqual(route.epochs.present.dateRange, { from: '2021-12', to: '2024-11' });
  assert.match(route.epochs.present.label, /2021-12 a 2024-11/);
  assert.ok(route.epochs.past.nodes.every(node => node.metadata.date.startsWith('2010')));
});

test('a recent bridge older than the declared four-year window is rejected', async () => {
  const provider = mockProvider({ transform(metadata, { epoch, s }) {
    if (epoch === 'present' && s <= -390) metadata.date = '2019-12';
  } });
  await assert.rejects(resolvePaulistaRoute(provider), /400 m antes/);
});

test('an explicitly named cross street is not used to extend the avenue', async () => {
  const provider = mockProvider({ transform(metadata, { s }) {
    if (s === -360) for (const link of metadata.links) if (link.heading === 135) link.text = 'Rua Augusta';
  } });
  await assert.rejects(resolvePaulistaRoute(provider), /cobertura contínua/);
});

test('headingAt interpolates across north on the short arc and agrees at the temporal portal', () => {
  const route = { heading: 310, portalS: 200, epochs: {
    present: { nodes: [{ s: 0, heading: 350 }, { s: 100, heading: 10 }, { s: 200, heading: 305 }, { s: 300, heading: 320 }] },
    past: { nodes: [{ s: 0, heading: 355 }, { s: 100, heading: 5 }, { s: 200, heading: 318 }, { s: 300, heading: 322 }] },
  } };
  assert.equal(headingAt(route, 'present', 50), 0);
  assert.equal(headingAt(route, 'present', 200), 310);
  assert.equal(headingAt(route, 'past', 200), 310);
  assert.equal(headingAt(route, 'missing', 50), 310);
});

test('a junction label can be crossed only through a verified Paulista continuation within 60 metres', async () => {
  const provider = mockProvider({ transform(metadata, { s }) {
    for (const link of metadata.links) link.text = 'Av. Paulista';
    if (s === 300) for (const link of metadata.links) if (link.heading === 315) link.text = 'Alameda Min. Rocha Azevedo';
  } });
  const route = await resolvePaulistaRoute(provider);
  assert.ok(route.length > 899);
  assert.ok(!route.epochs.past.nodes.some(node => node.metadata.panoId === 'past:330'));
  assert.ok(route.epochs.past.nodes.some(node => node.metadata.panoId === 'past:360'));
});

test('a location refresh replaces an older disconnected recent ID with a verified connected capture', async () => {
  const provider = mockProvider();
  const original = provider.records.get('present:-360');
  const refreshed = { ...original, panoId: 'refreshed-recent-360', links: [...original.links] };
  original.date = '2021-12';
  original.links = original.links.filter(link => link.heading !== 135);
  const read = provider.getMetadata;
  provider.getMetadata = async (request, options) => {
    if (!request.panoId && distanceMeters(request, original) < 1) { provider.calls.push(request); return refreshed; }
    return read(request, options);
  };
  const route = await resolvePaulistaRoute(provider);
  assert.ok(route.portalS > 449);
  assert.ok(route.epochs.present.nodes.some(node => node.metadata.panoId === refreshed.panoId));
  assert.ok(!route.epochs.present.nodes.some(node => node.metadata.panoId === original.panoId));
  assert.deepEqual(route.epochs.present.dateRange, { from: '2024-11', to: '2024-11' });
});

test('a broken recent link can rejoin the avenue through a nearby official location lookup', async () => {
  const provider = mockProvider({ transform(metadata) { for (const link of metadata.links) link.text = 'Av. Paulista'; } });
  provider.records.get('present:-330').links = [{ panoId: 'present:-450', heading: 135, text: 'Av. Paulista' }];
  const read = provider.getMetadata;
  provider.getMetadata = async (request, options) => {
    if (request.panoId) return read(request, options);
    provider.calls.push(request);
    const closest = [...provider.records.values()].filter(node => node.panoId.startsWith('present:'))
      .sort((a, b) => distanceMeters(request, a) - distanceMeters(request, b))[0];
    if (distanceMeters(request, closest) > request.radius) throw Object.assign(new Error('Panorama ausente.'), { code: 'NOT_FOUND' });
    return closest;
  };
  const route = await resolvePaulistaRoute(provider);
  assert.ok(route.portalS > 449);
  const recent = route.epochs.present.nodes;
  assert.ok(recent.every((node, i) => !i || distanceMeters(recent[i - 1].metadata, node.metadata) < 60.01));
  assert.ok(route.epochs.past.nodes.every(node => node.metadata.date.startsWith('2010')));
});
