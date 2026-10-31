import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
function command(binary, args) {
  return new Promise((resolve,reject) => {
    const child = spawn(binary,args,{stdio:['ignore','pipe','pipe']});
    let output = '';
    let error = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 600000);
    child.stdout.on('data',chunk => { output = (output + chunk).slice(-20000); });
    child.stderr.on('data',chunk => { error = (error + chunk).slice(-3000); });
    child.on('error',err => { clearTimeout(timer);reject(err); });
    child.on('close',code => { clearTimeout(timer);code===0?resolve(output):reject(new Error(error || `process_exit_${code}`)); });
  });
}
export function assText(value, maxLength=100) {
  return String(value).replace(/[\\{}\r\n]/g,' ').trim().slice(0,maxLength);
}
function clock(seconds) {
  const total = Math.max(0,Math.round(seconds*100));
  return `${Math.floor(total/360000)}:${String(Math.floor(total/6000)%60).padStart(2,'0')}:${String(Math.floor(total/100)%60).padStart(2,'0')}.${String(total%100).padStart(2,'0')}`;
}
export function captionEvents(alignment, factor) {
  const chars=alignment?.characters;
  const starts=alignment?.character_start_times_seconds;
  const ends=alignment?.character_end_times_seconds;
  if (!Array.isArray(chars) || chars.length>1500 || starts?.length!==chars.length || ends?.length!==chars.length) throw new Error('alignment_invalid');
  const words=[];
  let word='';
  let start=0;
  let end=0;
  for(let i=0;i<chars.length;i++) {
    if (!Number.isFinite(starts[i]) || !Number.isFinite(ends[i]) || starts[i]<0 || ends[i]<starts[i]) throw new Error('alignment_time_invalid');
    if (/\s/u.test(chars[i])) {
      if(word)words.push({text:word,start,end});
      word='';
    } else {
      if(!word)start=starts[i]/factor;
      word+=chars[i];end=ends[i]/factor;
    }
  }
  if(word)words.push({text:word,start,end});
  const lines=[];
  for(let i=0;i<words.length;) {
    const group=[words[i++]];
    while(i<words.length && group.length<4 && group.map(w=>w.text).join(' ').length+words[i].text.length<33)group.push(words[i++]);
    const from=group[0].start;
    const to=Math.min(12,group[group.length-1].end+.08);
    if(from<to)lines.push(`Dialogue: 0,${clock(from)},${clock(to)},Caption,,0,0,0,,${assText(group.map(w=>w.text).join(' '))}`);
  }
  return lines.join('\n');
}
export async function renderQuickReel(payload, directory, download, localFiles=null) {
  const clip=path.join(directory,'clip.mp4');
  const voice=path.join(directory,'voice.mp3');
  const music=path.join(directory,'music.mp3');
  if(localFiles) {
    await Promise.all([fs.copyFile(localFiles.clip,clip),fs.copyFile(localFiles.voice,voice),fs.copyFile(localFiles.music,music)]);
  } else {
    await Promise.all([download(payload.clip_url,clip),download(payload.voice_url,voice),download(payload.music_url,music)]);
  }
  const voiceDuration=Number(await command('ffprobe',['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',voice]));
  const factor=Math.max(1,voiceDuration/11.7);
  if(!Number.isFinite(factor)||factor>1.45)throw new Error('voice_too_long');
  const subtitles = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Caption,DejaVu Sans,58,&H00FFFFFF,&H000000FF,&H00201912,&H90000000,-1,0,0,0,100,100,0,0,3,14,0,2,90,90,330,1\nStyle: CTA,DejaVu Sans,70,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,100,100,0,1\nStyle: Brand,DejaVu Sans,42,&H005CB1FF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,100,100,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${captionEvents(payload.alignment,factor)}\nDialogue: 1,0:00:12.00,0:00:15.00,CTA,,0,0,0,,{\\pos(540,920)}${assText(payload.cta,45)}\nDialogue: 1,0:00:12.00,0:00:15.00,Brand,,0,0,0,,{\\pos(540,1110)}${assText(payload.brand,60)}\n`;
  const ass=path.join(directory,'captions.ass');
  await fs.writeFile(ass,subtitles);
  const output=path.join(directory,'result.mp4');
  const filter=`[0:v]trim=0:12,setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x0a1222,setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=3,drawbox=x=0:y=0:w=iw:h=ih:color=0x0a1222@0.92:t=fill:enable='gte(t,12)',ass=${ass},format=yuv420p[v];[1:a]atempo=${factor.toFixed(5)},apad,atrim=0:15,asetpts=PTS-STARTPTS[voice];[2:a]volume=0.09,atrim=0:15,afade=t=out:st=13.7:d=1.3,asetpts=PTS-STARTPTS[music];[voice][music]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95[a]`;
  await command('ffmpeg',['-y','-i',clip,'-i',voice,'-stream_loop','-1','-i',music,'-filter_complex_threads','1','-filter_complex',filter,'-map','[v]','-map','[a]','-t','15','-r','30','-c:v','libx264','-preset','veryfast','-crf','21','-threads','2','-c:a','aac','-b:a','160k','-movflags','+faststart',output]);
  const probe=JSON.parse(await command('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type,width,height','-of','json',output]));
  if(Math.abs(Number(probe.format.duration)-15)>.15 || !probe.streams.some(s=>s.codec_type==='audio') || !probe.streams.some(s=>s.codec_type==='video'&&s.width===1080&&s.height===1920))throw new Error('output_validation_failed');
  return output;
}
