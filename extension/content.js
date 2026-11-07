(() => {
  if (globalThis.__audioxtractorObserver) { globalThis.__audioxtractorObserver.scan(); return; }
  let timer;
  const observed = new WeakSet();
  const mediaRoots = new Set([document]);
  const walkers = [];
  let discoveryScheduled = false;
  const idle = callback => typeof requestIdleCallback === 'function' ? requestIdleCallback(callback, { timeout: 1500 }) : setTimeout(callback, 40);
  const observeOptions = { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'type', 'href'] };
  function discover(node) {
    if (!node || ![1, 9, 11].includes(node.nodeType)) return;
    walkers.push(document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT));
    if (!discoveryScheduled) { discoveryScheduled = true; idle(discoverSlice); }
  }
  function discoverSlice() {
    const until = performance.now() + 4;
    while (walkers.length && performance.now() < until) {
      const walker = walkers[0], node = walker.currentNode;
      if (node.shadowRoot && !mediaRoots.has(node.shadowRoot) && mediaRoots.size < 100) {
        mediaRoots.add(node.shadowRoot); observer.observe(node.shadowRoot, observeOptions); discover(node.shadowRoot); schedule();
      }
      if (!walker.nextNode()) walkers.shift();
    }
    discoveryScheduled = walkers.length > 0;
    if (discoveryScheduled) idle(discoverSlice);
  }
  function sendSnapshot() {
    clearTimeout(timer);
    const media = [];
    const seen = new Map();
    function add(item) {
      if (!item.url || media.length >= 100) return;
      const previous = seen.get(item.url);
      if (previous) { previous.playing ||= item.playing; return; }
      seen.set(item.url, item); media.push(item);
    }
    const mediaUrl = value => /\.(mp3|wav|flac|m4a|aac|ogg|opus|weba|webm|mp4|m3u8|mpd)(?:[?#]|$)/i.test(value || '');
    for (const root of mediaRoots) if (root.host && !root.host.isConnected) mediaRoots.delete(root);
    const roots = [...mediaRoots];
    for (let i = 0; i < roots.length && i < 100; i++) {
      for (const element of roots[i].querySelectorAll('audio,video')) {
        if (!observed.has(element)) {
          observed.add(element);
          for (const event of ['play', 'pause', 'ended', 'loadedmetadata', 'emptied', 'durationchange']) element.addEventListener(event, schedule, { passive: true });
        }
        const url = element.currentSrc || element.src || element.querySelector('source')?.src;
        if (!url) continue;
        add({ url, elementType: element.localName, mime: element.querySelector('source')?.type || '', playing: !element.paused && !element.ended, duration: Number.isFinite(element.duration) ? element.duration : null, title: (element.title || element.getAttribute('aria-label') || (!element.paused ? navigator.mediaSession?.metadata?.title : '') || '').slice(0, 180) });
        for (const source of element.querySelectorAll('source')) if (source.src) add({ url: source.src, elementType: element.localName, mime: source.type, playing: false, title: element.title || '' });
        if (media.length >= 100) break;
      }
      for (const link of roots[i].querySelectorAll('a[href],link[href]')) if (mediaUrl(link.href)) add({ url: link.href, title: (link.title || link.textContent || '').trim().slice(0, 180), playing: false });
    }
    for (const entry of performance.getEntriesByType('resource')) if (mediaUrl(entry.name)) add({ url: entry.name, playing: false });
    for (const meta of document.querySelectorAll('meta[property^="og:audio"],meta[name="twitter:player:stream"]')) {
      try { if (meta.content && !/type$/i.test(meta.getAttribute('property') || '')) add({ url: new URL(meta.content, location.href).href, elementType: 'audio', playing: false }); } catch { /* Invalid page metadata. */ }
    }
    function structured(value, depth = 0) {
      if (!value || typeof value !== 'object' || depth > 8) return;
      if (typeof value.contentUrl === 'string') {
        try { add({ url: new URL(value.contentUrl, location.href).href, elementType: String(value['@type']).includes('Audio') ? 'audio' : 'video', title: String(value.name || '').slice(0, 180), playing: false }); } catch { /* Invalid URL. */ }
      }
      for (const item of Object.values(value)) if (item && typeof item === 'object') structured(item, depth + 1);
    }
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) if (script.textContent.length < 250000) try { structured(JSON.parse(script.textContent)); } catch { /* Invalid JSON-LD. */ }
    chrome.runtime.sendMessage({ target: 'background', type: 'MEDIA_SNAPSHOT', media }).catch(() => {});
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(() => idle(sendSnapshot), 160); }
  const observer = new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) discover(node); schedule(); });
  observer.observe(document, observeOptions);
  chrome.runtime.onMessage.addListener(message => { if (message.type === 'SCAN_MEDIA') sendSnapshot(); });
  globalThis.__audioxtractorObserver = { scan: sendSnapshot };
  document.addEventListener('DOMContentLoaded', () => { discover(document); schedule(); }, { once: true });
  setInterval(() => idle(sendSnapshot), 2500);
  setInterval(() => discover(document), 20000);
  discover(document); schedule();
})();
