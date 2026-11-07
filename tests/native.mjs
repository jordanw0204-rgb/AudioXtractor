import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../scripts/serve.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const companion = join(root, 'dist/AudioXtractor-Companion', version);
const exe = join(companion, 'AudioXtractor.Native.exe');
const results = [];
const check = label => { results.push(label); console.log(`PASS ${label}`); };
const oleTest = JSON.parse(execFileSync(exe, ['--drag-self-test'], { encoding: 'utf8', timeout: 5000, windowsHide: true }));
assert(Object.values(oleTest).every(Boolean));
check('Windows COM round trip accepts the native drop-source callback and CF_HDROP format');
const selfTest = JSON.parse(execFileSync(exe, ['--self-test'], { encoding: 'utf8' }));
assert(Object.values(selfTest).every(Boolean));
check('Win32 topmost toggles, OLE multi-file payload and unsafe URL rejection');
const child = spawn(exe, ['chrome-extension://lpbcknnfflbgmjglnoopgmnkjgpdibin/'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const waiting = new Map();
let buffer = Buffer.alloc(0);
child.stdout.on('data', data => {
  buffer = Buffer.concat([buffer, data]);
  while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
    const size = buffer.readUInt32LE(0), message = JSON.parse(buffer.subarray(4, size + 4)); buffer = buffer.subarray(size + 4);
    const pending = waiting.get(message.id);
    if (pending) { clearTimeout(pending.timer); waiting.delete(message.id); message.ok ? pending.resolve(message) : pending.reject(new Error(message.error)); }
  }
});
child.stderr.on('data', data => console.error(data.toString()));
function request(command, data = {}, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const id = randomUUID(), payload = Buffer.from(JSON.stringify({ id, command, ...data })), header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`Native request timed out: ${command}`)); }, timeout);
    waiting.set(id, { resolve, reject, timer }); child.stdin.write(Buffer.concat([header, payload]));
  });
}
async function poll(fn, predicate, label, timeout = 120000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const result = await fn(); if (predicate(result)) return result; await new Promise(resolve => setTimeout(resolve, 350)); }
  throw new Error(`Timed out: ${label}`);
}
const studio = await startServer();
studio.server.on('request', request => console.log(`Reference request ${request.method} ${request.url}`));
try {
  const hello = await request('HELLO', { clientId: randomUUID() });
  assert(hello.ytDlp && hello.ffmpeg && hello.nativeDrag);
  check('Native messaging framing and installed tools are ready');
  const fileIds = [];
  for (const filename of ['Reference A.wav', 'Reference B.wav']) {
    const fileId = randomUUID(); fileIds.push(fileId);
    await request('FILE_BEGIN', { fileId, filename, size: studio.wav.length });
    for (let offset = 0; offset < studio.wav.length; offset += 192 * 1024) await request('FILE_CHUNK', { fileId, offset, data: studio.wav.subarray(offset, offset + 192 * 1024).toString('base64') });
    await request('FILE_END', { fileId });
    assert.equal((await request('FILE_STATUS', { fileId })).size, studio.wav.length);
  }
  const drag = await request('DRAG_INFO', { ids: fileIds });
  assert.deepEqual(drag.formats, ['FileDrop']); assert.equal(drag.files.length, 2);
  for (const path of drag.files) assert.deepEqual(await readFile(path), studio.wav);
  check('Chunked audio transfer is byte-exact and exposes two real native drag files');
  await assert.rejects(request('FILE_BEGIN', { fileId: '../escape', filename: 'unsafe.wav', size: 0 }));
  await assert.rejects(request('READ_FILE', { fileId: fileIds[0], offset: -1 }));
  await assert.rejects(request('QUEUE', { urls: ['https://youtube.com.evil.test/watch?v=jNQXAC9IVRw'], mode: 'mp3' }));
  check('Companion rejects traversal, invalid offsets and non-YouTube conversion URLs');
  try {
    const resolved = await request('RESOLVE', { url: `${studio.url}/fixture` }, 110000);
    assert(resolved.sources.length > 0); check('Page resolver returns original local reference audio');
  } catch (error) { console.log(`Resolver diagnostic: ${error.message}`); throw error; }

  const queued = await request('QUEUE', { urls: [process.env.AUDIOXTRACTOR_TEST_YOUTUBE_URL || 'https://www.youtube.com/watch?v=jNQXAC9IVRw'], mode: 'mp3' });
  assert.equal(queued.count, 1);
  const jobs = await poll(() => request('LIST_JOBS'), data => data.jobs.some(job => ['completed', 'failed'].includes(job.status)), 'real YouTube conversion');
  const job = jobs.jobs[0];
  if (job.status !== 'completed') throw new Error(`YouTube conversion failed: ${job.error}`);
  assert(job.file.endsWith('.mp3')); assert(job.bytes > 1000);
  const tools = JSON.parse(await readFile(join(companion, 'tools.json'), 'utf8'));
  const probe = join(dirname(tools.ffmpeg), 'ffprobe.exe');
  const info = JSON.parse(execFileSync(probe, ['-v', 'error', '-show_streams', '-of', 'json', job.file], { encoding: 'utf8' }));
  assert.equal(info.streams[0].codec_name, 'mp3');
  check(`Real YouTube video converts through yt-dlp and FFmpeg to MP3 (${job.bytes} bytes)`);
  const mp3Drag = await request('DRAG_INFO', { ids: [job.id] }); assert.equal(mp3Drag.files[0], job.file);
  const preview = await request('READ_FILE', { fileId: job.id, offset: 0 }); assert(preview.data.length > 0);
  check('Converted audio exposes native drag files and in-app preview bytes');
  for (const fileId of fileIds) await request('FILE_DELETE', { fileId });
  await request('DELETE_JOB', { jobId: job.id });
  check('Explicit local deletion removes test recordings and conversion');
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  child.stdin.end();
  await new Promise(resolve => child.once('exit', resolve));
  await new Promise(resolve => studio.server.close(resolve));
  await mkdir(join(root, 'test-results'), { recursive: true });
  await writeFile(join(root, 'test-results/native-report.json'), JSON.stringify({ passed: results, at: new Date().toISOString() }, null, 2));
  console.log(`${results.length} native checks passed.`);
}
