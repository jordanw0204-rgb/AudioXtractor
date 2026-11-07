import { wavHeader, WAV_HEADER_BYTES } from './wav.js';
import { safeFilename } from './media.js';

async function directory() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('audioxtractor', { create: true });
}

function validateId(id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid recording.');
  return id;
}

export async function createRecording(title) {
  const dir = await directory();
  const id = crypto.randomUUID();
  const handle = await dir.getFileHandle(`${id}.wav`, { create: true });
  const writer = await handle.createWritable();
  await writer.write(new Uint8Array(WAV_HEADER_BYTES));
  return { id, dir, handle, writer, title, createdAt: Date.now() };
}

export async function finishRecording(file, { sampleRate, channels, frames, origin }) {
  await file.writer.seek(0);
  await file.writer.write(wavHeader(sampleRate, channels, frames));
  await file.writer.close();
  const record = { id: file.id, title: file.title, createdAt: file.createdAt, sampleRate, channels, frames, duration: frames / sampleRate, bytes: WAV_HEADER_BYTES + frames * channels * 4, origin, filename: `${safeFilename(file.title)} - ${new Date(file.createdAt).toISOString().replace(/[:.]/g, '-')}.wav` };
  const metadata = await file.dir.getFileHandle(`${file.id}.json`, { create: true });
  const writer = await metadata.createWritable();
  await writer.write(JSON.stringify(record));
  await writer.close();
  return record;
}

export async function abandonRecording(file) {
  await file.writer.abort().catch(() => {});
  await file.dir.removeEntry(`${file.id}.wav`).catch(() => {});
}

export async function listRecordings() {
  const dir = await directory();
  const records = [];
  for await (const [name, handle] of dir.entries()) {
    if (!name.endsWith('.json') || handle.kind !== 'file') continue;
    try { records.push(JSON.parse(await (await handle.getFile()).text())); } catch { /* Ignore interrupted metadata writes. */ }
  }
  return records.sort((a, b) => b.createdAt - a.createdAt);
}

export async function recordingFile(id) {
  validateId(id);
  const dir = await directory();
  const file = await (await dir.getFileHandle(`${id}.wav`)).getFile();
  const metadata = JSON.parse(await (await (await dir.getFileHandle(`${id}.json`)).getFile()).text());
  return { file: new File([file], metadata.filename, { type: 'audio/wav' }), metadata };
}

export async function deleteRecording(id) {
  validateId(id);
  const dir = await directory();
  await dir.removeEntry(`${id}.json`);
  await dir.removeEntry(`${id}.wav`);
}
