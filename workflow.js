import { task } from '@renderinc/sdk/workflows';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const secret = process.env.PM_REEL_SECRET || '';
const allowedHosts = new Set((process.env.ALLOWED_MEDIA_HOSTS || 'www.postmarket.app,postmarket.app').split(',').map(v => v.trim()));

function mediaUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname)) throw new Error('media_url_not_allowed');
  return url;
}

async function download(url, destination) {
  const response = await fetch(mediaUrl(url), { redirect: 'error', signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error(`media_download_failed_${response.status}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > 150 * 1024 * 1024) throw new Error('media_too_large');
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > 150 * 1024 * 1024) throw new Error('media_too_large');
  await fsp.writeFile(destination, data);
}

function run(args) {
  return new Promise((resolve, reject) => {
    const process = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    process.stderr.on('data', chunk => { error = (error + chunk.toString()).slice(-12000); });
    process.on('error', reject);
    process.on('close', (code, signal) => code === 0
      ? resolve()
      : reject(new Error(`${signal ? `ffmpeg_terminated_${signal}\n` : ''}${error.slice(-3000) || 'ffmpeg_failed'}`)));
  });
}

function runOutput(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let error = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { error = (error + chunk.toString()).slice(-4000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(error || `${command}_failed`)));
  });
}

async function renderAvatar(payload, directory) {
  const source = path.join(directory, 'avatar-source.mp4');
  const output = path.join(directory, 'result.mp4');
  await download(payload.assets[0], source);
  const raw = await runOutput('python3', [path.join(process.cwd(), 'detect_avatar_frame.py'), source]);
  const frame = JSON.parse(raw);
  const sourceWidth = Math.max(2, Number(frame.width));
  const contentHeight = Math.max(2, Number(frame.content_height));
  const top = Math.max(0, Number(frame.top));
  const faceX = Math.min(0.92, Math.max(0.08, Number(frame.face_x) || 0.5));
  const scaledWidth = sourceWidth * (1280 / contentHeight);
  const focalScaledX = faceX * scaledWidth;
  const cropX = Math.max(0, Math.min(Math.max(0, scaledWidth - 720), focalScaledX - 360));
  const filter = `crop=${sourceWidth}:${contentHeight}:0:${top},scale=-2:1280:flags=lanczos,crop=720:1280:${Math.round(cropX)}:0,setsar=1,format=yuv420p`;
  await run(['-y', '-i', source, '-vf', filter, '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', output]);
  return output;
}

function directionPlan(style = 'automatico', count = 3) {
  const groups = {
    elegante: [
      "zoompan=z='min(zoom+0.00055,1.065)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'",
      "zoompan=z='if(eq(on,1),1.065,max(1.0,zoom-0.00052))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'",
      "zoompan=z='1.045':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*on/124'",
      "zoompan=z='1.045':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(1-on/124)'",
    ],
    dinamico: [
      "zoompan=z='min(zoom+0.0008,1.09)':x='(iw-iw/zoom)*on/124':y='(ih-ih/zoom)*(1-on/124)'",
      "zoompan=z='min(zoom+0.0008,1.09)':x='(iw-iw/zoom)*(1-on/124)':y='(ih-ih/zoom)*on/124'",
      "zoompan=z='1.075':x='(iw-iw/zoom)*on/124':y='ih/2-(ih/zoom/2)'",
      "zoompan=z='1.075':x='(iw-iw/zoom)*(1-on/124)':y='ih/2-(ih/zoom/2)'",
    ],
    cinematografico: [
      "zoompan=z='min(zoom+0.00065,1.075)':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*on/124'",
      "zoompan=z='if(eq(on,1),1.075,max(1.0,zoom-0.0006))':x='(iw-iw/zoom)*on/124':y='ih/2-(ih/zoom/2)'",
      "zoompan=z='1.065':x='(iw-iw/zoom)*on/124':y='(ih-ih/zoom)*on/124'",
      "zoompan=z='1.065':x='(iw-iw/zoom)*(1-on/124)':y='(ih-ih/zoom)*(1-on/124)'",
    ],
    base: [
      "zoompan=z='1.055':x='(iw-iw/zoom)*on/124':y='ih/2-(ih/zoom/2)'",
      "zoompan=z='1.055':x='(iw-iw/zoom)*(1-on/124)':y='ih/2-(ih/zoom/2)'",
      "zoompan=z='1.05':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*on/124'",
      "zoompan=z='1.05':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(1-on/124)'",
    ],
  };
  const transitionGroups = {
    elegante: ['fade', 'dissolve', 'smoothleft', 'smoothright'],
    dinamico: ['slideleft', 'slideright', 'slideup', 'slidedown', 'wipeleft', 'wiperight'],
    cinematografico: ['fadeblack', 'fadewhite', 'dissolve', 'smoothup', 'smoothdown'],
    base: ['fade', 'slideleft', 'slideright', 'smoothleft', 'smoothright'],
  };
  const selected = Object.hasOwn(groups, style) && style !== 'base' ? style : 'automatico';
  const movements = (selected === 'automatico' ? Object.values(groups).flat() : [...groups[selected], ...groups.base]).sort(() => Math.random() - 0.5);
  const transitions = [...new Set(selected === 'automatico' ? Object.values(transitionGroups).flat() : transitionGroups[selected])].sort(() => Math.random() - 0.5);
  const movementPlan = Array.from({ length: count }, (_, index) => movements[index % movements.length]);
  const transitionPlan = Array.from({ length: Math.max(0, count - 1) }, (_, index) => transitions[index % transitions.length]);
  return { movements: movementPlan, transitions: transitionPlan };
}

async function render(payload, directory) {
  const extension = payload.type === 'images' ? '.jpg' : '.mp4';
  const inputs = [];
  const count = payload.assets.length;
  const targetDuration = Math.max(5, Math.min(15, Number(payload.target_duration || 14)));
  const transitionDuration = count > 6 ? 0.28 : count > 3 ? 0.35 : 0.5;
  const clipDuration = (targetDuration + transitionDuration * (count - 1)) / count;
  const fps = 30;
  const frames = Math.max(fps, Math.round(clipDuration * fps));
  const lastFrame = Math.max(1, frames - 1);
  const formats = {
    '9:16': [720, 1280],
    '4:5': [864, 1080],
    '1:1': [1080, 1080],
    '16:9': [1280, 720],
  };
  const [width, height] = formats[payload.output_format] || formats['9:16'];
  // Zoompan arrotonda le coordinate ai pixel interi: lavorare a risoluzione
  // doppia riduce sensibilmente il micro-jitter delle panoramiche su foto statiche.
  const motionWidth = width * 2;
  const motionHeight = height * 2;
  for (let index = 0; index < count; index++) {
    const file = path.join(directory, `scene-${index + 1}${extension}`);
    await download(payload.assets[index], file);
    inputs.push(file);
  }
  let music = null;
  if (payload.music_url) {
    music = path.join(directory, 'music.bin');
    await download(payload.music_url, music);
  }

  const clips = [];
  const direction = directionPlan(payload.style, count);
  for (let index = 0; index < count; index++) {
    const clip = path.join(directory, `clip-${index + 1}.mp4`);
    clips.push(clip);
    const filter = payload.type === 'images'
      ? `scale=${motionWidth}:${motionHeight}:force_original_aspect_ratio=increase:flags=lanczos,crop=${motionWidth}:${motionHeight},${direction.movements[index].replaceAll('124', String(lastFrame))}:d=${frames}:s=${width}x${height}:fps=${fps},setsar=1,settb=AVTB,format=yuv420p`
      : `trim=0:${clipDuration.toFixed(3)},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height},fps=${fps},setsar=1,settb=AVTB,format=yuv420p`;
    const args = ['-y'];
    if (payload.type === 'images') args.push('-loop', '1', '-t', clipDuration.toFixed(3));
    args.push('-i', inputs[index], '-vf', filter, '-t', clipDuration.toFixed(3), '-r', String(fps), '-threads', '1', '-filter_threads', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '21', '-an', clip);
    await run(args);
  }

  const silent = path.join(directory, 'result-silent.mp4');
  const output = path.join(directory, 'result.mp4');
  const join = ['-y'];
  clips.forEach(clip => join.push('-i', clip));
  const joins = [];
  let previous = '0:v';
  for (let index = 1; index < count; index++) {
    const outputLabel = index === count - 1 ? 'vout' : `x${index}`;
    const offset = index * (clipDuration - transitionDuration);
    joins.push(`[${previous}][${index}:v]xfade=transition=${direction.transitions[index - 1]}:duration=${transitionDuration.toFixed(3)}:offset=${offset.toFixed(3)}[${outputLabel}]`);
    previous = outputLabel;
  }
  join.push('-filter_complex', joins.join(';'), '-map', '[vout]', '-t', String(targetDuration), '-r', String(fps), '-threads', '1', '-filter_threads', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '21', '-an', '-movflags', '+faststart', music ? silent : output);
  await run(join);

  if (music) {
    const fadeOutStart = Math.max(0, targetDuration - 0.7);
    await run(['-y', '-i', silent, '-stream_loop', '-1', '-i', music, '-filter_complex', `[1:a:0]volume=0.12,atrim=duration=${targetDuration},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.35,afade=t=out:st=${fadeOutStart}:d=0.7[aout]`, '-map', '0:v:0', '-map', '[aout]', '-map_metadata', '-1', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', output]);
  }
  return output;
}

async function callback(url, reelId, status, body, contentType, durationMs) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const billedDurationMs = String(Math.max(1, Math.round(durationMs)));
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${reelId}.${status}.${billedDurationMs}.${digest}`).digest('hex');
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST', body, signal: AbortSignal.timeout(120000),
        headers: {
          'Content-Type': contentType,
          'X-PM-Timestamp': timestamp,
          'X-PM-Reel-Id': String(reelId),
          'X-PM-Status': status,
          'X-PM-Duration-Ms': billedDurationMs,
          'X-PM-Signature': signature,
        },
      });
      if (response.ok) return;
      lastError = new Error(`callback_http_${response.status}`);
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  throw lastError || new Error('callback_failed');
}

export const montaggioReel = task(
  {
    name: 'montaggioReel',
    plan: 'standard',
    timeoutSeconds: 900,
    retry: { maxRetries: 1, waitDurationMs: 3000, backoffScaling: 2 },
  },
  async function montaggioReel(payload) {
    const startedAt = Date.now();
    if (secret.length < 32) throw new Error('workflow_not_configured');
    const assetCountValid = Array.isArray(payload?.assets) && (payload.type === 'images'
      ? payload.assets.length >= 3 && payload.assets.length <= 10
      : payload.type === 'avatar' ? payload.assets.length === 1 : payload.assets.length === 3);
    if (!payload || !Number.isInteger(payload.reel_id) || !['images', 'videos', 'avatar'].includes(payload.type) || !assetCountValid) throw new Error('invalid_payload');
    if (payload.output_format && !['9:16', '4:5', '1:1', '16:9'].includes(payload.output_format)) throw new Error('invalid_output_format');
    mediaUrl(payload.callback_url);
    payload.assets.forEach(mediaUrl);
    if (payload.music_url) mediaUrl(payload.music_url);
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), `reel-${payload.reel_id}-`));
    try {
      const output = payload.type === 'avatar' ? await renderAvatar(payload, directory) : await render(payload, directory);
      const video = await fsp.readFile(output);
      await callback(payload.callback_url, payload.reel_id, 'completed', video, 'video/mp4', Date.now() - startedAt);
      return { ok: true, reel_id: payload.reel_id, bytes: video.length };
    } catch (error) {
      const message = String(error?.message || error).slice(-1800);
      const body = Buffer.from(JSON.stringify({ error: message }));
      try { await callback(payload.callback_url, payload.reel_id, 'failed', body, 'application/json', Date.now() - startedAt); } catch (callbackError) {
        throw new Error(`${message}\n${String(callbackError?.message || callbackError)}`);
      }
      return { ok: false, reel_id: payload.reel_id, error: message };
    } finally {
      await fsp.rm(directory, { recursive: true, force: true });
    }
  }
);
