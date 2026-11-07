import { mkdir, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run only after the user approves this third-party tool installation.
const release = {
  version: '2026.10.26',
  url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp.exe',
  sha256: 'f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d',
};
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, '.tools/downloader', release.version);
await mkdir(directory, { recursive: true });
const response = await fetch(release.url);
if (!response.ok) throw new Error(`Official download failed: ${response.status}`);
const bytes = new Uint8Array(await response.arrayBuffer());
if (createHash('sha256').update(bytes).digest('hex') !== release.sha256) throw new Error('Official release SHA-256 verification failed.');
const executable = join(directory, 'yt-dlp.exe');
await writeFile(`${executable}.partial`, bytes);
await rename(`${executable}.partial`, executable);
await writeFile(join(root, '.tools/downloader/current.json'), JSON.stringify({ ...release, executable }, null, 2));
console.log(`Verified app-local yt-dlp ${release.version}. Global tools were not changed.`);
