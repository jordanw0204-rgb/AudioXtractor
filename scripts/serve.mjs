import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wavHeader } from '../extension/lib/wav.js';

export function toneWav() {
  const rate = 48000, frames = rate * 12, pcm = Buffer.alloc(frames * 2 * 4);
  for (let i = 0; i < frames; i++) { pcm.writeFloatLE(Math.sin(i * 2 * Math.PI * 440 / rate) * .12, i * 8); pcm.writeFloatLE(Math.sin(i * 2 * Math.PI * 660 / rate) * .09, i * 8 + 4); }
  return Buffer.concat([Buffer.from(wavHeader(rate, 2, frames)), pcm]);
}
const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Midnight frequencies — AudioXtractor test studio</title><style>body{background:#111113;color:#dddde5;font:15px system-ui;padding:60px;max-width:700px;margin:auto}button{background:#dddde5;color:#15151a;border:0;padding:14px 20px;border-radius:8px;cursor:pointer}audio{display:block;margin:24px 0;width:100%}p{color:#9696a3}h1{font-weight:500;letter-spacing:-1px}code{color:#aaa}</style></head><body><p>AudioXtractor / local test studio</p><h1>Midnight frequencies.</h1><p>A quiet stereo reference signal. Left: 440 Hz. Right: 660 Hz. 48 kHz, 32-bit float WAV.</p><button id="play">Play reference audio</button><audio id="audio" src="/tone.wav?token=keep-this-signature" loop controls title="Midnight frequencies"></audio><audio id="alternate" src="/alternate.wav" preload="metadata" title="Second light"></audio><div id="shadow-host"></div><p>Open AudioXtractor to find the originals or make an uncompressed recording.</p><script>const audio=document.querySelector('#audio');document.querySelector('#play').onclick=()=>audio.play();window.addBlob=async()=>{const response=await fetch('/tone.wav');const player=document.createElement('audio');player.src=URL.createObjectURL(await response.blob());player.title='Page-only stream';document.body.append(player);return player.src};window.addPlaylist=()=>fetch('/stream.m3u8');window.addSegment=()=>fetch('/chunk.m4s');window.addShadow=()=>{const root=document.querySelector('#shadow-host').attachShadow({mode:'open'});root.innerHTML='<audio src="/shadow.wav" preload="metadata" title="Inside shadow DOM"></audio>'};window.addFrame=()=>{const frame=document.createElement('iframe');frame.src='/frame';document.body.append(frame)};</script></body></html>`;
const root = fileURLToPath(new URL('../extension/', import.meta.url));
export async function startServer(port = 0) {
  const wav = toneWav();
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    try {
      if (pathname === '/fixture' || pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(fixture.replace('<head>', '<head><link rel="icon" href="/icons/icon32.png">')); return; }
      if (pathname === '/frame') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<audio src="/frame.wav" preload="metadata" title="Frame audio"></audio>'); return; }
      if (pathname.endsWith('.wav')) {
        const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
        const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
        res.writeHead(range ? 206 : 200, { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${wav.length}` } : {}) }); res.end(wav.subarray(start, end + 1)); return;
      }
      if (pathname === '/stream.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); res.end('#EXTM3U\n#EXTINF:4,\nchunk.m4s'); return; }
      if (pathname === '/chunk.m4s') { res.writeHead(200, { 'Content-Type': 'audio/mp4' }); res.end('fragment'); return; }
      const path = resolve(root, `.${decodeURIComponent(pathname)}`);
      if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) { res.writeHead(403); res.end(); return; }
      const data = await readFile(path);
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }[extname(path)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime }); res.end(data);
    } catch { res.writeHead(404); res.end('Not found'); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  return { server, url: `http://127.0.0.1:${server.address().port}`, wav };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await startServer(Number(process.env.PORT) || 4173);
  console.log(`Test studio: ${url}/fixture\nInterface preview: ${url}/popup.html`);
}
