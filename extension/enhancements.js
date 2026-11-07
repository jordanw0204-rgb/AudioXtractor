import * as ui from './popup.js';
import { formatBytes } from './lib/media.js';
import { youtubeLinks } from './lib/youtube.js';
import { native as windowNative } from './lib/native.js';

const $ = selector => document.querySelector(selector);
const selectedSources = new Set(), selectedRecordings = new Set(), selectedJobs = new Set(), readyRecordings = new Set();
let nativeOnline = false, preparing = false, jobList = [], lastJobs = '', polling = false;
let jobAudio, jobAudioId, jobAudioUrl, deletingJob;
const parameters = new URL(location.href).searchParams;
const isPanel = parameters.get('panel') === '1';
$('#setup-command').textContent = `npm run setup:companion -- --extension-id ${chrome.runtime?.id || 'YOUR_EXTENSION_ID'}`;

function updateCheckbox(selector, selected, ids) {
  const checkbox = $(selector);
  checkbox.checked = ids.length > 0 && ids.every(id => selected.has(id));
  checkbox.indeterminate = ids.some(id => selected.has(id)) && !checkbox.checked;
  checkbox.disabled = ids.length === 0;
}
function trimSelection(selected, ids) { const current = new Set(ids); for (const id of selected) if (!current.has(id)) selected.delete(id); }
function selection(row, id, title, selected, onChange) {
  let input = row.querySelector('.row-select');
  if (!input) {
    input = ui.element('input', 'row-select'); input.type = 'checkbox'; input.setAttribute('aria-label', `Select ${title}`);
    input.addEventListener('change', () => { if (input.checked) selected.add(id); else selected.delete(id); row.classList.toggle('selected', input.checked); onChange(); });
    row.prepend(input);
  }
  input.checked = selected.has(id); row.classList.toggle('selected', input.checked);
}
function nativeDrag(row, id, selected, ready = true) {
  if (row.draggable) row.draggable = false;
  row.classList.toggle('drag-ready', ready && nativeOnline);
  const hint = nativeOnline ? ready ? 'Drag this audio into a folder or audio app. Select several to drag together.' : 'Preparing audio for native drag-out…' : 'Native drag-out needs the Windows companion.';
  if (row.title !== hint) row.title = hint;
  row.ondragstart = event => event.preventDefault();
  row.onpointerdown = event => {
    if (event.button !== 0 || event.target.closest('button,input,a,textarea')) return;
    event.preventDefault();
    if (!nativeOnline) { ui.toast('Native drag-out needs the Windows companion. Open Info for setup.', true); return; }
    const ids = selected.has(id) ? [...selected] : [id];
    if (row.closest('#recording-list') && ids.some(value => !readyRecordings.has(value))) { ui.toast('Audio is preparing for drag-out. Try again in a moment.'); prepareRecordings(); return; }
    windowNative('ARM_DRAG', { ids }).catch(error => ui.toast(error.message, true));
  };
}

function sourceSelection() {
  const downloadable = ui.snapshot.sources.filter(source => source.downloadable);
  trimSelection(selectedSources, downloadable.map(source => source.id));
  for (const row of $('#source-list').children) {
    const source = downloadable.find(item => item.id === row.dataset.id);
    if (source) selection(row, source.id, source.label, selectedSources, sourceSelection);
  }
  updateCheckbox('#select-sources', selectedSources, downloadable.map(source => source.id));
  $('#download-selected-sources').disabled = selectedSources.size === 0;
  $('#download-all-sources').disabled = downloadable.length === 0;
  $('#source-selection-label').textContent = selectedSources.size ? `${selectedSources.size} SELECTED` : 'DETECTED SOURCES';
  $('#source-list').hidden = !ui.snapshot.sources.length;
}
async function exportSources(all) {
  const sources = ui.snapshot.sources.filter(source => source.downloadable && (all || selectedSources.has(source.id)));
  if (!sources.length) return;
  let done = 0;
  for (const source of sources) {
    try { await ui.request(source.nativePage ? 'DOWNLOAD_ORIGINAL' : 'DOWNLOAD_SOURCE', { tabId: ui.snapshot.tab.id, id: source.id }); done++; }
    catch (error) { ui.toast(`${done} started. ${error.message}`, true); return; }
  }
  ui.toast(`${done} original ${done === 1 ? 'source' : 'sources'} downloading.`);
}

function recordingSelection() {
  trimSelection(selectedRecordings, ui.recordings.map(record => record.id));
  for (const row of $('#recording-list').children) {
    const record = ui.recordings.find(item => item.id === row.dataset.id);
    if (!record) continue;
    selection(row, record.id, record.title, selectedRecordings, recordingSelection);
    nativeDrag(row, record.id, selectedRecordings, readyRecordings.has(record.id));
  }
  updateCheckbox('#select-recordings', selectedRecordings, ui.recordings.map(record => record.id));
  $('#download-selected-recordings').disabled = !selectedRecordings.size;
  $('#download-all-recordings').disabled = !ui.recordings.length;
  $('#recording-list').hidden = !ui.recordings.length;
  $('#recording-drag-note').textContent = preparing ? 'Preparing local audio for drag-out…' : nativeOnline ? 'Drag a row. Select several to drag them together.' : 'Download freely. Native drag-out needs companion setup.';
}
async function prepareRecordings() {
  if (!nativeOnline || preparing) return;
  const ids = ui.recordings.filter(record => !readyRecordings.has(record.id)).map(record => record.id);
  if (!ids.length) { recordingSelection(); return; }
  preparing = true; recordingSelection();
  try { const result = await ui.request('PREPARE_FILES', { ids }); for (const id of result.ready) readyRecordings.add(id); }
  catch (error) { $('#recording-drag-note').textContent = error.message; }
  finally { preparing = false; recordingSelection(); }
}
async function exportRecordings(all) {
  const records = ui.recordings.filter(record => all || selectedRecordings.has(record.id));
  let done = 0;
  for (const record of records) {
    try { await ui.request('DOWNLOAD_RECORDING', { id: record.id }); done++; }
    catch (error) { ui.toast(`${done} started. ${error.message}`, true); return; }
  }
  if (done) ui.toast(`${done} uncompressed ${done === 1 ? 'WAV' : 'WAVs'} downloading.`);
}

function selectAll(selector, selected, ids, render) {
  $(selector).addEventListener('change', event => { selected.clear(); if (event.target.checked) for (const id of ids()) selected.add(id); render(); });
}
selectAll('#select-sources', selectedSources, () => ui.snapshot.sources.filter(source => source.downloadable).map(source => source.id), sourceSelection);
selectAll('#select-recordings', selectedRecordings, () => ui.recordings.map(record => record.id), recordingSelection);
$('#download-selected-sources').addEventListener('click', () => exportSources(false));
$('#download-all-sources').addEventListener('click', () => exportSources(true));
$('#download-selected-recordings').addEventListener('click', () => exportRecordings(false));
$('#download-all-recordings').addEventListener('click', () => exportRecordings(true));
window.addEventListener('audioxtractor:sources', sourceSelection);
window.addEventListener('audioxtractor:library', () => { recordingSelection(); prepareRecordings(); });

$('#resolve-button').addEventListener('click', async event => {
  const control = event.currentTarget; control.disabled = true; $('#resolve-note').textContent = 'Resolving player audio…';
  try { const result = await ui.request('RESOLVE_SOURCES'); $('#resolve-note').textContent = `${result.count} original audio streams found`; await ui.refresh(); }
  catch (error) { $('#resolve-note').textContent = 'Direct page sources are still available'; ui.toast(error.message, true); }
  finally { control.disabled = false; }
});

async function companion() {
  const result = await ui.request('NATIVE_STATUS').catch(error => ({ connected: false, error: error.message }));
  nativeOnline = result.connected;
  if (nativeOnline) {
    try { await windowNative('STATUS'); }
    catch (error) { $('#companion-help-status').textContent = error.message; }
  }
  $('#companion-state').textContent = nativeOnline ? 'Local companion connected' : 'Companion setup needed';
  $('#companion-help-status').textContent = nativeOnline ? `Companion ${result.version} connected. ${result.ytDlp && result.ffmpeg ? 'Extraction and conversion tools are ready.' : 'Run setup to configure yt-dlp and FFmpeg.'}` : result.error;
  recordingSelection(); prepareRecordings();
  if (nativeOnline) loadJobs();
  return result;
}
function pinState() {
  const pinned = Boolean(ui.snapshot.settings?.pinned);
  $('#pin-button').setAttribute('aria-pressed', String(pinned));
  $('#pin-button').title = pinned ? 'Pinned above other apps. Click to unpin.' : 'Keep above other apps';
}
window.addEventListener('audioxtractor:state', pinState);
$('#pin-button').addEventListener('click', async event => {
  const control = event.currentTarget; control.disabled = true;
  try {
    if (!isPanel) { await ui.request('OPEN_PANEL'); ui.toast('Use the pin in the separate AudioXtractor window.'); return; }
    const pinned = control.getAttribute('aria-pressed') !== 'true';
    const result = await windowNative('PIN', { pinned });
    await ui.request('SAVE_PIN_PREFERENCE', { pinned: result.pinned });
    ui.snapshot.settings = { ...ui.snapshot.settings, pinned: result.pinned }; pinState();
    ui.toast(result.pinned ? 'Pinned above other apps.' : 'Window unpinned.');
  } catch (error) { ui.toast(error.message, true); }
  finally { control.disabled = false; }
});

function stopJobAudio() {
  jobAudio?.pause(); jobAudio = null; jobAudioId = null;
  if (jobAudioUrl) ui.request('RELEASE_URL', { url: jobAudioUrl }).catch(() => {});
  jobAudioUrl = null; updateJobControls();
}
async function playJob(job) {
  const same = jobAudioId === job.id; stopJobAudio(); ui.stopPlayback();
  if (same) return;
  try {
    const result = await ui.request('JOB_URL', { id: job.id });
    jobAudioUrl = result.url; jobAudioId = job.id; jobAudio = new Audio(result.url);
    jobAudio.addEventListener('ended', stopJobAudio, { once: true });
    jobAudio.addEventListener('error', () => { stopJobAudio(); ui.toast('Could not preview this audio.', true); }, { once: true });
    await jobAudio.play(); updateJobControls();
  } catch (error) { stopJobAudio(); ui.toast(error.message, true); }
}
function updateJobControls() {
  for (const row of $('#jobs-list').children) {
    const job = jobList.find(value => value.id === row.dataset.id);
    if (!job || job.status !== 'completed') continue;
    selection(row, job.id, job.title, selectedJobs, renderJobs);
    const control = row.querySelector('.play-button');
    const label = jobAudioId === job.id ? 'Stop converted preview' : `Play converted ${job.title}`;
    if (control && control.getAttribute('aria-label') !== label) {
      control.setAttribute('aria-label', label); control.title = label;
      control.replaceChildren(ui.icon(jobAudioId === job.id ? 'pause' : 'play'));
    }
  }
}
function renderJobs() {
  const completed = jobList.filter(job => job.status === 'completed');
  trimSelection(selectedJobs, completed.map(job => job.id));
  updateCheckbox('#select-jobs', selectedJobs, completed.map(job => job.id));
  $('#download-selected-jobs').disabled = !selectedJobs.size;
  $('#download-all-jobs').disabled = !completed.length;
  $('#jobs-selection-label').textContent = selectedJobs.size ? `${selectedJobs.size} SELECTED` : `YOUR AUDIO${jobList.length ? ` · ${jobList.length}` : ''}`;
  const active = jobList.filter(job => ['queued', 'working'].includes(job.status)).length;
  $('#job-count').hidden = !active; $('#job-count').textContent = active;
  $('#jobs-empty').hidden = jobList.length > 0;
  $('#jobs-list').hidden = jobList.length === 0;
  const key = JSON.stringify(jobList);
  if (key === lastJobs) { updateJobControls(); return; }
  lastJobs = key;
  const container = $('#jobs-list');
  const existing = new Map([...container.children].map(row => [row.dataset.id, row]));
  const rows = [];
  for (const job of jobList) {
    let row = existing.get(job.id);
    if (row?.dataset.status === job.status) {
      const title = row.querySelector('.source-title');
      if (title.textContent !== job.title) { title.textContent = job.title; title.title = job.title; }
      const meta = row.querySelector('.source-meta');
      const status = job.status === 'completed' ? `${job.mode === 'original' ? 'ORIGINAL' : 'MP3 · 320 kbps'} · ${formatBytes(job.bytes)}` : job.status === 'failed' ? job.error : job.stage || 'Queued';
      if (meta.textContent !== status) meta.textContent = status;
      const progress = row.querySelector('.job-progress span');
      if (progress) progress.style.width = `${Math.max(3, job.progress)}%`;
      rows.push(row); continue;
    }
    row ||= ui.element('article'); row.className = `job-row ${job.status}`; row.dataset.id = job.id; row.dataset.status = job.status;
    row.replaceChildren();
    const finished = job.status === 'completed';
    if (finished) selection(row, job.id, job.title, selectedJobs, renderJobs);
    const marker = finished ? ui.button('play-button', jobAudioId === job.id ? 'Stop converted preview' : `Play converted ${job.title}`, jobAudioId === job.id ? 'pause' : 'play', () => playJob(job)) : ui.element('div', 'job-marker');
    if (!finished) marker.append(ui.icon(job.status === 'failed' ? 'info' : 'youtube'));
    const info = ui.element('div', 'source-info');
    const title = ui.element('div', 'source-title', job.title); title.title = job.title;
    const status = finished ? `${job.mode === 'original' ? 'ORIGINAL' : 'MP3 · 320 kbps'} · ${formatBytes(job.bytes)}` : job.status === 'failed' ? job.error : job.stage || 'Queued';
    info.append(title, ui.element('div', `source-meta${job.status === 'failed' ? ' job-error' : ''}`, status));
    if (job.status === 'working') { const progress = ui.element('div', 'job-progress'); const fill = ui.element('span'); fill.style.width = `${Math.max(3, job.progress)}%`; progress.append(fill); info.append(progress); }
    const actions = ui.element('div', 'recording-actions');
    if (finished) {
      actions.append(ui.button('icon-button', `Download converted ${job.title}`, 'download', () => exportJobs([job.id])), ui.button('icon-button', `Delete converted ${job.title}`, 'trash', () => { deletingJob = job.id; $('#delete-dialog').showModal(); }));
      nativeDrag(row, job.id, selectedJobs);
    } else if (['queued', 'working'].includes(job.status)) actions.append(ui.button('icon-button', `Cancel ${job.title}`, 'close', async () => { try { await ui.request('CANCEL_JOB', { id: job.id }); await loadJobs(); } catch (error) { ui.toast(error.message, true); } }));
    else {
      actions.append(ui.button('icon-button', `Retry ${job.title}`, 'refresh', async () => { try { await ui.request('QUEUE_YOUTUBE', { links: job.url }); await loadJobs(); } catch (error) { ui.toast(error.message, true); } }), ui.button('icon-button', `Delete converted ${job.title}`, 'trash', () => { deletingJob = job.id; $('#delete-dialog').showModal(); }));
    }
    row.append(marker, info, actions); rows.push(row);
  }
  const ids = new Set(rows.map(row => row.dataset.id));
  for (const row of [...container.children]) if (!ids.has(row.dataset.id)) row.remove();
  rows.forEach((row, index) => { if (container.children[index] !== row) container.insertBefore(row, container.children[index] || null); });
  updateJobControls();
}
async function loadJobs() {
  if (!nativeOnline || polling) return;
  polling = true;
  try { jobList = (await ui.request('LIST_JOBS')).jobs; renderJobs(); }
  catch { nativeOnline = false; $('#companion-state').textContent = 'Companion disconnected'; }
  finally { polling = false; }
}
async function exportJobs(ids) {
  if (!ids.length) return;
  try { const result = await ui.request('EXPORT_JOBS', { ids }); ui.toast(`${result.count} ${result.count === 1 ? 'audio file' : 'audio files'} saved to Downloads / AudioXtractor.`); }
  catch (error) { ui.toast(error.message, true); }
}
selectAll('#select-jobs', selectedJobs, () => jobList.filter(job => job.status === 'completed').map(job => job.id), renderJobs);
$('#download-selected-jobs').addEventListener('click', () => exportJobs([...selectedJobs]));
$('#download-all-jobs').addEventListener('click', () => exportJobs(jobList.filter(job => job.status === 'completed').map(job => job.id)));
$('#confirm-delete').addEventListener('click', async () => {
  if (!deletingJob) return;
  const id = deletingJob; deletingJob = null; $('#delete-dialog').close();
  if (jobAudioId === id) stopJobAudio();
  try { await ui.request('DELETE_JOB', { id }); await loadJobs(); ui.toast('Local conversion deleted.'); }
  catch (error) { ui.toast(error.message, true); }
});
$('#delete-dialog').addEventListener('close', () => { deletingJob = null; });

$('#youtube-current').addEventListener('click', () => {
  try { const links = youtubeLinks(ui.snapshot.tab?.url || ''); $('#youtube-links').value = [...new Set([$('#youtube-links').value.trim(), ...links].filter(Boolean))].join('\n'); }
  catch { ui.toast('Open a YouTube video in your browser first, or paste a link here.', true); }
});
$('#youtube-convert').addEventListener('click', async event => {
  const control = event.currentTarget; control.disabled = true;
  try { const result = await ui.request('QUEUE_YOUTUBE', { links: $('#youtube-links').value }); $('#youtube-links').value = ''; nativeOnline = true; await loadJobs(); ui.toast(`${result.count} ${result.count === 1 ? 'video' : 'videos'} added to the conversion queue.`); }
  catch (error) { ui.toast(error.message, true); }
  finally { control.disabled = false; }
});
window.addEventListener('audioxtractor:view', event => { if (event.detail === 'youtube') { stopJobAudio(); loadJobs(); } });
$('#record-button').addEventListener('click', stopJobAudio, { capture: true });
$('#recording-list').addEventListener('click', event => { if (event.target.closest('.play-button')) stopJobAudio(); }, { capture: true });
window.addEventListener('pagehide', stopJobAudio);

sourceSelection(); recordingSelection(); pinState();
if (globalThis.chrome?.runtime?.id) {
  const status = await companion();
  if (isPanel && ui.snapshot.settings?.pinned && status.connected) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await windowNative('PIN', { pinned: true }); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 300)); }
    }
  }
  setInterval(loadJobs, 1200);
}
$('#help-button').addEventListener('click', companion);
window.addEventListener('audioxtractor:native-drag-complete', event => {
  if (event.detail.status === 'failed') ui.toast(event.detail.error || 'Windows could not complete the file drag.', true);
});
