import { native } from './native.js';

const defaults = { width: 460, height: 800, pinned: false };
let opening;

export async function settings() {
  return { ...defaults, ...(await chrome.storage.local.get('panelSettings')).panelSettings };
}

export async function targetTab() {
  const { sourceTabId } = await chrome.storage.session.get('sourceTabId');
  if (sourceTabId != null) {
    try { const tab = await chrome.tabs.get(sourceTabId); if (/^https?:/.test(tab.url || '')) return tab; } catch { /* Tab closed. */ }
  }
  const tabs = await chrome.tabs.query({ active: true, windowType: 'normal' });
  return tabs.find(tab => /^https?:/.test(tab.url || '')) || null;
}

async function rememberTab(tab) {
  if (tab?.id != null && /^https?:/.test(tab.url || '')) await chrome.storage.session.set({ sourceTabId: tab.id });
}

export async function openPanel(tab) {
  await rememberTab(tab);
  if (opening) return opening;
  opening = (async () => {
    const { panel } = await chrome.storage.session.get('panel');
    if (panel) {
      try { await chrome.windows.update(panel.windowId, { focused: true }); return panel; }
      catch { await chrome.storage.session.remove('panel'); }
    }
    const saved = await settings();
    const token = crypto.randomUUID();
    const options = { url: chrome.runtime.getURL(`popup.html?panel=1&token=${token}`), type: 'popup', width: Math.max(420, Math.min(1200, saved.width)), height: Math.max(600, Math.min(1600, saved.height)), focused: true };
    if (Number.isInteger(saved.left) && Number.isInteger(saved.top)) Object.assign(options, { left: saved.left, top: saved.top });
    let window;
    try { window = await chrome.windows.create(options); }
    catch { delete options.left; delete options.top; window = await chrome.windows.create(options); }
    const state = { windowId: window.id, token };
    await chrome.storage.session.set({ panel: state });
    return state;
  })().finally(() => { opening = undefined; });
  return opening;
}

export async function pinPanel(pinned) {
  const { panel } = await chrome.storage.session.get('panel');
  if (!panel) throw new Error('Open AudioXtractor from the browser toolbar first.');
  const result = await native('PIN', { token: panel.token, pinned: Boolean(pinned) });
  const saved = await settings();
  await chrome.storage.local.set({ panelSettings: { ...saved, pinned: result.pinned } });
  return result;
}

export async function savePinPreference(pinned) {
  const saved = await settings();
  await chrome.storage.local.set({ panelSettings: { ...saved, pinned: Boolean(pinned) } });
  return { pinned: Boolean(pinned) };
}

chrome.action.onClicked.addListener(tab => { openPanel(tab).catch(console.error); });
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try { const tab = await chrome.tabs.get(tabId); const window = await chrome.windows.get(tab.windowId); if (window.type === 'normal') await rememberTab(tab); } catch { /* Closed tab. */ }
});
chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (!tab.active || !change.url) return;
  try { if ((await chrome.windows.get(tab.windowId)).type === 'normal') await rememberTab(tab); } catch { /* Closed window. */ }
});
chrome.windows.onFocusChanged.addListener(async windowId => {
  if (windowId < 0) return;
  try { const window = await chrome.windows.get(windowId); if (window.type !== 'normal') return; const [tab] = await chrome.tabs.query({ active: true, windowId }); await rememberTab(tab); } catch { /* Closed window. */ }
});
chrome.windows.onBoundsChanged.addListener(async window => {
  const { panel } = await chrome.storage.session.get('panel');
  if (panel?.windowId !== window.id || window.state !== 'normal') return;
  const previous = await settings();
  await chrome.storage.local.set({ panelSettings: { ...previous, width: window.width, height: window.height, left: window.left, top: window.top } });
});
chrome.windows.onRemoved.addListener(async windowId => {
  const { panel } = await chrome.storage.session.get('panel');
  if (panel?.windowId === windowId) await chrome.storage.session.remove('panel');
});
