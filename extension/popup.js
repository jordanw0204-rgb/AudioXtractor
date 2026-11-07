import { formatBytes, formatTime } from './lib/media.js';

const $ = selector => document.querySelector(selector);
document.title = 'AudioXtractor';
let snapshot = { tab: null, sources: [], recorder: { status: 'idle' } };
let recordings = [];
let busy = false;
let toastTimer;
let deleting;
let playback;
let playbackId;
let playbackUrl;
let playbackRequest = 0;
let waveform = new Array(96).fill(0);
let displayed = [...waveform];
let lastMeterAt = 0;
let peak = 0;
let currentView = 'sources';
let lastSources = '';
let lastLibrary = '';
let lastRecorder = '';
let lastSite = '';
let panelPresence;

async function request(type, data = {}) {
  if (!globalThis.chrome?.runtime?.id) throw new Error('Load AudioXtractor as a browser extension to use it. See the installation guide.');
  const result = await chrome.runtime.sendMessage({ target: 'background', type, ...data });
  if (!result?.ok) throw new Error(result?.error || 'AudioXtractor could not connect. Reopen the extension and try again.');
  return result;
}

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.toggle('error', error);
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 7000 : 3500);
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`); svg.append(use); return svg;
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function button(className, label, iconName, action) {
  const node = element('button', className);
  node.type = 'button'; node.title = label; node.setAttribute('aria-label', label);
  node.append(icon(iconName)); node.addEventListener('click', action); return node;
}
function selectView(name) {
  currentView = name;
  for (const view of ['sources', 'recorder', 'youtube']) {
    const active = view === name;
    $(`#tab-${view}`).classList.toggle('active', active);
    $(`#tab-${view}`).setAttribute('aria-selected', String(active));
    $(`#tab-${view}`).tabIndex = active ? 0 : -1;
    $(`#panel-${view}`).hidden = !active;
  }
  panelPresence?.postMessage({ view: name });
  if (name === 'recorder') {
    loadLibrary();
    if (/^https?:/.test(snapshot.tab?.url || '') && snapshot.recorder.status === 'idle') request('CONNECT_RECORDER', { tabId: snapshot.tab.id }).catch(error => toast(error.message, true));
  }
  window.dispatchEvent(new CustomEvent('audioxtractor:view', { detail: name }));
}

function renderSite() {
  const { tab } = snapshot;
  const siteKey = JSON.stringify([tab, snapshot.sources.some(source => source.playing)]);
  if (siteKey === lastSite) return; lastSite = siteKey;
  let host = 'No website selected';
  try { const url = new URL(tab?.url); if (/^https?:$/.test(url.protocol)) host = url.hostname.replace(/^www\./, ''); } catch { /* No tab URL. */ }
  $('#site-title').textContent = host;
  $('#site-subtitle').textContent = tab?.title || 'Open a website and play some audio';
  $('#site-status').classList.toggle('audible', Boolean(tab?.audible || snapshot.sources.some(source => source.playing)));
  $('#site-status span').textContent = tab?.audible || snapshot.sources.some(source => source.playing) ? 'Playing' : 'Ready';
  const favicon = $('#site-favicon');
  if (tab?.url && /^https?:/.test(tab.url)) {
    const url = chrome.runtime.getURL(`_favicon/?pageUrl=${encodeURIComponent(tab.url)}&size=32`);
    if (favicon.src !== url) { favicon.hidden = false; $('#site-fallback').setAttribute('hidden', ''); favicon.src = url; }
    favicon.onerror = () => { favicon.hidden = true; $('#site-fallback').removeAttribute('hidden'); };
  } else { favicon.hidden = true; $('#site-fallback').removeAttribute('hidden'); }
}

function renderSources() {
  const sorted = [...snapshot.sources].sort((a, b) => Number(b.playing) - Number(a.playing) || (a.firstSeen || 0) - (b.firstSeen || 0));
  $('#source-count').textContent = sorted.length;
  const key = JSON.stringify(sorted.map(({ lastSeen, ...source }) => source));
  if (key === lastSources) return;
  lastSources = key;
  const fragment = document.createDocumentFragment();
  for (const source of sorted) {
    const row = element('article', `source-card${source.playing ? ' playing' : ''}`);
    row.dataset.id = source.id;
    const fileIcon = element('div', 'file-icon'); fileIcon.append(icon('wave'));
    const info = element('div', 'source-info');
    const title = element('div', 'source-title', source.label); title.title = source.label;
    const meta = element('div', 'source-meta');
    meta.append(element('span', 'format-badge', source.format));
    meta.append(element('span', 'meta-dot', '·'));
    if (source.playing) {
      const playing = element('span', 'playing-text');
      const eq = element('span', 'mini-eq'); eq.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < 3; i++) eq.append(element('i'));
      playing.append(eq, document.createTextNode('Playing')); meta.append(playing);
    } else meta.append(element('span', '', source.duration ? formatTime(source.duration) : source.kind === 'playlist' ? 'Playlist' : source.kind === 'blob' ? 'Page stream' : source.kind === 'segment' ? 'Partial stream' : formatBytes(source.size)));
    if (source.playing && source.size) meta.append(element('span', 'meta-dot', '·'), element('span', '', formatBytes(source.size)));
    info.append(title, meta);
    if (source.kind === 'video') info.append(element('div', 'source-reason', 'Video file · includes video'));
    else if (source.resolved) info.append(element('div', 'source-reason', 'Original audio stream · no MP3 conversion'));
    else if (!source.downloadable) info.append(element('div', 'source-reason', 'Capture this stream with the recorder'));
    const download = button(`download-button${source.downloadable ? '' : ' stream-button'}`, source.downloadable ? `Download ${source.label}` : 'Record this stream', source.downloadable ? 'download' : 'arrow', async () => {
      if (!source.downloadable) { selectView('recorder'); return; }
      download.disabled = true;
      try {
        await request(source.nativePage ? 'DOWNLOAD_ORIGINAL' : 'DOWNLOAD_SOURCE', { tabId: snapshot.tab.id, id: source.id });
        toast(source.nativePage ? 'Original audio queued. Follow its progress in YouTube / Exports.' : source.kind === 'video' ? 'Downloading the original video file.' : 'Downloading the original. No conversion.');
        if (source.nativePage) selectView('youtube');
      }
      catch (error) { toast(error.message, true); }
      finally { download.disabled = false; }
    });
    row.append(fileIcon, info, download); fragment.append(row);
  }
  $('#source-list').replaceChildren(fragment);
  $('#source-empty').hidden = sorted.length > 0;
  window.dispatchEvent(new Event('audioxtractor:sources'));
}

function renderRecorder() {
  const state = snapshot.recorder;
  const recorderKey = JSON.stringify([state.status, state.frames, state.sampleRate, state.channels, state.bytes, state.title, state.connected, busy, snapshot.tab?.id, snapshot.tab?.url]);
  if (recorderKey === lastRecorder) return; lastRecorder = recorderKey;
  const active = ['recording', 'paused'].includes(state.status);
  const stopping = ['connecting', 'starting', 'stopping'].includes(state.status);
  const seconds = state.frames / state.sampleRate || 0;
  $('#timer').replaceChildren(document.createTextNode(formatTime(seconds)), element('span', '', `.${Math.floor(seconds * 10) % 10}`));
  $('#recorder-display').className = `recorder-display ${state.status}`;
  const labels = { idle: state.connected ? 'TAB CONNECTED · READY TO RECORD' : 'READY TO RECORD', connecting: 'CONNECTING TO TAB', recording: 'RECORDING TAB AUDIO', paused: 'RECORDING PAUSED', stopping: 'SAVING YOUR RECORDING', starting: 'STARTING RECORDING' };
  $('#record-status').replaceChildren(element('i'), document.createTextNode(labels[state.status] || labels.idle));
  $('#record-button').classList.toggle('stopping', active);
  $('#record-button-label').textContent = active ? 'Stop & save recording' : state.status === 'connecting' ? 'Connecting…' : state.status === 'starting' ? 'Starting…' : stopping ? 'Saving…' : 'Start recording';
  $('#record-button').disabled = busy || stopping || (!active && !/^https?:/.test(snapshot.tab?.url || ''));
  $('#pause-button').hidden = !active;
  $('#pause-button').disabled = busy;
  $('#pause-button').setAttribute('aria-label', state.status === 'paused' ? 'Resume recording' : 'Pause recording');
  $('#pause-button').replaceChildren(icon(state.status === 'paused' ? 'play' : 'pause'));
  $('#tab-record-dot').hidden = !active;
  $('#capture-format').textContent = active || stopping || state.connected ? `${state.sampleRate / 1000} kHz · ${state.channels === 1 ? 'MONO' : state.channels === 2 ? 'STEREO' : `${state.channels} CH`} · FLOAT32` : '32-BIT FLOAT';
  $('#capture-size').textContent = active || stopping ? formatBytes(state.bytes) : 'UNCOMPRESSED';
  $('#capture-note').textContent = active ? `Recording: ${state.title || 'tab audio'}. This window can close safely.` : state.connected ? `Connected: ${state.title || 'website tab'}. Recording is stopped.` : 'Current website tab. No mic. Click Record to save audio.';
  $('#disconnect-recorder').hidden = !state.connected || active || stopping;
  if (!state.connected && state.status !== 'recording') { peak = 0; waveform = waveform.map(() => 0); }
}

async function refresh() {
  try {
    const previous = snapshot.recorder.status;
    snapshot = await request('GET_STATE');
    renderSite(); renderSources(); renderRecorder();
    window.dispatchEvent(new Event('audioxtractor:state'));
    if (previous !== 'idle' && snapshot.recorder.status === 'idle') { await loadLibrary(); if (snapshot.recorder.error) toast(snapshot.recorder.error, true); }
  } catch (error) { toast(error.message, true); }
}

async function loadLibrary() {
  try { recordings = (await request('LIST_RECORDINGS')).recordings; renderLibrary(); }
  catch (error) { toast(error.message, true); }
}

function stopPlayback() {
  playbackRequest++;
  playback?.pause(); playback = null; playbackId = null;
  if (playbackUrl) request('RELEASE_URL', { url: playbackUrl }).catch(() => {});
  playbackUrl = null; updatePlaybackButtons();
}

function updatePlaybackButtons() {
  for (const row of $('#recording-list').children) {
    const record = recordings.find(item => item.id === row.dataset.id);
    const control = row.querySelector('.play-button');
    if (!record || !control) continue;
    const playing = record.id === playbackId;
    const label = playing ? 'Stop preview' : `Play ${record.title}`;
    if (control.getAttribute('aria-label') === label) continue;
    control.setAttribute('aria-label', label); control.title = label;
    control.setAttribute('aria-pressed', String(playing));
    control.replaceChildren(icon(playing ? 'pause' : 'play'));
  }
}

function renderLibrary() {
  $('#recording-count').textContent = recordings.length;
  $('#library-empty').hidden = recordings.length > 0;
  const key = JSON.stringify(recordings);
  if (key === lastLibrary) { updatePlaybackButtons(); return; }
  lastLibrary = key;
  const fragment = document.createDocumentFragment();
  for (const record of recordings) {
    const row = element('article', 'recording-row'); row.dataset.id = record.id;
    let loading = false;
    const play = button('play-button', playbackId === record.id ? 'Stop preview' : `Play ${record.title}`, playbackId === record.id ? 'pause' : 'play', async () => {
      if (loading) return;
      const same = playbackId === record.id;
      stopPlayback(); if (same) return;
      const requestId = playbackRequest;
      loading = true; play.setAttribute('aria-busy', 'true');
      try {
        const result = await request('RECORDING_URL', { id: record.id });
        if (requestId !== playbackRequest) { request('RELEASE_URL', { url: result.url }).catch(() => {}); return; }
        playbackUrl = result.url; playback = new Audio(result.url); playbackId = record.id;
        const audio = playback;
        playback.addEventListener('ended', () => { if (playback === audio) stopPlayback(); }, { once: true });
        playback.addEventListener('error', () => { if (playback === audio) { toast('Could not play this recording.', true); stopPlayback(); } }, { once: true });
        await playback.play(); updatePlaybackButtons();
      } catch (error) { if (requestId === playbackRequest) { stopPlayback(); toast(error.message, true); } }
      finally { loading = false; play.removeAttribute('aria-busy'); }
    });
    const info = element('div', 'source-info');
    const title = element('div', 'source-title', record.title); title.title = record.title;
    info.append(title, element('div', 'source-meta', `${formatTime(record.duration)} · ${formatBytes(record.bytes)} · WAV`));
    const actions = element('div', 'recording-actions');
    actions.append(button('icon-button', `Download recording ${record.title}`, 'download', async event => {
      const control = event.currentTarget; control.disabled = true;
      try { await request('DOWNLOAD_RECORDING', { id: record.id }); toast('Your uncompressed WAV is downloading.'); }
      catch (error) { toast(error.message, true); }
      finally { control.disabled = false; }
    }), button('icon-button', `Delete recording ${record.title}`, 'trash', () => { deleting = record.id; $('#delete-dialog').showModal(); }));
    row.append(play, info, actions); fragment.append(row);
  }
  $('#recording-list').replaceChildren(fragment);
  window.dispatchEvent(new Event('audioxtractor:library'));
}

$('#record-button').addEventListener('click', async () => {
  if (busy) return;
  busy = true; renderRecorder();
  stopPlayback();
  try {
    const result = await request(snapshot.recorder.status === 'idle' ? 'START_RECORDING' : 'STOP_RECORDING', { tabId: snapshot.tab?.id, requestedAt: performance.timeOrigin + performance.now() });
    if (result.state) snapshot.recorder = result.state;
    if (result.recording) { toast('Saved to your local recording library.'); await loadLibrary(); }
  } catch (error) { toast(error.message, true); }
  finally { busy = false; await refresh(); }
});
$('#pause-button').addEventListener('click', async () => {
  if (busy) return;
  busy = true; renderRecorder();
  try { await request(snapshot.recorder.status === 'paused' ? 'RESUME_RECORDING' : 'PAUSE_RECORDING'); }
  catch (error) { toast(error.message, true); }
  finally { busy = false; await refresh(); }
});
$('#disconnect-recorder').addEventListener('click', async () => {
  try { await request('DISCONNECT_RECORDER'); await refresh(); }
  catch (error) { toast(error.message, true); }
});
$('#refresh-button').addEventListener('click', async event => {
  const control = event.currentTarget; control.classList.add('spinning'); control.disabled = true;
  try { await request('SCAN'); await new Promise(resolve => setTimeout(resolve, 350)); await refresh(); toast(snapshot.sources.length ? 'Source list updated.' : 'Play audio on this page, then scan again.'); }
  catch (error) { toast(error.message, true); }
  finally { control.classList.remove('spinning'); control.disabled = false; }
});
for (const view of ['sources', 'recorder', 'youtube']) $(`#tab-${view}`).addEventListener('click', () => selectView(view));
$('.tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const views = ['sources', 'recorder', 'youtube'];
  const index = views.indexOf(event.target.closest('[role="tab"]')?.id.replace('tab-', ''));
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowLeft' ? 2 : 1)) % 3;
  event.preventDefault(); selectView(views[next]); $(`#tab-${currentView}`).focus();
});
$('#open-recorder').addEventListener('click', () => selectView('recorder'));
$('#help-button').addEventListener('click', () => $('#help-dialog').showModal());
$('#close-help').addEventListener('click', () => $('#help-dialog').close());
$('#cancel-delete').addEventListener('click', () => $('#delete-dialog').close());
$('#confirm-delete').addEventListener('click', async () => {
  if (!deleting) return;
  const id = deleting; deleting = null; $('#delete-dialog').close();
  if (playbackId === id) stopPlayback();
  try { await request('DELETE_RECORDING', { id }); await loadLibrary(); toast('Recording deleted from this device.'); }
  catch (error) { toast(error.message, true); }
});
$('#delete-dialog').addEventListener('close', () => { deleting = null; });

const canvas = $('#waveform');
const ctx = canvas.getContext('2d');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
function draw() {
  requestAnimationFrame(draw);
  if (currentView !== 'recorder') return;
  if (Date.now() - lastMeterAt > 600) { waveform = waveform.map(() => 0); peak = 0; }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#29292f'; ctx.lineWidth = 1;
  for (let x = 0; x < canvas.width; x += 36) { ctx.beginPath(); ctx.moveTo(x, 10); ctx.lineTo(x, canvas.height - 10); ctx.stroke(); }
  for (const y of [32, 80, 128]) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke(); }
  ctx.beginPath(); ctx.strokeStyle = snapshot.recorder.status === 'recording' ? '#d6d6df' : '#62626e'; ctx.lineWidth = 2;
  // Auto-scale only the drawing; captured PCM is never altered.
  const visualGain = peak > .00001 ? Math.min(16, .8 / peak) : 1;
  for (let i = 0; i < waveform.length; i++) {
    displayed[i] += (waveform[i] - displayed[i]) * (reducedMotion.matches ? 1 : .75);
    const x = i * canvas.width / (waveform.length - 1), y = canvas.height / 2 - Math.max(-1, Math.min(1, displayed[i] * visualGain)) * 66;
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  ctx.stroke();
  $('#peak-label').textContent = peak > .00001 ? `${(20 * Math.log10(peak)).toFixed(1)} dBFS` : '−∞ dBFS';
}
draw();

if (globalThis.chrome?.runtime?.id) {
  panelPresence = chrome.runtime.connect({ name: 'audioxtractor-panel' });
  panelPresence.onDisconnect.addListener(() => {});
  panelPresence.postMessage({ view: currentView });
  chrome.runtime.onMessage.addListener(message => {
    if (message.target === 'popup' && message.type === 'METER') { waveform = message.waveform; peak = message.peak; lastMeterAt = Date.now(); }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session') return;
    if (changes.sourceTabId) refresh();
    if (changes.recorder) {
      const previous = snapshot.recorder.status;
      snapshot.recorder = changes.recorder.newValue || { status: 'idle' }; renderRecorder();
      if (snapshot.recorder.status === 'idle' && previous !== 'idle') { loadLibrary(); if (snapshot.recorder.error) toast(snapshot.recorder.error, true); }
    }
    if (changes[`sources-${snapshot.tab?.id}`]) { snapshot.sources = changes[`sources-${snapshot.tab.id}`].newValue || []; renderSources(); renderSite(); }
    if (changes.downloadError?.newValue) toast(changes.downloadError.newValue.message, true);
  });
  await refresh();
  if (snapshot.recorder.status !== 'idle') selectView('recorder');
  else request('SCAN').catch(() => {});
  setInterval(refresh, 2500);
} else {
  $('#site-subtitle').textContent = 'Load the extension to connect to your tabs';
  $('#record-button').disabled = true;
}
window.addEventListener('pagehide', stopPlayback);
export { request, toast, icon, element, button, selectView, refresh, loadLibrary, stopPlayback, snapshot, recordings, playbackId };
