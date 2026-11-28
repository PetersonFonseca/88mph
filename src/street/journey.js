const MPH_TO_MS = 0.44704;
const TRAVEL_MPH = 88;
const EPSILON = 0.001;
const STEP_SECONDS = 1 / 120;
const MAX_FRAME_SECONDS = 0.25;
// Gentle enough to dose the throttle: ~31 s and ~700 m to 88 mph, still well
// before the ~1 km portal.
const ACCELERATION = 2.0;
const BRAKING = 7.5;
// After the jump the car eases to a stop at the end of the route instead of
// hitting it at speed; short streets (Arleta: ~80 m after the portal) need this.
const END_BRAKING = 10;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function progressValue(value) {
  if (typeof value === 'number') return clamp(value, 0, 1);
  if (Number.isFinite(value?.progress)) return clamp(value.progress, 0, 1);
  if (value?.total > 0) return clamp(value.loaded / value.total, 0, 1);
  return 0;
}

/** Guided metres/second physics and bounded, GPU-ready panorama ownership. */
export class StreetJourney {
  constructor({ route, loadPanorama, onChange = () => {}, lookaheadCount = 3, destinationLookaheadCount = lookaheadCount, acceleration = ACCELERATION }) {
    // Short streets need a stronger engine to reach 88 mph before the portal.
    this.acceleration = Number.isFinite(acceleration) && acceleration > 0 ? acceleration : ACCELERATION;
    if (!route?.epochs || !route.portal || typeof loadPanorama !== 'function') {
      throw new Error('Percurso ou carregador de panoramas inválido.');
    }
    this.route = route;
    this.loadPanorama = loadPanorama;
    this.onChange = onChange;
    this.lookaheadCount = Number.isInteger(lookaheadCount) ? clamp(lookaheadCount, 0, 6) : 3;
    this.destinationLookaheadCount = Number.isInteger(destinationLookaheadCount)
      ? clamp(destinationLookaheadCount, 0, 6) : this.lookaheadCount;
    this.status = 'idle';
    this.epoch = 'present';
    this.destinationEpoch = null;
    this.s = 0;
    this.speed = 0;
    this.current = null;
    this.prepared = null;
    this.preparing = false;
    this.buffering = false;
    this.error = '';
    this.progress = 0;
    this.loadingProgress = 0;
    this.needsRestart = false;
    this.travelSnapshot = null;
    this._runVersion = 0;
    this._destinationVersion = 0;
    this._currentIndex = 0;
    this._streamFailure = false;
    this._ahead = new Map();
    this._destinationAhead = new Map();
    this._crossedPortal = false;
    this._disposed = false;
    this._released = new WeakSet();
    this._nodes = new Map();
    for (const epoch of Object.keys(route.epochs)) {
      const nodes = route.epochs[epoch].nodes
        .filter(node => node.s >= 0 && node.s <= route.length && Math.abs(node.s - route.portalS) > EPSILON)
        .map(node => ({ ...node }));
      nodes.push({ s: route.portalS, metadata: route.portal[epoch] });
      nodes.sort((a, b) => a.s - b.s);
      if (!nodes.length || nodes.some(node => !node.metadata)) throw new Error('Percurso sem imagens válidas.');
      this._nodes.set(epoch, nodes);
    }
  }

  get speedMph() { return this.speed / MPH_TO_MS; }
  get speedKmh() { return this.speed * 3.6; }
  get movementPaused() {
    return this.status !== 'driving' || this.buffering || this._streamFailure || this.needsRestart;
  }

  snapshot() {
    return {
      status: this.status, epoch: this.epoch, destinationEpoch: this.destinationEpoch,
      s: this.s, speedMph: this.speedMph, speedKmh: this.speedKmh, movementPaused: this.movementPaused,
      prepared: !!this.prepared?.ready, preparing: this.preparing, buffering: this.buffering, error: this.error,
      progress: this.progress, loadingProgress: this.loadingProgress,
      aheadReady: [...this._ahead.values()].filter(entry => entry.resource?.ready).length,
      destinationAheadReady: [...this._destinationAhead.values()].filter(entry => entry.resource?.ready).length,
      ended: this.status === 'finished', needsRestart: this.needsRestart,
      portalS: this.route.portalS, length: this.route.length,
    };
  }

  _emit() { if (!this._disposed) this.onChange(this.snapshot()); }

  _release(resource) {
    if (!resource || this._released.has(resource)) return;
    this._released.add(resource);
    resource.dispose();
  }

  _assertReady(resource) {
    if (!resource || resource.ready !== true || typeof resource.dispose !== 'function') {
      this._release(resource?.dispose ? resource : null);
      throw new Error('O panorama ainda não está pronto para exibição.');
    }
    return resource;
  }

  _cancelPool(pool) {
    for (const entry of pool.values()) {
      entry.abort.abort();
      this._release(entry.resource);
      entry.resource = null;
    }
    pool.clear();
  }

  _cancelDestination() {
    this._destinationVersion++;
    this._destinationAbort?.abort();
    this._cancelPool(this._destinationAhead);
    this._destinationAhead = new Map();
    this._destinationAbort = null;
    this._release(this.prepared);
    this.prepared = null;
    this.preparing = false;
    this.destinationEpoch = null;
    this.progress = 0;
  }

  _entryActive(entry) {
    return !this._disposed && !entry.abort.signal.aborted &&
      entry.runVersion === this._runVersion &&
      (entry.scope === 'current'
        ? entry.pool === this._ahead && entry.pool.get(entry.index) === entry
        : entry.pool === this._destinationAhead && entry.pool.get(entry.index) === entry &&
          entry.version === this._destinationVersion);
  }

  _queueAhead(pool, index, epoch, scope) {
    if (pool.has(index)) return pool.get(index);
    const entry = {
      pool, index, epoch, scope, runVersion: this._runVersion, version: this._destinationVersion,
      abort: new AbortController(), resource: null, error: null, progress: 0, promise: null,
    };
    pool.set(index, entry);
    entry.promise = this._loadAhead(entry);
    return entry;
  }

  async _loadAhead(entry) {
    try {
      const node = this._nodes.get(entry.epoch)[entry.index];
      const resource = await this.loadPanorama(node.metadata, {
        signal: entry.abort.signal,
        onProgress: value => {
          if (!this._entryActive(entry)) return;
          entry.progress = progressValue(value);
          if (entry.scope === 'destination') this._destinationProgress();
          else if (this.buffering) {
            this.loadingProgress = entry.progress;
            this._emit();
          }
        },
      });
      if (!this._entryActive(entry)) { this._release(resource); return; }
      entry.resource = this._assertReady(resource);
      entry.progress = 1;
      if (entry.scope === 'destination') this._destinationProgress();
      else if (this.status === 'driving' && this.buffering &&
        entry.index === this._currentIndex + 1 && this.s >= node.s - EPSILON) this._adoptAhead(entry);
    } catch (error) {
      if (!this._entryActive(entry)) return;
      entry.error = error;
      if (entry.scope === 'current' && this.status === 'driving' && this.buffering &&
        entry.index === this._currentIndex + 1) this._failAhead(entry);
    }
  }

  _aheadIndices(epoch, index, afterPortal, count = this.lookaheadCount) {
    const nodes = this._nodes.get(epoch), indices = [];
    for (let next = index + 1; next < nodes.length && indices.length < count; next++) {
      if (!afterPortal && nodes[next].s > this.route.portalS + EPSILON) break;
      indices.push(next);
    }
    return indices;
  }

  async _warmAhead(pool, epoch, index, scope, afterPortal, count = this.lookaheadCount) {
    const entries = this._aheadIndices(epoch, index, afterPortal, count)
      .map(next => this._queueAhead(pool, next, epoch, scope));
    await Promise.all(entries.map(entry => entry.promise));
    for (const entry of entries) {
      if (!this._entryActive(entry)) return false;
      if (entry.error) throw entry.error;
      this._assertReady(entry.resource);
    }
    return true;
  }

  _refillAhead() {
    if (this._disposed || this.status !== 'driving' || this._streamFailure || this.needsRestart) return;
    const indices = this._aheadIndices(this.epoch, this._currentIndex, this._crossedPortal);
    for (const [index, entry] of this._ahead) if (!indices.includes(index)) {
      entry.abort.abort(); this._release(entry.resource); this._ahead.delete(index);
    }
    for (const index of indices) this._queueAhead(this._ahead, index, this.epoch, 'current');
  }

  _destinationProgress() {
    if (!this.preparing) return;
    const entries = [...this._destinationAhead.values()];
    this.progress = (this._destinationImageProgress + entries.reduce((sum, entry) => sum + entry.progress, 0)) /
      (1 + this._destinationExpectedCount);
    this._emit();
  }

  async start(epoch = 'present') {
    if (this._disposed) throw new Error('A viagem já foi encerrada.');
    if (!this._nodes.has(epoch)) throw new Error('Acervo indisponível para este percurso.');
    const version = ++this._runVersion;
    this._currentAbort?.abort();
    this._cancelPool(this._ahead);
    this._ahead = new Map();
    this._cancelDestination();
    this._release(this._arrivalSource);
    this._arrivalSource = null;
    this.travelSnapshot = null;
    this.speed = 0;
    this.status = 'idle';
    this.buffering = true;
    this.loadingProgress = 0;
    this.error = '';
    this.needsRestart = false;
    this._streamFailure = false;
    const abort = new AbortController();
    this._currentAbort = abort;
    let resource = null;
    this._emit();
    try {
      resource = await this.loadPanorama(this._nodes.get(epoch)[0].metadata, {
        signal: abort.signal,
        onProgress: value => {
          if (version !== this._runVersion || this._disposed) return;
          this.loadingProgress = progressValue(value);
          this._emit();
        },
      });
      if (version !== this._runVersion || this._disposed) { this._release(resource); return null; }
      this._assertReady(resource);
      await this._warmAhead(this._ahead, epoch, 0, 'current', false);
      if (version !== this._runVersion || this._disposed) { this._release(resource); return null; }
      this._release(this.current);
      this.current = resource;
      this.epoch = epoch;
      this.s = 0;
      this._currentIndex = 0;
      this._crossedPortal = false;
      this.status = 'driving';
      this.buffering = false;
      this.loadingProgress = 1;
      this._currentAbort = null;
      this._emit();
      return resource;
    } catch (error) {
      this._release(resource);
      if (version !== this._runVersion || this._disposed) return null;
      this._cancelPool(this._ahead);
      this.buffering = false;
      this.status = 'error';
      this.error = error.message || 'Não foi possível abrir o percurso.';
      this._emit();
      throw error;
    }
  }

  async prepareDestination(epoch) {
    if (this._disposed || this.status !== 'driving' || this.speedMph >= 2 || this._crossedPortal || this.needsRestart) {
      throw new Error('Pare o carro antes do ponto de salto para preparar o destino.');
    }
    if (!this._nodes.has(epoch) || epoch === this.epoch) throw new Error('Escolha a outra época para viajar.');
    this._cancelDestination();
    const version = this._destinationVersion, runVersion = this._runVersion;
    const abort = new AbortController();
    this._destinationAbort = abort;
    this.destinationEpoch = epoch;
    this.preparing = true;
    this.error = '';
    this._destinationImageProgress = 0;
    const portalIndex = this._nodes.get(epoch).findIndex(node => Math.abs(node.s - this.route.portalS) <= EPSILON);
    this._destinationExpectedCount = this._aheadIndices(epoch, portalIndex, true, this.destinationLookaheadCount).length;
    let resource = null;
    this._emit();
    try {
      resource = await this.loadPanorama(this.route.portal[epoch], {
        signal: abort.signal,
        onProgress: value => {
          if (version !== this._destinationVersion || runVersion !== this._runVersion || this._disposed) return;
          this._destinationImageProgress = progressValue(value);
          this._destinationProgress();
        },
      });
      if (version !== this._destinationVersion || runVersion !== this._runVersion || this._disposed) {
        this._release(resource); return null;
      }
      this._assertReady(resource);
      this._destinationImageProgress = 1;
      await this._warmAhead(this._destinationAhead, epoch, portalIndex, 'destination', true, this.destinationLookaheadCount);
      if (version !== this._destinationVersion || runVersion !== this._runVersion || this._disposed) {
        this._release(resource); return null;
      }
      this.prepared = resource;
      this.preparing = false;
      this.progress = 1;
      this._destinationAbort = null;
      this._emit();
      return resource;
    } catch (error) {
      this._release(resource);
      if (version !== this._destinationVersion || runVersion !== this._runVersion || this._disposed) return null;
      this._cancelPool(this._destinationAhead);
      this.preparing = false;
      this.error = error.message || 'Não foi possível preparar a chegada.';
      this._emit();
      throw error;
    }
  }

  _adoptAhead(entry) {
    if (!this._entryActive(entry) || !entry.resource?.ready) return false;
    const previous = this.current;
    this.current = entry.resource;
    entry.resource = null;
    this._ahead.delete(entry.index);
    this._currentIndex = entry.index;
    this.buffering = false;
    this.loadingProgress = 1;
    this._release(previous);
    this._refillAhead();
    this._emit();
    return true;
  }

  _failAhead(entry) {
    this.buffering = false;
    this.speed = 0;
    this._streamFailure = true;
    this.error = entry.error?.message || 'Não foi possível carregar o próximo trecho. Reinicie a aproximação.';
    this._emit();
  }

  _waitForAhead(index) {
    // Count=0 is supported for constrained devices/tests; the reached image
    // still loads on demand, and motion cannot go beyond its position.
    const entry = this._queueAhead(this._ahead, index, this.epoch, 'current');
    if (this._adoptAhead(entry)) return true;
    if (entry.error) { this._failAhead(entry); return false; }
    this.buffering = true;
    this.loadingProgress = entry.progress;
    this._emit();
    return false;
  }

  canTravel() {
    return !this._disposed && this.status === 'driving' && !this.buffering && !this._crossedPortal &&
      !this.needsRestart && Math.abs(this.s - this.route.portalS) <= EPSILON &&
      this.speedMph >= TRAVEL_MPH - EPSILON && !!this.prepared?.ready &&
      [...this._destinationAhead.values()].every(entry => entry.resource?.ready) &&
      this.current?.metadata?.panoId === this.route.portal[this.epoch].panoId;
  }

  beginTravel() {
    if (!this.canTravel()) return null;
    this.speed = TRAVEL_MPH * MPH_TO_MS;
    this.travelSnapshot = Object.freeze({
      revision: this._destinationVersion, runVersion: this._runVersion,
      sourceEpoch: this.epoch, targetEpoch: this.destinationEpoch,
      resource: this.prepared, ahead: this._destinationAhead, portalS: this.route.portalS,
    });
    this.status = 'departure';
    this._emit();
    return this.travelSnapshot;
  }

  /** Transfer the ready source/destination pools without async or GPU work. */
  commitTravel(snapshot = this.travelSnapshot) {
    if (this._disposed || this.status !== 'departure' || snapshot !== this.travelSnapshot ||
      snapshot.revision !== this._destinationVersion || snapshot.runVersion !== this._runVersion ||
      snapshot.resource !== this.prepared || !snapshot.resource.ready ||
      snapshot.ahead !== this._destinationAhead ||
      ![...snapshot.ahead.values()].every(entry => entry.resource?.ready)) return false;
    this._runVersion++;
    this._currentAbort?.abort();
    this._currentAbort = null;
    this._cancelPool(this._ahead);
    this._ahead = snapshot.ahead;
    this._destinationAhead = new Map();
    for (const entry of this._ahead.values()) {
      entry.scope = 'current'; entry.runVersion = this._runVersion;
    }
    this._arrivalSource = this.current;
    this.current = snapshot.resource;
    this.prepared = null;
    this.epoch = snapshot.targetEpoch;
    this.destinationEpoch = null;
    this.s = snapshot.portalS;
    this.speed = TRAVEL_MPH * MPH_TO_MS;
    this._currentIndex = this._nodes.get(this.epoch).findIndex(node => Math.abs(node.s - this.s) <= EPSILON);
    this._crossedPortal = true;
    this.preparing = this.buffering = false;
    this.status = 'arrival';
    this._emit();
    return true;
  }

  finishArrival() {
    if (this._disposed || this.status !== 'arrival') return false;
    this._release(this._arrivalSource);
    this._arrivalSource = null;
    this.travelSnapshot = null;
    this.status = 'driving';
    this._refillAhead();
    this._emit();
    return true;
  }

  _reachPortal() {
    if (this.beginTravel()) return;
    this.speed = 0;
    this.needsRestart = true;
    this.error = 'O salto exige 88 mph e uma chegada pronta. Reinicie a aproximação.';
    this._emit();
  }

  _advanceDistance(distance) {
    const nodes = this._nodes.get(this.epoch);
    while (distance > 1e-9 && !this.movementPaused) {
      const nextIndex = this._currentIndex + 1, nextNode = nodes[nextIndex];
      const boundary = Math.min(nextNode?.s ?? this.route.length, this._crossedPortal ? this.route.length : this.route.portalS);
      const toBoundary = Math.max(0, boundary - this.s);
      if (distance < toBoundary) { this.s += distance; return; }
      this.s = boundary;
      distance -= toBoundary;
      if (nextNode && Math.abs(this.s - nextNode.s) <= EPSILON) {
        if (nextNode.metadata.panoId === this.current?.metadata?.panoId) {
          this._currentIndex = nextIndex; this._refillAhead();
        } else if (!this._waitForAhead(nextIndex)) return;
      }
      if (!this._crossedPortal && this.s >= this.route.portalS - EPSILON) {
        this._reachPortal(); return;
      }
      if (this.s >= this.route.length - EPSILON) {
        this.s = this.route.length;
        this.speed = 0;
        this.status = 'finished';
        this._emit();
        return;
      }
      // Continue with the remaining metres in this physics step. Ready image
      // boundaries must not throw away distance or depend on render frame rate.
    }
  }

  update(dt, { throttle = 0, brake = 0 } = {}) {
    if (this._disposed || this.movementPaused || !Number.isFinite(dt) || dt <= 0) return;
    if (!this._crossedPortal && this.s >= this.route.portalS - EPSILON) {
      this._reachPortal(); return;
    }
    throttle = clamp(Number(throttle) || 0, 0, 1);
    brake = clamp(Number(brake) || 0, 0, 1);
    this._refillAhead();
    let remaining = Math.min(dt, MAX_FRAME_SECONDS);
    while (remaining > 1e-9 && !this.movementPaused) {
      const step = Math.min(remaining, STEP_SECONDS), previous = this.speed;
      const drag = 0.2 + previous * 0.015 + previous ** 2 * 0.0003;
      // Before the portal the car is governed at exactly 88 mph once armed, so
      // the jump always happens at 88.0 mph instead of whatever top speed the
      // approach reached. Unarmed it stays just below, keeping the portal shut.
      const capMph = this._crossedPortal ? 104 : this.prepared?.ready ? TRAVEL_MPH : TRAVEL_MPH - 1;
      this.speed = clamp(previous + (this.acceleration * throttle - drag - BRAKING * brake) * step, 0, capMph * MPH_TO_MS);
      if (this._crossedPortal) this.speed = Math.min(this.speed, Math.sqrt(2 * END_BRAKING * Math.max(0, this.route.length - this.s)));
      this._advanceDistance((previous + this.speed) * 0.5 * step);
      remaining -= step;
    }
  }

  restart() { return this.start(this.epoch); }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._runVersion++;
    this._currentAbort?.abort();
    this._cancelPool(this._ahead);
    this._cancelDestination();
    this._release(this.current);
    this._release(this._arrivalSource);
    this.current = this._arrivalSource = null;
    this.travelSnapshot = null;
    this.speed = 0;
    this.buffering = false;
    this.status = 'idle';
  }
}
