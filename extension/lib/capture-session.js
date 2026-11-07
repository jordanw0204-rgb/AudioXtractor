import { takeAudioEngine, createProcessingEngine } from './audio-engine.js';

export async function connectCapture({ streamId, tab, onPcm, onMeter, onEnded }) {
  if (!streamId || !Number.isInteger(tab?.id)) throw new Error('Connect the current website before recording.');
  const began = performance.now();
  const graph = { id: crypto.randomUUID(), tab, takes: 0, pending: new Map(), closed: false };
  graph.command = name => new Promise((resolve, reject) => {
    if (graph.closed) { reject(new Error('The tab disconnected.')); return; }
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => { graph.pending.delete(id); reject(new Error('The audio processor stopped responding.')); }, 5000);
    graph.pending.set(id, { resolve, reject, timeout });
    graph.worklet.port.postMessage({ command: name, id });
  });
  graph.dispose = () => {
    if (graph.closed) return;
    graph.closed = true;
    graph.cancelReady?.();
    for (const pending of graph.pending.values()) { clearTimeout(pending.timeout); pending.reject(new Error('The tab disconnected.')); }
    graph.pending.clear();
    graph.source?.disconnect(); graph.worklet?.disconnect();
    graph.monitorSource?.disconnect();
    graph.stream?.getTracks().forEach(track => track.stop());
    graph.context?.close().catch(() => {});
    if (graph.monitorContext !== graph.context) graph.monitorContext?.close().catch(() => {});
  };
  try {
    graph.monitorContext = await takeAudioEngine();
    graph.stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }, video: false });
    const audio = graph.stream.getAudioTracks()[0];
    if (!audio) throw new Error('The website did not provide an audio track.');
    // This output was running before capture. Restore playback immediately and
    // retain it unchanged until the connection is explicitly released.
    graph.monitorSource = graph.monitorContext.createMediaStreamSource(graph.stream);
    graph.monitorSource.connect(graph.monitorContext.destination);
    let settings = audio.getSettings();
    if (audio.readyState === 'ended') throw new Error('The tab stopped providing audio. Reconnect it and try again.');
    if (settings.echoCancellation || settings.noiseSuppression || settings.autoGainControl) {
      await audio.applyConstraints({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
      settings = audio.getSettings();
      if (settings.echoCancellation || settings.noiseSuppression || settings.autoGainControl) throw new Error('The browser enabled audio processing. Recording stopped to preserve fidelity.');
    }
    graph.channels = Math.max(1, Math.min(8, settings.channelCount || 2));
    // An uncommon rate mismatch uses a separate silent PCM context; the warm
    // monitor keeps playing while it loads, without switching output devices.
    graph.context = settings.sampleRate && settings.sampleRate !== graph.monitorContext.sampleRate ? await createProcessingEngine(settings.sampleRate) : graph.monitorContext;
    graph.sampleRate = graph.context.sampleRate;
    graph.source = graph.context === graph.monitorContext ? graph.monitorSource : graph.context.createMediaStreamSource(graph.stream);
    let ready;
    const firstInput = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('The connected tab did not provide audio. Reconnect it and try again.')), 5000);
      ready = () => { clearTimeout(timeout); resolve(); };
      graph.cancelReady = () => { clearTimeout(timeout); reject(new Error('The tab disconnected.')); };
    });
    firstInput.catch(() => {});
    graph.worklet = new AudioWorkletNode(graph.context, 'audioxtractor-pcm', { channelCount: graph.channels, channelCountMode: 'explicit', channelInterpretation: 'discrete', numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [graph.channels], processorOptions: { channels: graph.channels } });
    graph.worklet.port.onmessage = ({ data }) => {
      if (data.type === 'ack') { const pending = graph.pending.get(data.id); if (pending) { clearTimeout(pending.timeout); graph.pending.delete(data.id); pending.resolve(); } }
      else if (data.type === 'render-ready') ready();
      else if (data.type === 'meter' && !graph.closed) onMeter?.(data);
      else if (data.type === 'pcm' && !graph.closed) onPcm(data, graph);
    };
    const ended = reason => { if (!graph.closed && !graph.ended) { graph.ended = true; graph.cancelReady?.(); onEnded(graph, reason); } };
    audio.addEventListener('ended', () => ended('The tab closed or capture ended. Your recording has been saved.'), { once: true });
    graph.worklet.onprocessorerror = () => { graph.processorFailed = true; ended('The audio processor stopped. Your recording has been saved.'); };
    graph.source.connect(graph.worklet);
    graph.worklet.connect(graph.context.destination); // Worklet output is zeros.
    await firstInput;
    graph.connectionMs = performance.now() - began;
    return graph;
  } catch (error) {
    graph.dispose();
    if (['NotAllowedError', 'AbortError'].includes(error.name)) throw new Error('Click the AudioXtractor toolbar icon on this website, then open Recorder again.');
    throw error;
  }
}
