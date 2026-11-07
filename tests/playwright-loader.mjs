import { readFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

export async function loadPlaywright() {
  if (process.env.AUDIOXTRACTOR_PLAYWRIGHT_PATH) return import(pathToFileURL(join(process.env.AUDIOXTRACTOR_PLAYWRIGHT_PATH, 'index.mjs')).href);
  try { return await import('playwright'); } catch { /* Reuse an existing local Playwright installation. */ }
  const links = join(homedir(), 'AppData/Local/ms-playwright/.links');
  let entries = [];
  try { entries = await readdir(links); } catch { /* Non-Windows or no cached browsers. */ }
  const candidates = [];
  for (const entry of entries) {
    try {
      const dir = (await readFile(join(links, entry), 'utf8')).trim();
      await access(join(dir, 'index.mjs'));
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
      candidates.push({ dir, version: pkg.version });
    } catch { /* Ignore stale cache links. */ }
  }
  candidates.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  for (const candidate of candidates) {
    const pw = await import(pathToFileURL(join(candidate.dir, 'index.mjs')).href);
    try { await access(pw.chromium.executablePath()); return pw; } catch { /* Match the next installed browser. */ }
  }
  throw new Error('Playwright and its Chromium browser are required for browser tests. Set AUDIOXTRACTOR_PLAYWRIGHT_PATH to an existing playwright-core package, or install Playwright in your development environment.');
}
