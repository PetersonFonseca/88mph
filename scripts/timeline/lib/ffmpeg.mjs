import {spawn} from 'node:child_process';
import {link, unlink, mkdir, access} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname, basename, extname, join} from 'node:path';

export const FONT = '/System/Library/Fonts/Supplemental/Arial.ttf';

/** Runs a command, returning stdout as a Buffer. Errors carry the tail of stderr, never the full argument list. */
export function run(command, args, {input, keepStderr = false} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: ['pipe', 'pipe', 'pipe']});
    const out = [], err = [];
    let errBytes = 0;
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => { if (errBytes < 1 << 20) { err.push(chunk); errBytes += chunk.length; } });
    child.on('error', reject);
    child.on('close', code => {
      const stderr = Buffer.concat(err).toString('utf8');
      if (code === 0) return resolve(keepStderr ? {stdout: Buffer.concat(out), stderr} : Buffer.concat(out));
      reject(new Error(`${command} terminou com código ${code}: ${stderr.trim().split('\n').slice(-6).join(' | ')}`));
    });
    child.stdin.on('error', () => {});
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

const ff = (args, options) => run('ffmpeg', ['-hide_banner', '-v', 'error', ...args], options);

export async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

/** A sibling temporary path that keeps the extension, so ffmpeg can infer the container. */
export function temporaryPath(final) {
  return join(dirname(final), `.${basename(final, extname(final))}.${randomUUID()}.tmp${extname(final)}`);
}

/** Atomically publishes `temporary` as `final`; fails with EEXIST instead of overwriting. */
export async function publish(temporary, final) {
  await mkdir(dirname(final), {recursive: true});
  try { await link(temporary, final); } finally { await unlink(temporary).catch(() => {}); }
  return final;
}

export async function decodeJpegToRgb(bytes, width, height) {
  const data = await ff(['-f', 'jpeg_pipe', '-i', 'pipe:0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], {input: bytes});
  if (data.length !== width * height * 3) throw new Error(`Bloco decodificado com ${data.length} bytes; esperado ${width}x${height}.`);
  return data;
}

export async function decodeImageToRgb(path) {
  const info = await probe(path);
  const data = await ff(['-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  if (data.length !== info.width * info.height * 3) throw new Error(`Imagem ${basename(path)} com tamanho inesperado.`);
  return {width: info.width, height: info.height, data};
}

/** Writes RGB24 (or RGBA) to a new PNG (never overwrites); optional area downscale for supersampled renders. */
export async function encodePng({data, width, height, pixFmt = 'rgb24'}, final, {outWidth = width, outHeight = height} = {}) {
  await mkdir(dirname(final), {recursive: true});
  const temporary = temporaryPath(final);
  const filters = outWidth !== width || outHeight !== height ? ['-vf', `scale=${outWidth}:${outHeight}:flags=area`] : [];
  await ff(['-f', 'rawvideo', '-pix_fmt', pixFmt, '-video_size', `${width}x${height}`, '-i', 'pipe:0', ...filters, '-frames:v', '1', '-y', temporary], {input: Buffer.from(data.buffer, data.byteOffset, data.byteLength)});
  return publish(temporary, final);
}

export async function probe(path) {
  const json = JSON.parse((await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=codec_name,width,height,pix_fmt,r_frame_rate,avg_frame_rate,nb_read_frames,duration,color_space,color_transfer,color_primaries,color_range',
    '-show_entries', 'format=duration,size,bit_rate', '-of', 'json', path])).toString('utf8'));
  const stream = json.streams?.[0] || {}, format = json.format || {};
  const rate = value => { const [n, d] = String(value || '0/1').split('/').map(Number); return d ? n / d : 0; };
  return {
    codec: stream.codec_name, width: stream.width, height: stream.height, pixFmt: stream.pix_fmt,
    fps: rate(stream.avg_frame_rate) || rate(stream.r_frame_rate), frames: Number(stream.nb_read_frames) || null,
    duration: Number(stream.duration || format.duration) || null, bytes: Number(format.size) || null,
    bitRate: Number(format.bit_rate) || null,
    color: {space: stream.color_space, transfer: stream.color_transfer, primaries: stream.color_primaries, range: stream.color_range},
  };
}

export async function extractFrame(video, index, final) {
  const temporary = temporaryPath(final);
  await ff(['-i', video, '-vf', `select=eq(n\\,${index})`, '-fps_mode', 'passthrough', '-frames:v', '1', '-y', temporary]);
  return publish(temporary, final);
}

export async function lastFrame(video, final) {
  const {frames} = await probe(video);
  if (!frames) throw new Error(`Não foi possível contar os quadros de ${basename(video)}.`);
  return extractFrame(video, frames - 1, final);
}

/** Grid of every Nth frame, labelled with its index, for quick visual review. */
export async function contactSheet(video, final, {every = 6, columns = 6, rows = 4, width = 320} = {}) {
  const temporary = temporaryPath(final);
  const label = `drawtext=fontfile=${FONT}:text='%{n}':x=8:y=8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.55`;
  await ff(['-i', video, '-vf', `select='not(mod(n\\,${every}))',${label},scale=${width}:-2,tile=${columns}x${rows}:padding=4:margin=4:color=0x101010`,
    '-fps_mode', 'passthrough', '-frames:v', '1', '-y', temporary]);
  return publish(temporary, final);
}

/** SSIM (All) between two images or videos, optionally on the same crop "w:h:x:y" of both. */
export async function ssim(a, b, {crop} = {}) {
  const pre = crop ? `crop=${crop},` : '';
  const {stderr} = await run('ffmpeg', ['-hide_banner', '-v', 'info', '-i', a, '-i', b, '-lavfi',
    `[0:v]${pre}format=rgb24[x];[1:v]${pre}format=rgb24[y];[x][y]ssim`, '-f', 'null', '-'], {keepStderr: true});
  const match = /All:([\d.]+)/.exec(stderr);
  if (!match) throw new Error('O ffmpeg não informou o SSIM.');
  return Number(match[1]);
}

export {ff as ffmpeg};
