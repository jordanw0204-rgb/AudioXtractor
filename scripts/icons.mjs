import { writeFile, mkdir, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, crc]);
}
function icon(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const heights = [6, 14, 23, 14, 6];
  const scale = size / 32;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = (x + .5) / scale, py = (y + .5) / scale;
    const rx = Math.max(6 - px, px - 26, 0), ry = Math.max(6 - py, py - 26, 0);
    const inside = rx * rx + ry * ry <= 36;
    let foreground = false;
    for (let i = 0; i < heights.length; i++) {
      const cx = 6 + i * 5, half = heights[i] / 2;
      const dx = Math.abs(px - cx), dy = Math.max(Math.abs(py - 16) - half + 1, 0);
      if (dx * dx + dy * dy <= 1.1 ** 2) foreground = true;
    }
    const at = y * (size * 4 + 1) + 1 + x * 4;
    raw[at] = foreground ? 236 : 24; raw[at + 1] = foreground ? 236 : 24; raw[at + 2] = foreground ? 242 : 28; raw[at + 3] = inside ? 255 : 0;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
export async function generateIcons() {
  const dir = fileURLToPath(new URL('../extension/icons/', import.meta.url));
  await mkdir(dir, { recursive: true });
  const source = fileURLToPath(new URL('../assets/AudioXtractor-icon.png', import.meta.url));
  try {
    await access(source);
    if (process.platform === 'win32') {
      execFileSync('powershell.exe', ['-NoProfile', '-File', fileURLToPath(new URL('./prepare-icon.ps1', import.meta.url)), '-Source', source, '-OutputDirectory', dir]);
      return;
    }
    // Prepared PNGs are checked in so non-Windows builds need no image library.
    await access(`${dir}/icon128.png`); return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const size of [16, 32, 48, 128]) await writeFile(`${dir}/icon${size}.png`, icon(size));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await generateIcons();
