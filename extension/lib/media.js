const EXTENSIONS = { mp3: 'MP3', wav: 'WAV', wave: 'WAV', flac: 'FLAC', m4a: 'M4A', aac: 'AAC', ogg: 'OGG', oga: 'OGG', opus: 'OPUS', aiff: 'AIFF', aif: 'AIFF', weba: 'WEBM', mp4: 'MP4', webm: 'WEBM', m3u8: 'HLS', mpd: 'DASH', m4s: 'SEGMENT', ts: 'SEGMENT' };
const MIMES = { 'audio/mpeg': 'MP3', 'audio/mp3': 'MP3', 'audio/wav': 'WAV', 'audio/wave': 'WAV', 'audio/x-wav': 'WAV', 'audio/flac': 'FLAC', 'audio/x-flac': 'FLAC', 'audio/mp4': 'M4A', 'audio/aac': 'AAC', 'audio/aacp': 'AAC', 'audio/ogg': 'OGG', 'audio/opus': 'OPUS', 'audio/webm': 'WEBM', 'video/mp4': 'MP4', 'video/webm': 'WEBM', 'application/ogg': 'OGG' };

export function classifyMedia(rawUrl, contentType = '', elementType = '') {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (!['http:', 'https:', 'blob:'].includes(url.protocol)) return null;
  if (url.protocol === 'blob:') return { kind: 'blob', format: 'STREAM', downloadable: false };
  const ext = url.pathname.split('.').pop().toLowerCase();
  const mime = contentType.split(';')[0].trim().toLowerCase();
  const format = MIMES[mime] || EXTENSIONS[ext];
  if (['m3u8', 'mpd'].includes(ext) || /mpegurl|dash\+xml/.test(mime)) {
    return { kind: 'playlist', format: ext === 'mpd' || mime.includes('dash') ? 'DASH' : 'HLS', downloadable: false };
  }
  if (['m4s', 'ts'].includes(ext) || /mp2t/.test(mime) || url.searchParams.has('range') || url.searchParams.has('bytestart') || url.searchParams.has('byteend')) {
    if (!format && !mime.startsWith('audio/') && !mime.startsWith('video/')) return null;
    return { kind: 'segment', format: format || 'SEGMENT', downloadable: false };
  }
  if (!format && !mime.startsWith('audio/') && !['audio', 'video'].includes(elementType)) return null;
  const video = mime.startsWith('video/') || elementType === 'video' || (['mp4', 'webm'].includes(ext) && !mime.startsWith('audio/'));
  return { kind: video ? 'video' : 'file', format: format || (video ? 'VIDEO' : 'AUDIO'), downloadable: true };
}

export function sourceId(url) {
  let a = 2166136261, b = 5381;
  for (let i = 0; i < url.length; i++) { a = Math.imul(a ^ url.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ url.charCodeAt(i); }
  return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}

export function safeFilename(value, fallback = 'audio') {
  let name = String(value || fallback).normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '-').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '').slice(0, 140).replace(/[. ]+$/g, '');
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = fallback;
  return name;
}

export function sourceLabel(url, fallback = 'Audio source') {
  try { const path = new URL(url).pathname.split('/').filter(Boolean).pop(); return path ? decodeURIComponent(path).slice(0, 180) : fallback; } catch { return fallback; }
}

export function downloadFilename(source) {
  const ext = { MP3: 'mp3', WAV: 'wav', FLAC: 'flac', M4A: 'm4a', AAC: 'aac', OGG: 'ogg', OPUS: 'opus', AIFF: 'aiff', WEBM: 'webm', MP4: 'mp4' }[source.format];
  let name = safeFilename(source.label || sourceLabel(source.url));
  if (ext && !name.toLowerCase().endsWith(`.${ext}`)) name += `.${ext}`;
  return `AudioXtractor/${name}`;
}

export function responseSize(headers) {
  const range = headers['content-range']?.match(/\/(\d+)$/);
  const size = Number(range?.[1] || headers['content-length']);
  return Number.isFinite(size) && size > 0 ? size : null;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'Size unknown';
  if (bytes < 1024) return `${bytes} B`;
  const unit = bytes < 1024 ** 2 ? 1 : bytes < 1024 ** 3 ? 2 : 3;
  return `${(bytes / 1024 ** unit).toFixed(unit === 1 ? 0 : 1)} ${['B', 'KB', 'MB', 'GB'][unit]}`;
}

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
