import { task } from '@renderinc/sdk/workflows';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { renderQuickReel } from './quick-reel-render.js';

const allowedHosts = new Set((process.env.ALLOWED_MEDIA_HOSTS || 'www.postmarket.app,postmarket.app').split(',').map(v => v.trim()));
function mediaUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || !allowedHosts.has(url.hostname) || (url.port && url.port !== '443')) throw new Error('media_url_not_allowed');
  return url;
}
async function download(url, destination) {
  const response = await fetch(mediaUrl(url), {redirect:'error',signal:AbortSignal.timeout(60000)});
  if (!response.ok) throw new Error(`download_${response.status}`);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 150 * 1024 * 1024) throw new Error('media_too_large');
    chunks.push(chunk);
  }
  await fs.writeFile(destination, Buffer.concat(chunks));
}
async function callback(payload,status,body,startedAt) {
  const secret=process.env.PM_REEL_SECRET||'';
  if(secret.length<32)throw new Error('callback_not_configured');
  const duration=String(Math.max(1,Date.now()-startedAt));
  for(let attempt=0;attempt<5;attempt++) {
    const timestamp=String(Math.floor(Date.now()/1000));
    const signature=crypto.createHmac('sha256',secret).update(`${timestamp}.${payload.reel_id}.${status}.${duration}.${crypto.createHash('sha256').update(body).digest('hex')}`).digest('hex');
    try {
      const response=await fetch(mediaUrl(payload.callback_url),{method:'POST',redirect:'error',body,signal:AbortSignal.timeout(120000),headers:{'Content-Type':status==='completed'?'video/mp4':'application/json','X-PM-Timestamp':timestamp,'X-PM-Reel-Id':String(payload.reel_id),'X-PM-Status':status,'X-PM-Duration-Ms':duration,'X-PM-Signature':signature}});
      if(response.ok)return;
    } catch(error) { if(attempt===4)throw error; }
    await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));
  }
  throw new Error('callback_delivery_failed');
}
export const videoRapido=task({name:'videoRapido',plan:'standard',timeoutSeconds:1800,retry:{maxRetries:0}},async payload=>{
  const startedAt=Date.now();
  if(!Number.isInteger(payload?.reel_id)||payload.reel_id<1)throw new Error('invalid_attempt');
  for(const key of ['callback_url','clip_url','voice_url','music_url'])mediaUrl(payload[key]);
  if(typeof payload.cta!=='string'||typeof payload.brand!=='string')throw new Error('invalid_text');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pm-quick-'));
  let output;
  try {
    try { output=await renderQuickReel(payload,directory,download); }
    catch(error) { await callback(payload,'failed',Buffer.from(JSON.stringify({error:String(error.message).slice(-1000)})),startedAt);return {ok:false}; }
    // Un errore di trasporto della callback non trasforma un video riuscito in fallimento.
    await callback(payload,'completed',await fs.readFile(output),startedAt);
    return {ok:true,reel_id:payload.reel_id};
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
});
