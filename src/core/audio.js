const soundtrackUrl = new URL('../../instrumental.m4a', import.meta.url).href;

/** Soundtrack supports autoplay where allowed; effects unlock on interaction. */
export class AudioSystem {
  constructor() {
    this.context = null;
    this.muted = false;
    this.era = 'present';
    this.time = 0;
    this.stepClock = 0;
    this.ambientClock = 0;
    this.musicStep = 0;
    this.nodes = [];
    this.voices = new Set();
    this.paused = false;
    this.surface = 'road';
    this.soundtrack = new Audio(soundtrackUrl);
    this.soundtrack.loop = true;
    this.soundtrack.preload = 'metadata';
    this.soundtrack.volume = 0.35;
    this.soundtrackReady = false;
    this.soundtrackRequested = false;
    this.soundtrack.addEventListener('loadedmetadata', () => {
      // An incomplete file must never become a rapid, repeating click.
      this.soundtrackReady = Number.isFinite(this.soundtrack.duration) && this.soundtrack.duration >= 10;
      if (this.soundtrackRequested) this.startSoundtrack();
    });
  }

  startSoundtrack() {
    this.soundtrackRequested = true;
    if (this.soundtrackReady && !this.muted) return this.soundtrack.play().catch(() => {});
    return Promise.resolve();
  }

  async unlock() {
    this.startSoundtrack();
    const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContext) return false;
    if (!this.context) {
      this.context = new AudioContext();
      const ctx = this.context;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.45;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -12;
      limiter.knee.value = 16;
      limiter.ratio.value = 5;
      this.master.connect(limiter).connect(ctx.destination);
      this.nodes.push(this.master, limiter);

      this.engine = ctx.createGain();
      this.engine.gain.value = 0;
      this.engineFilter = ctx.createBiquadFilter();
      this.engineFilter.type = 'lowpass';
      this.engineFilter.frequency.value = 500;
      this.engine.connect(this.engineFilter).connect(this.master);
      this.engineOscillators = [0.5, 1, 1.498].map((ratio, i) => {
        const osc = ctx.createOscillator();
        osc.type = i === 0 ? 'triangle' : 'sawtooth';
        osc.frequency.value = 48 * ratio;
        const gain = ctx.createGain();
        gain.gain.value = i === 0 ? 0.7 : 0.17;
        osc.connect(gain).connect(this.engine);
        osc.start();
        this.nodes.push(osc, gain);
        return { osc, ratio };
      });
      this.nodes.push(this.engine, this.engineFilter);

      this.noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
      const samples = this.noiseBuffer.getChannelData(0);
      let previous = 0;
      for (let i = 0; i < samples.length; i++) {
        previous = (previous + (Math.random() * 2 - 1) * 0.12) / 1.025;
        samples[i] = previous * 3;
      }

      this.chargeOsc = ctx.createOscillator();
      this.chargeOsc.type = 'sine';
      this.chargeOsc.frequency.value = 130;
      this.chargeGain = ctx.createGain();
      this.chargeGain.gain.value = 0;
      this.chargeOsc.connect(this.chargeGain).connect(this.master);
      this.chargeOsc.start();
      this.nodes.push(this.chargeOsc, this.chargeGain);
      this.setEra(this.era);
    }
    if (this.context.state === 'suspended') await this.context.resume();
    return this.context.state === 'running';
  }

  setEra(era) {
    this.era = era;
    this.ambientClock = 0;
    this.musicStep = 0;
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    this.soundtrack.muted = this.muted;
    if (!this.muted && this.soundtrackReady) this.soundtrack.play().catch(() => {});
    if (this.context) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.45, this.context.currentTime, 0.05);
  }

  update(dt, { speedMph = 0, throttle = 0, charge = 0, walking = false, surface = 'road', paused = false } = {}) {
    if (!this.context || this.context.state !== 'running') return;
    this.time += dt;
    this.surface = surface;
    const now = this.context.currentTime;
    const speed = Math.abs(speedMph);
    const gear = Math.min(4, Math.floor(speed / 23));
    const rpm = 42 + (speed - gear * 18) * 1.95 + Math.max(0, throttle) * 10;
    for (const { osc, ratio } of this.engineOscillators) osc.frequency.setTargetAtTime(rpm * ratio, now, 0.08);
    this.engine.gain.setTargetAtTime(paused ? 0 : (0.035 + Math.min(speed / 88, 1) * 0.10 + Math.abs(throttle) * 0.035), now, 0.1);
    this.engineFilter.frequency.setTargetAtTime(250 + speed * 12 + Math.abs(throttle) * 280, now, 0.12);
    this.chargeOsc.frequency.setTargetAtTime(150 + charge * charge * 1400 + Math.sin(this.time * 12) * charge * 35, now, 0.06);
    this.chargeGain.gain.setTargetAtTime(paused ? 0 : Math.max(0, charge) * 0.055, now, 0.08);
    this.paused = paused;
    if (paused) return;
    if (walking) {
      this.stepClock += dt;
      const cadence = typeof walking === 'number' ? 0.48 / Math.max(0.7, Math.min(walking, 2)) : 0.46;
      if (this.stepClock > cadence) {
        this.stepClock = 0;
        this.play('step');
      }
    } else this.stepClock = 0.25;
    this.ambientClock += dt;
    if (this.ambientClock >= 2.4) {
      this.ambientClock = 0;
      this.ambientPhrase();
    }
  }

  track(source, nodes) {
    const voice = { source, nodes };
    this.voices.add(voice);
    source.onended = () => {
      for (const node of nodes) node.disconnect();
      this.voices.delete(voice);
    };
  }

  tone(frequency, duration, volume = 0.08, type = 'sine', delay = 0, endFrequency = frequency) {
    const ctx = this.context;
    if (!ctx) return;
    const now = ctx.currentTime + delay;
    const oscillator = ctx.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(10, endFrequency), now + duration);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + Math.min(0.018, duration * 0.2));
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain).connect(this.master);
    this.track(oscillator, [oscillator, gain]);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }

  noise(duration, volume, frequency, delay = 0, endFrequency = frequency) {
    const ctx = this.context;
    if (!ctx) return;
    const now = ctx.currentTime + delay;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(frequency, now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), now + duration);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + Math.min(0.04, duration * 0.2));
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    source.connect(filter).connect(gain).connect(this.master);
    this.track(source, [source, filter, gain]);
    source.start(now, Math.random());
    source.stop(now + duration + 0.02);
  }

  play(name) {
    if (!this.context || this.context.state !== 'running') return;
    switch (name) {
      case 'beep': this.tone(920, 0.065, 0.055, 'sine'); break;
      case 'error': this.tone(170, 0.18, 0.07, 'triangle'); this.tone(130, 0.23, 0.06, 'triangle', 0.13); break;
      case 'confirm': this.tone(660, 0.12, 0.06); this.tone(990, 0.22, 0.06, 'sine', 0.11); break;
      case 'door':
        this.noise(0.55, 0.12, 1100, 0, 250);
        this.tone(105, 0.18, 0.1, 'triangle');
        this.tone(210, 0.6, 0.025, 'sine', 0, 360);
        break;
      case 'step':
        this.noise(0.12, 0.08, this.surface === 'grass' ? 1800 : this.surface === 'dirt' ? 1250 : 650);
        this.tone(75, 0.09, 0.035, 'triangle');
        break;
      case 'departure':
        this.tone(95, 1.3, 0.14, 'sawtooth', 0, 1800);
        this.tone(130, 1.6, 0.1, 'sine', 0, 2600);
        this.noise(1.1, 0.28, 600, 0.35, 7000);
        this.noise(2.0, 0.25, 1600, 1.1, 90);
        this.tone(45, 1.7, 0.22, 'sine', 1.0, 22);
        break;
      case 'arrival':
        this.noise(1.8, 0.3, 3400, 0, 220);
        this.tone(63, 1.1, 0.19, 'sine', 0, 30);
        this.tone(1300, 1.5, 0.055, 'sine', 0, 150);
        break;
      case 'thunder': this.noise(3.3, 0.25, 350, 0, 75); this.tone(35, 2.7, 0.12, 'sine', 0.1, 20); break;
    }
  }

  ambientPhrase() {
    // Small original motifs, deliberately quiet and sparse; never a film melody.
    if (this.era === 'present' && this.soundtrack.paused) {
      const chords = [[130.81,164.81,196], [110,130.81,164.81], [87.31,130.81,174.61], [98,146.83,196]];
      const chord = chords[Math.floor(this.musicStep / 3) % chords.length];
      for (const frequency of chord) this.tone(frequency, 3.2, 0.018, 'sine');
      for (let i = 0; i < 4; i++) this.tone(chord[i % 3] * 2, 0.9, 0.014, 'triangle', i * 0.6);
    } else if (this.era === 'fifties') {
      const notes = [174.61, 220, 261.63, 220, 196, 146.83, 196, 261.63];
      for (let i = 0; i < 3; i++) {
        const frequency = notes[(this.musicStep + i) % notes.length];
        this.tone(frequency, 0.48, 0.009, 'triangle', i * 0.28);
        this.tone(frequency * 2, 0.23, 0.004, 'sine', i * 0.28);
      }
      if (this.musicStep % 2 === 0) for (let i = 0; i < 4; i++) this.tone(3200, 0.04, 0.006, 'sine', 1.2 + i * 0.12, 3500);
    } else if (this.era === 'oldwest') {
      const notes = [146.83, 220, 293.66, 349.23, 261.63, 174.61, 220, 293.66];
      for (let i = 0; i < 2; i++) {
        const frequency = notes[(this.musicStep + i) % notes.length];
        this.tone(frequency, 0.8, 0.012, 'triangle', i * 0.45);
        this.tone(frequency * 2.002, 0.5, 0.004, 'sine', i * 0.45);
      }
    } else if (this.era === 'future') {
      this.tone(75 + (this.musicStep % 3) * 25, 2.3, 0.014, 'sine', 0, 85);
      if (this.musicStep % 2 === 0) this.tone(450, 1.8, 0.012, 'sine', 0.2, 170);
    }
    this.musicStep += 3;
  }

  dispose() {
    this.soundtrack.pause();
    this.soundtrack.removeAttribute('src');
    this.soundtrack.load();
    for (const { source, nodes } of this.voices) {
      try { source.stop(); } catch { /* Already ended. */ }
      for (const node of nodes) node.disconnect();
    }
    this.voices.clear();
    for (const node of this.nodes) {
      if (typeof node.stop === 'function') { try { node.stop(); } catch { /* Already stopped. */ } }
      node.disconnect();
    }
    this.nodes = [];
    if (this.context && this.context.state !== 'closed') this.context.close();
    this.context = null;
  }
}
