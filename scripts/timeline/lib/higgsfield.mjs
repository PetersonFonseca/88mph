import {createWriteStream} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname} from 'node:path';
import {redact} from './env.mjs';
import {temporaryPath, publish} from './ffmpeg.mjs';

export const API_ORIGIN = 'https://api.higgsfield.ai';
export const TERMINAL = new Set(['completed', 'failed', 'nsfw', 'canceled']);

export class HiggsfieldError extends Error {
  constructor(message, {status, code, retryable = false, ambiguous = false, correlationId, retryAfterMs} = {}) {
    super(message);
    Object.assign(this, {name: 'HiggsfieldError', status, code, retryable, ambiguous, correlationId, retryAfterMs});
  }
}

const httpsUrl = value => { try { const url = new URL(value); return url.protocol === 'https:' ? url : null; } catch { return null; } };

/** Minimal REST client. Credentials go only to api.higgsfield.ai, never to upload or download URLs. */
export function createHiggsfield({credentials, fetchImpl = globalThis.fetch, timeoutMs = 90000}) {
  if (!credentials) throw new HiggsfieldError('Credencial do Higgsfield ausente.', {code: 'HF_CREDENTIALS_MISSING'});
  const clean = text => redact(text, [credentials]);

  async function send(url, init) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fetchImpl(url, {...init, signal: controller.signal}); }
    catch (error) {
      const timeout = controller.signal.aborted;
      throw new HiggsfieldError(timeout ? 'Tempo esgotado ao falar com o Higgsfield.' : clean(`Falha de rede: ${error.message}`),
        {code: timeout ? 'TIMEOUT' : 'NETWORK', retryable: true, ambiguous: true});
    } finally { clearTimeout(timer); }
  }

  async function api(method, path, {body, headers = {}} = {}) {
    const url = new URL(path, API_ORIGIN);
    if (url.origin !== API_ORIGIN) throw new HiggsfieldError('URL fora da API do Higgsfield recusada.', {code: 'FOREIGN_URL'});
    const response = await send(url.href, {method, body: body === undefined ? undefined : JSON.stringify(body), headers: {
      Authorization: `Key ${credentials}`, Accept: 'application/json', ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...headers,
    }});
    const correlationId = response.headers.get('x-correlation-id') || undefined;
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error bodies are summarised below */ }
    if (!response.ok) {
      const detail = json?.detail;
      const code = detail && typeof detail === 'object' && !Array.isArray(detail) ? detail.code : undefined;
      const message = typeof detail === 'string' ? detail
        : Array.isArray(detail) ? detail.map(item => [item.loc?.slice(1).join('.'), item.msg].filter(Boolean).join(': ')).join('; ')
          : detail?.message || text.slice(0, 300) || response.statusText;
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new HiggsfieldError(clean(`HTTP ${response.status}: ${message}`), {
        status: response.status, code, correlationId,
        retryable: response.status === 429 || response.status === 423 || response.status >= 500,
        ambiguous: response.status >= 500,
        retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      });
    }
    return {json, correlationId};
  }

  return {
    async estimate(model, input) {
      const {json} = await api('POST', `/estimate/${model}`, {body: input});
      const usd = Number(json?.usd);
      if (!Number.isFinite(usd) || usd < 0) throw new HiggsfieldError('Estimativa sem valor em USD.', {code: 'BAD_ESTIMATE'});
      return usd;
    },
    async upload(bytes, contentType) {
      const {json} = await api('POST', '/files/generate-upload-url', {body: {content_type: contentType}});
      const target = httpsUrl(json?.upload_url), publicUrl = httpsUrl(json?.public_url);
      if (!target || !publicUrl) throw new HiggsfieldError('Resposta de upload sem URLs HTTPS.', {code: 'BAD_UPLOAD'});
      const headers = {};
      for (const [name, value] of Object.entries(json.upload_headers || {})) if (typeof value === 'string') headers[name] = value;
      headers['Content-Type'] ||= contentType;
      const response = await send(target.href, {method: 'PUT', headers, body: bytes});
      if (!response.ok) throw new HiggsfieldError(`Upload recusado pelo armazenamento (HTTP ${response.status}).`, {status: response.status, code: 'UPLOAD_FAILED', retryable: response.status >= 500});
      return publicUrl.href;
    },
    async submit(model, input, {idempotencyKey}) {
      if (!idempotencyKey) throw new HiggsfieldError('Envio sem Idempotency-Key recusado.', {code: 'NO_IDEMPOTENCY_KEY'});
      const {json, correlationId} = await api('POST', `/${model}`, {body: input, headers: {'Idempotency-Key': idempotencyKey}});
      if (typeof json?.request_id !== 'string' || !json.request_id) throw new HiggsfieldError('Envio aceito sem request_id.', {code: 'BAD_SUBMIT', ambiguous: true});
      return {...json, correlationId};
    },
    async status(requestId) {
      return (await api('GET', `/requests/${encodeURIComponent(requestId)}/status`)).json;
    },
    async cancel(requestId) {
      return (await api('POST', `/requests/${encodeURIComponent(requestId)}/cancel`)).json;
    },
    /** Streams a public output URL to a new file (no credentials sent, never overwrites). */
    async download(url, final) {
      const source = httpsUrl(url);
      if (!source) throw new HiggsfieldError('URL de saída inválida.', {code: 'BAD_OUTPUT_URL'});
      const response = await send(source.href, {method: 'GET'});
      if (!response.ok || !response.body) throw new HiggsfieldError(`Download falhou (HTTP ${response.status}).`, {status: response.status, code: 'DOWNLOAD_FAILED', retryable: true});
      await mkdir(dirname(final), {recursive: true});
      const temporary = temporaryPath(final), hash = createHash('sha256'), file = createWriteStream(temporary, {flags: 'wx'});
      let bytes = 0;
      try {
        for await (const chunk of response.body) {
          hash.update(chunk); bytes += chunk.length;
          if (!file.write(chunk)) await new Promise(resolve => file.once('drain', resolve));
        }
        await new Promise((resolve, reject) => file.end(error => error ? reject(error) : resolve()));
      } catch (error) { file.destroy(); throw error; }
      if (!bytes) throw new HiggsfieldError('Arquivo de saída vazio.', {code: 'EMPTY_OUTPUT'});
      await publish(temporary, final);
      return {file: final, bytes, sha256: hash.digest('hex'), contentType: response.headers.get('content-type') || ''};
    },
  };
}
