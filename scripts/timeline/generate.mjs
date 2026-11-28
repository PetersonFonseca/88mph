#!/usr/bin/env node
// Look-dev generation queue for the Paulista timeline (Higgsfield API). Dry run by default.
import {parseArgs} from 'node:util';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {loadEnv, higgsfieldCredentials, TIMELINE_DIR} from './lib/env.mjs';
import {createHiggsfield} from './lib/higgsfield.mjs';
import {createRunner} from './lib/runner.mjs';
import {lookdevShots} from './shots/lookdev.mjs';

const USAGE = `Uso:
  node scripts/timeline/generate.mjs plan [--only I1,T1]          estima custos (grátis); não envia nada
  node scripts/timeline/generate.mjs run --max-usd 6 [--only ...]  executa em fila, com teto de gasto
  node scripts/timeline/generate.mjs status                        estado, saídas e gasto comprometido
  node scripts/timeline/generate.mjs select I4[:1]                 usa a saída de I4 como chegada em 1955
  node scripts/timeline/generate.mjs retry T2                      libera um trabalho para nova tentativa`;

const money = value => `US$ ${(value ?? 0).toFixed(2)}`;
const pad = (text, size) => String(text ?? '').padEnd(size).slice(0, size);

async function readSelection() {
  try { return JSON.parse(await readFile(join(TIMELINE_DIR, 'selection.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

async function main() {
  const {values, positionals} = parseArgs({allowPositionals: true, options: {
    only: {type: 'string'}, 'max-usd': {type: 'string'}, 'allow-overrun': {type: 'boolean', default: false},
  }});
  const [command, argument] = positionals;
  if (!command) { console.log(USAGE); return; }
  const only = values.only?.split(',').map(value => value.trim()).filter(Boolean);
  const env = loadEnv(), dir = TIMELINE_DIR;
  const needsApi = ['plan', 'run'].includes(command);
  const client = needsApi ? createHiggsfield({credentials: higgsfieldCredentials(env)}) : null;
  const runner = createRunner({dir, client});
  const specs = await lookdevShots({dir, selection: await readSelection()});

  if (command === 'plan') {
    const {rows, committed, pending} = await runner.plan(specs, {only});
    for (const row of rows) {
      const note = row.blocked ? `aguardando ${row.blocked.join(', ')}` : row.done ? row.state
        : row.overrun ? `ACIMA DO PREVISTO (${money(row.spec.expectUsd)})` : `previsto ${money(row.spec.expectUsd)}`;
      console.log(`${pad(row.spec.id, 4)} ${pad(row.spec.title, 58)} ${row.usd === undefined ? '      —' : money(row.usd).padStart(9)}  ${note}`);
    }
    console.log(`\nA enviar agora: ${money(pending)} · já comprometido: ${money(committed)} · itens bloqueados dependem da escolha do visual de 1955.`);
    return;
  }
  if (command === 'run') {
    const maxUsd = Number(values['max-usd']);
    const {committed} = await runner.run(specs, {maxUsd, only, allowOverrun: values['allow-overrun']});
    console.log(`\nConcluído. Gasto comprometido: ${money(committed)} de ${money(maxUsd)}.`);
    return;
  }
  if (command === 'status') {
    const state = await runner.load();
    for (const spec of specs) {
      const record = state.jobs[spec.id];
      const outputs = record?.outputs?.map(output => output.file).join(', ') || '';
      console.log(`${pad(spec.id, 4)} ${pad(spec.title, 58)} ${pad(record?.state || '—', 11)} ${record?.estimateUsd === undefined ? '' : money(record.estimateUsd)} ${outputs}`);
    }
    console.log(`\nGasto comprometido: ${money(runner.committedUsd())}.`);
    return;
  }
  if (command === 'select') {
    const [id, index = '1'] = String(argument || '').split(':');
    const state = await runner.load(), record = state.jobs[id];
    const output = record?.state === 'downloaded' ? record.outputs?.[Number(index) - 1] : null;
    if (!output) throw new Error(`${id || '?'} não tem a saída ${index} baixada.`);
    const selection = {...await readSelection(), portal1955: output.file, model1955: record.model, chosenJob: id, chosenAt: new Date().toISOString()};
    await writeFile(join(dir, 'selection.json'), JSON.stringify(selection, null, 2));
    console.log(`Chegada em 1955: ${output.file} (${record.model}).`);
    return;
  }
  if (command === 'retry') {
    await runner.retry(argument);
    console.log(`${argument} liberado para nova tentativa; a anterior fica no histórico.`);
    return;
  }
  console.log(USAGE);
  process.exitCode = 1;
}

main().catch(error => {
  console.error(`Erro: ${error.message}${error.correlationId ? ` (X-Correlation-ID ${error.correlationId})` : ''}`);
  process.exitCode = error.name === 'RunnerStop' ? 2 : 1;
});
