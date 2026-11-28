import {readFile, writeFile, rename, unlink, mkdir, appendFile, stat} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {join, isAbsolute, extname, relative} from 'node:path';
import {TERMINAL} from './higgsfield.mjs';

const CONTENT_TYPES = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp'};
const EXTENSIONS = {'video/mp4': '.mp4', 'video/quicktime': '.mov', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp'};
export const PLACEHOLDER_URL = 'https://example.com/placeholder.png';
const CHARGED = new Set(['submitting', 'accepted', 'completed', 'downloaded']);
const UPLOAD_REUSE_MS = 12 * 3600 * 1000;
const money = value => `US$ ${value.toFixed(2)}`;
const sha256 = data => createHash('sha256').update(data).digest('hex');

export class RunnerStop extends Error {
  constructor(message, code) { super(message); this.name = 'RunnerStop'; this.code = code; }
}

/**
 * Serial, resumable generation queue. Specs: {id, title, model, output: 'video'|'images', inputs, params, expectUsd}.
 * inputs maps request fields to local files (relative to dir), {select: name} entries resolved from selection.json, or arrays of those.
 */
export function createRunner({dir, client, log = console.log, now = () => new Date(), uuid = randomUUID,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), random = Math.random, pollTimeoutMs = 60 * 60000, submitAttempts = 5}) {
  const statePath = join(dir, 'state.json'), ledgerPath = join(dir, 'ledger.jsonl'), lockPath = join(dir, 'state.lock');
  let state;

  async function load() {
    await mkdir(dir, {recursive: true});
    try { state = JSON.parse(await readFile(statePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; state = {version: 1, jobs: {}, uploads: {}}; }
    return state;
  }
  async function save() {
    const temporary = `${statePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2));
    await rename(temporary, statePath);
  }
  async function ledger(entry) { await appendFile(ledgerPath, JSON.stringify({at: now().toISOString(), ...entry}) + '\n'); }
  function event(record, name, note) { (record.events ||= []).push({at: now().toISOString(), state: name, ...(note ? {note} : {})}); }

  async function selection() {
    try { return JSON.parse(await readFile(join(dir, 'selection.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }

  async function resolveInputs(spec) {
    const chosen = await selection(), blocked = [];
    const one = reference => {
      let path = reference;
      if (reference?.select) path = chosen[reference.select];
      else if (reference?.output) {
        const source = state.jobs[reference.output];
        path = source?.state === 'downloaded' ? source.outputs?.[reference.index ?? 0]?.file : null;
      }
      if (!path) { blocked.push(reference.select || reference.output); return null; }
      return isAbsolute(path) ? path : join(dir, path);
    };
    const files = {};
    for (const [field, reference] of Object.entries(spec.inputs || {})) files[field] = Array.isArray(reference) ? reference.map(one) : one(reference);
    if (blocked.length) return {blocked};
    for (const path of Object.values(files).flat()) {
      if (!CONTENT_TYPES[extname(path).toLowerCase()]) throw new RunnerStop(`${spec.id}: tipo de arquivo não suportado (${extname(path)}).`, 'BAD_INPUT');
      try { await stat(path); } catch { throw new RunnerStop(`${spec.id}: entrada ausente: ${relative(dir, path)}`, 'MISSING_INPUT'); }
    }
    return {files};
  }

  async function specHash(spec, files) {
    const hashes = {};
    for (const [field, value] of Object.entries(files)) {
      hashes[field] = await Promise.all([value].flat().map(async path => sha256(await readFile(path))));
    }
    return sha256(JSON.stringify({model: spec.model, params: spec.params, inputs: hashes}));
  }

  const placeholders = files => Object.fromEntries(Object.entries(files).map(([field, value]) => [field, Array.isArray(value) ? value.map(() => PLACEHOLDER_URL) : PLACEHOLDER_URL]));

  const attemptsOf = record => [record, ...(record.attempts || [])];
  function committedUsd() {
    let total = 0;
    for (const record of Object.values(state.jobs)) for (const attempt of attemptsOf(record)) {
      if (CHARGED.has(attempt.state)) total += attempt.estimateUsd || 0;
    }
    return total;
  }

  async function uploadAll(files) {
    const urls = {};
    for (const [field, value] of Object.entries(files)) {
      const list = [];
      for (const path of [value].flat()) {
        const bytes = await readFile(path), hash = sha256(bytes), cached = state.uploads[hash];
        if (cached && now() - new Date(cached.at) < UPLOAD_REUSE_MS) { list.push(cached.url); continue; }
        const url = await client.upload(bytes, CONTENT_TYPES[extname(path).toLowerCase()]);
        state.uploads[hash] = {url, at: now().toISOString(), file: relative(dir, path)};
        await save();
        list.push(url);
      }
      urls[field] = Array.isArray(value) ? list : list[0];
    }
    return urls;
  }

  async function submit(record) {
    for (let attempt = 1; ; attempt++) {
      try { return await client.submit(record.model, record.body, {idempotencyKey: record.idempotencyKey}); }
      catch (error) {
        // Ambiguous failures and full queues are retried with the same key and identical body: no duplicate charge.
        if (!error.retryable || attempt >= submitAttempts) throw error;
        const wait = error.retryAfterMs ?? Math.min(30000, 2000 * 2 ** (attempt - 1)) + random() * 500;
        log(`  ${record.id}: ${error.message} · nova tentativa com a mesma chave em ${Math.round(wait / 1000)} s`);
        await sleep(wait);
      }
    }
  }

  async function poll(record) {
    const started = Date.now();
    let delay = 2000, last = '';
    while (true) {
      let status;
      try { status = await client.status(record.requestId); }
      catch (error) {
        if (!error.retryable && error.status !== undefined) throw error;
        status = null;
      }
      if (status?.status && status.status !== last) {
        last = status.status;
        log(`  ${record.id}: ${last}`);
        if (!TERMINAL.has(last) && record.state !== 'accepted') record.state = 'accepted';
      }
      if (status && TERMINAL.has(status.status)) return status;
      if (Date.now() - started > pollTimeoutMs) throw new RunnerStop(`${record.id}: sem resultado em ${Math.round(pollTimeoutMs / 60000)} min. Rode de novo para continuar acompanhando.`, 'POLL_TIMEOUT');
      await sleep(delay + random() * 500);
      delay = Math.min(delay * 1.5, 10000);
    }
  }

  function outputUrls(spec, status) {
    if (spec.output === 'video' || status.video?.url) return status.video?.url ? [status.video.url] : [];
    return (status.images || []).map(image => image?.url).filter(Boolean);
  }

  async function download(spec, record, status) {
    const urls = outputUrls(spec, status);
    if (!urls.length) throw new RunnerStop(`${spec.id}: concluído sem arquivo de saída.`, 'NO_OUTPUT');
    record.outputs = [];
    for (const [index, url] of urls.entries()) {
      let extension = extname(new URL(url).pathname).toLowerCase();
      if (!Object.values(EXTENSIONS).includes(extension)) extension = spec.output === 'video' ? '.mp4' : '.png';
      const name = `${spec.id}-${record.requestId.slice(0, 8)}${urls.length > 1 ? `-${index + 1}` : ''}${extension}`;
      const result = await client.download(url, join(dir, 'outputs', name));
      record.outputs.push({file: relative(dir, result.file), bytes: result.bytes, sha256: result.sha256, contentType: result.contentType});
    }
    record.expiresAt = status.expires_at;
  }

  async function finish(spec, record, status) {
    record.state = status.status;
    if (status.error) record.error = String(status.error).slice(0, 500);
    event(record, status.status);
    await ledger({jobId: spec.id, requestId: record.requestId, event: status.status, usd: status.status === 'completed' ? record.estimateUsd : 0});
    await save();
    if (status.status !== 'completed') { log(`  ${spec.id}: ${status.status}${record.error ? ` (${record.error})` : ''} · sem cobrança`); return; }
    await download(spec, record, status);
    record.state = 'downloaded'; event(record, 'downloaded');
    await save();
    log(`  ${spec.id}: salvo em ${record.outputs.map(output => output.file).join(', ')}`);
  }

  async function lock() {
    await mkdir(dir, {recursive: true});
    try { await writeFile(lockPath, String(process.pid), {flag: 'wx'}); }
    catch (error) {
      if (error.code === 'EEXIST') throw new RunnerStop('Outra execução está em andamento (state.lock). Se não houver, apague o arquivo.', 'LOCKED');
      throw error;
    }
  }

  return {
    get state() { return state; },
    load, committedUsd,

    /** Dry run: validates inputs and asks /estimate (free) with placeholder URLs. Never uploads or submits. */
    async plan(specs, {only} = {}) {
      await load();
      const rows = [];
      for (const spec of specs.filter(item => !only || only.includes(item.id))) {
        const record = state.jobs[spec.id];
        if (record && record.state !== 'new') { rows.push({spec, state: record.state, usd: record.estimateUsd, done: true}); continue; }
        const resolved = await resolveInputs(spec);
        if (resolved.blocked) { rows.push({spec, state: 'aguardando escolha', blocked: resolved.blocked}); continue; }
        const usd = await client.estimate(spec.model, {...spec.params, ...placeholders(resolved.files)});
        state.jobs[spec.id] = {...(record || {}), id: spec.id, model: spec.model, state: 'new', estimateUsd: usd, estimatedAt: now().toISOString()};
        rows.push({spec, state: 'new', usd, overrun: spec.expectUsd !== undefined && usd > spec.expectUsd * 1.25 + .005});
      }
      await save();
      return {rows, committed: committedUsd(), pending: rows.filter(row => row.state === 'new').reduce((sum, row) => sum + row.usd, 0)};
    },

    async run(specs, {maxUsd, only, allowOverrun = false} = {}) {
      if (!(maxUsd > 0)) throw new RunnerStop('Informe o teto de gasto com --max-usd.', 'NO_BUDGET');
      await load();
      await lock();
      try {
        for (const spec of specs.filter(item => !only || only.includes(item.id))) {
          let record = state.jobs[spec.id];
          if (record?.state === 'downloaded') continue;
          if (['failed', 'nsfw', 'canceled', 'rejected'].includes(record?.state)) { log(`= ${spec.id}: ${record.state} anteriormente; use --retry ${spec.id} para tentar de novo.`); continue; }
          if (record?.state === 'completed') { await finish(spec, record, await client.status(record.requestId)); continue; }
          if (record?.state === 'accepted' || (record?.state === 'submitting' && record.requestId)) {
            log(`> ${spec.id}: acompanhando ${record.requestId}`);
            await finish(spec, record, await poll(record));
            continue;
          }
          if (record?.state === 'submitting') {
            log(`> ${spec.id}: reenviando com a mesma chave (resposta anterior incerta)`);
          } else {
            const resolved = await resolveInputs(spec);
            if (resolved.blocked) { log(`= ${spec.id}: aguardando escolha (${resolved.blocked.join(', ')})`); continue; }
            const usd = await client.estimate(spec.model, {...spec.params, ...placeholders(resolved.files)});
            if (spec.expectUsd !== undefined && usd > spec.expectUsd * 1.25 + .005 && !allowOverrun) {
              throw new RunnerStop(`${spec.id} custaria ${money(usd)}, acima do previsto (${money(spec.expectUsd)}). Nada foi enviado.`, 'OVERRUN');
            }
            if (committedUsd() + usd > maxUsd + 1e-9) {
              throw new RunnerStop(`${spec.id} (${money(usd)}) passaria do teto: ${money(committedUsd())} já comprometidos de ${money(maxUsd)}.`, 'BUDGET');
            }
            const hash = await specHash(spec, resolved.files);
            const urls = await uploadAll(resolved.files);
            record = state.jobs[spec.id] = {
              id: spec.id, title: spec.title, model: spec.model, specHash: hash, estimateUsd: usd, state: 'submitting',
              idempotencyKey: uuid(), body: {...spec.params, ...urls}, inputs: Object.fromEntries(Object.entries(resolved.files).map(([field, value]) => [field, Array.isArray(value) ? value.map(path => relative(dir, path)) : relative(dir, value)])),
              attempts: record?.attempts || [], events: [],
            };
            event(record, 'submitting');
            await save(); // key and body are durable before the request leaves
            log(`> ${spec.id}: enviando (${money(usd)}) · ${spec.title}`);
          }
          let accepted;
          try { accepted = await submit(record); }
          catch (error) {
            if (error.ambiguous) { await save(); throw new RunnerStop(`${spec.id}: resposta incerta (${error.message}). Rode de novo: o reenvio usa a mesma chave.`, 'AMBIGUOUS'); }
            record.state = 'rejected'; record.error = error.message; event(record, 'rejected', error.message);
            await save();
            throw new RunnerStop(`${spec.id}: recusado antes de começar, sem cobrança. ${error.message}`, 'REJECTED');
          }
          Object.assign(record, {state: 'accepted', requestId: accepted.request_id, correlationId: accepted.correlationId});
          event(record, 'accepted');
          await save();
          await ledger({jobId: spec.id, requestId: record.requestId, event: 'accepted', usd: record.estimateUsd});
          await finish(spec, record, await poll(record));
        }
      } finally { await unlink(lockPath).catch(() => {}); }
      return {committed: committedUsd()};
    },

    /** Keeps the old attempt for the books and lets the job run again with a new key. */
    async retry(id) {
      await load();
      const record = state.jobs[id];
      if (!record) throw new RunnerStop(`Trabalho ${id} não existe.`, 'UNKNOWN_JOB');
      if (['submitting', 'accepted'].includes(record.state)) throw new RunnerStop(`${id} ainda está em andamento.`, 'BUSY');
      const {attempts = [], ...previous} = record;
      state.jobs[id] = {id, model: record.model, state: 'new', attempts: [...attempts, previous]};
      await save();
    },
  };
}
