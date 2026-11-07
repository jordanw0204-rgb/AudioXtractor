import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ -1) >>> 0;
}
export async function writeZip(directory, destination, include = () => true) {
  const local = [], central = []; let offset = 0, count = 0;
  async function add(dir, prefix = '') {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name), name = prefix + entry.name;
      if (entry.isDirectory()) { await add(path, name + '/'); continue; }
      if (!include(name)) continue;
      const data = await readFile(path), encoded = Buffer.from(name), crc = crc32(data);
      const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(0x21, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(encoded.length, 26);
      local.push(header, encoded, data);
      const item = Buffer.alloc(46); item.writeUInt32LE(0x02014b50); item.writeUInt16LE(20, 4); item.writeUInt16LE(20, 6); item.writeUInt16LE(0x800, 8); item.writeUInt16LE(0x21, 14); item.writeUInt32LE(crc, 16); item.writeUInt32LE(data.length, 20); item.writeUInt32LE(data.length, 24); item.writeUInt16LE(encoded.length, 28); item.writeUInt32LE(offset, 42);
      central.push(item, encoded); offset += header.length + encoded.length + data.length; count++;
    }
  }
  await add(directory);
  const index = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  await writeFile(destination, Buffer.concat([...local, index, end]));
  return count;
}
