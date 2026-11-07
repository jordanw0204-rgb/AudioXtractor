let port;
let connecting;
let capabilities;
const waiting = new Map();
const host = 'com.audioxtractor.companion';

function transmit(command, data = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => { waiting.delete(id); reject(new Error('The desktop companion did not respond in time.')); }, timeoutMs);
    waiting.set(id, { resolve, reject, timeout });
    try { port.postMessage({ id, command, ...data }); }
    catch (error) { clearTimeout(timeout); waiting.delete(id); reject(error); }
  });
}

async function connect() {
  if (port && capabilities) return capabilities;
  if (connecting) return connecting;
  connecting = (async () => {
    let { nativeClientId } = await chrome.storage.local.get('nativeClientId');
    if (!nativeClientId) { nativeClientId = crypto.randomUUID(); await chrome.storage.local.set({ nativeClientId }); }
    port = chrome.runtime.connectNative(host);
    port.onMessage.addListener(message => {
      if (message.event && globalThis.dispatchEvent) globalThis.dispatchEvent(new CustomEvent(`audioxtractor:native-${message.event}`, { detail: message }));
      const pending = waiting.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout); waiting.delete(message.id);
      if (message.ok) pending.resolve(message);
      else pending.reject(new Error(message.error || 'Desktop companion action failed.'));
    });
    port.onDisconnect.addListener(() => {
      const detail = chrome.runtime.lastError?.message;
      port = undefined; capabilities = undefined;
      for (const pending of waiting.values()) { clearTimeout(pending.timeout); pending.reject(new Error(`Desktop companion unavailable. Run companion setup, then reopen AudioXtractor.${detail ? ` ${detail}` : ''}`)); }
      waiting.clear();
    });
    capabilities = await transmit('HELLO', { clientId: nativeClientId, role: globalThis.document ? 'window' : 'service' });
    return capabilities;
  })().finally(() => { connecting = undefined; });
  return connecting;
}

export async function native(command, data = {}) {
  const status = await connect();
  if (command === 'STATUS') return { connected: true, ...status };
  return transmit(command, data, command === 'RESOLVE' ? 110000 : 30000);
}

export async function nativeStatus() {
  try { return await native('STATUS'); }
  catch (error) { return { connected: false, error: error.message }; }
}
