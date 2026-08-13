// public/folia-cover-sw.js
// Serves validated content-addressed local cover files directly from OPFS.

const COVER_PATH_PREFIX = '/__folia_cover/';
const ASSET_ID_PATTERN = /^sha256:([0-9a-f]{64})$/;
const ALLOWED_MIME_TYPES = new Set([
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

const getCoverResponse = async (requestUrl) => {
  let assetId;
  try {
    assetId = decodeURIComponent(requestUrl.pathname.slice(COVER_PATH_PREFIX.length));
  } catch {
    return new Response('Bad request', { status: 400 });
  }
  const match = ASSET_ID_PATTERN.exec(assetId);
  if (!match) return new Response('Bad request', { status: 400 });

  try {
    const root = await navigator.storage.getDirectory();
    const foliaRoot = await root.getDirectoryHandle('folia-cache');
    const directory = await foliaRoot.getDirectoryHandle('local-cover-assets');
    const [file, rawDescriptor] = await Promise.all([
      directory.getFileHandle(`${match[1]}.bin`).then(handle => handle.getFile()),
      directory.getFileHandle(`${match[1]}.json`).then(handle => handle.getFile()).then(value => value.text()),
    ]);
    const descriptor = JSON.parse(rawDescriptor);
    const mimeType = typeof descriptor?.mimeType === 'string' ? descriptor.mimeType.toLowerCase() : '';
    if (descriptor?.id !== assetId
      || !ALLOWED_MIME_TYPES.has(mimeType)
      || descriptor?.size !== file.size
      || file.size <= 0) {
      return new Response('Not found', { status: 404 });
    }
    return new Response(file.stream(), {
      status: 200,
      headers: {
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Length': String(file.size),
        'Content-Type': mimeType,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
};

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(COVER_PATH_PREFIX)) {
    return;
  }
  event.respondWith(getCoverResponse(url));
});
