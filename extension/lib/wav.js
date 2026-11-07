// IEEE Float WAV stores the Web Audio Float32 samples without quantization.
export const WAV_HEADER_BYTES = 56;
export const MAX_DATA_BYTES = 2 * 1024 ** 3;

export function wavHeader(sampleRate, channels, frames) {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 384000) throw new Error('Invalid sample rate.');
  if (!Number.isInteger(channels) || channels < 1 || channels > 8) throw new Error('Invalid channel count.');
  if (!Number.isSafeInteger(frames) || frames < 0) throw new Error('Invalid frame count.');
  const dataBytes = frames * channels * 4;
  if (dataBytes > MAX_DATA_BYTES) throw new Error('Recording reached the 2 GB WAV limit.');
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES);
  const view = new DataView(buffer);
  const tag = (at, text) => [...text].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  tag(0, 'RIFF'); view.setUint32(4, 48 + dataBytes, true); tag(8, 'WAVE');
  tag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 3, true);
  view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 4, true); view.setUint16(32, channels * 4, true); view.setUint16(34, 32, true);
  tag(36, 'fact'); view.setUint32(40, 4, true); view.setUint32(44, frames, true);
  tag(48, 'data'); view.setUint32(52, dataBytes, true);
  return buffer;
}

export function interleave(channels, frames = channels[0]?.length || 0) {
  const output = new Float32Array(frames * channels.length);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels.length; channel++) output[frame * channels.length + channel] = channels[channel][frame] ?? 0;
  return output;
}
