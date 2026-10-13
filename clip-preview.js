import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { composeClipLayer } from './clip-layer.js';

function allowed(urlText) {
  const url = new URL(urlText);
  if (url.protocol !== 'https:' || url.hostname !== 'www.postmarket.app' || url.port ||
      !url.pathname.startsWith('/generati/visual/') || url.search) throw new Error('preview_media_not_allowed');
  return url;
}

async function download(urlText, file) {
  const response = await fetch(allowed(urlText), { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok || Number(response.headers.get('content-length') || 0) > 25e6) throw new Error('preview_download_failed');
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > 25e6) throw new Error('preview_media_too_large');
  await fs.writeFile(file, data);
}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', chunk => { error = (error + chunk.toString()).slice(-4000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(error || 'preview_ffmpeg_failed')));
  });
}

async function send(payload, event, data) {
  const callback = new URL(payload.callback_url);
  if (callback.protocol !== 'https:' || callback.hostname !== 'www.postmarket.app' || callback.port ||
      callback.pathname !== '/dashboard/video_tipografia_preview_callback.php' || callback.search) {
    throw new Error('preview_callback_not_allowed');
  }
  const secret = process.env.PM_REEL_SECRET || '';
  if (secret.length < 32) throw new Error('preview_not_configured');
  const body = JSON.stringify({ id: payload.id, nonce: payload.nonce, event, data });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex');
  const response = await fetch(callback, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { 'content-type': 'application/json', 'X-PM-Timestamp': timestamp, 'X-PM-Signature': signature }, body });
  if (!response.ok) throw new Error('preview_callback_failed_' + response.status);
  return response.json();
}

export async function processClipPreview(payload) {
  if (!/^[a-f0-9]{40}$/.test(payload?.id) || !/^[a-f0-9]{48}$/.test(payload?.nonce) ||
      !Array.isArray(payload?.contract?.scenes) || payload.contract.scenes.length !== 3) throw new Error('invalid_preview_job');
  const worker = crypto.randomUUID();
  const claim = await send(payload, 'claim', { worker });
  if (!claim.accepted) return { duplicate: true };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-clip-preview-'));
  try {
    const clips = [];
    for (let index = 0; index < 3; index++) {
      const scene = payload.contract.scenes[index];
      const raw = path.join(directory, `raw-${index}.mp4`);
      const overlay = path.join(directory, `overlay-${index}.png`);
      const clip = path.join(directory, `clip-${index}.mp4`);
      const frame = path.join(directory, `frame-${index}.jpg`);
      await download(scene.source, raw);
      await download(scene.overlay, overlay);
      await composeClipLayer(raw, overlay, clip);
      await ffmpeg(['-i', clip, '-frames:v', '1', frame]);
      clips.push(clip);
      await send(payload, 'scene', { worker, index,
        frame: (await fs.readFile(frame)).toString('base64'),
        overlay: (await fs.readFile(overlay)).toString('base64'),
        placement: { source: 'existing_visual_text_engine', mode: 'fixed_typography_on_video', ai_calls: 0 } });
    }
    const output = path.join(directory, 'result.mp4');
    await ffmpeg(['-i', clips[0], '-i', clips[1], '-i', clips[2], '-filter_complex',
      '[0:v][1:v]xfade=transition=fade:duration=0.5:offset=4.5[x1];[x1][2:v]xfade=transition=fade:duration=0.5:offset=9[v]',
      '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-movflags', '+faststart', output]);
    await send(payload, 'completed', { worker, video: (await fs.readFile(output)).toString('base64') });
    return { ok: true, id: payload.id };
  } catch (error) {
    await send(payload, 'failed', { worker }).catch(() => {});
    throw error;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
