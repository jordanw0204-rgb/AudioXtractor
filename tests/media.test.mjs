import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMedia, safeFilename, downloadFilename, sourceId, responseSize, formatBytes, formatTime } from '../extension/lib/media.js';

test('recognizes direct audio with signed URLs and MIME-only endpoints', () => {
  assert.deepEqual(classifyMedia('https://cdn.test/track.mp3?token=a%2Fb&expires=123'), { kind: 'file', format: 'MP3', downloadable: true });
  assert.equal(classifyMedia('https://cdn.test/playback', 'audio/mp4; codecs=mp4a.40.2').format, 'M4A');
  assert.equal(classifyMedia('https://cdn.test/sound', 'audio/flac').kind, 'file');
});
test('labels video containers without promising audio extraction', () => {
  assert.equal(classifyMedia('https://cdn.test/movie.mp4').kind, 'video');
  assert.equal(classifyMedia('https://cdn.test/media.webm', 'audio/webm').kind, 'file');
  assert.equal(classifyMedia('https://cdn.test/movie', '', 'video').kind, 'video');
});
test('playlists, fragments and explicit byte-range endpoints are not complete downloads', () => {
  for (const [url, mime] of [['https://a.test/live.m3u8', ''], ['https://a.test/live', 'application/dash+xml'], ['https://a.test/chunk.m4s', 'audio/mp4'], ['https://a.test/a.ts', ''], ['https://a.test/play?range=0-100', 'audio/webm']]) assert.equal(classifyMedia(url, mime).downloadable, false);
});
test('handles blob sources and rejects unsafe schemes and unrelated requests', () => {
  assert.equal(classifyMedia('blob:https://a.test/123').downloadable, false);
  for (const url of ['javascript:alert(1)', 'data:audio/mp3;base64,123', 'file:///a.wav', 'https://a.test/app.js', 'garbage']) assert.equal(classifyMedia(url), null);
});
test('safe filenames handle traversal, illegal characters, reserved Windows names and Unicode', () => {
  assert.equal(safeFilename('../../CON:<a>|?*'), '-..-CON--a----');
  assert.equal(safeFilename('NUL.wav'), 'audio');
  assert.equal(safeFilename('...'), 'audio');
  assert.equal(safeFilename('夜の音'), '夜の音');
  assert.equal(safeFilename('a'.repeat(300)).length, 140);
  assert.equal(downloadFilename({ label: 'A/B', format: 'FLAC' }), 'AudioXtractor/A-B.flac');
});
test('different signed URL variants retain distinct source IDs', () => {
  assert.notEqual(sourceId('https://a.test/a?token=1'), sourceId('https://a.test/a?token=2'));
  assert.equal(sourceId('https://a.test/a'), sourceId('https://a.test/a'));
});
test('range-response metadata uses the complete resource size', () => {
  assert.equal(responseSize({ 'content-range': 'bytes 0-99/5000', 'content-length': '100' }), 5000);
  assert.equal(responseSize({ 'content-length': '500' }), 500);
  assert.equal(responseSize({}), null);
});
test('duration and file size labels are stable for unknown or negative values', () => {
  assert.equal(formatTime(-2), '00:00'); assert.equal(formatTime(125.5), '02:05');
  assert.equal(formatBytes(null), 'Size unknown'); assert.equal(formatBytes(1048576), '1.0 MB');
});
