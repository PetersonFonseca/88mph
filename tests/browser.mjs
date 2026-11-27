import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Run with the dev server already started: node tests/browser.mjs
// CHROME_PATH overrides the browser executable; BROWSER_URL overrides localhost.
const baseURL = process.env.BROWSER_URL || 'http://127.0.0.1:5173';
const output = new URL('../artifacts/browser/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined),
  headless: true,
  args: process.platform === 'darwin' ? ['--use-angle=metal'] : [],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(20000);
const errors = [], warnings = [];
const report = { startedAt: new Date().toISOString(), browser: browser.version(), baseURL, checks: [], memory: [], projections: [], errors, warnings };
page.on('pageerror', error => errors.push(error.stack || error.message));
page.on('response', response => {
  if (response.status() >= 400) { const detail = `HTTP ${response.status()}: ${response.url()}`; warnings.push(detail); console.warn(detail); }
});
page.on('console', message => {
  if (message.type() === 'error') { const detail = `${message.text()} @ ${message.location().url}`; errors.push(detail); console.error(detail); }
  if (message.type() === 'warning') warnings.push(message.text());
});
const snapshot = () => page.evaluate(() => window.__game.debug.snapshot());
const readyFrames = (count = 5) => page.evaluate(n => window.__game.debug.frames(n), count);
async function check(name, fn) {
  const start = performance.now();
  try {
    await fn();
    report.checks.push({ name, passed: true, elapsedMs: Math.round(performance.now() - start) });
    await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2));
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, passed: false, error: error.stack || error.message });
    console.error(`FAIL ${name}: ${error.message}`);
    throw error;
  }
}
async function travel(date, era) {
  await page.evaluate(value => window.__game.debug.travel(value), date);
  await page.waitForFunction(expected => {
    const state = window.__game.debug.snapshot();
    return state.mode === 'car' && state.era === expected && state.destination === null;
  }, era, { timeout: 45000 });
  await page.evaluate(() => { window.__game.debug.setSpeedMph(0); window.__game.debug.setPosition(0, 200, 0); });
  return readyFrames(6);
}

try {
  await check('Inicialização WebGL e imagem original de abertura', async () => {
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__game && document.documentElement.dataset.ready === 'true', null, { timeout: 90000 });
    assert.equal((await snapshot()).mode, 'title');
    await page.screenshot({ path: new URL('title.png', output).pathname });
  });
  await check('Teclado real: caminhar, abrir porta com E e entrar com E', async () => {
    await page.locator('#start').click();
    await page.waitForFunction(() => window.__game.state.mode === 'walk');
    // Aim at the driver door; the initial title composition points at the car's body.
    await page.evaluate(() => {
      const g = window.__game, door = g.car.driverPoint();
      g.debug.look(Math.atan2(g.walker.position.x - door.x, g.walker.position.z - door.z));
    });
    await page.keyboard.down('w');
    try { await page.waitForFunction(() => window.__game.car.canEnter(window.__game.walker), null, { timeout: 15000 }); }
    finally { await page.keyboard.up('w'); }
    await page.keyboard.press('e');
    assert.equal((await snapshot()).car.doorOpen, true);
    await page.keyboard.press('e');
    assert.equal((await snapshot()).mode, 'car');
  });
  await check('Painel real: data inválida, Backspace, 12 dígitos e Enter', async () => {
    await page.keyboard.press('t');
    await page.keyboard.type('023119551200');
    await page.keyboard.press('Enter');
    assert.equal((await snapshot()).mode, 'panel');
    assert.match(await page.evaluate(() => window.__game.circuits.error), /dia não existe/);
    for (let i = 0; i < 12; i++) await page.keyboard.press('Backspace');
    await page.keyboard.type('110519550600');
    await readyFrames(6);
    await page.screenshot({ path: new URL('panel.png', output).pathname });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__game.debug.snapshot().prepared);
    assert.equal((await snapshot()).destination.year, 1955);
  });
  await check('Aceleração dispara a viagem e chega aos Anos 50', async () => {
    await page.evaluate(() => { window.__game.debug.setPosition(0, 200, 0); window.__game.debug.setSpeedMph(87.9); });
    await page.keyboard.down('w');
    try { await page.waitForFunction(() => window.__game.state.mode === 'departure'); }
    finally { await page.keyboard.up('w'); }
    await page.waitForFunction(() => window.__game.state.mode === 'car' && window.__game.world.current.era === 'fifties', null, { timeout: 45000 });
    assert.equal((await snapshot()).date.hour, 6);
    assert.ok((await snapshot()).speedMph > 70, 'A chegada deve preservar velocidade e exigir frenagem.');
    await page.keyboard.down('Space');
    try { await page.waitForFunction(() => Math.abs(window.__game.car.physics.speedMph) < 1, null, { timeout: 15000 }); }
    finally { await page.keyboard.up('Space'); }
    await page.keyboard.press('e');
    assert.equal((await snapshot()).mode, 'walk');
    const before = (await snapshot()).walker;
    await page.keyboard.down('s');
    await readyFrames(20);
    await page.keyboard.up('s');
    const after = (await snapshot()).walker;
    assert.ok(Math.hypot(before.x - after.x, before.z - after.z) > 0.1);
  });
  await check('Ciclo entre as quatro épocas', async () => {
    for (const [date, era] of [['010118851200', 'oldwest'], ['102120772200', 'future'], ['111120262204', 'present']]) {
      const state = await travel(date, era);
      assert.equal(state.era, era);
      await page.keyboard.press('c');
      await readyFrames(3);
      await page.screenshot({ path: new URL(`${era}.png`, output).pathname });
      await page.keyboard.press('c');
    }
  });
  await check('Sem destino, 88 mph não inicia outra viagem', async () => {
    await page.evaluate(() => { window.__game.debug.setPosition(0, 200, 0); window.__game.debug.setSpeedMph(90); });
    await readyFrames(20);
    assert.equal((await snapshot()).mode, 'car');
    await page.evaluate(() => window.__game.debug.setSpeedMph(0));
  });
  await check('Pause/resume e limpeza de teclas', async () => {
    await page.keyboard.down('w');
    await page.keyboard.press('h');
    await page.keyboard.up('w');
    assert.equal((await snapshot()).paused, true);
    assert.equal(await page.evaluate(() => window.__game.input.keys.size), 0);
    await page.keyboard.press('h');
    assert.equal((await snapshot()).paused, false);
    await page.evaluate(() => window.__game.debug.setSpeedMph(0));
  });
  await check('Projeção da cabine: 4:3, 16:9 e 21:9', async () => {
    for (const [name, width, height] of [['4x3', 1024, 768], ['16x9', 1280, 720], ['21x9', 1680, 720]]) {
      await page.setViewportSize({ width, height });
      await readyFrames(20);
      const result = await page.evaluate(() => {
        const { camera } = window.__game.engine, p = window.__game.cockpit.projection;
        const vanishing = camera.position.clone().set(0, 0, -100).applyMatrix4(camera.matrixWorld).project(camera);
        const pixel = { x: (vanishing.x * 0.5 + 0.5) * innerWidth, y: (-vanishing.y * 0.5 + 0.5) * innerHeight };
        return { projection: p, pixel, error: Math.hypot(pixel.x - p.vanishingX, pixel.y - p.vanishingY) };
      });
      assert.ok(result.error < 0.01, `Erro de projeção ${result.error}px`);
      report.projections.push({ name, ...result });
      await page.screenshot({ path: new URL(`cockpit-${name}.png`, output).pathname });
    }
    await page.setViewportSize({ width: 1280, height: 720 });
  });
  await check('24 horários sem crescimento de programas shader', async () => {
    const before = (await snapshot()).programs;
    const counts = [];
    for (let hour = 0; hour < 24; hour++) {
      await page.evaluate(hour => { const game = window.__game; game.sky.setDate({ ...game.circuits.now, hour }, 'present'); }, hour);
      counts.push((await readyFrames(2)).programs);
    }
    assert.ok(Math.max(...counts) <= before, `Shaders: ${before} → ${Math.max(...counts)}`);
    report.hourShaderCounts = counts;
    await page.evaluate(() => { const game = window.__game; game.sky.setDate(game.circuits.now, 'present'); });
  });
  await check('10 idas e voltas: memória GPU e programas estáveis', async () => {
    const baseline = await travel('111120262204', 'present');
    report.memory.push({ round: 0, ...baseline.memory, programs: baseline.programs });
    for (let round = 1; round <= 10; round++) {
      await travel('010118851200', 'oldwest');
      const state = await travel('111120262204', 'present');
      report.memory.push({ round, ...state.memory, programs: state.programs });
      await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2));
      console.log(`MEMORY ${JSON.stringify(report.memory.at(-1))}`);
      assert.equal(state.memory.geometries, baseline.memory.geometries, `Geometrias na volta ${round}`);
      assert.equal(state.memory.textures, baseline.memory.textures, `Texturas na volta ${round}`);
      assert.equal(state.programs, baseline.programs, `Programas na volta ${round}`);
    }
  });
  await check('Amostra de desempenho a 1080p', async () => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await readyFrames(15);
    report.benchmark = await page.evaluate(async () => {
      const times = [];
      for (let i = 0; i < 120; i++) { await new Promise(requestAnimationFrame); times.push(window.__game.metrics.frameMs); }
      const sorted = [...times].sort((a, b) => a - b);
      const mean = times.reduce((a, b) => a + b, 0) / times.length;
      return { viewport: [innerWidth, innerHeight], meanMs: mean, medianMs: sorted[60], p95Ms: sorted[114], fpsFromMean: 1000 / mean, note: 'Chrome headless local; não equivale a uma garantia de 60 FPS em todo hardware.' };
    });
  });
  assert.deepEqual(errors, [], 'Console e pageerrors devem estar limpos.');
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error.stack || error.message;
  try { await page.screenshot({ path: new URL('failure.png', output).pathname }); report.lastSnapshot = await snapshot(); } catch { /* Preserve the original failure. */ }
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2));
  await browser.close();
  console.log(`Relatório: ${new URL('report.json', output).pathname}`);
}
