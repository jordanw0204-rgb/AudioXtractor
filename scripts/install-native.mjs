import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const extensionPath = resolve(root, 'dist/AudioXtractor');
let extensionId = process.argv[process.argv.indexOf('--extension-id') + 1];
if (!/^[a-p]{32}$/.test(extensionId || '')) {
  extensionId = undefined;
  for (const name of ['Secure Preferences', 'Preferences']) {
    try {
      const prefs = JSON.parse(await readFile(join(root, '.local-profile/Default', name), 'utf8'));
      extensionId ||= Object.entries(prefs.extensions?.settings || {}).find(([, item]) => item.path?.toLowerCase() === extensionPath.toLowerCase())?.[0];
    } catch { /* The preview may not have been launched yet. */ }
  }
}
if (!/^[a-p]{32}$/.test(extensionId || '')) throw new Error('Use --extension-id followed by the AudioXtractor ID shown on chrome://extensions.');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const output = join(root, 'dist/AudioXtractor-Companion', version);
execFileSync('dotnet', ['build', join(root, 'native/AudioXtractor.Native.csproj'), '-c', 'Release', '-o', output, '--nologo'], { stdio: 'inherit' });
const getTool = name => execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Command '${name}' -ErrorAction Stop).Source`], { encoding: 'utf8' }).trim();
let localDownloader;
try { localDownloader = JSON.parse(await readFile(join(root, '.tools/downloader/current.json'), 'utf8')); } catch { /* Use installed tool. */ }
const downloader = localDownloader?.executable || getTool('yt-dlp');
const tools = { ytDlp: downloader, ffmpeg: getTool('ffmpeg'), node: process.execPath, downloaderVersion: execFileSync(downloader, ['--version'], { encoding: 'utf8', windowsHide: true }).trim() };
await writeFile(join(output, 'tools.json'), JSON.stringify(tools, null, 2));
const host = { name: 'com.audioxtractor.companion', description: 'AudioXtractor local file and audio companion', path: join(output, 'AudioXtractor.Native.exe'), type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] };
const manifestPath = join(output, 'com.audioxtractor.companion.json');
try {
  const previous = JSON.parse(await readFile(manifestPath, 'utf8'));
  host.allowed_origins = [...new Set([...host.allowed_origins, ...(previous.allowed_origins || []).filter(value => /^chrome-extension:\/\/[a-p]{32}\/$/.test(value))])];
} catch { /* First setup. */ }
await writeFile(manifestPath, JSON.stringify(host, null, 2));
await cp(join(root, 'native/Install-Companion.ps1'), join(output, 'Install-Companion.ps1'));
await writeFile(join(output, 'README.txt'), `AudioXtractor Windows companion ${version}\r\nRequires .NET 9 Desktop Runtime, current yt-dlp, FFmpeg and Node installed locally.\r\nExtract this folder somewhere permanent. Run Install-Companion.ps1 -ExtensionId YOUR_EXTENSION_ID to register it for your browser. No administrator access is needed.\r\nThe companion handles OS pinning, native file drag, original stream resolution and local MP3 conversion. It has no listening network service.\r\n`);
for (const vendor of ['Google\\Chrome', 'Google\\ChromeForTesting', 'Chromium', 'Microsoft\\Edge', 'BraveSoftware\\Brave-Browser']) execFileSync('reg.exe', ['ADD', `HKCU\\Software\\${vendor}\\NativeMessagingHosts\\${host.name}`, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { stdio: 'pipe' });
console.log(`Companion registered for ${extensionId}.\n${output}\nUses yt-dlp ${tools.downloaderVersion}${localDownloader ? ' from the app-local tools folder' : ''}, FFmpeg and Node. No administrator access needed.`);
