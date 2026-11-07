import { test } from 'node:test';
import assert from 'node:assert/strict';
import { youtubeLinks } from '../extension/lib/youtube.js';

test('normalizes multiple YouTube forms and removes duplicates and playlist tracking', () => {
  assert.deepEqual(youtubeLinks('https://youtu.be/jNQXAC9IVRw?si=abc\nhttps://www.youtube.com/watch?v=jNQXAC9IVRw&list=abc\nhttps://youtube.com/shorts/aqz-KE-bpKQ'), ['https://www.youtube.com/watch?v=jNQXAC9IVRw', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ']);
});
test('rejects lookalike hosts, non-HTTPS, credentials, invalid IDs and empty input', () => {
  for (const input of ['', 'https://youtube.com.evil.test/watch?v=jNQXAC9IVRw', 'http://youtube.com/watch?v=jNQXAC9IVRw', 'https://user:secret@youtube.com/watch?v=jNQXAC9IVRw', 'https://youtube.com/watch?v=x', 'https://youtube.com/playlist?list=x', 'file:///secret']) assert.throws(() => youtubeLinks(input));
});
test('limits a conversion submission to 50 links', () => {
  assert.throws(() => youtubeLinks(Array(51).fill('https://youtu.be/jNQXAC9IVRw').join('\n')));
});
