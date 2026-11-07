import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadPlaywright } from './playwright-loader.mjs';
import { startServer } from '../scripts/serve.mjs';

if (process.env.AUDIOXTRACTOR_AUDIBLE_TESTS !== '1') {
  console.log('Audio capture tests play a reference tone. They require explicit opt-in: AUDIOXTRACTOR_AUDIBLE_TESTS=1. Use npm run test:browser for silent checks.');
  process.exit(0);
}

const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const artifacts = join(root, 'test-results');
await mkdir(artifacts, { recursive: true });
const pw = await loadPlaywright();
const studio = await startServer();
const profile = await mkdtemp(join(tmpdir(), 'audioxtractor-test-'));
const pathToExtension = join(root, 'dist/AudioXtractor');
const errors = [], passed = [];
let context;
let popup;
function pass(label) { passed.push(label); console.log(`PASS ${label}`); }
async function poll(fn, predicate, label, timeout = 10000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await fn(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${label}`);
}
try {
  context = await pw.chromium.launchPersistentContext(profile, { channel: 'chromium', headless: process.env.HEADED !== '1', ignoreDefaultArgs: ['--mute-audio'], viewport: null, acceptDownloads: true, args: [`--disable-extensions-except=${pathToExtension}`, `--load-extension=${pathToExtension}`, '--enable-unsafe-extension-debugging', '--autoplay-policy=no-user-gesture-required', '--auto-select-desktop-capture-source=Midnight frequencies', '--auto-accept-tab-capture'] });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  await poll(() => worker.evaluate(() => chrome.action.onClicked.hasListeners()), value => value, 'extension action initialized');
  const id = worker.url().split('/')[2];
  console.log(`Chromium ${context.browser().version()} · extension ${id}`);
  const page = context.pages()[0];
  await page.goto(`${studio.url}/fixture`);
  await page.locator('#play').click();
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, `${studio.url}/fixture`);
  const getSources = () => worker.evaluate(async key => (await chrome.storage.session.get(key))[key] || [], `sources-${tabId}`);
  let sources = await poll(getSources, data => data.some(item => item.playing && item.label === 'Midnight frequencies') && data.length >= 2, 'live source detection');
  assert(sources.find(item => item.label === 'Midnight frequencies').url.endsWith('?token=keep-this-signature'));
  assert.equal(sources.find(item => item.label === 'Midnight frequencies').size, studio.wav.length);
  pass('Live media detection, playing status, signed URL and full range-response size');

  const cdp = await context.newCDPSession(page);
  const browserCdp = await context.browser().newBrowserCDPSession();
  const { targetInfos } = await browserCdp.send('Target.getTargets', { filter: [{ type: 'tab' }] });
  const targetInfo = targetInfos.find(target => target.url === `${studio.url}/fixture`);
  if (!targetInfo) throw new Error(`No fixture tab target: ${JSON.stringify(targetInfos)}`);
  async function openPopup() {
    await page.bringToFront();
    const pending = context.waitForEvent('page', { timeout: 10000 });
    pending.catch(() => {});
    await browserCdp.send('Extensions.triggerAction', { id, targetId: targetInfo.targetId });
    const opened = await pending;
    popup = opened;
    opened.setDefaultTimeout(10000);
    await opened.waitForLoadState('domcontentloaded');
    await opened.locator('#site-title').filter({ hasText: '127.0.0.1' }).waitFor();
    return opened;
  }
  popup = await openPopup();
  await popup.locator('.source-card').first().waitFor();
  await page.waitForTimeout(300);
  await popup.locator('.app').screenshot({ path: join(artifacts, 'sources.png') });
  const dimensions = await popup.evaluate(() => ({ width: document.body.scrollWidth, height: document.body.scrollHeight, viewport: innerHeight }));
  console.log('Popup dimensions', dimensions);
  assert(dimensions.width >= 390); assert(dimensions.height <= dimensions.viewport);
  pass('Actual persistent panel opens from the toolbar without overflow');
  await poll(() => popup.locator('#companion-state').innerText(), text => text.includes('connected'), 'native companion connection');
  pass('Chrome native messaging connects to the real Windows companion');
  await poll(() => popup.locator('#site-favicon').evaluate(image => !image.hidden && image.naturalWidth > 0), value => value, 'website favicon');
  const iconUrl = await worker.evaluate(async tabId => (await chrome.tabs.get(tabId)).favIconUrl, tabId);
  assert(iconUrl.endsWith('/icons/icon32.png'));
  assert((await popup.locator('#site-favicon').getAttribute('src')).includes('_favicon/'));
  pass('Website icon comes from the browser favicon service and the actual site favicon');
  const panel = await worker.evaluate(async () => (await chrome.storage.session.get('panel')).panel);
  await worker.evaluate(async windowId => chrome.windows.update(windowId, { height: 1000, width: 500 }), panel.windowId);
  await poll(() => worker.evaluate(async () => (await chrome.storage.local.get('panelSettings')).panelSettings), value => value?.height === 1000 && value.width === 500, 'window size saved');
  await popup.locator('.app').screenshot({ path: join(artifacts, 'expanded.png') });
  pass('Panel can grow taller and saves native window dimensions');
  if (process.env.HEADED === '1') {
    await popup.locator('#pin-button').click();
    await poll(() => popup.locator('#pin-button').getAttribute('aria-pressed'), value => value === 'true', 'pin activated');
    const nativePin = await popup.evaluate(async () => (await import(chrome.runtime.getURL('lib/native.js'))).native('PIN_STATE'));
    assert(nativePin.pinned && nativePin.found);
    pass('Pin button sets the actual Windows topmost style');
  }

  const sourceButton = popup.getByRole('button', { name: 'Download Midnight frequencies', exact: true });
  await sourceButton.click();
  // Downloads initiated by the extension use Chrome's download manager.
  const job = await poll(() => worker.evaluate(async () => (await chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 }))[0]), data => data?.state === 'complete', 'source download completion');
  assert.deepEqual(await readFile(job.filename), studio.wav);
  pass('One-click source download is byte-identical to the original WAV');
  const sourceDownloads = await worker.evaluate(async () => (await chrome.downloads.search({})).length);
  await popup.locator('#select-sources').check();
  assert.equal(await popup.locator('.source-card .row-select:checked').count(), 2);
  await popup.locator('#download-all-sources').click();
  await poll(() => worker.evaluate(async () => (await chrome.downloads.search({})).filter(job => job.state === 'complete').length), count => count >= sourceDownloads + 2, 'all original downloads');
  pass('Sources supports selection and Download All for original files');

  await popup.locator('#tab-recorder').click();
  await popup.locator('#record-button').click();
  await page.waitForTimeout(300);
  if (await popup.locator('#toast.error').isVisible()) throw new Error(await popup.locator('#toast').innerText());
  await poll(() => worker.evaluate(async () => (await chrome.storage.session.get('recorder')).recorder), state => state?.status === 'recording' && state.frames > 0, 'actual tab capture', 15000);
  await poll(() => popup.locator('#record-button').isEnabled(), enabled => enabled, 'record controls ready');
  await popup.locator('#toast').evaluate(node => { node.hidden = true; });
  await popup.locator('.app').screenshot({ path: join(artifacts, 'recording.png') });
  assert.equal(await popup.locator('#pause-button').isVisible(), true);
  pass('Tab capture starts and produces PCM with a real live waveform');

  await popup.locator('#pause-button').click();
  let state = await poll(() => worker.evaluate(async () => (await chrome.storage.session.get('recorder')).recorder), state => state?.status === 'paused', 'pause');
  const pausedFrames = state.frames;
  await page.waitForTimeout(700);
  state = await worker.evaluate(async () => (await chrome.storage.session.get('recorder')).recorder);
  assert.equal(state.frames, pausedFrames);
  await popup.locator('.app').screenshot({ path: join(artifacts, 'paused.png') });
  await popup.locator('#pause-button').click();
  await poll(() => worker.evaluate(async () => (await chrome.storage.session.get('recorder')).recorder), state => state?.status === 'recording' && state.frames > pausedFrames, 'resume');
  pass('Pause excludes samples; resume continues the same recording');

  await popup.close();
  const beforeClose = state.frames;
  await page.waitForTimeout(900);
  state = await worker.evaluate(async () => (await chrome.storage.session.get('recorder')).recorder);
  assert(state.status === 'recording' && state.frames > beforeClose);
  popup = await openPopup();
  assert.equal(await popup.locator('#panel-recorder').isVisible(), true);
  const restoredPanel = await worker.evaluate(async () => (await chrome.storage.session.get('panel')).panel);
  const restoredWindow = await worker.evaluate(async id => chrome.windows.get(id), restoredPanel.windowId);
  assert.equal(restoredWindow.height, 1000); assert.equal(restoredWindow.width, 500);
  if (process.env.HEADED === '1') await poll(() => popup.evaluate(async () => (await import(chrome.runtime.getURL('lib/native.js'))).native('PIN_STATE')), value => value.pinned === true, 'pin restored');
  pass('Window size and always-on-top preference restore on reopen');
  await popup.locator('#record-button').click();
  await poll(() => popup.locator('.recording-row').count(), count => count === 1, 'recording save');
  await popup.locator('.app').screenshot({ path: join(artifacts, 'library.png') });
  pass('Recording survives popup closure and saves to the local library');

  const library = await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'LIST_RECORDINGS' }));
  assert.equal(library.ok, true);
  const record = library.recordings[0];
  await poll(() => popup.locator('.recording-row').first().getAttribute('class'), value => value.includes('drag-ready'), 'recording prepared for native drag');
  const drag = await popup.evaluate(id => chrome.runtime.sendMessage({ target: 'background', type: 'DRAG_INFO', ids: [id] }), record.id);
  assert(drag.ok && drag.formats.includes('FileDrop') && drag.files.length === 1);
  pass('Recorded WAV is automatically prepared as a real Windows file-drop payload');
  if (process.env.AUDIOXTRACTOR_DRAG_SESSION === '1') {
    const activePanel = await worker.evaluate(async () => (await chrome.storage.session.get('panel')).panel);
    const dropOutput = join(artifacts, `drop-${activePanel.token}.json`);
    const receiver = spawn(join(root, 'dist/AudioXtractor-Companion', version, 'AudioXtractor.Native.exe'), ['--drop-target', activePanel.token, dropOutput], { stdio: 'ignore', windowsHide: true });
    console.log(`NATIVE DRAG READY · window token ${activePanel.token} · source row ${record.title} · drop file ${dropOutput}`);
    try {
      const result = await poll(async () => { try { return JSON.parse(await readFile(dropOutput, 'utf8')); } catch { return null; } }, value => value?.files?.length > 0, 'physical Windows file drop', 240000);
      assert.equal(result.format, 'FileDrop'); assert.equal(result.files.length, 1);
      assert.deepEqual(await readFile(result.files[0]), await readFile(drag.files[0]));
      pass('Physical drag from the extension is accepted by a native Windows drop target');
    } finally { receiver.kill(); }
  }
  const exported = await popup.evaluate(async id => {
    const result = await chrome.runtime.sendMessage({ target: 'background', type: 'RECORDING_URL', id });
    const bytes = await (await fetch(result.url)).arrayBuffer();
    await chrome.runtime.sendMessage({ target: 'background', type: 'RELEASE_URL', url: result.url });
    return Array.from(new Uint8Array(bytes));
  }, record.id);
  const wav = Buffer.from(exported);
  assert.equal(wav.readUInt16LE(20), 3); assert.equal(wav.readUInt16LE(34), 32);
  assert.equal(wav.readUInt32LE(24), record.sampleRate);
  assert.equal(wav.length, 56 + record.frames * record.channels * 4);
  let max = 0;
  for (let offset = 56; offset < wav.length; offset += 4) max = Math.max(max, Math.abs(wav.readFloatLE(offset)));
  assert(max > .01 && max < .3, `Unexpected capture peak ${max}`);
  await writeFile(join(artifacts, 'captured-reference.wav'), wav);
  pass(`Captured WAV is valid Float32 PCM: ${record.sampleRate} Hz, ${record.channels} channels, ${record.frames} frames, peak ${max.toFixed(4)}`);

  await popup.locator('.play-button').click();
  await poll(() => popup.locator('.play-button').getAttribute('aria-label'), label => label === 'Stop preview', 'local playback');
  await popup.locator('.play-button').click();
  await popup.getByRole('button', { name: `Download recording ${record.title}`, exact: true }).click();
  await page.waitForTimeout(300);
  if (await popup.locator('#toast.error').isVisible()) throw new Error(await popup.locator('#toast').innerText());
  const saved = await poll(() => worker.evaluate(async () => (await chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 }))[0]), data => data?.state === 'complete' && data.id !== job.id, 'recording export');
  assert.deepEqual(await readFile(saved.filename), wav);
  pass('Local playback and WAV export preserve the saved recording');

  await popup.locator('#record-button').click();
  await poll(() => worker.evaluate(async () => (await chrome.storage.session.get('recorder')).recorder), value => value?.status === 'recording' && value.frames > 16000, 'batch second recording');
  await popup.locator('#record-button').click();
  await poll(() => popup.locator('.recording-row').count(), count => count === 2, 'two recordings');
  await poll(() => popup.locator('.recording-row.drag-ready').count(), count => count === 2, 'both recordings cached');
  await popup.locator('#select-recordings').check();
  assert.equal(await popup.locator('.recording-row .row-select:checked').count(), 2);
  const ids = await popup.locator('.recording-row').evaluateAll(rows => rows.map(row => row.dataset.id));
  const multiDrag = await popup.evaluate(ids => chrome.runtime.sendMessage({ target: 'background', type: 'DRAG_INFO', ids }), ids);
  assert.equal(multiDrag.files.length, 2);
  const countBefore = await worker.evaluate(async () => (await chrome.downloads.search({})).length);
  await popup.locator('#download-selected-recordings').click();
  await poll(() => worker.evaluate(async () => (await chrome.downloads.search({})).filter(job => job.state === 'complete').length), count => count >= countBefore + 2, 'batch WAV downloads');
  pass('Multiple recordings select together, expose multiple native files and download in one action');
  const second = ids.find(value => value !== record.id);
  await popup.locator(`.recording-row[data-id="${second}"]`).getByRole('button', { name: `Delete recording ${record.title}`, exact: true }).click();
  await popup.locator('#confirm-delete').click();
  await poll(() => popup.locator('.recording-row').count(), count => count === 1, 'batch cleanup');

  await popup.close();
  await page.evaluate(async () => { await addBlob(); await addPlaylist(); await addSegment(); addShadow(); addFrame(); });
  sources = await poll(getSources, sources => sources.some(item => item.kind === 'blob') && sources.some(item => item.kind === 'playlist') && sources.some(item => item.kind === 'segment') && sources.some(item => item.label === 'Inside shadow DOM') && sources.some(item => item.label === 'Frame audio'), 'stream, shadow DOM and iframe discovery');
  for (const source of sources.filter(item => ['blob', 'playlist', 'segment'].includes(item.kind))) assert.equal(source.downloadable, false);
  pass('Blob streams, playlists, fragments, shadow DOM and iframe sources are detected and labeled');
  await page.evaluate(() => document.querySelector('#audio').pause());
  await poll(getSources, sources => sources.every(item => !item.playing), 'paused source state');
  pass('The live source list reflects paused playback');
  popup = await openPopup();
  await popup.locator('#tab-recorder').click();
  await popup.locator('.recording-row').first().waitFor();
  pass('Saved recording persists after popup reopening');
  await popup.getByRole('button', { name: `Delete recording ${record.title}`, exact: true }).click();
  await popup.locator('#cancel-delete').click();
  assert.equal(await popup.locator('.recording-row').count(), 1);
  await popup.getByRole('button', { name: `Delete recording ${record.title}`, exact: true }).click();
  await popup.locator('#confirm-delete').click();
  await poll(() => popup.locator('.recording-row').count(), count => count === 0, 'confirmed deletion');
  pass('Delete confirmation supports cancel and explicit deletion');
  await popup.locator('#help-button').click();
  assert.equal(await popup.locator('#help-dialog').isVisible(), true);
  await popup.keyboard.press('Escape');
  await popup.locator('#tab-sources').focus();
  await popup.keyboard.press('ArrowRight');
  assert.equal(await popup.locator('#tab-recorder').getAttribute('aria-selected'), 'true');
  pass('Help dialog, Escape and keyboard tab navigation work');

  await popup.locator('#tab-sources').click();
  await page.evaluate(() => {
    const link = document.createElement('a'); link.href = '/download-only.wav'; link.textContent = 'Download-only audio'; document.body.append(link);
    const metadata = document.createElement('script'); metadata.type = 'application/ld+json'; metadata.textContent = JSON.stringify({ '@type': 'AudioObject', name: 'Structured audio', contentUrl: location.origin + '/structured.wav' }); document.body.append(metadata);
  });
  await poll(getSources, sources => sources.some(source => source.label === 'Download-only audio') && sources.some(source => source.label === 'Structured audio'), 'audio links and metadata');
  pass('Audio links and structured page metadata are discovered before playback');
  await popup.locator('#resolve-button').click();
  await poll(getSources, sources => sources.some(source => source.resolved), 'full source resolution', 15000);
  pass('Resolve page audio returns complete original streams through the native extractor');

  if (process.env.AUDIOXTRACTOR_LIVE_YOUTUBE === '1') {
    await popup.locator('#tab-youtube').click();
    await popup.locator('#youtube-links').fill('https://youtu.be/jNQXAC9IVRw\nhttps://www.youtube.com/watch?v=jNQXAC9IVRw');
    await popup.locator('#youtube-convert').click();
    await poll(() => popup.locator('.job-row.completed').count(), count => count === 1, 'first live YouTube conversion', 120000);
    pass('YouTube tab converts pasted links with deduplication into a real playable MP3');
    const sourceWindowId = await worker.evaluate(async id => (await chrome.tabs.get(id)).windowId, tabId);
    const newPage = context.waitForEvent('page');
    await worker.evaluate(async windowId => chrome.tabs.create({ windowId, url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', active: true }), sourceWindowId);
    const youtubePage = await newPage;
    await poll(() => popup.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' })), state => state.tab?.url?.includes('jNQXAC9IVRw'), 'current YouTube tab');
    await poll(() => popup.locator('#site-title').innerText(), text => text.includes('youtube.com'), 'panel follows current website');
    await popup.locator('#youtube-current').click();
    assert((await popup.locator('#youtube-links').inputValue()).includes('jNQXAC9IVRw'));
    await popup.locator('#youtube-convert').click();
    await youtubePage.close();
    await poll(() => popup.locator('.job-row.completed').count(), count => count === 2, 'second live conversion', 120000);
    await popup.locator('#select-jobs').check();
    assert.equal(await popup.locator('.job-row .row-select:checked').count(), 2);
    const jobIds = await popup.locator('.job-row.completed').evaluateAll(rows => rows.map(row => row.dataset.id));
    const jobsDrag = await popup.evaluate(ids => chrome.runtime.sendMessage({ target: 'background', type: 'DRAG_INFO', ids }), jobIds);
    assert.equal(jobsDrag.files.length, 2); assert(jobsDrag.files.every(path => path.endsWith('.mp3')));
    await popup.locator('.job-row.completed .play-button').first().click();
    await poll(() => popup.locator('.job-row.completed .play-button').first().getAttribute('aria-label'), label => label === 'Stop converted preview', 'MP3 preview');
    await popup.locator('.job-row.completed .play-button').first().click();
    await popup.locator('#download-selected-jobs').click();
    await poll(() => popup.locator('#toast').innerText(), text => text.includes('2 audio files saved'), 'batch MP3 export');
    await popup.locator('#toast').evaluate(node => { node.hidden = true; });
    await popup.locator('.app').screenshot({ path: join(artifacts, 'youtube.png') });
    pass('Current-page conversion, MP3 preview, multi-select, native multi-file payload and batch download work');
  }

  // A navigation must discard old signed sources, fragments and frame state.
  await popup.close();
  await page.reload();
  await page.locator('#play').click();
  await poll(getSources, sources => sources.length === 2 && sources.some(source => source.playing), 'navigation clears previous sources');
  pass('Navigation clears stale sources and rediscovers current media');
  popup = await openPopup();
  await popup.locator('#tab-recorder').click();
  await popup.locator('#record-button').click();
  await poll(() => worker.evaluate(async () => (await chrome.storage.session.get('recorder')).recorder), state => state?.status === 'recording' && state.frames > 16000, 'second recording');
  await page.close();
  await poll(() => worker.evaluate(async () => (await chrome.storage.session.get('recorder')).recorder), state => state?.status === 'idle', 'tab close saves recording');
  const afterClose = await poll(() => popup.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'LIST_RECORDINGS' })), data => data.recordings?.length === 1, 'auto-saved recording');
  assert(afterClose.recordings[0].frames > 0);
  await poll(() => worker.evaluate(async key => (await chrome.storage.session.get(key))[key], `sources-${tabId}`), value => value == null, 'closed tab cleanup');
  pass('Closing the source tab saves captured audio and cleans up tab state');
  const persistedId = afterClose.recordings[0].id;
  await context.close();
  context = await pw.chromium.launchPersistentContext(profile, { channel: 'chromium', headless: process.env.HEADED !== '1', ignoreDefaultArgs: ['--mute-audio'], viewport: { width: 420, height: 600 }, args: [`--disable-extensions-except=${pathToExtension}`, `--load-extension=${pathToExtension}`] });
  popup = context.pages()[0];
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.locator('#tab-recorder').click();
  await popup.locator('.recording-row').first().waitFor();
  const afterRestart = await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'LIST_RECORDINGS' }));
  assert.equal(afterRestart.recordings[0].id, persistedId);
  assert.equal(await popup.locator('#record-button').isDisabled(), true);
  pass('Saved audio persists across a full browser restart; capture disables when no website is selected');
  assert.deepEqual(errors, []);
  pass('No uncaught page errors');
} catch (error) {
  if (popup && !popup.isClosed()) {
    await popup.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
    console.error('Popup text:', await popup.locator('body').innerText().catch(() => 'closed'));
  }
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(join(artifacts, 'browser-report.json'), JSON.stringify({ passed, errors, profile, at: new Date().toISOString() }, null, 2));
  await context?.close();
  await new Promise(resolve => studio.server.close(resolve));
  console.log(`${passed.length} browser checks passed. Artifacts: ${artifacts}`);
}
