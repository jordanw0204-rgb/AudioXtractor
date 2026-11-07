import { test } from 'node:test';
import assert from 'node:assert/strict';

test('one-click current-tab recording lifecycle', async t => {
  let listener, captures = 0, choice = 'normal', rate = 44100, audio, endOnStart = false, endOnStop = false, hold = false, release, holdFile = false, releaseFile;
  const timers = new Set(), nativeSet = globalThis.setInterval, nativeClear = globalThis.clearInterval;
  globalThis.setInterval = (...args) => { const id = nativeSet(...args); timers.add(id); return id; };
  globalThis.clearInterval = id => { timers.delete(id); nativeClear(id); };
  t.after(() => { for (const id of timers) nativeClear(id); globalThis.setInterval = nativeSet; globalThis.clearInterval = nativeClear; });
  const contexts = [], writes = [], edges = [], events = [], messages = [];
  const tab = { id: 1, title: 'Silent fixture', url: 'https://example.test/audio' };
  const other = { id: 2, title: 'Other website', url: 'https://other.test/audio' };
  const directory = { getFileHandle: async () => ({ createWritable: async () => { if (holdFile) await new Promise(resolve => { releaseFile = resolve; }); return { write: async data => writes.push(data), close: async () => {}, seek: async () => {}, abort: async () => {} }; } }), removeEntry: async () => {} };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    storage: { estimate: async () => ({ quota: 1e9, usage: 0 }), getDirectory: async () => ({ getDirectoryHandle: async () => directory }) },
    mediaDevices: {
      getDisplayMedia: async () => { throw new Error('The Share picker must never be used'); },
      getUserMedia: async options => {
        captures++; events.push('capture');
        assert.equal(options.audio.mandatory.chromeMediaSource, 'tab'); assert.match(options.audio.mandatory.chromeMediaSourceId, /^id-/); assert.equal(options.video, false);
        assert.equal(contexts.at(-1).state, 'running');
        if (choice === 'denied') throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
        if (hold) await new Promise(resolve => { release = resolve; });
        const ended = [];
        audio = { readyState: 'live', stopped: false,
          getSettings: () => ({ sampleRate: rate, channelCount: 2, echoCancellation: choice === 'processed', noiseSuppression: false, autoGainControl: false }),
          applyConstraints: async constraints => assert.equal(constraints.echoCancellation, false),
          addEventListener: (name, callback) => { if (name === 'ended') ended.push(callback); },
          stop() { this.stopped = true; this.readyState = 'ended'; },
          end() { this.readyState = 'ended'; ended.forEach(callback => callback()); }
        };
        return { getAudioTracks: () => choice === 'no-audio' ? [] : [audio], getVideoTracks: () => [], getTracks: () => choice === 'no-audio' ? [] : [audio] };
      }
    }
  } });
  globalThis.chrome = { runtime: { id: 'fixture', getURL: name => name, onMessage: { addListener(value) { listener = value; } }, sendMessage: async value => { messages.push(value); return { ok: true }; } } };
  globalThis.AudioContext = class {
    constructor(options) { this.sampleRate = options.sampleRate || 44100; this.sinkId = options.sinkId || ''; this.state = 'suspended'; this.destination = {}; this.audioWorklet = { addModule: async () => events.push('compiled') }; contexts.push(this); }
    get currentTime() { return this.state === 'running' ? performance.now() / 1000 : 0; }
    createConstantSource() { const node = { offset: { value: 1 }, connect() {}, start: () => assert.equal(node.offset.value, 0) }; return node; }
    createMediaStreamSource() { return { connect: target => { edges.push({ context: this, target }); events.push(target === this.destination ? 'monitor' : 'processor'); }, disconnect() {} }; }
    async resume() { await new Promise(resolve => setTimeout(resolve, 10)); this.state = 'running'; events.push('running'); }
    async close() { this.state = 'closed'; }
  };
  globalThis.AudioWorkletNode = class {
    constructor() { this.port = { postMessage: data => queueMicrotask(() => {
      if (data.command === 'start' && endOnStart) { endOnStart = false; audio.end(); }
      if (['start', 'resume', 'stop'].includes(data.command)) this.port.onmessage({ data: { type: 'pcm', buffer: new Float32Array([-.123456789, -0, 1.234567, .5]).buffer, frames: 2, waveform: [], peak: 1.234567 } });
      if (data.command === 'stop' && endOnStop) { endOnStop = false; audio.end(); }
      this.port.onmessage({ data: { type: 'ack', id: data.id } });
    }) }; }
    connect() { setTimeout(() => { this.port.onmessage({ data: { type: 'render-ready' } }); this.port.onmessage({ data: { type: 'meter', waveform: [0], peak: 0 } }); }, 10); }
    disconnect() {}
  };
  await import('../extension/offscreen.js');
  const send = (type, data = {}) => new Promise(resolve => listener({ target: 'offscreen', type, ...data }, { id: 'fixture' }, resolve));
  const attach = (selected = tab) => send('ATTACH', { tab: selected, streamId: 'id-' + selected.id });
  const start = (selected = tab) => send('START', { tab: selected });
  await t.test('connects without a picker or recording and restores one warm monitor', async () => {
    await send('PREPARE'); const result = await attach();
    assert.equal(result.ok, true); assert.equal(result.state.status, 'idle'); assert.equal(result.state.connected, true); assert.equal(result.state.tabId, tab.id);
    assert.equal(writes.length, 0); assert.equal(captures, 1); assert.equal(contexts.length, 1);
    assert(events.indexOf('compiled') < events.indexOf('capture')); assert(events.indexOf('running') < events.indexOf('capture')); assert(events.indexOf('monitor') < events.indexOf('processor'));
    assert.equal(edges.filter(edge => edge.target === edge.context.destination).length, 1); assert(messages.some(message => message.type === 'ENGINE_METER'));
  });
  await t.test('Record, pause/resume and repeated takes reuse input and preserve PCM bits', async () => {
    const first = await start(); assert.equal(first.state.status, 'recording'); assert.equal(first.state.captureMs, 0); assert.equal(first.state.preparedConnection, true); assert.equal(first.state.title, tab.title);
    await send('PAUSE'); await send('RESUME'); assert.equal((await send('DISCONNECT')).ok, false); assert.equal((await send('DISCONNECT', { onlyIfIdle: true })).state.status, 'recording');
    const saved = await send('STOP'); assert.equal(saved.state.connected, true); assert.equal(audio.stopped, false); assert.equal(saved.recording.origin, 'example.test');
    const second = await start(); assert.equal(second.state.reusedConnection, true); assert.equal(second.state.captureMs, 0); assert.equal(captures, 1); assert.equal(contexts.length, 1); await send('STOP');
    const pcm = writes.find(data => data instanceof Uint8Array && data.byteLength === 16); assert.deepEqual(Buffer.from(pcm), Buffer.from(new Float32Array([-.123456789, -0, 1.234567, .5]).buffer));
    await send('DISCONNECT'); assert.equal(audio.stopped, true); assert.equal(contexts[0].state, 'closed');
  });
  await t.test('a different current tab cannot reuse the previous website audio', async () => {
    await attach(); assert.equal((await start(other)).ok, false); assert.equal((await send('STATE')).state.connected, false);
    await attach(other); const next = await start(other); assert.equal(next.state.tabId, other.id); assert.equal(next.state.title, other.title); assert.equal((await attach(tab)).ok, false);
    await send('STOP'); await send('DISCONNECT');
  });
  await t.test('closing the captured tab flushes and saves an active take', async () => {
    await attach(); await start(); audio.end(); let result;
    for (let i = 0; i < 30; i++) { result = await send('STATE'); if (result.state.status === 'idle') break; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(result.state.status, 'idle'); assert.equal(result.state.connected, false); assert.match(result.state.error, /capture ended/); assert.equal(contexts.at(-1).state, 'closed');
  });
  await t.test('capture ending during Save releases the ended graph', async () => {
    await attach(); await start(); endOnStop = true; assert.equal((await send('STOP')).state.connected, false);
    const before = captures; await attach(); const next = await start(); assert.equal(next.state.status, 'recording'); assert.equal(next.state.reusedConnection, false); assert.equal(captures, before + 1);
    await send('STOP'); await send('DISCONNECT');
  });
  await t.test('capture ending during Start leaves no stale timer or session', async () => {
    await attach(); endOnStart = true; const result = await start(); assert.equal(result.ok, true); assert.equal(result.state.status, 'idle'); assert.equal(result.state.connected, false); assert.equal(timers.size, 0);
  });
  await t.test('a rate mismatch retains the monitor and records at the actual capture rate', async () => {
    rate = 48000; const before = contexts.length; await attach(); assert.equal((await start()).state.sampleRate, 48000); assert.equal(contexts.length, before + 2); assert.equal(contexts.at(-1).sinkId.type, 'none'); assert.equal(contexts[before].state, 'running');
    await send('STOP'); await send('DISCONNECT'); assert.equal(contexts[before].state, 'closed'); assert.equal(contexts.at(-1).state, 'closed'); rate = 44100;
  });
  await t.test('missing audio, denied access and processing errors clean up without files', async () => {
    for (const invalid of ['no-audio', 'denied', 'processed']) { choice = invalid; const before = writes.length; assert.equal((await attach()).ok, false, invalid); assert.equal((await send('STATE')).state.connected, false); assert.equal(writes.length, before); assert.equal(contexts.at(-1).state, 'closed'); }
    choice = 'normal';
  });
  await t.test('Record waits for one in-flight connection without reacquiring input', async () => {
    hold = true; const before = captures; const pendingAttach = attach(); for (let i = 0; i < 30 && !release; i++) await new Promise(resolve => setTimeout(resolve, 5));
    const pendingStart = start(); release(); hold = false; assert.equal((await pendingAttach).ok, true); assert.equal((await pendingStart).state.status, 'recording'); assert.equal(captures, before + 1);
    await send('STOP'); await send('DISCONNECT'); assert.equal(timers.size, 0);
  });
  await t.test('retargeting cannot replace a graph while Record opens its output file', async () => {
    await attach(); holdFile = true; const pending = start();
    for (let i = 0; i < 30 && !releaseFile; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await attach(other)).ok, false);
    holdFile = false; releaseFile();
    assert.equal((await pending).state.tabId, tab.id);
    await send('STOP'); await send('DISCONNECT');
  });
});
