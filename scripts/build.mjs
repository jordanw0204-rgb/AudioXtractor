import { cp, mkdir, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateIcons } from './icons.mjs';
import { writeZip } from './zip.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
await generateIcons();
await import('./check.mjs');
const manifest = JSON.parse(await readFile(join(root, 'extension/manifest.json'), 'utf8'));
const out = join(root, 'dist/AudioXtractor');
await mkdir(out, { recursive: true });
await cp(join(root, 'extension'), out, { recursive: true });
const zip = join(root, 'dist', `AudioXtractor-${manifest.version}.zip`);
const count = await writeZip(out, zip);
console.log(`Built ${count} extension files.\nUnpacked: ${out}\nArchive: ${zip}`);
const companion = join(root, 'dist/AudioXtractor-Companion', manifest.version);
try {
  await access(join(companion, 'AudioXtractor.Native.exe'));
  const companionZip = join(root, 'dist', `AudioXtractor-Companion-${manifest.version}.zip`);
  const nativeCount = await writeZip(companion, companionZip, name => !name.endsWith('.pdb') && name !== 'tools.json' && name !== 'com.audioxtractor.companion.json');
  console.log(`Companion: ${nativeCount} portable files, ${companionZip}`);
} catch (error) { if (error.code !== 'ENOENT') throw error; console.log('Run npm run setup:companion to build the optional Windows companion.'); }
