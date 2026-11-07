export function youtubeLinks(input) {
  const values = String(input).split(/[\s,]+/).map(value => value.trim()).filter(Boolean);
  if (!values.length) throw new Error('Paste one or more YouTube video links.');
  if (values.length > 50) throw new Error('Add up to 50 links at a time.');
  const links = [];
  for (const value of values) {
    let url;
    try { url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`); } catch { throw new Error(`Invalid YouTube link: ${value.slice(0, 70)}`); }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || !(host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com'))) throw new Error('Use YouTube video links beginning with https://youtube.com or https://youtu.be.');
    let id = host === 'youtu.be' ? url.pathname.split('/')[1] : url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?]+)/)?.[1];
    if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) throw new Error('Use links to individual YouTube videos, Shorts or live replays.');
    links.push(`https://www.youtube.com/watch?v=${id}`);
  }
  return [...new Set(links)];
}
