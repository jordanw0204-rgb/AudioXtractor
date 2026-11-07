import { MAX_DATA_BYTES } from './lib/wav.js';
import { createRecording, finishRecording, abandonRecording, listRecordings, recordingFile, deleteRecording } from './lib/recordings.js';
import { prepareAudioEngine } from './lib/audio-engine.js';
import { connectCapture } from './lib/capture-session.js';

let session = null;
let connection = null;
let attachment = null, connectingTab = null;
let startPending = false;
let lastError = '';
const urls = new Map();
const nativeLittleEndian = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 4;
const idle = () => ({ status: connectingTab ? 'connecting' : startPending ? 'starting' : 'idle', frames: 0, sampleRate: connection?.sampleRate || 0, channels: connection?.channels || 0, bytes: 0, error: lastError, connected: Boolean(connection && !connection.closed && !connection.ended), connectionId: connection?.id, tabId: connection?.tab.id ?? connectingTab?.id, title: connection?.tab.title ?? connectingTab?.title });
function state() {
  if (!session) return idle();
  const { status, frames, sampleRate, channels, tab, startedAt, error, captureMs, totalStartMs, reusedConnection } = session;
  return { status, frames, sampleRate, channels, tabId: tab.id, title: tab.title, startedAt, bytes: frames * channels * 4 + 56, error, captureMs, totalStartMs, reusedConnection, connected: Boolean(connection && !connection.closed && !connection.ended), connectionId: connection?.id, preparedConnection: true };
}
function notify(type, data) { return chrome.runtime.sendMessage({ target: 'background', type, ...data }).catch(() => {}); }
function publish(extra = {}) { return notify('ENGINE_STATE', { state: { ...state(), ...extra } }); }
const caching = new Map();
async function native(command, data = {}) {
  const result = await chrome.runtime.sendMessage({ target: 'background', type: 'NATIVE', command, data });
  if (!result?.ok) throw new Error(result?.error || 'Desktop companion unavailable.');
  return result;
}
async function cacheRecording(id) {
  if (caching.has(id)) return caching.get(id);
  const operation = (async () => {
    const { file, metadata } = await recordingFile(id);
    const status = await native('FILE_STATUS', { fileId: id });
    if (status.ready && status.size === file.size) return;
    await native('FILE_BEGIN', { fileId: id, filename: metadata.filename, size: file.size });
    for (let offset = 0; offset < file.size; offset += 192 * 1024) {
      const bytes = new Uint8Array(await file.slice(offset, offset + 192 * 1024).arrayBuffer());
      let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      await native('FILE_CHUNK', { fileId: id, offset, data: btoa(binary) });
    }
    await native('FILE_END', { fileId: id });
  })().finally(() => caching.delete(id));
  caching.set(id, operation); return operation;
}

function receivePcm(data, graph) {
  const current = session;
  if (!current || current.graph !== graph) return;
  if ((current.frames + data.frames) * current.channels * 4 > MAX_DATA_BYTES) { stop('The 2 GB WAV limit was reached. Your recording has been saved.').catch(() => {}); return; }
  let bytes = new Uint8Array(data.buffer);
  if (!nativeLittleEndian) {
    const samples = new Float32Array(data.buffer), converted = new ArrayBuffer(data.buffer.byteLength), view = new DataView(converted);
    for (let i = 0; i < samples.length; i++) view.setFloat32(i * 4, samples[i], true);
    bytes = new Uint8Array(converted);
  }
  current.frames += data.frames; current.queuedBytes += bytes.byteLength;
  current.writes = current.writes.then(() => current.file.writer.write(bytes)).finally(() => { current.queuedBytes -= bytes.byteLength; });
  current.writes.catch(error => { current.writeError = error; stop('Storage failed. Free some disk space and try again.').catch(() => {}); });
  if (current.queuedBytes > 32 * 1024 ** 2) stop('Storage could not keep up. Your recording has been saved.').catch(() => {});
  notify('ENGINE_METER', { waveform: data.waveform, peak: data.peak });
}

function dropConnection() {
  const graph = connection; connection = null; graph?.dispose();
}
async function disconnect(onlyIfIdle = false, connectionId) {
  if (connectionId && connection?.id !== connectionId) return { state: state() };
  if (session || startPending || attachment) {
    if (onlyIfIdle) return { state: state() };
    throw new Error('Stop and save the current recording before disconnecting.');
  }
  dropConnection(); await publish(); return { state: state() };
}
async function attach(message) {
  const tab = message.tab;
  if (!Number.isInteger(tab?.id)) throw new Error('Open a regular website to record its audio.');
  if (attachment) await attachment;
  if (connection && !connection.closed && !connection.ended && connection.tab.id === tab.id) return { state: state() };
  if (session || startPending) throw new Error('Stop the current recording before changing tabs.');
  dropConnection(); lastError = ''; connectingTab = tab;
  attachment = (async () => {
    await publish();
    connection = await connectCapture({ streamId: message.streamId, tab, onPcm: receivePcm, onMeter: data => notify('ENGINE_METER', { waveform: data.waveform, peak: data.peak }), onEnded: connectionEnded });
  })();
  try { await attachment; }
  catch (error) { dropConnection(); lastError = error.message; throw error; }
  finally { attachment = null; connectingTab = null; await publish(); }
  return { state: state() };
}
function connectionEnded(graph, reason) {
  if (session?.graph === graph) stop(reason).catch(() => {});
  else { if (connection === graph) dropConnection(); publish().catch(() => {}); }
}

async function start(message) {
  if (session || startPending) throw new Error('A recording is already running.');
  startPending = true; lastError = '';
  const requestedAt = Number.isFinite(message.requestedAt) ? message.requestedAt : performance.timeOrigin + performance.now();
  let file, current;
  try {
    await publish();
    const estimate = await navigator.storage.estimate();
    if (estimate.quota && estimate.quota - estimate.usage < 16 * 1024 ** 2) throw new Error('Local storage is almost full. Download and delete older recordings first.');
    if (attachment) await attachment;
    if (!connection || connection.closed || connection.ended || connection.tab.id !== message.tab?.id) throw new Error('Connect the current website before recording.');
    const graph = connection;
    file = await createRecording(message.tab.title);
    current = { file, graph, tab: message.tab, sampleRate: graph.sampleRate, channels: graph.channels, frames: 0, queuedBytes: 0, status: 'starting', writes: Promise.resolve(), startedAt: Date.now(), error: '', captureMs: 0, reusedConnection: graph.takes > 0 };
    session = current;
    await graph.command('start');
    // Stop sharing can arrive while the start acknowledgment is in flight.
    // Let that save finish; do not create a recording timer after it stopped.
    if (current.stopPromise) { const stopped = await current.stopPromise; startPending = false; return { ...stopped, state: state() }; }
    if (session !== current) { startPending = false; return { state: state() }; }
    if (graph.ended || graph.closed) { const stopped = await stop('The tab disconnected. Your recording has been saved.'); startPending = false; return { ...stopped, state: state() }; }
    current.totalStartMs = performance.timeOrigin + performance.now() - requestedAt;
    graph.takes++; current.status = 'recording'; current.timer = setInterval(() => publish(), 500);
    return { state: state() };
  } catch (error) {
    if (current) clearInterval(current.timer);
    dropConnection();
    if (file) await abandonRecording(file);
    session = null; lastError = error.message; throw error;
  } finally { startPending = false; await publish(); }
}

async function stop(reason = '') {
  const current = session;
  if (!current) return { state: state() };
  if (reason) current.endReason = reason;
  if (current.stopPromise) return current.stopPromise;
  current.status = 'stopping'; clearInterval(current.timer);
  current.stopPromise = (async () => {
    await publish();
    let record;
    try {
      if (!current.graph.closed && !current.graph.processorFailed) await current.graph.command('stop');
      await current.writes;
      if (current.writeError) throw current.writeError;
      if (current.frames) record = await finishRecording(current.file, { sampleRate: current.sampleRate, channels: current.channels, frames: current.frames, origin: new URL(current.tab.url).hostname });
      else await abandonRecording(current.file);
      lastError = reason || current.endReason || '';
    } catch (error) {
      dropConnection(); await abandonRecording(current.file);
      lastError = 'Could not save the recording: ' + error.message; throw error;
    } finally {
      session = null;
      if (reason || current.graph.closed || current.graph.ended) dropConnection();
      await publish({ lastRecording: record || null });
    }
    return { state: state(), recording: record };
  })();
  return current.stopPromise;
}

async function handle(message) {
  switch (message.type) {
    case 'STATE': return { state: state() };
    case 'PREPARE':
      if (!session && !connection) await prepareAudioEngine();
      return { ready: true };
    case 'START': return start(message);
    case 'ATTACH': return attach(message);
    case 'DISCONNECT': return disconnect(message.onlyIfIdle, message.connectionId);
    case 'PAUSE': {
      const current = session;
      if (!current || current.status !== 'recording') throw new Error('No active recording to pause.');
      await current.graph.command('pause');
      if (session !== current || current.stopPromise) return { state: state() };
      current.status = 'paused'; await publish(); return { state: state() };
    }
    case 'RESUME': {
      const current = session;
      if (!current || current.status !== 'paused') throw new Error('No paused recording to resume.');
      await current.graph.command('resume');
      if (session !== current || current.stopPromise) return { state: state() };
      current.status = 'recording'; await publish(); return { state: state() };
    }
    case 'STOP': return stop();
    case 'LIST': return { recordings: await listRecordings() };
    case 'CACHE_RECORDINGS': {
      const ready = [];
      for (const id of (message.ids || []).slice(0, 200)) { await cacheRecording(id); ready.push(id); }
      return { ready };
    }
    case 'JOB_URL': {
      const parts = []; let offset = 0, result;
      do {
        result = await native('READ_FILE', { fileId: message.id, offset });
        if (result.size > 128 * 1024 ** 2) throw new Error('This audio is too large for an in-app preview. Drag or download it to your audio player.');
        const binary = atob(result.data); const part = Uint8Array.from(binary, character => character.charCodeAt(0)); parts.push(part); offset += part.length;
      } while (offset < result.size);
      const url = URL.createObjectURL(new Blob(parts, { type: result.filename.toLowerCase().endsWith('.mp3') ? 'audio/mpeg' : 'audio/mp4' }));
      urls.set(url, { timeout: setTimeout(() => release(url), 3600000), id: message.id });
      return { url };
    }
    case 'URL': {
      const { file, metadata } = await recordingFile(message.id);
      const url = URL.createObjectURL(file);
      const timeout = setTimeout(() => release(url), 60 * 60 * 1000);
      urls.set(url, { timeout, id: message.id });
      return { url, filename: metadata.filename };
    }
    case 'RELEASE_URL': release(message.url); return {};
    case 'DELETE':
      for (const [url, entry] of urls) if (entry.id === message.id) release(url);
      await deleteRecording(message.id);
      await native('FILE_DELETE', { fileId: message.id }).catch(() => {});
      return {};
    default: throw new Error('Unknown audio engine action.');
  }
}
function release(url) {
  if (!urls.has(url)) return;
  clearTimeout(urls.get(url).timeout); urls.delete(url); URL.revokeObjectURL(url);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen' || sender.id !== chrome.runtime.id || sender.tab) return;
  handle(message).then(result => sendResponse({ ...result, ok: true }), error => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});
