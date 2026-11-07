let prepared, preparing, expiry;

async function createEngine(sampleRate, silent = false) {
  const context = new AudioContext({ ...(sampleRate ? { sampleRate } : {}), latencyHint: 'interactive', ...(silent ? { sinkId: { type: 'none' } } : {}) });
  try {
    if (silent && context.sinkId?.type !== 'none') await context.setSinkId({ type: 'none' });
    await context.audioWorklet.addModule(chrome.runtime.getURL('pcm-worklet.js'));
    const silence = context.createConstantSource();
    silence.offset.value = 0; silence.connect(context.destination); silence.start();
    await context.resume();
    if (context.state !== 'running') throw new Error('The audio engine could not start. Reopen AudioXtractor and try again.');
    const clock = context.currentTime, deadline = performance.now() + 1000;
    while (context.currentTime <= clock) {
      if (performance.now() >= deadline) throw new Error('The audio clock did not start. Check your output device and try again.');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return context;
  } catch (error) { await context.close(); throw error; }
}

export async function prepareAudioEngine() {
  if (preparing) return preparing;
  if (prepared && prepared.state !== 'closed') return prepared;
  preparing = createEngine().then(context => {
    prepared = context; clearTimeout(expiry);
    expiry = setTimeout(() => { if (prepared === context) { prepared = null; context.close().catch(() => {}); } }, 300000);
    return context;
  }).finally(() => { preparing = undefined; });
  return preparing;
}
export async function takeAudioEngine() {
  const context = await prepareAudioEngine(); prepared = null; clearTimeout(expiry); return context;
}
export function createProcessingEngine(sampleRate) { return createEngine(sampleRate, true); }
