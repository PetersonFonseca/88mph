import {readFileSync, existsSync} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const TIMELINE_DIR = join(ROOT, '.cache', 'timeline', 'paulista');
export const ARCHIVE_DIR = join(ROOT, '.cache', 'streetview');
// Zoom-5 keyframe tiles live apart from the app's archive so its inventory stays untouched.
export const KEYFRAME_TILE_DIR = join(ROOT, '.cache', 'timeline', 'tiles');
export const DEV_REFERRER = 'http://127.0.0.1:5173/';

export function parseEnv(text) {
  const values = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    values[match[1]] = value;
  }
  return values;
}

/** Same precedence as Vite's loadEnv: later files win, variables already in the process win over files. */
export function loadEnv(root = ROOT, {mode = 'development', processEnv = process.env} = {}) {
  const values = {};
  for (const name of ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]) {
    const path = join(root, name);
    if (existsSync(path)) Object.assign(values, parseEnv(readFileSync(path, 'utf8')));
  }
  for (const [key, value] of Object.entries(processEnv)) if (value !== undefined && value !== '') values[key] = value;
  return values;
}

export function googleKey(env) {
  const key = (env.GOOGLE_MAPS_SERVER_API_KEY || env.VITE_GOOGLE_MAPS_API_KEY || '').trim();
  if (!key) throw new Error('Chave do Google ausente: configure VITE_GOOGLE_MAPS_API_KEY no .env, como no app.');
  return key;
}

export function archiveNamespace(key, directory = ARCHIVE_DIR) {
  return join(directory, createHash('sha256').update(key).digest('hex'));
}

/** Higgsfield credentials as "KEY_ID:KEY_SECRET". The value itself is never echoed. */
export function higgsfieldCredentials(env, {required = true} = {}) {
  const value = (env.HF_CREDENTIALS || env.HF_KEY ||
    (env.HF_API_KEY_ID && env.HF_API_KEY_SECRET ? `${env.HF_API_KEY_ID}:${env.HF_API_KEY_SECRET}` : '')).trim();
  if (!value) {
    if (!required) return null;
    throw Object.assign(new Error('Credencial do Higgsfield ausente. Crie a chave em console.higgsfield.ai e acrescente HF_CREDENTIALS=id:segredo ao .env.'), {code: 'HF_CREDENTIALS_MISSING'});
  }
  if (!/^[^\s:]+:\S+$/.test(value)) {
    throw Object.assign(new Error('HF_CREDENTIALS deve ter o formato id:segredo, numa única linha e sem espaços.'), {code: 'HF_CREDENTIALS_INVALID'});
  }
  return value;
}

export function redact(text, secrets = []) {
  let result = String(text ?? '');
  for (const secret of secrets.filter(Boolean)) {
    for (const part of [secret, ...String(secret).split(':')].filter(value => value.length >= 6)) {
      result = result.split(part).join('***');
    }
  }
  return result;
}
