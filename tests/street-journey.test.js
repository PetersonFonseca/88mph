import test from 'node:test';
import assert from 'node:assert/strict';
import { StreetJourney } from '../src/street/journey.js';

const MS_PER_MPH = 0.44704;
const metadata = (epoch, s) => ({ panoId: epoch + '-' + s, date: epoch === 'present' ? '2024-11' : '2010-02' });
function route({ gap = 75, portalS = 750, length = 1500 } = {}) {
  const positions = [...new Set([0, portalS, length,
    ...Array.from({ length: Math.floor(length / gap) + 1 }, (_, index) => index * gap)])].sort((a, b) => a - b);
  return {
    id: 'paulista', name: 'Paulista', portalS, length, heading: 315,
    epochs: Object.fromEntries(['present', 'past'].map(epoch => [epoch, {
      id: epoch, nodes: positions.map(s => ({ s, metadata: metadata(epoch, s) })),
    }])),
    portal: { present: metadata('present', portalS), past: metadata('past', portalS) },
  };
}
function resource(meta) {
  return { metadata: meta, ready: true, disposals: 0, dispose() { this.disposals++; } };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup({ load, lookaheadCount = 3, destinationLookaheadCount, track = route() } = {}) {
  const requests = [], resources = [];
  const loadPanorama = async (meta, options) => {
    requests.push({ meta, options });
    const result = load ? await load(meta, options) : resource(meta);
    resources.push(result);
    return result;
  };
  const journey = new StreetJourney({ route: track, loadPanorama, lookaheadCount, destinationLookaheadCount });
  return { journey, requests, resources };
}
async function ticks() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
async function drive(journey, until, limit = 5000) {
  for (let i = 0; i < limit && !until(); i++) {
    journey.update(1 / 60, { throttle: 1 });
    await ticks();
  }
  assert.ok(until(), 'Did not reach expected state: ' + JSON.stringify(journey.snapshot()));
}
const holdSpeedThrottle = speed => (0.2 + speed * 0.015 + speed ** 2 * 0.0003) / 2.0;

test('start waits for three adjacent GPU-ready panoramas and never cascades beyond them', async () => {
  const pending = deferred();
  const { journey, requests } = setup({ load: meta => meta.panoId === 'present-225' ? pending.promise : resource(meta) });
  const starting = journey.start();
  await ticks();
  assert.equal(journey.status, 'idle');
  assert.equal(journey.buffering, true);
  assert.equal(journey.current, null);
  assert.deepEqual(requests.map(item => item.meta.panoId), ['present-0', 'present-75', 'present-150', 'present-225']);
  pending.resolve(resource(metadata('present', 225)));
  await starting;
  assert.equal(journey.snapshot().aheadReady, 3);
  assert.equal(journey.snapshot().movementPaused, false);
  await ticks();
  assert.equal(requests.length, 4);
  journey.dispose();
});

test('destination is armed only after the portal and three following images are ready', async () => {
  const pending = deferred();
  const { journey, requests } = setup({ load: meta => meta.panoId === 'past-975' ? pending.promise : resource(meta) });
  await journey.start();
  const preparing = journey.prepareDestination('past');
  await ticks();
  assert.equal(journey.preparing, true);
  assert.equal(journey.prepared, null);
  assert.equal(journey.snapshot().destinationAheadReady, 2);
  assert.equal(journey.progress, 0.75);
  assert.equal(journey.beginTravel(), null);
  assert.deepEqual(requests.filter(item => item.meta.panoId.startsWith('past')).map(item => item.meta.panoId),
    ['past-750', 'past-825', 'past-900', 'past-975']);
  pending.resolve(resource(metadata('past', 975)));
  await preparing;
  assert.equal(journey.snapshot().prepared, true);
  assert.equal(journey.snapshot().destinationAheadReady, 3);
  assert.equal(journey.progress, 1);
  journey.dispose();
});

test('failed startup warming releases every newly loaded resource', async () => {
  const { journey, resources } = setup({ load: meta => {
    if (meta.panoId === 'present-150') throw new Error('Imagem indisponível.');
    return resource(meta);
  } });
  await assert.rejects(journey.start(), /Imagem indisponível/);
  assert.equal(journey.status, 'error');
  assert.equal(journey.current, null);
  assert.ok(resources.every(item => item.disposals === 1));
  journey.dispose();
});

test('failed destination warming keeps the origin usable and never arms a partial destination', async () => {
  const { journey, resources } = setup({ load: meta => {
    if (meta.panoId === 'past-900') throw new Error('Chegada incompleta.');
    return resource(meta);
  } });
  await journey.start();
  const source = journey.current;
  await assert.rejects(journey.prepareDestination('past'), /Chegada incompleta/);
  assert.equal(journey.current, source);
  assert.equal(journey.prepared, null);
  assert.equal(journey.snapshot().destinationAheadReady, 0);
  assert.equal(journey.snapshot().aheadReady, 3);
  assert.ok(resources.filter(item => item.metadata.panoId.startsWith('past')).every(item => item.disposals === 1));
  journey.dispose();
});

test('travels only at the exact portal and source photo, at 88 mph', async () => {
  const { journey, requests } = setup();
  await journey.start();
  await journey.prepareDestination('past');
  journey.speed = 90 * MS_PER_MPH;
  assert.equal(journey.canTravel(), false);
  assert.equal(journey.beginTravel(), null);
  await drive(journey, () => journey.status === 'departure');
  assert.equal(journey.s, 750);
  assert.equal(journey.current.metadata.panoId, 'present-750');
  assert.equal(journey.speedMph, 88);
  assert.ok(Math.abs(journey.speedKmh - 141.622272) < 1e-9);
  assert.equal(journey.snapshot().movementPaused, true);
  assert.equal(Object.isFrozen(journey.travelSnapshot), true);
  assert.ok(!requests.some(item => item.meta.panoId === 'present-825'));
  journey.dispose();
});

test('commit transfers the preview and warmed pool with no requests; arrival remains inert', async () => {
  const { journey, requests } = setup();
  await journey.start();
  const preview = await journey.prepareDestination('past');
  await drive(journey, () => journey.status === 'departure');
  const count = requests.length, source = journey.current, snapshot = journey.travelSnapshot;
  const preparedAfter = [...snapshot.ahead.values()].map(entry => entry.resource);
  assert.equal(preparedAfter.length, 3);
  assert.equal(journey.commitTravel({ ...snapshot }), false);
  assert.equal(journey.commitTravel(snapshot), true);
  assert.equal(requests.length, count);
  assert.equal(journey.current, preview);
  assert.deepEqual([...journey._ahead.values()].map(entry => entry.resource), preparedAfter);
  assert.equal(journey.epoch, 'past');
  assert.equal(journey.s, 750);
  assert.equal(journey.speedMph, 88);
  assert.equal(source.disposals, 0);
  assert.equal(journey.snapshot().movementPaused, true);
  journey.update(1, { throttle: 1 });
  assert.equal(requests.length, count);
  journey.finishArrival();
  assert.equal(source.disposals, 1);
  assert.equal(requests.length, count, 'the first three arrival views were already prepared');
  assert.equal(journey.commitTravel(snapshot), false);
  journey.dispose();
});

test('a late destination cannot let the car pass the portal', async () => {
  const pending = deferred();
  const { journey } = setup({ lookaheadCount: 0, load: meta => meta.panoId === 'past-750' ? pending.promise : resource(meta) });
  await journey.start();
  const preparing = journey.prepareDestination('past');
  await drive(journey, () => journey.needsRestart);
  assert.equal(journey.s, 750);
  assert.equal(journey.speedMph, 0);
  for (let i = 0; i < 20; i++) journey.update(0.1, { throttle: 1 });
  assert.equal(journey.s, 750);
  pending.resolve(resource(metadata('past', 750)));
  await preparing;
  assert.equal(journey.beginTravel(), null);
  await journey.restart();
  assert.equal(journey.s, 0);
  assert.equal(journey.needsRestart, false);
  journey.dispose();
});

test('buffering stops movement without falsifying the conserved physical velocity', async () => {
  const pending = deferred();
  const { journey } = setup({ lookaheadCount: 0, load: meta => meta.panoId === 'present-75' ? pending.promise : resource(meta) });
  await journey.start();
  const old = journey.current;
  await drive(journey, () => journey.buffering);
  const speed = journey.speed;
  assert.equal(journey.s, 75);
  assert.ok(speed > 0);
  assert.equal(journey.snapshot().movementPaused, true);
  for (let i = 0; i < 50; i++) journey.update(0.1, { throttle: 1 });
  assert.equal(journey.s, 75);
  assert.equal(journey.speed, speed);
  assert.equal(journey.current, old);
  pending.resolve(resource(metadata('present', 75)));
  await ticks();
  assert.equal(journey.buffering, false);
  assert.equal(journey.snapshot().movementPaused, false);
  assert.equal(journey.current.metadata.panoId, 'present-75');
  assert.equal(old.disposals, 1);
  journey.dispose();
});

test('stale destination responses are released and cannot replace a newer preview', async () => {
  const pending = [deferred(), deferred()]; let request = 0;
  const { journey } = setup({ lookaheadCount: 0, load: meta => meta.panoId === 'past-750' ? pending[request++].promise : resource(meta) });
  await journey.start();
  const first = journey.prepareDestination('past'), second = journey.prepareDestination('past');
  const newer = resource(metadata('past', 750)), older = resource(metadata('past', 750));
  pending[1].resolve(newer); await second;
  pending[0].resolve(older); await first;
  assert.equal(journey.prepared, newer);
  assert.equal(older.disposals, 1);
  assert.equal(newer.disposals, 0);
  journey.dispose();
});

test('restarting cancels destination warming and releases its portal and late pool entries', async () => {
  const pending = deferred();
  const { journey, requests, resources } = setup({ load: meta => meta.panoId === 'past-825' ? pending.promise : resource(meta) });
  await journey.start();
  const preparing = journey.prepareDestination('past');
  await ticks();
  const request = requests.find(item => item.meta.panoId === 'past-825');
  await journey.restart();
  assert.equal(request.options.signal.aborted, true);
  const late = resource(metadata('past', 825));
  pending.resolve(late);
  await preparing;
  assert.equal(late.disposals, 1);
  assert.ok(resources.filter(item => item.metadata.panoId.startsWith('past')).every(item => item.disposals === 1));
  assert.equal(journey.prepared, null);
  assert.equal(journey.snapshot().aheadReady, 3);
  journey.dispose();
});

test('restart invalidates a captured travel and unready destinations are rejected', async () => {
  const { journey } = setup();
  await journey.start();
  await journey.prepareDestination('past');
  await drive(journey, () => journey.status === 'departure');
  const oldSnapshot = journey.travelSnapshot;
  await journey.restart();
  assert.equal(journey.commitTravel(oldSnapshot), false);
  assert.equal(journey.epoch, 'present');
  assert.equal(journey.s, 0);
  const unready = { ...resource(metadata('past', 750)), ready: false };
  journey.loadPanorama = async () => unready;
  await assert.rejects(journey.prepareDestination('past'), /ainda não está pronto/);
  assert.equal(journey.snapshot().prepared, false);
  assert.equal(unready.disposals, 1);
  journey.dispose();
});

test('failed later warming stops at its image boundary without retry loops', async () => {
  const { journey, requests } = setup({ load: meta => {
    if (meta.panoId === 'present-300') throw new Error('Rede indisponível.');
    return resource(meta);
  } });
  await journey.start();
  await drive(journey, () => !!journey.error);
  assert.equal(journey.s, 300);
  assert.equal(journey.current.metadata.panoId, 'present-225');
  assert.equal(journey.speedMph, 0);
  const count = requests.length;
  for (let i = 0; i < 20; i++) journey.update(0.1, { throttle: 1 });
  assert.equal(requests.length, count);
  journey.dispose();
});

test('each adopted view replenishes one slot and keeps at most eight live prepared views', async () => {
  const { journey, requests, resources } = setup();
  await journey.start();
  await journey.prepareDestination('past');
  assert.equal(resources.filter(item => item.disposals === 0).length, 8);
  assert.equal(requests.length, 8);
  const count = requests.length;
  await drive(journey, () => journey.current.metadata.panoId === 'present-75');
  assert.equal(requests.length, count + 1);
  assert.equal(requests.at(-1).meta.panoId, 'present-300');
  assert.ok(resources.filter(item => item.disposals === 0).length <= 8);
  await ticks();
  assert.equal(requests.length, count + 1, 'completion alone must never trigger a route-wide cascade');
  assert.equal(journey.snapshot().aheadReady, 3);
  journey.dispose();
});

test('six driving views and three arrival views stay bounded and commit without new work', async () => {
  const { journey, requests, resources } = setup({
    lookaheadCount: 6, destinationLookaheadCount: 3, track: route({ gap: 30 }),
  });
  await journey.start();
  assert.equal(journey.snapshot().aheadReady, 6);
  assert.deepEqual(requests.map(item => item.meta.panoId),
    [0, 30, 60, 90, 120, 150, 180].map(s => 'present-' + s));
  const preview = await journey.prepareDestination('past');
  assert.equal(journey.snapshot().destinationAheadReady, 3);
  assert.equal(journey.progress, 1);
  assert.equal(requests.length, 11);
  assert.equal(resources.filter(item => !item.disposals).length, 11);
  await drive(journey, () => {
    assert.ok(resources.filter(item => !item.disposals).length <= 11);
    return journey.status === 'departure';
  });
  const count = requests.length, source = journey.current;
  const preparedAfter = [...journey.travelSnapshot.ahead.values()].map(entry => entry.resource);
  assert.equal(journey.commitTravel(), true);
  assert.equal(journey.current, preview);
  assert.equal(requests.length, count);
  assert.deepEqual([...journey._ahead.values()].map(entry => entry.resource), preparedAfter);
  assert.equal(journey.snapshot().aheadReady, 3);
  journey.update(.25, { throttle: 1 });
  await ticks();
  assert.equal(requests.length, count, 'arrival must not refill before finishArrival');
  journey.finishArrival();
  assert.equal(source.disposals, 1);
  assert.equal(requests.length, count + 3);
  assert.deepEqual(requests.slice(count).map(item => item.meta.panoId), ['past-870', 'past-900', 'past-930']);
  await ticks();
  assert.equal(journey.snapshot().aheadReady, 6);
  assert.ok(resources.filter(item => !item.disposals).length <= 7);
  journey.dispose();
  assert.ok(resources.every(item => item.disposals === 1));
});

test('the destination inherits six-view lookahead when no separate count is selected', async () => {
  const { journey, requests, resources } = setup({ lookaheadCount: 6, track: route({ gap: 30 }) });
  await journey.start();
  await journey.prepareDestination('past');
  assert.equal(journey.snapshot().aheadReady, 6);
  assert.equal(journey.snapshot().destinationAheadReady, 6);
  assert.equal(requests.length, 14);
  journey.dispose();
  assert.ok(resources.every(item => item.disposals === 1));
});

test('ready boundaries preserve the remainder of the integrated displacement', async () => {
  const { journey } = setup();
  await journey.start();
  await journey.prepareDestination('past');
  journey.s = 74;
  journey.speed = 88 * MS_PER_MPH;
  const speed = journey.speed, old = journey.current;
  journey.update(0.1, { throttle: holdSpeedThrottle(speed) });
  assert.ok(Math.abs(journey.s - (74 + speed * 0.1)) < 1e-9);
  assert.equal(journey.current.metadata.panoId, 'present-75');
  assert.equal(journey.buffering, false);
  assert.equal(old.disposals, 1);
  journey.dispose();
});

test('one frame may cross ready nodes, but never passes an image that is not prepared', async () => {
  const pending = deferred();
  const track = route({ gap: 1, portalS: 100, length: 200 });
  const { journey } = setup({ track, load: meta => meta.panoId === 'present-4' ? pending.promise : resource(meta) });
  await journey.start();
  await journey.prepareDestination('past');
  journey.speed = 40;
  journey.update(0.25, { throttle: holdSpeedThrottle(40) });
  assert.equal(journey.s, 4);
  assert.equal(journey.current.metadata.panoId, 'present-3');
  assert.equal(journey.buffering, true);
  pending.resolve(resource(metadata('present', 4)));
  await ticks();
  assert.equal(journey.current.metadata.panoId, 'present-4');
  journey.dispose();
});

test('constant velocity covers the same real distance at 4, 10, 20 and 60 FPS across dense photographs', async () => {
  const speed = 88 * MS_PER_MPH;
  for (const gap of [5, 30]) for (const fps of [4, 10, 20, 60]) {
    const { journey } = setup({ track: route({ gap, portalS: 1000, length: 2000 }) });
    await journey.start();
    await journey.prepareDestination('past');
    journey.speed = speed;
    for (let frame = 0; frame < 10 * fps; frame++) {
      journey.update(1 / fps, { throttle: holdSpeedThrottle(speed) });
      await ticks();
      assert.equal(journey.buffering, false, 'ready pool should cover each frame');
    }
    assert.ok(Math.abs(journey.s - speed * 10) < 1e-6, JSON.stringify({ gap, fps, s: journey.s }));
    assert.ok(Math.abs(journey.speedKmh - 141.622272) < 1e-9);
    journey.dispose();
  }
});

test('acceleration is measured in seconds/metres and reaches 100 km/h gradually, around nineteen seconds', async () => {
  const { journey } = setup({ track: route({ portalS: 1000, length: 2000 }) });
  await journey.start();
  await journey.prepareDestination('past');
  let seconds = 0, time100 = null;
  while (journey.speedMph < 88 && seconds < 45) {
    journey.update(1 / 120, { throttle: 1 });
    await ticks();
    seconds += 1 / 120;
    if (time100 === null && journey.speedKmh >= 100) time100 = seconds;
  }
  assert.ok(time100 > 18 && time100 < 19.2, String(time100));
  assert.ok(seconds > 30 && seconds < 32, String(seconds));
  assert.ok(journey.s > 680 && journey.s < 710, String(journey.s));
  journey.dispose();
});

test('full throttle is governed at exactly 88 mph and the jump happens at 88 mph', async () => {
  const { journey } = setup({ track: route({ portalS: 1000, length: 2000 }) });
  await journey.start();
  await journey.prepareDestination('past');
  let seconds = 0, topMph = 0;
  while (journey.status === 'driving' && seconds < 60) {
    journey.update(1 / 120, { throttle: 1 });
    await ticks();
    seconds += 1 / 120;
    if (journey.status === 'driving') topMph = Math.max(topMph, journey.speedMph);
  }
  assert.equal(journey.status, 'departure');
  assert.equal(topMph, 88);
  assert.equal(journey.speedMph, 88);
  assert.ok(Math.abs(journey.s - 1000) < 1e-6, String(journey.s));
  journey.dispose();
});

test('service braking stops 88 mph gradually without reverse or creep', async () => {
  const { journey } = setup({ track: route({ portalS: 1000, length: 2000 }) });
  await journey.start();
  await journey.prepareDestination('past');
  journey.speed = 88 * MS_PER_MPH;
  let seconds = 0;
  while (journey.speed > 0 && seconds < 10) {
    journey.update(1 / 60, { brake: 1 });
    await ticks(); seconds += 1 / 60;
  }
  assert.ok(seconds > 4 && seconds < 6, String(seconds));
  assert.ok(journey.s > 85 && journey.s < 110, String(journey.s));
  assert.equal(journey.speed, 0);
  const stopped = journey.s;
  for (let i = 0; i < 60; i++) journey.update(1 / 60, { brake: 1 });
  assert.equal(journey.s, stopped);
  assert.equal(journey.speedKmh, 0);
  journey.dispose();
});

test('a long suspended browser interval is bounded to 250 ms of physics', async () => {
  const { journey } = setup();
  await journey.start();
  await journey.prepareDestination('past');
  journey.speed = 10;
  journey.update(10, { throttle: holdSpeedThrottle(10) });
  assert.ok(Math.abs(journey.s - 2.5) < 1e-9);
  journey.dispose();
});

test('repeated round trips release every resource exactly once', async () => {
  const { journey, resources } = setup();
  await journey.start();
  for (const destination of ['past', 'present', 'past', 'present']) {
    await journey.prepareDestination(destination);
    await drive(journey, () => journey.status === 'departure');
    journey.commitTravel();
    journey.finishArrival();
    await drive(journey, () => journey.status === 'finished');
    assert.equal(journey.s, 1500);
    assert.equal(journey.speedMph, 0);
    await journey.restart();
  }
  journey.dispose(); journey.dispose();
  assert.ok(resources.every(item => item.disposals === 1));
});

for (const action of ['restart', 'change-epoch', 'dispose']) {
  test(action + ' cancels a replenishing pool and releases stale completion', async () => {
    const pending = deferred();
    const { journey, requests } = setup({ load: meta => meta.panoId === 'present-300' ? pending.promise : resource(meta) });
    await journey.start();
    await drive(journey, () => journey.current.metadata.panoId === 'present-75');
    const request = requests.find(item => item.meta.panoId === 'present-300');
    if (action === 'restart') await journey.restart();
    else if (action === 'change-epoch') await journey.start('past');
    else journey.dispose();
    assert.equal(request.options.signal.aborted, true);
    const stale = resource(metadata('present', 300));
    pending.resolve(stale);
    await ticks();
    assert.equal(stale.disposals, 1);
    assert.equal(journey.current?.metadata.panoId ?? null,
      action === 'dispose' ? null : action === 'change-epoch' ? 'past-0' : 'present-0');
    journey.dispose();
  });
}

test('disposing while the initial pool warms also releases the not-yet-activated source', async () => {
  const pending = deferred();
  const { journey, resources } = setup({ load: meta => meta.panoId === 'present-75' ? pending.promise : resource(meta) });
  const starting = journey.start();
  await ticks();
  journey.dispose();
  pending.resolve(resource(metadata('present', 75)));
  await starting;
  assert.equal(journey.current, null);
  assert.ok(resources.every(item => item.disposals === 1));
});

test('a stronger engine reaches cruising speed sooner on short streets', async () => {
  async function distanceTo(mph, acceleration) {
    const journey = new StreetJourney({ route: route({ portalS: 1400, length: 1500 }), loadPanorama: async meta => resource(meta), acceleration });
    await journey.start();
    await drive(journey, () => journey.speed >= mph * MS_PER_MPH);
    const s = journey.s;
    journey.dispose();
    return s;
  }
  // Unarmed the car is capped just below 88 mph, so compare at 85 mph.
  const standard = await distanceTo(85, 2.0), arleta = await distanceTo(85, 2.8);
  assert.ok(standard > 550, `standard ${standard}`);
  assert.ok(arleta < 400, `arleta ${arleta}`);
  assert.equal(new StreetJourney({ route: route(), loadPanorama: async m => resource(m), acceleration: -1 }).acceleration, 2.0);
});

test('after the jump a short street eases to a stop at its end instead of hitting it at 88 mph', async () => {
  const { journey } = setup({ track: route({ gap: 20, portalS: 750, length: 830 }) });
  await journey.start();
  await journey.prepareDestination('past');
  await drive(journey, () => journey.status === 'departure');
  assert.equal(journey.commitTravel(journey.travelSnapshot), true);
  journey.finishArrival();
  let previous = journey.speed, steps = 0, hardest = 0;
  while (journey.status !== 'finished' && steps++ < 6000) {
    journey.update(1 / 120, { throttle: 1 });
    await ticks();
    if (journey.movementPaused) continue;
    if (journey.status !== 'finished' && journey.speed > 2) hardest = Math.max(hardest, (previous - journey.speed) * 120);
    previous = journey.speed;
  }
  assert.ok(hardest < 12, `braking peaked at ${hardest} m/s²`);
  assert.equal(journey.status, 'finished');
  assert.ok(previous < 2, `ends almost stopped, not at ${previous} m/s`);
  journey.dispose();
});
