import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';

const app = express();
const port = Number(process.env.PORT || 8080);
const secret = process.env.PM_REEL_SECRET || '';
const allowedHosts = new Set((process.env.ALLOWED_MEDIA_HOSTS || 'www.postmarket.app,postmarket.app').split(',').map(v=>v.trim()));
const root = '/app/jobs';
const jobs = new Map();
app.use(express.json({limit:'64kb',verify:(req,res,buf)=>{req.rawBody=buf.toString('utf8')}}));

function auth(req,res,next){
  if(secret.length<32) return res.status(503).json({error:'worker_not_configured'});
  const ts=String(req.get('X-PM-Timestamp')||''), sig=String(req.get('X-PM-Signature')||'');
  if(!/^\d{10}$/.test(ts)||Math.abs(Date.now()/1000-Number(ts))>300) return res.status(401).json({error:'expired_signature'});
  const expected=crypto.createHmac('sha256',secret).update(ts+'.'+(req.rawBody||'')).digest('hex');
  if(sig.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected))) return res.status(401).json({error:'invalid_signature'});
  next();
}
function mediaUrl(value){const u=new URL(value);if(u.protocol!=='https:'||!allowedHosts.has(u.hostname))throw new Error('media_url_not_allowed');return u;}
async function download(url,dest){const response=await fetch(mediaUrl(url),{redirect:'error',signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error('media_download_failed');const declared=Number(response.headers.get('content-length')||0);if(declared>150*1024*1024)throw new Error('media_too_large');const data=Buffer.from(await response.arrayBuffer());if(data.length>150*1024*1024)throw new Error('media_too_large');await fsp.writeFile(dest,data);}
function run(args){return new Promise((resolve,reject)=>{const p=spawn('ffmpeg',args,{stdio:['ignore','ignore','pipe']});let err='';p.stderr.on('data',d=>{err=(err+d.toString()).slice(-12000)});p.on('error',reject);p.on('close',(code,signal)=>code===0?resolve():reject(new Error(`${signal?`ffmpeg_terminated_${signal}\n`:''}${err.slice(-3000)||'ffmpeg_failed'}`)));});}
async function render(id,payload){
  const job=jobs.get(id); job.status='processing'; const dir=path.join(root,id); await fsp.mkdir(dir,{recursive:true});
  try{
    const ext=payload.type==='images'?'.jpg':'.mp4'; const inputs=[];
    for(let i=0;i<3;i++){const file=path.join(dir,`scene-${i+1}${ext}`);await download(payload.assets[i],file);inputs.push(file)}
    let music=null;if(payload.music_url){music=path.join(dir,'music.mp3');await download(payload.music_url,music)}
    // Le istanze Free hanno solo 512 MB. Prepariamo ogni scena separatamente:
    // in questo modo FFmpeg non mantiene tre catene di immagini in RAM.
    const clips=[];
    for(let i=0;i<3;i++){
      const clip=path.join(dir,`clip-${i+1}.mp4`); clips.push(clip);
      const sceneFilter=payload.type==='images'
        ? `scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,zoompan=z='min(zoom+0.0005,1.07)':d=125:s=720x1280:fps=25,setsar=1,format=yuv420p`
        : `trim=0:5,setpts=PTS-STARTPTS,scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,fps=25,setsar=1,format=yuv420p`;
      const sceneArgs=['-y'];
      if(payload.type==='images')sceneArgs.push('-loop','1','-t','5');
      sceneArgs.push('-i',inputs[i],'-vf',sceneFilter,'-t','5','-r','25','-threads','1','-filter_threads','1','-c:v','libx264','-pix_fmt','yuv420p','-preset','veryfast','-crf','22','-an',clip);
      await run(sceneArgs);
    }
    const silent=path.join(dir,'result-silent.mp4');const out=path.join(dir,'result.mp4');
    const joinArgs=['-y']; clips.forEach(clip=>joinArgs.push('-i',clip));
    joinArgs.push('-filter_complex','[0:v][1:v]xfade=transition=fade:duration=0.5:offset=4.5[x1];[x1][2:v]xfade=transition=fade:duration=0.5:offset=9.0[vout]','-map','[vout]','-t','14','-r','25','-threads','1','-filter_threads','1','-c:v','libx264','-pix_fmt','yuv420p','-preset','veryfast','-crf','22','-an','-movflags','+faststart',music?silent:out);
    await run(joinArgs);
    await Promise.all(clips.map(clip=>fsp.unlink(clip).catch(()=>{})));
    if(music){
      // Alcuni provider consegnano la musica dentro un MP4 con una traccia video.
      // Selezioniamo esclusivamente il primo flusso audio, senza dipendere
      // dall'estensione del file scaricato.
      await run(['-y','-i',silent,'-stream_loop','-1','-i',music,'-filter_complex','[1:a:0]volume=0.12,atrim=duration=14,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=.35,afade=t=out:st=13.3:d=.7[aout]','-map','0:v:0','-map','[aout]','-map_metadata','-1','-c:v','copy','-c:a','aac','-b:a','160k','-shortest','-movflags','+faststart',out]);
      await fsp.unlink(silent).catch(()=>{});
    }
    job.status='completed';job.token=crypto.randomBytes(24).toString('hex');job.result_url=`${process.env.PUBLIC_URL}/v1/results/${id}?token=${job.token}`;
  }catch(e){job.status='failed';job.error=String(e.message||e).slice(-2000);console.error(`[job ${id}]`,job.error)}
}

app.get('/health',(req,res)=>res.json({ok:true}));
app.post('/v1/jobs',auth,(req,res)=>{try{const {type,assets,music_url}=req.body;if(!['images','videos'].includes(type)||!Array.isArray(assets)||assets.length!==3)throw new Error('invalid_payload');assets.forEach(mediaUrl);if(music_url)mediaUrl(music_url);const id=crypto.randomUUID();jobs.set(id,{status:'pending',created_at:Date.now()});res.status(202).json({job_id:id,status:'pending'});setImmediate(()=>render(id,{type,assets,music_url}));}catch(e){res.status(422).json({error:String(e.message||e)})}});
app.get('/v1/jobs/:id',auth,(req,res)=>{const job=jobs.get(req.params.id);if(!job)return res.status(404).json({error:'job_not_found'});res.json(job)});
app.get('/v1/results/:id',(req,res)=>{const job=jobs.get(req.params.id);if(!job||job.status!=='completed'||req.query.token!==job.token)return res.sendStatus(404);res.type('video/mp4').sendFile(path.join(root,req.params.id,'result.mp4'))});
app.listen(port,()=>console.log(`PostMarket Reel Worker on ${port}`));
