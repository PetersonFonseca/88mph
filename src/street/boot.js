import * as THREE from 'three';
import {Cockpit} from '../car/cockpit.js';
import {TimeCircuits} from '../car/timeCircuits.js';
import {AudioSystem} from '../core/audio.js';
import {createGoogleProvider} from './googleProvider.js';
import {PanoramaRenderer} from './panoramaRenderer.js';
import {resolvePaulistaRoute, headingAt} from './route.js';
import {StreetJourney} from './journey.js';
import {downloadRoute} from './downloadRoute.js';
import {normalizeSavedRoute} from './savedRoute.js';
import './street.css';
import {streetTitle} from '../ui/streetTitle.js';

const MONTHS = ['jan.', 'fev.', 'mar.', 'abr.', 'mai.', 'jun.', 'jul.', 'ago.', 'set.', 'out.', 'nov.', 'dez.'];
export function captureLabel(date) {
  const [year, month] = String(date || '').split('-');
  return month && MONTHS[Number(month) - 1] ? `${MONTHS[Number(month) - 1]} ${year}` : year || 'Data indisponível';
}
function circuitDate(date) {
  // Day/time are the fictional circuit clock, never represented as photo metadata.
  const [year, month] = date.split('-').map(Number);
  return {year, month: month || 1, day: 1, hour: 12, minute: 0};
}
function safeReportLink(value) {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : '#'; }
  catch { return '#'; }
}

export async function bootStreet() {
  const root = document.querySelector('#app');
  root.classList.add('street-app');
  root.innerHTML = `${streetTitle}
    <div class="street-backdrop" aria-hidden="true"></div>
    <header class="street-header"><a class="street-brand" href="/">88<span>MPH</span></a><div class="street-place"><span>UMA RUA. DOIS TEMPOS.</span><strong>São Paulo / Avenida Paulista</strong></div></header>
    <section class="street-setup" id="street-setup" hidden aria-labelledby="street-title">
      <div class="street-intro"><p class="street-kicker">EXPEDIÇÃO 01 <i></i> 23°33′ S · 46°39′ O</p><h1 id="street-title">A Paulista<br>tem memória.</h1><p class="street-copy">A mesma avenida. Fotografias de outros tempos.<br>Prepare a chegada, entre na cabine e alcance 88 mph.</p><div class="street-years"><div><span>PASSADO</span><strong id="past-year">2010</strong></div><b>↔</b><div><span>CAPTURA RECENTE</span><strong id="recent-year">2024*</strong></div></div><p class="street-note" id="archive-note">*Capturas observadas junto ao MASP. O modo local usa o percurso e as fotografias salvos no computador.</p></div>
      <div class="street-connect"><span class="street-kicker">SEU PERCURSO</span><h2>Uma avenida inteira de histórias.</h2><p id="route-summary">Um percurso ampliado pela Paulista.<br>O ponto de viagem fica perto do MASP.</p><ol class="street-stops"><li>Início da avenida <span>APROXIMAÇÃO</span></li><li class="portal-stop">MASP / Paulista, 1508 <span>SALTO TEMPORAL</span></li><li>Continue pela Paulista <span>CHEGADA</span></li></ol><div class="street-status" role="status" aria-live="polite"><i id="connection-dot"></i><span id="connection-status">Preparando a cabine…</span></div><progress id="connect-progress" aria-label="Preparação da viagem" hidden></progress><button id="connect-street" class="street-primary" >USAR ACERVO LOCAL <span>→</span></button><button id="update-street" class="street-secondary street-update">ATUALIZAR COM GOOGLE ↓</button><button id="cancel-download" class="street-secondary" hidden>CANCELAR PREPARAÇÃO</button><p class="street-small" id="download-detail">Modo local: sem consultas ao Google. Atualizar consulta o percurso e baixa apenas as imagens ausentes, consumindo a cota da API.</p><a class="street-cloud" id="street-cloud" href="https://console.cloud.google.com/google/maps-apis/credentials" target="_blank" rel="noopener">Configurar acesso no Google Maps ↗</a><p class="street-setup-error" id="setup-error" role="alert" hidden></p><p class="street-small">Imagens reais do Street View. As imagens salvas ficam no computador, sem exclusão automática por prazo ou tamanho. O acervo local não é atualizado automaticamente.</p></div>
    </section>
    <section class="street-dashboard" id="street-dashboard" hidden>
      <div class="street-capture"><span>VOCÊ ESTÁ EM</span><strong id="active-capture">—</strong><small id="active-address">Avenida Paulista</small></div>
      <div class="street-route"><div><span id="route-stage">APROXIMAÇÃO</span><strong id="portal-distance">—</strong></div><div class="street-route-track"><i id="route-fill"></i><b id="portal-marker"></b></div><p id="driving-message" role="status">Prepare o destino antes de acelerar.</p></div>
      <footer class="street-controls"><span><kbd>W</kbd> ACELERAR</span><span><kbd>S / ESPAÇO</kbd> FREAR</span><span><kbd>ARRASTE</kbd> OLHAR</span><span><kbd>T</kbd> DESTINO</span><button id="street-pause">PAUSAR <kbd>H</kbd></button><button id="street-mute">SOM ON</button></footer>
    </section>
    <section class="street-panel" id="street-panel" aria-labelledby="destination-title" hidden>
      <div class="street-panel-head"><div><span class="street-kicker">CIRCUITOS DO TEMPO</span><h2 id="destination-title">Prepare o próximo instante.</h2></div><button id="close-street-panel" aria-label="Fechar destino">×</button></div>
      <div class="street-preview" id="street-preview"><canvas id="preview-canvas" aria-label="Prévia do panorama de chegada" hidden></canvas><span id="preview-placeholder">A chegada será exibida aqui quando estiver pronta.</span></div>
      <div class="street-preview-caption"><strong id="preview-date">DESTINO</strong><span id="preview-credit"></span><a id="preview-report" target="_blank" rel="noopener" hidden>Reportar problema</a></div>
      <div class="street-destination-row"><label for="street-destination">ÉPOCA DE CHEGADA</label><select id="street-destination"><option value="past">2010 · acervo histórico</option><option value="present">Captura recente</option></select></div>
      <div class="street-load-row"><span id="destination-status" role="status">Escolha o destino.</span><progress id="destination-progress" max="1" value="0" aria-label="Carregamento do destino"></progress></div>
      <p class="street-panel-error" id="destination-error" role="alert" hidden></p>
      <div class="street-panel-buttons"><button id="prepare-street" class="street-secondary">PREPARAR DESTINO</button><button id="drive-street" class="street-primary" disabled>INICIAR APROXIMAÇÃO →</button></div>
      <p class="street-small">A data da foto aparece acima. Dia e hora no painel do carro são o relógio da simulação.</p>
    </section>
    <section class="street-pause-panel" id="street-pause-panel" hidden><span class="street-kicker">O TEMPO PODE ESPERAR</span><h2 id="street-pause-title">Viagem em pausa.</h2><p id="street-pause-copy">Continue quando estiver pronto.</p><label><input id="street-reduced" type="checkbox"> Reduzir clarões</label><button id="street-resume" class="street-primary">CONTINUAR VIAGEM</button><button id="street-restart" class="street-secondary">NOVA APROXIMAÇÃO</button><a href="/">Voltar ao início</a></section>
    <div id="street-flash" class="street-flash" aria-hidden="true"></div><div id="street-jump" class="street-jump" hidden><span>ATRAVESSANDO O TEMPO</span><strong id="street-jump-date"></strong></div>
    <footer class="street-attribution" id="street-attribution" hidden><span class="google-credit">Google Maps</span><span id="street-copyright"></span><span id="street-image-date"></span><a id="street-report" target="_blank" rel="noopener">Reportar problema com esta imagem</a><a href="https://maps.google.com/help/terms_maps/" target="_blank" rel="noopener">Termos</a><a href="https://policies.google.com/privacy" target="_blank" rel="noopener">Privacidade</a></footer>`;
  const el = Object.fromEntries([...root.querySelectorAll('[id]')].map(node => [node.id, node]));
  const renderer = new THREE.WebGLRenderer({antialias: true, powerPreference: 'high-performance'});
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.autoClear = false;
  renderer.domElement.id = 'street-canvas';
  renderer.domElement.setAttribute('aria-label', 'Panorama fotográfico da Avenida Paulista');
  root.prepend(renderer.domElement);
  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, .055, 1000);
  camera.position.set(0, 1.2, 0);
  camera.rotation.order = 'YXZ';
  const overlay = new THREE.Scene(); overlay.add(camera);
  const previewCamera = new THREE.PerspectiveCamera(75, 2, .1, 1000);
  const cockpit = new Cockpit(camera);
  await cockpit.load();
  const panoramas = new PanoramaRenderer(renderer, camera);
  const audio = new AudioSystem();
  const circuits = new TimeCircuits({year: 2024, month: 11, day: 1, hour: 12, minute: 0});
  const keys = new Set();
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';
  let sourceMode = 'local';
  let provider, journey, route, connectAbort, downloaded, persistence, connecting = false, disposed = false;
  let running = false, paused = false, panel = false, muted = false, dragging = false;
  let lookHeading = 0, lookPitch = 0, time = 0, lastFrame = performance.now(), lastHud = 0;
  let travelClock = 0, travelPhase = '', lastCapture = '', prepareBusy = false, lastPreviewKey = '';
  let reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const metrics = {travelCount: 0, commitMs: 0, frameMs: 0, frames: 0, drivingMs: 0, bufferedMs: 0, bufferEvents: 0};
  let wasBuffering = false;
  el['street-reduced'].checked = reduced;
  el['connection-status'].textContent = 'Use o acervo local. O Google só será consultado ao atualizar.';
  el['connect-street'].disabled = false;
  el['update-street'].disabled = !apiKey;
  el['street-cloud'].hidden = !!apiKey;
  el.start.disabled = false;
  el.start.textContent = 'INICIAR VIAGEM';
  el['load-status'].textContent = 'PRONTO PARA PARTIR · GOOGLE MAPS';
  on('start', () => {
    audio.unlock();
    el['title-screen'].hidden = true;
    el['street-setup'].hidden = false;
  });
  function syncSoundControls() {
    const playing = !audio.soundtrack.paused && !muted;
    el['title-mute'].textContent = playing ? 'SOM ON ♫' : 'ATIVAR SOM ♫';
    el['title-mute'].setAttribute('aria-label', playing ? 'Silenciar trilha sonora' : 'Ativar trilha sonora');
    el['title-mute'].setAttribute('aria-pressed', String(playing));
    el['street-mute'].textContent = muted ? 'SOM OFF' : 'SOM ON';
  }
  function toggleSound() {
    muted = !audio.soundtrack.paused && !muted;
    audio.setMuted(muted);
    if (!muted) audio.startSoundtrack();
    syncSoundControls();
  }
  on('title-mute', toggleSound);
  audio.soundtrack.addEventListener('playing', syncSoundControls);
  audio.soundtrack.addEventListener('pause', syncSoundControls);
  audio.startSoundtrack();
  document.documentElement.dataset.ready = 'true';

  function on(id, callback) { el[id].addEventListener('click', event => { event.currentTarget.blur(); callback(); }); }
  function showError(id, error) { el[id].hidden = !error; el[id].textContent = error ? error.humanError || error.message || String(error) : ''; }
  function setPanel(value) { panel = value; el['street-panel'].hidden = !value; keys.clear(); dragging = false; }
  function setPaused(value) {
    paused = value; keys.clear(); dragging = false;
    el['street-pause-panel'].hidden = !value;
    if (value) { el['street-pause-title'].textContent = 'Viagem em pausa.'; el['street-pause-copy'].textContent = 'A chegada permanece preparada.'; }
  }
  async function prepare() {
    if (!journey || prepareBusy || journey.snapshot().speedMph > 2) return;
    prepareBusy = true;
    showError('destination-error', null);
    try {
      await journey.prepareDestination(el['street-destination'].value);
      if (journey.prepared) { circuits.destination = circuitDate(journey.prepared.metadata.date); audio.play('confirm'); }
    } catch (error) { showError('destination-error', error); audio.play('error'); }
    finally { prepareBusy = false; updateHud(); }
  }
  async function connect({online = false, rediscover = false} = {}) {
    if (connecting || disposed || (online && !apiKey)) return;
    sourceMode = online ? 'google' : 'local';
    downloaded = null;
    el['download-detail'].textContent = online ? 'Consultando o percurso no Google. As imagens já salvas serão preservadas.' : 'Lendo somente o acervo local. Nenhum download será iniciado.';
    el['download-detail'].dataset.reusedBytes = '0';
    el['download-detail'].dataset.googleBytes = '0';
    el['update-street'].disabled = true;
    connecting = true; el['connect-street'].disabled = true; showError('setup-error', null);
    el['connect-progress'].hidden = false; el['connect-progress'].removeAttribute('value');
    el['cancel-download'].hidden = false;
    connectAbort?.abort(); connectAbort = new AbortController();
    try {
      journey?.dispose(); provider?.dispose();
      provider = createGoogleProvider({apiKey, localOnly: !online});
      persistence = await provider.detectPersistence({signal: connectAbort.signal});
      if (online) {
        // Reuse the saved route: rediscovering it costs hundreds of metadata
        // requests and may pick other panoramas, wasting tiles already on disk.
        route = null;
        if (persistence.type === 'disk' && !rediscover) {
          try { route = normalizeSavedRoute(await provider.readLocalRoute({signal: connectAbort.signal})); }
          catch (error) { if (connectAbort.signal.aborted) throw error; }
        }
        if (route) el['connection-status'].textContent = 'Percurso salvo encontrado. Baixando apenas as imagens que faltam…';
        else {
          route = await resolvePaulistaRoute(provider, {signal: connectAbort.signal, onProgress: progress => {
            el['connection-status'].textContent = progress.message || `Verificando o acervo · ${progress.loaded || 0} pontos`;
          }});
          // Save before downloading: a quota failure must not lose the route again.
          if (persistence.type === 'disk') await provider.saveLocalRoute(route, {signal: connectAbort.signal});
        }
      } else {
        if (persistence.type === 'disk') {
          const inventory = await provider.localInventory({signal: connectAbort.signal});
          el['download-detail'].textContent = `${inventory.entries} blocos de imagem preservados no disco · ${(inventory.bytes / 1048576).toFixed(1).replace('.', ',')} MB. Sem consultas ao Google.`;
        }
        route = normalizeSavedRoute(await provider.readLocalRoute({signal: connectAbort.signal}));
      }
      el['route-summary'].textContent = `${(route.length / 1000).toFixed(2).replace('.', ',')} km verificados · ${Math.round(route.portalS)} m de aproximação até o MASP.`;
      el['archive-note'].textContent = `Capturas recentes: ${captureLabel(route.epochs.present.dateRange.from)} a ${captureLabel(route.epochs.present.dateRange.to)}. A data de cada fotografia aparece durante a viagem.`;
      el['connect-progress'].max = 1; el['connect-progress'].value = 0;
      let lastDownloadUpdate = 0;
      downloaded = await downloadRoute(route, provider, {signal: connectAbort.signal, localOnly: !online, persistToDisk: persistence.type === 'disk', onProgress: progress => {
        downloaded = progress;
        const now = performance.now();
        if (now - lastDownloadUpdate < 100 && progress.checked !== progress.total) return;
        lastDownloadUpdate = now;
        el['connect-progress'].value = progress.progress;
        const reused = ['memory', 'disk', 'browser'].reduce((sum, source) => sum + progress.sources[source].bytes, 0);
        const received = progress.sources.google.bytes;
        const action = received ? (reused ? 'Preparando percurso' : 'Baixando imagens do Google')
          : reused ? 'Carregando imagens salvas' : 'Verificando imagens salvas';
        const megabytes = bytes => (bytes / 1048576).toFixed(1).replace('.', ',');
        el['connection-status'].textContent = `${action} · ${Math.floor(progress.progress * 100)}% · ${progress.completedPanoramas}/${progress.totalPanoramas} panoramas`;
        el['download-detail'].textContent = `${megabytes(reused)} MB reaproveitados · ${megabytes(received)} MB recebidos do Google. ${progress.missing ? `${progress.missing} blocos ausentes.` : 'A partida será liberada ao concluir.'}`;
        el['download-detail'].dataset.reusedBytes = String(reused);
        el['download-detail'].dataset.googleBytes = String(received);
      }});
      journey = new StreetJourney({route, lookaheadCount: 6, destinationLookaheadCount: 3,
        loadPanorama: (metadata, options) => panoramas.prepare(metadata, provider, options)});
      const preparingJourney = journey;
      connectAbort.signal.addEventListener('abort', () => preparingJourney.dispose(), {once: true});
      el['connection-status'].textContent = 'Imagens prontas. Preparando a avenida para dirigir…';
      await journey.start('present');
      if (connectAbort.signal.aborted) throw new DOMException('Preparação cancelada.', 'AbortError');
      circuits.now = circuitDate(journey.current.metadata.date); circuits.last = {...circuits.now};
      el['past-year'].textContent = route.epochs.past.date.slice(0, 4);
      el['recent-year'].textContent = route.epochs.present.date.slice(0, 4);
      for (const option of el['street-destination'].options) {
        option.textContent = `${captureLabel(route.epochs[option.value].date)} · ${option.value === 'past' ? 'acervo histórico' : 'captura recente'}`;
      }
      el['street-destination'].value = 'past';
      el['street-setup'].hidden = true;
      el['street-dashboard'].hidden = false;
      cockpit.setVisible(true); running = true; setPanel(true);
      await prepare();
    } catch (error) {
      if (disposed) return;
      const cancelled = connectAbort.signal.aborted || error.name === 'AbortError';
      el['connection-status'].textContent = cancelled ? 'Preparação interrompida. Os arquivos salvos permanecem no disco.' : 'A viagem ainda não pode ser liberada.';
      // A saved panorama ID can expire; rediscover the route once in that case.
      if (!cancelled && online && !rediscover && error?.code === 'NOT_FOUND') {
        connecting = false;
        return await connect({online: true, rediscover: true});
      }
      showError('setup-error', cancelled ? null : error);
      el['connect-street'].textContent = 'USAR ACERVO LOCAL →';
    } finally {
      connecting = false; el['connect-progress'].hidden = true; el['cancel-download'].hidden = true; el['connect-street'].disabled = false; el['update-street'].disabled = !apiKey;
    }
  }
  async function restart() {
    if (!journey || prepareBusy) return;
    keys.clear(); setPaused(false); setPanel(true); prepareBusy = true;
    try {
      await journey.restart();
      circuits.destination = null; travelPhase = ''; travelClock = 0;
      el['street-flash'].style.opacity = '0'; el['street-jump'].hidden = true; lastPreviewKey = '';
      el['street-destination'].value = journey.snapshot().epoch === 'present' ? 'past' : 'present';
      showError('destination-error', null);
    } catch (error) { showError('destination-error', error); }
    finally { prepareBusy = false; }
    await prepare();
  }
  on('connect-street', () => { audio.unlock(); connect(); });
  on('update-street', () => { audio.unlock(); connect({online: true}); });
  on('cancel-download', () => connectAbort?.abort());
  on('prepare-street', prepare);
  on('drive-street', () => { if (journey?.prepared) { audio.unlock(); setPanel(false); setPaused(false); } });
  on('close-street-panel', () => setPanel(false));
  on('street-pause', () => setPaused(true));
  on('street-resume', () => { audio.unlock(); setPaused(false); });
  on('street-restart', restart);
  on('street-mute', toggleSound);
  el['street-reduced'].addEventListener('change', event => reduced = event.target.checked);
  el['street-destination'].addEventListener('change', () => { circuits.destination = null; prepare(); });
  const handleKeyDown = event => {
    if (event.target.matches('input,select,textarea,button')) return;
    if (event.code === 'KeyM') { if (!event.repeat) el['street-mute'].click(); return; }
    if (!running) return;
    if (['Space', 'ArrowUp', 'ArrowDown'].includes(event.code)) event.preventDefault();
    if (event.repeat) return;
    if (event.code === 'Escape' || event.code === 'KeyH') { if (panel) setPanel(false); else setPaused(!paused); return; }
    if (event.code === 'KeyT' && !paused && !['departure', 'arrival'].includes(journey.snapshot().status)) {
      if (journey.snapshot().speedMph <= 2) setPanel(!panel);
      else el['driving-message'].textContent = 'Pare o carro para escolher o destino.';
      return;
    }
    if (!paused && !panel) keys.add(event.code);
  };
  const handleKeyUp = event => keys.delete(event.code);
  const handleBlur = () => { if (running) setPaused(true); };
  const handleMove = event => {
    if (!dragging || paused || panel) return;
    lookHeading = THREE.MathUtils.clamp(lookHeading - event.movementX * .1, -40, 40);
    lookPitch = THREE.MathUtils.clamp(lookPitch - event.movementY * .08, -20, 20);
  };
  const handleUp = () => dragging = false;
  const handleDown = () => { if (running && !paused && !panel) dragging = true; };
  const resize = () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); };
  window.addEventListener('keydown', handleKeyDown); window.addEventListener('keyup', handleKeyUp);
  window.addEventListener('blur', handleBlur); window.addEventListener('pointermove', handleMove);
  window.addEventListener('pointerup', handleUp); renderer.domElement.addEventListener('pointerdown', handleDown);
  window.addEventListener('resize', resize);

  function updateHud() {
    if (!journey) return;
    const state = journey.snapshot();
    el['street-dashboard'].dataset.bufferEvents = String(metrics.bufferEvents);
    el['street-dashboard'].dataset.bufferedMs = String(Math.round(metrics.bufferedMs));
    el['street-dashboard'].dataset.travelCount = String(metrics.travelCount);
    const cache = provider?.cacheStats();
    el['street-dashboard'].dataset.memoryHits = String(cache?.memoryHits || 0);
    el['street-dashboard'].dataset.memoryBytes = String(cache?.memoryBytes || 0);
    const current = journey.current?.metadata;
    if (current && current.panoId !== lastCapture) {
      lastCapture = current.panoId;
      el['active-capture'].textContent = captureLabel(current.date);
      el['street-copyright'].textContent = current.copyright;
      el['street-image-date'].textContent = `Captura: ${captureLabel(current.date)}`;
      el['street-report'].href = safeReportLink(current.reportProblemLink);
      el['street-attribution'].hidden = false;
    }
    const remaining = Math.max(0, route.portalS - state.s);
    el['portal-distance'].textContent = state.s <= route.portalS ? `${Math.ceil(remaining)} m até o salto` : `${Math.ceil(route.length - state.s)} m até o fim`;
    el['route-stage'].textContent = state.s <= route.portalS ? 'APROXIMAÇÃO / MASP' : 'CHEGADA / PAULISTA';
    el['route-fill'].style.width = `${state.s / route.length * 100}%`;
    el['portal-marker'].style.left = `${route.portalS / route.length * 100}%`;
    el['destination-status'].textContent = state.prepared ? 'Destino pronto · chegada carregada' : state.preparing ? 'Carregando e preparando a chegada…' : 'Escolha o destino e prepare a chegada.';
    const progress = typeof state.progress === 'number' ? state.progress : (state.progress?.total ? state.progress.loaded / state.progress.total : 0);
    el['destination-progress'].value = state.prepared ? 1 : progress || 0;
    el['prepare-street'].disabled = prepareBusy || state.preparing || state.speedMph > 2 || el['street-destination'].value === state.epoch;
    el['street-destination'].disabled = prepareBusy || state.preparing || state.speedMph > 2;
    for (const option of el['street-destination'].options) option.disabled = option.value === state.epoch;
    el['drive-street'].disabled = !state.prepared || state.preparing || state.needsRestart;
    el['preview-placeholder'].hidden = !!journey.prepared;
    el['preview-canvas'].hidden = !journey.prepared;
    if (journey.prepared) {
      el['preview-date'].textContent = `CHEGADA · ${captureLabel(journey.prepared.metadata.date)}`;
      el['preview-credit'].textContent = `Google Maps · ${journey.prepared.metadata.copyright}`;
      el['preview-report'].href = safeReportLink(journey.prepared.metadata.reportProblemLink);
      el['preview-report'].hidden = false;
    } else { el['preview-credit'].textContent = ''; el['preview-report'].hidden = true; }
    el['driving-message'].textContent = state.error || (state.buffering ? 'Preparando a próxima imagem. Movimento em espera.' : state.needsRestart ? 'Sem velocidade suficiente no portal. Inicie uma nova aproximação.' : state.preparing ? 'Destino em preparação. O portal permanecerá fechado.' : state.prepared ? 'Alcance 142 km/h (88 mph) ao passar pelo ponto de viagem.' : 'T abre os circuitos com o carro parado.');
    if ((state.ended || state.status === 'finished' || state.needsRestart || state.status === 'error') && !paused && !panel) {
      setPaused(true);
      el['street-pause-title'].textContent = state.ended || state.status === 'finished' ? 'Uma avenida. Outra história.' : 'Vamos preparar outra partida.';
      el['street-pause-copy'].textContent = state.error || 'Uma nova aproximação permite viajar para a outra época.';
    }
  }

  function frame(now) {
    if (disposed) return;
    const dt = Math.min((now - lastFrame) / 1000, .25); metrics.frameMs = now - lastFrame; metrics.frames++; lastFrame = now;
    try {
      if (journey && running) {
        const before = journey.snapshot();
        if (!paused && !panel) {
          time += dt;
          journey.update(dt, {throttle: keys.has('KeyW') ? 1 : 0, brake: keys.has('KeyS') || keys.has('Space') ? 1 : 0});
          const state = journey.snapshot();
          if (state.status === 'departure' && travelPhase !== 'departure') {
            travelPhase = 'departure'; travelClock = 0; audio.play('departure');
            el['street-jump'].hidden = false;
            el['street-jump-date'].textContent = captureLabel(journey.prepared.metadata.date);
          }
          if (state.status === 'departure') {
            travelClock += dt;
            el['street-flash'].style.opacity = String(Math.min(1, travelClock / 1.2));
            if (travelClock >= 1.35) {
              const started = performance.now();
              if (!journey.commitTravel(journey.travelSnapshot)) throw new Error('A chegada preparada foi alterada. Reinicie a aproximação.');
              metrics.commitMs = performance.now() - started; metrics.travelCount++;
              circuits.arrive(); travelPhase = 'arrival'; travelClock = 0; audio.play('arrival');
            }
          } else if (state.status === 'arrival') {
            travelClock += dt;
            el['street-flash'].style.opacity = String(Math.max(0, 1 - travelClock / .8));
            if (travelClock >= 1.2) { journey.finishArrival(); travelPhase = ''; el['street-jump'].hidden = true; }
          }
        }
        const state = journey.snapshot();
        camera.rotation.set(THREE.MathUtils.degToRad(lookPitch), -THREE.MathUtils.degToRad(headingAt(route, state.epoch, state.s) + lookHeading), 0, 'YXZ');
        if (!paused && !panel && state.status === 'driving') {
          metrics.drivingMs += dt * 1000;
          if (state.buffering) { metrics.bufferedMs += dt * 1000; if (!wasBuffering) metrics.bufferEvents++; }
        }
        wasBuffering = state.buffering;
        const charge = state.prepared ? THREE.MathUtils.clamp((state.speedMph - 75) / 13, 0, 1) : 0;
        cockpit.update(dt, time, {panel: false, look: {x: 0, y: 0}, speedMph: state.speedMph, circuits, night: false, charge});
        audio.update(dt, {speedMph: state.speedMph, throttle: keys.has('KeyW') ? 1 : 0, charge, paused: paused || panel || state.movementPaused, surface: 'road'});
        if (before.epoch !== state.epoch) lastCapture = '';
      }
      el['street-flash'].style.background = reduced ? '#07121e' : '#eaf8ff';
      renderer.setRenderTarget(null); renderer.setScissorTest(false); renderer.setViewport(0, 0, innerWidth, innerHeight);
      renderer.setClearColor(0x08131b, 1); renderer.clear();
      if (journey?.current) {
        panoramas.render(journey.current, camera);
        renderer.clearDepth(); renderer.render(overlay, camera);
      }
      if (panel && journey?.prepared) {
        const rect = el['street-preview'].getBoundingClientRect();
        const previewKey = `${journey.prepared.metadata.panoId}:${rect.width}:${rect.height}:${renderer.getPixelRatio()}`;
        if (lastPreviewKey !== previewKey) {
          previewCamera.aspect = rect.width / rect.height; previewCamera.updateProjectionMatrix();
          previewCamera.rotation.set(0, -THREE.MathUtils.degToRad(route.heading), 0, 'YXZ');
          panoramas.renderPreview(journey.prepared, previewCamera, {x: rect.left, y: rect.top, width: rect.width, height: rect.height});
          const ratio = renderer.getPixelRatio(), canvas = el['preview-canvas'];
          canvas.width = Math.round(rect.width * ratio); canvas.height = Math.round(rect.height * ratio);
          // Copy the display region in the same frame. This uses the prepared GPU
          // resource, without another request, texture upload, or persistent cache.
          canvas.getContext('2d').drawImage(renderer.domElement, rect.left * ratio, rect.top * ratio, rect.width * ratio, rect.height * ratio, 0, 0, canvas.width, canvas.height);
          lastPreviewKey = previewKey;
        }
      }
      if (now - lastHud > 80) { updateHud(); lastHud = now; }
    } catch (error) {
      el['street-flash'].style.opacity = '0'; el['street-jump'].hidden = true;
      setPaused(true); el['street-pause-copy'].textContent = error.message;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  function dispose() {
    if (disposed) return;
    disposed = true; connectAbort?.abort(); journey?.dispose(); provider?.dispose(); panoramas.dispose?.(); cockpit.dispose(); audio.dispose(); renderer.dispose();
    window.removeEventListener('keydown', handleKeyDown); window.removeEventListener('keyup', handleKeyUp); window.removeEventListener('blur', handleBlur);
    window.removeEventListener('pointermove', handleMove); window.removeEventListener('pointerup', handleUp); window.removeEventListener('resize', resize);
    renderer.domElement.removeEventListener('pointerdown', handleDown);
  }
  window.addEventListener('pagehide', dispose, {once: true});
  window.__street = {
    get journey() { return journey; }, get route() { return route; }, get renderer() { return renderer; },
    snapshot: () => ({...journey?.snapshot(), configured: !!apiKey, sourceMode, connecting, paused, panel, download: downloaded, persistence, metrics: {...metrics}, cache: provider?.cacheStats(), memory: {...renderer.info.memory}, projection: cockpit.projection}),
    flushCache: () => provider?.flushCache(),
    connect, prepare, restart, dispose,
  };
}
