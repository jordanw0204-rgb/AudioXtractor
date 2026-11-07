import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './playwright-loader.mjs';
import { startServer } from '../scripts/serve.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const studio = await startServer();
const { chromium } = await loadPlaywright();
const profile = await mkdtemp(join(tmpdir(), 'audioxtractor-silent-'));
const extension = join(root, 'dist/AudioXtractor');
const passed = [], errors = [];
let context;
const pass = name => { passed.push(name); console.log(`PASS ${name}`); };
async function poll(fn, condition, label) {
  const until = Date.now() + 10000;
  while (Date.now() < until) { const value = await fn(); if (condition(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${label}`);
}
try {
  const extensionArgs = process.env.AUDIOXTRACTOR_LOAD_VIA_CDP === '1' ? [] : [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`];
  context = await chromium.launchPersistentContext(profile, { ...(process.env.AUDIOXTRACTOR_BROWSER_EXE ? { executablePath: process.env.AUDIOXTRACTOR_BROWSER_EXE } : { channel: 'chromium' }), ignoreDefaultArgs: ['--disable-extensions'], headless: process.env.HEADED !== '1', viewport: null, args: [...extensionArgs, '--enable-unsafe-extension-debugging', '--mute-audio'] });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  if (process.env.AUDIOXTRACTOR_LOAD_VIA_CDP === '1') {
    const setup = await context.browser().newBrowserCDPSession();
    await setup.send('Extensions.loadUnpacked', { path: extension, enableInIncognito: false });
    await setup.detach();
  }
  await context.pages()[0].goto(`${studio.url}/fixture`);
  let [worker] = context.serviceWorkers(); if (!worker) worker = await context.waitForEvent('serviceworker');
  await poll(() => worker.evaluate(() => chrome.action.onClicked.hasListeners()), value => value, 'extension action initialized');
  const id = worker.url().split('/')[2], page = context.pages()[0];
  await page.goto(`${studio.url}/fixture`);
  const browserCdp = await context.browser().newBrowserCDPSession();
  const targets = (await browserCdp.send('Target.getTargets', { filter: [{ type: 'tab' }] })).targetInfos;
  const target = targets.find(target => target.url === `${studio.url}/fixture`);
  const opened = context.waitForEvent('page');
  await browserCdp.send('Extensions.triggerAction', { id, targetId: target.targetId });
  let panel = await opened; panel.setDefaultTimeout(10000);
  await panel.locator('#site-title').filter({ hasText: '127.0.0.1' }).waitFor();
  await poll(() => panel.locator('.source-card').count(), value => value >= 2, 'source list');
  assert.equal(await page.locator('#audio').evaluate(audio => audio.paused), true);
  pass('Persistent panel and live source discovery work without playing any audio');
  await panel.locator('#select-sources').check();
  assert.equal(await panel.locator('.source-card .row-select:checked').count(), 2);
  assert.equal(await panel.locator('#download-selected-sources').isEnabled(), true);
  pass('Source multi-select and batch controls work');
  const state = await worker.evaluate(async () => (await chrome.storage.session.get('panel')).panel);
  if (process.env.HEADED === '1') {
    await poll(() => panel.locator('#companion-state').innerText(), value => value.includes('connected'), 'companion ready');
    await panel.locator('#pin-button').click();
    const pinInfo = await poll(() => panel.evaluate(async () => (await import(chrome.runtime.getURL('lib/native.js'))).native('PIN_STATE')), value => value.pinned, 'native topmost');
    assert(pinInfo.handle !== '0');
    await panel.locator('#pin-button').click();
    pass('Pin uses the real caller HWND and toggles Windows topmost with a plain title');
  }
  await worker.evaluate(async id => chrome.windows.update(id, { width: 500, height: 980 }), state.windowId);
  await poll(() => worker.evaluate(async () => (await chrome.storage.local.get('panelSettings')).panelSettings), value => value?.height === 980 && value?.width === 500, 'saved bounds');
  await panel.close();
  const reopened = context.waitForEvent('page');
  await browserCdp.send('Extensions.triggerAction', { id, targetId: target.targetId });
  panel = await reopened; panel.setDefaultTimeout(10000);
  await panel.locator('#site-title').filter({ hasText: '127.0.0.1' }).waitFor();
  const saved = await worker.evaluate(async () => (await chrome.storage.local.get('panelSettings')).panelSettings);
  assert.equal(saved.width, 500); assert.equal(saved.height, 980);
  pass('Resizing and reopening preserve window dimensions');
  await panel.locator('#tab-recorder').click();
  const ready = await poll(() => panel.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' })), value => value.recorder?.status === 'idle' && value.recorder.connected, 'Recorder prepares current tab');
  assert.equal(await panel.locator('.recording-row').count(), 0);
  const liveTabs = await worker.evaluate(() => chrome.tabCapture.getCapturedTabs());
  assert(liveTabs.some(tab => tab.tabId === ready.tab.id && tab.status === 'active'));
  assert.notEqual(await worker.evaluate(id => chrome.action.getBadgeText({ tabId: id }), ready.tab.id), 'REC');
  pass('Opening Recorder prepares only the current tab without a picker or saving a recording');
  assert.equal(await panel.locator('#record-button-label').innerText(), 'Start recording');
  const fixtureIds = await panel.evaluate(async () => {
    const store = await import(chrome.runtime.getURL('lib/recordings.js'));
    const ids = [];
    for (const title of ['Midnight frequencies — take 1', 'Second light — take 1']) {
      const file = await store.createRecording(title);
      await file.writer.write(new Float32Array(9600 * 2));
      const record = await store.finishRecording(file, { sampleRate: 48000, channels: 2, frames: 9600, origin: 'localhost' }); ids.push(record.id);
    }
    await (await import(chrome.runtime.getURL('popup.js'))).loadLibrary();
    // UI-only preview testing: no media is played or sent to an audio device.
    HTMLMediaElement.prototype.play = async function () {};
    return ids;
  });
  await poll(() => panel.locator('.recording-row').count(), value => value === 2, 'fixture library');
  const row = panel.locator(`.recording-row[data-id="${fixtureIds[0]}"]`);
  await row.locator('.row-select').check();
  const rowHandle = await row.elementHandle();
  const playHandle = await row.locator('.play-button').elementHandle();
  await row.locator('.play-button').click();
  await poll(() => row.locator('.play-button').getAttribute('aria-label'), value => value === 'Stop preview', 'preview state');
  assert(await rowHandle.evaluate(node => node === document.querySelector(`[data-id="${node.dataset.id}"]`)));
  assert(await playHandle.evaluate(node => node === document.activeElement));
  assert(await row.locator('.row-select').isChecked());
  await row.locator('.play-button').click();
  assert(await rowHandle.evaluate(node => node === document.querySelector(`[data-id="${node.dataset.id}"]`)));
  pass('Preview toggles in place; recording rows, button focus and selection remain stable');
  await poll(() => panel.locator('.recording-row.drag-ready').count(), value => value === 2, 'native drag files');
  assert.equal(await row.evaluate(node => node.draggable), false);
  const dragInfo = await panel.evaluate(async ids => (await import(chrome.runtime.getURL('lib/native.js'))).native('DRAG_INFO', { ids }), fixtureIds);
  assert.equal(dragInfo.files.length, 2);
  pass('Window-local companion resolves both real drag files without cancelling an HTML drag');
  if (process.env.AUDIOXTRACTOR_DRAG_PROBE === '1') {
    await panel.locator('#select-recordings').check();
    await panel.evaluate(async ids => {
      document.title = 'AudioXtractor — drag verification';
      window.verifiedDrops = [];
      const store = await import(chrome.runtime.getURL('lib/recordings.js'));
      const hash = async file => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      window.expectedDropHashes = await Promise.all(ids.map(async id => hash((await store.recordingFile(id)).file)));
      const zone = document.createElement('div'); zone.id = 'native-drop-probe'; zone.textContent = 'DROP THE SELECTED FILES HERE';
      Object.assign(zone.style, { position: 'fixed', right: '24px', bottom: '65px', width: '210px', height: '135px', display: 'grid', placeItems: 'center', border: '2px dashed #86b69a', borderRadius: '12px', background: '#21372c', color: '#cce7d7', zIndex: '9', font: '10px Segoe UI', textAlign: 'center' });
      zone.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
      zone.addEventListener('drop', async event => {
        event.preventDefault();
        window.verifiedDrops = await Promise.all([...event.dataTransfer.files].map(async file => ({ name: file.name, bytes: file.size, hash: await hash(file) })));
        zone.textContent = `${window.verifiedDrops.length} FILES RECEIVED`; zone.style.background = '#345c43';
      });
      document.body.append(zone);
    }, fixtureIds);
    console.log('PHYSICAL DRAG READY: AudioXtractor — drag verification; two silent WAVs are selected.');
    const until = Date.now() + 180000;
    let drops;
    while (Date.now() < until) {
      drops = await panel.evaluate(() => window.verifiedDrops);
      if (drops.length === 2) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(drops?.length, 2, 'Windows drag did not reach the native-to-browser drop target');
    const expected = await panel.evaluate(() => window.expectedDropHashes);
    assert.deepEqual(drops.map(file => file.hash).sort(), expected.sort());
    await writeFile(join(root, 'test-results/physical-drag-report.json'), JSON.stringify({ dropped: drops, expectedHashes: expected, browser: context.browser().version(), silent: true }, null, 2));
    pass('Physical Windows drag delivers both real WAV files with byte-identical SHA-256 hashes');
    await panel.evaluate(() => document.querySelector('#native-drop-probe').remove());
  }
  await panel.locator('#record-button').click();
  const captureState = await poll(() => panel.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' })), value => value.recorder?.status === 'recording' && value.recorder.frames > 0, 'silent tab capture');
  assert.equal(captureState.recorder.preparedConnection, true);
  assert.equal(captureState.recorder.captureMs, 0);
  assert.equal(captureState.recorder.tabId, ready.tab.id);
  assert.equal(captureState.recorder.connectionId, ready.recorder.connectionId);
  const sharedConnection = captureState.recorder.connectionId;
  const framesBeforeClose = captureState.recorder.frames;
  await panel.close();
  await poll(() => worker.evaluate(async () => (await chrome.storage.session.get('recorder')).recorder), value => value.status === 'recording' && value.frames > framesBeforeClose, 'recording survives panel close');
  const recordingReopened = context.waitForEvent('page');
  await browserCdp.send('Extensions.triggerAction', { id, targetId: target.targetId });
  panel = await recordingReopened; panel.setDefaultTimeout(10000);
  await panel.locator('#record-button-label').filter({ hasText: 'Stop & save recording' }).waitFor();
  await panel.locator('#record-button').click();
  await poll(() => panel.locator('.recording-row').count(), value => value === 3, 'silent capture saved');
  assert.equal(await page.locator('#audio').evaluate(audio => audio.paused), true);
  await panel.locator('#disconnect-recorder').waitFor();
  if (process.env.HEADED !== '1') await panel.setViewportSize({ width: 484, height: 900 });
  await panel.locator('#toast').evaluate(node => { node.hidden = true; });
  await panel.locator('.app').screenshot({ path: join(root, 'test-results/silent-recorder-2.3.png'), animations: 'disabled' });
  pass('First Record uses the already connected input; active recording survives panel closure');
  await panel.locator('#record-button').click();
  const secondTake = await poll(() => panel.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' })), value => value.recorder?.status === 'recording' && value.recorder.frames > 0, 'second silent take');
  assert.equal(secondTake.recorder.connectionId, sharedConnection);
  assert.equal(secondTake.recorder.reusedConnection, true);
  assert.equal(secondTake.recorder.captureMs, 0);
  await panel.locator('#pause-button').click();
  await poll(() => panel.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' })), value => value.recorder?.status === 'paused', 'pause');
  await panel.locator('#pause-button').click();
  await panel.locator('#record-button').click();
  await poll(() => panel.locator('.recording-row').count(), value => value === 4, 'second take saved');
  pass(`Repeated Record/Stop and pause/resume reuse the same input; second Start ${secondTake.recorder.totalStartMs.toFixed(2)} ms with no capture request`);
  await panel.close();
  await poll(() => worker.evaluate(async () => (await chrome.storage.session.get('recorder')).recorder), value => !value.connected, 'idle connection released on close');
  const idleReopened = context.waitForEvent('page');
  await browserCdp.send('Extensions.triggerAction', { id, targetId: target.targetId });
  panel = await idleReopened; panel.setDefaultTimeout(10000);
  await panel.locator('#tab-recorder').click();
  pass('Closing the idle panel releases tab capture automatically');
  await panel.locator('#record-button').click();
  const reconnected = await poll(() => panel.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' })), value => value.recorder?.status === 'recording' && value.recorder.frames > 0, 'new shared connection');
  assert.notEqual(reconnected.recorder.connectionId, sharedConnection);
  await panel.locator('#record-button').click();
  await poll(() => panel.locator('.recording-row').count(), value => value === 5, 'reconnected take saved');
  await panel.locator('#disconnect-recorder').click();
  await poll(() => panel.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' })), value => !value.recorder.connected, 'explicit disconnect');
  pass('Disconnect tab releases capture while preserving saved recordings');
  const otherPage = await context.newPage();
  await otherPage.goto(`${studio.url}/fixture?second=1`);
  await otherPage.evaluate(() => { document.title = 'Second silent website'; });
  const otherTarget = (await browserCdp.send('Target.getTargets', { filter: [{ type: 'tab' }] })).targetInfos.find(info => info.url === `${studio.url}/fixture?second=1`);
  await browserCdp.send('Extensions.triggerAction', { id, targetId: otherTarget.targetId });
  await poll(() => panel.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' })), value => value.tab?.title === 'Second silent website', 'new current website');
  // Pass an intentionally stale UI tab ID; the worker must use its current tab.
  const switched = await panel.evaluate(tabId => chrome.runtime.sendMessage({ target: 'background', type: 'START_RECORDING', tabId }), ready.tab.id);
  assert.equal(switched.ok, true); assert.equal(switched.state.title, 'Second silent website');
  assert.notEqual(switched.state.tabId, ready.tab.id);
  await poll(() => worker.evaluate(() => chrome.tabCapture.getCapturedTabs()), value => value.some(tab => tab.tabId === switched.state.tabId && tab.status === 'active'), 'new tab captured');
  await poll(() => panel.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' })), value => value.recorder?.frames > 0, 'new tab PCM');
  await panel.locator('#record-button').click();
  await poll(() => panel.locator('.recording-row').count(), value => value === 6, 'new website take saved');
  assert.equal(await otherPage.locator('#audio').evaluate(audio => audio.paused), true);
  pass('Current website wins over a stale UI tab ID; the correct tab is recorded without a picker');
  await panel.locator('#tab-sources').click();
  await poll(() => worker.evaluate(async () => (await chrome.storage.session.get('recorder')).recorder), value => !value.connected, 'leaving Recorder releases idle capture');
  await otherPage.close();
  pass('Leaving Recorder releases idle monitoring');
  await panel.locator('#tab-youtube').click();
  await panel.locator('#youtube-links').fill('https://example.com/not-youtube');
  await panel.locator('#youtube-convert').click();
  await panel.locator('#toast.error').waitFor();
  assert((await panel.locator('#toast').innerText()).includes('YouTube'));
  pass('YouTube input validation and all three views work');
  await panel.locator('#help-button').click();
  await panel.locator('#help-dialog').waitFor();
  await panel.keyboard.press('Escape');
  await panel.locator('#tab-sources').focus(); await panel.keyboard.press('ArrowRight');
  assert.equal(await panel.locator('#tab-recorder').getAttribute('aria-selected'), 'true');
  pass('Info dialog, Escape and keyboard navigation work');
  await panel.locator('#tab-sources').click();
  await panel.locator('#toast').evaluate(node => { node.hidden = true; });
  await mkdir(join(root, 'test-results'), { recursive: true });
  await panel.locator('.app').screenshot({ path: join(root, 'test-results/silent-sources.png'), animations: 'disabled' });
  assert.deepEqual(errors, []);
  pass('No uncaught browser errors; browser remains muted throughout');
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  await context?.close(); await new Promise(resolve => studio.server.close(resolve));
  await writeFile(join(root, 'test-results/ui-report.json'), JSON.stringify({ passed, errors, silent: true, at: new Date().toISOString() }, null, 2));
}
