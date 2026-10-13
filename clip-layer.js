import { spawn } from 'node:child_process';

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let error = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { error = (error + chunk.toString()).slice(-6000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(error || `${command}_failed`)));
  });
}

export async function composeClipLayer(video, overlay, output, options = {}) {
  const ffmpeg = options.ffmpeg || 'ffmpeg';
  const ffprobe = options.ffprobe || 'ffprobe';
  const raw = await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,duration', '-of', 'json', video]);
  const info = JSON.parse(raw).streams?.[0];
  const width = Number(info?.width);
  const height = Number(info?.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 500 || height < 800 ||
      Math.abs(width / height - 9 / 16) > 0.012) throw new Error('invalid_clip_geometry');
  const overlayRaw = await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,pix_fmt', '-of', 'json', overlay]);
  const overlayInfo = JSON.parse(overlayRaw).streams?.[0];
  if (Number(overlayInfo?.width) !== width || Number(overlayInfo?.height) !== height ||
      !['rgba', 'bgra', 'argb', 'abgr', 'pal8'].includes(overlayInfo?.pix_fmt)) {
    throw new Error('invalid_overlay_geometry');
  }
  await run(ffmpeg, ['-y', '-i', video, '-loop', '1', '-i', overlay,
    '-filter_complex', '[0:v]setsar=1,format=rgba[bg];[1:v]format=rgba[fg];[bg][fg]overlay=0:0:shortest=1:format=auto,format=yuv420p[v]',
    '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-shortest', output]);
  return { width, height };
}
