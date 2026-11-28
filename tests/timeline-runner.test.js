import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHiggsfield} from '../scripts/timeline/lib/higgsfield.mjs';
import {createRunner, RunnerStop, PLACEHOLDER_URL} from '../scripts/timeline/lib/runner.mjs';
import {parseEnv, higgsfieldCredentials, redact} from '../scripts/timeline/lib/env.mjs';

const CREDENTIALS = 'key-id-123456:super-secret-value-987654';
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json', ...headers}});

/** Scripted fake of the Higgsfield API plus storage/CDN hosts. */
function fakeApi({estimate = () => '0.32', submit, statuses = ['queued', 'in_progress', 'completed'], output = 'video'} = {}) {
  const calls = [], requests = new Map(), keys = new Map();
  let submitted = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input), headers = new Headers(init.headers), body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    calls.push({url, method: init.method || 'GET', headers, body});
    if (url.origin === 'https://api.higgsfield.ai') {
      if (url.pathname.startsWith('/estimate/')) return json({usd: estimate(url.pathname.slice(10), body)});
      if (url.pathname === '/files/generate-upload-url') {
        const id = calls.length;
        return json({upload_url: `https://storage.example.net/put/${id}`, public_url: `https://cdn.example.net/in/${id}.png`, content_type: body.content_type, upload_headers: {'Content-Type': body.content_type, 'x-amz-tagging': 'retention=temporary'}});
      }
      const status = /^\/requests\/([^/]+)\/status$/.exec(url.pathname);
      if (status) {
        const entry = requests.get(status[1]);
        const state = entry.statuses[Math.min(entry.polls++, entry.statuses.length - 1)];
        if (state !== 'completed') return json({status: state, request_id: status[1], ...(state === 'failed' ? {error: 'Generation failed'} : {})});
        return json(output === 'video'
          ? {status: 'completed', request_id: status[1], video: {url: `https://cdn.example.net/out/${status[1]}.mp4`}, expires_at: '2026-12-04T00:00:00Z'}
          : {status: 'completed', request_id: status[1], images: [{url: `https://cdn.example.net/out/${status[1]}.png`}]});
      }
      if (init.method === 'POST') {
        const custom = submit?.({url, headers, body, attempt: ++submitted});
        if (custom) return custom;
        const key = headers.get('idempotency-key');
        if (!keys.has(key)) keys.set(key, `${String(keys.size + 1).padStart(8, '0')}-0000-4000-8000-000000000000`);
        const id = keys.get(key);
        if (!requests.has(id)) requests.set(id, {statuses: [...statuses], polls: 0, body});
        return json({status: 'queued', request_id: id, status_url: `https://api.higgsfield.ai/requests/${id}/status`});
      }
    }
    if (url.hostname === 'storage.example.net') return new Response(null, {status: 200});
    if (url.hostname === 'cdn.example.net') return new Response(new Uint8Array([1, 2, 3, 4]), {status: 200, headers: {'Content-Type': output === 'video' ? 'video/mp4' : 'image/png'}});
    throw new Error(`host inesperado ${url.href}`);
  };
  return {fetchImpl, calls, requests};
}

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'timeline-runner-'));
  await mkdir(join(dir, 'keyframes'));
  await writeFile(join(dir, 'keyframes', 'a.png'), 'frame-a');
  await writeFile(join(dir, 'keyframes', 'b.png'), 'frame-b');
  return dir;
}
const spec = (id, extra = {}) => ({id, title: id, model: 'sand/magi-2/image-to-video', output: 'video', expectUsd: .32,
  inputs: {image_url: 'keyframes/a.png', end_image_url: 'keyframes/b.png'},
  params: {prompt: 'drive forward', duration: 4, aspect_ratio: '16:9', resolution: '1080p', seed: 7, generate_audio: false}, ...extra});
const quiet = () => {};
function runnerFor(dir, api, extra = {}) {
  let n = 0;
  return createRunner({dir, client: createHiggsfield({credentials: CREDENTIALS, fetchImpl: api.fetchImpl}), log: quiet,
    sleep: async () => {}, random: () => 0, uuid: () => `key-${++n}`, ...extra});
}

test('env parsing and credentials never echo secrets', () => {
  assert.deepEqual(parseEnv('# c\nA=1\nexport B="two words"\nC=x # note\n'), {A: '1', B: 'two words', C: 'x'});
  assert.equal(higgsfieldCredentials({HF_CREDENTIALS: CREDENTIALS}), CREDENTIALS);
  assert.equal(higgsfieldCredentials({HF_API_KEY_ID: 'abcdef', HF_API_KEY_SECRET: 'ghijkl'}), 'abcdef:ghijkl');
  assert.throws(() => higgsfieldCredentials({}), error => error.code === 'HF_CREDENTIALS_MISSING');
  assert.throws(() => higgsfieldCredentials({HF_CREDENTIALS: 'sem-dois-pontos'}), error => !error.message.includes('sem-dois-pontos'));
  assert.equal(redact(`falhou com ${CREDENTIALS} e super-secret-value-987654`, [CREDENTIALS]), 'falhou com *** e ***');
});

test('plan only estimates, with placeholder URLs: no upload, no submission', async () => {
  const dir = await workspace(), api = fakeApi({estimate: () => '0.48'});
  try {
    const result = await runnerFor(dir, api).plan([spec('T1'), spec('T4', {inputs: {image_url: {select: 'portal1955'}}})]);
    assert.equal(api.calls.length, 1);
    assert.equal(api.calls[0].url.pathname, '/estimate/sand/magi-2/image-to-video');
    assert.equal(api.calls[0].body.image_url, PLACEHOLDER_URL);
    assert.equal(api.calls[0].body.duration, 4);
    assert.equal(result.rows[0].overrun, true, '0,48 > 0,32 previsto');
    assert.deepEqual(result.rows[1].blocked, ['portal1955']);
    assert.equal(result.committed, 0);
  } finally { await rm(dir, {recursive: true}); }
});

test('run uploads, submits once with a durable idempotency key, polls and downloads without sending credentials elsewhere', async () => {
  const dir = await workspace(), api = fakeApi();
  try {
    const runner = runnerFor(dir, api);
    const result = await runner.run([spec('T1')], {maxUsd: 6});
    assert.equal(result.committed, .32);
    const record = runner.state.jobs.T1;
    assert.equal(record.state, 'downloaded');
    assert.equal(record.idempotencyKey, 'key-1');
    assert.match(record.body.image_url, /^https:\/\/cdn\.example\.net\/in\//);
    assert.equal(record.body.generate_audio, false);
    assert.equal((await readFile(join(dir, record.outputs[0].file))).length, 4);
    assert.equal(record.outputs[0].file, 'outputs/T1-00000001.mp4');
    const submits = api.calls.filter(call => call.url.pathname === '/sand/magi-2/image-to-video');
    assert.equal(submits.length, 1);
    assert.equal(submits[0].headers.get('idempotency-key'), 'key-1');
    for (const call of api.calls) {
      const auth = call.headers.get('authorization');
      if (call.url.origin === 'https://api.higgsfield.ai') assert.equal(auth, `Key ${CREDENTIALS}`);
      else assert.equal(auth, null, `credencial vazou para ${call.url.host}`);
    }
    const ledger = (await readFile(join(dir, 'ledger.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(ledger.map(entry => entry.event), ['accepted', 'completed']);
    // A second run does nothing: no duplicate charge.
    const before = api.calls.length;
    await runner.run([spec('T1')], {maxUsd: 6});
    assert.equal(api.calls.length, before);
  } finally { await rm(dir, {recursive: true}); }
});

test('ambiguous submission failures are retried with the same key and identical body', async () => {
  const dir = await workspace(), api = fakeApi({submit: ({attempt}) => attempt === 1 ? new Response('upstream', {status: 502}) : null});
  try {
    const runner = runnerFor(dir, api);
    await runner.run([spec('T1')], {maxUsd: 6});
    const submits = api.calls.filter(call => call.url.pathname === '/sand/magi-2/image-to-video');
    assert.equal(submits.length, 2);
    assert.equal(submits[0].headers.get('idempotency-key'), submits[1].headers.get('idempotency-key'));
    assert.deepEqual(submits[0].body, submits[1].body);
    assert.equal(api.requests.size, 1);
  } finally { await rm(dir, {recursive: true}); }
});

test('a network failure that outlasts retries stops; the next run resends the same key instead of a new request', async () => {
  const dir = await workspace();
  let down = true;
  const api = fakeApi({submit: () => down ? (() => { throw new TypeError('fetch failed'); })() : null});
  try {
    const runner = runnerFor(dir, api, {submitAttempts: 2});
    await assert.rejects(runner.run([spec('T1')], {maxUsd: 6}), error => error instanceof RunnerStop && error.code === 'AMBIGUOUS');
    assert.equal(runner.state.jobs.T1.state, 'submitting');
    assert.equal(runner.committedUsd(), .32, 'pode ter sido aceito: conta como comprometido');
    down = false;
    await runner.run([spec('T1')], {maxUsd: 6});
    const keys = new Set(api.calls.filter(call => call.url.pathname === '/sand/magi-2/image-to-video').map(call => call.headers.get('idempotency-key')));
    assert.deepEqual([...keys], ['key-1']);
    assert.equal(runner.state.jobs.T1.state, 'downloaded');
  } finally { await rm(dir, {recursive: true}); }
});

test('budget and overrun guards stop before anything is uploaded or submitted', async () => {
  const dir = await workspace(), api = fakeApi({estimate: (model, body) => body.duration === 8 ? '0.64' : '0.32'});
  try {
    const runner = runnerFor(dir, api);
    await assert.rejects(runner.run([spec('T1')], {}), error => error.code === 'NO_BUDGET');
    await assert.rejects(runner.run([spec('T1'), spec('T2')], {maxUsd: .5}), error => error.code === 'BUDGET');
    assert.equal(runner.state.jobs.T1.state, 'downloaded');
    assert.equal(runner.state.jobs.T2, undefined);
    const expensive = spec('T5', {params: {...spec('T5').params, duration: 8}});
    await assert.rejects(runner.run([expensive], {maxUsd: 6}), error => error.code === 'OVERRUN');
    assert.equal(api.calls.filter(call => call.url.pathname === '/files/generate-upload-url').length, 2, 'só as duas entradas do T1');
  } finally { await rm(dir, {recursive: true}); }
});

test('failed and moderated requests are free; the queue moves on; retry keeps the history', async () => {
  const dir = await workspace(), api = fakeApi({statuses: ['queued', 'nsfw']});
  try {
    const runner = runnerFor(dir, api);
    await runner.run([spec('T1'), spec('T2')], {maxUsd: 6});
    assert.equal(runner.state.jobs.T1.state, 'nsfw');
    assert.equal(runner.state.jobs.T2.state, 'nsfw');
    assert.equal(runner.committedUsd(), 0);
    await runner.retry('T1');
    assert.equal(runner.state.jobs.T1.attempts.length, 1);
    assert.equal(runner.state.jobs.T1.state, 'new');
  } finally { await rm(dir, {recursive: true}); }
});

test('rejected requests stop the run with a readable, redacted message', async () => {
  const dir = await workspace();
  const api = fakeApi({submit: () => json({detail: [{loc: ['body', 'duration'], msg: `must be >= 4 (${CREDENTIALS})`}]}, 422)});
  try {
    const runner = runnerFor(dir, api);
    await assert.rejects(runner.run([spec('T1')], {maxUsd: 6}), error => {
      assert.equal(error.code, 'REJECTED');
      assert.match(error.message, /duration: must be >= 4/);
      assert.ok(!error.message.includes('super-secret-value'));
      return true;
    });
    assert.equal(runner.committedUsd(), 0);
  } finally { await rm(dir, {recursive: true}); }
});

test('selected inputs resolve from selection.json; image outputs are saved with their own names', async () => {
  const dir = await workspace(), api = fakeApi({output: 'images', estimate: () => '0.05'});
  try {
    await writeFile(join(dir, 'selection.json'), JSON.stringify({portal1955: 'keyframes/b.png'}));
    const edit = {id: 'I7', title: 'continuidade', model: 'bytedance/seedream/v5.0/pro/edit', output: 'images', expectUsd: .15,
      inputs: {image_urls: ['keyframes/a.png', {select: 'portal1955'}]}, params: {prompt: 'make it 1955', aspect_ratio: '16:9', resolution: '2k'}};
    const runner = runnerFor(dir, api);
    await runner.run([edit], {maxUsd: 6});
    const record = runner.state.jobs.I7;
    assert.equal(record.body.image_urls.length, 2);
    assert.deepEqual(record.inputs.image_urls, ['keyframes/a.png', 'keyframes/b.png']);
    assert.equal(record.outputs[0].file, 'outputs/I7-00000001.png');
    assert.equal(record.outputs[0].contentType, 'image/png');
  } finally { await rm(dir, {recursive: true}); }
});
