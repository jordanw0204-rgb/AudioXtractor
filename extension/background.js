import { classifyMedia, sourceId, sourceLabel, downloadFilename } from './lib/media.js';
import { responseSize } from './lib/media.js';
import { native, nativeStatus } from './lib/native.js';
import { targetTab, settings, pinPanel, openPanel, savePinPreference } from './lib/panel.js';
import { youtubeLinks } from './lib/youtube.js';

const queues = new Map();
const downloadJobs = new Map();
let creatingOffscreen;
let starting = false;
let captureQueue = Promise.resolve();
const recorderPanels = new Map();
const recorderVisible = () => [...recorderPanels.values()].includes('recorder');
const idle = () => ({ status: 'idle', frames: 0, sampleRate: 0, channels: 0, bytes: 0 });
const keyFor = id => `sources-${id}`;

function changeSources(tabId, mutate) {
  const key = keyFor(tabId);
  const next = (queues.get(tabId) || Promise.resolve()).catch(() => {}).then(async () => {
    const previous = (await chrome.storage.session.get(key))[key] || [];
    const sources = mutate(previous).slice(-150);
    await chrome.storage.session.set({ [key]: sources });
    const state = (await chrome.storage.session.get('recorder')).recorder;
    if (!state || state.status === 'idle') await chrome.action.setBadgeText({ tabId, text: sources.length ? String(sources.length) : '' });
  });
  queues.set(tabId, next);
  next.finally(() => { if (queues.get(tabId) === next) queues.delete(tabId); }).catch(() => {});
  return next;
}

function mergeSource(sources, data) {
  const index = sources.findIndex(source => source.url === data.url);
  if (index === -1) sources.push({ id: sourceId(data.url), label: sourceLabel(data.url), playing: false, firstSeen: Date.now(), ...data });
  else sources[index] = { ...sources[index], ...data, label: data.label || sources[index].label };
  return sources;
}

chrome.webRequest.onHeadersReceived.addListener(details => {
  if (details.tabId < 0 || details.statusCode < 200 || details.statusCode >= 400 || details.method !== 'GET') return;
  const headers = Object.fromEntries((details.responseHeaders || []).map(header => [header.name.toLowerCase(), header.value || '']));
  const media = classifyMedia(details.url, headers['content-type']);
  if (!media) return;
  changeSources(details.tabId, sources => mergeSource(sources, { ...media, url: details.url, mime: headers['content-type'] || '', size: responseSize(headers), frameId: details.frameId, lastSeen: Date.now(), detected: 'network' })).catch(() => {});
}, { urls: ['http://*/*', 'https://*/*'], types: ['media', 'xmlhttprequest', 'other'] }, ['responseHeaders']);

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') changeSources(tabId, () => []).catch(() => {});
});
chrome.tabs.onRemoved.addListener(tabId => {
  changeSources(tabId, () => []).catch(() => {}).then(() => chrome.storage.session.remove(keyFor(tabId))).catch(() => {});
});

async function ensureOffscreen() {
  if (creatingOffscreen) { await creatingOffscreen; return; }
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  if (!creatingOffscreen) creatingOffscreen = chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA', 'BLOBS'], justification: 'Record current-tab audio, retain local WAVs and serve playback URLs.' }).finally(() => { creatingOffscreen = null; });
  await creatingOffscreen;
}

async function offscreen(type, data = {}) {
  await ensureOffscreen();
  // A new document can exist before its module has installed the listener.
  // Probe without side effects before issuing capture or file operations.
  let ready;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { ready = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'STATE' }); } catch { /* Loading. */ }
    if (ready?.ok) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!ready?.ok) throw new Error('The audio engine could not start. Reopen AudioXtractor and try again.');
  if (type === 'STATE') return ready;
  const result = await chrome.runtime.sendMessage({ target: 'offscreen', type, ...data });
  if (!result?.ok) throw new Error(result?.error || 'The audio engine did not respond.');
  return result;
}

async function updateRecorder(state) {
  const previous = (await chrome.storage.session.get('recorder')).recorder;
  await chrome.storage.session.set({ recorder: state });
  const recording = ['recording', 'paused', 'stopping'].includes(state.status);
  await chrome.action.setBadgeBackgroundColor({ color: state.status === 'paused' ? '#797979' : '#e66767' });
  const badge = recording ? state.status === 'paused' ? 'Ⅱ' : 'REC' : '';
  await chrome.action.setBadgeText({ text: badge });
  if (state.tabId != null) await chrome.action.setBadgeText({ tabId: state.tabId, text: badge });
  if (previous?.tabId != null && (!recording || previous.tabId !== state.tabId)) {
    const sources = (await chrome.storage.session.get(keyFor(previous.tabId)))[keyFor(previous.tabId)] || [];
    await chrome.action.setBadgeText({ tabId: previous.tabId, text: sources.length ? String(sources.length) : '' }).catch(() => {});
  }
}

function captureCommand(action) {
  const result = captureQueue.catch(() => {}).then(action);
  captureQueue = result.catch(() => {}); return result;
}
async function prepareRecorder() {
    // UI snapshots can lag a toolbar invocation on another website.
    const selected = await targetTab();
    if (!selected?.id || !/^https?:/.test(selected.url || '')) throw new Error('Open a regular website to record its audio.');
    const tab = { id: selected.id, title: selected.title || 'Tab audio', url: selected.url };
    const current = await offscreen('STATE');
    if (['recording', 'paused', 'stopping', 'starting'].includes(current.state.status)) return { ...current, tab };
    if (current.state.connected && current.state.tabId === tab.id) return { ...current, tab };
    if (current.state.connected) await offscreen('DISCONNECT', { onlyIfIdle: true });
    await offscreen('PREPARE'); // Warm output before the short-lived stream ID.
    let streamId;
    try { streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }); }
    catch (error) { throw new Error(`Click the AudioXtractor toolbar icon on this website, then open Recorder again. ${error.message}`); }
    return { ...await offscreen('ATTACH', { streamId, tab }), tab };
}
function connectRecorder() { return captureCommand(prepareRecorder); }
function releaseUnusedCapture() {
  return captureCommand(async () => {
    if (starting || recorderVisible()) return;
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (!contexts.length || starting || recorderVisible()) return;
    await offscreen('DISCONNECT', { onlyIfIdle: true });
  }).catch(() => {});
}

async function handle(message, sender) {
  if (message.type === 'MEDIA_SNAPSHOT') {
    const tabId = sender.tab?.id;
    if (tabId == null) return {};
    await changeSources(tabId, sources => {
      sources = sources.map(source => source.domFrame === sender.frameId ? { ...source, playing: false } : source);
      for (const item of (Array.isArray(message.media) ? message.media : []).slice(0, 100)) {
        if (typeof item.url !== 'string' || item.url.length > 16384) continue;
        const media = classifyMedia(item.url, item.mime, item.elementType);
        if (media) mergeSource(sources, { ...media, url: item.url, ...(item.title ? { label: String(item.title).slice(0, 180) } : {}), playing: Boolean(item.playing), duration: Number.isFinite(item.duration) ? item.duration : null, domFrame: sender.frameId, lastSeen: Date.now() });
      }
      return sources;
    });
    return {};
  }
  // Content scripts may report their own media, but cannot control capture or downloads.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) throw new Error('This action is only available in AudioXtractor.');
  switch (message.type) {
    case 'GET_STATE': {
      const tab = await targetTab();
      const stored = await chrome.storage.session.get([keyFor(tab?.id), 'recorder']);
      let recorder = stored.recorder || idle();
      if (recorder.status !== 'idle' || recorder.connected) {
        const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
        if (!contexts.length) { recorder = { ...idle(), error: 'The audio engine closed. Start a new recording.' }; await updateRecorder(recorder); }
      }
      return { tab: tab ? { id: tab.id, title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl, audible: tab.audible } : null, sources: stored[keyFor(tab?.id)] || [], recorder, settings: await settings() };
    }
    case 'SCAN': {
      const tab = await targetTab();
      if (!tab?.id || !/^https?:/.test(tab.url || '')) throw new Error('Open a regular website to find audio.');
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] });
      return {};
    }
    case 'DOWNLOAD_SOURCE': {
      const sources = (await chrome.storage.session.get(keyFor(message.tabId)))[keyFor(message.tabId)] || [];
      const source = sources.find(item => item.id === message.id);
      if (!source || !source.downloadable || !/^https?:/.test(source.url)) throw new Error('This stream is not a complete downloadable file. Use the recorder.');
      const downloadId = await chrome.downloads.download({ url: source.url, filename: downloadFilename(source), conflictAction: 'uniquify', saveAs: false });
      downloadJobs.set(downloadId, { source: source.label });
      return { downloadId };
    }
    case 'START_RECORDING': {
      if (starting) throw new Error('A recording is already starting.');
      starting = true;
      try {
        return await captureCommand(async () => {
          const current = await prepareRecorder();
          if (current.state.status !== 'idle') throw new Error('Stop the current recording first.');
          return offscreen('START', { requestedAt: message.requestedAt, tab: current.tab });
        });
      } finally { starting = false; }
    }
    case 'CONNECT_RECORDER': return connectRecorder();
    case 'PAUSE_RECORDING': return offscreen('PAUSE');
    case 'WARM_RECORDER': return offscreen('PREPARE');
    case 'RESUME_RECORDING': return offscreen('RESUME');
    case 'STOP_RECORDING': return offscreen('STOP');
    case 'DISCONNECT_RECORDER': return captureCommand(() => offscreen('DISCONNECT', { onlyIfIdle: Boolean(message.onlyIfIdle) }));
    case 'ENGINE_STATE':
      await updateRecorder(message.state);
      if (message.state.status === 'idle' && message.state.connected && !starting && !recorderVisible()) releaseUnusedCapture();
      if (message.state.lastRecording) offscreen('CACHE_RECORDINGS', { ids: [message.state.lastRecording.id] }).catch(() => {});
      return {};
    case 'ENGINE_METER': chrome.runtime.sendMessage({ target: 'popup', type: 'METER', waveform: message.waveform, peak: message.peak }).catch(() => {}); return {};
    case 'LIST_RECORDINGS': return offscreen('LIST');
    case 'RECORDING_URL': return offscreen('URL', { id: message.id });
    case 'RELEASE_URL': return offscreen('RELEASE_URL', { url: message.url });
    case 'DELETE_RECORDING': return offscreen('DELETE', { id: message.id });
    case 'NATIVE_STATUS': return nativeStatus();
    case 'NATIVE': return native(message.command, message.data || {});
    case 'PANEL_SETTINGS': return { settings: await settings() };
    case 'PIN': return pinPanel(message.pinned);
    case 'SAVE_PIN_PREFERENCE': return savePinPreference(message.pinned);
    case 'OPEN_PANEL': return { panel: await openPanel(await targetTab()) };
    case 'PREPARE_FILES': return offscreen('CACHE_RECORDINGS', { ids: message.ids });
    case 'DRAG_FILES': return native('DRAG', { ids: message.ids });
    case 'DRAG_INFO': return native('DRAG_INFO', { ids: message.ids });
    case 'LIST_JOBS': return native('LIST_JOBS');
    case 'QUEUE_YOUTUBE': return native('QUEUE', { urls: youtubeLinks(message.links), mode: 'mp3' });
    case 'CANCEL_JOB': return native('CANCEL', { jobId: message.id });
    case 'DELETE_JOB': return native('DELETE_JOB', { jobId: message.id });
    case 'EXPORT_JOBS': return native('EXPORT', { ids: message.ids });
    case 'JOB_URL': return offscreen('JOB_URL', { id: message.id });
    case 'RESOLVE_SOURCES': {
      const tab = await targetTab();
      if (!tab?.url) throw new Error('Select a website first.');
      const result = await native('RESOLVE', { url: tab.url });
      await changeSources(tab.id, sources => {
        for (const resolved of result.sources) mergeSource(sources, { id: sourceId(resolved.url), url: resolved.url, label: `${resolved.title} · ${resolved.format}${resolved.bitrate ? ` ${Math.round(resolved.bitrate)} kbps` : ''}`, kind: 'file', format: resolved.format, downloadable: true, size: resolved.size, nativePage: resolved.pageUrl || tab.url, nativeFormat: resolved.formatId, bitrate: resolved.bitrate, resolved: true, lastSeen: Date.now() });
        return sources;
      });
      return { count: result.sources.length };
    }
    case 'DOWNLOAD_ORIGINAL': {
      const sources = (await chrome.storage.session.get(keyFor(message.tabId)))[keyFor(message.tabId)] || [];
      const source = sources.find(item => item.id === message.id);
      if (!source?.nativePage || !source.nativeFormat) throw new Error('Resolve the page audio first.');
      return native('QUEUE', { urls: [source.nativePage], format: source.nativeFormat, mode: 'original' });
    }
    case 'DOWNLOAD_RECORDING': {
      const result = await offscreen('URL', { id: message.id });
      try {
        const downloadId = await chrome.downloads.download({ url: result.url, filename: `AudioXtractor/${result.filename}`, conflictAction: 'uniquify', saveAs: false });
        downloadJobs.set(downloadId, { url: result.url });
        return { downloadId };
      } catch (error) { await offscreen('RELEASE_URL', { url: result.url }); throw error; }
    }
    default: throw new Error('Unknown action.');
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'background') return;
  handle(message, sender).then(result => sendResponse({ ...result, ok: true }), error => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'audioxtractor-panel' || port.sender?.id !== chrome.runtime.id || !port.sender?.url?.startsWith(chrome.runtime.getURL(''))) return;
  recorderPanels.set(port, 'sources');
  port.onMessage.addListener(message => {
    if (!['sources', 'recorder', 'youtube'].includes(message.view)) return;
    recorderPanels.set(port, message.view);
    if (!recorderVisible()) releaseUnusedCapture();
  });
  port.onDisconnect.addListener(async () => {
    recorderPanels.delete(port);
    if (!recorderVisible()) releaseUnusedCapture();
  });
});

chrome.downloads.onChanged.addListener(async delta => {
  if (!delta.state || !['complete', 'interrupted'].includes(delta.state.current)) return;
  const job = downloadJobs.get(delta.id);
  if (job?.url) await offscreen('RELEASE_URL', { url: job.url }).catch(() => {});
  downloadJobs.delete(delta.id);
  if (delta.state.current === 'interrupted') {
    await chrome.storage.session.set({ downloadError: { id: delta.id, message: 'Download interrupted. The site may require its player or an expired link. Try recording instead.', at: Date.now() } });
  }
});
