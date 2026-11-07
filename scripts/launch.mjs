import { spawn } from 'node:child_process';
import { mkdir, access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../tests/playwright-loader.mjs';
import { startServer } from './serve.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const extension = join(root, 'dist/AudioXtractor');
await access(join(extension, 'manifest.json'));
const profile = join(root, '.local-profile');
await mkdir(profile, { recursive: true });
const { chromium } = await loadPlaywright();
const studio = await startServer(4173).catch(error => error.code === 'EADDRINUSE' ? startServer(0) : Promise.reject(error));
// Launch Chromium directly so normal downloads survive closing the preview.
const browser = spawn(chromium.executablePath(), [`--user-data-dir=${profile}`, `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--new-window', `${studio.url}/fixture`], { stdio: 'ignore', windowsHide: true });
browser.on('error', error => { console.error(error.message); studio.server.close(); process.exitCode = 1; });
browser.on('exit', () => studio.server.close());
console.log(`AudioXtractor is deployed in a separate local Chromium profile.\nStudio: ${studio.url}/fixture\nExtension: ${extension}\nOpen the puzzle-piece menu, then AudioXtractor. Play reference audio to try it.\nDownloads use Chromium's normal download folder. Close the preview browser to stop the studio.`);
// Open the toolbar action through the preview browser's local debugging socket.
// No audio is started; the reference player remains paused until the user acts.
let socket;
try {
  let endpoint;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { const lines = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/); endpoint = `ws://127.0.0.1:${lines[0]}${lines[1]}`; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  if (!endpoint) throw new Error('Preview browser is still starting.');
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0; const pending = new Map();
  socket.addEventListener('message', event => { const data = JSON.parse(event.data); const entry = pending.get(data.id); if (entry) { clearTimeout(entry.timeout); pending.delete(data.id); data.error ? entry.reject(new Error(data.error.message)) : entry.resolve(data.result); } });
  const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Preview action timed out.')); }, 5000); pending.set(id, { resolve, reject, timeout }); socket.send(JSON.stringify({ id, method, params })); });
  for (let attempt = 0; attempt < 30; attempt++) {
    const { extensions } = await call('Extensions.getExtensions');
    const audioxtractor = extensions.find(item => item.path.toLowerCase() === extension.toLowerCase());
    const { targetInfos } = await call('Target.getTargets', { filter: [{ type: 'tab' }] });
    const page = targetInfos.find(item => item.url === `${studio.url}/fixture`);
    if (audioxtractor && page) { await new Promise(resolve => setTimeout(resolve, 400)); await call('Extensions.triggerAction', { id: audioxtractor.id, targetId: page.targetId }); console.log('AudioXtractor window opened. No test audio is playing.'); break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
} catch (error) { console.log(`${error.message} You can open AudioXtractor from the extensions menu.`); }
finally { socket?.close(); }
