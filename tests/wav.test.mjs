import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { wavHeader, interleave, MAX_DATA_BYTES, WAV_HEADER_BYTES } from '../extension/lib/wav.js';

test('WAV header describes uncompressed IEEE Float32 with fact and data chunks', () => {
  const buffer = Buffer.from(wavHeader(48000, 2, 48000));
  assert.equal(buffer.length, WAV_HEADER_BYTES);
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF'); assert.equal(buffer.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buffer.readUInt16LE(20), 3); assert.equal(buffer.readUInt16LE(22), 2);
  assert.equal(buffer.readUInt32LE(24), 48000); assert.equal(buffer.readUInt16LE(34), 32);
  assert.equal(buffer.toString('ascii', 36, 40), 'fact'); assert.equal(buffer.readUInt32LE(44), 48000);
  assert.equal(buffer.toString('ascii', 48, 52), 'data'); assert.equal(buffer.readUInt32LE(52), 384000);
  assert.equal(buffer.readUInt32LE(4), buffer.length + 384000 - 8);
});
test('interleaving and WAV serialization preserve Float32 sample bits including negative zero and headroom', () => {
  const left = new Float32Array([0, -0, .123456789, -1.234567, 1.999999]);
  const right = new Float32Array([.9, -.8, .7, -.6, .5]);
  const samples = interleave([left, right]);
  const wav = Buffer.concat([Buffer.from(wavHeader(44100, 2, left.length)), Buffer.from(samples.buffer)]);
  for (let frame = 0; frame < left.length; frame++) for (let channel = 0; channel < 2; channel++) {
    const original = [left, right][channel];
    const expected = Buffer.from(original.buffer).readUInt32LE(frame * 4);
    assert.equal(wav.readUInt32LE(WAV_HEADER_BYTES + (frame * 2 + channel) * 4), expected);
  }
});
test('rejects invalid WAV metadata and RIFF overflow', () => {
  for (const args of [[1, 2, 10], [48000, 0, 10], [48000, 2, -1], [48000, 2, 1.1], [48000, 2, MAX_DATA_BYTES]]) assert.throws(() => wavHeader(...args));
});

async function processor() {
  const messages = [];
  let Processor;
  const context = vm.createContext({ Float32Array, Math, AudioWorkletProcessor: class { constructor() { this.port = { postMessage: data => messages.push(data) }; } }, registerProcessor: (name, value) => { Processor = value; } });
  vm.runInContext(await readFile(new URL('../extension/pcm-worklet.js', import.meta.url), 'utf8'), context);
  return { instance: new Processor({ processorOptions: { channels: 2 } }), messages };
}

test('worklet reports first input render once, including silence, without recording samples before Start', async () => {
  const { instance, messages } = await processor();
  instance.process([[]]);
  assert.equal(messages.length, 0);
  instance.process([[new Float32Array(128), new Float32Array(128)]]);
  instance.process([[new Float32Array(128), new Float32Array(128)]]);
  assert.equal(messages.filter(item => item.type === 'render-ready').length, 1);
  assert.equal(messages.filter(item => item.type === 'pcm').length, 0);
});

test('connected idle waveform emits only a small meter message and never stores PCM', async () => {
  const { instance, messages } = await processor();
  instance.process([[new Float32Array(4096).fill(.25), new Float32Array(4096).fill(-.5)]]);
  const meter = messages.find(item => item.type === 'meter');
  assert.equal(meter.waveform.length, 96); assert.equal(meter.peak, .5);
  assert.equal(messages.filter(item => item.type === 'pcm').length, 0);
  assert.equal(instance.frames, 0);
});
test('actual worklet preserves samples across variable block sizes, pause, resume and final partial flush', async () => {
  const { instance, messages } = await processor();
  instance.port.onmessage({ data: { command: 'start', id: '1' } });
  const expected = [];
  for (const frames of [128, 256, 73, 4096, 240]) {
    const left = Float32Array.from({ length: frames }, (_, i) => Math.sin(i) * 1.3), right = Float32Array.from({ length: frames }, (_, i) => Math.cos(i) * .3);
    expected.push(...interleave([left, right])); instance.process([[left, right]]);
  }
  instance.port.onmessage({ data: { command: 'pause', id: '2' } });
  const before = messages.filter(item => item.type === 'pcm').length;
  instance.process([[new Float32Array(128).fill(9), new Float32Array(128).fill(9)]]);
  assert.equal(messages.filter(item => item.type === 'pcm').length, before);
  instance.port.onmessage({ data: { command: 'resume', id: '3' } });
  const left = new Float32Array([-.123456789, -0]), right = new Float32Array([1.123456789, .5]);
  expected.push(...interleave([left, right])); instance.process([[left, right]]);
  instance.port.onmessage({ data: { command: 'stop', id: '4' } });
  const actual = Buffer.concat(messages.filter(item => item.type === 'pcm').map(item => Buffer.from(item.buffer)));
  assert.deepEqual(actual, Buffer.from(new Float32Array(expected).buffer));
  assert.equal(messages.filter(item => item.type === 'ack').length, 4);
  assert.equal(actual.length, expected.length * 4);
});
