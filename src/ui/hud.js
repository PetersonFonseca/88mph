import {ERA_NAMES,ERA_COPY,TITLE} from '../config.js';
import {formatDate,FIELDS} from '../car/timeCircuits.js';
export class HUD {
  constructor(root){
    root.insertAdjacentHTML('beforeend',`
      <div id="title-screen" class="title-screen">
        <div class="title-image"></div><div class="title-shade"></div>
        <header class="title-header"><a class="brand" href="#" aria-label="88 MPH"><span class="brand-mark">88</span><span>MPH<span class="brand-caption">UMA VIAGEM NO TEMPO</span></span></a><span class="edition">EXPERIÊNCIA INTERATIVA · VOL. 01</span></header>
        <main class="title-content"><p class="eyebrow"><span class="small-line"></span> O FUTURO NÃO ESTÁ ESCRITO</p><h1>O tempo é<br>uma estrada.</h1><p class="intro-copy">Escolha uma data. Encontre seu caminho.<br>O resto acontece a 88 milhas por hora.</p><div class="start-row"><button id="start" class="primary" disabled>PREPARANDO A VIAGEM…</button><span class="start-note">Fones de ouvido recomendados<br>Teclado + mouse</span></div><a class="street-entry" href="?mode=paulista"><span>EXPERIÊNCIA FOTOGRÁFICA</span>Avenida Paulista · 2010 ↔ hoje <b>↗</b></a></main>
        <footer class="title-footer"><div class="time-stamp"><span class="eyebrow">PONTO DE PARTIDA</span><strong>11 NOV 2026 <span>22:04</span></strong></div><div class="era-track"><span>1885</span><i></i><span>1955</span><i></i><span class="active">2026</span><i></i><span>2077</span></div><span class="footer-note">QUATRO ÉPOCAS. UM MESMO LUGAR.</span></footer>
        <div id="load-status" role="status">Construindo a estrada e aquecendo os circuitos.</div>
      </div>
      <div id="hud" class="hud hidden">
        <header class="game-header"><div class="game-brand">88<span>MPH</span></div><div class="location"><span id="era-name">PRESENTE</span><strong id="current-date"></strong></div><div class="header-actions"><button id="mute" aria-label="Silenciar áudio" title="Áudio (M)">SOM ON</button><button id="help" aria-label="Abrir ajuda">AJUDA <kbd>H</kbd></button></div></header>
        <div id="reticle" class="reticle"></div>
        <div id="objective" class="objective"><span class="eyebrow" id="objective-label">SUA JORNADA COMEÇA AQUI</span><h2 id="objective-title">Encontre o carro.</h2><p id="objective-copy">Chegue perto da porta do motorista.</p></div>
        <div id="interact" class="interact hidden"></div>
        <div id="speedometer" class="speedometer hidden"><span class="speed-caption">VELOCIDADE</span><div><strong id="speed">00</strong><span>MPH</span></div><span id="kmh">0 km/h</span><div class="speed-track"><i id="speed-fill"></i><b>88</b></div><p id="travel-status">CIRCUITOS DESLIGADOS</p></div>
        <footer class="game-footer"><div id="controls"></div><span id="environment-note">VALE DO TEMPO · BRASIL</span></footer>
        <div id="toast" class="toast hidden" role="status"></div>
      </div>
      <section id="panel-ui" class="panel-ui hidden" aria-label="Circuitos do tempo"><div class="panel-heading"><div><span class="eyebrow">CIRCUITOS DO TEMPO</span><h2>Para quando vamos?</h2></div><button id="panel-close" class="quiet">FECHAR <kbd>T</kbd></button></div><div class="panel-footer"><p id="panel-feedback" role="status">Digite a data: mês · dia · ano · hora · minuto</p><div id="date-entry" class="date-entry"></div><div class="panel-actions"><span class="preset-label">DESTINOS CLÁSSICOS</span><button class="preset" data-date="110519550600">1955 · AMANHECER</button><button class="preset" data-date="010118851200">1885 · MEIO-DIA</button><button class="preset" data-date="102120772200">2077 · NOITE</button><button id="confirm-date" class="primary">PROGRAMAR <kbd>ENTER</kbd></button></div><p class="panel-hint">Digite 12 números · Backspace apaga · Horário em 24 h · Qualquer data leva à época mais próxima</p></div></section>
      <div id="flash" class="flash"></div><div id="travel-caption" class="travel-caption hidden"><span class="eyebrow">ATRAVESSANDO O TEMPO</span><strong>O próximo instante é outro mundo.</strong></div>
      <div id="arrival-card" class="arrival-card hidden"><span class="eyebrow">VOCÊ CHEGOU</span><h2 id="arrival-era"></h2><p id="arrival-date"></p><span id="arrival-copy"></span><small>Use S ou Espaço para frear antes de sair do carro.</small></div>
      <div id="pause" class="modal-backdrop hidden"><section class="modal"><span class="eyebrow">O TEMPO PODE ESPERAR</span><h2 id="pause-title">Uma pausa na viagem.</h2><p>Continue quando estiver pronto.</p><div class="help-grid"><span><kbd>W A S D</kbd> Andar / dirigir</span><span><kbd>MOUSE</kbd> Olhar ao redor</span><span><kbd>E</kbd> Porta / entrar / sair</span><span><kbd>T</kbd> Circuitos do tempo</span><span><kbd>C</kbd> Trocar câmera</span><span><kbd>ESPAÇO</kbd> Freio de mão</span><span><kbd>SHIFT</kbd> Correr a pé</span><span><kbd>ESC / H</kbd> Pausar / ajuda</span></div><label class="setting"><input type="checkbox" id="reduced-flashes"> Reduzir clarões e tremor</label><div class="modal-buttons"><button id="resume" class="primary">CONTINUAR VIAGEM</button><button id="recover" class="quiet">REPOSICIONAR NA ESTRADA</button></div><p class="fine-print">O mouse é capturado ao jogar. Esc libera o cursor.<br>Se o navegador não permitir, arraste o mouse para olhar.</p></section></div>
    `);
    this.el={};for(const el of root.querySelectorAll('[id]'))this.el[el.id]=el;this.toastUntil=0;this.arrivalUntil=0;
  }
  on(id,fn){this.el[id].addEventListener('click',e=>{fn(e);e.currentTarget.blur();});}
  ready(){this.el.start.disabled=false;this.el.start.textContent='INICIAR VIAGEM';this.el['load-status'].textContent='PRONTO PARA PARTIR';}
  start(){this.el['title-screen'].classList.add('leaving');setTimeout(()=>this.el['title-screen'].classList.add('hidden'),900);this.el.hud.classList.remove('hidden');}
  toast(message,duration=3500){this.el.toast.textContent=message;this.toastUntil=performance.now()+duration;this.el.toast.classList.remove('hidden');}
  arrival(era,date){this.el['arrival-era'].textContent=ERA_NAMES[era];this.el['arrival-date'].textContent=formatDate(date);this.el['arrival-copy'].textContent=ERA_COPY[era];this.el['arrival-card'].classList.remove('hidden');this.arrivalUntil=performance.now()+6500;}
  panel(circuits){let cursor=0;this.el['date-entry'].innerHTML=FIELDS.map(f=>{const start=cursor;cursor+=f.size;const active=circuits.buffer.length>=start&&circuits.buffer.length<cursor;return `<div class="date-field ${active?'selected':''}"><label>${f.label}</label><span>${circuits.buffer.slice(start,cursor).padEnd(f.size,'_')}</span></div>`;}).join('');this.el['panel-feedback'].textContent=circuits.error||'Digite a data: mês · dia · ano · hora · minuto';this.el['panel-feedback'].classList.toggle('error',!!circuits.error);}
  update({state,car,walker,circuits,era,near,prepared}){
    const mode=state.mode,inCar=mode==='car',panel=mode==='panel',walking=mode==='walk',travel=['departure','arrival'].includes(mode);
    this.el.pause.classList.toggle('hidden',!state.paused);this.el['panel-ui'].classList.toggle('hidden',!panel);this.el['travel-caption'].classList.toggle('hidden',!travel);
    this.el.controls.closest('footer').classList.toggle('hidden',panel||travel);
    this.el['era-name'].textContent=ERA_NAMES[era].toUpperCase();this.el['current-date'].textContent=formatDate(circuits.now);
    this.el.reticle.classList.toggle('hidden',!walking||state.paused);this.el.speedometer.classList.toggle('hidden',!inCar);
    this.el.objective.classList.toggle('hidden',!walking&&!inCar);this.el.controls.innerHTML=walking?'<span><kbd>W A S D</kbd> ANDAR</span><span><kbd>MOUSE</kbd> OLHAR</span><span><kbd>SHIFT</kbd> CORRER</span>':'<span><kbd>W / S</kbd> ACELERAR / FREAR</span><span><kbd>A / D</kbd> VIRAR</span><span><kbd>C</kbd> CÂMERA</span><span><kbd>T</kbd> DESTINO</span>';
    if(walking){this.el['objective-label'].textContent='EXPLORE O SEU TEMPO';this.el['objective-title'].textContent='A estrada é só o começo.';this.el['objective-copy'].textContent=near?'A próxima viagem está esperando.':'Aproxime-se da porta do motorista para viajar.';}
    if(inCar){this.el['objective-label'].textContent=circuits.destination?'DESTINO PROGRAMADO':'CIRCUITOS DO TEMPO';this.el['objective-title'].textContent=circuits.destination?formatDate(circuits.destination):'Para quando vamos?';this.el['objective-copy'].textContent=circuits.destination?'Alinhe o carro na estrada e acelere até 88 mph.':'Pressione T e escolha sua próxima época.';}
    let prompt='';if(walking&&near)prompt=`<kbd>E</kbd> ${car.doorOpen?'ENTRAR NO CARRO':'ABRIR A PORTA'}`;else if(inCar&&Math.abs(car.physics.speedMph)<2)prompt='<kbd>E</kbd> SAIR DO CARRO';this.el.interact.innerHTML=prompt;this.el.interact.classList.toggle('hidden',!prompt||state.paused);
    const speed=Math.abs(car.physics.speedMph);this.el.speed.textContent=String(Math.round(speed)).padStart(2,'0');this.el.kmh.textContent=`${Math.round(speed*1.60934)} km/h`;this.el['speed-fill'].style.width=`${Math.min(speed/88*100,100)}%`;this.el.speedometer.classList.toggle('charged',speed>=75&&!!circuits.destination);this.el['travel-status'].textContent=circuits.destination?(prepared?'CIRCUITOS ARMADOS':'PREPARANDO DESTINO'):'PROGRAME UM DESTINO';
    if(panel)this.panel(circuits);if(performance.now()>this.toastUntil)this.el.toast.classList.add('hidden');if(performance.now()>this.arrivalUntil)this.el['arrival-card'].classList.add('hidden');
  }
}
