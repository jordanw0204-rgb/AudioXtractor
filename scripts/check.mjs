import { readFile, readdir, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../extension/', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3 || !manifest.minimum_chrome_version) throw new Error('Invalid extension manifest.');
for (const file of [manifest.background.service_worker, manifest.action.default_popup || 'popup.html', ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap(item => item.js)]) await access(resolve(root, file));
let checked = 0;
async function check(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await check(path);
    else if (entry.name.endsWith('.js')) { execFileSync(process.execPath, ['--check', path]); checked++; }
    else if (entry.name.endsWith('.html')) {
      const html = await readFile(path, 'utf8');
      if (/<script(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(html)) throw new Error(`Inline script violates MV3 CSP: ${entry.name}`);
      for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) if (!/^(https?:|data:)/.test(match[1])) await access(resolve(dir, match[1]));
    }
  }
}
await check(root);
console.log(`Manifest, local assets, CSP and ${checked} JavaScript files verified.`);
