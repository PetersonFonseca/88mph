import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Focused verification after visual changes. Keeps full-validation.json intact.
const output = new URL('../artifacts/browser/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined),
  headless: true,
  args: process.platform === 'darwin' ? ['--use-angle=metal'] : [],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(45000);
const report = { startedAt: new Date().toISOString(), browser: browser.version(), checks: [], errors: [], warnings: [], memory: [] };
page.on('pageerror', error => report.errors.push(error.stack || error.message));
page.on('console', message => {
  if (message.type() === 'error') report.errors.push(`${message.text()} @ ${message.location().url}`);
  if (message.type() === 'warning') report.warnings.push(message.text());
});
page.on('response', response => { if (response.status() >= 400) report.errors.push(`HTTP ${response.status()}: ${response.url()}`); });
const frames = count => page.evaluate(n => window.__game.debug.frames(n), count);
async function travel(date, era) {
  await page.evaluate(value => window.__game.debug.travel(value), date);
  await page.waitForFunction(expected => {
    const state = window.__game.debug.snapshot();
    return state.mode === 'car' && state.era === expected && state.destination === null;
  }, era);
  await page.evaluate(() => { window.__game.debug.setPosition(0, 200, 0); });
  return frames(8);
}
async function check(name, fn) {
  await fn();
  report.checks.push({ name, passed: true });
  await writeFile(new URL('visual-validation.json', output), JSON.stringify(report, null, 2));
  console.log(`PASS ${name}`);
}
try {
  await page.goto(process.env.BROWSER_URL || 'http://127.0.0.1:5173', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__game, null, { timeout: 90000 });
  await check('Iluminação dos postes e captura noturna', async () => {
    await page.evaluate(() => {
      const g = window.__game;
      g.debug.enterCar(); g.debug.setPosition(0, 105, 0);
      g.car.view = 'external'; g.hud.toastUntil = 0; g.hud.arrivalUntil = 0;
    });
    report.lighting = await page.evaluate(() => ({ lampCount: window.__game.world.current.lamps.length, bloom: window.__game.engine.bloom.strength, exposure: window.__game.engine.renderer.toneMappingExposure }));
    await frames(30);
    await page.screenshot({ path: new URL('final-postes.png', output).pathname });
  });
  await check('Painel e máscaras da terceira linha', async () => {
    await page.keyboard.press('t');
    await page.keyboard.type('110519550600');
    await frames(90);
    await page.screenshot({ path: new URL('final-panel.png', output).pathname });
    assert.equal(await page.evaluate(() => window.__game.circuits.buffer), '110519550600');
    await page.keyboard.press('t');
  });
  await check('24 horários sem recompilar shaders', async () => {
    await frames(60);
    const before = await page.evaluate(() => window.__game.engine.renderer.info.programs.length);
    report.hourShaderCounts = [];
    for (let hour = 0; hour < 24; hour++) {
      await page.evaluate(hour => { const g = window.__game; g.sky.setDate({ ...g.circuits.now, hour }, 'present'); }, hour);
      report.hourShaderCounts.push((await frames(2)).programs);
    }
    assert.ok(Math.max(...report.hourShaderCounts) <= before);
    await page.evaluate(() => { const g = window.__game; g.sky.setDate(g.circuits.now, 'present'); });
  });
  await check('Duas idas e voltas mantêm memória estável', async () => {
    const baseline = await travel('111120262204', 'present');
    report.memory.push({ round: 0, ...baseline.memory, programs: baseline.programs });
    for (let round = 1; round <= 2; round++) {
      await travel('010118851200', 'oldwest');
      const state = await travel('111120262204', 'present');
      report.memory.push({ round, ...state.memory, programs: state.programs });
      assert.deepEqual(state.memory, baseline.memory);
      assert.equal(state.programs, baseline.programs);
    }
  });
  await check('Console sem erros ou avisos', async () => {
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.warnings, []);
  });
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error.stack || error.message;
  console.error(report.failure);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(new URL('visual-validation.json', output), JSON.stringify(report, null, 2));
  await browser.close();
  console.log(`Relatório: ${new URL('visual-validation.json', output).pathname}`);
}
