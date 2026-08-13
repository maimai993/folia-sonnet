const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { pathToFileURL } = require('url');

// electron/localCoverAssets.cjs
// Stores content-addressed local covers and exposes them through a validated streaming protocol.

const ASSET_ID_PATTERN = /^sha256:([0-9a-f]{64})$/;
const ALLOWED_MIME_TYPES = new Set([
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

function parseAssetId(value) {
  if (typeof value !== 'string') return null;
  const match = ASSET_ID_PATTERN.exec(value);
  return match ? { assetId: value, digest: match[1] } : null;
}

function getAssetPaths(directory, assetId) {
  const parsed = parseAssetId(assetId);
  if (!parsed) return null;
  return {
    dataPath: path.join(directory, `${parsed.digest}.bin`),
    metaPath: path.join(directory, `${parsed.digest}.json`),
  };
}

function normalizeMimeType(value) {
  return typeof value === 'string' && ALLOWED_MIME_TYPES.has(value.toLowerCase())
    ? value.toLowerCase()
    : null;
}

function getLocalCoverAssetDirectory(userDataDirectory) {
  return path.join(userDataDirectory, 'local-cover-assets');
}

function createLocalCoverAssetStore({ getDirectory }) {
  const readDescriptor = async (assetId) => {
    const directory = getDirectory();
    const paths = getAssetPaths(directory, assetId);
    if (!paths) return null;
    try {
      const raw = await fsp.readFile(paths.metaPath, 'utf8');
      const descriptor = JSON.parse(raw);
      const mimeType = normalizeMimeType(descriptor?.mimeType);
      if (descriptor?.id !== assetId || !mimeType || !Number.isSafeInteger(descriptor?.size) || descriptor.size <= 0) {
        return null;
      }
      const stat = await fsp.stat(paths.dataPath);
      if (!stat.isFile() || stat.size !== descriptor.size) return null;
      return { ...descriptor, mimeType, ...paths };
    } catch {
      return null;
    }
  };

  const has = async (assetId) => Boolean(await readDescriptor(assetId));

  const write = async (assetId, data, mimeType) => {
    const parsed = parseAssetId(assetId);
    const normalizedMimeType = normalizeMimeType(mimeType);
    if (!parsed || !normalizedMimeType) throw new Error('Invalid local cover asset metadata');
    const bytes = Buffer.isBuffer(data)
      ? data
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : Buffer.from(data);
    if (bytes.byteLength === 0) throw new Error('Cannot persist an empty local cover asset');

    const directory = getDirectory();
    const paths = getAssetPaths(directory, assetId);
    const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const temporaryDataPath = `${paths.dataPath}.${nonce}.tmp`;
    const temporaryMetaPath = `${paths.metaPath}.${nonce}.tmp`;
    await fsp.mkdir(directory, { recursive: true });
    try {
      await fsp.writeFile(temporaryDataPath, bytes);
      await fsp.writeFile(temporaryMetaPath, JSON.stringify({
        id: assetId,
        mimeType: normalizedMimeType,
        size: bytes.byteLength,
        updatedAt: Date.now(),
      }), 'utf8');
      await Promise.allSettled([
        fsp.rm(paths.dataPath, { force: true }),
        fsp.rm(paths.metaPath, { force: true }),
      ]);
      await fsp.rename(temporaryDataPath, paths.dataPath);
      await fsp.rename(temporaryMetaPath, paths.metaPath);
    } finally {
      await Promise.allSettled([
        fsp.rm(temporaryDataPath, { force: true }),
        fsp.rm(temporaryMetaPath, { force: true }),
      ]);
    }
    return { mimeType: normalizedMimeType, size: bytes.byteLength };
  };

  const remove = async (assetId) => {
    const paths = getAssetPaths(getDirectory(), assetId);
    if (!paths) return false;
    await Promise.allSettled([
      fsp.rm(paths.dataPath, { force: true }),
      fsp.rm(paths.metaPath, { force: true }),
    ]);
    return true;
  };

  const clear = async () => {
    await fsp.rm(getDirectory(), { recursive: true, force: true });
    return true;
  };

  const registerProtocolHandler = (protocol, net) => {
    protocol.handle('folia-cover', async (request) => {
      let assetId = null;
      try {
        const url = new URL(request.url);
        if (url.hostname !== 'asset') throw new Error('Invalid local cover host');
        assetId = decodeURIComponent(url.pathname.replace(/^\//, ''));
      } catch {
        return new Response('Bad request', { status: 400 });
      }

      const descriptor = await readDescriptor(assetId);
      if (!descriptor) return new Response('Not found', { status: 404 });
      const fileResponse = await net.fetch(pathToFileURL(descriptor.dataPath).toString());
      if (!fileResponse.ok || !fileResponse.body) return new Response('Not found', { status: 404 });
      return new Response(fileResponse.body, {
        status: 200,
        headers: {
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Content-Length': String(descriptor.size),
          'Content-Type': descriptor.mimeType,
          'X-Content-Type-Options': 'nosniff',
        },
      });
    });
  };

  return { has, write, remove, clear, registerProtocolHandler };
}

module.exports = {
  ALLOWED_MIME_TYPES,
  ASSET_ID_PATTERN,
  createLocalCoverAssetStore,
  getLocalCoverAssetDirectory,
  parseAssetId,
};
