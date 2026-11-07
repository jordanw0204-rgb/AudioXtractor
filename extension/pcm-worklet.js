class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = options.processorOptions.channels;
    this.capacity = 4096;
    this.buffer = new Float32Array(this.capacity * this.channels);
    this.frames = 0;
    this.recording = false;
    this.renderReady = false;
    this.idleFrames = 0;
    this.port.onmessage = ({ data }) => {
      if (data.command === 'pause' || data.command === 'stop') { this.recording = false; this.flush(); }
      if (data.command === 'start' || data.command === 'resume') this.recording = true;
      this.port.postMessage({ type: 'ack', id: data.id });
    };
  }

  flush() {
    if (!this.frames) return;
    const samples = this.buffer.slice(0, this.frames * this.channels);
    const waveform = [];
    let peak = 0;
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
    for (let i = 0; i < 96; i++) {
      const frame = Math.min(this.frames - 1, Math.floor(i * this.frames / 96));
      let sample = 0;
      for (let channel = 0; channel < this.channels; channel++) if (Math.abs(samples[frame * this.channels + channel]) > Math.abs(sample)) sample = samples[frame * this.channels + channel];
      waveform.push(sample);
    }
    this.port.postMessage({ type: 'pcm', buffer: samples.buffer, frames: this.frames, waveform, peak }, [samples.buffer]);
    this.frames = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!this.renderReady && input?.[0]?.length) { this.renderReady = true; this.port.postMessage({ type: 'render-ready' }); }
    if (!input?.length || !input[0].length) return true;
    if (!this.recording) {
      this.idleFrames += input[0].length;
      if (this.idleFrames >= this.capacity) {
        this.idleFrames %= this.capacity;
        const waveform = []; let peak = 0;
        for (const channel of input) for (const sample of channel) peak = Math.max(peak, Math.abs(sample));
        for (let i = 0; i < 96; i++) {
          const frame = Math.min(input[0].length - 1, Math.floor(i * input[0].length / 96)); let sample = 0;
          for (const channel of input) if (Math.abs(channel[frame]) > Math.abs(sample)) sample = channel[frame];
          waveform.push(sample);
        }
        this.port.postMessage({ type: 'meter', waveform, peak });
      }
      return true;
    }
    for (let frame = 0; frame < input[0].length; frame++) {
      for (let channel = 0; channel < this.channels; channel++) this.buffer[this.frames * this.channels + channel] = input[channel]?.[frame] ?? 0;
      this.frames++;
      if (this.frames === this.capacity) this.flush();
    }
    // Output stays silent. The source has a separate unity-gain monitor path.
    return true;
  }
}

registerProcessor('audioxtractor-pcm', PcmCaptureProcessor);
